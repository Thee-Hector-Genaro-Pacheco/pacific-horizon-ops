import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { OAuth2Client } from 'google-auth-library';
import {
  decodeRfc2047,
  encodeRfc2047,
  encodeSubjectHeader,
  encodeRecipientHeader,
} from '../src/mime.js';
import {
  DefaultActionExecutor,
  normalizeSubject,
  normalizeBody,
  type GmailSendAdapter,
} from '../src/actions/executor.js';
import { ActionStore } from '../src/actions/store.js';

describe('Unicode Subject and RFC 2047 Header Safety', () => {
  let tempDir: string;
  let actionStore: ActionStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phro-unicode-test-'));
    actionStore = new ActionStore({ dataDir: tempDir });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // Test cases covering the minimum required test strings
  const testCases = [
    { name: '1. ASCII subject', value: 'Invoice #1042', expectedNorm: 'invoice #1042' },
    { name: '2. emoji subject', value: '🖕🏽', expectedNorm: '🖕🏽' },
    { name: '3. emoji + text', value: 'Photo Booth 📸🤖', expectedNorm: 'photo booth 📸🤖' },
    { name: '4. accented Unicode', value: 'Résumé — José', expectedNorm: 'résumé — josé' },
    { name: '5. non-Latin text', value: 'こんにちは', expectedNorm: 'こんにちは' },
    { name: '6. smart punctuation', value: '“Approved” — ready', expectedNorm: '“approved” — ready' },
  ];

  for (const tc of testCases) {
    it(`${tc.name} survives round-trip encoding and decoding`, () => {
      const headerWithRe = `Re: ${tc.value}`;
      const encoded = encodeSubjectHeader(headerWithRe);
      const decoded = decodeRfc2047(encoded);

      assert.equal(decoded, headerWithRe);
      assert.equal(normalizeSubject(decoded), tc.expectedNorm);
      assert.equal(normalizeSubject(tc.value), tc.expectedNorm);
      assert.equal(normalizeSubject(headerWithRe), normalizeSubject(tc.value));
    });
  }

  it('7. expected Unicode subject equals correctly decoded Gmail subject in executor', async () => {
    const subject = '🖕🏽';

    const { action } = actionStore.createDraftAction({
      messageId: 'msg_emoji_1',
      threadId: 'th_emoji_1',
      draftId: 'r-emoji-1',
      subject,
      from: 'Paul Hermosillo <hermosillopaul3@gmail.com>',
      classificationCategory: 'booking_inquiry',
      confidence: 1.0,
      draftReply: 'Hello, thank you for contacting Pacific Horizon Labs.',
    });

    // Simulate approval
    actionStore.approveAction(action.actionId, {
      decision: 'approved',
      approvedBy: 'owner_voice',
      approvedAt: new Date().toISOString(),
      approvalSource: 'voice',
    });

    // Generate valid RFC 2047 encoded fixture for Gmail readback:
    // "Re: =?UTF-8?B?8J+WlfCfj70=?="
    const rfc2047Header = encodeSubjectHeader(`Re: ${subject}`);
    assert.equal(rfc2047Header, 'Re: =?UTF-8?B?8J+WlfCfj70=?=');

    let sendCalled = false;
    const mockAdapter: GmailSendAdapter = {
      getReplyDraft: async () => ({
        draftId: action.draftId!,
        to: action.from,
        subject: rfc2047Header,
        bodyText: action.proposedAction.payload?.draftReply as string,
      }),
      sendReplyDraft: async () => {
        sendCalled = true;
        return { messageId: 'msg_sent_1', threadId: action.threadId };
      },
    };

    const executor = new DefaultActionExecutor(mockAdapter);
    const result = await executor.executeApprovedAction(action.actionId, {
      auth: {} as OAuth2Client,
      actionStore,
    });

    assert.equal(result.success, true);
    assert.equal(result.status, 'SENT');
    assert.equal(sendCalled, true);

    const finalAction = actionStore.getAction(action.actionId)!;
    assert.equal(finalAction.status, 'SENT');
    assert.ok(!finalAction.failureReason);
  });

  it('7b. already-decoded UTF-8 draft subject from Gmail equals expected Unicode subject without double-decoding', async () => {
    const subject = '🖕🏽';

    const { action } = actionStore.createDraftAction({
      messageId: 'msg_emoji_2',
      threadId: 'th_emoji_2',
      draftId: 'r-emoji-2',
      subject,
      from: 'Paul Hermosillo <hermosillopaul3@gmail.com>',
      classificationCategory: 'booking_inquiry',
      confidence: 1.0,
      draftReply: 'Hello, thank you for contacting Pacific Horizon Labs.',
    });

    actionStore.approveAction(action.actionId, {
      decision: 'approved',
      approvedBy: 'owner_voice',
      approvedAt: new Date().toISOString(),
      approvalSource: 'voice',
    });

    let sendCalled = false;
    const mockAdapter: GmailSendAdapter = {
      // Gmail API returned already-decoded UTF-8
      getReplyDraft: async () => ({
        draftId: action.draftId!,
        to: action.from,
        subject: `Re: ${subject}`,
        bodyText: action.proposedAction.payload?.draftReply as string,
      }),
      sendReplyDraft: async () => {
        sendCalled = true;
        return { messageId: 'msg_sent_2', threadId: action.threadId };
      },
    };

    const executor = new DefaultActionExecutor(mockAdapter);
    const result = await executor.executeApprovedAction(action.actionId, {
      auth: {} as OAuth2Client,
      actionStore,
    });

    assert.equal(result.success, true);
    assert.equal(result.status, 'SENT');
    assert.equal(sendCalled, true);
  });

  it('8. genuinely modified Unicode subject fails verification and aborts send', async () => {
    const subject = '🖕🏽';

    const { action } = actionStore.createDraftAction({
      messageId: 'msg_emoji_3',
      threadId: 'th_emoji_3',
      draftId: 'r-emoji-3',
      subject,
      from: 'Paul Hermosillo <hermosillopaul3@gmail.com>',
      classificationCategory: 'booking_inquiry',
      confidence: 1.0,
      draftReply: 'Hello, thank you.',
    });

    actionStore.approveAction(action.actionId, {
      decision: 'approved',
      approvedBy: 'owner_voice',
      approvedAt: new Date().toISOString(),
      approvalSource: 'voice',
    });

    let sendCalled = false;
    const mockAdapter: GmailSendAdapter = {
      getReplyDraft: async () => ({
        draftId: action.draftId!,
        to: action.from,
        // Subject tampered in Gmail to different emoji
        subject: 'Re: ✌️',
        bodyText: action.proposedAction.payload?.draftReply as string,
      }),
      sendReplyDraft: async () => {
        sendCalled = true;
        return { messageId: 'never_sent', threadId: action.threadId };
      },
    };

    const executor = new DefaultActionExecutor(mockAdapter);
    const result = await executor.executeApprovedAction(action.actionId, {
      auth: {} as OAuth2Client,
      actionStore,
    });

    assert.equal(result.success, false);
    assert.equal(result.status, 'BLOCKED_MODIFIED');
    assert.equal(sendCalled, false);
    assert.match(result.error!, /Draft subject changed in Gmail/);

    const finalAction = actionStore.getAction(action.actionId)!;
    assert.equal(finalAction.status, 'EXECUTION_FAILED');
    assert.match(finalAction.failureReason!, /Draft subject changed in Gmail/);
  });

  it('9. skin-tone modifier difference fails verification and aborts send', async () => {
    // Approved with Fitzpatrick modifier Type-4 (medium skin tone)
    const subjectWithModifier = '🖕🏽'; // U+1F595 + U+1F3FD
    const subjectWithoutModifier = '🖕'; // U+1F595 alone

    const { action } = actionStore.createDraftAction({
      messageId: 'msg_emoji_4',
      threadId: 'th_emoji_4',
      draftId: 'r-emoji-4',
      subject: subjectWithModifier,
      from: 'Paul Hermosillo <hermosillopaul3@gmail.com>',
      classificationCategory: 'booking_inquiry',
      confidence: 1.0,
      draftReply: 'Hello.',
    });

    actionStore.approveAction(action.actionId, {
      decision: 'approved',
      approvedBy: 'owner_voice',
      approvedAt: new Date().toISOString(),
      approvalSource: 'voice',
    });

    let sendCalled = false;
    const mockAdapter: GmailSendAdapter = {
      getReplyDraft: async () => ({
        draftId: action.draftId!,
        to: action.from,
        // Modified in Gmail: skin-tone modifier removed
        subject: `Re: ${subjectWithoutModifier}`,
        bodyText: action.proposedAction.payload?.draftReply as string,
      }),
      sendReplyDraft: async () => {
        sendCalled = true;
        return { messageId: 'never_sent', threadId: action.threadId };
      },
    };

    const executor = new DefaultActionExecutor(mockAdapter);
    const result = await executor.executeApprovedAction(action.actionId, {
      auth: {} as OAuth2Client,
      actionStore,
    });

    assert.equal(result.success, false);
    assert.equal(result.status, 'BLOCKED_MODIFIED');
    assert.equal(sendCalled, false);
    assert.match(result.error!, /Draft subject changed in Gmail/);

    const finalAction = actionStore.getAction(action.actionId)!;
    assert.equal(finalAction.status, 'EXECUTION_FAILED');
  });

  it('10. malformed/undecodable header fails closed', async () => {
    const { action } = actionStore.createDraftAction({
      messageId: 'msg_malformed_1',
      threadId: 'th_malformed_1',
      draftId: 'r-malformed-1',
      subject: 'Valid Subject',
      from: 'Paul Hermosillo <hermosillopaul3@gmail.com>',
      classificationCategory: 'booking_inquiry',
      confidence: 1.0,
      draftReply: 'Hello.',
    });

    actionStore.approveAction(action.actionId, {
      decision: 'approved',
      approvedBy: 'owner_voice',
      approvedAt: new Date().toISOString(),
      approvalSource: 'voice',
    });

    let sendCalled = false;
    const mockAdapter: GmailSendAdapter = {
      getReplyDraft: async () => ({
        draftId: action.draftId!,
        to: action.from,
        // Corrupt header with invalid base64 in RFC 2047 word
        subject: 'Re: =?UTF-8?B?***NOT_VALID_BASE64***?=',
        bodyText: action.proposedAction.payload?.draftReply as string,
      }),
      sendReplyDraft: async () => {
        sendCalled = true;
        return { messageId: 'never_sent', threadId: action.threadId };
      },
    };

    const executor = new DefaultActionExecutor(mockAdapter);
    const result = await executor.executeApprovedAction(action.actionId, {
      auth: {} as OAuth2Client,
      actionStore,
    });

    assert.equal(result.success, false);
    assert.equal(result.status, 'BLOCKED_MODIFIED');
    assert.equal(sendCalled, false);
    assert.match(result.error!, /Draft subject verification failed/);

    const finalAction = actionStore.getAction(action.actionId)!;
    assert.equal(finalAction.status, 'EXECUTION_FAILED');
  });

  it('11. normal Gmail ASCII subject behavior remains unchanged', async () => {
    const { action } = actionStore.createDraftAction({
      messageId: 'msg_ascii_1',
      threadId: 'th_ascii_1',
      draftId: 'r-ascii-1',
      subject: 'Booking for Saturday Night',
      from: 'customer@example.com',
      classificationCategory: 'booking_inquiry',
      confidence: 1.0,
      draftReply: 'We would love to host your event.',
    });

    actionStore.approveAction(action.actionId, {
      decision: 'approved',
      approvedBy: 'owner_voice',
      approvedAt: new Date().toISOString(),
      approvalSource: 'voice',
    });

    let sendCalled = false;
    const mockAdapter: GmailSendAdapter = {
      getReplyDraft: async () => ({
        draftId: action.draftId!,
        to: action.from,
        subject: 'Re: Booking for Saturday Night',
        bodyText: action.proposedAction.payload?.draftReply as string,
      }),
      sendReplyDraft: async () => {
        sendCalled = true;
        return { messageId: 'msg_sent_ascii', threadId: action.threadId };
      },
    };

    const executor = new DefaultActionExecutor(mockAdapter);
    const result = await executor.executeApprovedAction(action.actionId, {
      auth: {} as OAuth2Client,
      actionStore,
    });

    assert.equal(result.success, true);
    assert.equal(result.status, 'SENT');
    assert.equal(sendCalled, true);
  });

  it('12. recipient display name with non-ASCII is RFC 2047 encoded while keeping ASCII email address intact', () => {
    const rawTo = 'José García <jose@example.com>';
    const encoded = encodeRecipientHeader(rawTo);
    assert.equal(encoded, '=?UTF-8?B?Sm9zw6kgR2FyY8OtYQ==?= <jose@example.com>');

    // decodeRfc2047 decodes display name cleanly
    const decoded = decodeRfc2047(encoded);
    assert.equal(decoded, rawTo);

    // Pure ASCII recipient is unchanged
    const asciiTo = 'Hector Pacheco <hector@example.com>';
    assert.equal(encodeRecipientHeader(asciiTo), asciiTo);
  });

  it('13. Q-encoded RFC 2047 headers decode correctly', () => {
    const qHeader = '=?UTF-8?Q?R=C3=A9sum=C3=A9_-_Jos=C3=A9?=';
    assert.equal(decodeRfc2047(qHeader), 'Résumé - José');
  });

  it('14. multi-word chunked headers with linear whitespace collapse correctly (§6.2)', () => {
    // 🖕🏽 split across two adjacent words
    const fullEmojiBuf = Buffer.from('🖕🏽', 'utf-8');
    const w1 = fullEmojiBuf.subarray(0, 4).toString('base64');
    const w2 = fullEmojiBuf.subarray(4).toString('base64');
    const multiWord = `Re: =?UTF-8?B?${w1}?=   \r\n\t =?UTF-8?B?${w2}?=`;

    assert.equal(decodeRfc2047(multiWord), 'Re: 🖕🏽');
    assert.equal(normalizeSubject(multiWord), '🖕🏽');
  });
});
