import type { CalendarEventDTO } from '../data/contract';
import { clock, localDateKey } from './calendarHub';

/**
 * Pure layout for the read-only calendar views. Every position is computed from the
 * business timezone (from the API), never the browser's zone.
 */

export const MINUTES_PER_DAY = 1440;

/** Local date and minutes-after-midnight of an instant in `tz`. */
export function localStamp(iso: string, tz: string): { date: string; minutes: number } {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(iso))) {
    parts[p.type] = p.value;
  }
  return { date: localDateKey(iso, tz), minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute) };
}

function nextDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const n = new Date(Date.UTC(y, m - 1, d + 1));
  return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, '0')}-${String(n.getUTCDate()).padStart(2, '0')}`;
}

/** Local dates an event touches (end exclusive), so multi-day events render on every day they cover. */
export function eventDates(e: Pick<CalendarEventDTO, 'start' | 'end' | 'allDay'>, tz: string): string[] {
  const first = localDateKey(e.start, tz);
  const endStamp = localStamp(e.end, tz);
  // An end exactly at local midnight belongs to the previous day (exclusive end).
  const endsAtMidnight = endStamp.minutes === 0 && Date.parse(e.end) > Date.parse(e.start);
  const last = endsAtMidnight ? localDateKey(new Date(Date.parse(e.end) - 60_000).toISOString(), tz) : endStamp.date;
  const dates = [first];
  let cur = first;
  while (cur < last && dates.length < 62) {
    cur = nextDate(cur);
    dates.push(cur);
  }
  return dates;
}

export interface DaySegment {
  event: CalendarEventDTO;
  startMin: number;
  endMin: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
  /** 0-based column within its overlap cluster. */
  lane: number;
  /** Columns in its overlap cluster. */
  lanes: number;
}

/** All-day events and positioned timed segments for one local day. */
export function layoutDay(events: CalendarEventDTO[], date: string, tz: string): { allDay: CalendarEventDTO[]; timed: DaySegment[] } {
  const allDay: CalendarEventDTO[] = [];
  const raw: Omit<DaySegment, 'lane' | 'lanes'>[] = [];
  for (const e of events) {
    const dates = eventDates(e, tz);
    if (!dates.includes(date)) continue;
    if (e.allDay) {
      allDay.push(e);
      continue;
    }
    const s = localStamp(e.start, tz);
    const en = localStamp(e.end, tz);
    const startMin = s.date === date ? s.minutes : 0;
    const endMin = en.date === date ? en.minutes : MINUTES_PER_DAY;
    raw.push({
      event: e,
      startMin,
      endMin: Math.max(endMin, startMin + 1),
      continuesBefore: dates[0] !== date,
      continuesAfter: dates[dates.length - 1] !== date,
    });
  }
  raw.sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);

  // Overlap clusters; greedy lanes inside each cluster so overlapping events sit side by side.
  const timed: DaySegment[] = [];
  let cluster: DaySegment[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const lanes = Math.max(1, ...cluster.map((c) => c.lane + 1));
    for (const c of cluster) c.lanes = lanes;
    timed.push(...cluster);
    cluster = [];
  };
  for (const r of raw) {
    if (cluster.length && r.startMin >= clusterEnd) flush();
    const laneEnds: number[] = [];
    for (const c of cluster) laneEnds[c.lane] = Math.max(laneEnds[c.lane] ?? -1, c.endMin);
    let lane = laneEnds.findIndex((end) => end <= r.startMin);
    if (lane === -1) lane = laneEnds.length;
    cluster.push({ ...r, lane, lanes: 1 });
    clusterEnd = Math.max(clusterEnd, r.endMin);
  }
  if (cluster.length) flush();
  return { allDay, timed };
}

/** Month cell content: all-day first, then timed by start; at most `max` visible plus "+N more". */
export function monthCell(events: CalendarEventDTO[], date: string, tz: string, max = 3): { visible: CalendarEventDTO[]; more: number } {
  const here = events.filter((e) => eventDates(e, tz).includes(date));
  here.sort((a, b) => Number(b.allDay) - Number(a.allDay) || Date.parse(a.start) - Date.parse(b.start));
  return { visible: here.slice(0, max), more: Math.max(0, here.length - max) };
}

/** Stable palette slot per source (order of the hub's source list). Color is never the only cue. */
export function sourcePalette(sourceIds: string[]): Map<string, number> {
  return new Map(sourceIds.map((id, i) => [id, i % 8]));
}

export function durationLabel(e: Pick<CalendarEventDTO, 'start' | 'end' | 'allDay'>, tz: string): string {
  if (e.allDay) {
    const days = eventDates(e, tz).length;
    return days === 1 ? 'All day' : `${days} days`;
  }
  const mins = Math.round((Date.parse(e.end) - Date.parse(e.start)) / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return [h ? `${h} hr` : '', m ? `${m} min` : ''].filter(Boolean).join(' ') || '0 min';
}

/**
 * The only fields the event drawer may show. Built from the privacy-safe DTO, so a
 * busy_only event shows "<Account> event", and IDs, attendees and links never appear.
 */
export function eventDetailFields(e: CalendarEventDTO, tz: string, dateLabel: string): Array<[string, string]> {
  const when = e.allDay ? 'All day' : `${clock(e.start, tz)} – ${clock(e.end, tz)}`;
  return [
    ['Date', dateLabel],
    ['Time', when],
    ['Duration', durationLabel(e, tz)],
    ['Account', e.profileLabel],
    ['Calendar', e.calendarLabel],
    ['Shows as', e.busy ? 'Busy' : 'Free'],
  ];
}

/** Minutes after local midnight for the current-time line. */
export function nowMinutes(now: Date, tz: string): { date: string; minutes: number } {
  return localStamp(now.toISOString(), tz);
}
