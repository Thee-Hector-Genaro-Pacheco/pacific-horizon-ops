import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { ActionStore } from '../src/actions/store.js';
import { VoiceStore } from '../src/voice/store.js';
import { handleVoiceUtterance } from '../src/voice/conversation.js';
import { createVoiceServer } from '../src/voice/server.js';
import {
  type EligibleInboxMessage,
  type RawInboxCandidate,
  isEligibleInboxMessage,
  formatSafeSenderName,
  formatMailboxGreeting,
  parseMessageSelection,
  generateDraftReply,
  selectTop3InboxMessages,
} from '../src/voice/mailbox.js';
import { type ActionExecutor, type ExecutionResult } from '../src/actions/executor.js';

describe('Beta Mailbox Voice Call (PHRO-BETA-001)', () => {
  let testDir: string;
  let actionStore: ActionStore;
  let voiceStore: VoiceStore;

  const mockEligibleMessages: EligibleInboxMessage[] = [
    {
      index: 1,
      messageId: 'msg_001',
      threadId: 'th_001',
      from: 'Alice Johnson <alice@example.com>',
      senderName: 'Alice Johnson',
      subject: 'Photo Booth for Birthday Party',
      date: '2026-10-04T12:00:00Z',
      internalDate: 1700000003000,
      body: 'Hi Hector, I would like to book a photo booth for my birthday on Nov 14th in Irvine.',
      snippet: 'Hi Hector, I would like to book a photo booth for my birthday on Nov 14th in Irvine.',
    },
    {
      index: 2,
      messageId: 'msg_002',
      threadId: 'th_002',
      from: 'Bob Smith <bob@example.com>',
      senderName: 'Bob Smith',
      subject: 'Corporate Holiday Gala Inquiry',
      date: '2026-10-04T11:00:00Z',
      internalDate: 1700000002000,
      body: 'Hello Pacific Horizon Labs, we need a photo booth for 200 guests on Dec 10th.',
      snippet: 'Hello Pacific Horizon Labs, we need a photo booth for 200 guests on Dec 10th.',
    },
    {
      index: 3,
      messageId: 'msg_003',
      threadId: 'th_003',
      from: 'Carol White <carol@example.com>',
      senderName: 'Carol White',
      subject: 'Wedding Photo Booth Availability',
      date: '2026-10-04T10:00:00Z',
      internalDate: 1700000001000,
      body: 'Hi! Are you available for a Newport Beach wedding on Jan 20th?',
      snippet: 'Hi! Are you available for a Newport Beach wedding on Jan 20th?',
    },
  ];

  beforeEach(() => {
    testDir = path.resolve(process.cwd(), `tmp_test_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });

    actionStore = new ActionStore({
      dataDir: testDir,
      actionsFilePath: path.join(testDir, 'actions.json'),
      eventsFilePath: path.join(testDir, 'action-events.jsonl'),
    });

    voiceStore = new VoiceStore({
      dataDir: testDir,
      sessionsFilePath: path.join(testDir, 'voice-sessions.json'),
      eventsFilePath: path.join(testDir, 'voice-events.jsonl'),
    });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('1. mailbox session loads latest 3 eligible Gmail messages in newest-first order', () => {
    const greeting = formatMailboxGreeting(mockEligibleMessages);
    assert.ok(greeting.includes('I found three recent business emails'));
    assert.ok(greeting.includes('Message one is from Alice Johnson about Photo Booth for Birthday Party'));
    assert.ok(greeting.includes('Message two is from Bob Smith about Corporate Holiday Gala Inquiry'));
    assert.ok(greeting.includes('Message three is from Carol White about Wedding Photo Booth Availability'));
    assert.ok(greeting.includes('Which would you like to review?'));

    // Check timestamps are strictly descending
    assert.ok(mockEligibleMessages[0].internalDate > mockEligibleMessages[1].internalDate);
    assert.ok(mockEligibleMessages[1].internalDate > mockEligibleMessages[2].internalDate);
  });

  it('2. user can select message 1', async () => {
    const session = voiceStore.createSession({
      actionId: 'mailbox',
      toPhone: '+15551234567',
      fromPhone: '+15559876543',
      conversationState: 'MAILBOX_SELECTING',
      metadata: { mode: 'mailbox', availableMessages: mockEligibleMessages },
    });

    const turn = await handleVoiceUtterance({
      session,
      utterance: 'number one',
      actionStore,
      voiceStore,
    });

    assert.equal(turn.endCall, false);
    assert.ok(turn.responseText.includes('Selected message 1 from Alice Johnson'));
    assert.ok(turn.responseText.includes('Photo Booth for Birthday Party'));

    const freshSession = voiceStore.getSession(session.sessionId)!;
    assert.equal(freshSession.conversationState, 'READY');
    assert.equal((freshSession.metadata?.selectedMessage as EligibleInboxMessage).index, 1);
  });

  it('3. user can select message 2', async () => {
    const session = voiceStore.createSession({
      actionId: 'mailbox',
      toPhone: '+15551234567',
      fromPhone: '+15559876543',
      conversationState: 'MAILBOX_SELECTING',
      metadata: { mode: 'mailbox', availableMessages: mockEligibleMessages },
    });

    const turn = await handleVoiceUtterance({
      session,
      utterance: 'the second one',
      actionStore,
      voiceStore,
    });

    assert.equal(turn.endCall, false);
    assert.ok(turn.responseText.includes('Selected message 2 from Bob Smith'));
    assert.ok(turn.responseText.includes('Corporate Holiday Gala Inquiry'));

    const freshSession = voiceStore.getSession(session.sessionId)!;
    assert.equal(freshSession.conversationState, 'READY');
    assert.equal((freshSession.metadata?.selectedMessage as EligibleInboxMessage).index, 2);
  });

  it('4. user can select message 3', async () => {
    const session = voiceStore.createSession({
      actionId: 'mailbox',
      toPhone: '+15551234567',
      fromPhone: '+15559876543',
      conversationState: 'MAILBOX_SELECTING',
      metadata: { mode: 'mailbox', availableMessages: mockEligibleMessages },
    });

    const turn = await handleVoiceUtterance({
      session,
      utterance: 'message three',
      actionStore,
      voiceStore,
    });

    assert.equal(turn.endCall, false);
    assert.ok(turn.responseText.includes('Selected message 3 from Carol White'));
    assert.ok(turn.responseText.includes('Wedding Photo Booth Availability'));

    const freshSession = voiceStore.getSession(session.sessionId)!;
    assert.equal(freshSession.conversationState, 'READY');
    assert.equal((freshSession.metadata?.selectedMessage as EligibleInboxMessage).index, 3);
  });

  it('5. selected message becomes internally bound to session', async () => {
    const session = voiceStore.createSession({
      actionId: 'mailbox',
      toPhone: '+15551234567',
      fromPhone: '+15559876543',
      conversationState: 'MAILBOX_SELECTING',
      metadata: { mode: 'mailbox', availableMessages: mockEligibleMessages },
    });

    await handleVoiceUtterance({
      session,
      utterance: 'first',
      actionStore,
      voiceStore,
    });

    const updated = voiceStore.getSession(session.sessionId)!;
    const selected = updated.metadata?.selectedMessage as EligibleInboxMessage;
    assert.ok(selected);
    assert.equal(selected.messageId, 'msg_001');
    assert.equal(selected.threadId, 'th_001');
    assert.equal(selected.from, 'Alice Johnson <alice@example.com>');
  });

  it('6. draft response creates Gmail draft + approval action internally', async () => {
    const session = voiceStore.createSession({
      actionId: 'mailbox',
      toPhone: '+15551234567',
      fromPhone: '+15559876543',
      conversationState: 'READY',
      metadata: {
        mode: 'mailbox',
        availableMessages: mockEligibleMessages,
        selectedMessage: mockEligibleMessages[0],
      },
    });

    let mockDraftCreated = false;
    const mockDraftCreator = async (p: { to: string; subject: string; bodyText: string; threadId?: string }) => {
      mockDraftCreated = true;
      assert.equal(p.to, 'Alice Johnson <alice@example.com>');
      assert.equal(p.subject, 'Photo Booth for Birthday Party');
      assert.equal(p.threadId, 'th_001');
      return { draftId: 'draft_live_123', messageId: 'msg_draft_1', threadId: 'th_001' };
    };

    const turn = await handleVoiceUtterance({
      session,
      utterance: 'draft a response',
      actionStore,
      voiceStore,
      draftCreator: mockDraftCreator,
    });

    assert.equal(turn.endCall, false);
    assert.ok(mockDraftCreated);
    assert.ok(turn.responseText.includes('I created a draft reply in Gmail'));

    // Verify action created in ActionStore
    const freshSession = voiceStore.getSession(session.sessionId)!;
    assert.ok(freshSession.actionId !== 'mailbox');
    const createdAction = actionStore.getAction(freshSession.actionId);
    assert.ok(createdAction);
    assert.equal(createdAction.status, 'AWAITING_APPROVAL');
    assert.equal(createdAction.draftId, 'draft_live_123');
    assert.equal(createdAction.threadId, 'th_001');
  });

  it('7. owner never needs an action ID during conversation', async () => {
    const session = voiceStore.createSession({
      actionId: 'mailbox',
      toPhone: '+15551234567',
      fromPhone: '+15559876543',
      conversationState: 'MAILBOX_SELECTING',
      metadata: { mode: 'mailbox', availableMessages: mockEligibleMessages },
    });

    // Turn 1: selection
    const turn1 = await handleVoiceUtterance({
      session,
      utterance: 'message one',
      actionStore,
      voiceStore,
    });
    // Turn 2: draft request
    const turn2 = await handleVoiceUtterance({
      session: voiceStore.getSession(session.sessionId)!,
      utterance: 'draft a response',
      actionStore,
      voiceStore,
      draftCreator: async () => ({ draftId: 'draft_hidden_id', messageId: 'm1', threadId: 't1' }),
    });
    // Turn 3: approve request
    const turn3 = await handleVoiceUtterance({
      session: voiceStore.getSession(session.sessionId)!,
      utterance: 'approve',
      actionStore,
      voiceStore,
    });

    // Zero action IDs or internal IDs are spoken in responses
    for (const text of [turn1.responseText, turn2.responseText, turn3.responseText]) {
      assert.equal(/\bact_[0-9a-f_]+\b/i.test(text), false);
      assert.equal(/\bdraft_[0-9a-f_]+\b/i.test(text), false);
      assert.equal(/\bth_[0-9a-f_]+\b/i.test(text), false);
    }
  });

  it('8. approve without confirm does not send', async () => {
    const session = voiceStore.createSession({
      actionId: 'mailbox',
      toPhone: '+15551234567',
      fromPhone: '+15559876543',
      conversationState: 'READY',
      metadata: {
        mode: 'mailbox',
        availableMessages: mockEligibleMessages,
        selectedMessage: mockEligibleMessages[0],
      },
    });

    await handleVoiceUtterance({
      session,
      utterance: 'draft a response',
      actionStore,
      voiceStore,
      draftCreator: async () => ({ draftId: 'd1', messageId: 'm1', threadId: 't1' }),
    });

    let sendCalled = false;
    const mockExecutor: ActionExecutor = {
      async executeApprovedAction() {
        sendCalled = true;
        return { success: true, status: 'SENT' };
      },
    };

    // User says "approve"
    const turn = await handleVoiceUtterance({
      session: voiceStore.getSession(session.sessionId)!,
      utterance: 'approve',
      actionStore,
      voiceStore,
      executor: mockExecutor,
    });

    assert.equal(sendCalled, false);
    assert.equal(turn.endCall, false);
    assert.ok(turn.responseText.includes('confirm approval'));

    // Casual "yes" still does not send
    const turnCasual = await handleVoiceUtterance({
      session: voiceStore.getSession(session.sessionId)!,
      utterance: 'yes',
      actionStore,
      voiceStore,
      executor: mockExecutor,
    });

    assert.equal(sendCalled, false);
    assert.equal(turnCasual.endCall, false);
    assert.ok(turnCasual.responseText.includes('Approval was not confirmed'));
  });

  it('9. approve + confirm approval sends exact selected draft once', async () => {
    const session = voiceStore.createSession({
      actionId: 'mailbox',
      toPhone: '+15551234567',
      fromPhone: '+15559876543',
      conversationState: 'READY',
      metadata: {
        mode: 'mailbox',
        availableMessages: mockEligibleMessages,
        selectedMessage: mockEligibleMessages[0],
      },
    });

    await handleVoiceUtterance({
      session,
      utterance: 'draft a response',
      actionStore,
      voiceStore,
      draftCreator: async () => ({ draftId: 'draft_exact_9', messageId: 'm9', threadId: 't9' }),
    });

    let sendCallCount = 0;
    const mockExecutor: ActionExecutor = {
      async executeApprovedAction(actionId) {
        sendCallCount++;
        actionStore.transitionAction(actionId, 'SENT', {
          actor: 'mock_exec',
          reason: 'Draft sent',
        });
        return { success: true, status: 'SENT', messageId: 'sent_msg_9' };
      },
    };

    // 1. Approve
    await handleVoiceUtterance({
      session: voiceStore.getSession(session.sessionId)!,
      utterance: 'approve',
      actionStore,
      voiceStore,
      executor: mockExecutor,
    });

    // 2. Confirm approval
    const turn = await handleVoiceUtterance({
      session: voiceStore.getSession(session.sessionId)!,
      utterance: 'confirm approval',
      actionStore,
      voiceStore,
      executor: mockExecutor,
    });

    assert.equal(sendCallCount, 1);
    assert.equal(turn.endCall, true);
    assert.ok(turn.responseText.includes('email has been sent successfully'));

    const freshSession = voiceStore.getSession(session.sessionId)!;
    const action = actionStore.getAction(freshSession.actionId);
    assert.equal(action?.status, 'SENT');
  });

  it("10. switching selected message cannot accidentally send previous message's draft", async () => {
    const session = voiceStore.createSession({
      actionId: 'mailbox',
      toPhone: '+15551234567',
      fromPhone: '+15559876543',
      conversationState: 'READY',
      metadata: {
        mode: 'mailbox',
        availableMessages: mockEligibleMessages,
        selectedMessage: mockEligibleMessages[0], // Message 1
      },
    });

    // Draft response for Message 1
    await handleVoiceUtterance({
      session,
      utterance: 'draft a response',
      actionStore,
      voiceStore,
      draftCreator: async () => ({ draftId: 'd_msg1', messageId: 'm1', threadId: 't1' }),
    });

    const msg1ActionId = voiceStore.getSession(session.sessionId)!.actionId;
    assert.ok(msg1ActionId !== 'mailbox');

    // Caller switches to message 2
    const switchTurn = await handleVoiceUtterance({
      session: voiceStore.getSession(session.sessionId)!,
      utterance: 'message two',
      actionStore,
      voiceStore,
    });
    assert.ok(switchTurn.responseText.includes('Switched to message 2'));

    // Now caller attempts to say "approve"
    let sendCalled = false;
    const mockExecutor: ActionExecutor = {
      async executeApprovedAction() {
        sendCalled = true;
        return { success: true, status: 'SENT' };
      },
    };

    const approveTurn = await handleVoiceUtterance({
      session: voiceStore.getSession(session.sessionId)!,
      utterance: 'approve',
      actionStore,
      voiceStore,
      executor: mockExecutor,
    });

    // Must block approval because message 2 has no draft, and MUST NOT send message 1's draft!
    assert.equal(sendCalled, false);
    assert.ok(approveTurn.responseText.includes('No draft has been created for this email yet'));

    // Verify Message 1 action remains AWAITING_APPROVAL (never sent)
    const msg1Action = actionStore.getAction(msg1ActionId);
    assert.equal(msg1Action?.status, 'AWAITING_APPROVAL');
  });

  it('11. disconnect cannot send', async () => {
    const session = voiceStore.createSession({
      actionId: 'mailbox',
      toPhone: '+15551234567',
      fromPhone: '+15559876543',
      conversationState: 'READY',
      metadata: {
        mode: 'mailbox',
        availableMessages: mockEligibleMessages,
        selectedMessage: mockEligibleMessages[0],
      },
    });

    await handleVoiceUtterance({
      session,
      utterance: 'draft a response',
      actionStore,
      voiceStore,
      draftCreator: async () => ({ draftId: 'd11', messageId: 'm11', threadId: 't11' }),
    });

    const boundActionId = voiceStore.getSession(session.sessionId)!.actionId;

    // Simulate abrupt disconnect
    voiceStore.updateSessionStatus(session.sessionId, 'COMPLETED', {
      reason: 'WebSocket closed (1006 abnormal)',
    });

    const action = actionStore.getAction(boundActionId);
    assert.equal(action?.status, 'AWAITING_APPROVAL');
    assert.equal(action?.approvalMetadata, null);
  });

  it('12. fewer than 3 messages handled correctly', () => {
    // 2 messages
    const twoGreeting = formatMailboxGreeting(mockEligibleMessages.slice(0, 2));
    assert.ok(twoGreeting.includes('I found two recent business emails'));
    assert.ok(twoGreeting.includes('Message one is from'));
    assert.ok(twoGreeting.includes('Message two is from'));
    assert.ok(!twoGreeting.includes('Message three'));

    // 1 message
    const oneGreeting = formatMailboxGreeting(mockEligibleMessages.slice(0, 1));
    assert.ok(oneGreeting.includes('I found one business email'));
    assert.ok(oneGreeting.includes('Message one is from'));
    assert.ok(!oneGreeting.includes('Message two'));

    // 0 messages
    const zeroGreeting = formatMailboxGreeting([]);
    assert.ok(zeroGreeting.includes('I did not find any recent business emails'));
  });

  it('13. newsletter/system noise excluded using existing safe logic', () => {
    const businessEmail = 'hector@pacifichorizonlabs.com';

    // 1. Legitimate customer inquiry -> ELIGIBLE
    const customerMsg = {
      from: 'Alice Johnson <alice@example.com>',
      subject: 'Inquiry about wedding photo booth on July 10',
      body: 'Hi Hector, can you send quote?',
    };
    assert.equal(isEligibleInboxMessage(customerMsg, businessEmail), true);

    // 2. Self-sent message -> EXCLUDED
    const selfMsg = {
      from: 'Hector Pacheco <hector@pacifichorizonlabs.com>',
      subject: 'Follow up on proposal',
      body: 'Sending follow up.',
    };
    assert.equal(isEligibleInboxMessage(selfMsg, businessEmail), false);

    // 3. Obvious promotion / newsletter -> EXCLUDED
    const promoMsg = {
      from: 'marketing@retailer.com',
      subject: 'Exclusive Flash Sale! 50% off everything',
      snippet: 'Unsubscribe at any time.',
      body: 'Check out our deals of the week.',
    };
    assert.equal(isEligibleInboxMessage(promoMsg, businessEmail), false);

    // 4. Automated system noise -> EXCLUDED
    const noiseMsg = {
      from: 'no-reply@accounts.google.com',
      subject: 'Security alert: new sign-in attempt detected',
      body: 'Someone signed in from a new device.',
    };
    assert.equal(isEligibleInboxMessage(noiseMsg, businessEmail), false);

    // 5. Safe sender name extraction
    assert.equal(formatSafeSenderName('Hector Pacheco <hector@example.com>'), 'Hector Pacheco');
    assert.equal(formatSafeSenderName('"Jane Doe" <jane@example.com>'), 'Jane Doe');
    assert.equal(formatSafeSenderName('john@client.com'), 'john');
  });

  it('14. existing PHRO-VOICE-005 single-action behavior remains intact', async () => {
    // Single-action session (not mailbox mode)
    const testAction = actionStore.createDraftAction({
      messageId: 'msg_legacy_1',
      threadId: 'th_legacy_1',
      draftId: 'draft_legacy_1',
      subject: 'Direct Action Inquiry',
      from: 'Direct Customer <direct@example.com>',
      classificationCategory: 'booking_inquiry',
      confidence: 0.9,
      draftReply: 'Thanks for reaching out! Here are the package options.',
    }).action;

    const session = voiceStore.createSession({
      actionId: testAction.actionId,
      toPhone: '+15551234567',
      fromPhone: '+15559876543',
      conversationState: 'READY',
    });

    let sendCalled = false;
    const mockExecutor: ActionExecutor = {
      async executeApprovedAction(actionId) {
        sendCalled = true;
        actionStore.transitionAction(actionId, 'SENT', { actor: 'mock_exec' });
        return { success: true, status: 'SENT' };
      },
    };

    // User approves
    await handleVoiceUtterance({
      session,
      utterance: 'approve',
      actionStore,
      voiceStore,
      executor: mockExecutor,
    });

    // User confirms approval
    const turn = await handleVoiceUtterance({
      session: voiceStore.getSession(session.sessionId)!,
      utterance: 'confirm approval',
      actionStore,
      voiceStore,
      executor: mockExecutor,
    });

    assert.equal(sendCalled, true);
    assert.equal(turn.endCall, true);
    assert.ok(turn.responseText.includes('email has been sent successfully'));
    const finalAction = actionStore.getAction(testAction.actionId);
    assert.equal(finalAction?.status, 'SENT');
  });

  it('simulates full WebSocket ConversationRelay mailbox session: greeting -> select 1 -> draft -> approve -> confirm approval -> send', async () => {
    const prevSkip = process.env.PHRO_SKIP_TWILIO_SIGNATURE_VALIDATION;
    process.env.PHRO_SKIP_TWILIO_SIGNATURE_VALIDATION = 'true';

    let draftCreated = false;
    let sendExecuted = false;

    const mockExecutor: ActionExecutor = {
      async executeApprovedAction(actionId) {
        sendExecuted = true;
        actionStore.transitionAction(actionId, 'SENT', { actor: 'mock_ws' });
        return { success: true, status: 'SENT', messageId: 'ws_msg_sent_1' };
      },
    };

    const mockDraftCreator = async (p: { to: string; subject: string; bodyText: string; threadId?: string }) => {
      draftCreated = true;
      return { draftId: 'draft_ws_1', messageId: 'msg_ws_1', threadId: p.threadId };
    };

    const voiceServer = createVoiceServer({
      port: 0,
      actionStore,
      voiceStore,
      executor: mockExecutor,
      mailboxMessages: mockEligibleMessages,
      draftCreator: mockDraftCreator,
      endCallBufferMs: 50,
    });

    await voiceServer.start();
    const port = voiceServer.getPort();

    const session = voiceStore.createSession({
      actionId: 'mailbox',
      toPhone: '+15551234567',
      fromPhone: '+15559876543',
      conversationState: 'MAILBOX_SELECTING',
      metadata: { mode: 'mailbox', availableMessages: mockEligibleMessages },
    });

    const receivedMessages: Array<{ type: string; token?: string; last?: boolean }> = [];
    const ws = new WebSocket(`ws://localhost:${port}/voice/ws?sessionId=${session.sessionId}`);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'setup', callSid: 'CA_ws_mailbox_test', sessionId: session.sessionId }));
      });

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        receivedMessages.push(msg);

        // Turn 1: Greeting received -> select message one
        if (msg.type === 'text' && msg.token?.includes('I found three recent business emails')) {
          ws.send(JSON.stringify({ type: 'prompt', voicePrompt: 'number one', last: true }));
        }

        // Turn 2: Selected message 1 -> request draft
        if (msg.type === 'text' && msg.token?.includes('Selected message 1 from Alice Johnson')) {
          ws.send(JSON.stringify({ type: 'prompt', voicePrompt: 'draft a response', last: true }));
        }

        // Turn 3: Draft prepared -> approve
        if (msg.type === 'text' && msg.token?.includes('I created a draft reply in Gmail')) {
          ws.send(JSON.stringify({ type: 'prompt', voicePrompt: 'approve', last: true }));
        }

        // Turn 4: Confirmation requested -> confirm approval
        if (msg.type === 'text' && msg.token?.includes('confirm approval')) {
          ws.send(JSON.stringify({ type: 'prompt', voicePrompt: 'confirm approval', last: true }));
        }

        if (msg.type === 'end') {
          resolve();
        }
      });

      ws.on('error', reject);
    });

    assert.equal(draftCreated, true);
    assert.equal(sendExecuted, true);

    // Verify spoken progress and final success
    assert.ok(receivedMessages.some((m) => m.type === 'text' && m.token?.includes('I found three recent business emails')));
    assert.ok(receivedMessages.some((m) => m.type === 'text' && m.token?.includes('Selected message 1 from Alice Johnson')));
    assert.ok(receivedMessages.some((m) => m.type === 'text' && m.token?.includes('I created a draft reply in Gmail')));
    assert.ok(receivedMessages.some((m) => m.type === 'text' && m.token?.includes('confirm approval')));
    assert.ok(receivedMessages.some((m) => m.type === 'text' && m.token?.includes('email has been sent successfully')));
    assert.ok(receivedMessages.some((m) => m.type === 'end'));

    // Verify session completed
    const finalSession = voiceStore.getSession(session.sessionId)!;
    assert.equal(finalSession.conversationState, 'COMPLETE');

    // Verify action in ActionStore is SENT
    const finalAction = actionStore.getAction(finalSession.actionId);
    assert.equal(finalAction?.status, 'SENT');

    await voiceServer.stop();
    if (prevSkip !== undefined) {
      process.env.PHRO_SKIP_TWILIO_SIGNATURE_VALIDATION = prevSkip;
    } else {
      delete process.env.PHRO_SKIP_TWILIO_SIGNATURE_VALIDATION;
    }
  });
});

describe('PHRO Mailbox Top-3 Correction (Task 8: A through G)', () => {
  let testDir: string;
  let actionStore: ActionStore;
  let voiceStore: VoiceStore;

  beforeEach(() => {
    testDir = path.resolve(process.cwd(), `tmp_test_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });

    actionStore = new ActionStore({
      dataDir: testDir,
      actionsFilePath: path.join(testDir, 'actions.json'),
      eventsFilePath: path.join(testDir, 'action-events.jsonl'),
    });

    voiceStore = new VoiceStore({
      dataDir: testDir,
      sessionsFilePath: path.join(testDir, 'voice-sessions.json'),
      eventsFilePath: path.join(testDir, 'voice-events.jsonl'),
    });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // A. Inbox contains 5 messages with internalDate: 500, 400, 300, 200, 100 -> mailbox presents 500, 400, 300 exactly
  it('A. Inbox contains 5 messages with internalDate: 500, 400, 300, 200, 100 -> mailbox presents 500, 400, 300 exactly', () => {
    const candidates: RawInboxCandidate[] = [
      { messageId: 'm1', threadId: 't1', internalDate: 100, from: 'Person A <a@example.com>', subject: 'Sub A', labelIds: ['INBOX'] },
      { messageId: 'm2', threadId: 't2', internalDate: 400, from: 'Person B <b@example.com>', subject: 'Sub B', labelIds: ['INBOX'] },
      { messageId: 'm3', threadId: 't3', internalDate: 200, from: 'Person C <c@example.com>', subject: 'Sub C', labelIds: ['INBOX'] },
      { messageId: 'm4', threadId: 't4', internalDate: 500, from: 'Person D <d@example.com>', subject: 'Sub D', labelIds: ['INBOX'] },
      { messageId: 'm5', threadId: 't5', internalDate: 300, from: 'Person E <e@example.com>', subject: 'Sub E', labelIds: ['INBOX'] },
    ];

    const result = selectTop3InboxMessages(candidates, { logDiagnostics: false });
    assert.equal(result.length, 3);
    assert.equal(result[0].internalDate, 500);
    assert.equal(result[0].index, 1);
    assert.equal(result[1].internalDate, 400);
    assert.equal(result[1].index, 2);
    assert.equal(result[2].internalDate, 300);
    assert.equal(result[2].index, 3);

    const greeting = formatMailboxGreeting(result);
    assert.ok(greeting.includes('Message one is from Person D about Sub D.'));
    assert.ok(greeting.includes('Message two is from Person B about Sub B.'));
    assert.ok(greeting.includes('Message three is from Person E about Sub E.'));
  });

  // B. newest message is Google Workspace/system notification -> it is still included in initial top 3
  it('B. newest message is Google Workspace/system notification -> it is still included in initial top 3', () => {
    const candidates: RawInboxCandidate[] = [
      {
        messageId: 'm_gw',
        threadId: 't_gw',
        internalDate: 1000,
        from: 'Google Workspace <workspace-noreply@google.com>',
        subject: 'Important account alert for your domain',
        body: 'Your subscription renewed.',
        labelIds: ['INBOX'],
      },
      {
        messageId: 'm_cust',
        threadId: 't_cust',
        internalDate: 900,
        from: 'Alice Johnson <alice@example.com>',
        subject: 'Photo booth inquiry',
        body: 'We want to book a booth.',
        labelIds: ['INBOX'],
      },
      {
        messageId: 'm_twilio',
        threadId: 't_twilio',
        internalDate: 800,
        from: 'Twilio Support <help@twilio.com>',
        subject: 'Ticket update',
        body: 'Your ticket is updated.',
        labelIds: ['INBOX'],
      },
    ];

    const result = selectTop3InboxMessages(candidates, { logDiagnostics: false });
    assert.equal(result.length, 3);
    assert.equal(result[0].messageId, 'm_gw');
    assert.equal(result[0].senderName, 'Google Workspace');
    assert.equal(result[0].subject, 'Important account alert for your domain');
  });

  // C. newest message is from owner/self but has INBOX label -> it is still included in initial top 3
  it('C. newest message is from owner/self but has INBOX label -> it is still included in initial top 3', () => {
    const candidates: RawInboxCandidate[] = [
      {
        messageId: 'm_self',
        threadId: 't_self',
        internalDate: 1200,
        from: 'Hector Pacheco <hector@pacifichorizonlabs.com>',
        subject: 'PHRO Voice test message',
        body: 'Testing self sent message',
        labelIds: ['INBOX', 'SENT'],
      },
      {
        messageId: 'm_other',
        threadId: 't_other',
        internalDate: 1100,
        from: 'Jane Doe <jane@example.com>',
        subject: 'Event details',
        labelIds: ['INBOX'],
      },
      {
        messageId: 'm_other2',
        threadId: 't_other2',
        internalDate: 1000,
        from: 'Bob <bob@example.com>',
        subject: 'Follow up',
        labelIds: ['INBOX'],
      },
    ];

    const result = selectTop3InboxMessages(candidates, { logDiagnostics: false });
    assert.equal(result.length, 3);
    assert.equal(result[0].messageId, 'm_self');
    assert.equal(result[0].senderName, 'Hector Pacheco');
    assert.equal(result[0].subject, 'PHRO Voice test message');
  });

  // D. old Twilio support message -> cannot displace a newer Inbox message
  it('D. old Twilio support message -> cannot displace a newer Inbox message', () => {
    const candidates: RawInboxCandidate[] = [
      { messageId: 'm_new1', threadId: 't1', internalDate: 900, from: 'Client 1 <c1@example.com>', subject: 'New Email 1', labelIds: ['INBOX'] },
      { messageId: 'm_new2', threadId: 't2', internalDate: 850, from: 'Client 2 <c2@example.com>', subject: 'New Email 2', labelIds: ['INBOX'] },
      { messageId: 'm_new3', threadId: 't3', internalDate: 800, from: 'Client 3 <c3@example.com>', subject: 'New Email 3', labelIds: ['INBOX'] },
      { messageId: 'm_old_twilio', threadId: 't4', internalDate: 100, from: 'Twilio Support <support@twilio.com>', subject: 'Old Sep 30 Twilio Ticket', labelIds: ['INBOX'] },
    ];

    const result = selectTop3InboxMessages(candidates, { logDiagnostics: false });
    assert.equal(result.length, 3);
    assert.equal(result[0].internalDate, 900);
    assert.equal(result[1].internalDate, 850);
    assert.equal(result[2].internalDate, 800);
    assert.ok(!result.some((m) => m.messageId === 'm_old_twilio'));
  });

  // E. Trash/Spam/Sent-only message -> excluded
  it('E. Trash/Spam/Sent-only message -> excluded', () => {
    const candidates: RawInboxCandidate[] = [
      { messageId: 'm_trash', threadId: 't1', internalDate: 999, from: 'Trash Sender', subject: 'Trash', labelIds: ['TRASH', 'INBOX'] },
      { messageId: 'm_spam', threadId: 't2', internalDate: 888, from: 'Spam Sender', subject: 'Spam', labelIds: ['SPAM', 'INBOX'] },
      { messageId: 'm_sent_only', threadId: 't3', internalDate: 777, from: 'Me', subject: 'Sent Only', labelIds: ['SENT'] },
      { messageId: 'm_inbox1', threadId: 't4', internalDate: 500, from: 'Valid 1 <v1@example.com>', subject: 'Valid 1', labelIds: ['INBOX'] },
      { messageId: 'm_inbox2', threadId: 't5', internalDate: 400, from: 'Valid 2 <v2@example.com>', subject: 'Valid 2', labelIds: ['INBOX'] },
      { messageId: 'm_inbox3', threadId: 't6', internalDate: 300, from: 'Valid 3 <v3@example.com>', subject: 'Valid 3', labelIds: ['INBOX'] },
    ];

    const result = selectTop3InboxMessages(candidates, { logDiagnostics: false });
    assert.equal(result.length, 3);
    assert.equal(result[0].messageId, 'm_inbox1');
    assert.equal(result[1].messageId, 'm_inbox2');
    assert.equal(result[2].messageId, 'm_inbox3');
  });

  // F. message read/unread status does not affect selection
  it('F. message read/unread status does not affect selection', () => {
    const candidates: RawInboxCandidate[] = [
      { messageId: 'm_read_new', threadId: 't1', internalDate: 800, from: 'Sender A', subject: 'Already Read', labelIds: ['INBOX'] },
      { messageId: 'm_unread_older', threadId: 't2', internalDate: 600, from: 'Sender B', subject: 'Unread Older', labelIds: ['INBOX', 'UNREAD'] },
      { messageId: 'm_read_oldest', threadId: 't3', internalDate: 400, from: 'Sender C', subject: 'Read Oldest', labelIds: ['INBOX'] },
    ];

    const result = selectTop3InboxMessages(candidates, { logDiagnostics: false });
    assert.equal(result.length, 3);
    assert.equal(result[0].messageId, 'm_read_new');
    assert.equal(result[0].internalDate, 800);
    assert.equal(result[1].messageId, 'm_unread_older');
    assert.equal(result[1].internalDate, 600);
    assert.equal(result[2].messageId, 'm_read_oldest');
    assert.equal(result[2].internalDate, 400);
  });

  // G. classification happens only after user selects a message
  it('G. classification happens only after user selects a message', async () => {
    const rawMessages: RawInboxCandidate[] = [
      {
        messageId: 'm_sys',
        threadId: 't_sys',
        internalDate: 900,
        from: 'no-reply@accounts.google.com',
        subject: 'Security alert: new sign-in attempt detected',
        body: 'A new device signed into your account.',
        labelIds: ['INBOX'],
      },
      {
        messageId: 'm_cust',
        threadId: 't_cust',
        internalDate: 800,
        from: 'Alice Johnson <alice@example.com>',
        subject: 'Photo booth inquiry for Dec 5',
        body: 'Hi Hector, do you have a booth available?',
        labelIds: ['INBOX'],
      },
    ];

    // Initial presentation includes BOTH messages without filtering
    const top3 = selectTop3InboxMessages(rawMessages, { logDiagnostics: false });
    assert.equal(top3.length, 2);
    assert.equal(top3[0].messageId, 'm_sys');
    assert.equal(top3[1].messageId, 'm_cust');

    const greeting = formatMailboxGreeting(top3);
    assert.ok(greeting.includes('Security alert'));
    assert.ok(greeting.includes('Photo booth inquiry'));

    // Create session in MAILBOX_SELECTING with these messages
    const session = voiceStore.createSession({
      actionId: 'mailbox',
      toPhone: '+15551234567',
      fromPhone: '+15559876543',
      conversationState: 'MAILBOX_SELECTING',
      metadata: { mode: 'mailbox', availableMessages: top3 },
    });

    // Caller selects message 1 (the system security alert)
    const turn1 = await handleVoiceUtterance({
      session,
      utterance: 'message one',
      actionStore,
      voiceStore,
    });

    // Classification happened AFTER selection: noted as system notification in spoken response
    assert.ok(turn1.responseText.includes('system notification'));

    // If caller attempts to draft a response for message 1:
    const draftAttempt = await handleVoiceUtterance({
      session: voiceStore.getSession(session.sessionId)!,
      utterance: 'draft a response',
      actionStore,
      voiceStore,
    });

    // Drafting is safely refused for system notification
    assert.ok(draftAttempt.responseText.includes('automated system notification, so automated drafting is not supported'));

    // Caller switches to message 2 (the customer inquiry)
    const turn2 = await handleVoiceUtterance({
      session: voiceStore.getSession(session.sessionId)!,
      utterance: 'message two',
      actionStore,
      voiceStore,
    });
    assert.ok(turn2.responseText.includes('Alice Johnson'));

    // Drafting succeeds for customer inquiry
    let draftCreated = false;
    const turnDraftCust = await handleVoiceUtterance({
      session: voiceStore.getSession(session.sessionId)!,
      utterance: 'draft a response',
      actionStore,
      voiceStore,
      draftCreator: async () => {
        draftCreated = true;
        return { draftId: 'd_cust', messageId: 'm_cust', threadId: 't_cust' };
      },
    });

    assert.equal(draftCreated, true);
    assert.ok(turnDraftCust.responseText.includes('I created a draft reply in Gmail'));
  });
});
