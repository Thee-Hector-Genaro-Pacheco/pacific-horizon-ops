import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActionStore } from '../src/actions/store.js';
import { isTerminalStatus, ALLOWED_TRANSITIONS } from '../src/actions/transitions.js';
import type { ActionRecord, ActionStatus } from '../src/actions/types.js';
import type { ActionExecutor } from '../src/actions/executor.js';
import { VoiceStore } from '../src/voice/store.js';
import { handleVoiceUtterance, checkBoundDraft, STALE_DRAFT_TEXT } from '../src/voice/conversation.js';
import type { EligibleInboxMessage } from '../src/voice/mailbox.js';

const messages: EligibleInboxMessage[] = [
  { index: 1, messageId: 'gmail_src_1', threadId: 'thread_src_1', from: 'Alice Johnson <alice@example.com>', senderName: 'Alice Johnson', subject: 'Photo Booth for Birthday Party', date: '2026-10-09T12:00:00Z', internalDate: 3, body: 'Hi Hector, I would like to book a photo booth for my birthday on Nov 14th in Irvine.' },
  { index: 2, messageId: 'gmail_src_2', threadId: 'thread_src_2', from: 'Bob Smith <bob@example.com>', senderName: 'Bob Smith', subject: 'Corporate Holiday Gala Inquiry', date: '2026-10-09T11:00:00Z', internalDate: 2, body: 'We need a photo booth for 200 guests on Dec 10th.' },
];

const NO_DRAFT_TEXT = 'No draft has been created for this email yet. Please say "draft a response" first.';

describe('Action lifecycle: terminal actions are history, never reused', () => {
  let dir: string;
  let voiceStore: VoiceStore;
  let actionStore: ActionStore;
  let sessionId: string;
  let draftSeq: number;
  let draftCalls: number;
  let executed: string[];
  let warn: typeof console.warn;
  let error: typeof console.error;
  let logs: string[];

  const executor: ActionExecutor = {
    async executeApprovedAction(actionId) {
      executed.push(actionId);
      actionStore.transitionAction(actionId, 'SENT', { actor: 'test_executor' });
      return { success: true, status: 'SENT' };
    },
  };
  // Mirrors production: the action keeps the SOURCE Gmail messageId; only the draft ID is new.
  const draftCreator = async (p: { threadId?: string }) => {
    draftCalls++;
    draftSeq++;
    return { draftId: `r_new_draft_${draftSeq}`, threadId: p.threadId };
  };

  async function say(utterance: string) {
    return handleVoiceUtterance({
      session: voiceStore.getSession(sessionId)!,
      utterance,
      voiceStore,
      actionStore,
      executor,
      draftCreator,
    });
  }

  function newMailboxSession(): string {
    const s = voiceStore.createSession({
      actionId: 'mailbox',
      toPhone: '+15550000001',
      fromPhone: '+15550000002',
      conversationState: 'MAILBOX_SELECTING',
      metadata: { mode: 'mailbox', availableMessages: messages },
    });
    return s.sessionId;
  }

  /** A historical action for message 1 that already reached `finalStatus`. */
  function historicalAction(finalStatus: 'EXECUTION_FAILED' | 'SENT' | 'REJECTED'): ActionRecord {
    const { action } = actionStore.createDraftAction({
      messageId: messages[0].messageId,
      threadId: messages[0].threadId,
      draftId: 'r_old_draft',
      subject: messages[0].subject,
      from: messages[0].from,
      classificationCategory: 'booking_inquiry',
      confidence: 1,
      draftReply: 'Old reply text',
    });
    if (finalStatus === 'REJECTED') {
      actionStore.rejectAction(action.actionId, { decision: 'rejected', approvedBy: 'owner_voice', approvedAt: new Date().toISOString(), approvalSource: 'voice' });
    } else {
      actionStore.approveAction(action.actionId, { decision: 'approved', approvedBy: 'owner_voice', approvedAt: new Date().toISOString(), approvalSource: 'voice' });
      actionStore.transitionAction(action.actionId, finalStatus, { actor: 'test', reason: 'historical outcome' });
    }
    return actionStore.getAction(action.actionId)!;
  }

  function eventsFor(actionId: string): string[] {
    const file = path.join(dir, 'action-events.jsonl');
    return fs.readFileSync(file, 'utf-8').trim().split('\n').filter((l) => JSON.parse(l).actionId === actionId);
  }

  function assertSessionConsistent() {
    const session = voiceStore.getSession(sessionId)!;
    const bound = actionStore.getAction(session.metadata?.boundActionId as string)!;
    assert.ok(bound, 'session is bound to an existing action');
    assert.equal(bound.status, 'AWAITING_APPROVAL');
    assert.equal(bound.draftId, session.metadata?.draftId, 'action draftId === session draftId');
    assert.equal(bound.proposedAction.payload?.draftReply, session.metadata?.draftReply);
    assert.equal(session.actionId, bound.actionId);
    return { session, bound };
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phro-lifecycle-'));
    voiceStore = new VoiceStore({ dataDir: dir, sessionsFilePath: path.join(dir, 'voice-sessions.json'), eventsFilePath: path.join(dir, 'voice-events.jsonl') });
    actionStore = new ActionStore({ dataDir: dir, actionsFilePath: path.join(dir, 'actions.json'), eventsFilePath: path.join(dir, 'action-events.jsonl') });
    draftSeq = 0;
    draftCalls = 0;
    executed = [];
    sessionId = newMailboxSession();
    logs = [];
    warn = console.warn;
    error = console.error;
    console.warn = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
    console.error = (...a: unknown[]) => void logs.push(a.map(String).join(' '));
  });

  afterEach(() => {
    console.warn = warn;
    console.error = error;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('terminal statuses come from the state machine', () => {
    for (const s of ['SENT', 'REJECTED', 'EXECUTION_FAILED', 'EXECUTED', 'FAILED'] as ActionStatus[]) assert.equal(isTerminalStatus(s), true, s);
    for (const s of ['RECEIVED', 'CLASSIFIED', 'DRAFTED', 'AWAITING_APPROVAL', 'APPROVED', 'EXECUTING'] as ActionStatus[]) assert.equal(isTerminalStatus(s), false, s);
    for (const [s, next] of Object.entries(ALLOWED_TRANSITIONS)) assert.equal(isTerminalStatus(s as ActionStatus), next.length === 0);
  });

  it('store: a terminal action for the same message is never returned for a new draft', () => {
    const old = historicalAction('EXECUTION_FAILED');
    const { action, isNew } = actionStore.createDraftAction({
      messageId: messages[0].messageId,
      threadId: messages[0].threadId,
      draftId: 'r_new_draft_x',
      subject: messages[0].subject,
      from: messages[0].from,
      classificationCategory: 'booking_inquiry',
      confidence: 1,
      draftReply: 'New reply',
    });
    assert.equal(isNew, true);
    assert.notEqual(action.actionId, old.actionId);
    assert.equal(action.draftId, 'r_new_draft_x');
    assert.deepEqual(actionStore.getAction(old.actionId), old);
  });

  it('1. fresh email -> draft -> new action -> approval works', async () => {
    await say('message one');
    const draft = await say('draft a response');
    assert.match(draft.responseText, /^I created a draft reply in Gmail/);
    const { bound } = assertSessionConsistent();
    assert.equal(bound.messageId, messages[0].messageId);

    assert.match((await say('approve')).responseText, /confirm approval/);
    await say('confirm approval');
    assert.deepEqual(executed, [bound.actionId]);
  });

  it('2-4. incident: earlier EXECUTION_FAILED action -> new draft gets a NEW action, old stays untouched', async () => {
    const old = historicalAction('EXECUTION_FAILED');
    const oldEvents = eventsFor(old.actionId);

    await say('message one');
    const draft = await say('draft a response');
    assert.match(draft.responseText, /^I created a draft reply in Gmail/);

    const { session, bound } = assertSessionConsistent();
    assert.notEqual(bound.actionId, old.actionId, 'new action identity');
    assert.notEqual(session.metadata?.boundActionId, old.actionId);
    assert.equal(bound.draftId, 'r_new_draft_1');
    assert.notEqual(bound.draftId, old.draftId, 'new draft never paired with the old action');

    // History is immutable: same record, same audit events.
    assert.deepEqual(actionStore.getAction(old.actionId), old);
    assert.equal(actionStore.getAction(old.actionId)!.status, 'EXECUTION_FAILED');
    assert.deepEqual(eventsFor(old.actionId), oldEvents);

    // The exact incident step: "approve" now proceeds.
    const approve = await say('approve');
    assert.notEqual(approve.responseText, NO_DRAFT_TEXT);
    assert.match(approve.responseText, /confirm approval/);
    await say('confirm approval');
    assert.deepEqual(executed, [bound.actionId], 'only the new action executes');
    assert.equal(actionStore.getAction(old.actionId)!.status, 'EXECUTION_FAILED');
  });

  it('5. historical SENT action is preserved and a new explicit response gets its own lifecycle', async () => {
    const old = historicalAction('SENT');
    await say('message one');
    await say('draft a response');
    const { bound } = assertSessionConsistent();
    assert.notEqual(bound.actionId, old.actionId);
    assert.deepEqual(actionStore.getAction(old.actionId), old);
    assert.deepEqual(executed, [], 'nothing re-sent by drafting');
  });

  it('6. historical REJECTED action is preserved when drafting again', async () => {
    const old = historicalAction('REJECTED');
    await say('message one');
    await say('draft a response');
    const { bound } = assertSessionConsistent();
    assert.notEqual(bound.actionId, old.actionId);
    assert.deepEqual(actionStore.getAction(old.actionId), old);
  });

  it('7. a session bound to a terminal action fails closed on approve (the exact incident state)', async () => {
    const old = historicalAction('EXECUTION_FAILED');
    voiceStore.updateSessionMetadata(sessionId, {
      selectedMessage: messages[0],
      boundActionId: old.actionId,
      draftId: 'r5192121596654755525',
      draftReply: 'New reply text',
    });
    voiceStore.updateConversationState(sessionId, 'READY');

    const check = checkBoundDraft(voiceStore.getSession(sessionId)!, actionStore);
    assert.deepEqual(check, { ok: false, reason: 'action_not_approvable', actionId: old.actionId, status: 'EXECUTION_FAILED' });

    const turn = await say('approve');
    assert.equal(turn.responseText, STALE_DRAFT_TEXT);
    assert.notEqual(turn.responseText, NO_DRAFT_TEXT, 'no longer claims no draft exists');
    assert.equal(voiceStore.getSession(sessionId)!.conversationState, 'READY');
    assert.ok(logs.some((l) => l.includes('approve refused: action_not_approvable') && l.includes(old.actionId)));
    assert.deepEqual(actionStore.getAction(old.actionId), old);

    // Recovery: drafting again creates a fresh, consistent lifecycle.
    await say('draft a response');
    const { bound } = assertSessionConsistent();
    assert.notEqual(bound.actionId, old.actionId);
  });

  it('8. session draftId != action draftId fails closed on approve and on confirm approval', async () => {
    await say('message one');
    await say('draft a response');
    const { bound } = assertSessionConsistent();

    voiceStore.updateSessionMetadata(sessionId, { draftId: 'r_some_other_draft' });
    const approve = await say('approve');
    assert.equal(approve.responseText, STALE_DRAFT_TEXT);
    assert.ok(logs.some((l) => l.includes('approve refused: draft_mismatch')));

    // Even if the mismatch appears after "approve", confirmation must not approve or send.
    voiceStore.updateSessionMetadata(sessionId, { draftId: bound.draftId });
    await say('approve');
    voiceStore.updateSessionMetadata(sessionId, { draftId: 'r_some_other_draft' });
    const confirm = await say('confirm approval');
    assert.equal(confirm.responseText, STALE_DRAFT_TEXT);
    assert.deepEqual(executed, []);
    assert.equal(actionStore.getAction(bound.actionId)!.status, 'AWAITING_APPROVAL');
  });

  it('missing bound action and plain no-draft are distinguished', async () => {
    await say('message one');
    let check = checkBoundDraft(voiceStore.getSession(sessionId)!, actionStore);
    assert.deepEqual(check, { ok: false, reason: 'no_draft' });
    assert.equal((await say('approve')).responseText, NO_DRAFT_TEXT);

    voiceStore.updateSessionMetadata(sessionId, { boundActionId: 'act_does_not_exist', draftId: 'r_x' });
    check = checkBoundDraft(voiceStore.getSession(sessionId)!, actionStore);
    assert.deepEqual(check, { ok: false, reason: 'action_missing', actionId: 'act_does_not_exist' });
    assert.equal((await say('approve')).responseText, STALE_DRAFT_TEXT);
  });

  it('9. repeating "draft a response" in the same open lifecycle reuses it: one draft, one action, one send', async () => {
    await say('message one');
    await say('draft a response');
    const first = assertSessionConsistent().bound;

    const again = await say('draft a response');
    assert.match(again.responseText, /already waiting for your approval/);
    assert.equal(draftCalls, 1, 'no second Gmail draft');
    assert.equal(actionStore.listActions().length, 1);
    assert.equal(assertSessionConsistent().bound.actionId, first.actionId);

    // A new session on the same message also reuses the open lifecycle.
    sessionId = newMailboxSession();
    await say('message one');
    await say('draft a response');
    assert.equal(draftCalls, 1);
    assert.equal(assertSessionConsistent().bound.actionId, first.actionId);

    await say('approve');
    await say('confirm approval');
    assert.deepEqual(executed, [first.actionId]);
  });

  it('an in-flight (APPROVED) action blocks a second draft instead of creating a parallel lifecycle', async () => {
    const { action } = actionStore.createDraftAction({
      messageId: messages[0].messageId,
      threadId: messages[0].threadId,
      draftId: 'r_inflight',
      subject: messages[0].subject,
      from: messages[0].from,
      classificationCategory: 'booking_inquiry',
      confidence: 1,
      draftReply: 'In flight',
    });
    actionStore.approveAction(action.actionId, { decision: 'approved', approvedBy: 'owner_voice', approvedAt: new Date().toISOString(), approvalSource: 'voice' });

    await say('message one');
    const turn = await say('draft a response');
    assert.match(turn.responseText, /already being processed/);
    assert.equal(draftCalls, 0);
    assert.equal(actionStore.listActions().length, 1);
    assert.equal(actionStore.getAction(action.actionId)!.status, 'APPROVED');
  });

  it('never says a draft was created if the new draft cannot be bound to a fresh approvable action', async () => {
    // Simulate a store that hands back an existing action instead of creating one.
    const old = historicalAction('EXECUTION_FAILED');
    const original = actionStore.createDraftAction.bind(actionStore);
    actionStore.createDraftAction = () => ({ action: actionStore.getAction(old.actionId)!, isNew: false });
    try {
      await say('message one');
      const turn = await say('draft a response');
      assert.doesNotMatch(turn.responseText, /I created a draft reply/);
      assert.match(turn.responseText, /couldn't register it for approval/);
      const session = voiceStore.getSession(sessionId)!;
      assert.equal(session.metadata?.boundActionId, null);
      assert.equal(session.metadata?.draftId, null);
      assert.equal((await say('approve')).responseText, NO_DRAFT_TEXT);
    } finally {
      actionStore.createDraftAction = original;
    }
    assert.deepEqual(actionStore.getAction(old.actionId), old);
  });

  it('switching messages clears the previous draft binding entirely', async () => {
    await say('message one');
    await say('draft a response');
    await say('message two');
    const session = voiceStore.getSession(sessionId)!;
    assert.equal(session.metadata?.boundActionId, null);
    assert.equal(session.metadata?.draftId, null);
    assert.equal(session.metadata?.draftReply, null);
  });
});
