import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CalendarEventDTO } from '../data/contract';
import { durationLabel, eventDates, eventDetailFields, layoutDay, localStamp, monthCell, sourcePalette } from './calendarLayout';

const TZ = 'America/Los_Angeles';

function ev(id: string, start: string, end: string, extra: Partial<CalendarEventDTO> = {}): CalendarEventDTO {
  return {
    id,
    title: id,
    start,
    end,
    allDay: false,
    busy: true,
    sourceId: 'business.0',
    profileLabel: 'Business',
    calendarLabel: 'Primary',
    sourceLabel: 'Business · Primary',
    conflict: false,
    crossAccountConflict: false,
    ...extra,
  };
}
const personal = { sourceId: 'personal.0', profileLabel: 'Personal', sourceLabel: 'Personal · Primary', title: 'Personal event' };

describe('calendar layout (America/Los_Angeles)', () => {
  it('positions timed events by local wall clock in the day', () => {
    const { timed } = layoutDay([ev('call', '2026-10-19T17:00:00Z', '2026-10-19T18:30:00Z')], '2026-10-19', TZ);
    expect(timed).toHaveLength(1);
    expect([timed[0].startMin, timed[0].endMin]).toEqual([10 * 60, 11 * 60 + 30]); // 10:00–11:30 AM PDT
    expect([timed[0].lane, timed[0].lanes]).toEqual([0, 1]);
  });

  it('puts overlapping events side by side and keeps cross-account conflicts visible', () => {
    const b = ev('booth', '2026-10-25T01:00:00Z', '2026-10-25T03:00:00Z', { conflict: true, crossAccountConflict: true }); // 6–8 PM
    const p = ev('p', '2026-10-25T02:00:00Z', '2026-10-25T04:00:00Z', { ...personal, conflict: true, crossAccountConflict: true }); // 7–9 PM
    const later = ev('later', '2026-10-25T04:30:00Z', '2026-10-25T05:00:00Z');
    const { timed } = layoutDay([p, b, later], '2026-10-24', TZ);
    const byId = Object.fromEntries(timed.map((t) => [t.event.id, t]));
    expect([byId.booth.lane, byId.booth.lanes]).toEqual([0, 2]);
    expect([byId.p.lane, byId.p.lanes]).toEqual([1, 2]);
    expect([byId.later.lane, byId.later.lanes]).toEqual([0, 1]);
    expect(byId.p.event.crossAccountConflict).toBe(true);
    expect(byId.p.event.title).toBe('Personal event');
    expect(byId.p.event.sourceLabel).toBe('Personal · Primary');
  });

  it('reuses a free lane in a cluster of three', () => {
    const a = ev('a', '2026-10-19T16:00:00Z', '2026-10-19T18:00:00Z'); // 9–11
    const b = ev('b', '2026-10-19T16:30:00Z', '2026-10-19T17:00:00Z'); // 9:30–10
    const c = ev('c', '2026-10-19T17:15:00Z', '2026-10-19T17:45:00Z'); // 10:15–10:45
    const lanes = Object.fromEntries(layoutDay([a, b, c], '2026-10-19', TZ).timed.map((t) => [t.event.id, [t.lane, t.lanes]]));
    expect(lanes).toEqual({ a: [0, 2], b: [1, 2], c: [1, 2] });
  });

  it('splits events that cross midnight and handles the timezone boundary', () => {
    const late = ev('late', '2026-10-25T06:30:00Z', '2026-10-25T07:30:00Z'); // Sat 11:30 PM – Sun 12:30 AM PDT
    expect(eventDates(late, TZ)).toEqual(['2026-10-24', '2026-10-25']);
    const sat = layoutDay([late], '2026-10-24', TZ).timed[0];
    const sun = layoutDay([late], '2026-10-25', TZ).timed[0];
    expect([sat.startMin, sat.endMin, sat.continuesAfter]).toEqual([23 * 60 + 30, 1440, true]);
    expect([sun.startMin, sun.endMin, sun.continuesBefore]).toEqual([0, 30, true]);
    // Ending exactly at local midnight does not spill into the next day.
    expect(eventDates(ev('eve', '2026-10-25T03:00:00Z', '2026-10-25T07:00:00Z'), TZ)).toEqual(['2026-10-24']);
  });

  it('all-day and multi-day all-day events cover every local date, end exclusive', () => {
    const one = ev('one', '2026-10-21T07:00:00Z', '2026-10-22T07:00:00Z', { allDay: true });
    const three = ev('three', '2026-10-21T07:00:00Z', '2026-10-24T07:00:00Z', { allDay: true });
    expect(eventDates(one, TZ)).toEqual(['2026-10-21']);
    expect(eventDates(three, TZ)).toEqual(['2026-10-21', '2026-10-22', '2026-10-23']);
    expect(layoutDay([three], '2026-10-22', TZ).allDay.map((e) => e.id)).toEqual(['three']);
    expect(durationLabel(three, TZ)).toBe('3 days');
  });

  it('DST: the fall-back day still positions by wall clock', () => {
    // Nov 1 2026: 2 AM PDT -> 1 AM PST. A 9–10 AM PST event.
    const e = ev('dst', '2026-11-01T17:00:00Z', '2026-11-01T18:00:00Z');
    const seg = layoutDay([e], '2026-11-01', TZ).timed[0];
    expect([seg.startMin, seg.endMin]).toEqual([9 * 60, 10 * 60]);
    expect(localStamp('2026-11-01T08:30:00Z', TZ)).toEqual({ date: '2026-11-01', minutes: 60 + 30 }); // 1:30 AM PST
  });

  it('month cells put all-day first, then timed by start, with +N more', () => {
    const events = [
      ev('t3', '2026-10-24T22:00:00Z', '2026-10-24T23:00:00Z'),
      ev('t1', '2026-10-24T16:00:00Z', '2026-10-24T17:00:00Z'),
      ev('ad', '2026-10-24T07:00:00Z', '2026-10-25T07:00:00Z', { allDay: true }),
      ev('t2', '2026-10-24T18:00:00Z', '2026-10-24T19:00:00Z'),
      ev('t4', '2026-10-25T01:00:00Z', '2026-10-25T02:00:00Z'),
    ];
    const cell = monthCell(events, '2026-10-24', TZ, 3);
    expect(cell.visible.map((e) => e.id)).toEqual(['ad', 't1', 't2']);
    expect(cell.more).toBe(2);
    expect(monthCell(events, '2026-10-23', TZ).visible).toEqual([]);
  });

  it('assigns each source a stable palette slot', () => {
    const p = sourcePalette(['business.0', 'business.1', 'personal.0']);
    expect([p.get('business.0'), p.get('business.1'), p.get('personal.0')]).toEqual([0, 1, 2]);
  });

  it('the event drawer shows only privacy-safe fields', () => {
    const e = ev('p-raw-id-123', '2026-10-25T02:00:00Z', '2026-10-25T04:00:00Z', { ...personal });
    const fields = eventDetailFields(e, TZ, 'Saturday');
    expect(fields.map(([k]) => k)).toEqual(['Date', 'Time', 'Duration', 'Account', 'Calendar', 'Shows as']);
    expect(fields).toContainEqual(['Time', '7 PM – 9 PM']);
    expect(fields).toContainEqual(['Duration', '2 hr']);
    const text = JSON.stringify(fields);
    expect(text).not.toContain('p-raw-id-123');
    expect(text).not.toContain('personal.0');
    expect(text).not.toMatch(/@|https?:/);
  });
});

describe('read-only guarantee in the calendar UI', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8');
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('has no mutation controls, drag or resize handlers', () => {
    for (const file of ['../pages/CalendarPage.tsx', '../components/CalendarViews.tsx']) {
      const src = code(read(file));
      expect(src).not.toMatch(/draggable|onDrag|onDrop|onResize|onPointerDown|contentEditable/);
      expect(src).not.toMatch(/>\s*(New event|Create|Add event|Edit|Delete|Remove|Reschedule|RSVP|Accept|Decline|Cancel event)\b/i);
      expect(src).not.toMatch(/method:\s*['"](POST|PUT|PATCH|DELETE)/);
    }
  });

  it('the calendar service exposes reads only', () => {
    const services = code(read('../data/services.ts'));
    const block = services.slice(services.indexOf('interface CalendarHubService'), services.indexOf('}', services.indexOf('interface CalendarHubService')));
    expect(block).toMatch(/getHub\(/);
    expect(block).not.toMatch(/create|update|delete|insert|patch|move/i);
  });
});
