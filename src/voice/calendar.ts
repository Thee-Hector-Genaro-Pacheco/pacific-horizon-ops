import type { CalendarService } from '../calendar/service.js';
import { CalendarError } from '../calendar/types.js';
import { MultiCalendar, calendarSourcesFromRegistry, singleCalendar, type AggregateMeta, type CalendarSource, type SourcedEvent } from '../calendar/multi.js';
import { conflictWindows } from '../calendar/conflicts.js';
import {
  addDays,
  formatLocalDate,
  localDateOf,
  normalizeTimeText,
  parseLocalDate,
  resolveTimePhrase,
  zonedToUtc,
  type LocalDate,
  type ResolvedWindow,
} from '../calendar/time.js';
import {
  describeAvailability,
  describeBusyOnly,
  describeConflicts,
  describeEventAt,
  describeFirstEvent,
  describeNextEvent,
  describeOpenTimes,
  describeSchedule,
  joinLabels,
  spokenCalendarFailure,
} from '../calendar/speech.js';
import { isPhotoBoothAnalyticsRequest } from './analytics.js';

/**
 * Google Calendar as a read-only Pacific Ops voice domain. Routing, follow-up context
 * and phrasing live here; every Google call goes through CalendarService, which only
 * exposes reads. Nothing here can reach the action store, approvals, Gmail or the executor.
 */

export interface CalendarVoiceDeps {
  /** Every calendar source Pacific Ops may read. Defaults to the Google profile registry. */
  sources?: CalendarSource[];
  timeZone?: string;
  /** Legacy single-calendar injection (wrapped as one business source). */
  service?: CalendarService;
  now?: () => Date;
}

/** Profiles a Calendar question covers: every enabled calendar, or specific profile IDs. */
export type CalendarSelection = 'all' | string[];

/** Minimal per-session Calendar context: scope, last window and safe event summaries. No raw payloads or IDs. */
export interface CalendarVoiceContext {
  selection: CalendarSelection;
  windowStart: string;
  windowEnd: string;
  label: string;
  /** YYYY-MM-DD when the last window was a single day. */
  day: string | null;
  events: Array<Pick<SourcedEvent, 'profileId' | 'sourceLabel' | 'calendarLabel' | 'title' | 'start' | 'end' | 'allDay'>> | null;
  /** Index of the event the owner last asked about ("the second one"). */
  focusIndex: number | null;
}

export const CALENDAR_PROGRESS_TEXT = 'One moment, checking your calendar.';

export const CALENDAR_VOICE_HELP =
  'You can ask what you have today, tomorrow, or this weekend, what your next event is, or whether you are free at a certain time. Say "go back to my inbox" to return to your emails.';

export const CALENDAR_MAILBOX_COMMAND_GUIDANCE =
  'We are on your calendar right now. Say "go back to my inbox" to return to your emails first.';

/** Owner day used for "when am I free <day>": 8 AM to 10 PM local. */
export const OPEN_TIME_DAY_START_HOUR = 8;
export const OPEN_TIME_DAY_END_HOUR = 22;
const MAX_CONTEXT_EVENTS = 10;

const CALENDAR_PATTERNS: RegExp[] = [
  /\bcalendar\b/,
  /\bschedule\b/,
  /\bavailab(?:le|ility)\b/,
  /\b(?:am i|are we|i'?m|be|is it) (?:free|busy|open)\b/,
  /\bfree (?:time|on|after|before|from|between|this|next|today|tonight|tomorrow)\b/,
  /\bbusy\b/,
  /\bappointments?\b/,
  /\bbookings?\b/,
  /\bbooked\b/,
  /\bmeetings?\b/,
  /\bwhat do i have\b/,
  /\bdo i have (?:anything|any|a|an)\b/,
  /\bwhat'?s on\b/,
  /\b(?:next|first|upcoming) (?:event|appointment|booking|meeting|thing)s?\b/,
  /\bwhat'?s next\b/,
  /\bmy day\b/,
  /\bconflict(?:s|ing)?\b/,
  /\bdouble[- ]?book(?:ed|ing)?\b/,
  /\boverlap(?:s|ping)?\b/,
];

/** Conflict questions: "any conflicts", "double booked", "do my events overlap", "clashes". */
export const CONFLICT_INTENT = /\b(?:conflict(?:s|ing)?|double[- ]?book(?:ed|ing)?|overlap(?:s|ping)?|clash(?:es|ing)?)\b/;

/** Analytics-specific vocabulary that outranks Calendar words ("how did the booth event perform"). */
const STRONG_ANALYTICS =
  /\b(?:perform|performance|performed|analytics|telemetry|downloads?|instagram|tik ?tok|google reviews?|claim (?:page|views?)|feedback|ratings?|cta|unfinali[sz]ed|delivery (?:sessions?|issues?|problems?|health)|how many sessions|how did)\b/;

const MAILBOX_ANCHORS = /\b(?:e-?mails?|messages?|inbox|mailbox|drafts?|reply|replies|sender)\b/;

export function isCalendarRequest(norm: string): boolean {
  if (!CALENDAR_PATTERNS.some((p) => p.test(norm))) return false;
  if (MAILBOX_ANCHORS.test(norm) && !/\bcalendar\b/.test(norm)) return false;
  return true;
}

/**
 * Explicit, testable domain routing for a normalized utterance. Calendar and Photo Booth
 * analytics can both match "booth" questions; analytics wins only on analytics vocabulary.
 */
export function routeReadDomain(norm: string): 'calendar' | 'photo_booth' | null {
  const calendar = isCalendarRequest(norm);
  const booth = isPhotoBoothAnalyticsRequest(norm);
  if (calendar && booth) return STRONG_ANALYTICS.test(norm) ? 'photo_booth' : 'calendar';
  if (calendar) return 'calendar';
  if (booth) return 'photo_booth';
  return null;
}

export interface CalendarVoiceResult {
  text: string;
  ok: boolean;
  /** Updated context to persist, when the answer succeeded (fully or partially). */
  context: CalendarVoiceContext | null;
  /** Reads performed, for the audit trail (method names only). */
  calls: string[];
  outcome: string;
  /** Display-safe scope label, e.g. "All calendars" or "Business + Personal". */
  scopeLabel: string;
}

const ORDINAL_WORDS: Record<string, number> = {
  first: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2, fourth: 3, '4th': 3, fifth: 4, '5th': 4,
};

const GENERIC_CALENDAR_WORDS = new Set(['my', 'the', 'a', 'your', 'all', 'whole', 'entire', 'google', 'every', 'each', 'other', 'both', 'which', 'what', 'shared', 'only', 'check', 'on', 'in']);

/**
 * Which profiles an utterance names. "all my calendars", "across everything" -> all;
 * "<label> calendar" / "only my <label> calendar" -> those profiles; unknown "<word> calendar" -> unknown.
 */
export function parseCalendarSelection(
  norm: string,
  profiles: Array<{ id: string; label: string }>
): CalendarSelection | { unknown: string } | null {
  if (/\b(?:all|every|both)\b(?: of)?(?: my| the)? (?:calendars?|accounts?)\b|\bacross (?:all|every|everything|my calendars|all my calendars)\b|\beverything\b|\ball of them\b/.test(norm)) {
    return 'all';
  }
  const named = profiles.filter((p) =>
    new RegExp(`\\b(?:${escapeRe(p.id)}|${escapeRe(p.label.toLowerCase())}) (?:calendars?|schedule|account)\\b`).test(norm)
  );
  if (named.length > 0) return named.map((p) => p.id);
  const other = /\b([a-z]+) calendars?\b/.exec(norm);
  if (other && !GENERIC_CALENDAR_WORDS.has(other[1])) return { unknown: other[1] };
  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function partialNote(meta: AggregateMeta, what: string): string {
  if (meta.status !== 'partial') return '';
  const failed = meta.failed.map((f) => f.label.toLowerCase());
  return ` I couldn't check your ${joinLabels(failed)} calendar${failed.length > 1 ? 's' : ''}, so ${what}.`;
}

/** Answers one Calendar question. Never throws; failures are spoken as failures, never as availability. */
export async function answerCalendarQuestion(
  utterance: string,
  context: CalendarVoiceContext | null,
  deps: CalendarVoiceDeps = {}
): Promise<CalendarVoiceResult> {
  const calls: string[] = [];
  let scopeLabel = 'Calendar';
  const fail = (kind: string): CalendarVoiceResult => ({ text: spokenCalendarFailure(kind), ok: false, context: null, calls, outcome: kind, scopeLabel });

  let all: CalendarSource[];
  let tz: string;
  try {
    if (deps.service) {
      const single = singleCalendar(deps.service);
      all = single.sources;
      tz = single.timeZone;
    } else if (deps.sources) {
      all = deps.sources;
      tz = deps.timeZone ?? 'America/Los_Angeles';
    } else {
      const built = calendarSourcesFromRegistry('all');
      all = built.sources;
      tz = built.timeZone;
    }
  } catch (err) {
    return fail(err instanceof CalendarError ? err.kind : 'config');
  }
  if (all.length === 0) return fail('config');

  const profiles = [...new Map(all.map((s) => [s.profileId, { id: s.profileId, label: s.label }])).values()];
  const text = normalizeTimeText(utterance);
  const parsed = parseCalendarSelection(text, profiles);
  if (parsed && typeof parsed === 'object' && 'unknown' in parsed) {
    return {
      text: `I don't have a ${parsed.unknown} calendar connected. I can check ${joinLabels(profiles.map((p) => p.label.toLowerCase()))}.`,
      ok: true,
      context,
      calls,
      outcome: 'unknown_calendar',
      scopeLabel,
    };
  }
  const selection: CalendarSelection = (parsed as CalendarSelection | null) ?? context?.selection ?? 'all';
  const selected = selection === 'all' ? all : all.filter((s) => selection.includes(s.profileId));
  if (selected.length === 0) return fail('config');
  const multi = new MultiCalendar(selected, tz);
  const selectedProfiles = multi.labels;
  scopeLabel = selection === 'all' && profiles.length > 1 ? 'All calendars' : selectedProfiles.join(' + ');
  // Explicitly narrowed answers name their scope: "On your personal calendar, ...".
  const scoped = (t: string) =>
    selection !== 'all' && profiles.length > 1 ? `On your ${joinLabels(selectedProfiles.map((l) => l.toLowerCase()))} calendar${selectedProfiles.length > 1 ? 's' : ''}, ${t.charAt(0).toLowerCase()}${t.slice(1)}` : t;

  const now = (deps.now ?? (() => new Date()))();
  const contextDay = context?.day ? parseLocalDate(context.day) : null;
  const contextWindow: ResolvedWindow | null = context
    ? { start: new Date(context.windowStart), end: new Date(context.windowEnd), label: context.label, day: contextDay, hasTimeOfDay: false }
    : null;
  const phrase = resolveTimePhrase(utterance, now, tz, contextDay);

  const remember = (window: ResolvedWindow, events: SourcedEvent[] | null, focusIndex: number | null = null): CalendarVoiceContext => ({
    selection,
    windowStart: window.start.toISOString(),
    windowEnd: window.end.toISOString(),
    label: window.label,
    day: window.day ? formatLocalDate(window.day) : null,
    events: events
      ? events.slice(0, MAX_CONTEXT_EVENTS).map(({ profileId, sourceLabel, calendarLabel, title, start, end, allDay }) => ({ profileId, sourceLabel, calendarLabel, title, start, end, allDay }))
      : null,
    focusIndex,
  });
  const ok = (t: string, ctx: CalendarVoiceContext, outcome: string): CalendarVoiceResult => ({ text: t, ok: true, context: ctx, calls, outcome, scopeLabel });
  const failedAll = (m: AggregateMeta): CalendarVoiceResult =>
    m.failed.length === 1
      ? fail(m.failed[0].kind)
      : { text: `I couldn't check any of your calendars right now.`, ok: false, context: null, calls, outcome: 'all_failed', scopeLabel };
  const dayWindow = (day: LocalDate, label: string): ResolvedWindow => ({
    start: zonedToUtc(tz, day),
    end: zonedToUtc(tz, addDays(day, 1)),
    label,
    day,
    hasTimeOfDay: false,
  });
  const list = async (window: ResolvedWindow) => {
    calls.push('listEvents');
    return multi.listEvents(window.start, window.end);
  };

  try {
    // Scheduling conflicts: only the overlapping intervals, from the shared conflict semantics.
    if (CONFLICT_INTENT.test(text)) {
      const window = phrase ?? contextWindow ?? dayWindow(localDateOf(now, tz), 'today');
      const { events, meta } = await list(window);
      if (meta.status === 'failed') return failedAll(meta);
      const windows = conflictWindows(events).map((w) => ({ start: w.start, end: w.end, eventLabels: w.events.map((e) => e.sourceLabel) }));
      let answer: string;
      if (meta.status === 'partial') {
        const failed = joinLabels(meta.failed.map((f) => f.label.toLowerCase()));
        const plural = meta.failed.length > 1 ? 'calendars' : 'calendar';
        answer =
          windows.length === 0
            ? `I didn't find a conflict in the calendars I could check, but I couldn't verify your ${failed} ${plural}.`
            : `${describeConflicts(windows, window, tz, now)} I couldn't verify your ${failed} ${plural}, so there may be more.`;
      } else {
        answer = describeConflicts(windows, window, tz, now);
      }
      return ok(scoped(answer), remember(window, events), `conflicts:${meta.status}:${windows.length}`);
    }

    // Next event.
    if (/\b(?:next (?:event|appointment|booking|meeting|thing)|what'?s next|whats next)\b/.test(text)) {
      calls.push('nextEvent');
      const { event, meta } = await multi.nextEvent(now);
      if (meta.status === 'failed') return failedAll(meta);
      const window = dayWindow(localDateOf(event ? new Date(event.start) : now, tz), '');
      const answer = describeNextEvent(event, tz, now) + partialNote(meta, 'there may be something sooner');
      return ok(scoped(answer), remember(window, event ? [event] : [], event ? 0 : null), `next_event:${meta.status}`);
    }

    // "Am I free after that?" / "before that": anchored on the event last discussed.
    const relative = /\b(after|before) (?:that|it|this|the (?:event|meeting|appointment|booking))\b/.exec(text);
    if (relative && context?.events && context.events.length > 0 && contextDay) {
      const anchor = context.events[context.focusIndex ?? context.events.length - 1];
      const start = relative[1] === 'after' ? new Date(anchor.end) : zonedToUtc(tz, contextDay);
      const end = relative[1] === 'after' ? zonedToUtc(tz, addDays(contextDay, 1)) : new Date(anchor.start);
      if (end.getTime() <= start.getTime()) {
        return ok(relative[1] === 'after' ? 'That event runs to the end of the day.' : 'That event starts at the beginning of the day.', context, 'relative_empty');
      }
      const window: ResolvedWindow = { start, end, label: context.label, day: contextDay, hasTimeOfDay: true };
      return answerAvailability(window, { ...context, selection });
    }

    // "What time is the second one?": answered from context, no Google call.
    const ordinal = /\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th|last)\b/.exec(text);
    const asksAboutOne = /\b(?:one|event|appointment|booking|meeting|time|when|start)\b/.test(text);
    if (ordinal && asksAboutOne && !phrase && !parsed && context?.events) {
      const idx = ordinal[1] === 'last' ? context.events.length - 1 : ORDINAL_WORDS[ordinal[1]];
      const events = context.events.map((e) => ({ ...e, id: '', busy: true }));
      return ok(describeEventAt(events, idx, tz), { ...context, focusIndex: idx < events.length ? idx : context.focusIndex }, 'event_at');
    }
    if (ordinal && asksAboutOne && !phrase && !context?.events && ordinal[1] !== 'first') {
      return ok('Ask me about a day first, like "what do I have Saturday".', context ?? remember(dayWindow(localDateOf(now, tz), 'today'), null), 'needs_day');
    }

    // First event of a day.
    if (/\bfirst (?:event|appointment|booking|meeting|thing)\b/.test(text)) {
      const window = phrase ?? contextWindow ?? dayWindow(localDateOf(now, tz), 'today');
      const { events, meta } = await list(window);
      if (meta.status === 'failed') return failedAll(meta);
      return ok(scoped(describeFirstEvent(events, window, tz, now) + partialNote(meta, 'there may be something earlier')), remember(window, events, events.length ? 0 : null), `first_event:${meta.status}`);
    }

    // Availability.
    if (/\b(?:free|available|availability|open|busy)\b/.test(text)) {
      if (phrase?.hasTimeOfDay) return answerAvailability(phrase, remember(phrase, null));
      const base = phrase ?? contextWindow ?? dayWindow(localDateOf(now, tz), 'today');
      const days = daysIn(base, tz).slice(0, 7);
      const answers: string[] = [];
      let worst: AggregateMeta | null = null;
      for (const day of days) {
        const window = days.length === 1 ? { ...base, day } : dayWindow(day, '');
        let searchStart = zonedToUtc(tz, day, OPEN_TIME_DAY_START_HOUR);
        const searchEnd = zonedToUtc(tz, day, OPEN_TIME_DAY_END_HOUR);
        if (searchStart < now) searchStart = now;
        if (searchEnd <= searchStart) continue;
        calls.push('availability');
        const { result, meta } = await multi.availability(searchStart, searchEnd);
        if (meta.status === 'failed' || !result) return failedAll(meta);
        if (meta.status === 'partial') worst = meta;
        const free = result.free.filter((g) => Date.parse(g.end) - Date.parse(g.start) >= 30 * 60_000);
        answers.push(describeOpenTimes(free, window, searchStart, searchEnd, tz, now));
      }
      const body = answers.length > 0 ? answers.join(' ') : `There's no time left to check ${base.label || 'today'}.`;
      const note = worst ? partialNote(worst, "some of that time may not actually be free") : '';
      return ok(scoped(body + note), remember(base, null), `open_times:${worst ? 'partial' : 'complete'}`);
    }

    // Schedule (optionally only bookings).
    const window = phrase ?? contextWindow ?? dayWindow(localDateOf(now, tz), 'today');
    const { events, meta } = await list(window);
    if (meta.status === 'failed') return failedAll(meta);
    const bookingsOnly = /\b(?:bookings?|booked|photo ?booth)\b/.test(text);
    const answer = describeSchedule(events, window, tz, now, { bookingsOnly }) + partialNote(meta, 'this may be incomplete');
    return ok(scoped(answer), remember(window, events), `${bookingsOnly ? 'bookings' : 'schedule'}:${meta.status}`);
  } catch (err) {
    if (err instanceof CalendarError) return fail(err.kind);
    console.warn(`[voice:calendar] Calendar read failed (${err instanceof Error ? err.name : 'unknown'}).`);
    return fail('internal');
  }

  /** Explicit-window availability across the selected calendars, never claiming "free" on partial data. */
  async function answerAvailability(window: ResolvedWindow, ctx: CalendarVoiceContext): Promise<CalendarVoiceResult> {
    calls.push('availability');
    const { result, meta } = await multi.availability(window.start, window.end);
    if (meta.status === 'failed' || !result) return failedAll(meta);
    if (meta.status === 'complete') {
      return ok(scoped(describeAvailability(result, window, tz, now)), ctx, 'availability:complete');
    }
    const checked = joinLabels(meta.checked.map((l) => l.toLowerCase()));
    const failed = joinLabels(meta.failed.map((f) => f.label.toLowerCase()));
    const plural = (n: number) => (n > 1 ? 'calendars' : 'calendar');
    if (result.isFree) {
      return ok(
        `I could verify your ${checked} ${plural(meta.checked.length)}, but I couldn't check your ${failed} ${plural(meta.failed.length)}, so I can't confirm you're completely free.`,
        ctx,
        'availability:partial'
      );
    }
    return ok(
      `${describeBusyOnly(result, window, tz, now)} on the calendars I could check. I couldn't check your ${failed} ${plural(meta.failed.length)}, so I can't confirm the rest of that time is free.`,
      ctx,
      'availability:partial'
    );
  }
}

/** Local days covered by a window (single-day windows return that day). */
function daysIn(window: ResolvedWindow, tz: string): LocalDate[] {
  if (window.day) return [window.day];
  const days: LocalDate[] = [];
  let d = localDateOf(window.start, tz);
  while (zonedToUtc(tz, d) < window.end && days.length < 14) {
    days.push(d);
    d = addDays(d, 1);
  }
  return days;
}
