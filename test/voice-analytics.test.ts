import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import twilio from 'twilio';
import { WebSocket } from 'ws';
import { ActionStore } from '../src/actions/store.js';
import { VoiceStore } from '../src/voice/store.js';
import { handleVoiceUtterance } from '../src/voice/conversation.js';
import { createVoiceServer } from '../src/voice/server.js';
import { VoicePresenceReporter, type RuntimeSink } from '../src/voice/presenceReporter.js';
import {
  PHOTO_BOOTH_MAILBOX_COMMAND_GUIDANCE,
  PHOTO_BOOTH_PROGRESS_TEXT,
  isPhotoBoothAnalyticsRequest,
  isReturnToInboxRequest,
  normalizeUtterance,
  spokenAnalyticsFailure,
} from '../src/voice/analytics.js';
import { PHOTO_BOOTH_VOICE_STYLE } from '../src/photobooth/agent.js';
import { findSemanticViolations } from '../src/photobooth/semantics.js';
import type { ActionExecutor } from '../src/actions/executor.js';
import type { EligibleInboxMessage } from '../src/voice/mailbox.js';
import type { FetchLike } from '../src/photobooth/client.js';
import {
  SECRET,
  EVENT_A,
  mockFetch,
  makeClient,
  textMessage,
  toolMessage,
  fakeAnthropic,
  captureConsole,
} from './helpers/photoBoothFakes.js';

const messages: EligibleInboxMessage[] = [
  { index: 1, messageId: 'm1', threadId: 't1', from: 'Alice Johnson <alice@example.com>', senderName: 'Alice Johnson', subject: 'Photo Booth for Birthday Party', date: '2026-10-09T12:00:00Z', internalDate: 3, body: 'Hi Hector, I would like to book a photo booth for my birthday on Nov 14th in Irvine.' },
  { index: 2, messageId: 'm2', threadId: 't2', from: 'Bob Smith <bob@example.com>', senderName: 'Bob Smith', subject: 'Corporate Holiday Gala Inquiry', date: '2026-10-09T11:00:00Z', internalDate: 2, body: 'We need a photo booth for 200 guests on Dec 10th.' },
  { index: 3, messageId: 'm3', threadId: 't3', from: 'Carol White <carol@example.com>', senderName: 'Carol White', subject: 'Wedding Photo Booth Availability', date: '2026-10-09T10:00:00Z', internalDate: 1, body: 'Are you available for a Newport Beach wedding on Jan 20th?' },
];

const READ_OPERATIONS = new Set(['latest_event', 'event_summary', 'feedback_summary', 'delivery_health', 'compare_events']);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

const SUMMARY_ANSWER =
  'The latest event recorded 97 delivery sessions. 88 reached ready state and 9 remain unfinalized. 55 distinct sessions clicked download.';

describe('Photo Booth voice routing (unit)', () => {
  it('recognizes booth analytics questions', () => {
    for (const q of [
      'How did the latest photo booth event perform?',
      'How many downloads did we get?',
      'Any delivery issues?',
      'How many Instagram clicks?',
      'What feedback did we get?',
      'Did we get any Google reviews?',
      'Compare the latest event to event 1234',
      'How did the booth do tonight?',
      'Are there any unfinalized sessions?',
    ]) {
      assert.equal(isPhotoBoothAnalyticsRequest(normalizeUtterance(q)), true, q);
    }
  });

  it('never claims mailbox commands, including emails whose subject mentions the booth', () => {
    for (const q of [
      'message one',
      'number two',
      'draft a response',
      'read the draft',
      'approve',
      'confirm approval',
      'reject',
      'go back',
      'summarize',
      'read more',
      'repeat',
      'help',
      'summarize the photo booth email',
      'read the email about the booth',
      'the feedback email from Carol',
      'tell me about the event',
    ]) {
      assert.equal(isPhotoBoothAnalyticsRequest(normalizeUtterance(q)), false, q);
    }
  });

  it('recognizes return-to-inbox phrases', () => {
    for (const q of ['Go back to my inbox.', 'back to my emails', 'inbox', 'go back', 'return to the mailbox', 'check my email']) {
      assert.equal(isReturnToInboxRequest(normalizeUtterance(q)), true, q);
    }
    assert.equal(isReturnToInboxRequest(normalizeUtterance('How many downloads?')), false);
  });

  it('voice style forbids UUIDs, raw timestamps, and tool names', () => {
    assert.match(PHOTO_BOOTH_VOICE_STYLE, /Do not read event UUIDs/);
    assert.match(PHOTO_BOOTH_VOICE_STYLE, /never read raw ISO timestamps/);
    assert.match(PHOTO_BOOTH_VOICE_STYLE, /tool names/);
  });
});

describe('Photo Booth voice analytics conversation', () => {
  let dir: string;
  let voiceStore: VoiceStore;
  let actionStore: ActionStore;
  let sessionId: string;
  let sends: number;
  let drafts: number;
  let progress: Array<{ text: string; stillWorking?: boolean }>;
  let fetchImpl: FetchLike;
  let http: Array<{ method: string; body: Record<string, unknown> }>;
  let console_: ReturnType<typeof captureConsole>;

  const executor: ActionExecutor = {
    async executeApprovedAction() {
      sends++;
      return { success: true, status: 'SENT' };
    },
  };
  const draftCreator = async (p: { threadId?: string }) => {
    drafts++;
    return { draftId: 'd1', messageId: 'mm1', threadId: p.threadId };
  };

  function useFetch(mock: ReturnType<typeof mockFetch>) {
    fetchImpl = mock.fetchImpl;
    http = mock.requests;
  }

  async function say(utterance: string, anthropic: ReturnType<typeof fakeAnthropic>['client']) {
    const session = voiceStore.getSession(sessionId)!;
    return handleVoiceUtterance({
      session,
      utterance,
      voiceStore,
      actionStore,
      executor,
      draftCreator,
      onProgress: (text, opts) => progress.push({ text, stillWorking: opts?.stillWorking }),
      photoBooth: { analytics: makeClient(fetchImpl), anthropic, model: 'test-model' },
    });
  }

  /** Scripted model turn for "how did the latest event perform": latest_event -> event_summary -> answer. */
  function latestEventScript(answer = SUMMARY_ANSWER) {
    return [
      toolMessage('t1', 'get_latest_photo_booth_event', {}),
      toolMessage('t2', 'get_photo_booth_event_summary', { eventId: EVENT_A }),
      textMessage(answer),
    ];
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phro-voice-pb-'));
    voiceStore = new VoiceStore({ dataDir: dir, sessionsFilePath: path.join(dir, 'voice-sessions.json'), eventsFilePath: path.join(dir, 'voice-events.jsonl') });
    actionStore = new ActionStore({ dataDir: dir, actionsFilePath: path.join(dir, 'actions.json'), eventsFilePath: path.join(dir, 'action-events.jsonl') });
    sends = 0;
    drafts = 0;
    progress = [];
    useFetch(mockFetch());
    const s = voiceStore.createSession({ actionId: 'mailbox', toPhone: '+15550000001', fromPhone: '+15550000002', conversationState: 'MAILBOX_SELECTING', metadata: { mode: 'mailbox', availableMessages: messages } });
    sessionId = s.sessionId;
    voiceStore.updateConversationState(sessionId, 'MAILBOX_SELECTING', { lastSpokenText: 'I found three recent business emails. Which would you like to review?' });
    console_ = captureConsole();
  });

  afterEach(() => {
    console_.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('routes a booth question from the mailbox into the analytics domain via the existing agent', async () => {
    const ai = fakeAnthropic(latestEventScript());
    const turn = await say('How did the latest photo booth event perform?', ai.client);

    assert.equal(turn.responseText, SUMMARY_ANSWER);
    assert.equal(turn.endCall, false);
    const session = voiceStore.getSession(sessionId)!;
    assert.equal(session.conversationState, 'PHOTO_BOOTH_ANALYTICS');
    assert.equal(session.lastSpokenText, SUMMARY_ANSWER);
    assert.deepEqual(http.map((r) => r.body), [{ operation: 'latest_event' }, { operation: 'event_summary', eventId: EVENT_A }]);
    assert.deepEqual(progress, [{ text: PHOTO_BOOTH_PROGRESS_TEXT, stillWorking: true }]);
    assert.match(String(ai.requests[0].system), /spoken aloud on a phone call/);
    // Minimal context only: event ID and the last exchange, never API payloads.
    assert.deepEqual(session.metadata?.photoBooth, { eventId: EVENT_A, lastQuestion: 'How did the latest photo booth event perform?', lastAnswer: SUMMARY_ANSWER });
    assert.equal(session.metadata?.resumeConversationState, 'MAILBOX_SELECTING');
    assert.deepEqual(session.metadata?.availableMessages, messages, 'mailbox state preserved');
  });

  it('keeps event context for "How many downloads?" and "What about Instagram?"', async () => {
    await say('How did the latest photo booth event perform?', fakeAnthropic(latestEventScript()).client);
    const beforeFollowUps = http.length;

    const downloadsAnswer = '55 distinct sessions clicked download, 80 download clicks in total.';
    const downloads = fakeAnthropic([toolMessage('t3', 'get_photo_booth_event_summary', { eventId: EVENT_A }), textMessage(downloadsAnswer)]);
    const t1 = await say('How many downloads?', downloads.client);
    assert.equal(t1.responseText, downloadsAnswer);

    // The follow-up reached the agent with the previous exchange and the resolved event.
    const req = downloads.requests[0];
    assert.equal(req.messages[0].content, 'How did the latest photo booth event perform?');
    assert.equal(req.messages[1].content, SUMMARY_ANSWER);
    assert.match(String(req.messages[2].content), new RegExp(`How many downloads\\?[\\s\\S]*${EVENT_A}`));

    const igAnswer = 'There were 20 Instagram CTA clicks from 15 distinct booth sessions.';
    const ig = fakeAnthropic([toolMessage('t4', 'get_photo_booth_event_summary', { eventId: EVENT_A }), textMessage(igAnswer)]);
    const t2 = await say('What about Instagram?', ig.client);
    assert.equal(t2.responseText, igAnswer);
    assert.equal(ig.requests[0].messages[0].content, 'How many downloads?');

    assert.deepEqual(http.slice(beforeFollowUps).map((r) => r.body.operation), ['event_summary', 'event_summary'], 'no latest_event re-lookup on follow-ups');
    assert.equal(voiceStore.getSession(sessionId)!.conversationState, 'PHOTO_BOOTH_ANALYTICS');
  });

  it('Instagram follower phrasing is revised to CTA wording before it is spoken', async () => {
    await say('How did the latest photo booth event perform?', fakeAnthropic(latestEventScript()).client);
    const ai = fakeAnthropic([
      toolMessage('t3', 'get_photo_booth_event_summary', { eventId: EVENT_A }),
      textMessage('We gained 15 new followers on Instagram.'),
      textMessage('There were 20 Instagram CTA clicks from 15 distinct booth sessions. Clicks do not confirm follows.'),
    ]);
    const turn = await say('What about Instagram?', ai.client);
    assert.match(turn.responseText, /20 Instagram CTA clicks/);
    assert.doesNotMatch(turn.responseText, /new followers/);
    assert.deepEqual(findSemanticViolations(turn.responseText), []);
  });

  it('Google review questions are answered as CTA clicks, not submitted reviews', async () => {
    await say('How did the latest photo booth event perform?', fakeAnthropic(latestEventScript()).client);
    const ai = fakeAnthropic([
      toolMessage('t3', 'get_photo_booth_event_summary', { eventId: EVENT_A }),
      textMessage('Yes, we got 1 Google review.'),
      textMessage('The telemetry only records Google Review CTA clicks, not submitted reviews. There was 1 Google Review CTA click.'),
    ]);
    const turn = await say('Did we get any Google reviews?', ai.client);
    assert.match(turn.responseText, /1 Google Review CTA click/);
    assert.doesNotMatch(turn.responseText, /got 1 Google review\b/);
    assert.deepEqual(findSemanticViolations(turn.responseText), []);
  });

  it('unfinalized sessions are never spoken as failures, and the spoken fallback has no UUIDs or timestamps', async () => {
    const ai = fakeAnthropic([
      toolMessage('t1', 'get_latest_photo_booth_event', {}),
      toolMessage('t2', 'get_photo_booth_event_summary', { eventId: EVENT_A }),
      textMessage('9 uploads failed at the event.'),
      textMessage('Again, 9 uploads failed.'),
    ]);
    const turn = await say('Any delivery problems at the booth?', ai.client);
    assert.match(turn.responseText, /9 remain unfinalized/);
    assert.match(turn.responseText, /does not establish why/);
    assert.doesNotMatch(turn.responseText, /fail|crash/i);
    assert.doesNotMatch(turn.responseText, UUID);
    assert.doesNotMatch(turn.responseText, ISO);
  });

  it('repeat replays the spoken answer without another API or model call', async () => {
    const ai = fakeAnthropic(latestEventScript());
    const first = await say('How did the latest photo booth event perform?', ai.client);
    const httpCount = http.length;
    const modelCount = ai.requests.length;

    const again = await say('Repeat.', ai.client);
    const sayAgain = await say('Say that again.', ai.client);
    assert.equal(again.responseText, first.responseText);
    assert.equal(sayAgain.responseText, first.responseText);
    assert.equal(http.length, httpCount);
    assert.equal(ai.requests.length, modelCount);
    assert.equal(voiceStore.getSession(sessionId)!.conversationState, 'PHOTO_BOOTH_ANALYTICS');
  });

  it('network failure is spoken as unavailable, never as zero activity', async () => {
    useFetch(mockFetch(() => 'throw'));
    const ai = fakeAnthropic([
      toolMessage('t1', 'get_latest_photo_booth_event', {}),
      textMessage('There was no activity and zero sessions.'),
    ]);
    const turn = await say('How did the latest photo booth event perform?', ai.client);
    assert.equal(turn.responseText, "The Photo Booth analytics service isn't responding right now.");
    assert.doesNotMatch(turn.responseText, /no activity|zero/i);
    assert.equal(voiceStore.getSession(sessionId)!.metadata?.photoBooth, undefined, 'failed answers are not stored as context');
  });

  it('unauthorized upstream and malformed responses get their own spoken failures', async () => {
    useFetch(mockFetch(() => ({ status: 401, body: { error: 'Unauthorized' } })));
    let turn = await say('How did the booth do?', fakeAnthropic([toolMessage('t1', 'get_latest_photo_booth_event', {}), textMessage('ok')]).client);
    assert.equal(turn.responseText, "I can't authenticate with the Photo Booth analytics service.");

    useFetch(mockFetch(() => ({ status: 200, body: { nope: true } })));
    turn = await say('How did the booth do?', fakeAnthropic([toolMessage('t1', 'get_latest_photo_booth_event', {}), textMessage('ok')]).client);
    assert.equal(turn.responseText, "I received an invalid analytics response, so I won't report those numbers.");
  });

  it('missing reporting credential fails safely without calling the model or the API', async () => {
    const saved = process.env.PHOTO_BOOTH_REPORTING_API_KEY;
    delete process.env.PHOTO_BOOTH_REPORTING_API_KEY;
    try {
      const ai = fakeAnthropic([]);
      const session = voiceStore.getSession(sessionId)!;
      const turn = await handleVoiceUtterance({
        session,
        utterance: 'How did the latest photo booth event perform?',
        voiceStore,
        actionStore,
        photoBooth: { anthropic: ai.client }, // no analytics client: falls back to env, which has no key
      });
      assert.equal(turn.responseText, "Photo Booth analytics isn't configured right now.");
      assert.equal(ai.requests.length, 0);
    } finally {
      if (saved !== undefined) process.env.PHOTO_BOOTH_REPORTING_API_KEY = saved;
    }
  });

  it('mailbox -> analytics -> back restores the selected email and its draft options', async () => {
    const selected = await say('message one', fakeAnthropic([]).client);
    assert.match(selected.responseText, /Selected message 1 from Alice Johnson/);
    await say('draft a response', fakeAnthropic([]).client);
    assert.equal(drafts, 1);
    const boundActionId = voiceStore.getSession(sessionId)!.metadata?.boundActionId;

    await say('How did the latest photo booth event perform?', fakeAnthropic(latestEventScript()).client);
    assert.equal(voiceStore.getSession(sessionId)!.conversationState, 'PHOTO_BOOTH_ANALYTICS');

    const back = await say('Go back to my inbox.', fakeAnthropic([]).client);
    assert.match(back.responseText, /Back to the email from Alice Johnson about "Photo Booth for Birthday Party"/);
    assert.match(back.responseText, /approve/);
    const session = voiceStore.getSession(sessionId)!;
    assert.equal(session.conversationState, 'READY');
    assert.equal(session.metadata?.boundActionId, boundActionId, 'draft binding survives the detour');
    assert.equal(session.metadata?.resumeConversationState, null);

    // The existing two-step approval still works after returning.
    const approve = await say('approve', fakeAnthropic([]).client);
    assert.match(approve.responseText, /confirm approval/);
    await say('confirm approval', fakeAnthropic([]).client);
    assert.equal(sends, 1);
  });

  it('analytics -> mailbox from message selection, then mailbox commands work normally', async () => {
    await say('How did the latest photo booth event perform?', fakeAnthropic(latestEventScript()).client);
    const back = await say('back to my emails', fakeAnthropic([]).client);
    assert.equal(back.responseText, 'Back to your inbox. You can choose message one, message two, or message three.');
    assert.equal(voiceStore.getSession(sessionId)!.conversationState, 'MAILBOX_SELECTING');

    const pick = await say('message two', fakeAnthropic([]).client);
    assert.match(pick.responseText, /Selected message 2 from Bob Smith/);
    assert.equal(voiceStore.getSession(sessionId)!.conversationState, 'READY');
  });

  it('analytics creates no Gmail draft, no action, no approval, and sends only read operations', async () => {
    await say('How did the latest photo booth event perform?', fakeAnthropic(latestEventScript()).client);
    await say('How many downloads?', fakeAnthropic([toolMessage('t3', 'get_photo_booth_event_summary', { eventId: EVENT_A }), textMessage('55 distinct sessions clicked download.')]).client);

    // Mailbox action words are refused inside the analytics domain.
    for (const cmd of ['approve', 'confirm approval', 'draft a response', 'message two']) {
      const turn = await say(cmd, fakeAnthropic([]).client);
      assert.equal(turn.responseText, PHOTO_BOOTH_MAILBOX_COMMAND_GUIDANCE, cmd);
      assert.equal(voiceStore.getSession(sessionId)!.conversationState, 'PHOTO_BOOTH_ANALYTICS');
    }

    assert.equal(actionStore.listActions().length, 0);
    assert.equal(drafts, 0);
    assert.equal(sends, 0);
    assert.ok(http.length > 0);
    for (const r of http) {
      assert.equal(r.method, 'POST');
      assert.ok(READ_OPERATIONS.has(String(r.body.operation)), `unexpected operation ${String(r.body.operation)}`);
    }
  });

  it('a pending approval confirmation is never interrupted by an analytics question', async () => {
    await say('message one', fakeAnthropic([]).client);
    await say('draft a response', fakeAnthropic([]).client);
    await say('approve', fakeAnthropic([]).client);
    assert.equal(voiceStore.getSession(sessionId)!.conversationState, 'AWAITING_APPROVAL_CONFIRMATION');

    const ai = fakeAnthropic([]);
    const turn = await say('How did the latest photo booth event perform?', ai.client);
    assert.match(turn.responseText, /Approval was not confirmed/);
    assert.equal(voiceStore.getSession(sessionId)!.conversationState, 'AWAITING_APPROVAL_CONFIRMATION');
    assert.equal(ai.requests.length, 0);
    assert.equal(http.length, 0);
    assert.equal(sends, 0);
  });

  it('never writes the reporting key to logs, session state, or voice events', async () => {
    await say('How did the latest photo booth event perform?', fakeAnthropic(latestEventScript()).client);
    useFetch(mockFetch(() => ({ status: 401, body: { error: `bad ${SECRET}` } })));
    await say('Any delivery problems?', fakeAnthropic([toolMessage('t1', 'get_photo_booth_delivery_health', { eventId: EVENT_A }), textMessage('ok')]).client);

    for (const file of fs.readdirSync(dir)) {
      assert.ok(!fs.readFileSync(path.join(dir, file), 'utf-8').includes(SECRET), file);
    }
    for (const line of console_.lines) assert.ok(!line.includes(SECRET), line);
    const events = fs.readFileSync(path.join(dir, 'voice-events.jsonl'), 'utf-8');
    assert.match(events, /Photo Booth analytics answered:model \(tools: get_latest_photo_booth_event, get_photo_booth_event_summary; event 11111111/);
  });

  it('spoken failure messages cover every error kind', () => {
    assert.equal(spokenAnalyticsFailure('config'), "Photo Booth analytics isn't configured right now.");
    assert.equal(spokenAnalyticsFailure('timeout'), "The Photo Booth analytics service isn't responding right now.");
    assert.equal(spokenAnalyticsFailure('upstream_error'), "The Photo Booth analytics service isn't responding right now.");
    assert.match(spokenAnalyticsFailure('agent'), /couldn't analyze/);
  });
});

describe('Photo Booth analytics runtime presence', () => {
  it('progress speech settles back to thinking, and the task label reflects analytics', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phro-voice-pb-rt-'));
    try {
      const voiceStore = new VoiceStore({ dataDir: dir, sessionsFilePath: path.join(dir, 's.json'), eventsFilePath: path.join(dir, 'e.jsonl') });
      const s = voiceStore.createSession({ actionId: 'mailbox', toPhone: '+15550000001', fromPhone: '+15550000002', conversationState: 'MAILBOX_SELECTING', metadata: { mode: 'mailbox' } });
      const events: Array<{ state: string; task: string | null; operation: string | null }> = [];
      const sink: RuntimeSink = { publish: (e) => void events.push({ state: e.state, task: e.task, operation: e.operation }) };
      const timers: Array<() => void> = [];
      const reporter = new VoicePresenceReporter(sink, voiceStore, { setTimer: (fn) => timers.push(fn), clearTimer: () => {}, log: () => {} });

      reporter.sessionConnected(s.sessionId);
      reporter.processing(s.sessionId);
      voiceStore.updateConversationState(s.sessionId, 'PHOTO_BOOTH_ANALYTICS');
      reporter.speaking(s.sessionId, PHOTO_BOOTH_PROGRESS_TEXT, { stillWorking: true });
      timers.shift()!();
      reporter.speaking(s.sessionId, SUMMARY_ANSWER);
      timers.shift()!();

      assert.deepEqual(events.map((e) => e.state), ['idle', 'thinking', 'speaking', 'thinking', 'speaking', 'listening']);
      const analytics = events.slice(2);
      for (const e of analytics) {
        assert.equal(e.task, 'Photo Booth analytics');
        assert.equal(e.operation, 'photo_booth_analytics');
      }
      assert.ok(!events.some((e) => e.state === 'executing' || e.state === 'success'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Inbound Pacific Ops call with Photo Booth analytics (end to end)', () => {
  const OWNER = '+19495550123';
  const BUSINESS = '+17145550199';
  const TOKEN = 'test_auth_token_not_real';
  const PUBLIC = 'https://pacific-ops-test.ngrok.app';
  const savedEnv: Record<string, string | undefined> = {};
  let dir: string;
  let server: ReturnType<typeof createVoiceServer>;
  let states: string[];
  let actionStore: ActionStore;
  let http: Array<{ body: Record<string, unknown> }>;

  beforeEach(async () => {
    for (const k of ['TWILIO_AUTH_TOKEN', 'PHRO_PUBLIC_BASE_URL', 'PHRO_PUBLIC_WSS_URL', 'PHRO_OWNER_PHONE_E164', 'TWILIO_PHONE_NUMBER_E164', 'PHRO_SKIP_TWILIO_SIGNATURE_VALIDATION']) savedEnv[k] = process.env[k];
    process.env.TWILIO_AUTH_TOKEN = TOKEN;
    process.env.PHRO_PUBLIC_BASE_URL = PUBLIC;
    delete process.env.PHRO_PUBLIC_WSS_URL;
    delete process.env.PHRO_SKIP_TWILIO_SIGNATURE_VALIDATION;
    process.env.PHRO_OWNER_PHONE_E164 = OWNER;
    process.env.TWILIO_PHONE_NUMBER_E164 = BUSINESS;

    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phro-voice-pb-e2e-'));
    const voiceStore = new VoiceStore({ dataDir: dir, sessionsFilePath: path.join(dir, 'voice-sessions.json'), eventsFilePath: path.join(dir, 'voice-events.jsonl') });
    actionStore = new ActionStore({ dataDir: dir, actionsFilePath: path.join(dir, 'actions.json'), eventsFilePath: path.join(dir, 'action-events.jsonl') });
    states = [];
    const mock = mockFetch();
    http = mock.requests;
    const ai = fakeAnthropic([
      toolMessage('t1', 'get_latest_photo_booth_event', {}),
      toolMessage('t2', 'get_photo_booth_event_summary', { eventId: EVENT_A }),
      textMessage(SUMMARY_ANSWER),
    ]);
    server = createVoiceServer({
      port: 0,
      voiceStore,
      actionStore,
      executor: { async executeApprovedAction() { throw new Error('analytics must never execute actions'); } },
      mailboxMessages: messages,
      draftCreator: async () => { throw new Error('analytics must never create drafts'); },
      endCallBufferMs: 20,
      runtime: { publish: (e) => void states.push(e.state) },
      presenceOptions: { playbackMs: () => 5 },
      photoBooth: { analytics: makeClient(mock.fetchImpl), anthropic: ai.client },
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('owner calls in, asks about the booth, repeats, returns to inbox, and hangs up', async () => {
    const params = { CallSid: 'CA_pb_test', AccountSid: 'AC_test', Direction: 'inbound', From: OWNER, To: BUSINESS };
    const url = `${PUBLIC}/voice/inbound`;
    const res = await fetch(`http://127.0.0.1:${server.getPort()}/voice/inbound`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': twilio.getExpectedTwilioSignature(TOKEN, url, params) },
      body: new URLSearchParams(params).toString(),
    });
    const twiml = await res.text();
    const relayUrl = /ConversationRelay url="([^"]+)"/.exec(twiml)![1].replace(/&amp;/g, '&');
    const local = relayUrl.replace(PUBLIC.replace(/^https/, 'wss'), `ws://127.0.0.1:${server.getPort()}`);
    const ws = new WebSocket(local, { headers: { 'X-Twilio-Signature': twilio.getExpectedTwilioSignature(TOKEN, relayUrl, {}) } });

    const spoken: string[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({ type: 'setup', callSid: 'CA_pb_test' })));
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'end') return resolve();
        if (msg.type !== 'text') return;
        spoken.push(msg.token);
        const send = (t: string) => ws.send(JSON.stringify({ type: 'prompt', voicePrompt: t, last: true }));
        if (msg.token.includes('I found three recent business emails')) send('How did the latest photo booth event perform?');
        else if (msg.token === SUMMARY_ANSWER && spoken.filter((t) => t === SUMMARY_ANSWER).length === 1) send('Repeat.');
        else if (msg.token === SUMMARY_ANSWER) send('Go back to my inbox.');
        else if (msg.token.startsWith('Back to your inbox')) send('goodbye');
      });
      ws.on('close', () => resolve());
      ws.on('error', reject);
    });
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(spoken.includes(PHOTO_BOOTH_PROGRESS_TEXT));
    assert.equal(spoken.filter((t) => t === SUMMARY_ANSWER).length, 2, 'answer + repeat');
    assert.ok(spoken.some((t) => t.startsWith('Back to your inbox')));
    assert.equal(http.length, 2, 'repeat did not re-query analytics');
    assert.equal(actionStore.listActions().length, 0);
    assert.ok(!states.includes('executing') && !states.includes('success'), `states: ${states.join(' > ')}`);

    const expected = ['speaking', 'thinking', 'speaking', 'thinking', 'speaking', 'thinking', 'speaking', 'idle'];
    let i = 0;
    for (const s of states) if (s === expected[i]) i++;
    assert.equal(i, expected.length, `runtime states: ${states.join(' > ')}`);
  });
});
