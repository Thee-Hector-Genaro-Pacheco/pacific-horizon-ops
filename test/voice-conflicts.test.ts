import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActionStore } from '../src/actions/store.js';
import { VoiceStore } from '../src/voice/store.js';
import { handleVoiceUtterance } from '../src/voice/conversation.js';
import { routeReadDomain } from '../src/voice/calendar.js';
import { normalizeUtterance } from '../src/voice/analytics.js';
import { conflictWindows, eventsOverlap } from '../src/calendar/conflicts.js';
import { CalendarService, type CalendarTransport } from '../src/calendar/service.js';
import type { CalendarSource } from '../src/calendar/multi.js';
import type { EligibleInboxMessage } from '../src/voice/mailbox.js';
import { captureConsole } from './helpers/photoBoothFakes.js';

const TZ = 'America/Los_Angeles';
/** Wednesday, October 14, 2026, 12:00 PDT. */
const NOW = new Date('2026-10-14T19:00:00Z');

const c = (start: string, end: string, profileId = 'business', extra: { busy?: boolean; allDay?: boolean } = {}) => ({
  start: new Date(start).toISOString(),
  end: new Date(end).toISOString(),
  busy: extra.busy ?? true,
  allDay: extra.allDay ?? false,
  profileId,
});

describe('Conflict semantics (shared by Hub and voice)', () => {
  it('1. no overlap, no conflict', () => {
    assert.deepEqual(conflictWindows([c('2026-10-15T09:00:00-07:00', '2026-10-15T10:00:00-07:00'), c('2026-10-15T11:00:00-07:00', '2026-10-15T12:00:00-07:00')]), []);
  });

  it('2-3. one overlap is a conflict; edge-touching events are not', () => {
    const w = conflictWindows([c('2026-10-15T17:00:00-07:00', '2026-10-15T19:00:00-07:00'), c('2026-10-15T18:00:00-07:00', '2026-10-15T20:00:00-07:00')]);
    assert.equal(w.length, 1);
    assert.deepEqual([w[0].start, w[0].end], ['2026-10-16T01:00:00.000Z', '2026-10-16T02:00:00.000Z']); // 6–7 PM
    const touching = [c('2026-10-15T17:00:00-07:00', '2026-10-15T18:00:00-07:00'), c('2026-10-15T18:00:00-07:00', '2026-10-15T19:00:00-07:00')];
    assert.equal(eventsOverlap(touching[0], touching[1]), false);
    assert.deepEqual(conflictWindows(touching), []);
  });

  it('4-5. cross-account vs same-account', () => {
    const cross = conflictWindows([c('2026-10-15T18:00:00-07:00', '2026-10-15T20:00:00-07:00'), c('2026-10-15T19:00:00-07:00', '2026-10-15T21:00:00-07:00', 'personal')]);
    assert.deepEqual([cross[0].crossAccount, cross[0].profileIds], [true, ['business', 'personal']]);
    const same = conflictWindows([c('2026-10-15T18:00:00-07:00', '2026-10-15T20:00:00-07:00'), c('2026-10-15T19:00:00-07:00', '2026-10-15T21:00:00-07:00')]);
    assert.equal(same[0].crossAccount, false);
  });

  it('6-7. three events on one interval form one window; separate windows stay separate', () => {
    const w = conflictWindows([
      c('2026-10-15T10:00:00-07:00', '2026-10-15T12:00:00-07:00'),
      c('2026-10-15T10:30:00-07:00', '2026-10-15T11:00:00-07:00'),
      c('2026-10-15T10:45:00-07:00', '2026-10-15T11:30:00-07:00', 'personal'),
      c('2026-10-15T15:00:00-07:00', '2026-10-15T16:00:00-07:00'),
      c('2026-10-15T15:30:00-07:00', '2026-10-15T17:00:00-07:00'),
    ]);
    assert.equal(w.length, 2);
    assert.equal(w[0].events.length, 3);
    assert.deepEqual([w[0].start, w[0].end], ['2026-10-15T17:30:00.000Z', '2026-10-15T18:30:00.000Z']); // 10:30–11:30 AM
    assert.deepEqual([w[1].start, w[1].end], ['2026-10-15T22:30:00.000Z', '2026-10-15T23:00:00.000Z']); // 3:30–4 PM
  });

  it('free (transparent) and all-day events never conflict', () => {
    assert.deepEqual(
      conflictWindows([
        c('2026-10-15T10:00:00-07:00', '2026-10-15T11:00:00-07:00'),
        c('2026-10-15T10:00:00-07:00', '2026-10-15T11:00:00-07:00', 'business', { busy: false }),
        c('2026-10-15T00:00:00-07:00', '2026-10-16T00:00:00-07:00', 'business', { allDay: true }),
      ]),
      []
    );
  });
});

describe('Conflict routing', () => {
  it('13. conflict phrasings route to Calendar; schedule phrasing still does', () => {
    for (const q of [
      'Do I have any conflicts in my scheduling?',
      'Do I have any conflicts today?',
      'Any scheduling conflicts today?',
      'Am I double booked?',
      'Am I double-booked Saturday?',
      'Do any of my events overlap?',
      'Is anything overlapping tomorrow?',
      'Do I have conflicting appointments?',
      "What's on my calendar?",
    ]) {
      assert.equal(routeReadDomain(normalizeUtterance(q)), 'calendar', q);
    }
    assert.equal(routeReadDomain(normalizeUtterance('the client mentioned a conflict in their email')), null);
  });
});

function calSource(sourceId: string, profileId: string, label: string, events: unknown[], privacy: 'titles' | 'busy_only' = 'titles', error?: unknown) {
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
    async freeBusy() {
      calls.push('freeBusy');
      return { calendars: {} };
    },
  };
  const calendarId = `${profileId}-cal@group.calendar.google.com`;
  const svc = new CalendarService(transport, { calendarId, timeZone: TZ, timeoutMs: 1000 });
  const s: CalendarSource = { sourceId, profileId, label, calendarId, calendarLabel: 'Primary', privacy, getService: async () => svc };
  return { s, calls };
}
const ev = (id: string, summary: string, start: string, end: string) => ({ id, summary, start: { dateTime: start }, end: { dateTime: end } });

const messages: EligibleInboxMessage[] = [
  { index: 1, messageId: 'm1', threadId: 't1', from: 'Alice <alice@example.com>', senderName: 'Alice', subject: 'Hi', date: '2026-10-09T12:00:00Z', internalDate: 1, body: 'Hello' },
];

describe('Conflict answers by voice', () => {
  let dir: string;
  let voiceStore: VoiceStore;
  let actionStore: ActionStore;
  let sessionId: string;
  let business: ReturnType<typeof calSource>;
  let personal: ReturnType<typeof calSource>;
  let consoleCapture: ReturnType<typeof captureConsole>;

  async function say(utterance: string) {
    return handleVoiceUtterance({
      session: voiceStore.getSession(sessionId)!,
      utterance,
      voiceStore,
      actionStore,
      calendar: { sources: [business.s, personal.s], timeZone: TZ, now: () => NOW },
    });
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phro-voice-conflict-'));
    voiceStore = new VoiceStore({ dataDir: dir, sessionsFilePath: path.join(dir, 's.json'), eventsFilePath: path.join(dir, 'e.jsonl') });
    actionStore = new ActionStore({ dataDir: dir, actionsFilePath: path.join(dir, 'a.json'), eventsFilePath: path.join(dir, 'ae.jsonl') });
    business = calSource('business.0', 'business', 'Business', [
      // Today: business 6–8 PM overlaps personal 7–9 PM -> one cross-account conflict 7–8 PM.
      ev('b-today', 'Client meeting', '2026-10-14T18:00:00-07:00', '2026-10-14T20:00:00-07:00'),
      // Tomorrow: two separate same-account conflicts.
      ev('b1', 'Sync A', '2026-10-15T10:00:00-07:00', '2026-10-15T11:00:00-07:00'),
      ev('b2', 'Sync B', '2026-10-15T10:30:00-07:00', '2026-10-15T11:30:00-07:00'),
      ev('b3', 'Review A', '2026-10-15T15:00:00-07:00', '2026-10-15T16:00:00-07:00'),
      ev('b4', 'Review B', '2026-10-15T15:00:00-07:00', '2026-10-15T16:00:00-07:00'),
      // Saturday: back-to-back only.
      ev('b5', 'Setup', '2026-10-17T17:00:00-07:00', '2026-10-17T18:00:00-07:00'),
      ev('b6', 'Booth', '2026-10-17T18:00:00-07:00', '2026-10-17T22:00:00-07:00'),
    ]);
    personal = calSource('personal.0', 'personal', 'Personal', [ev('p-today', 'Dinner with Liz', '2026-10-14T19:00:00-07:00', '2026-10-14T21:00:00-07:00')], 'busy_only');
    sessionId = voiceStore.createSession({ actionId: 'mailbox', toPhone: '+15550000001', fromPhone: '+15550000002', conversationState: 'MAILBOX_SELECTING', metadata: { mode: 'mailbox', availableMessages: messages } }).sessionId;
    consoleCapture = captureConsole();
  });
  afterEach(() => {
    consoleCapture.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the reported bug: a conflict question answers the conflict, not the event list', async () => {
    const t = await say('Do I have any conflicts in my scheduling?');
    assert.equal(t.responseText, 'Yes. You have one scheduling conflict today from 7 to 8 PM between your business and personal calendars.');
    assert.doesNotMatch(t.responseText, /Client meeting|You have two events/);
  });

  it('8. busy_only titles are never spoken (nor any title)', async () => {
    const t = await say('Am I double booked today?');
    assert.doesNotMatch(t.responseText, /Dinner|Liz|Client meeting|Personal event/);
  });

  it('7. multiple windows: count plus intervals, no event list', async () => {
    const t = await say('Do I have any conflicts tomorrow?');
    assert.equal(
      t.responseText,
      'You have two scheduling conflicts tomorrow. The first is from 10:30 to 11 AM between two business events, and the second is from 3 to 4 PM between two business events.'
    );
    assert.doesNotMatch(t.responseText, /Sync|Review/);
  });

  it('no conflict, including back-to-back events', async () => {
    assert.equal((await say('Is anything overlapping Saturday?')).responseText, "You don't have any scheduling conflicts Saturday.");
  });

  it('this weekend names the day of each conflict', async () => {
    personal = calSource('personal.0', 'personal', 'Personal', [ev('p', 'x', '2026-10-17T19:00:00-07:00', '2026-10-17T20:00:00-07:00')], 'busy_only');
    const t = await say('Do I have any conflicts this weekend?');
    assert.equal(t.responseText, 'Yes. You have one scheduling conflict this weekend from 7 to 8 PM Saturday between your business and personal calendars.');
  });

  it('9 + 11. business-only scope and the follow-up keep scope and date', async () => {
    await say('Check my business calendar tomorrow.');
    const personalCalls = personal.calls.length;
    const t = await say('Any conflicts?');
    assert.match(t.responseText, /^On your business calendar, you have two scheduling conflicts tomorrow\./);
    assert.equal(personal.calls.length, personalCalls, 'personal not queried');
  });

  it('10 + 11. "now check everything" then "any conflicts" covers all calendars for the same day', async () => {
    await say('Check my business calendar today.');
    assert.equal((await say('Any conflicts?')).responseText, "On your business calendar, you don't have any scheduling conflicts today.");
    await say('Now check everything.');
    assert.equal((await say('Any conflicts?')).responseText, 'Yes. You have one scheduling conflict today from 7 to 8 PM between your business and personal calendars.');
  });

  it('12. a failing calendar never yields "no conflicts"', async () => {
    personal = calSource('personal.0', 'personal', 'Personal', [], 'busy_only', { response: { status: 503 } });
    const t = await say('Do I have any conflicts Saturday?');
    assert.equal(t.responseText, "I didn't find a conflict in the calendars I could check, but I couldn't verify your personal calendar.");
    const tomorrow = await say('Do I have any conflicts tomorrow?');
    assert.match(tomorrow.responseText, /^You have two scheduling conflicts tomorrow\..* I couldn't verify your personal calendar, so there may be more\.$/);
  });

  it('14. a generic schedule question still lists events', async () => {
    const t = await say("What's on my calendar tomorrow?");
    assert.match(t.responseText, /^You have four events tomorrow: Sync A at 10 AM/);
  });

  it('conflict answers create no actions and only read', async () => {
    await say('Am I double-booked today?');
    assert.equal(actionStore.listActions().length, 0);
    for (const call of [...business.calls, ...personal.calls]) assert.equal(call, 'listEvents');
  });
});
