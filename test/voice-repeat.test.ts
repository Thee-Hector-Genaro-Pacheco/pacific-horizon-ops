import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActionStore } from '../src/actions/store.js';
import { VoiceStore } from '../src/voice/store.js';
import { handleVoiceUtterance, isRepeatRequest } from '../src/voice/conversation.js';
import type { ActionExecutor } from '../src/actions/executor.js';
import type { EligibleInboxMessage } from '../src/voice/mailbox.js';

const messages: EligibleInboxMessage[] = [
  { index: 1, messageId: 'm1', threadId: 't1', from: 'Alice Johnson <alice@example.com>', senderName: 'Alice Johnson', subject: 'Photo Booth for Birthday Party', date: '2026-10-09T12:00:00Z', internalDate: 3, body: 'Hi Hector, I would like to book a photo booth for my birthday on Nov 14th in Irvine.' },
  { index: 2, messageId: 'm2', threadId: 't2', from: 'Bob Smith <bob@example.com>', senderName: 'Bob Smith', subject: 'Corporate Holiday Gala Inquiry', date: '2026-10-09T11:00:00Z', internalDate: 2, body: 'We need a photo booth for 200 guests on Dec 10th.' },
];

describe('Mailbox voice: repeat and context-aware prompts', () => {
  let dir: string;
  let voiceStore: VoiceStore;
  let actionStore: ActionStore;
  let sessionId: string;
  let sends: number;
  const executor: ActionExecutor = { async executeApprovedAction() { sends++; return { success: true, status: 'SENT' }; } };
  const draftCreator = async (p: { threadId?: string }) => ({ draftId: 'd1', messageId: 'mm1', threadId: p.threadId });

  async function say(utterance: string) {
    const session = voiceStore.getSession(sessionId)!;
    return handleVoiceUtterance({ session, utterance, voiceStore, actionStore, executor, draftCreator });
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phro-repeat-'));
    voiceStore = new VoiceStore({ dataDir: dir, sessionsFilePath: path.join(dir, 'voice-sessions.json'), eventsFilePath: path.join(dir, 'voice-events.jsonl') });
    actionStore = new ActionStore({ dataDir: dir, actionsFilePath: path.join(dir, 'actions.json'), eventsFilePath: path.join(dir, 'action-events.jsonl') });
    sends = 0;
    const s = voiceStore.createSession({ actionId: 'mailbox', toPhone: '+15550000001', fromPhone: '+15550000002', conversationState: 'MAILBOX_SELECTING', metadata: { mode: 'mailbox', availableMessages: messages } });
    sessionId = s.sessionId;
    voiceStore.updateConversationState(sessionId, 'MAILBOX_SELECTING', { lastSpokenText: 'I found two recent business emails. Which would you like to review?' });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('recognizes repeat phrases and never approval words', () => {
    for (const p of ['repeat', 'say that again', 'one more time', 'can you repeat that', 'again']) assert.equal(isRepeatRequest(p), true, p);
    for (const p of ['approve', 'confirm approval', 'yes', 'send it', 'draft a response']) assert.equal(isRepeatRequest(p), false, p);
  });

  it('repeats the inbox list while choosing a message', async () => {
    const r = await say('say that again');
    assert.equal(r.responseText, 'I found two recent business emails. Which would you like to review?');
    assert.equal(voiceStore.getSession(sessionId)!.conversationState, 'MAILBOX_SELECTING');
  });

  it('repeats the summary of the selected message', async () => {
    const selected = await say('number one');
    const again = await say('repeat');
    assert.equal(again.responseText, selected.responseText);
  });

  it('repeats the draft, and keeps draft options after "summarize again"', async () => {
    await say('number one');
    const drafted = await say('draft a response');
    assert.ok(drafted.responseText.includes('approve'));
    assert.ok(!drafted.responseText.includes('make changes'), 'no unimplemented option offered');
    assert.equal((await say('repeat that')).responseText, drafted.responseText);

    const summary = await say('summarize it again');
    assert.ok(summary.responseText.includes('Here is the summary'));
    assert.ok(summary.responseText.includes('approve'), 'draft context kept');
    assert.ok(!summary.responseText.includes('draft a response'), 'does not reset to the starting menu');

    const unknown = await say('banana');
    assert.ok(unknown.responseText.includes('approve') && unknown.responseText.includes('read the draft again'));

    const draftAgain = await say('read the draft again');
    assert.ok(draftAgain.responseText.startsWith('The proposed draft reply is'));
  });

  it('repeat never advances or completes approval', async () => {
    await say('number one');
    await say('draft a response');
    await say('approve');
    assert.equal(voiceStore.getSession(sessionId)!.conversationState, 'AWAITING_APPROVAL_CONFIRMATION');
    const r = await say('repeat');
    assert.ok(r.responseText.includes('confirm approval'));
    assert.equal(voiceStore.getSession(sessionId)!.conversationState, 'AWAITING_APPROVAL_CONFIRMATION');
    assert.equal(sends, 0);
    await say('confirm approval');
    assert.equal(sends, 1);
  });
});
