import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import twilio from 'twilio';
import { WebSocket } from 'ws';
import { ActionStore } from '../src/actions/store.js';
import { VoiceStore } from '../src/voice/store.js';
import { createVoiceServer } from '../src/voice/server.js';
import { generateConversationRelayTwiML } from '../src/voice/twilio.js';
import { createOwnerCallerIdAuthorizer, normalizeE164, INBOUND_OWNER_WELCOME, PRIVATE_LINE_MESSAGE } from '../src/voice/inbound.js';
import type { ActionExecutor } from '../src/actions/executor.js';
import type { EligibleInboxMessage } from '../src/voice/mailbox.js';
import type { RuntimeSink } from '../src/voice/presenceReporter.js';

const OWNER = '+19495550123';
const BUSINESS = '+17145550199';
const STRANGER = '+13105550111';
const TOKEN = 'test_auth_token_not_real';
const PUBLIC = 'https://pacific-ops-test.ngrok.app';

const messages: EligibleInboxMessage[] = [
  { index: 1, messageId: 'm1', threadId: 't1', from: 'Alice Johnson <alice@example.com>', senderName: 'Alice Johnson', subject: 'Photo Booth for Birthday Party', date: '2026-10-09T12:00:00Z', internalDate: 3, body: 'Hi Hector, I would like to book a photo booth for my birthday on Nov 14th in Irvine.' },
  { index: 2, messageId: 'm2', threadId: 't2', from: 'Bob Smith <bob@example.com>', senderName: 'Bob Smith', subject: 'Corporate Holiday Gala Inquiry', date: '2026-10-09T11:00:00Z', internalDate: 2, body: 'Hello Pacific Horizon Labs, we need a photo booth for 200 guests on Dec 10th.' },
  { index: 3, messageId: 'm3', threadId: 't3', from: 'Carol White <carol@example.com>', senderName: 'Carol White', subject: 'Wedding Photo Booth Availability', date: '2026-10-09T10:00:00Z', internalDate: 1, body: 'Are you available for a Newport Beach wedding on Jan 20th?' },
];

describe('Inbound caller authorization (owner beta)', () => {
  const auth = createOwnerCallerIdAuthorizer({ ownerE164: OWNER, businessE164: BUSINESS });

  it('normalizes formatted E.164 and rejects non-E.164 values', () => {
    assert.equal(normalizeE164(' +1 (949) 555-0123 '), OWNER);
    assert.equal(normalizeE164('9495550123'), null, 'no country code is not guessed');
    assert.equal(normalizeE164('anonymous'), null);
    assert.equal(normalizeE164('+0123456789'), null);
    assert.equal(normalizeE164(undefined), null);
  });

  it('authorizes the configured owner', () => {
    const d = auth.authorize({ from: OWNER, to: BUSINESS });
    assert.equal(d.authorized, true);
    if (d.authorized) assert.deepEqual({ role: d.identity.role, method: d.identity.method }, { role: 'owner', method: 'caller_id' });
  });

  it('rejects unknown, missing, malformed and misrouted callers', () => {
    assert.deepEqual(auth.authorize({ from: STRANGER, to: BUSINESS }), { authorized: false, reason: 'not_owner' });
    assert.deepEqual(auth.authorize({ from: undefined, to: BUSINESS }), { authorized: false, reason: 'missing_from' });
    assert.deepEqual(auth.authorize({ from: '', to: BUSINESS }), { authorized: false, reason: 'missing_from' });
    assert.deepEqual(auth.authorize({ from: 'anonymous', to: BUSINESS }), { authorized: false, reason: 'malformed_from' });
    assert.deepEqual(auth.authorize({ from: OWNER, to: STRANGER }), { authorized: false, reason: 'wrong_destination' });
  });

  it('fails closed when no owner number is configured', () => {
    assert.deepEqual(createOwnerCallerIdAuthorizer({ ownerE164: undefined }).authorize({ from: OWNER }), { authorized: false, reason: 'owner_not_configured' });
  });
});

describe('Outbound TwiML is unchanged', () => {
  it('produces the original ConversationRelay TwiML when called without options', () => {
    const xml = generateConversationRelayTwiML('wss://x.example/voice/ws?sessionId=abc');
    assert.equal(
      xml,
      '<?xml version="1.0" encoding="UTF-8"?><Response><Connect><ConversationRelay url="wss://x.example/voice/ws?sessionId=abc" dtmfDetection="true"/></Connect></Response>'
    );
  });
});

describe('POST /voice/inbound and the inbound ConversationRelay session', () => {
  let dir: string;
  let voiceStore: VoiceStore;
  let actionStore: ActionStore;
  let server: ReturnType<typeof createVoiceServer>;
  let base: string;
  let sink: { states: string[]; publish: RuntimeSink['publish'] };
  let sends: number;
  const saved: Record<string, string | undefined> = {};

  const sign = (url: string, params: Record<string, string>) => twilio.getExpectedTwilioSignature(TOKEN, url, params);

  async function postInbound(params: Record<string, string>, opts: { signature?: string | null } = {}) {
    const url = `${PUBLIC}/voice/inbound`;
    const signature = opts.signature === undefined ? sign(url, params) : opts.signature;
    const res = await fetch(`${base}/voice/inbound`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(signature ? { 'X-Twilio-Signature': signature } : {}) },
      body: new URLSearchParams(params).toString(),
    });
    return { status: res.status, body: await res.text() };
  }

  const callParams = (from: string | undefined, to = BUSINESS): Record<string, string> => ({
    CallSid: 'CA_inbound_test',
    AccountSid: 'AC_test',
    Direction: 'inbound',
    ...(from !== undefined ? { From: from } : {}),
    To: to,
  });

  function openRelay(twiml: string): WebSocket {
    const relayUrl = /ConversationRelay url="([^"]+)"/.exec(twiml)![1].replace(/&amp;/g, '&');
    const local = relayUrl.replace(PUBLIC.replace(/^https/, 'wss'), `ws://127.0.0.1:${server.getPort()}`);
    return new WebSocket(local, { headers: { 'X-Twilio-Signature': sign(relayUrl, {}) } });
  }

  beforeEach(async () => {
    for (const k of ['TWILIO_AUTH_TOKEN', 'PHRO_PUBLIC_BASE_URL', 'PHRO_PUBLIC_WSS_URL', 'PHRO_OWNER_PHONE_E164', 'TWILIO_PHONE_NUMBER_E164', 'PHRO_SKIP_TWILIO_SIGNATURE_VALIDATION']) saved[k] = process.env[k];
    process.env.TWILIO_AUTH_TOKEN = TOKEN;
    process.env.PHRO_PUBLIC_BASE_URL = PUBLIC;
    delete process.env.PHRO_PUBLIC_WSS_URL;
    delete process.env.PHRO_SKIP_TWILIO_SIGNATURE_VALIDATION; // real signature checks
    process.env.PHRO_OWNER_PHONE_E164 = OWNER;
    process.env.TWILIO_PHONE_NUMBER_E164 = BUSINESS;

    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phro-inbound-'));
    voiceStore = new VoiceStore({ dataDir: dir, sessionsFilePath: path.join(dir, 'voice-sessions.json'), eventsFilePath: path.join(dir, 'voice-events.jsonl') });
    actionStore = new ActionStore({ dataDir: dir, actionsFilePath: path.join(dir, 'actions.json'), eventsFilePath: path.join(dir, 'action-events.jsonl') });
    sends = 0;
    const states: string[] = [];
    sink = { states, publish: (e) => void states.push(e.state) };
    const executor: ActionExecutor = {
      async executeApprovedAction(actionId) {
        sends++;
        actionStore.transitionAction(actionId, 'SENT', { actor: 'test' });
        return { success: true, status: 'SENT', messageId: 'sent_inbound' };
      },
    };
    server = createVoiceServer({
      port: 0,
      voiceStore,
      actionStore,
      executor,
      mailboxMessages: messages,
      draftCreator: async (p) => ({ draftId: 'draft_in_1', messageId: 'msg_in_1', threadId: p.threadId }),
      endCallBufferMs: 20,
      runtime: sink,
      presenceOptions: { playbackMs: () => 5 },
    });
    await server.start();
    base = `http://127.0.0.1:${server.getPort()}`;
  });

  afterEach(async () => {
    await server.stop();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('valid signature + owner caller: returns ConversationRelay TwiML in mailbox mode with inbound context', async () => {
    const { status, body } = await postInbound(callParams(OWNER));
    assert.equal(status, 200);
    assert.match(body, /<Connect><ConversationRelay url="wss:\/\/pacific-ops-test\.ngrok\.app\/voice\/ws\?sessionId=vses_/);
    assert.ok(body.includes(`welcomeGreeting="${INBOUND_OWNER_WELCOME.replace("'", '&apos;')}"`) || body.includes('welcomeGreeting="Welcome back.'));
    assert.ok(body.includes('<Parameter name="direction" value="inbound"/>'));
    assert.ok(body.includes('<Parameter name="mode" value="mailbox"/>'));
    assert.ok(body.includes('<Parameter name="callerRole" value="owner"/>'));
    assert.ok(!body.includes(OWNER) && !body.includes(TOKEN), 'no phone numbers or secrets in TwiML');

    const sessions = [...voiceStore.loadSessions().values()];
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].actionId, 'mailbox');
    assert.equal(sessions[0].conversationState, 'MAILBOX_SELECTING');
    assert.deepEqual(
      { mode: sessions[0].metadata?.mode, direction: sessions[0].metadata?.direction, callerRole: sessions[0].metadata?.callerRole },
      { mode: 'mailbox', direction: 'inbound', callerRole: 'owner' }
    );
    assert.equal(sessions[0].callSid, 'CA_inbound_test');
  });

  it('invalid signature: 403 and no session', async () => {
    const { status } = await postInbound(callParams(OWNER), { signature: 'bm90LWEtcmVhbC1zaWduYXR1cmU=' });
    assert.equal(status, 403);
    assert.equal(voiceStore.loadSessions().size, 0);
  });

  it('missing signature: 403 and no session', async () => {
    const { status } = await postInbound(callParams(OWNER), { signature: null });
    assert.equal(status, 403);
    assert.equal(voiceStore.loadSessions().size, 0);
  });

  it('signature for a different URL (wrong ngrok host) fails closed', async () => {
    const params = callParams(OWNER);
    const { status } = await postInbound(params, { signature: sign('https://some-other.ngrok.app/voice/inbound', params) });
    assert.equal(status, 403);
  });

  for (const [label, from] of [
    ['unknown caller', STRANGER],
    ['missing From', undefined],
    ['malformed From', 'anonymous'],
  ] as const) {
    it(`${label}: neutral private-line refusal, hang up, no session`, async () => {
      const { status, body } = await postInbound(callParams(from));
      assert.equal(status, 200);
      assert.ok(body.includes(`<Say>${PRIVATE_LINE_MESSAGE}</Say><Hangup/>`));
      assert.ok(!body.includes('ConversationRelay'));
      assert.ok(!body.includes(OWNER), 'does not disclose the owner number');
      assert.equal(voiceStore.loadSessions().size, 0);
    });
  }

  it('unauthorized caller cannot open a private session over the WebSocket', async () => {
    // Even with a valid Twilio WS signature, an unknown session id is refused at upgrade.
    const fakeUrl = `${PUBLIC.replace(/^https/, 'wss')}/voice/ws?sessionId=vses_guess_00000000`;
    const ws = new WebSocket(fakeUrl.replace(PUBLIC.replace(/^https/, 'wss'), `ws://127.0.0.1:${server.getPort()}`), { headers: { 'X-Twilio-Signature': sign(fakeUrl, {}) } });
    const outcome = await new Promise<string>((r) => {
      ws.on('unexpected-response', (_req, res) => r(`http ${res.statusCode}`));
      ws.on('open', () => r('open'));
      ws.on('error', () => r('error'));
    });
    assert.equal(outcome, 'http 404');

    // A tampered inbound session record without an owner role is closed immediately.
    const forged = voiceStore.createSession({ actionId: 'mailbox', toPhone: BUSINESS, fromPhone: STRANGER, conversationState: 'MAILBOX_SELECTING', metadata: { mode: 'mailbox', direction: 'inbound' } });
    const forgedUrl = `${PUBLIC.replace(/^https/, 'wss')}/voice/ws?sessionId=${forged.sessionId}`;
    const ws2 = new WebSocket(forgedUrl.replace(PUBLIC.replace(/^https/, 'wss'), `ws://127.0.0.1:${server.getPort()}`), { headers: { 'X-Twilio-Signature': sign(forgedUrl, {}) } });
    const close = await new Promise<{ code: number; reason: string; texts: number }>((r) => {
      let texts = 0;
      ws2.on('open', () => ws2.send(JSON.stringify({ type: 'setup', customParameters: { direction: 'inbound', callerRole: 'owner' } })));
      ws2.on('message', () => texts++);
      ws2.on('close', (code, reason) => r({ code, reason: reason.toString(), texts }));
    });
    assert.equal(close.code, 1008);
    assert.equal(close.texts, 0, 'no mailbox content was spoken');
  });

  it('WebSocket without a valid Twilio signature is refused', async () => {
    const { body } = await postInbound(callParams(OWNER));
    const relayUrl = /ConversationRelay url="([^"]+)"/.exec(body)![1].replace(/&amp;/g, '&');
    const ws = new WebSocket(relayUrl.replace(PUBLIC.replace(/^https/, 'wss'), `ws://127.0.0.1:${server.getPort()}`), { headers: { 'X-Twilio-Signature': 'bad' } });
    const outcome = await new Promise<string>((r) => {
      ws.on('unexpected-response', (_req, res) => r(`http ${res.statusCode}`));
      ws.on('open', () => r('open'));
      ws.on('error', () => r('error'));
    });
    assert.equal(outcome, 'http 403');
  });

  it('owner inbound call runs the existing mailbox flow end to end, with live runtime states', async () => {
    const { body } = await postInbound(callParams(OWNER));
    const ws = openRelay(body);
    const spoken: string[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({ type: 'setup', callSid: 'CA_inbound_test', customParameters: { direction: 'inbound', mode: 'mailbox', callerRole: 'owner' } })));
      ws.on('message', async (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'end') return resolve();
        if (msg.type !== 'text') return;
        spoken.push(msg.token);
        const send = (t: string) => ws.send(JSON.stringify({ type: 'prompt', voicePrompt: t, last: true }));
        if (msg.token.includes('I found three recent business emails')) send('number two');
        else if (msg.token.includes('Selected message 2')) send('draft a response');
        else if (msg.token.includes('I created a draft reply in Gmail')) send('approve');
        else if (msg.token.includes('confirm approval') && !msg.token.includes('Approval confirmed')) {
          await new Promise((r) => setTimeout(r, 30));
          send('confirm approval');
        }
      });
      ws.on('close', () => resolve());
      ws.on('error', reject);
    });
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(spoken[0].includes('I found three recent business emails'), 'same mailbox greeting as outbound');
    assert.ok(spoken.some((t) => t.includes('Selected message 2 from Bob Smith')));
    assert.equal(sends, 1, 'exactly one send, only after confirm approval');

    const session = [...voiceStore.loadSessions().values()][0];
    assert.equal(session.metadata?.direction, 'inbound');
    assert.equal(session.conversationState, 'COMPLETE');
    const action = actionStore.getAction(session.metadata?.boundActionId as string);
    assert.equal(action?.status, 'SENT');
    assert.equal(action?.approvalMetadata?.approvalSource, 'voice');
    assert.equal(action?.approvalMetadata?.approvedBy, 'owner_voice');

    const expected = ['idle', 'speaking', 'thinking', 'speaking', 'thinking', 'speaking', 'thinking', 'speaking', 'awaiting_approval', 'thinking', 'executing', 'success', 'idle'];
    let i = 0;
    for (const s of sink.states) if (s === expected[i]) i++;
    assert.equal(i, expected.length, `runtime states: ${sink.states.join(' > ')}`);
  });

  it('"approve" alone on an inbound call never sends', async () => {
    const { body } = await postInbound(callParams(OWNER));
    const ws = openRelay(body);
    await new Promise<void>((resolve) => {
      ws.on('open', () => ws.send(JSON.stringify({ type: 'setup', callSid: 'CA_inbound_test' })));
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type !== 'text') return;
        const send = (t: string) => ws.send(JSON.stringify({ type: 'prompt', voicePrompt: t, last: true }));
        if (msg.token.includes('Approval was not confirmed')) ws.close();
        else if (msg.token.includes('I found three recent business emails')) send('number one');
        else if (msg.token.includes('Selected message 1')) send('draft a response');
        else if (msg.token.includes('I created a draft reply in Gmail')) send('approve');
        else if (msg.token.includes('confirm approval')) send('yes send it');
      });
      ws.on('close', () => resolve());
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(sends, 0);
    assert.ok(!sink.states.includes('executing'));
  });

  it('a completed inbound session cannot be reconnected', async () => {
    const { body } = await postInbound(callParams(OWNER));
    const session = [...voiceStore.loadSessions().values()][0];
    voiceStore.updateSessionStatus(session.sessionId, 'COMPLETED');
    const ws = openRelay(body);
    const code = await new Promise<number>((r) => ws.on('close', (c) => r(c)));
    assert.equal(code, 1008);
  });
});
