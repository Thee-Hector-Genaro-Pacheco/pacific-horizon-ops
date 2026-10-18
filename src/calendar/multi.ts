import { CalendarService, freeGaps, googleCalendarTransport, loadCalendarConfig, mergeIntervals } from './service.js';
import { CalendarError, type AvailabilityResult, type SafeCalendarEvent, type TimeInterval } from './types.js';
import { getProfileClient, type ProfileClientOptions } from '../google/clients.js';
import { GoogleProfileError, loadGoogleProfiles, type CalendarPrivacy, type GoogleProfileRegistry } from '../google/profiles.js';

/**
 * Read-only Calendar aggregation across Google profiles. Each source is queried
 * independently; one failing source never turns into "free" or "nothing scheduled",
 * it turns the result into `partial` (some sources answered) or `failed` (none did).
 */

export interface CalendarSource {
  /** Opaque, display-safe source identifier: "<profileId>.<n>". Never the Google Calendar ID. */
  sourceId: string;
  profileId: string;
  /** Display-safe profile label, e.g. "Personal". */
  label: string;
  /** Google Calendar ID. Internal only. */
  calendarId: string;
  /** Display-safe calendar label, e.g. "Primary", "Bookings". */
  calendarLabel: string;
  privacy: CalendarPrivacy;
  /** Lazily builds the read service; may throw (not connected, missing scope, ...). */
  getService(): Promise<CalendarService>;
}

/** A display-safe event plus its internal source identity. */
export interface SourcedEvent extends SafeCalendarEvent {
  sourceId: string;
  profileId: string;
  /** Profile label, e.g. "Business". */
  sourceLabel: string;
  calendarLabel: string;
  /** Internal only. */
  calendarId: string;
  /** Composite identity {profileId, calendarId, eventId}: provider IDs are only unique within a calendar. Internal only. */
  key: string;
}

export type AggregateStatus = 'complete' | 'partial' | 'failed';

export interface SourceFailure {
  profileId: string;
  label: string;
  kind: string;
}

export interface AggregateMeta {
  status: AggregateStatus;
  /** Labels of profiles that answered. */
  checked: string[];
  failed: SourceFailure[];
}

function failureKind(err: unknown): string {
  if (err instanceof CalendarError) return err.kind;
  if (err instanceof GoogleProfileError) {
    if (err.kind === 'missing_scope' || err.kind === 'not_connected') return 'missing_scope';
    if (err.kind === 'account_mismatch') return 'unauthorized';
    return 'config';
  }
  return 'upstream_error';
}

function meta(sources: CalendarSource[], outcomes: PromiseSettledResult<unknown>[]): AggregateMeta {
  const failed: SourceFailure[] = [];
  const checked = new Set<string>();
  outcomes.forEach((o, i) => {
    const s = sources[i];
    if (o.status === 'fulfilled') checked.add(s.label);
    else if (!failed.some((f) => f.profileId === s.profileId)) failed.push({ profileId: s.profileId, label: s.label, kind: failureKind(o.reason) });
  });
  // A profile with one failing calendar is not "checked".
  for (const f of failed) checked.delete(f.label);
  const status: AggregateStatus = failed.length === 0 ? 'complete' : checked.size > 0 ? 'partial' : 'failed';
  return { status, checked: [...checked], failed };
}

/**
 * Same real-world event on two calendars (an invitation) shares an iCalUID and start.
 * Only that is treated as a duplicate; equal titles/times alone are not.
 */
export function dedupeEvents(events: SourcedEvent[], privacyBySource: Map<string, CalendarPrivacy>): SourcedEvent[] {
  const byKey = new Map<string, SourcedEvent>();
  const out: SourcedEvent[] = [];
  for (const ev of events) {
    if (!ev.iCalUID) {
      out.push(ev);
      continue;
    }
    const dedupeKey = `${ev.iCalUID}|${ev.start}`;
    const existing = byKey.get(dedupeKey);
    if (!existing) {
      byKey.set(dedupeKey, ev);
      out.push(ev);
    } else if (privacyBySource.get(existing.sourceId) === 'busy_only' && privacyBySource.get(ev.sourceId) === 'titles') {
      // Prefer the copy whose profile allows its title to be spoken.
      out[out.indexOf(existing)] = ev;
      byKey.set(dedupeKey, ev);
    }
  }
  return out;
}

export class MultiCalendar {
  constructor(
    readonly sources: CalendarSource[],
    readonly timeZone: string
  ) {
    if (sources.length === 0) throw new CalendarError('config', 'No calendars are selected.');
  }

  /** Distinct profile labels in this selection, in order. */
  get labels(): string[] {
    return [...new Set(this.sources.map((s) => s.label))];
  }

  async listEvents(start: Date, end: Date): Promise<{ events: SourcedEvent[]; meta: AggregateMeta }> {
    const outcomes = await Promise.allSettled(
      this.sources.map(async (s) => {
        const events = await (await s.getService()).listEvents(start, end);
        return events.map<SourcedEvent>((e) => ({
          ...e,
          title: s.privacy === 'busy_only' ? `${s.label} event` : e.title,
          sourceId: s.sourceId,
          profileId: s.profileId,
          sourceLabel: s.label,
          calendarLabel: s.calendarLabel,
          calendarId: s.calendarId,
          key: `${s.profileId}:${s.calendarId}:${e.id}`,
        }));
      })
    );
    const all = outcomes.flatMap((o) => (o.status === 'fulfilled' ? o.value : []));
    const privacy = new Map(this.sources.map((s) => [s.sourceId, s.privacy]));
    const events = dedupeEvents(all, privacy).sort(
      (a, b) => Date.parse(a.start) - Date.parse(b.start) || Date.parse(a.end) - Date.parse(b.end) || a.key.localeCompare(b.key)
    );
    return { events, meta: meta(this.sources, outcomes) };
  }

  async nextEvent(now: Date, horizonDays = 30): Promise<{ event: SourcedEvent | null; meta: AggregateMeta }> {
    const { events, meta: m } = await this.listEvents(now, new Date(now.getTime() + horizonDays * 86_400_000));
    return { event: events.find((e) => Date.parse(e.start) >= now.getTime()) ?? null, meta: m };
  }

  /**
   * FreeBusy per source, busy intervals merged. The window is only reported free when
   * every selected source answered; otherwise `result` covers the answering sources only
   * and `meta.status` says so.
   */
  async availability(start: Date, end: Date): Promise<{ result: AvailabilityResult | null; meta: AggregateMeta }> {
    const outcomes = await Promise.allSettled(this.sources.map(async (s) => (await s.getService()).availability(start, end)));
    const m = meta(this.sources, outcomes);
    if (m.status === 'failed') return { result: null, meta: m };
    const busyAll: TimeInterval[] = outcomes.flatMap((o) => (o.status === 'fulfilled' ? o.value.busy : []));
    const busy = mergeIntervals(busyAll, start, end);
    const result: AvailabilityResult = {
      window: { start: start.toISOString(), end: end.toISOString() },
      busy,
      free: freeGaps(busy, start, end),
      isFree: busy.length === 0,
    };
    return { result, meta: m };
  }
}

/** Wraps one CalendarService as a single-source MultiCalendar (business, titles). */
export function singleCalendar(service: CalendarService, label = 'Business', profileId = 'business'): MultiCalendar {
  return new MultiCalendar(
    [
      {
        sourceId: `${profileId}.0`,
        profileId,
        label,
        calendarId: service.config.calendarId,
        calendarLabel: 'Primary',
        privacy: 'titles',
        getService: async () => service,
      },
    ],
    service.timeZone
  );
}

/**
 * Calendar sources for the selected profiles (default: every enabled calendar profile),
 * one per configured calendar ID, each authorized by its own profile's token.
 */
export function calendarSourcesFromRegistry(
  selection: string[] | 'all',
  options: { registry?: GoogleProfileRegistry; env?: NodeJS.ProcessEnv; client?: ProfileClientOptions } = {}
): { sources: CalendarSource[]; timeZone: string } {
  const env = options.env ?? process.env;
  const registry = options.registry ?? loadGoogleProfiles({ env });
  const base = loadCalendarConfig(env);
  const profiles =
    selection === 'all' ? registry.withCapability('calendar.read') : selection.map((id) => registry.get(id));
  const sources: CalendarSource[] = [];
  for (const p of profiles) {
    for (const [index, cal] of p.calendars.entries()) {
      const calendarId = cal.id;
      let service: Promise<CalendarService> | null = null;
      sources.push({
        sourceId: `${p.id}.${index}`,
        profileId: p.id,
        label: p.label,
        calendarId,
        calendarLabel: cal.label,
        privacy: cal.privacy,
        getService: () => {
          service ??= getProfileClient(p.id, 'calendar.read', { registry, ...options.client }).then(
            (auth) => new CalendarService(googleCalendarTransport(auth, base.timeoutMs), { ...base, calendarId })
          );
          return service;
        },
      });
    }
  }
  return { sources, timeZone: base.timeZone };
}
