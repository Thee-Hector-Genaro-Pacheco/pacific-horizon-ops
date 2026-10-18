import { localDateOf, localParts, sameDate, addDays, type ResolvedWindow } from './time.js';
import type { AvailabilityResult, SafeCalendarEvent, TimeInterval } from './types.js';

/**
 * Deterministic, privacy-safe spoken Calendar answers. Built only from the display-safe
 * model: titles and local clock times. Never IDs, timestamps, attendees or links.
 */

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MAX_LISTED = 3;

export function countWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}

export function ordinalWord(i: number): string {
  return ORDINALS[i] ?? `number ${i + 1}`;
}

/** "10 AM", "5:30 PM", "noon", "midnight". */
export function formatClock(iso: string, tz: string): string {
  const { hour, minute } = localParts(new Date(iso), tz);
  if (minute === 0 && hour === 12) return 'noon';
  if (minute === 0 && hour === 0) return 'midnight';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}${minute ? `:${String(minute).padStart(2, '0')}` : ''} ${hour < 12 ? 'AM' : 'PM'}`;
}

/** "5 to 10 PM" when both share AM/PM, otherwise "10 AM to 2 PM". */
export function formatClockRange(startIso: string, endIso: string, tz: string): string {
  const a = formatClock(startIso, tz);
  const b = formatClock(endIso, tz);
  const ma = / (AM|PM)$/.exec(a)?.[1];
  const mb = / (AM|PM)$/.exec(b)?.[1];
  if (ma && ma === mb) return `${a.replace(/ (AM|PM)$/, '')} to ${b}`;
  return `${a} to ${b}`;
}

/** "today", "tomorrow", "Saturday" (within a week), else "Saturday, October 24". */
export function dayPhrase(iso: string, tz: string, now: Date): string {
  const d = localDateOf(new Date(iso), tz);
  const today = localDateOf(now, tz);
  if (sameDate(d, today)) return 'today';
  if (sameDate(d, addDays(today, 1))) return 'tomorrow';
  const weekday = WEEKDAY_NAMES[localParts(new Date(iso), tz).weekday];
  for (let i = 2; i < 7; i++) if (sameDate(d, addDays(today, i))) return weekday;
  return `${weekday}, ${MONTHS[d.month - 1]} ${d.day}`;
}

function windowLabel(window: ResolvedWindow, tz: string, now: Date): string {
  return window.label || dayPhrase(window.start.toISOString(), tz, now);
}

function eventClause(ev: SafeCalendarEvent, tz: string, now: Date, withDay: boolean): string {
  const day = withDay ? `${dayPhrase(ev.start, tz, now)} ` : '';
  if (ev.allDay) return `${ev.title}, ${withDay ? `${dayPhrase(ev.start, tz, now)}, ` : ''}all day`;
  return `${ev.title} ${day}at ${formatClock(ev.start, tz)}`;
}

/** "business", "business and personal", "business, personal, and school". */
export function joinLabels(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

function joinClauses(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

export function isBookingLike(ev: SafeCalendarEvent): boolean {
  return /\b(photo ?booth|booth|booking|booked)\b/i.test(ev.title);
}

/** "You have two events tomorrow: Team sync at 10 AM, and Dinner at 7 PM." */
export function describeSchedule(
  events: SafeCalendarEvent[],
  window: ResolvedWindow,
  tz: string,
  now: Date,
  opts: { bookingsOnly?: boolean } = {}
): string {
  const label = windowLabel(window, tz, now);
  const multiDay = window.day === null;
  if (opts.bookingsOnly) {
    const bookings = events.filter(isBookingLike);
    if (bookings.length === 0) {
      const others = events.length > 0 ? ` You do have ${countWord(events.length)} other ${events.length === 1 ? 'event' : 'events'}.` : '';
      return `I don't see any photo booth bookings on your calendar ${label}.${others}`;
    }
    events = bookings;
  }
  const noun = opts.bookingsOnly ? 'booking' : 'event';
  if (events.length === 0) return `You don't have anything scheduled ${label}.`;
  const listed = events.slice(0, MAX_LISTED).map((e) => eventClause(e, tz, now, multiDay));
  const more = events.length > MAX_LISTED ? `, plus ${countWord(events.length - MAX_LISTED)} more` : '';
  return `You have ${countWord(events.length)} ${events.length === 1 ? noun : `${noun}s`} ${label}: ${joinClauses(listed)}${more}.`;
}

/** Answer about one event by position: "The second one is Dinner, from 7 to 9 PM." */
export function describeEventAt(events: SafeCalendarEvent[], index: number, tz: string): string {
  const ev = events[index];
  if (!ev) {
    return events.length === 0
      ? "There aren't any events in that window."
      : `There ${events.length === 1 ? 'is only one event' : `are only ${countWord(events.length)} events`} in that window.`;
  }
  const when = ev.allDay ? 'all day' : `from ${formatClockRange(ev.start, ev.end, tz)}`;
  return `The ${ordinalWord(index)} one is ${ev.title}, ${when}.`;
}

export function describeNextEvent(ev: SafeCalendarEvent | null, tz: string, now: Date, horizonDays = 30): string {
  if (!ev) return `You don't have anything scheduled in the next ${horizonDays} days.`;
  if (ev.allDay) return `Your next event is ${ev.title}, all day ${dayPhrase(ev.start, tz, now)}.`;
  return `Your next event is ${ev.title}, ${dayPhrase(ev.start, tz, now)} at ${formatClock(ev.start, tz)}.`;
}

export function describeFirstEvent(events: SafeCalendarEvent[], window: ResolvedWindow, tz: string, now: Date): string {
  const label = windowLabel(window, tz, now);
  const timed = events.filter((e) => !e.allDay);
  const first = timed[0] ?? events[0];
  if (!first) return `You don't have anything scheduled ${label}.`;
  if (first.allDay) return `Your first event ${label} is ${first.title}, all day.`;
  return `Your first event ${label} is ${first.title} at ${formatClock(first.start, tz)}.`;
}

function rangeList(intervals: TimeInterval[], tz: string, windowEnd: Date, endOfDayAware: boolean): string {
  return joinClauses(
    intervals.slice(0, MAX_LISTED).map((i) => {
      const toEnd = endOfDayAware && Date.parse(i.end) === windowEnd.getTime();
      return toEnd ? `after ${formatClock(i.start, tz)}` : `from ${formatClockRange(i.start, i.end, tz)}`;
    })
  );
}

/** Answer for an explicit window: free, fully busy, or busy-then-free. */
export function describeAvailability(result: AvailabilityResult, window: ResolvedWindow, tz: string, now: Date): string {
  const label = windowLabel(window, tz, now);
  const span = formatClockRange(result.window.start, result.window.end, tz);
  if (result.isFree) return `You're free ${label} from ${span}.`;
  if (result.free.length === 0) return `You're busy the whole time from ${span} ${label}.`;
  const busy = joinClauses(result.busy.slice(0, MAX_LISTED).map((b) => `from ${formatClockRange(b.start, b.end, tz)}`));
  const free = rangeList(result.free, tz, new Date(result.window.end), true);
  return `You're busy ${busy} ${label}, but you're free ${free}.`;
}

/** "You're busy from 5 to 6 PM Saturday" using only the known busy intervals (for partial results). */
export function describeBusyOnly(result: AvailabilityResult, window: ResolvedWindow, tz: string, now: Date): string {
  const busy = joinClauses(result.busy.slice(0, MAX_LISTED).map((b) => `from ${formatClockRange(b.start, b.end, tz)}`));
  return `You're busy ${busy} ${windowLabel(window, tz, now)}`;
}

/** Answer for "when am I free <day>": open gaps inside the owner's day window. */
export function describeOpenTimes(
  free: TimeInterval[],
  window: ResolvedWindow,
  searchStart: Date,
  searchEnd: Date,
  tz: string,
  now: Date
): string {
  const label = windowLabel(window, tz, now);
  const span = formatClockRange(searchStart.toISOString(), searchEnd.toISOString(), tz);
  if (free.length === 0) return `You don't have any open time ${label} between ${span.replace(' to ', ' and ')}.`;
  if (free.length === 1 && Date.parse(free[0].start) === searchStart.getTime() && Date.parse(free[0].end) === searchEnd.getTime()) {
    return `You're free all of ${label} from ${span}.`;
  }
  return `${label.charAt(0).toUpperCase()}${label.slice(1)} you're free ${rangeList(free, tz, searchEnd, true)}.`;
}

/** Minimal shape of a conflict window for speech (profile labels only; never event titles). */
export interface SpokenConflict {
  start: string;
  end: string;
  /** Profile labels of the events involved, one entry per event. */
  eventLabels: string[];
}

/** "between your business and personal calendars" / "between two business events". */
function conflictSources(c: SpokenConflict): string {
  const distinct = [...new Set(c.eventLabels.map((l) => l.toLowerCase()))];
  if (distinct.length > 1) return `between your ${joinLabels(distinct)} calendars`;
  if (distinct.length === 1) return `between ${countWord(c.eventLabels.length)} ${distinct[0]} events`;
  return '';
}

/**
 * Conflict answer: only the overlapping intervals and their sources, never the day's full
 * event list and never event titles (so busy_only titles cannot leak).
 */
export function describeConflicts(conflicts: SpokenConflict[], window: ResolvedWindow, tz: string, now: Date): string {
  const label = windowLabel(window, tz, now);
  if (conflicts.length === 0) return `You don't have any scheduling conflicts ${label}.`;
  const multiDay = window.day === null;
  const when = (c: SpokenConflict) => `from ${formatClockRange(c.start, c.end, tz)}${multiDay ? ` ${dayPhrase(c.start, tz, now)}` : ''}`;
  const clause = (c: SpokenConflict) => [when(c), conflictSources(c)].filter(Boolean).join(' ');
  if (conflicts.length === 1) return `Yes. You have one scheduling conflict ${label} ${clause(conflicts[0])}.`;
  const listed = conflicts.slice(0, MAX_LISTED).map((c, i) => `the ${ordinalWord(i)} is ${clause(c)}`);
  const more = conflicts.length > MAX_LISTED ? ` There ${conflicts.length - MAX_LISTED === 1 ? 'is' : 'are'} ${countWord(conflicts.length - MAX_LISTED)} more.` : '';
  const body = joinClauses(listed);
  return `You have ${countWord(conflicts.length)} scheduling conflicts ${label}. ${body.charAt(0).toUpperCase()}${body.slice(1)}.${more}`;
}

/** Spoken failure for each Calendar error kind. Never implies availability. */
export function spokenCalendarFailure(kind: string): string {
  switch (kind) {
    case 'missing_scope':
      return "I don't have permission to read your calendar yet.";
    case 'unauthorized':
      return "I can't authenticate with Google Calendar right now.";
    case 'timeout':
    case 'network':
    case 'upstream_error':
      return "Google Calendar isn't responding right now.";
    case 'malformed_response':
      return "I couldn't safely interpret the calendar response.";
    case 'not_found':
      return "I couldn't find the configured calendar.";
    case 'config':
      return "Google Calendar isn't set up for Pacific Ops yet.";
    default:
      return "I couldn't check your calendar right now.";
  }
}
