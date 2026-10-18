import type Anthropic from '@anthropic-ai/sdk';
import type { PhotoBoothAnalyticsClient } from './client.js';
import { PhotoBoothAnalyticsError, type PhotoBoothErrorKind } from './types.js';
import {
  caveatsForCompareEvents,
  caveatsForDeliveryHealth,
  caveatsForEventSummary,
  caveatsForFeedbackSummary,
  caveatsForLatestEvent,
} from './semantics.js';

export const PHOTO_BOOTH_TOOL_NAMES = [
  'get_latest_photo_booth_event',
  'get_photo_booth_event_summary',
  'get_photo_booth_feedback_summary',
  'get_photo_booth_delivery_health',
  'compare_photo_booth_events',
] as const;

export type PhotoBoothToolName = (typeof PHOTO_BOOTH_TOOL_NAMES)[number];

const eventIdProperty = {
  type: 'string',
  description: 'Photo Booth event UUID, e.g. the eventId returned by get_latest_photo_booth_event.',
} as const;

/** Read-only tool definitions in Anthropic tool-use format. */
export const PHOTO_BOOTH_TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_latest_photo_booth_event',
    description:
      'Find the most recently active Photo Booth event. Returns its eventId (UUID), lastActivityAt, and sessionCount (delivery sessions created). ' +
      'Call this first whenever the user refers to "the latest event", "the last event", "tonight", or asks about booth performance without giving an event UUID. ' +
      'It does not return metrics; follow up with get_photo_booth_event_summary using the returned eventId. If eventId is null, no booth activity exists yet.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_photo_booth_event_summary',
    description:
      'Get the deterministic performance summary for one Photo Booth event: delivery session counts (total/ready/preparing/expired), claim page views, download clicks, ' +
      'Instagram/TikTok/Google Review CTA clicks, private feedback rating counts, and the activity window (startedAt/lastActivityAt). ' +
      'This is the default tool for "how did the event go", session counts, claim views, downloads, social clicks, and Google Review CTA clicks. ' +
      'It already includes basic feedback and delivery counts, so only call the feedback or delivery tools when more detail is needed.',
    input_schema: {
      type: 'object',
      properties: { eventId: eventIdProperty },
      required: ['eventId'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_photo_booth_feedback_summary',
    description:
      'Get detailed PRIVATE booth feedback for one event: rating distribution, average rating, feedback categories (photo_quality, ai_effects, qr_delivery, print_experience, ease_of_use, something_went_wrong), ' +
      'testimonial consent count, and triage status. Never contains guest comments. These are not Google reviews. ' +
      'Call only when the user asks about feedback categories, what guests complained about, testimonials, or triage; the event summary already has the average rating.',
    input_schema: {
      type: 'object',
      properties: { eventId: eventIdProperty },
      required: ['eventId'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_photo_booth_delivery_health',
    description:
      'Get delivery health for one event: sessionsCreated, sessionsReady, sessionsPreparing (unfinalized), sessionsExpired, media item counts by kind (photo/loopVideo), ' +
      'completionRate (ready / created), and hasUnfinalizedSessions. ' +
      'Call when the user asks about unfinalized sessions, completion rate, media counts, or delivery problems.',
    input_schema: {
      type: 'object',
      properties: { eventId: eventIdProperty },
      required: ['eventId'],
      additionalProperties: false,
    },
  },
  {
    name: 'compare_photo_booth_events',
    description:
      'Compare two Photo Booth events. Returns both full event summaries plus deltas computed as event B minus event A. ' +
      'Call when the user asks to compare two events and both event UUIDs are known. Do not call event_summary separately for the same two events.',
    input_schema: {
      type: 'object',
      properties: {
        eventIdA: { ...eventIdProperty, description: 'Baseline event UUID (A).' },
        eventIdB: { ...eventIdProperty, description: 'Event UUID to compare against the baseline (B).' },
      },
      required: ['eventIdA', 'eventIdB'],
      additionalProperties: false,
    },
  },
];

export type PhotoBoothToolResult =
  | { ok: true; tool: PhotoBoothToolName; data: unknown; caveats: string[] }
  | { ok: false; tool: string; error: { kind: PhotoBoothErrorKind | 'unknown_tool' | 'internal'; message: string } };

export function isPhotoBoothTool(name: string): name is PhotoBoothToolName {
  return (PHOTO_BOOTH_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Executes one Photo Booth tool. Never throws: failures become an explicit
 * { ok: false } result so the agent can never mistake an outage for zero activity.
 */
export async function executePhotoBoothTool(
  name: string,
  input: unknown,
  client: PhotoBoothAnalyticsClient
): Promise<PhotoBoothToolResult> {
  if (!isPhotoBoothTool(name)) {
    return { ok: false, tool: name, error: { kind: 'unknown_tool', message: `Unknown tool: ${name}` } };
  }
  const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;

  try {
    switch (name) {
      case 'get_latest_photo_booth_event': {
        const data = await client.latestEvent();
        return { ok: true, tool: name, data, caveats: caveatsForLatestEvent(data) };
      }
      case 'get_photo_booth_event_summary': {
        const data = await client.eventSummary(args.eventId as string);
        return { ok: true, tool: name, data, caveats: caveatsForEventSummary(data) };
      }
      case 'get_photo_booth_feedback_summary': {
        const data = await client.feedbackSummary(args.eventId as string);
        return { ok: true, tool: name, data, caveats: caveatsForFeedbackSummary(data) };
      }
      case 'get_photo_booth_delivery_health': {
        const data = await client.deliveryHealth(args.eventId as string);
        return { ok: true, tool: name, data, caveats: caveatsForDeliveryHealth(data) };
      }
      case 'compare_photo_booth_events': {
        const data = await client.compareEvents(args.eventIdA as string, args.eventIdB as string);
        return { ok: true, tool: name, data, caveats: caveatsForCompareEvents(data) };
      }
    }
  } catch (err: unknown) {
    if (err instanceof PhotoBoothAnalyticsError) {
      console.warn(`[photobooth] ${name} failed (${err.kind}): ${err.message}`);
      return { ok: false, tool: name, error: { kind: err.kind, message: err.message } };
    }
    console.warn(`[photobooth] ${name} failed unexpectedly.`);
    return { ok: false, tool: name, error: { kind: 'internal', message: 'Unexpected error while querying Photo Booth analytics.' } };
  }
}
