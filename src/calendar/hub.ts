import crypto from 'node:crypto';
import { dedupeEvents, type CalendarSource, type SourcedEvent } from './multi.js';
import { overlappingWith } from './conflicts.js';
import { freeGaps, mergeIntervals } from './service.js';
import { CalendarError, type AvailabilityResult, type TimeInterval } from './types.js';
import { addDays, formatLocalDate, localDateOf, sameDate, weekdayOf, zonedToUtc, type LocalDate } from './time.js';
import { GoogleProfileError, type CalendarPrivacy } from '../google/profiles.js';
import type { VoiceSession } from '../voice/types.js';
import type {
  CalendarConnectionDTO,
  CalendarDayAvailabilityDTO,
  CalendarEventDTO,
  CalendarHubDTO,
  CalendarHubView,
  CalendarProfileDTO,
  CalendarSourceDTO,
  CalendarVoiceScopeDTO,
} from '../dashboard/types.js';

/**
 * Read-only Calendar Hub model for the Command Center. Uses the same sources, privacy
 * and FreeBusy merge as Pacific Ops voice. Never returns Google Calendar IDs, event IDs,
 * attendees, descriptions, links or account emails.
 */

export const HUB_DAY_START_HOUR = 8;
export const HUB_DAY_END_HOUR = 22;
const VOICE_SCOPE_MAX_AGE_MS = 30 * 60_000;

export class CalendarHubRequestError extends Error {}

export interface CalendarHubInput {
  sources: CalendarSource[];
  timeZone: string;
  now: Date;
  view: CalendarHubView;
  /** Opaque source IDs to include; null/empty = all. Unknown IDs are rejected. */
  sourceIds?: string[] | null;
  /** Recent voice sessions, to reflect the real scope of the last Calendar question. */
  sessions?: VoiceSession[];
  /** Local anchor date (month/week/day views). Defaults to today. */
  anchor?: LocalDate | null;
}

function connectionOf(err: unknown): CalendarConnectionDTO {
  if (err instanceof GoogleProfileError) {
    if (err.kind === 'not_connected') return 'not_connected';
    if (err.kind === 'missing_scope') return 'missing_scope';
    if (err.kind === 'account_mismatch') return 'unauthorized';
    return 'error';
  }
  if (err instanceof CalendarError) {
    if (err.kind === 'missing_scope') return 'missing_scope';
    if (err.kind === 'unauthorized') return 'unauthorized';
  }
  return 'error';
}

const RANK: Record<CalendarConnectionDTO, number> = { connected: 0, error: 1, unauthorized: 2, missing_scope: 3, not_connected: 4 };

function opaqueId(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface HubRange {
  start: Date;
  end: Date;
  label: string;
  /** Days shown (and given availability), in order. */
  days: LocalDate[];
  /** Days that belong to the period (month grid padding days are excluded). */
  inPeriod: (d: LocalDate) => boolean;
  nav: { anchor: LocalDate; today: LocalDate; prev: LocalDate; next: LocalDate };
}

function sameMonth(a: LocalDate, b: LocalDate): boolean {
  return a.year === b.year && a.month === b.month;
}

function shiftMonth(d: LocalDate, delta: number): LocalDate {
  const m = d.month - 1 + delta;
  return { year: d.year + Math.floor(m / 12), month: ((m % 12) + 12) % 12 + 1, day: 1 };
}

/**
 * Visible range for a view, anchored on a local date in the business timezone.
 *   month    whole Sunday-first weeks covering the anchor's month
 *   week     Sunday to Saturday containing the anchor
 *   day      the anchor day (`today` = day anchored on today)
 *   upcoming now to 14 days ahead (anchor ignored); availability for the next 7 days
 */
export function resolveHubRange(view: CalendarHubView, now: Date, tz: string, anchorInput?: LocalDate | null): HubRange {
  const today = localDateOf(now, tz);
  const anchor = view === 'today' || view === 'upcoming' ? today : anchorInput ?? today;
  const span = (first: LocalDate, count: number) => Array.from({ length: count }, (_, i) => addDays(first, i));
  const at = (d: LocalDate) => zonedToUtc(tz, d);

  if (view === 'month') {
    const first = { ...anchor, day: 1 };
    const gridStart = addDays(first, -weekdayOf(first));
    const nextMonth = shiftMonth(anchor, 1);
    const lastOfMonth = addDays(nextMonth, -1);
    const gridEnd = addDays(lastOfMonth, 6 - weekdayOf(lastOfMonth));
    const count = Math.round((at(addDays(gridEnd, 1)).getTime() - at(gridStart).getTime()) / 86_400_000);
    const days = span(gridStart, count);
    return {
      start: at(gridStart),
      end: at(addDays(gridEnd, 1)),
      label: `${MONTHS[anchor.month - 1]} ${anchor.year}`,
      days,
      inPeriod: (d) => sameMonth(d, anchor),
      nav: { anchor, today, prev: shiftMonth(anchor, -1), next: nextMonth },
    };
  }
  if (view === 'week') {
    const sunday = addDays(anchor, -weekdayOf(anchor));
    const saturday = addDays(sunday, 6);
    const label =
      sunday.month === saturday.month
        ? `${MONTHS[sunday.month - 1]} ${sunday.day}–${saturday.day}, ${saturday.year}`
        : `${MONTHS[sunday.month - 1].slice(0, 3)} ${sunday.day} – ${MONTHS[saturday.month - 1].slice(0, 3)} ${saturday.day}, ${saturday.year}`;
    return {
      start: at(sunday),
      end: at(addDays(sunday, 7)),
      label,
      days: span(sunday, 7),
      inPeriod: () => true,
      nav: { anchor, today, prev: addDays(anchor, -7), next: addDays(anchor, 7) },
    };
  }
  if (view === 'day' || view === 'today') {
    return {
      start: at(anchor),
      end: at(addDays(anchor, 1)),
      label: `${WEEKDAYS[weekdayOf(anchor)]}, ${MONTHS[anchor.month - 1]} ${anchor.day}`,
      days: [anchor],
      inPeriod: () => true,
      nav: { anchor, today, prev: addDays(anchor, -1), next: addDays(anchor, 1) },
    };
  }
  return {
    start: now,
    end: at(addDays(today, 14)),
    label: 'Upcoming',
    days: span(today, 7),
    inPeriod: () => true,
    nav: { anchor: today, today, prev: today, next: today },
  };
}

/** Most recent Calendar question's scope, from real voice session context only. */
export function voiceCalendarScope(sessions: VoiceSession[] | undefined, now: Date): CalendarVoiceScopeDTO | null {
  const recent = (sessions ?? [])
    .filter((s) => s.metadata?.calendar && now.getTime() - Date.parse(s.updatedAt) <= VOICE_SCOPE_MAX_AGE_MS)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  if (!recent) return null;
  const ctx = recent.metadata!.calendar as { selection?: unknown; label?: unknown; windowStart?: unknown; windowEnd?: unknown };
  if (typeof ctx.windowStart !== 'string' || typeof ctx.windowEnd !== 'string') return null;
  const task = recent.metadata?.readTaskLabel;
  const scopeLabel = typeof task === 'string' && task.includes(' · ') ? task.split(' · ').slice(1).join(' · ') : 'Calendar';
  return {
    scopeLabel,
    profileIds: Array.isArray(ctx.selection) ? ctx.selection.filter((x): x is string => typeof x === 'string') : null,
    dayLabel: typeof ctx.label === 'string' && ctx.label ? ctx.label : null,
    windowStart: ctx.windowStart,
    windowEnd: ctx.windowEnd,
    at: recent.updatedAt,
  };
}

export async function buildCalendarHub(input: CalendarHubInput): Promise<CalendarHubDTO> {
  const { sources, timeZone: tz, now, view } = input;
  const wanted = input.sourceIds && input.sourceIds.length > 0 ? input.sourceIds : null;
  if (wanted) {
    const unknown = wanted.filter((id) => !sources.some((s) => s.sourceId === id));
    if (unknown.length) throw new CalendarHubRequestError(`Unknown calendar source: ${unknown.join(', ')}`);
  }
  const selected = wanted ? sources.filter((s) => wanted.includes(s.sourceId)) : sources;
  const range = resolveHubRange(view, now, tz, input.anchor);
  const firstDay = range.days[0];
  const availStart = zonedToUtc(tz, firstDay);
  const availEnd = zonedToUtc(tz, addDays(range.days[range.days.length - 1], 1));

  const outcomes = await Promise.allSettled(
    selected.map(async (s) => {
      const svc = await s.getService();
      const [events, availability] = await Promise.all([svc.listEvents(range.start, range.end), svc.availability(availStart, availEnd)]);
      return { events, availability };
    })
  );

  const status = new Map<string, CalendarConnectionDTO>();
  const tagged: SourcedEvent[] = [];
  const busyBySource: AvailabilityResult[] = [];
  const failures: CalendarHubDTO['failures'] = [];
  outcomes.forEach((o, i) => {
    const s = selected[i];
    if (o.status === 'fulfilled') {
      status.set(s.sourceId, 'connected');
      busyBySource.push(o.value.availability);
      for (const e of o.value.events) {
        tagged.push({
          ...e,
          title: s.privacy === 'busy_only' ? `${s.label} event` : e.title,
          sourceId: s.sourceId,
          profileId: s.profileId,
          sourceLabel: s.label,
          calendarLabel: s.calendarLabel,
          calendarId: s.calendarId,
          key: `${s.profileId}:${s.calendarId}:${e.id}`,
        });
      }
    } else {
      const c = connectionOf(o.reason);
      status.set(s.sourceId, c);
      failures.push({ label: `${s.label} · ${s.calendarLabel}`, kind: c });
    }
  });

  const privacy = new Map<string, CalendarPrivacy>(selected.map((s) => [s.sourceId, s.privacy]));
  const merged = dedupeEvents(tagged, privacy).sort(
    (a, b) => Date.parse(a.start) - Date.parse(b.start) || Date.parse(a.end) - Date.parse(b.end) || a.key.localeCompare(b.key)
  );
  const events: CalendarEventDTO[] = merged.map((e) => {
    const clashes = overlappingWith(e, merged);
    return {
      id: opaqueId(e.key),
      title: e.title,
      start: e.start,
      end: e.end,
      allDay: e.allDay,
      busy: e.busy,
      sourceId: e.sourceId,
      profileLabel: e.sourceLabel,
      calendarLabel: e.calendarLabel,
      sourceLabel: `${e.sourceLabel} · ${e.calendarLabel}`,
      conflict: clashes.length > 0,
      crossAccountConflict: clashes.some((o) => o.profileId !== e.profileId),
    };
  });

  const answered = outcomes.filter((o) => o.status === 'fulfilled').length;
  const dayStatus: CalendarDayAvailabilityDTO['status'] = answered === 0 ? 'failed' : answered === selected.length ? 'complete' : 'partial';
  const allBusy: TimeInterval[] = busyBySource.flatMap((a) => a.busy);
  const availability: CalendarDayAvailabilityDTO[] = [];
  for (const day of range.days) {
    const start = zonedToUtc(tz, day, HUB_DAY_START_HOUR);
    const end = zonedToUtc(tz, day, HUB_DAY_END_HOUR);
    const busy = dayStatus === 'failed' ? [] : mergeIntervals(allBusy, start, end);
    availability.push({
      date: formatLocalDate(day),
      window: { start: start.toISOString(), end: end.toISOString() },
      status: dayStatus,
      busy,
      free: dayStatus === 'complete' ? freeGaps(busy, start, end) : null,
    });
  }

  const sourceDTOs: CalendarSourceDTO[] = sources.map((s) => ({
    sourceId: s.sourceId,
    profileId: s.profileId,
    profileLabel: s.label,
    calendarLabel: s.calendarLabel,
    label: `${s.label} · ${s.calendarLabel}`,
    privacy: s.privacy,
    selected: selected.includes(s),
    status: status.get(s.sourceId) ?? null,
  }));
  const profiles: CalendarProfileDTO[] = [];
  for (const s of sourceDTOs) {
    let p = profiles.find((x) => x.profileId === s.profileId);
    if (!p) {
      p = { profileId: s.profileId, label: s.profileLabel, sourceIds: [], connection: null };
      profiles.push(p);
    }
    p.sourceIds.push(s.sourceId);
    if (s.status && (p.connection === null || RANK[s.status] > RANK[p.connection])) p.connection = s.status;
  }

  const scopeLabel = !wanted
    ? 'All calendars'
    : [...new Set(selected.map((s) => s.label))]
        .map((label) => {
          const all = sources.filter((s) => s.label === label);
          const picked = selected.filter((s) => s.label === label);
          return picked.length === all.length ? label : picked.map((s) => `${label} · ${s.calendarLabel}`).join(', ');
        })
        .join(' + ');

  return {
    generatedAt: now.toISOString(),
    timeZone: tz,
    view,
    range: { start: range.start.toISOString(), end: range.end.toISOString(), label: range.label },
    nav: {
      anchor: formatLocalDate(range.nav.anchor),
      today: formatLocalDate(range.nav.today),
      prev: formatLocalDate(range.nav.prev),
      next: formatLocalDate(range.nav.next),
    },
    days: range.days.map((d) => ({
      date: formatLocalDate(d),
      weekday: weekdayOf(d),
      isToday: sameDate(d, range.nav.today),
      inPeriod: range.inPeriod(d),
    })),
    scope: { mode: wanted ? 'filtered' : 'all', label: scopeLabel, sourceIds: selected.map((s) => s.sourceId) },
    status: selected.length === 0 ? 'no_sources' : dayStatus,
    failures,
    profiles,
    sources: sourceDTOs,
    events,
    availability,
    voice: voiceCalendarScope(input.sessions, now),
  };
}
