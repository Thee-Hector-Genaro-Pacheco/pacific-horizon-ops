import { describe, expect, it } from 'vitest';
import type { CalendarDayAvailabilityDTO, CalendarEventDTO } from '../data/contract';
import { availabilityLines, clock, dayHeading, groupByDay, scopeFromVoice, scopeOptions, scopeToSourceIds, timeRange } from './calendarHub';

const TZ = 'America/Los_Angeles';
const hub = {
  profiles: [
    { profileId: 'business', label: 'Business', sourceIds: ['business.0', 'business.1'], connection: 'connected' as const },
    { profileId: 'personal', label: 'Personal', sourceIds: ['personal.0'], connection: 'connected' as const },
  ],
  sources: [
    { sourceId: 'business.0', profileId: 'business', profileLabel: 'Business', calendarLabel: 'Primary', label: 'Business · Primary', privacy: 'titles' as const, selected: true, status: 'connected' as const },
    { sourceId: 'business.1', profileId: 'business', profileLabel: 'Business', calendarLabel: 'Bookings', label: 'Business · Bookings', privacy: 'titles' as const, selected: true, status: 'connected' as const },
    { sourceId: 'personal.0', profileId: 'personal', profileLabel: 'Personal', calendarLabel: 'Primary', label: 'Personal · Primary', privacy: 'busy_only' as const, selected: true, status: 'connected' as const },
  ],
};

function ev(id: string, start: string, end: string): CalendarEventDTO {
  return { id, title: id, start, end, allDay: false, busy: true, sourceId: 'business.0', profileLabel: 'Business', calendarLabel: 'Primary', sourceLabel: 'Business · Primary', conflict: false, crossAccountConflict: false };
}

describe('calendar hub helpers', () => {
  it('offers all, per-profile, and per-calendar filters only where a profile has several calendars', () => {
    expect(scopeOptions(hub).map((o) => o.label)).toEqual(['All calendars', 'Business', 'Business · Primary', 'Business · Bookings', 'Personal']);
  });

  it('maps filters to opaque source IDs', () => {
    expect(scopeToSourceIds('all', hub)).toBeNull();
    expect(scopeToSourceIds('p:business', hub)).toEqual(['business.0', 'business.1']);
    expect(scopeToSourceIds('s:business.1', hub)).toEqual(['business.1']);
  });

  it('follows the real voice scope', () => {
    const base = { scopeLabel: 'Business', dayLabel: 'tomorrow', windowStart: '', windowEnd: '', at: '' };
    expect(scopeFromVoice({ ...base, profileIds: ['business'] }, hub)).toBe('p:business');
    expect(scopeFromVoice({ ...base, profileIds: null }, hub)).toBe('all');
    expect(scopeFromVoice({ ...base, profileIds: ['business', 'personal'] }, hub)).toBe('all');
  });

  it('formats times in the business timezone, not the browser zone', () => {
    expect(clock('2026-10-17T21:00:00Z', TZ)).toBe('2 PM');
    expect(clock('2026-10-17T19:00:00Z', TZ)).toBe('noon');
    expect(timeRange({ start: '2026-10-17T21:00:00Z', end: '2026-10-17T22:30:00Z', allDay: false }, TZ)).toBe('2 PM – 3:30 PM');
    expect(dayHeading('2026-10-17', TZ, new Date('2026-10-14T19:00:00Z'))).toBe('Sat, Oct 17');
  });

  it('groups by local day keeping chronological order', () => {
    const groups = groupByDay([ev('a', '2026-10-17T16:00:00Z', '2026-10-17T17:00:00Z'), ev('b', '2026-10-18T06:30:00Z', '2026-10-18T07:30:00Z')], TZ);
    // 11:30 PM PDT on the 17th is still Saturday locally.
    expect(groups.map((g) => [g.date, g.events.map((e) => e.id)])).toEqual([['2026-10-17', ['a', 'b']]]);
  });

  it('never shows "Free" when a selected calendar could not be checked', () => {
    const day: CalendarDayAvailabilityDTO = {
      date: '2026-10-17',
      window: { start: '2026-10-17T15:00:00Z', end: '2026-10-18T05:00:00Z' },
      status: 'partial',
      busy: [{ start: '2026-10-18T01:00:00Z', end: '2026-10-18T03:00:00Z' }],
      free: null,
    };
    const lines = availabilityLines(day, TZ);
    expect(lines.free).toBeNull();
    expect(lines.busy).toEqual(['6 PM – 8 PM']);
    expect(lines.note).toMatch(/not confirmed/);
    const complete = availabilityLines({ ...day, status: 'complete', free: [{ start: '2026-10-17T15:00:00Z', end: '2026-10-18T01:00:00Z' }, { start: '2026-10-18T03:00:00Z', end: '2026-10-18T05:00:00Z' }] }, TZ);
    expect(complete.free).toEqual(['8 AM – 6 PM', 'After 8 PM']);
  });
});
