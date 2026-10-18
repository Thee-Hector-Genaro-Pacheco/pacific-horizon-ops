import type { CalendarDayAvailabilityDTO, CalendarEventDTO, CalendarHubDTO, CalendarVoiceScopeDTO } from '../data/contract';

/**
 * Pure display helpers for the Calendar Hub. All times are formatted in the hub's
 * business timezone (from the API), never the browser's.
 */

/** A filter choice: "all", a whole profile ("p:<profileId>") or one calendar ("s:<sourceId>"). */
export type ScopeKey = string;

export interface ScopeOption {
  value: ScopeKey;
  label: string;
}

/** All calendars, each profile, and individual calendars when a profile has more than one. */
export function scopeOptions(hub: Pick<CalendarHubDTO, 'profiles' | 'sources'>): ScopeOption[] {
  const options: ScopeOption[] = [{ value: 'all', label: 'All calendars' }];
  for (const p of hub.profiles) {
    options.push({ value: `p:${p.profileId}`, label: p.label });
    if (p.sourceIds.length > 1) {
      for (const id of p.sourceIds) {
        const s = hub.sources.find((x) => x.sourceId === id);
        if (s) options.push({ value: `s:${id}`, label: s.label });
      }
    }
  }
  return options;
}

/** Source IDs for a scope key; null means every calendar. */
export function scopeToSourceIds(scope: ScopeKey, hub: Pick<CalendarHubDTO, 'sources'> | undefined): string[] | null {
  if (scope === 'all' || !hub) return null;
  if (scope.startsWith('s:')) return [scope.slice(2)];
  if (scope.startsWith('p:')) {
    const ids = hub.sources.filter((s) => s.profileId === scope.slice(2)).map((s) => s.sourceId);
    return ids.length ? ids : null;
  }
  return null;
}

/** The scope key that matches what Pacific Ops last checked by voice. */
export function scopeFromVoice(voice: CalendarVoiceScopeDTO, hub: Pick<CalendarHubDTO, 'profiles'>): ScopeKey {
  if (!voice.profileIds || voice.profileIds.length !== 1) return 'all';
  return hub.profiles.some((p) => p.profileId === voice.profileIds![0]) ? `p:${voice.profileIds[0]}` : 'all';
}

function parts(iso: string, tz: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso))) {
    out[p.type] = p.value;
  }
  return out;
}

export function localDateKey(iso: string, tz: string): string {
  const p = parts(iso, tz);
  return `${p.year}-${p.month}-${p.day}`;
}

/** "10 AM", "2:30 PM", "noon", "midnight". */
export function clock(iso: string, tz: string): string {
  const p = parts(iso, tz);
  const h = Number(p.hour) % 24;
  const m = Number(p.minute);
  if (h === 12 && m === 0) return 'noon';
  if (h === 0 && m === 0) return 'midnight';
  return `${h % 12 === 0 ? 12 : h % 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
}

export function timeRange(e: Pick<CalendarEventDTO, 'start' | 'end' | 'allDay'>, tz: string): string {
  if (e.allDay) return 'All day';
  return `${clock(e.start, tz)} – ${clock(e.end, tz)}`;
}

/** "Today", "Tomorrow", or "Sat, Oct 17" for a YYYY-MM-DD key. */
export function dayHeading(dateKey: string, tz: string, now: Date): string {
  const today = localDateKey(now.toISOString(), tz);
  const tomorrow = localDateKey(new Date(now.getTime() + 86_400_000).toISOString(), tz);
  if (dateKey === today) return 'Today';
  if (dateKey === tomorrow) return 'Tomorrow';
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
}

export interface DayGroup {
  date: string;
  events: CalendarEventDTO[];
}

/** Events grouped by local start day, preserving the API's chronological order. */
export function groupByDay(events: CalendarEventDTO[], tz: string): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const e of events) {
    const date = localDateKey(e.start, tz);
    let g = groups.find((x) => x.date === date);
    if (!g) {
      g = { date, events: [] };
      groups.push(g);
    }
    g.events.push(e);
  }
  return groups;
}

export interface AvailabilityLines {
  /** null when not every selected calendar could be checked: never show "Free" then. */
  free: string[] | null;
  busy: string[];
  note: string | null;
}

export function availabilityLines(day: CalendarDayAvailabilityDTO, tz: string): AvailabilityLines {
  const range = (i: { start: string; end: string }) =>
    i.end === day.window.end && i.start !== day.window.start ? `After ${clock(i.start, tz)}` : `${clock(i.start, tz)} – ${clock(i.end, tz)}`;
  const busy = day.busy.map(range);
  if (day.status === 'failed') return { free: null, busy: [], note: "Couldn't check any selected calendar." };
  if (day.status === 'partial') {
    return { free: null, busy, note: 'Some selected calendars could not be checked, so free time is not confirmed.' };
  }
  return { free: (day.free ?? []).map(range), busy, note: null };
}

export function connectionLabel(c: string | null): string {
  switch (c) {
    case 'connected':
      return 'Connected';
    case 'not_connected':
      return 'Not connected';
    case 'missing_scope':
      return 'Needs Calendar permission';
    case 'unauthorized':
      return 'Sign-in problem';
    case 'error':
      return "Couldn't load";
    default:
      return 'Not in scope';
  }
}
