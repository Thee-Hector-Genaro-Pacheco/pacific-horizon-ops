import { z } from 'zod';

/**
 * Display-safe Calendar domain model. Only what Pacific Ops needs to speak about a
 * schedule: no attendees, organizers, descriptions, locations, conference links,
 * attachments or HTML links ever leave the service layer.
 */
export interface SafeCalendarEvent {
  /** Google event ID. Internal only; never spoken. */
  id: string;
  /** Sanitized title (emails/URLs/phone numbers removed). "Private event" for private events. */
  title: string;
  /** Start instant (ISO, UTC). For all-day events: local midnight of the start date. */
  start: string;
  /** End instant (ISO, UTC, exclusive). For all-day events: local midnight after the last day. */
  end: string;
  allDay: boolean;
  /** False for events marked "Show as: Free" (transparent). */
  busy: boolean;
}

export interface TimeInterval {
  start: string;
  end: string;
}

export interface AvailabilityResult {
  window: TimeInterval;
  /** Merged busy intervals clipped to the window, from FreeBusy. */
  busy: TimeInterval[];
  /** Gaps inside the window that are not busy. */
  free: TimeInterval[];
  isFree: boolean;
}

export type CalendarErrorKind =
  | 'config'
  | 'missing_scope'
  | 'unauthorized'
  | 'not_found'
  | 'timeout'
  | 'network'
  | 'upstream_error'
  | 'malformed_response';

export class CalendarError extends Error {
  readonly kind: CalendarErrorKind;
  constructor(kind: CalendarErrorKind, message: string) {
    super(message);
    this.name = 'CalendarError';
    this.kind = kind;
  }
}

/* Raw Google response validation: only the fields we read, everything else ignored. */

const EventTimeSchema = z.object({
  date: z.string().optional().nullable(),
  dateTime: z.string().optional().nullable(),
  timeZone: z.string().optional().nullable(),
});

export const RawEventSchema = z.object({
  id: z.string(),
  status: z.string().optional().nullable(),
  summary: z.string().optional().nullable(),
  start: EventTimeSchema.optional().nullable(),
  end: EventTimeSchema.optional().nullable(),
  transparency: z.string().optional().nullable(),
  visibility: z.string().optional().nullable(),
});
export type RawEvent = z.infer<typeof RawEventSchema>;

export const RawEventListSchema = z.object({
  items: z.array(z.unknown()).optional().nullable(),
  nextPageToken: z.string().optional().nullable(),
});

export const RawFreeBusySchema = z.object({
  calendars: z.record(
    z.object({
      busy: z.array(z.object({ start: z.string(), end: z.string() })).optional().nullable(),
      errors: z.array(z.object({ domain: z.string().optional().nullable(), reason: z.string().optional().nullable() })).optional().nullable(),
    })
  ),
});
