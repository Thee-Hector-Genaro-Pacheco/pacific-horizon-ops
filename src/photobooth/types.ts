import { z } from 'zod';

/**
 * Response contracts for the read-only Photo Booth event-analytics API.
 *
 * These mirror the deterministic outputs computed upstream
 * (photobooth-kiosk-extensions/backend/supabase/functions/event-analytics/analytics.ts).
 * Pacific Rising Ops only validates and interprets them; it never recomputes them.
 */

const count = z.number().int().nonnegative();
const isoOrNull = z.string().nullable();

const RatingsSchema = z.object({
  '1': count,
  '2': count,
  '3': count,
  '4': count,
  '5': count,
});

export const LatestEventResultSchema = z.object({
  operation: z.literal('latest_event'),
  eventId: z.string().nullable(),
  lastActivityAt: isoOrNull,
  sessionCount: count,
});

export const EventSummarySchema = z.object({
  operation: z.literal('event_summary'),
  eventId: z.string(),
  startedAt: isoOrNull,
  lastActivityAt: isoOrNull,
  sessions: z.object({
    total: count,
    ready: count,
    preparing: count,
    expired: count,
  }),
  claims: z.object({
    views: count,
    uniqueSessionsViewed: count,
  }),
  downloads: z.object({
    total: count,
    uniqueSessionsDownloaded: count,
  }),
  social: z.object({
    instagramClicks: count,
    instagramUniqueSessions: count,
    tiktokClicks: count,
    tiktokUniqueSessions: count,
    googleReviewClicks: count,
    googleReviewUniqueSessions: count,
  }),
  feedback: z.object({
    submissions: count,
    averageRating: z.number().nullable(),
    ratings: RatingsSchema,
  }),
  delivery: z.object({
    totalSessions: count,
    readySessions: count,
    unfinalizedSessions: count,
    expiredSessions: count,
    mediaItemsCount: count,
  }),
});

export const FeedbackSummarySchema = z.object({
  operation: z.literal('feedback_summary'),
  eventId: z.string(),
  submissions: count,
  averageRating: z.number().nullable(),
  ratings: RatingsSchema,
  categories: z.object({
    photo_quality: count,
    ai_effects: count,
    qr_delivery: count,
    print_experience: count,
    ease_of_use: count,
    something_went_wrong: count,
  }),
  consentedTestimonialsCount: count,
  triage: z.object({
    total: count,
    new: count,
    triaged: count,
    planned: count,
    implemented: count,
    verified: count,
    actionable: count,
  }),
});

export const DeliveryHealthSchema = z.object({
  operation: z.literal('delivery_health'),
  eventId: z.string(),
  sessionsCreated: count,
  sessionsReady: count,
  sessionsPreparing: count,
  sessionsExpired: count,
  totalMediaItems: count,
  mediaBreakdown: z.object({
    photo: count,
    loopVideo: count,
  }),
  completionRate: z.number().nullable(),
  hasUnfinalizedSessions: z.boolean(),
});

export const CompareEventsResultSchema = z.object({
  operation: z.literal('compare_events'),
  eventIdA: z.string(),
  eventIdB: z.string(),
  eventA: EventSummarySchema,
  eventB: EventSummarySchema,
  deltas: z.object({
    sessionsTotalDelta: z.number().int(),
    readySessionsDelta: z.number().int(),
    claimViewsDelta: z.number().int(),
    uniqueSessionsViewedDelta: z.number().int(),
    downloadsDelta: z.number().int(),
    uniqueSessionsDownloadedDelta: z.number().int(),
    instagramClicksDelta: z.number().int(),
    tiktokClicksDelta: z.number().int(),
    googleReviewClicksDelta: z.number().int(),
    feedbackSubmissionsDelta: z.number().int(),
    averageRatingDelta: z.number().nullable(),
  }),
});

export type LatestEventResult = z.infer<typeof LatestEventResultSchema>;
export type EventSummary = z.infer<typeof EventSummarySchema>;
export type FeedbackSummary = z.infer<typeof FeedbackSummarySchema>;
export type DeliveryHealth = z.infer<typeof DeliveryHealthSchema>;
export type CompareEventsResult = z.infer<typeof CompareEventsResultSchema>;

export type PhotoBoothOperation =
  | 'latest_event'
  | 'event_summary'
  | 'feedback_summary'
  | 'delivery_health'
  | 'compare_events';

/**
 * Why a Photo Booth analytics call did not produce data. A failure is never
 * represented as zero-valued analytics.
 */
export type PhotoBoothErrorKind =
  | 'config' // missing/invalid local configuration (fails closed)
  | 'invalid_input' // bad eventId etc., caught before any network call
  | 'unauthorized' // upstream 401/403
  | 'bad_request' // upstream 400
  | 'upstream_error' // upstream 5xx or other non-2xx
  | 'timeout'
  | 'network'
  | 'malformed_response'; // non-JSON or schema mismatch

export class PhotoBoothAnalyticsError extends Error {
  readonly kind: PhotoBoothErrorKind;
  readonly status?: number;

  constructor(kind: PhotoBoothErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'PhotoBoothAnalyticsError';
    this.kind = kind;
    this.status = status;
  }
}
