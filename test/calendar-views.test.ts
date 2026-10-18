import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CalendarService, type CalendarTransport } from '../src/calendar/service.js';
import type { CalendarSource } from '../src/calendar/multi.js';
import { buildCalendarHub, resolveHubRange } from '../src/calendar/hub.js';
import { formatLocalDate } from '../src/calendar/time.js';
import { GoogleProfileError } from '../src/google/profiles.js';
import { createDashboardServer } from '../src/dashboard/server.js';

const TZ = 'America/Los_Angeles';
/** Sunday, October 18, 2026, 08:00 PDT. */
const NOW = new Date('2026-10-18T15:00:00Z');
const D = (s: string) => {
  const [year, month, day] = s.split('-').map(Number);
  return { year, month, day };
};

function src(sourceId: string, profileId: string, label: string, events: unknown[], busy: Array<[string, string]> = [], error?: unknown): CalendarSource {
  const transport: CalendarTransport = {
    async listEvents() {
      return { items: events };
    },
    async getEvent() {
      return null;
    },
    async freeBusy(p) {
      return { calendars: { [p.calendarId]: { busy: busy.map(([start, end]) => ({ start, end })) } } };
    },
  };
  const calendarId = `${sourceId}@group.calendar.google.com`;
  const svc = new CalendarService(transport, { calendarId, timeZone: TZ, timeoutMs: 1000 });
  return {
    sourceId,
    profileId,
    label,
    calendarId,
    calendarLabel: 'Primary',
    privacy: profileId === 'personal' ? 'busy_only' : 'titles',
    getService: async () => {
      if (error) throw error;
      return svc;
    },
  };
}
const ev = (id: string, summary: string, start: string, end: string) => ({ id, summary, start: { dateTime: start }, end: { dateTime: end } });

describe('Calendar ranges and navigation (business timezone)', () => {
  it('month grid: whole Sunday-first weeks, padding days marked, label and nav', () => {
    const r = resolveHubRange('month', NOW, TZ, D('2026-10-18'));
    const days = r.days.map(formatLocalDate);
    assert.equal(days[0], '2026-09-27', 'Oct 1 2026 is a Thursday; grid starts the Sunday before');
    assert.equal(days[days.length - 1], '2026-10-31');
    assert.equal(days.length, 35);
    assert.equal(r.inPeriod(D('2026-09-30')), false);
    assert.equal(r.inPeriod(D('2026-10-01')), true);
    assert.equal(r.label, 'October 2026');
    assert.deepEqual([r.nav.prev, r.nav.next, r.nav.today].map(formatLocalDate), ['2026-09-01', '2026-11-01', '2026-10-18']);
    assert.equal(r.start.toISOString(), '2026-09-27T07:00:00.000Z');
  });

  it('month grid across DST (November 2026) keeps whole local days', () => {
    const r = resolveHubRange('month', NOW, TZ, D('2026-11-05'));
    assert.equal(formatLocalDate(r.days[0]), '2026-11-01');
    assert.equal(r.days.length, 35);
    assert.equal(r.start.toISOString(), '2026-11-01T07:00:00.000Z', 'Nov 1 starts in PDT');
    assert.equal(r.end.toISOString(), '2026-12-06T08:00:00.000Z', 'grid ends in PST');
    const jan = resolveHubRange('month', NOW, TZ, D('2027-01-10'));
    assert.equal(formatLocalDate(resolveHubRange('month', NOW, TZ, D('2026-12-10')).nav.next), '2027-01-01');
    assert.equal(formatLocalDate(jan.nav.prev), '2026-12-01');
  });

  it('week: Sunday to Saturday, including cross-month labels; previous/next move by a week', () => {
    const r = resolveHubRange('week', NOW, TZ, D('2026-10-21'));
    assert.deepEqual([formatLocalDate(r.days[0]), formatLocalDate(r.days[6])], ['2026-10-18', '2026-10-24']);
    assert.equal(r.label, 'October 18–24, 2026');
    assert.deepEqual([r.nav.prev, r.nav.next].map(formatLocalDate), ['2026-10-14', '2026-10-28']);
    assert.equal(resolveHubRange('week', NOW, TZ, D('2026-11-02')).label, 'November 1–7, 2026');
    assert.equal(resolveHubRange('week', NOW, TZ, D('2026-12-01')).label, 'Nov 29 – Dec 5, 2026');
    assert.equal(resolveHubRange('week', NOW, TZ, D('2026-12-31')).label, 'Dec 27 – Jan 2, 2027');
  });

  it('day: label, nav, and a 25-hour fall-back day', () => {
    const r = resolveHubRange('day', NOW, TZ, D('2026-10-18'));
    assert.equal(r.label, 'Sunday, October 18');
    assert.deepEqual([r.nav.prev, r.nav.next].map(formatLocalDate), ['2026-10-17', '2026-10-19']);
    const dst = resolveHubRange('day', NOW, TZ, D('2026-11-01'));
    assert.equal((dst.end.getTime() - dst.start.getTime()) / 3_600_000, 25);
    assert.equal(formatLocalDate(resolveHubRange('today', NOW, TZ, D('2030-01-01')).days[0]), '2026-10-18', 'today ignores the anchor');
  });
});

describe('Calendar Hub month/week data', () => {
  const sources = () => [
    src('business.0', 'business', 'Business', [
      ev('b1', 'Client call', '2026-10-19T10:00:00-07:00', '2026-10-19T11:00:00-07:00'),
      ev('b2', 'Booth booking', '2026-10-24T18:00:00-07:00', '2026-10-24T20:00:00-07:00'),
      ev('late', 'Late setup', '2026-10-24T23:30:00-07:00', '2026-10-25T00:30:00-07:00'),
    ], [['2026-10-25T01:00:00Z', '2026-10-25T03:00:00Z']]),
    src('personal.0', 'personal', 'Personal', [ev('p1', 'Dentist', '2026-10-24T19:00:00-07:00', '2026-10-24T21:00:00-07:00')], [['2026-10-25T02:00:00Z', '2026-10-25T04:00:00Z']]),
  ];

  it('month view returns grid days with availability for every visible day and a cross-account conflict', async () => {
    const h = await buildCalendarHub({ sources: sources(), timeZone: TZ, now: NOW, view: 'month', anchor: D('2026-10-01') });
    assert.equal(h.days.length, 35);
    assert.equal(h.availability.length, 35);
    assert.deepEqual(h.days.find((d) => d.isToday)?.date, '2026-10-18');
    assert.equal(h.days[0].inPeriod, false);
    const sat = h.availability.find((a) => a.date === '2026-10-24')!;
    assert.deepEqual(sat.busy, [{ start: '2026-10-25T01:00:00.000Z', end: '2026-10-25T04:00:00.000Z' }]);
    const booth = h.events.find((e) => e.title === 'Booth booking')!;
    const personal = h.events.find((e) => e.sourceLabel === 'Personal · Primary')!;
    assert.equal(personal.title, 'Personal event');
    assert.ok(booth.crossAccountConflict && personal.crossAccountConflict);
    assert.equal(h.nav.next, '2026-11-01');
    // Timezone boundary: 11:30 PM PDT Saturday is Sunday 06:30 UTC but still Saturday locally.
    assert.equal(h.events.find((e) => e.title === 'Late setup')!.start, '2026-10-25T06:30:00.000Z');
  });

  it('a failing calendar in month view never confirms free time on any day', async () => {
    const failing = src('school.0', 'school', 'School', [], [], new GoogleProfileError('not_connected', 'x'));
    const h = await buildCalendarHub({ sources: [...sources(), failing], timeZone: TZ, now: NOW, view: 'month', anchor: D('2026-10-01') });
    assert.equal(h.status, 'partial');
    assert.ok(h.availability.every((a) => a.status === 'partial' && a.free === null));
  });
});

describe('Calendar Hub API date navigation', () => {
  let dir: string;
  afterEach(() => dir && fs.rmSync(dir, { recursive: true, force: true }));

  it('accepts view + date, rejects malformed dates, and stays GET-only', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phro-hub-nav-'));
    const server = createDashboardServer({
      port: 0,
      dataDir: dir,
      baseDir: dir,
      staticDir: null,
      voiceHealthUrl: null,
      now: () => NOW.getTime(),
      calendarSources: () => ({ sources: [src('business.0', 'business', 'Business', [])], timeZone: TZ }),
    });
    await server.start();
    const base = `http://127.0.0.1:${server.getPort()}/api/calendar`;
    try {
      const month = (await (await fetch(`${base}?view=month&date=2026-12-15`)).json()).data;
      assert.equal(month.range.label, 'December 2026');
      assert.deepEqual(month.nav, { anchor: '2026-12-15', today: '2026-10-18', prev: '2026-11-01', next: '2027-01-01' });
      const day = (await (await fetch(`${base}?view=day&date=2026-10-24`)).json()).data;
      assert.equal(day.range.label, 'Saturday, October 24');
      assert.equal((await fetch(`${base}?view=day&date=2026-02-30`)).status, 400);
      assert.equal((await fetch(`${base}?view=day&date=tomorrow`)).status, 400);
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal((await fetch(base, { method })).status, 405, method);
    } finally {
      await server.stop();
    }
  });
});
