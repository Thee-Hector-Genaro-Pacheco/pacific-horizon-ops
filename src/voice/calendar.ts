import { CalendarService } from '../calendar/service.js';
import { CalendarError, type SafeCalendarEvent } from '../calendar/types.js';
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
  describeEventAt,
  describeFirstEvent,
  describeNextEvent,
  describeOpenTimes,
  describeSchedule,
  spokenCalendarFailure,
} from '../calendar/speech.js';
import { isPhotoBoothAnalyticsRequest } from './analytics.js';

/**
 * Google Calendar as a read-only Pacific Ops voice domain. Routing, follow-up context
 * and phrasing live here; every Google call goes through CalendarService, which only
 * exposes reads. Nothing here can reach the action store, approvals, Gmail or the executor.
 */

export interface CalendarVoiceDeps {
  /** Defaults to CalendarService.fromBusinessAuth() at question time. */
  service?: CalendarService;
  now?: () => Date;
}

/** Minimal per-session Calendar context: the last window and its safe event summaries. No raw payloads. */
export interface CalendarVoiceContext {
  windowStart: string;
  windowEnd: string;
  label: string;
  /** YYYY-MM-DD when the last window was a single day. */
  day: string | null;
  events: Array<Pick<SafeCalendarEvent, 'title' | 'start' | 'end' | 'allDay'>> | null;
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
];

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
  /** Updated context to persist, when the answer succeeded. */
  context: CalendarVoiceContext | null;
  /** Service reads performed, for the audit trail (method names only). */
  calls: string[];
  outcome: string;
}

const ORDINAL_WORDS: Record<string, number> = {
  first: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2, fourth: 3, '4th': 3, fifth: 4, '5th': 4,
};

/** Answers one Calendar question. Never throws; failures are spoken as failures, never as availability. */
export async function answerCalendarQuestion(
  utterance: string,
  context: CalendarVoiceContext | null,
  deps: CalendarVoiceDeps = {}
): Promise<CalendarVoiceResult> {
  const calls: string[] = [];
  const fail = (kind: string): CalendarVoiceResult => ({ text: spokenCalendarFailure(kind), ok: false, context: null, calls, outcome: kind });

  let service: CalendarService;
  try {
    service = deps.service ?? (await CalendarService.fromBusinessAuth());
  } catch (err) {
    return fail(err instanceof CalendarError ? err.kind : 'unauthorized');
  }

  const now = (deps.now ?? (() => new Date()))();
  const tz = service.timeZone;
  const text = normalizeTimeText(utterance);
  const contextDay = context?.day ? parseLocalDate(context.day) : null;
  const contextWindow: ResolvedWindow | null = context
    ? { start: new Date(context.windowStart), end: new Date(context.windowEnd), label: context.label, day: contextDay, hasTimeOfDay: false }
    : null;
  const phrase = resolveTimePhrase(utterance, now, tz, contextDay);

  const remember = (window: ResolvedWindow, events: SafeCalendarEvent[] | null, focusIndex: number | null = null): CalendarVoiceContext => ({
    windowStart: window.start.toISOString(),
    windowEnd: window.end.toISOString(),
    label: window.label,
    day: window.day ? formatLocalDate(window.day) : null,
    events: events ? events.slice(0, MAX_CONTEXT_EVENTS).map(({ title, start, end, allDay }) => ({ title, start, end, allDay })) : null,
    focusIndex,
  });
  const ok = (t: string, ctx: CalendarVoiceContext, outcome: string): CalendarVoiceResult => ({ text: t, ok: true, context: ctx, calls, outcome });
  const list = async (window: ResolvedWindow) => {
    calls.push('listEvents');
    return service.listEvents(window.start, window.end);
  };
  const dayWindow = (day: LocalDate, label: string): ResolvedWindow => ({
    start: zonedToUtc(tz, day),
    end: zonedToUtc(tz, addDays(day, 1)),
    label,
    day,
    hasTimeOfDay: false,
  });

  try {
    // Next event.
    if (/\b(?:next (?:event|appointment|booking|meeting|thing)|what'?s next|whats next)\b/.test(text)) {
      calls.push('nextEvent');
      const ev = await service.nextEvent(now);
      const window = dayWindow(localDateOf(ev ? new Date(ev.start) : now, tz), '');
      return ok(describeNextEvent(ev, tz, now), remember(window, ev ? [ev as SafeCalendarEvent] : [], ev ? 0 : null), 'next_event');
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
      calls.push('availability');
      const result = await service.availability(start, end);
      return ok(describeAvailability(result, window, tz, now), { ...context }, 'availability_relative');
    }

    // "What time is the second one?": answered from context, no Google call.
    const ordinal = /\b(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th|last)\b/.exec(text);
    const asksAboutOne = /\b(?:one|event|appointment|booking|meeting|time|when|start)\b/.test(text);
    if (ordinal && asksAboutOne && !phrase && context?.events) {
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
      const events = await list(window);
      return ok(describeFirstEvent(events, window, tz, now), remember(window, events, events.length ? 0 : null), 'first_event');
    }

    // Availability.
    if (/\b(?:free|available|availability|open|busy)\b/.test(text)) {
      if (phrase?.hasTimeOfDay) {
        calls.push('availability');
        const result = await service.availability(phrase.start, phrase.end);
        return ok(describeAvailability(result, phrase, tz, now), remember(phrase, null), 'availability');
      }
      const base = phrase ?? contextWindow ?? dayWindow(localDateOf(now, tz), 'today');
      const days = daysIn(base, tz).slice(0, 7);
      const answers: string[] = [];
      for (const day of days) {
        const window = days.length === 1 ? { ...base, day } : dayWindow(day, '');
        let searchStart = zonedToUtc(tz, day, OPEN_TIME_DAY_START_HOUR);
        const searchEnd = zonedToUtc(tz, day, OPEN_TIME_DAY_END_HOUR);
        if (searchStart < now) searchStart = now;
        if (searchEnd <= searchStart) continue;
        calls.push('availability');
        const result = await service.availability(searchStart, searchEnd);
        const free = result.free.filter((g) => Date.parse(g.end) - Date.parse(g.start) >= 30 * 60_000);
        answers.push(describeOpenTimes(free, window, searchStart, searchEnd, tz, now));
      }
      const textOut = answers.length > 0 ? answers.join(' ') : `There's no time left to check ${base.label || 'today'}.`;
      return ok(textOut, remember(base, null), 'open_times');
    }

    // Schedule (optionally only bookings).
    const window = phrase ?? contextWindow ?? dayWindow(localDateOf(now, tz), 'today');
    const events = await list(window);
    const bookingsOnly = /\b(?:bookings?|booked|photo ?booth)\b/.test(text);
    return ok(describeSchedule(events, window, tz, now, { bookingsOnly }), remember(window, events), bookingsOnly ? 'bookings' : 'schedule');
  } catch (err) {
    if (err instanceof CalendarError) return fail(err.kind);
    console.warn(`[voice:calendar] Calendar read failed (${err instanceof Error ? err.name : 'unknown'}).`);
    return fail('internal');
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
