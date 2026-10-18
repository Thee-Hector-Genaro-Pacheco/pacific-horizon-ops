import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CalendarService, type CalendarTransport } from '../src/calendar/service.js';
import { MultiCalendar, type CalendarSource } from '../src/calendar/multi.js';
import { buildCalendarHub, CalendarHubRequestError } from '../src/calendar/hub.js';
import { CalendarError } from '../src/calendar/types.js';
import { readInboxes, type GmailReadTransport, type InboxSource } from '../src/google/gmailRead.js';
import { GoogleProfileError } from '../src/google/profiles.js';
import { createDashboardServer } from '../src/dashboard/server.js';
import { resolveTimePhrase } from '../src/calendar/time.js';

const TZ = 'America/Los_Angeles';
/** Wednesday, October 14, 2026, 12:00 PDT. */
const NOW = new Date('2026-10-14T19:00:00Z');
const SAT = resolveTimePhrase('Saturday', NOW, TZ)!;
const SAT_5_10 = resolveTimePhrase('Saturday from 5 to 10', NOW, TZ)!;

interface FakeCal {
  events?: unknown[];
  busy?: Array<[string, string]>;
  error?: unknown;
}

function ev(id: string, summary: string, start: string, end: string, extra: Record<string, unknown> = {}) {
  return { id, summary, start: { dateTime: start }, end: { dateTime: end }, ...extra };
}

/** One labeled calendar source over canned data; records calls so writes would be visible. */
function source(sourceId: string, profileId: string, label: string, calendarLabel: string, data: FakeCal, privacy: 'titles' | 'busy_only' = 'titles') {
  const calls: string[] = [];
  const transport: CalendarTransport = {
    async listEvents() {
      calls.push('listEvents');
      if (data.error) throw data.error;
      return { items: data.events ?? [] };
    },
    async getEvent() {
      calls.push('getEvent');
      return null;
    },
    async freeBusy() {
      calls.push('freeBusy');
      if (data.error) throw data.error;
      return { calendars: { [`cal-${sourceId}@group.calendar.google.com`]: { busy: (data.busy ?? []).map(([start, end]) => ({ start, end })) } } };
    },
  };
  const calendarId = `cal-${sourceId}@group.calendar.google.com`;
  const svc = new CalendarService(transport, { calendarId, timeZone: TZ, timeoutMs: 1000 });
  // Profile errors (not connected, missing scope, ...) come from building the client, as in production.
  const getService = async () => {
    if (data.error instanceof GoogleProfileError) throw data.error;
    return svc;
  };
  const s: CalendarSource = { sourceId, profileId, label, calendarId, calendarLabel, privacy, getService };
  return { s, calls };
}

const business = () =>
  source('business.0', 'business', 'Business', 'Primary', {
    events: [ev('b1', 'Client call', '2026-10-17T14:00:00-07:00', '2026-10-17T15:00:00-07:00')],
    busy: [['2026-10-17T21:00:00Z', '2026-10-17T22:00:00Z']],
  });
const personal = () =>
  source(
    'personal.0',
    'personal',
    'Personal',
    'Primary',
    {
      events: [ev('p1', 'Dentist with jane@x.example', '2026-10-17T18:00:00-07:00', '2026-10-17T20:00:00-07:00')],
      busy: [['2026-10-18T01:00:00Z', '2026-10-18T03:00:00Z']],
    },
    'busy_only'
  );
const school = () =>
  source('school.0', 'school', 'School', 'WGU', {
    events: [ev('s1', 'Mentor call', '2026-10-17T10:00:00-07:00', '2026-10-17T10:30:00-07:00')],
    busy: [['2026-10-17T17:00:00Z', '2026-10-17T17:30:00Z']],
  });

describe('Multi-account Calendar aggregation', () => {
  it('14-15, 17. merges two and three profiles chronologically and keeps source identity', async () => {
    const two = await new MultiCalendar([business().s, personal().s], TZ).listEvents(SAT.start, SAT.end);
    assert.deepEqual(two.events.map((e) => e.sourceLabel), ['Business', 'Personal']);
    const three = await new MultiCalendar([business().s, personal().s, school().s], TZ).listEvents(SAT.start, SAT.end);
    assert.deepEqual(three.events.map((e) => [e.title, e.profileId, e.calendarLabel]), [
      ['Mentor call', 'school', 'WGU'],
      ['Client call', 'business', 'Primary'],
      ['Personal event', 'personal', 'Primary'],
    ]);
    assert.equal(three.meta.status, 'complete');
    // 13. Composite identity: {profileId, calendarId, eventId}.
    assert.equal(three.events[0].key, 'school:cal-school.0@group.calendar.google.com:s1');
  });

  it('multiple calendars in one profile stay distinguishable', async () => {
    const bookings = source('business.1', 'business', 'Business', 'Bookings', { events: [ev('b1', 'Booth booking', '2026-10-17T16:00:00-07:00', '2026-10-17T17:00:00-07:00')] });
    const { events } = await new MultiCalendar([business().s, bookings.s], TZ).listEvents(SAT.start, SAT.end);
    assert.deepEqual(events.map((e) => [e.sourceId, e.calendarLabel, e.key.split(':')[0]]), [
      ['business.0', 'Primary', 'business'],
      ['business.1', 'Bookings', 'business'],
    ]);
    assert.notEqual(events[0].key, events[1].key, 'same provider event id b1 in two calendars is two events');
  });

  it('16. an empty profile does not break aggregation', async () => {
    const empty = source('school.0', 'school', 'School', 'WGU', { events: [], busy: [] });
    const r = await new MultiCalendar([business().s, empty.s], TZ).listEvents(SAT.start, SAT.end);
    assert.equal(r.events.length, 1);
    assert.equal(r.meta.status, 'complete');
  });

  it('18. busy_only privacy hides the personal title but keeps the time', async () => {
    const { events } = await new MultiCalendar([personal().s], TZ).listEvents(SAT.start, SAT.end);
    assert.equal(events[0].title, 'Personal event');
    assert.ok(!JSON.stringify(events).includes('Dentist'));
    assert.ok(!JSON.stringify(events).includes('jane@'));
  });

  it('19-21. FreeBusy merges profiles; any busy calendar makes the window busy', async () => {
    const r = await new MultiCalendar([business().s, personal().s, school().s], TZ).availability(SAT_5_10.start, SAT_5_10.end);
    assert.equal(r.meta.status, 'complete');
    assert.equal(r.result!.isFree, false);
    assert.deepEqual(r.result!.busy, [{ start: '2026-10-18T01:00:00.000Z', end: '2026-10-18T03:00:00.000Z' }]); // personal 6-8 PM
    assert.deepEqual(r.result!.free, [
      { start: '2026-10-18T00:00:00.000Z', end: '2026-10-18T01:00:00.000Z' },
      { start: '2026-10-18T03:00:00.000Z', end: '2026-10-18T05:00:00.000Z' },
    ]);
    const overlapping = source('x.0', 'x', 'X', 'Primary', { busy: [['2026-10-18T02:00:00Z', '2026-10-18T04:00:00Z']] });
    const merged = await new MultiCalendar([personal().s, overlapping.s], TZ).availability(SAT_5_10.start, SAT_5_10.end);
    assert.deepEqual(merged.result!.busy, [{ start: '2026-10-18T01:00:00.000Z', end: '2026-10-18T04:00:00.000Z' }]);
  });

  it('22. a partial FreeBusy failure never claims global availability', async () => {
    const failing = source('personal.0', 'personal', 'Personal', 'Primary', { error: { response: { status: 503 } } });
    const free = source('business.0', 'business', 'Business', 'Primary', { busy: [] });
    const r = await new MultiCalendar([free.s, failing.s], TZ).availability(SAT_5_10.start, SAT_5_10.end);
    assert.equal(r.meta.status, 'partial');
    assert.deepEqual(r.meta.checked, ['Business']);
    assert.deepEqual(r.meta.failed.map((f) => [f.label, f.kind]), [['Personal', 'upstream_error']]);
  });

  it('23. total FreeBusy failure fails clearly', async () => {
    const a = source('a.0', 'a', 'A', 'Primary', { error: { response: { status: 401 } } });
    const b = source('b.0', 'b', 'B', 'Primary', { error: new GoogleProfileError('not_connected', 'x') });
    const r = await new MultiCalendar([a.s, b.s], TZ).availability(SAT_5_10.start, SAT_5_10.end);
    assert.equal(r.meta.status, 'failed');
    assert.equal(r.result, null);
    assert.deepEqual(r.meta.failed.map((f) => f.kind), ['unauthorized', 'missing_scope']);
  });

  it('24. a shared invitation (same iCalUID and start) is spoken once, preferring the titled copy', async () => {
    const shared = { iCalUID: 'uid-shared-123@google.com' };
    const inBusiness = source('business.0', 'business', 'Business', 'Primary', { events: [ev('bx', 'Design review', '2026-10-17T11:00:00-07:00', '2026-10-17T12:00:00-07:00', shared)] });
    const inPersonal = source('personal.0', 'personal', 'Personal', 'Primary', { events: [ev('px', 'Design review', '2026-10-17T11:00:00-07:00', '2026-10-17T12:00:00-07:00', shared)] }, 'busy_only');
    const { events } = await new MultiCalendar([inPersonal.s, inBusiness.s], TZ).listEvents(SAT.start, SAT.end);
    assert.equal(events.length, 1);
    assert.equal(events[0].title, 'Design review');
    assert.equal(events[0].profileId, 'business');
  });

  it('25. unrelated events with the same title and time are not collapsed', async () => {
    const a = source('a.0', 'a', 'A', 'Primary', { events: [ev('1', 'Lunch', '2026-10-17T12:00:00-07:00', '2026-10-17T13:00:00-07:00', { iCalUID: 'one@x' })] });
    const b = source('b.0', 'b', 'B', 'Primary', { events: [ev('2', 'Lunch', '2026-10-17T12:00:00-07:00', '2026-10-17T13:00:00-07:00', { iCalUID: 'two@x' })] });
    const c = source('c.0', 'c', 'C', 'Primary', { events: [ev('3', 'Lunch', '2026-10-17T12:00:00-07:00', '2026-10-17T13:00:00-07:00')] });
    const { events } = await new MultiCalendar([a.s, b.s, c.s], TZ).listEvents(SAT.start, SAT.end);
    assert.equal(events.length, 3);
  });

  it('recurring occurrences sharing an iCalUID at different times are all kept', async () => {
    const r = source('a.0', 'a', 'A', 'Primary', {
      events: [
        ev('w_1', 'Weekly', '2026-10-17T09:00:00-07:00', '2026-10-17T09:30:00-07:00', { iCalUID: 'weekly@x' }),
        ev('w_2', 'Weekly', '2026-10-18T09:00:00-07:00', '2026-10-18T09:30:00-07:00', { iCalUID: 'weekly@x' }),
      ],
    });
    const w = resolveTimePhrase('this weekend', NOW, TZ)!;
    assert.equal((await new MultiCalendar([r.s], TZ).listEvents(w.start, w.end)).events.length, 2);
  });
});

describe('Calendar Hub (read-only Command Center model)', () => {
  const hub = (sources: CalendarSource[], sourceIds: string[] | null = null) =>
    buildCalendarHub({ sources, timeZone: TZ, now: new Date('2026-10-17T15:00:00Z'), view: 'today', sourceIds });

  it('shows each event with its account and calendar label, merged chronologically', async () => {
    const h = await hub([business().s, personal().s, school().s]);
    assert.deepEqual(h.events.map((e) => [e.title, e.sourceLabel]), [
      ['Mentor call', 'School · WGU'],
      ['Client call', 'Business · Primary'],
      ['Personal event', 'Personal · Primary'],
    ]);
    assert.equal(h.scope.label, 'All calendars');
    assert.equal(h.status, 'complete');
  });

  it('profile and individual-calendar filters affect events and availability', async () => {
    const bookings = source('business.1', 'business', 'Business', 'Bookings', {
      events: [ev('k', 'Booth booking', '2026-10-17T19:00:00-07:00', '2026-10-17T21:00:00-07:00')],
      busy: [['2026-10-18T02:00:00Z', '2026-10-18T04:00:00Z']],
    });
    const all = [business().s, bookings.s, personal().s];
    const onlyBusiness = await hub(all, ['business.0', 'business.1']);
    assert.deepEqual(onlyBusiness.events.map((e) => e.title), ['Client call', 'Booth booking']);
    assert.equal(onlyBusiness.scope.label, 'Business');
    const onlyBookings = await hub(all, ['business.1']);
    assert.deepEqual(onlyBookings.events.map((e) => e.title), ['Booth booking']);
    assert.equal(onlyBookings.scope.label, 'Business · Bookings');
    assert.deepEqual(onlyBookings.availability[0].busy, [{ start: '2026-10-18T02:00:00.000Z', end: '2026-10-18T04:00:00.000Z' }]);
    await assert.rejects(hub(all, ['business.9']), CalendarHubRequestError);
  });

  it('busy_only hides the title but still blocks availability', async () => {
    const h = await hub([personal().s]);
    assert.equal(h.events[0].title, 'Personal event');
    assert.deepEqual(h.availability[0].busy, [{ start: '2026-10-18T01:00:00.000Z', end: '2026-10-18T03:00:00.000Z' }]);
    assert.ok(h.availability[0].free!.every((f) => f.end <= '2026-10-18T01:00:00.000Z' || f.start >= '2026-10-18T03:00:00.000Z'));
  });

  it('overlapping events are flagged, and cross-account conflicts are visible', async () => {
    const late = source('business.0', 'business', 'Business', 'Primary', { events: [ev('v', 'Vendor call', '2026-10-17T19:00:00-07:00', '2026-10-17T20:00:00-07:00')] });
    const h = await hub([late.s, personal().s]);
    assert.deepEqual(h.events.map((e) => [e.title, e.conflict, e.crossAccountConflict]), [
      ['Personal event', true, true],
      ['Vendor call', true, true],
    ]);
  });

  it('partial failure is visible and never reports free time', async () => {
    const failing = source('school.0', 'school', 'School', 'WGU', { error: new GoogleProfileError('missing_scope', 'x') });
    const h = await hub([business().s, failing.s]);
    assert.equal(h.status, 'partial');
    assert.deepEqual(h.failures, [{ label: 'School · WGU', kind: 'missing_scope' }]);
    assert.equal(h.availability[0].status, 'partial');
    assert.equal(h.availability[0].free, null);
    assert.equal(h.profiles.find((p) => p.profileId === 'school')!.connection, 'missing_scope');
  });

  it('never exposes raw calendar IDs, event IDs or emails', async () => {
    const h = await hub([business().s, personal().s, school().s]);
    const json = JSON.stringify(h);
    for (const leak of ['@group.calendar.google.com', 'jane@', '"b1"', '"p1"', '"s1"', 'Dentist']) assert.ok(!json.includes(leak), leak);
    for (const e of h.events) assert.match(e.id, /^[0-9a-f]{16}$/);
  });

  it('reflects the real scope of the last voice Calendar question', async () => {
    const session = {
      sessionId: 'v1',
      updatedAt: '2026-10-17T14:55:00.000Z',
      metadata: {
        readTaskLabel: 'Checking calendar · All calendars',
        calendar: { selection: 'all', label: 'tomorrow', windowStart: '2026-10-18T07:00:00.000Z', windowEnd: '2026-10-19T07:00:00.000Z' },
      },
    };
    const h = await buildCalendarHub({ sources: [business().s], timeZone: TZ, now: new Date('2026-10-17T15:00:00Z'), view: 'today', sessions: [session as never] });
    assert.deepEqual(h.voice, { scopeLabel: 'All calendars', profileIds: null, dayLabel: 'tomorrow', windowStart: '2026-10-18T07:00:00.000Z', windowEnd: '2026-10-19T07:00:00.000Z', at: '2026-10-17T14:55:00.000Z' });
    const stale = await buildCalendarHub({ sources: [business().s], timeZone: TZ, now: new Date('2026-10-17T18:00:00Z'), view: 'today', sessions: [session as never] });
    assert.equal(stale.voice, null, 'old voice context is not shown as current');
  });

  it('Calendar reads are mutation-free', async () => {
    const b = business();
    const p = personal();
    await hub([b.s, p.s]);
    for (const c of [...b.calls, ...p.calls]) assert.ok(['listEvents', 'freeBusy'].includes(c), c);
  });
});

describe('Calendar Hub API', () => {
  let dir: string;
  afterEach(() => dir && fs.rmSync(dir, { recursive: true, force: true }));

  it('serves the hub over GET only, with filters, and never leaks provider IDs', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phro-hub-api-'));
    const server = createDashboardServer({
      port: 0,
      dataDir: dir,
      baseDir: dir,
      staticDir: null,
      voiceHealthUrl: null,
      now: () => new Date('2026-10-17T15:00:00Z').getTime(),
      calendarSources: () => ({ sources: [business().s, personal().s], timeZone: TZ }),
    });
    await server.start();
    const base = `http://127.0.0.1:${server.getPort()}/api/calendar`;
    try {
      const all = await (await fetch(`${base}?view=today`)).json();
      assert.equal(all.data.events.length, 2);
      const filtered = await (await fetch(`${base}?view=week&sources=personal.0`)).json();
      assert.deepEqual(filtered.data.events.map((e: { sourceLabel: string }) => e.sourceLabel), ['Personal · Primary']);
      assert.equal(filtered.data.availability.length, 7);
      assert.equal((await fetch(`${base}?sources=nope.0`)).status, 400);
      assert.equal((await fetch(`${base}?view=year`)).status, 400);
      assert.equal((await fetch(base, { method: 'POST' })).status, 405);
      assert.ok(!JSON.stringify(all).includes('@group.calendar.google.com'));
    } finally {
      await server.stop();
    }
  });
});

describe('Multi-inbox Gmail reads', () => {
  function inbox(profileId: string, label: string, msgs: Array<{ id: string; from: string; subject: string; at: number; labels?: string[] }>, error?: unknown) {
    const calls: string[] = [];
    const transport: GmailReadTransport = {
      async listMessageIds(p) {
        calls.push(`list:${p.maxResults}`);
        if (error) throw error;
        return { messages: msgs.map((m) => ({ id: m.id })) };
      },
      async getMessageMetadata(id) {
        calls.push(`get:${id}`);
        const m = msgs.find((x) => x.id === id)!;
        return {
          id: m.id,
          threadId: `t_${m.id}`,
          internalDate: String(m.at),
          snippet: 'Hello there',
          labelIds: m.labels ?? ['INBOX'],
          payload: { headers: [{ name: 'From', value: m.from }, { name: 'Subject', value: m.subject }] },
        };
      },
    };
    const s: InboxSource = { profileId, label, getTransport: async () => transport };
    return { s, calls };
  }

  it('26-27. merges by Gmail internalDate and preserves the source profile', async () => {
    const b = inbox('business', 'Business', [{ id: 'm1', from: 'Alice <alice@client.example>', subject: 'Booking', at: 3000 }]);
    const p = inbox('personal', 'Personal', [
      { id: 'm1', from: 'Bob <bob@friend.example>', subject: 'Dinner?', at: 5000 },
      { id: 'm2', from: 'Café Résumé <hi@cafe.example>', subject: 'Votre réservation ✓', at: 1000 },
    ]);
    const agg = await readInboxes([b.s, p.s], { max: 5 });
    assert.equal(agg.status, 'complete');
    assert.deepEqual(agg.items.map((i) => [i.key, i.profileLabel, i.senderName, i.subject]), [
      ['personal:m1', 'Personal', 'Bob', 'Dinner?'],
      ['business:m1', 'Business', 'Alice', 'Booking'],
      ['personal:m2', 'Personal', 'Café Résumé', 'Votre réservation ✓'],
    ]);
    assert.ok(!JSON.stringify(agg).includes('@friend.example'), 'sender addresses are stripped');
  });

  it('reads are bounded per account', async () => {
    const many = inbox('business', 'Business', Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, from: 'A <a@x.example>', subject: `S${i}`, at: i })));
    const agg = await readInboxes([many.s], { max: 50 });
    assert.equal(agg.items.length, 10);
    assert.equal(many.calls[0], 'list:10');
  });

  it('28. a personal-only read never touches the business inbox', async () => {
    const b = inbox('business', 'Business', [{ id: 'x', from: 'A <a@x>', subject: 'S', at: 1 }]);
    const p = inbox('personal', 'Personal', [{ id: 'y', from: 'B <b@y>', subject: 'T', at: 2 }]);
    const agg = await readInboxes([p.s], {});
    assert.deepEqual(agg.items.map((i) => i.profileId), ['personal']);
    assert.deepEqual(b.calls, []);
  });

  it('partial and total inbox failures are explicit', async () => {
    const ok = inbox('business', 'Business', [{ id: 'x', from: 'A <a@x>', subject: 'S', at: 1 }]);
    const bad = inbox('personal', 'Personal', [], { response: { status: 401 } });
    const partial = await readInboxes([ok.s, bad.s], {});
    assert.equal(partial.status, 'partial');
    assert.deepEqual(partial.failed, [{ profileId: 'personal', label: 'Personal', kind: 'unauthorized' }]);
    const none = await readInboxes([bad.s], {});
    assert.equal(none.status, 'failed');
    const malformed = await readInboxes([{ profileId: 'z', label: 'Z', getTransport: async () => ({ listMessageIds: async () => ({ messages: 'x' }), getMessageMetadata: async () => ({}) }) }], {});
    assert.deepEqual(malformed.failed.map((f) => f.kind), ['malformed_response']);
  });

  it('a calendar error type is still a CalendarError', () => {
    assert.ok(new CalendarError('timeout', 'x') instanceof Error);
  });
});
