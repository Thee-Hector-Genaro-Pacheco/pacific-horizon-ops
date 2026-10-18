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
import { BUSINESS_DRAFT_GUIDANCE, READ_ONLY_DRAFT_TEXT, isEmailReadRequest } from '../src/voice/email.js';
import { parseCalendarSelection } from '../src/voice/calendar.js';
import { normalizeUtterance } from '../src/voice/analytics.js';
import { CalendarService, type CalendarTransport } from '../src/calendar/service.js';
import type { CalendarSource } from '../src/calendar/multi.js';
import type { GmailReadTransport, InboxSource } from '../src/google/gmailRead.js';
import type { EligibleInboxMessage } from '../src/voice/mailbox.js';
import { captureConsole } from './helpers/photoBoothFakes.js';

const TZ = 'America/Los_Angeles';
/** Wednesday, October 14, 2026, 12:00 PDT. */
const NOW = new Date('2026-10-14T19:00:00Z');

const messages: EligibleInboxMessage[] = [
  { index: 1, messageId: 'm1', threadId: 't1', from: 'Alice Johnson <alice@example.com>', senderName: 'Alice Johnson', subject: 'Photo Booth for Birthday Party', date: '2026-10-09T12:00:00Z', internalDate: 3, body: 'Hi Hector, I would like to book a photo booth.' },
  { index: 2, messageId: 'm2', threadId: 't2', from: 'Bob Smith <bob@example.com>', senderName: 'Bob Smith', subject: 'Corporate Holiday Gala Inquiry', date: '2026-10-09T11:00:00Z', internalDate: 2, body: 'We need a photo booth for 200 guests.' },
];

function calSource(sourceId: string, profileId: string, label: string, events: unknown[], busy: Array<[string, string]>, privacy: 'titles' | 'busy_only' = 'titles', error?: unknown) {
  const calls: string[] = [];
  const transport: CalendarTransport = {
    async listEvents(p) {
      calls.push('listEvents');
      if (error) throw error;
      return {
        items: events.filter((e) => {
          const ev = e as { start: { dateTime: string }; end: { dateTime: string } };
          return Date.parse(ev.end.dateTime) > Date.parse(p.timeMin) && Date.parse(ev.start.dateTime) < Date.parse(p.timeMax);
        }),
      };
    },
    async getEvent() {
      return null;
    },
    async freeBusy(p) {
      calls.push('freeBusy');
      if (error) throw error;
      const inWindow = busy.filter(([s, e]) => Date.parse(e) > Date.parse(p.timeMin) && Date.parse(s) < Date.parse(p.timeMax));
      return { calendars: { [p.calendarId]: { busy: inWindow.map(([start, end]) => ({ start, end })) } } };
    },
  };
  const calendarId = `${profileId}-cal-id@group.calendar.google.com`;
  const svc = new CalendarService(transport, { calendarId, timeZone: TZ, timeoutMs: 1000 });
  const s: CalendarSource = { sourceId, profileId, label, calendarId, calendarLabel: 'Primary', privacy, getService: async () => svc };
  return { s, calls };
}

const ev = (id: string, summary: string, start: string, end: string) => ({ id, summary, start: { dateTime: start }, end: { dateTime: end } });

function inboxSource(profileId: string, label: string, msgs: Array<{ id: string; from: string; subject: string; at: number }>) {
  const calls: string[] = [];
  const transport: GmailReadTransport = {
    async listMessageIds() {
      calls.push('list');
      return { messages: msgs.map((m) => ({ id: m.id })) };
    },
    async getMessageMetadata(id) {
      calls.push('get');
      const m = msgs.find((x) => x.id === id)!;
      return { id, threadId: id, internalDate: String(m.at), snippet: `Snippet of ${m.subject}`, labelIds: ['INBOX'], payload: { headers: [{ name: 'From', value: m.from }, { name: 'Subject', value: m.subject }] } };
    },
  };
  const s: InboxSource = { profileId, label, getTransport: async () => transport };
  return { s, calls };
}

describe('Account-aware routing (unit)', () => {
  const profiles = [
    { id: 'business', label: 'Business' },
    { id: 'personal', label: 'Personal' },
  ];
  it('parses calendar scope', () => {
    const p = (q: string) => parseCalendarSelection(normalizeUtterance(q), profiles);
    assert.equal(p('What do I have tomorrow across all my calendars?'), 'all');
    assert.equal(p('Am I free Saturday from 5 to 10 across everything?'), 'all');
    assert.deepEqual(p('Check only my business calendar.'), ['business']);
    assert.deepEqual(p('Anything on my personal calendar tomorrow?'), ['personal']);
    assert.deepEqual(p('Check my school calendar'), { unknown: 'school' });
    assert.equal(p('What do I have tomorrow?'), null);
  });
  it('routes multi-inbox reads but leaves business-mailbox phrasing alone', () => {
    const r = (q: string) => isEmailReadRequest(normalizeUtterance(q), profiles);
    assert.equal(r('Check all my inboxes.'), true);
    assert.equal(r('Check my personal inbox.'), true);
    assert.equal(r('Anything important in my personal email?'), true);
    assert.equal(r("What's new across my email accounts?"), true);
    for (const q of ['Go back to my business inbox.', 'check my email', 'go back to my inbox', 'message one', 'draft a response']) assert.equal(r(q), false, q);
  });
});

describe('Multi-account voice', () => {
  let dir: string;
  let voiceStore: VoiceStore;
  let actionStore: ActionStore;
  let sessionId: string;
  let sends: number;
  let drafts: number;
  let business: ReturnType<typeof calSource>;
  let personal: ReturnType<typeof calSource>;
  let school: ReturnType<typeof calSource>;
  let inboxB: ReturnType<typeof inboxSource>;
  let inboxP: ReturnType<typeof inboxSource>;
  let progress: string[];
  let consoleCapture: ReturnType<typeof captureConsole>;

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
      onProgress: (t) => progress.push(t),
      calendar: { sources: [business.s, personal.s, school.s], timeZone: TZ, now: () => NOW },
      email: { sources: [inboxB.s, inboxP.s] },
    });
  }
  const state = () => voiceStore.getSession(sessionId)!.conversationState;
  const meta = () => voiceStore.getSession(sessionId)!.metadata!;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phro-voice-multi-'));
    voiceStore = new VoiceStore({ dataDir: dir, sessionsFilePath: path.join(dir, 'voice-sessions.json'), eventsFilePath: path.join(dir, 'voice-events.jsonl') });
    actionStore = new ActionStore({ dataDir: dir, actionsFilePath: path.join(dir, 'actions.json'), eventsFilePath: path.join(dir, 'action-events.jsonl') });
    sends = 0;
    drafts = 0;
    progress = [];
    business = calSource('business.0', 'business', 'Business',
      [ev('b1', 'Client call', '2026-10-17T14:00:00-07:00', '2026-10-17T15:00:00-07:00'), ev('b2', 'Sunday prep', '2026-10-18T09:00:00-07:00', '2026-10-18T10:00:00-07:00')],
      [['2026-10-17T21:00:00Z', '2026-10-17T22:00:00Z']]);
    personal = calSource('personal.0', 'personal', 'Personal',
      [ev('p1', 'Dentist', '2026-10-17T18:00:00-07:00', '2026-10-17T20:00:00-07:00')],
      [['2026-10-18T01:00:00Z', '2026-10-18T03:00:00Z']], 'busy_only');
    school = calSource('school.0', 'school', 'School',
      [ev('s1', 'Mentor call', '2026-10-17T10:00:00-07:00', '2026-10-17T10:30:00-07:00')],
      []);
    inboxB = inboxSource('business', 'Business', [{ id: 'x1', from: 'Alice <alice@client.example>', subject: 'Booking question', at: 3000 }]);
    inboxP = inboxSource('personal', 'Personal', [{ id: 'x1', from: 'Bob <bob@friend.example>', subject: 'Dinner?', at: 5000 }]);
    const s = voiceStore.createSession({ actionId: 'mailbox', toPhone: '+15550000001', fromPhone: '+15550000002', conversationState: 'MAILBOX_SELECTING', metadata: { mode: 'mailbox', availableMessages: messages } });
    sessionId = s.sessionId;
    consoleCapture = captureConsole();
  });
  afterEach(() => {
    consoleCapture.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('all-calendar schedule merges every profile and hides personal titles', async () => {
    const t = await say('What do I have Saturday across all my calendars?');
    assert.equal(t.responseText, 'You have three events Saturday: Mentor call at 10 AM, Client call at 2 PM, and Personal event at 6 PM.');
    assert.equal(state(), 'CALENDAR');
    assert.equal(meta().readTaskLabel, 'Checking calendar · All calendars');
    assert.doesNotMatch(t.responseText, /Dentist/);
  });

  it('profile-scoped follow-ups keep the scope until "everything"', async () => {
    const t1 = await say('Check only my business calendar for Saturday.');
    assert.equal(t1.responseText, 'On your business calendar, you have one event Saturday: Client call at 2 PM.');
    const before = { p: personal.calls.length, s: school.calls.length };
    const t2 = await say('What about Sunday?');
    assert.equal(t2.responseText, 'On your business calendar, you have one event Sunday: Sunday prep at 9 AM.');
    assert.deepEqual({ p: personal.calls.length, s: school.calls.length }, before, 'personal and school not queried');
    assert.deepEqual((meta().calendar as { selection: unknown }).selection, ['business']);
    const t3 = await say('Now check everything for Saturday.');
    assert.match(t3.responseText, /^You have three events Saturday/);
    assert.equal((meta().calendar as { selection: unknown }).selection, 'all');
    assert.equal(meta().readTaskLabel, 'Checking calendar · All calendars');
  });

  it('personal calendar alone answers with its privacy policy', async () => {
    const t = await say('Anything on my personal calendar Saturday?');
    assert.equal(t.responseText, 'On your personal calendar, you have one event Saturday: Personal event at 6 PM.');
    assert.equal(meta().readTaskLabel, 'Checking calendar · Personal');
  });

  it('an unconnected calendar name is answered honestly', async () => {
    const t = await say('Check my work calendar for Saturday.');
    assert.equal(t.responseText, "I don't have a work calendar connected. I can check business, personal, and school.");
  });

  it('cross-account availability: any busy calendar blocks the window', async () => {
    const t = await say('Am I free Saturday from 5 to 10 across everything?');
    assert.equal(t.responseText, "You're busy from 6 to 8 PM Saturday, but you're free from 5 to 6 PM, and after 8 PM.");
  });

  it('partial FreeBusy failure never claims free', async () => {
    personal = calSource('personal.0', 'personal', 'Personal', [], [], 'busy_only', { response: { status: 503 } });
    const t = await say('Am I free Saturday from 5 to 10 across everything?');
    assert.equal(
      t.responseText,
      "I could verify your business and school calendars, but I couldn't check your personal calendar, so I can't confirm you're completely free."
    );
    personal = calSource('personal.0', 'personal', 'Personal', [], [], 'busy_only', { response: { status: 503 } });
    business = calSource('business.0', 'business', 'Business', [], [['2026-10-18T00:00:00Z', '2026-10-18T01:00:00Z']]);
    const t2 = await say('Am I free Saturday from 5 to 10 across everything?');
    assert.match(t2.responseText, /^You're busy from 5 to 6 PM Saturday on the calendars I could check\. I couldn't check your personal calendar/);
    assert.doesNotMatch(t2.responseText, /you're free/i);
  });

  it('schedule with one failing calendar says it may be incomplete', async () => {
    school = calSource('school.0', 'school', 'School', [], [], 'titles', { response: { status: 401 } });
    const t = await say('What do I have Saturday across all my calendars?');
    assert.match(t.responseText, /^You have two events Saturday/);
    assert.match(t.responseText, /I couldn't check your school calendar, so this may be incomplete\.$/);
  });

  it('repeat does not re-query any provider', async () => {
    const first = await say('What do I have Saturday across all my calendars?');
    const n = business.calls.length + personal.calls.length + school.calls.length;
    assert.equal((await say('Repeat.')).responseText, first.responseText);
    assert.equal(business.calls.length + personal.calls.length + school.calls.length, n);
    await say('Check all my inboxes.');
    const m = inboxB.calls.length + inboxP.calls.length;
    await say('Say that again.');
    assert.equal(inboxB.calls.length + inboxP.calls.length, m);
  });

  it('all inboxes: merged newest first with account labels; reading and draft refusal stay read-only', async () => {
    const t = await say('Check all my inboxes.');
    assert.equal(state(), 'EMAIL_READ');
    assert.equal(t.responseText, 'Across your business and personal inboxes, the latest messages are from Bob about "Dinner?" in personal and from Alice about "Booking question" in business.');
    assert.equal(meta().readTaskLabel, 'Checking inboxes · All inboxes');

    const reads = inboxB.calls.length + inboxP.calls.length;
    const first = await say('Read the first one.');
    assert.equal(first.responseText, 'That one is from Bob about "Dinner?" in personal. It says: Snippet of Dinner?');
    assert.equal(inboxB.calls.length + inboxP.calls.length, reads, 'answered from context');

    assert.equal((await say('Draft a response.')).responseText, READ_ONLY_DRAFT_TEXT);
    await say('Read the second one.');
    assert.equal((await say('Reply to it.')).responseText, BUSINESS_DRAFT_GUIDANCE);
    assert.equal(drafts, 0);
    assert.equal(actionStore.listActions().length, 0);
  });

  it('personal inbox reads never use the business inbox', async () => {
    const t = await say('Check my personal inbox.');
    assert.equal(t.responseText, 'In your personal inbox, the latest message is from Bob about "Dinner?".');
    assert.equal(inboxB.calls.length, 0);
  });

  it('"go back to my business inbox" restores the mailbox, and business drafting/approval still work', async () => {
    await say('message one');
    await say('Check my personal inbox.');
    const back = await say('Go back to my business inbox.');
    assert.match(back.responseText, /Back to the email from Alice Johnson/);
    assert.equal(state(), 'READY');
    await say('draft a response');
    assert.equal(drafts, 1);
    await say('approve');
    await say('confirm approval');
    assert.equal(sends, 1);
  });

  it('a mailbox message from a read-only profile can never be drafted or bound to an Action', async () => {
    const personalMsg = { ...messages[0], messageId: 'm1', profileId: 'personal' };
    voiceStore.updateSessionMetadata(sessionId, { selectedMessage: personalMsg });
    voiceStore.updateConversationState(sessionId, 'READY');
    const t = await say('draft a response');
    assert.equal(t.responseText, READ_ONLY_DRAFT_TEXT);
    assert.equal(drafts, 0);
    assert.equal(actionStore.listActions().length, 0);
    assert.equal(meta().boundActionId, undefined);
  });

  it('mailbox -> Calendar -> Photo-free switching keeps the mailbox resume point', async () => {
    await say('What do I have Saturday across all my calendars?');
    await say('Check all my inboxes.');
    assert.equal(state(), 'EMAIL_READ');
    assert.equal(meta().resumeConversationState, 'MAILBOX_SELECTING');
    await say('What is my next event?');
    assert.equal(state(), 'CALENDAR');
    await say('Go back to my inbox.');
    assert.equal(state(), 'MAILBOX_SELECTING');
  });

  it('session output carries no emails, calendar IDs, or provider IDs', async () => {
    await say('What do I have Saturday across all my calendars?');
    await say('Check all my inboxes.');
    const stored = fs.readFileSync(path.join(dir, 'voice-sessions.json'), 'utf-8') + fs.readFileSync(path.join(dir, 'voice-events.jsonl'), 'utf-8');
    for (const leak of ['@group.calendar.google.com', 'bob@friend.example', 'alice@client.example', '"b1"', '"p1"', 'Dentist', 'access_token', 'refresh_token']) {
      assert.ok(!stored.includes(leak), leak);
    }
  });
});

describe('Runtime source labels', () => {
  it('Calendar and inbox reads show a display-safe scope, with thinking -> speaking only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phro-voice-multi-rt-'));
    try {
      const voiceStore = new VoiceStore({ dataDir: dir, sessionsFilePath: path.join(dir, 's.json'), eventsFilePath: path.join(dir, 'e.jsonl') });
      const s = voiceStore.createSession({ actionId: 'mailbox', toPhone: '+15550000001', fromPhone: '+15550000002', conversationState: 'MAILBOX_SELECTING', metadata: { mode: 'mailbox' } });
      const events: Array<{ state: string; task: string | null; operation: string | null }> = [];
      const sink: RuntimeSink = { publish: (e) => void events.push({ state: e.state, task: e.task, operation: e.operation }) };
      const reporter = new VoicePresenceReporter(sink, voiceStore, { setTimer: () => 0, clearTimer: () => {}, log: () => {} });
      reporter.processing(s.sessionId);
      voiceStore.updateConversationState(s.sessionId, 'CALENDAR');
      voiceStore.updateSessionMetadata(s.sessionId, { readTaskLabel: 'Checking calendar · Business + Personal' });
      reporter.speaking(s.sessionId, 'answer');
      voiceStore.updateConversationState(s.sessionId, 'EMAIL_READ');
      voiceStore.updateSessionMetadata(s.sessionId, { readTaskLabel: 'Checking inboxes · Personal' });
      reporter.processing(s.sessionId);
      reporter.speaking(s.sessionId, 'answer');
      assert.deepEqual(events.slice(1).map((e) => [e.state, e.task, e.operation]), [
        ['speaking', 'Checking calendar · Business + Personal', 'calendar_read'],
        ['thinking', 'Checking inboxes · Personal', 'email_read'],
        ['speaking', 'Checking inboxes · Personal', 'email_read'],
      ]);
      assert.ok(!events.some((e) => e.state === 'executing' || e.state === 'success'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
