import type { z } from 'zod';
import {
  CompareEventsResultSchema,
  DeliveryHealthSchema,
  EventSummarySchema,
  FeedbackSummarySchema,
  LatestEventResultSchema,
  PhotoBoothAnalyticsError,
  type CompareEventsResult,
  type DeliveryHealth,
  type EventSummary,
  type FeedbackSummary,
  type LatestEventResult,
  type PhotoBoothOperation,
} from './types.js';

export const DEFAULT_PHOTO_BOOTH_ANALYTICS_URL =
  'https://cqlrzijqezowffoxeoxo.supabase.co/functions/v1/event-analytics';
export const DEFAULT_PHOTO_BOOTH_TIMEOUT_MS = 10_000;

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidEventId(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

export interface PhotoBoothAnalyticsConfig {
  url: string;
  apiKey: string;
  timeoutMs: number;
}

/**
 * Reads Photo Booth analytics config from the environment.
 * The URL may default; the API key never does. Fails closed if the key is absent.
 */
export function loadPhotoBoothConfig(env: NodeJS.ProcessEnv = process.env): PhotoBoothAnalyticsConfig {
  const apiKey = env.PHOTO_BOOTH_REPORTING_API_KEY?.trim();
  if (!apiKey) {
    throw new PhotoBoothAnalyticsError(
      'config',
      'PHOTO_BOOTH_REPORTING_API_KEY environment variable is missing. Photo Booth analytics is unavailable.'
    );
  }

  const url = env.PHOTO_BOOTH_ANALYTICS_URL?.trim() || DEFAULT_PHOTO_BOOTH_ANALYTICS_URL;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PhotoBoothAnalyticsError('config', 'PHOTO_BOOTH_ANALYTICS_URL is not a valid URL.');
  }
  const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(isLocal && parsed.protocol === 'http:')) {
    // The reporting key travels in a header; never send it over plain HTTP to a remote host.
    throw new PhotoBoothAnalyticsError('config', 'PHOTO_BOOTH_ANALYTICS_URL must use https.');
  }

  const rawTimeout = Number(env.PHOTO_BOOTH_ANALYTICS_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_PHOTO_BOOTH_TIMEOUT_MS;

  return { url, apiKey, timeoutMs };
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface PhotoBoothAnalyticsClientOptions {
  config: PhotoBoothAnalyticsConfig;
  fetchImpl?: FetchLike;
}

/**
 * Server-side client for the deterministic Photo Booth event-analytics API.
 * Read-only: every operation is a POST that only queries aggregates.
 */
export class PhotoBoothAnalyticsClient {
  private readonly config: PhotoBoothAnalyticsConfig;
  private readonly fetchImpl: FetchLike;

  constructor(options: PhotoBoothAnalyticsClientOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl?: FetchLike): PhotoBoothAnalyticsClient {
    return new PhotoBoothAnalyticsClient({ config: loadPhotoBoothConfig(env), fetchImpl });
  }

  async latestEvent(): Promise<LatestEventResult> {
    return this.request('latest_event', {}, LatestEventResultSchema);
  }

  async eventSummary(eventId: string): Promise<EventSummary> {
    requireEventId(eventId, 'eventId');
    return this.request('event_summary', { eventId }, EventSummarySchema);
  }

  async feedbackSummary(eventId: string): Promise<FeedbackSummary> {
    requireEventId(eventId, 'eventId');
    return this.request('feedback_summary', { eventId }, FeedbackSummarySchema);
  }

  async deliveryHealth(eventId: string): Promise<DeliveryHealth> {
    requireEventId(eventId, 'eventId');
    return this.request('delivery_health', { eventId }, DeliveryHealthSchema);
  }

  async compareEvents(eventIdA: string, eventIdB: string): Promise<CompareEventsResult> {
    requireEventId(eventIdA, 'eventIdA');
    requireEventId(eventIdB, 'eventIdB');
    return this.request('compare_events', { eventIdA, eventIdB }, CompareEventsResultSchema);
  }

  private async request<T>(
    operation: PhotoBoothOperation,
    params: Record<string, string>,
    schema: z.ZodType<T>
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(this.config.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ operation, ...params }),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      if (controller.signal.aborted) {
        throw new PhotoBoothAnalyticsError(
          'timeout',
          `Photo Booth analytics ${operation} timed out after ${this.config.timeoutMs}ms.`
        );
      }
      throw new PhotoBoothAnalyticsError(
        'network',
        `Photo Booth analytics ${operation} request failed: ${this.redact(errorMessage(err))}`
      );
    } finally {
      clearTimeout(timer);
    }

    let body: unknown;
    let bodyParsed = true;
    try {
      body = await response.json();
    } catch {
      bodyParsed = false;
    }

    if (!response.ok) {
      const upstream = bodyParsed ? upstreamErrorText(body) : null;
      const detail = upstream ? `: ${this.redact(upstream)}` : '';
      if (response.status === 401 || response.status === 403) {
        throw new PhotoBoothAnalyticsError(
          'unauthorized',
          `Photo Booth analytics rejected the reporting credentials (HTTP ${response.status}). Check PHOTO_BOOTH_REPORTING_API_KEY.`,
          response.status
        );
      }
      if (response.status === 400) {
        throw new PhotoBoothAnalyticsError(
          'bad_request',
          `Photo Booth analytics rejected the ${operation} request (HTTP 400)${detail}`,
          400
        );
      }
      throw new PhotoBoothAnalyticsError(
        'upstream_error',
        `Photo Booth analytics ${operation} failed upstream (HTTP ${response.status})${detail}`,
        response.status
      );
    }

    if (!bodyParsed) {
      throw new PhotoBoothAnalyticsError(
        'malformed_response',
        `Photo Booth analytics ${operation} returned a non-JSON response.`,
        response.status
      );
    }

    const result = schema.safeParse(body);
    if (!result.success) {
      const issues = result.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new PhotoBoothAnalyticsError(
        'malformed_response',
        `Photo Booth analytics ${operation} returned an unexpected response shape (${issues}).`,
        response.status
      );
    }
    return result.data;
  }

  /** Defence in depth: never let the reporting key appear in an error message. */
  private redact(text: string): string {
    return text.split(this.config.apiKey).join('[REDACTED]').slice(0, 300);
  }
}

function requireEventId(value: unknown, field: string): void {
  if (!isValidEventId(value)) {
    throw new PhotoBoothAnalyticsError('invalid_input', `${field} must be a Photo Booth event UUID.`);
  }
}

function upstreamErrorText(body: unknown): string | null {
  if (body && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string') {
    return (body as { error: string }).error;
  }
  return null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
