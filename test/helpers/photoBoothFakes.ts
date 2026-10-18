import type Anthropic from '@anthropic-ai/sdk';
import { PhotoBoothAnalyticsClient, type FetchLike } from '../../src/photobooth/client.js';
import type { MessagesClient } from '../../src/photobooth/agent.js';

/** Shared mocked Photo Booth API + scripted Anthropic fakes. Never touches production. */

export const SECRET = 'pb-test-secret-9f8e7d6c5b4a';
export const URL = 'https://analytics.example.test/functions/v1/event-analytics';
export const EVENT_A = '11111111-2222-4333-8444-555555555555';
export const EVENT_B = '66666666-7777-4888-9999-aaaaaaaaaaaa';

export function eventSummary(eventId = EVENT_A) {
  return {
    operation: 'event_summary',
    eventId,
    startedAt: '2026-10-11T01:00:00.000Z',
    lastActivityAt: '2026-10-11T06:30:00.000Z',
    sessions: { total: 97, ready: 88, preparing: 9, expired: 0 },
    claims: { views: 130, uniqueSessionsViewed: 72 },
    downloads: { total: 80, uniqueSessionsDownloaded: 55 },
    social: {
      instagramClicks: 20,
      instagramUniqueSessions: 15,
      tiktokClicks: 5,
      tiktokUniqueSessions: 4,
      googleReviewClicks: 1,
      googleReviewUniqueSessions: 1,
    },
    feedback: { submissions: 1, averageRating: 5, ratings: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 1 } },
    delivery: { totalSessions: 97, readySessions: 88, unfinalizedSessions: 9, expiredSessions: 0, mediaItemsCount: 180 },
  };
}

export const latestEvent = { operation: 'latest_event', eventId: EVENT_A, lastActivityAt: '2026-10-11T06:30:00.000Z', sessionCount: 97 };

export const feedbackSummary = {
  operation: 'feedback_summary',
  eventId: EVENT_A,
  submissions: 1,
  averageRating: 5,
  ratings: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 1 },
  categories: { photo_quality: 1, ai_effects: 0, qr_delivery: 0, print_experience: 0, ease_of_use: 1, something_went_wrong: 0 },
  consentedTestimonialsCount: 1,
  triage: { total: 0, new: 0, triaged: 0, planned: 0, implemented: 0, verified: 0, actionable: 0 },
};

export const deliveryHealth = {
  operation: 'delivery_health',
  eventId: EVENT_A,
  sessionsCreated: 97,
  sessionsReady: 88,
  sessionsPreparing: 9,
  sessionsExpired: 0,
  totalMediaItems: 180,
  mediaBreakdown: { photo: 150, loopVideo: 30 },
  completionRate: 0.91,
  hasUnfinalizedSessions: true,
};

export function compareResult() {
  const a = eventSummary(EVENT_A);
  const b = eventSummary(EVENT_B);
  b.sessions.total = 50;
  b.delivery.totalSessions = 50;
  return {
    operation: 'compare_events',
    eventIdA: EVENT_A,
    eventIdB: EVENT_B,
    eventA: a,
    eventB: b,
    deltas: {
      sessionsTotalDelta: -47,
      readySessionsDelta: 0,
      claimViewsDelta: 0,
      uniqueSessionsViewedDelta: 0,
      downloadsDelta: 0,
      uniqueSessionsDownloadedDelta: 0,
      instagramClicksDelta: 0,
      tiktokClicksDelta: 0,
      googleReviewClicksDelta: 0,
      feedbackSubmissionsDelta: 0,
      averageRatingDelta: 0,
    },
  };
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Mock of the upstream API: routes by operation, records every request. */
export function mockFetch(handler?: (body: Record<string, unknown>) => { status: number; body: unknown } | 'throw') {
  const requests: RecordedRequest[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init.body));
    requests.push({ url, method: String(init.method), headers: init.headers as Record<string, string>, body });
    const routed = handler?.(body) ?? defaultRoute(body);
    if (routed === 'throw') throw new TypeError('fetch failed');
    const raw = typeof routed.body === 'string' ? routed.body : JSON.stringify(routed.body);
    return new Response(raw, { status: routed.status, headers: { 'Content-Type': 'application/json' } });
  };
  return { fetchImpl, requests };
}

export function defaultRoute(body: Record<string, unknown>): { status: number; body: unknown } {
  switch (body.operation) {
    case 'latest_event':
      return { status: 200, body: latestEvent };
    case 'event_summary':
      return { status: 200, body: eventSummary(body.eventId as string) };
    case 'feedback_summary':
      return { status: 200, body: feedbackSummary };
    case 'delivery_health':
      return { status: 200, body: deliveryHealth };
    case 'compare_events':
      return { status: 200, body: compareResult() };
    default:
      return { status: 400, body: { error: 'Unknown operation' } };
  }
}

export function makeClient(fetchImpl: FetchLike, timeoutMs = 2000) {
  return new PhotoBoothAnalyticsClient({ config: { url: URL, apiKey: SECRET, timeoutMs }, fetchImpl });
}

/** Captures console output so tests can assert the secret never reaches logs. */
export function captureConsole() {
  const lines: string[] = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  for (const k of ['log', 'warn', 'error'] as const) {
    console[k] = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  }
  return { lines, restore: () => Object.assign(console, originals) };
}

export function textMessage(text: string): Anthropic.Message {
  return {
    id: 'msg_text',
    type: 'message',
    role: 'assistant',
    model: 'test',
    content: [{ type: 'text', text, citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null },
  } as Anthropic.Message;
}

export function toolMessage(id: string, name: string, input: Record<string, unknown>): Anthropic.Message {
  return {
    ...textMessage(''),
    id: `msg_${id}`,
    content: [{ type: 'tool_use', id, name, input }],
    stop_reason: 'tool_use',
  } as Anthropic.Message;
}

/** Scripted fake of the Anthropic messages API; records every request it receives. */
export function fakeAnthropic(script: Array<Anthropic.Message | ((req: Anthropic.MessageCreateParamsNonStreaming) => Anthropic.Message)>) {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: MessagesClient = {
    messages: {
      async create(params) {
        requests.push(structuredClone(params));
        const next = script.shift();
        if (!next) throw new Error('fake anthropic script exhausted');
        return typeof next === 'function' ? next(params) : next;
      },
    },
  };
  return { client, requests };
}

export function toolResultsIn(req: Anthropic.MessageCreateParamsNonStreaming): Anthropic.ToolResultBlockParam[] {
  const last = req.messages[req.messages.length - 1];
  return Array.isArray(last.content) ? (last.content.filter((b) => b.type === 'tool_result') as Anthropic.ToolResultBlockParam[]) : [];
}
