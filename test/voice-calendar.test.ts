import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActionStore } from '../src/actions/store.js';
import type { ActionExecutor } from '../src/actions/executor.js';
import { VoiceStore } from '../src/voice/store.js';
import { handleVoiceUtterance } from '../src/voice/conversation.js';
import { VoicePresenceReporter, type RuntimeSink } from '../src/voice/presenceReporter.js';
import { CALENDAR_MAILBOX_COMMAND_GUIDANCE, CALENDAR_PROGRESS_TEXT, routeReadDomain } from '../src/voice/calendar.js';
import { normalizeUtterance } from '../src/voice/analytics.js';
import { CalendarService, type CalendarTransport } from '../src/calendar/service.js';
import type { EligibleInboxMessage } from '../src/voice/mailbox.js';
import { EVENT_A, mockFetch, makeClient, fakeAnthropic, toolMessage, textMessage, captureConsole } from './helpers/photoBoothFakes.js';

const TZ = 'America/Los_Angeles';
/** Wednesday, October 14, 2026, 12:00 PDT. */
const NOW = new Date('2026-10-14T19:00:00Z');

const messages: EligibleInboxMessage[] = [
  { index: 1, messageId: 'm1', threadId: 't1', from: 'Alice Johnson <alice@example.com>', senderName: 'Alice Johnson', subject: 'Photo Booth for Birthday Party', date: '2026-10-09T12:00:00Z', internalDate: 3, body: 'Hi Hector, I would like to book a photo booth for my birthday on Nov 14th in Irvine.' },
  { index: 2, messageId: 'm2', threadId: 't2', from: 'Bob Smith <bob@example.com>', senderName: 'Bob Smith', subject: 'Corporate Holiday Gala Inquiry', date: '2026-10-09T11:00:00Z', internalDate: 2, body: 'We need a photo booth for 200 guests on Dec 10th.' },
];

/** Saturday Oct 17: booth 12-3 PM (with attendee + link details that must never be spoken), dinner 7-9 PM. */
const SATURDAY_EVENTS = [
  {
    id: 'evt_booth_1',
    summary: 'Garcia booth setup jane@client.com https://meet.google.com/abc',
    description: 'gate code 4455',
    attendees: [{ email: 'jane@client.com' }],
    start: { dateTime: '2026-10-17T12:00:00-07:00' },
    end: { dateTime: '2026-10-17T15:00:00-07:00' },
  },
  { id: 'evt_dinner_2', summary: 'Dinner', start: { dateTime: '2026-10-17T19:00:00-07:00' }, end: { dateTime: '2026-10-17T21:00:00-07:00' } },
];

interface Call {
  method: string;
  params: Record<string, unknown>;
}

function fakeCalendar(opts: { error?: unknown; busy?: Array<[string, string]>; malformedFreeBusy?: boolean } = {}) {
  const calls: Call[] = [];
  const transport: CalendarTransport = {
    async listEvents(params) {
      calls.push({ method: 'listEvents', params });
      if (opts.error) throw opts.error;
      const min = Date.parse(params.timeMin);
      const max = Date.parse(params.timeMax);
      return {
        items: SATURDAY_EVENTS.filter((e) => Date.parse(e.end.dateTime) > min && Date.parse(e.start.dateTime) < max),
      };
    },
    async getEvent(params) {
      calls.push({ method: 'getEvent', params });
      return SATURDAY_EVENTS[0];
    },
    async freeBusy(params) {
      calls.push({ method: 'freeBusy', params });
      if (opts.error) throw opts.error;
      if (opts.malformedFreeBusy) return { bogus: true };
      const busy = (opts.busy ?? [
        ['2026-10-17T19:00:00Z', '2026-10-17T22:00:00Z'],
        ['2026-10-18T02:00:00Z', '2026-10-18T04:00:00Z'],
      ]).filter(([s, e]) => Date.parse(e) > Date.parse(params.timeMin) && Date.parse(s) < Date.parse(params.timeMax));
      return { calendars: { primary: { busy: busy.map(([start, end]) => ({ start, end })) } } };
    },
  };
  const service = new CalendarService(transport, { calendarId: 'primary', timeZone: TZ, timeoutMs: 1000 });
  return { service, calls };
}

describe('Calendar voice routing (unit)', () => {
  const route = (q: string) => routeReadDomain(normalizeUtterance(q));

  it('routes calendar questions to Calendar', () => {
    for (const q of [
      'What do I have tomorrow?',
      'What is my schedule this weekend?',
      'Am I available Saturday from 5 to 10?',
      'What is my next event?',
      "What's my first event tomorrow?",
      'When am I free Saturday?',
      'Check my calendar.',
      'Do I have any photo booth bookings next weekend?',
      'Do I have a photo booth booking Saturday?',
      'Am I busy tonight?',
    ]) {
      assert.equal(route(q), 'calendar', q);
    }
  });

  it('keeps explicit Photo Booth analytics questions in analytics', () => {
    for (const q of [
      'How did the latest photo booth event perform?',
      'How many downloads did we get?',
      'Any delivery problems at the booth?',
      'What feedback did we get?',
      'How many Instagram clicks?',
    ]) {
      assert.equal(route(q), 'photo_booth', q);
    }
  });

  it('never claims mailbox commands', () => {
    for (const q of ['message one', 'draft a response', 'read the draft', 'approve', 'confirm approval', 'go back', 'summarize', 'repeat', 'read the email about my schedule']) {
      assert.equal(route(q), null, q);
    }
  });
});

describe('Calendar voice domain', () => {
  let dir: string;
  let voiceStore: VoiceStore;
  let actionStore: ActionStore;
  let sessionId: string;
  let cal: ReturnType<typeof fakeCalendar>;
  let progress: Array<{ text: string; stillWorking?: boolean }>;
  let sends: number;
  let drafts: number;
  let consoleCapture: ReturnType<typeof captureConsole>;
  let pb: { fetch: ReturnType<typeof mockFetch>; ai: ReturnType<typeof fakeAnthropic> };

  const executor: ActionExecutor = {
    async executeApprovedAction(actionId) {
      sends++;
      actionStore.transitionAction(actionId, 'SENT', { actor: 'test' });
      return { success: true, status: 'SENT' };
    },
  };

  async function say(utterance: string) {
    return handleVoiceUtterance({
      session: voiceStore.getSession(sessionId)!,
      utterance,
      voiceStore,
      actionStore,
      executor,
      draftCreator: async (p) => {
        drafts++;
        return { draftId: `d${drafts}`, threadId: p.threadId };
      },
      onProgress: (text, opts) => progress.push({ text, stillWorking: opts?.stillWorking }),
      calendar: { service: cal.service, now: () => NOW },
      photoBooth: { analytics: makeClient(pb.fetch.fetchImpl), anthropic: pb.ai.client },
    });
  }
  const state = () => voiceStore.getSession(sessionId)!.conversationState;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phro-voice-cal-'));
    voiceStore = new VoiceStore({ dataDir: dir, sessionsFilePath: path.join(dir, 'voice-sessions.json'), eventsFilePath: path.join(dir, 'voice-events.jsonl') });
    actionStore = new ActionStore({ dataDir: dir, actionsFilePath: path.join(dir, 'actions.json'), eventsFilePath: path.join(dir, 'action-events.jsonl') });
    cal = fakeCalendar();
    progress = [];
    sends = 0;
    drafts = 0;
    pb = { fetch: mockFetch(), ai: fakeAnthropic([]) };
    const s = voiceStore.createSession({ actionId: 'mailbox', toPhone: '+15550000001', fromPhone: '+15550000002', conversationState: 'MAILBOX_SELECTING', metadata: { mode: 'mailbox', availableMessages: messages } });
    sessionId = s.sessionId;
    voiceStore.updateConversationState(sessionId, 'MAILBOX_SELECTING', { lastSpokenText: 'I found two recent business emails.' });
    consoleCapture = captureConsole();
  });

  afterEach(() => {
    consoleCapture.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('mailbox -> Calendar: answers the schedule with privacy-safe speech and minimal context', async () => {
    const turn = await say('What do I have Saturday?');
    assert.equal(
      turn.responseText,
      'You have two events Saturday: Garcia booth setup at noon, and Dinner at 7 PM.'
    );
    assert.equal(state(), 'CALENDAR');
    assert.deepEqual(progress, [{ text: CALENDAR_PROGRESS_TEXT, stillWorking: true }]);
    assert.deepEqual(cal.calls.map((c) => c.method), ['listEvents']);

    const session = voiceStore.getSession(sessionId)!;
    assert.equal(session.metadata?.resumeConversationState, 'MAILBOX_SELECTING');
    assert.deepEqual(session.metadata?.availableMessages, messages, 'mailbox state preserved');
    const ctx = session.metadata?.calendar as { events: Array<Record<string, unknown>>; day: string };
    assert.equal(ctx.day, '2026-10-17');
    for (const e of ctx.events) assert.deepEqual(Object.keys(e).sort(), ['allDay', 'end', 'start', 'title'], 'no IDs or raw payload in session');

    const stored = fs.readFileSync(path.join(dir, 'voice-sessions.json'), 'utf-8') + fs.readFileSync(path.join(dir, 'voice-events.jsonl'), 'utf-8');
    for (const leak of ['jane@client.com', 'meet.google', 'gate code', 'evt_booth_1', 'attendees']) assert.ok(!stored.includes(leak), leak);
  });

  it('follow-ups: "the second one" from context, then "am I free after that" for the same day', async () => {
    await say('What do I have Saturday?');
    const before = cal.calls.length;

    const second = await say('What time is the second one?');
    assert.equal(second.responseText, 'The second one is Dinner, from 7 to 9 PM.');
    assert.equal(cal.calls.length, before, 'answered from context, no Google call');

    const after = await say('Am I free after that?');
    assert.equal(after.responseText, "You're free Saturday from 9 PM to midnight.");
    const fb = cal.calls[cal.calls.length - 1];
    assert.equal(fb.method, 'freeBusy');
    assert.equal(fb.params.timeMin, '2026-10-18T04:00:00.000Z'); // 9 PM PDT
    assert.equal(fb.params.timeMax, '2026-10-18T07:00:00.000Z'); // midnight PDT
  });

  it('availability for an explicit window uses FreeBusy and reports busy-then-free', async () => {
    const turn = await say('Am I available Saturday from 5 to 10?');
    assert.equal(turn.responseText, "You're busy from 7 to 9 PM Saturday, but you're free from 5 to 7 PM, and after 9 PM.");
    assert.deepEqual(cal.calls.map((c) => c.method), ['freeBusy']);
  });

  it('next event and first event', async () => {
    assert.equal((await say('What is my next event?')).responseText, 'Your next event is Garcia booth setup, Saturday at noon.');
    assert.equal((await say("What's my first event Saturday?")).responseText, 'Your first event Saturday is Garcia booth setup at noon.');
  });

  it('photo booth bookings filter by title', async () => {
    const turn = await say('Do I have any photo booth bookings Saturday?');
    assert.equal(turn.responseText, 'You have one booking Saturday: Garcia booth setup at noon.');
    assert.equal(state(), 'CALENDAR');
  });

  it('repeat replays the spoken Calendar answer without another Google call', async () => {
    const first = await say('What do I have Saturday?');
    const n = cal.calls.length;
    assert.equal((await say('Repeat.')).responseText, first.responseText);
    assert.equal((await say('Say that again.')).responseText, first.responseText);
    assert.equal(cal.calls.length, n);
  });

  it('Calendar -> mailbox restores message selection, and mailbox commands work again', async () => {
    await say('What do I have tomorrow?');
    const back = await say('Go back to my inbox.');
    assert.equal(back.responseText, 'Back to your inbox. You can choose message one, message two, or message three.');
    assert.equal(state(), 'MAILBOX_SELECTING');
    assert.match((await say('message two')).responseText, /Selected message 2 from Bob Smith/);
  });

  it('selected email + draft -> Calendar -> back keeps the draft binding, and approval still works', async () => {
    await say('message one');
    await say('draft a response');
    const bound = voiceStore.getSession(sessionId)!.metadata?.boundActionId;
    await say('Check my calendar for Saturday.');
    assert.equal(state(), 'CALENDAR');
    const back = await say('back to my emails');
    assert.match(back.responseText, /Back to the email from Alice Johnson/);
    assert.equal(state(), 'READY');
    assert.equal(voiceStore.getSession(sessionId)!.metadata?.boundActionId, bound);
    await say('approve');
    await say('confirm approval');
    assert.equal(sends, 1);
  });

  it('Calendar -> Photo Booth analytics -> Calendar -> inbox, keeping the mailbox resume point', async () => {
    pb.ai = fakeAnthropic([
      toolMessage('t1', 'get_latest_photo_booth_event', {}),
      toolMessage('t2', 'get_photo_booth_event_summary', { eventId: EVENT_A }),
      textMessage('The latest event recorded 97 delivery sessions.'),
    ]);
    await say('What do I have Saturday?');
    const analytics = await say('How did the latest photo booth event perform?');
    assert.equal(analytics.responseText, 'The latest event recorded 97 delivery sessions.');
    assert.equal(state(), 'PHOTO_BOOTH_ANALYTICS');
    assert.equal(voiceStore.getSession(sessionId)!.metadata?.resumeConversationState, 'MAILBOX_SELECTING');

    await say('What is my next event?');
    assert.equal(state(), 'CALENDAR');
    assert.equal(voiceStore.getSession(sessionId)!.metadata?.resumeConversationState, 'MAILBOX_SELECTING');

    await say('Go back to my inbox.');
    assert.equal(state(), 'MAILBOX_SELECTING');
  });

  it('a pending "confirm approval" cannot be interrupted by a Calendar question', async () => {
    await say('message one');
    await say('draft a response');
    await say('approve');
    assert.equal(state(), 'AWAITING_APPROVAL_CONFIRMATION');
    const turn = await say('What do I have tomorrow?');
    assert.match(turn.responseText, /Approval was not confirmed/);
    assert.equal(state(), 'AWAITING_APPROVAL_CONFIRMATION');
    assert.equal(cal.calls.length, 0);
    assert.equal(sends, 0);
  });

  it('Calendar reads create no Gmail action or draft, and only call read methods', async () => {
    for (const q of ['What do I have Saturday?', 'What time is the second one?', 'Am I free after that?', 'Am I available Saturday from 5 to 10?', 'When am I free Saturday?', 'What is my next event?']) await say(q);
    for (const cmd of ['approve', 'confirm approval', 'draft a response', 'message two']) {
      assert.equal((await say(cmd)).responseText, CALENDAR_MAILBOX_COMMAND_GUIDANCE, cmd);
      assert.equal(state(), 'CALENDAR');
    }
    assert.equal(actionStore.listActions().length, 0);
    assert.equal(drafts, 0);
    assert.equal(sends, 0);
    assert.ok(cal.calls.length > 0);
    for (const c of cal.calls) assert.ok(['listEvents', 'freeBusy'].includes(c.method), c.method);
  });

  it('failures are spoken as failures and never as availability', async () => {
    const cases: Array<[unknown, string]> = [
      [{ response: { status: 403, data: { error: { message: 'Request had insufficient authentication scopes.' } } } }, "I don't have permission to read your calendar yet."],
      [{ response: { status: 401 } }, "I can't authenticate with Google Calendar right now."],
      [{ code: 'ETIMEDOUT', message: 'timeout' }, "Google Calendar isn't responding right now."],
      [{ code: 'ECONNRESET', message: 'socket hang up' }, "Google Calendar isn't responding right now."],
    ];
    for (const [error, spoken] of cases) {
      cal = fakeCalendar({ error });
      const turn = await say('Am I available Saturday from 5 to 10?');
      assert.equal(turn.responseText, spoken);
      assert.doesNotMatch(turn.responseText, /you're free|nothing scheduled/i);
    }
    cal = fakeCalendar({ malformedFreeBusy: true });
    assert.equal((await say('Am I available Saturday from 5 to 10?')).responseText, "I couldn't safely interpret the calendar response.");
  });

  it('spoken Calendar answers carry no IDs, timestamps, emails or links', async () => {
    const answers = [];
    for (const q of ['What do I have Saturday?', 'What time is the first one?', 'Am I available Saturday from 5 to 10?', 'What is my next event?', 'When am I free Saturday?']) {
      answers.push((await say(q)).responseText);
    }
    for (const a of answers) {
      assert.doesNotMatch(a, /\d{4}-\d{2}-\d{2}|T\d{2}:\d{2}|@|https?:|evt_|www\./, a);
    }
  });
});

describe('Calendar runtime presence', () => {
  it('maps the Calendar domain to calendar_read / "Checking calendar" with thinking -> speaking only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phro-voice-cal-rt-'));
    try {
      const voiceStore = new VoiceStore({ dataDir: dir, sessionsFilePath: path.join(dir, 's.json'), eventsFilePath: path.join(dir, 'e.jsonl') });
      const s = voiceStore.createSession({ actionId: 'mailbox', toPhone: '+15550000001', fromPhone: '+15550000002', conversationState: 'MAILBOX_SELECTING', metadata: { mode: 'mailbox' } });
      const events: Array<{ state: string; task: string | null; operation: string | null }> = [];
      const sink: RuntimeSink = { publish: (e) => void events.push({ state: e.state, task: e.task, operation: e.operation }) };
      const timers: Array<() => void> = [];
      const reporter = new VoicePresenceReporter(sink, voiceStore, { setTimer: (fn) => timers.push(fn), clearTimer: () => {}, log: () => {} });

      reporter.sessionConnected(s.sessionId);
      reporter.processing(s.sessionId);
      voiceStore.updateConversationState(s.sessionId, 'CALENDAR');
      reporter.speaking(s.sessionId, CALENDAR_PROGRESS_TEXT, { stillWorking: true });
      timers.shift()!();
      reporter.speaking(s.sessionId, 'You have two events Saturday.');
      timers.shift()!();

      assert.deepEqual(events.map((e) => e.state), ['idle', 'thinking', 'speaking', 'thinking', 'speaking', 'listening']);
      for (const e of events.slice(2)) {
        assert.equal(e.task, 'Checking calendar');
        assert.equal(e.operation, 'calendar_read');
      }
      assert.ok(!events.some((e) => e.state === 'executing' || e.state === 'success'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
