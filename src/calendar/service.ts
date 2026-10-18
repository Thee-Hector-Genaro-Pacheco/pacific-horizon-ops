import fs from 'node:fs';
import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { CALENDAR_READONLY_SCOPE, getAuthenticatedClient, missingScopes, resolveTokenPath } from '../auth.js';
import { isValidTimeZone, parseLocalDate, zonedToUtc } from './time.js';
import {
  CalendarError,
  RawEventListSchema,
  RawEventSchema,
  RawFreeBusySchema,
  type AvailabilityResult,
  type RawEvent,
  type SafeCalendarEvent,
  type TimeInterval,
} from './types.js';

export const DEFAULT_TIMEZONE = 'America/Los_Angeles';
export const DEFAULT_CALENDAR_ID = 'primary';
export const DEFAULT_CALENDAR_TIMEOUT_MS = 10_000;
const MAX_PAGES = 10;

export interface CalendarConfig {
  calendarId: string;
  /** IANA timezone used for every local-time interpretation. */
  timeZone: string;
  timeoutMs: number;
}

/**
 * PHRO_TIMEZONE (IANA, default America/Los_Angeles: the business operates in Southern
 * California), PHRO_CALENDAR_ID (default "primary"), PHRO_CALENDAR_TIMEOUT_MS (default 10000).
 * An invalid timezone fails closed rather than falling back to the machine's zone.
 */
export function loadCalendarConfig(env: NodeJS.ProcessEnv = process.env): CalendarConfig {
  const timeZone = env.PHRO_TIMEZONE?.trim() || DEFAULT_TIMEZONE;
  if (!isValidTimeZone(timeZone)) {
    throw new CalendarError('config', `PHRO_TIMEZONE "${timeZone}" is not a valid IANA timezone (e.g. America/Los_Angeles).`);
  }
  const timeout = Number(env.PHRO_CALENDAR_TIMEOUT_MS);
  return {
    calendarId: env.PHRO_CALENDAR_ID?.trim() || DEFAULT_CALENDAR_ID,
    timeZone,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_CALENDAR_TIMEOUT_MS,
  };
}

/** The only Google Calendar operations Pacific Ops can perform. All are reads. */
export interface CalendarTransport {
  listEvents(params: { calendarId: string; timeMin: string; timeMax: string; timeZone: string; pageToken?: string }): Promise<unknown>;
  getEvent(params: { calendarId: string; eventId: string }): Promise<unknown>;
  freeBusy(params: { calendarId: string; timeMin: string; timeMax: string; timeZone: string }): Promise<unknown>;
}

interface CalendarApiLike {
  events: {
    list(params: Record<string, unknown>, options?: Record<string, unknown>): Promise<{ data: unknown }>;
    get(params: Record<string, unknown>, options?: Record<string, unknown>): Promise<{ data: unknown }>;
  };
  freebusy: {
    query(params: Record<string, unknown>, options?: Record<string, unknown>): Promise<{ data: unknown }>;
  };
}

export function googleCalendarTransport(auth: OAuth2Client, timeoutMs: number, api?: CalendarApiLike): CalendarTransport {
  const calendar = api ?? (google.calendar({ version: 'v3', auth }) as unknown as CalendarApiLike);
  const options = { timeout: timeoutMs };
  return {
    async listEvents(p) {
      const res = await calendar.events.list(
        {
          calendarId: p.calendarId,
          timeMin: p.timeMin,
          timeMax: p.timeMax,
          timeZone: p.timeZone,
          // Expand recurring series into individual occurrences; never return masters.
          singleEvents: true,
          orderBy: 'startTime',
          showDeleted: false,
          maxResults: 250,
          ...(p.pageToken ? { pageToken: p.pageToken } : {}),
        },
        options
      );
      return res.data;
    },
    async getEvent(p) {
      const res = await calendar.events.get({ calendarId: p.calendarId, eventId: p.eventId }, options);
      return res.data;
    },
    async freeBusy(p) {
      const res = await calendar.freebusy.query(
        { requestBody: { timeMin: p.timeMin, timeMax: p.timeMax, timeZone: p.timeZone, items: [{ id: p.calendarId }] } },
        options
      );
      return res.data;
    },
  };
}

/** Maps googleapis/gaxios failures onto Calendar error kinds. Never includes tokens. */
export function toCalendarError(err: unknown): CalendarError {
  if (err instanceof CalendarError) return err;
  const e = err as { code?: unknown; response?: { status?: number; data?: unknown }; message?: string; name?: string };
  const status = e?.response?.status ?? (typeof e?.code === 'number' ? e.code : undefined);
  const detail = `${JSON.stringify(e?.response?.data ?? '')} ${e?.message ?? ''}`;
  const code = typeof e?.code === 'string' ? e.code : '';

  if (/insufficient.*scope|insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(detail)) {
    return new CalendarError('missing_scope', 'Google Calendar read permission has not been granted.');
  }
  if (/accessNotConfigured|SERVICE_DISABLED|has not been used in project|is disabled/i.test(detail)) {
    return new CalendarError('config', 'The Google Calendar API is not enabled for this Google Cloud project.');
  }
  if (status === 401 || /invalid_grant|invalid_token|unauthorized_client/i.test(detail)) {
    return new CalendarError('unauthorized', 'Google rejected the stored credentials.');
  }
  if (status === 403) return new CalendarError('unauthorized', 'Google denied access to this calendar.');
  if (status === 404) return new CalendarError('not_found', 'The configured calendar was not found.');
  if (code === 'ETIMEDOUT' || code === 'ECONNABORTED' || e?.name === 'AbortError' || /timeout|timed out|aborted/i.test(e?.message ?? '')) {
    return new CalendarError('timeout', 'Google Calendar did not respond in time.');
  }
  if (typeof status === 'number' && status >= 500) return new CalendarError('upstream_error', `Google Calendar returned HTTP ${status}.`);
  if (['ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH'].includes(code) || e?.name === 'FetchError' || (e?.name === 'TypeError' && /fetch failed/i.test(e?.message ?? ''))) {
    return new CalendarError('network', 'Could not reach Google Calendar.');
  }
  return new CalendarError('upstream_error', 'Google Calendar request failed.');
}

/** Strips anything contact-like or link-like from a title before it can be spoken or logged. */
export function sanitizeTitle(raw: string | null | undefined): string {
  const cleaned = (raw ?? '')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '')
    .replace(/\b[\w-]+\.(?:zoom|meet|teams)\.\S+/gi, '')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–:|,]+|[\s\-–:|,]+$/g, '')
    .trim();
  if (!cleaned) return 'Untitled event';
  return cleaned.length > 80 ? `${cleaned.slice(0, 77).trimEnd()}...` : cleaned;
}

function eventInstant(t: RawEvent['start'], tz: string, which: 'start' | 'end'): { iso: string; allDay: boolean } {
  if (t?.dateTime) {
    const ms = Date.parse(t.dateTime);
    if (Number.isNaN(ms)) throw new CalendarError('malformed_response', `Event ${which} time is not a valid timestamp.`);
    return { iso: new Date(ms).toISOString(), allDay: false };
  }
  if (t?.date) {
    const d = parseLocalDate(t.date);
    if (!d) throw new CalendarError('malformed_response', `Event ${which} date is not a valid date.`);
    return { iso: zonedToUtc(tz, d).toISOString(), allDay: true };
  }
  throw new CalendarError('malformed_response', `Event is missing its ${which} time.`);
}

/** Raw Google event -> display-safe event. Cancelled events return null. */
export function toSafeEvent(raw: unknown, tz: string): SafeCalendarEvent | null {
  const parsed = RawEventSchema.safeParse(raw);
  if (!parsed.success) throw new CalendarError('malformed_response', 'Calendar returned an event in an unexpected shape.');
  const ev = parsed.data;
  if (ev.status === 'cancelled') return null;
  const start = eventInstant(ev.start, tz, 'start');
  const end = eventInstant(ev.end, tz, 'end');
  if (Date.parse(end.iso) < Date.parse(start.iso)) throw new CalendarError('malformed_response', 'Event ends before it starts.');
  const isPrivate = ev.visibility === 'private' || ev.visibility === 'confidential';
  return {
    id: ev.id,
    title: isPrivate ? 'Private event' : sanitizeTitle(ev.summary),
    start: start.iso,
    end: end.iso,
    allDay: start.allDay,
    busy: ev.transparency !== 'transparent',
    ...(ev.iCalUID ? { iCalUID: ev.iCalUID } : {}),
  };
}

/** Merges overlapping/touching intervals and clips them to [start, end). */
export function mergeIntervals(intervals: TimeInterval[], start: Date, end: Date): TimeInterval[] {
  const s0 = start.getTime();
  const e0 = end.getTime();
  const clipped = intervals
    .map((i) => [Math.max(Date.parse(i.start), s0), Math.min(Date.parse(i.end), e0)] as [number, number])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [s, e] of clipped) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged.map(([s, e]) => ({ start: new Date(s).toISOString(), end: new Date(e).toISOString() }));
}

export function freeGaps(busy: TimeInterval[], start: Date, end: Date): TimeInterval[] {
  const gaps: TimeInterval[] = [];
  let cursor = start.getTime();
  for (const b of busy) {
    const bs = Date.parse(b.start);
    if (bs > cursor) gaps.push({ start: new Date(cursor).toISOString(), end: b.start });
    cursor = Math.max(cursor, Date.parse(b.end));
  }
  if (end.getTime() > cursor) gaps.push({ start: new Date(cursor).toISOString(), end: end.toISOString() });
  return gaps;
}

/**
 * Read-only Google Calendar service. Every public method either returns validated,
 * display-safe data or throws a CalendarError; failures never become empty results.
 */
export class CalendarService {
  constructor(
    private readonly transport: CalendarTransport,
    readonly config: CalendarConfig
  ) {}

  /**
   * Builds a service on the existing business Google OAuth client. Fails closed with
   * `missing_scope` (before calling Google) if the stored token lacks Calendar read access.
   */
  static async fromBusinessAuth(env: NodeJS.ProcessEnv = process.env): Promise<CalendarService> {
    const config = loadCalendarConfig(env);
    // Never start an interactive browser OAuth flow from here (e.g. mid-call): no token, no Calendar.
    if (!fs.existsSync(resolveTokenPath('business').tokenPath)) {
      throw new CalendarError('unauthorized', 'No business Google token found. Run: npm run calendar:auth');
    }
    const auth = await getAuthenticatedClient('business');
    if (missingScopes(auth.credentials?.scope, [CALENDAR_READONLY_SCOPE]).length > 0) {
      throw new CalendarError('missing_scope', 'The business Google token does not include Calendar read access yet. Run: npm run calendar:auth');
    }
    return new CalendarService(googleCalendarTransport(auth, config.timeoutMs), config);
  }

  get timeZone(): string {
    return this.config.timeZone;
  }

  /** Expanded, non-cancelled events overlapping [start, end), sorted by start. */
  async listEvents(start: Date, end: Date): Promise<SafeCalendarEvent[]> {
    const events: SafeCalendarEvent[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const raw = await this.call(() =>
        this.transport.listEvents({
          calendarId: this.config.calendarId,
          timeMin: start.toISOString(),
          timeMax: end.toISOString(),
          timeZone: this.config.timeZone,
          pageToken,
        })
      );
      const parsed = RawEventListSchema.safeParse(raw);
      if (!parsed.success) throw new CalendarError('malformed_response', 'Calendar returned an event list in an unexpected shape.');
      for (const item of parsed.data.items ?? []) {
        const ev = toSafeEvent(item, this.config.timeZone);
        if (ev && Date.parse(ev.end) > start.getTime() && Date.parse(ev.start) < end.getTime()) events.push(ev);
      }
      pageToken = parsed.data.nextPageToken ?? undefined;
      if (!pageToken) break;
    }
    return events.sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || Date.parse(a.end) - Date.parse(b.end));
  }

  async getEvent(eventId: string): Promise<SafeCalendarEvent | null> {
    const raw = await this.call(() => this.transport.getEvent({ calendarId: this.config.calendarId, eventId }));
    return toSafeEvent(raw, this.config.timeZone);
  }

  /** First event starting at or after `now`, within `horizonDays`. */
  async nextEvent(now: Date, horizonDays = 30): Promise<SafeCalendarEvent | null> {
    const events = await this.listEvents(now, new Date(now.getTime() + horizonDays * 86_400_000));
    return events.find((e) => Date.parse(e.start) >= now.getTime()) ?? null;
  }

  /**
   * Availability from Google FreeBusy, which already accounts for recurring occurrences,
   * all-day busy events and "Show as: Free" (transparent) events. Busy windows that only
   * touch the window boundary do not count as overlap.
   */
  async availability(start: Date, end: Date): Promise<AvailabilityResult> {
    const raw = await this.call(() =>
      this.transport.freeBusy({
        calendarId: this.config.calendarId,
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        timeZone: this.config.timeZone,
      })
    );
    const parsed = RawFreeBusySchema.safeParse(raw);
    if (!parsed.success) throw new CalendarError('malformed_response', 'Calendar returned free/busy data in an unexpected shape.');
    const keys = Object.keys(parsed.data.calendars);
    const entry = parsed.data.calendars[this.config.calendarId] ?? (keys.length === 1 ? parsed.data.calendars[keys[0]] : undefined);
    if (!entry) throw new CalendarError('malformed_response', 'Free/busy response did not include the configured calendar.');
    if (entry.errors && entry.errors.length > 0) {
      const notFound = entry.errors.some((e) => e.reason === 'notFound');
      throw new CalendarError(notFound ? 'not_found' : 'upstream_error', 'Google Calendar could not report free/busy for this calendar.');
    }
    for (const b of entry.busy ?? []) {
      if (Number.isNaN(Date.parse(b.start)) || Number.isNaN(Date.parse(b.end))) {
        throw new CalendarError('malformed_response', 'Free/busy response contained an invalid time.');
      }
    }
    const busy = mergeIntervals(entry.busy ?? [], start, end);
    return {
      window: { start: start.toISOString(), end: end.toISOString() },
      busy,
      free: freeGaps(busy, start, end),
      isFree: busy.length === 0,
    };
  }

  /** Free gaps of at least `minMinutes` inside [start, end). */
  async openTimes(start: Date, end: Date, minMinutes = 30): Promise<TimeInterval[]> {
    const { free } = await this.availability(start, end);
    return free.filter((g) => Date.parse(g.end) - Date.parse(g.start) >= minMinutes * 60_000);
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw toCalendarError(err);
    }
  }
}
