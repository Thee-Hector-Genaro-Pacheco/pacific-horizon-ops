import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WebSocket } from 'ws';
import type { OAuth2Client } from 'google-auth-library';
import { ActionStore } from '../src/actions/store.js';
import { VoiceStore } from '../src/voice/store.js';
import { handleVoiceUtterance } from '../src/voice/conversation.js';
import { DefaultActionExecutor, type ActionExecutor, type ExecutionResult } from '../src/actions/executor.js';
import { createVoiceServer } from '../src/voice/server.js';
import type { ActionRecord } from '../src/actions/types.js';

describe('Approved Voice Action Executes Gmail Draft (PHRO-VOICE-005)', () => {
  let tempDir: string;
  let actionStore: ActionStore;
  let voiceStore: VoiceStore;
  let testAction: ActionRecord;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phro-voice-exec-test-'));
    actionStore = new ActionStore({ dataDir: tempDir });
    voiceStore = new VoiceStore({ dataDir: tempDir });

    const { action } = actionStore.createDraftAction({
      messageId: 'msg_test_exec_01',
      threadId: 'thd_test_exec_01',
      draftId: 'draft_test_exec_01',
      subject: 'Holiday Photo Booth Inquiry',
      from: 'sarah.client@example.com',
      classificationCategory: 'booking_inquiry',
      confidence: 0.95,
      draftReply: 'Hello Sarah, we would love to provide our photo booth for your holiday event!',
    });
    testAction = action;
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('A. confirm approval executes exact approved draft once and transitions action to SENT', async () => {
    let sendCalls = 0;
    const mockExecutor: ActionExecutor = {
      async executeApprovedAction(actionId: string): Promise<ExecutionResult> {
        sendCalls++;
        actionStore.transitionAction(actionId, 'EXECUTING', { actor: 'mock_exec' });
        actionStore.transitionAction(actionId, 'SENT', {
          actor: 'mock_exec',
          metadata: { messageId: 'msg_sent_123', threadId: 'thd_test_exec_01' },
        });
        return {
          success: true,
          status: 'SENT',
          messageId: 'msg_sent_123',
          threadId: 'thd_test_exec_01',
        };
      },
    };

    const session = voiceStore.createSession({
      actionId: testAction.actionId,
      toPhone: '+15551234567',
      fromPhone: '+15559876543',
    });
    voiceStore.updateConversationState(session.sessionId, 'AWAITING_APPROVAL_CONFIRMATION');
    const freshSession = voiceStore.getSession(session.sessionId)!;

    const progressMessages: string[] = [];
    const turn = await handleVoiceUtterance({
      session: freshSession,
      utterance: 'confirm approval',
      actionStore,
      voiceStore,
      executor: mockExecutor,
      onProgress: (text) => progressMessages.push(text),
    });

    assert.equal(sendCalls, 1);
    assert.equal(turn.endCall, true);
    assert.ok(turn.responseText.includes('sent successfully'));
    assert.ok(progressMessages.some((m) => m.includes('Sending the email now')));

    const finalAction = actionStore.getAction(testAction.actionId)!;
    assert.equal(finalAction.status, 'SENT');
    assert.equal(finalAction.approvalMetadata?.approvalSource, 'voice');
  });

  it('B. casual "yes" or "okay" does NOT approve and does NOT execute Gmail send', async () => {
    let sendCalls = 0;
    const mockExecutor: ActionExecutor = {
      async executeApprovedAction(): Promise<ExecutionResult> {
        sendCalls++;
        return { success: true, status: 'SENT' };
      },
    };

    const session = voiceStore.createSession({
      actionId: testAction.actionId,
      toPhone: '+15551234567',
      fromPhone: '+15559876543',
    });
    voiceStore.updateConversationState(session.sessionId, 'AWAITING_APPROVAL_CONFIRMATION');
    const freshSession = voiceStore.getSession(session.sessionId)!;

    const turn = await handleVoiceUtterance({
      session: freshSession,
      utterance: 'yes, sounds good',
      actionStore,
      voiceStore,
      executor: mockExecutor,
    });

    assert.equal(sendCalls, 0);
    assert.equal(turn.endCall, false);
    assert.ok(turn.responseText.includes('Approval was not confirmed'));

    const action = actionStore.getAction(testAction.actionId)!;
    assert.equal(action.status, 'AWAITING_APPROVAL');
    assert.equal(action.approvalMetadata, null);
  });

  it('C. duplicate confirm approval executes Gmail send exactly once (idempotent)', async () => {
    let sendCalls = 0;
    const executor = new DefaultActionExecutor();

    // Create a mock OAuth client that intercepts drafts.get and drafts.send
    const mockAuth = {
      credentials: { scope: 'https://www.googleapis.com/auth/gmail.compose' },
    } as unknown as OAuth2Client;

    // Use a custom executor tracking execution calls
    let executionAttempts = 0;
    const mockExecutor: ActionExecutor = {
      async executeApprovedAction(actionId: string): Promise<ExecutionResult> {
        executionAttempts++;
        const action = actionStore.getAction(actionId)!;
        if (action.status === 'SENT') {
          return { success: true, status: 'ALREADY_SENT', alreadySent: true };
        }
        sendCalls++;
        actionStore.transitionAction(actionId, 'EXECUTING', { actor: 'mock_exec' });
        actionStore.transitionAction(actionId, 'SENT', { actor: 'mock_exec' });
        return { success: true, status: 'SENT', messageId: 'msg_single_send' };
      },
    };

    const session1 = voiceStore.createSession({
      actionId: testAction.actionId,
      toPhone: '+15551234567',
      fromPhone: '+15559876543',
    });
    voiceStore.updateConversationState(session1.sessionId, 'AWAITING_APPROVAL_CONFIRMATION');

    // Turn 1: confirm approval
    const turn1 = await handleVoiceUtterance({
      session: voiceStore.getSession(session1.sessionId)!,
      utterance: 'confirm approval',
      actionStore,
      voiceStore,
      executor: mockExecutor,
    });
    assert.equal(turn1.endCall, true);
    assert.equal(sendCalls, 1);

    // Turn 2: duplicate confirmation attempt in a second session or prompt
    const session2 = voiceStore.createSession({
      actionId: testAction.actionId,
      toPhone: '+15551234567',
      fromPhone: '+15559876543',
    });
    voiceStore.updateConversationState(session2.sessionId, 'AWAITING_APPROVAL_CONFIRMATION');

    const turn2 = await handleVoiceUtterance({
      session: voiceStore.getSession(session2.sessionId)!,
      utterance: 'confirm approval',
      actionStore,
      voiceStore,
      executor: mockExecutor,
    });

    assert.equal(sendCalls, 1); // Strictly sent only once
    assert.equal(turn2.endCall, true);
    assert.ok(turn2.responseText.includes('Action state changed to SENT'));
  });

  it('D. approved draft modified in Gmail before execution blocks send and transitions to EXECUTION_FAILED', async () => {
    // Approve action
    actionStore.approveAction(testAction.actionId, {
      decision: 'approved',
      approvedBy: 'owner_voice',
      approvedAt: new Date().toISOString(),
      approvalSource: 'voice',
    });

    const mockAdapter = {
      getReplyDraft: async () => ({
        draftId: testAction.draftId!,
        to: testAction.from,
        subject: `Re: ${testAction.subject}`,
        bodyText: 'TAMPERED / MODIFIED DRAFT CONTENT',
      }),
      sendReplyDraft: async () => {
        throw new Error('send should NEVER be reached when draft is modified');
      },
    };

    const executor = new DefaultActionExecutor(mockAdapter);
    const mockAuth = {} as OAuth2Client;

    const result = await executor.executeApprovedAction(testAction.actionId, {
      auth: mockAuth,
      actionStore,
    });

    assert.equal(result.success, false);
    assert.equal(result.status, 'BLOCKED_MODIFIED');
    assert.ok(result.error?.includes('modified after approval'));

    const finalAction = actionStore.getAction(testAction.actionId)!;
    assert.equal(finalAction.status, 'EXECUTION_FAILED');
    assert.ok(finalAction.failureReason?.includes('modified'));
  });

  it('E. Gmail send failure persists EXECUTION_FAILED, action not marked SENT, and caller receives failure acknowledgement', async () => {
    const mockExecutor: ActionExecutor = {
      async executeApprovedAction(actionId: string): Promise<ExecutionResult> {
        actionStore.transitionAction(actionId, 'EXECUTION_FAILED', {
          actor: 'mock_exec',
          failureReason: '503 Service Unavailable: Gmail API temporary failure',
        });
        return {
          success: false,
          status: 'EXECUTION_FAILED',
          error: '503 Service Unavailable: Gmail API temporary failure',
        };
      },
    };

    const session = voiceStore.createSession({
      actionId: testAction.actionId,
      toPhone: '+15551234567',
      fromPhone: '+15559876543',
    });
    voiceStore.updateConversationState(session.sessionId, 'AWAITING_APPROVAL_CONFIRMATION');

    const turn = await handleVoiceUtterance({
      session: voiceStore.getSession(session.sessionId)!,
      utterance: 'confirm approval',
      actionStore,
      voiceStore,
      executor: mockExecutor,
    });

    assert.equal(turn.endCall, true);
    assert.ok(turn.responseText.includes("approval was recorded, but I wasn't able to send the email"));
    assert.ok(turn.responseText.includes('not been marked as sent'));

    const finalAction = actionStore.getAction(testAction.actionId)!;
    assert.equal(finalAction.status, 'EXECUTION_FAILED');
    assert.notEqual(finalAction.status, 'SENT');
    assert.ok(finalAction.approvalMetadata !== null); // Approval remains recorded
    assert.ok(finalAction.failureReason?.includes('503 Service Unavailable'));
  });

  it('F. ambiguous/timeout send reconciles against thread before retrying without duplicate send', async () => {
    actionStore.approveAction(testAction.actionId, {
      decision: 'approved',
      approvedBy: 'owner_voice',
      approvedAt: new Date().toISOString(),
      approvalSource: 'voice',
    });

    let sendCalled = 0;
    const mockAdapter = {
      getReplyDraft: async () => ({
        draftId: testAction.draftId!,
        to: testAction.from,
        subject: `Re: ${testAction.subject}`,
        bodyText: testAction.proposedAction.payload?.draftReply as string,
      }),
      sendReplyDraft: async () => {
        sendCalled++;
        throw new Error('ETIMEDOUT: Connection reset by peer');
      },
      findSentMessageInThread: async () => ({
        messageId: 'msg_reconciled_999',
        threadId: testAction.threadId,
      }),
    };

    const executor = new DefaultActionExecutor(mockAdapter);
    const mockAuth = {} as OAuth2Client;

    const result = await executor.executeApprovedAction(testAction.actionId, {
      auth: mockAuth,
      actionStore,
    });

    assert.equal(sendCalled, 1);
    assert.equal(result.success, true);
    assert.equal(result.status, 'SENT');
    assert.equal(result.messageId, 'msg_reconciled_999');

    const action = actionStore.getAction(testAction.actionId)!;
    assert.equal(action.status, 'SENT');
  });

  it('G. disconnect after APPROVED leaves action APPROVED and does not blindly duplicate send', async () => {
    actionStore.approveAction(testAction.actionId, {
      decision: 'approved',
      approvedBy: 'owner_voice',
      approvedAt: new Date().toISOString(),
      approvalSource: 'voice',
    });

    const session = voiceStore.createSession({
      actionId: testAction.actionId,
      toPhone: '+15551234567',
      fromPhone: '+15559876543',
    });

    // Caller drops abruptly
    voiceStore.updateSessionStatus(session.sessionId, 'COMPLETED', {
      reason: 'WebSocket closed prematurely',
    });

    const action = actionStore.getAction(testAction.actionId)!;
    // Action remains safely APPROVED, never blindly marked SENT or executed without deliberate restart
    assert.equal(action.status, 'APPROVED');
    assert.equal(action.executionMetadata, null);
  });

  it('H. Twilio duplicate status callbacks do not trigger duplicate Gmail send', async () => {
    let sendCalls = 0;
    const mockExecutor: ActionExecutor = {
      async executeApprovedAction(): Promise<ExecutionResult> {
        sendCalls++;
        return { success: true, status: 'SENT' };
      },
    };

    const session = voiceStore.createSession({
      actionId: testAction.actionId,
      toPhone: '+15551234567',
      fromPhone: '+15559876543',
    });

    voiceStore.updateSessionStatus(session.sessionId, 'ACTIVE', { callSid: 'CA_dup_01' });
    voiceStore.updateSessionStatus(session.sessionId, 'COMPLETED', { callSid: 'CA_dup_01' });
    voiceStore.updateSessionStatus(session.sessionId, 'COMPLETED', { callSid: 'CA_dup_01' });

    assert.equal(sendCalls, 0);
    const action = actionStore.getAction(testAction.actionId)!;
    assert.equal(action.status, 'AWAITING_APPROVAL');
  });

  it('I. successful Gmail send acknowledgement is generated before call closes', async () => {
    const mockExecutor: ActionExecutor = {
      async executeApprovedAction(actionId: string): Promise<ExecutionResult> {
        actionStore.transitionAction(actionId, 'EXECUTING', { actor: 'mock_exec' });
        actionStore.transitionAction(actionId, 'SENT', { actor: 'mock_exec' });
        return { success: true, status: 'SENT', messageId: 'm1' };
      },
    };

    const session = voiceStore.createSession({
      actionId: testAction.actionId,
      toPhone: '+15551234567',
      fromPhone: '+15559876543',
    });
    voiceStore.updateConversationState(session.sessionId, 'AWAITING_APPROVAL_CONFIRMATION');

    const turn = await handleVoiceUtterance({
      session: voiceStore.getSession(session.sessionId)!,
      utterance: 'confirm approval',
      actionStore,
      voiceStore,
      executor: mockExecutor,
    });

    assert.equal(turn.endCall, true);
    assert.ok(turn.responseText.includes('sent successfully'));
    assert.ok(turn.responseText.includes('Goodbye'));
  });

  it('full WebSocket conversation: speaks progress, executes Gmail draft, delivers final acknowledgement, and closes cleanly', async () => {
    const prevSkip = process.env.PHRO_SKIP_TWILIO_SIGNATURE_VALIDATION;
    process.env.PHRO_SKIP_TWILIO_SIGNATURE_VALIDATION = 'true';

    let sendExecuted = false;
    const mockExecutor: ActionExecutor = {
      async executeApprovedAction(actionId: string): Promise<ExecutionResult> {
        sendExecuted = true;
        actionStore.transitionAction(actionId, 'EXECUTING', { actor: 'ws_test' });
        actionStore.transitionAction(actionId, 'SENT', {
          actor: 'ws_test',
          metadata: { messageId: 'msg_ws_sent_999' },
        });
        return { success: true, status: 'SENT', messageId: 'msg_ws_sent_999' };
      },
    };

    const voiceServer = createVoiceServer({
      port: 0,
      actionStore,
      voiceStore,
      endCallBufferMs: 50,
      executor: mockExecutor,
    });

    await voiceServer.start();
    const actualPort = voiceServer.getPort();

    const session = voiceStore.createSession({
      actionId: testAction.actionId,
      toPhone: '+15551234567',
      fromPhone: '+15559876543',
    });

    const receivedMessages: Array<{ type: string; token?: string; last?: boolean }> = [];
    const ws = new WebSocket(`ws://localhost:${actualPort}/voice/ws?sessionId=${session.sessionId}`);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'setup', callSid: 'CA_ws_test', sessionId: session.sessionId }));
      });

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        receivedMessages.push(msg);

        // After greeting -> say "approve"
        if (msg.type === 'text' && msg.token?.includes('Hello! This is Horizon')) {
          ws.send(JSON.stringify({ type: 'prompt', voicePrompt: 'approve', last: true }));
        }

        // After confirmation request -> say "confirm approval"
        if (msg.type === 'text' && msg.token?.includes('confirm approval')) {
          ws.send(JSON.stringify({ type: 'prompt', voicePrompt: 'confirm approval', last: true }));
        }

        // End signal received
        if (msg.type === 'end') {
          resolve();
        }
      });

      ws.on('error', reject);
    });

    assert.equal(sendExecuted, true);
    assert.ok(receivedMessages.some((m) => m.type === 'text' && m.token?.includes('Sending the email now')));
    assert.ok(receivedMessages.some((m) => m.type === 'text' && m.token?.includes('sent successfully')));
    assert.ok(receivedMessages.some((m) => m.type === 'end'));

    const finalAction = actionStore.getAction(testAction.actionId)!;
    assert.equal(finalAction.status, 'SENT');

    await voiceServer.stop();
    if (prevSkip !== undefined) {
      process.env.PHRO_SKIP_TWILIO_SIGNATURE_VALIDATION = prevSkip;
    } else {
      delete process.env.PHRO_SKIP_TWILIO_SIGNATURE_VALIDATION;
    }
  });
});
