import { PhotoBoothAnalyticsClient } from '../photobooth/client.js';
import { answerPhotoBoothQuestion, type MessagesClient, type PhotoBoothConversationContext } from '../photobooth/agent.js';
import { PhotoBoothAnalyticsError, type PhotoBoothErrorKind } from '../photobooth/types.js';

/**
 * Photo Booth analytics as a read-only Pacific Ops voice domain.
 *
 * This module only routes and phrases. Every number comes from the existing
 * answerPhotoBoothQuestion() agent (client, tools, semantics and guardrails live in
 * src/photobooth/). Nothing here can reach the action store, approvals, Gmail or the
 * executor.
 */

export interface PhotoBoothVoiceDeps {
  /** Defaults to PhotoBoothAnalyticsClient.fromEnv() at question time. */
  analytics?: PhotoBoothAnalyticsClient;
  /** Defaults to an Anthropic client from ANTHROPIC_API_KEY. */
  anthropic?: MessagesClient;
  model?: string;
}

/** Minimal per-session analytics context kept in voice session metadata. No API payloads. */
export interface PhotoBoothVoiceContext {
  eventId: string | null;
  lastQuestion: string | null;
  lastAnswer: string | null;
}

export const PHOTO_BOOTH_PROGRESS_TEXT = 'One moment, checking the booth numbers.';

export const PHOTO_BOOTH_VOICE_HELP =
  'You can ask how the latest booth event performed, or about downloads, Instagram, TikTok or Google Review CTA clicks, private feedback, or delivery issues. Say "go back to my inbox" to return to your emails.';

export const PHOTO_BOOTH_MAILBOX_COMMAND_GUIDANCE =
  'We are on Photo Booth analytics right now. Say "go back to my inbox" to return to your emails first.';

/** Booth-specific vocabulary. Bare words like "event" are excluded because emails are about events too. */
const ANALYTICS_PATTERNS: RegExp[] = [
  /\bbooth\b/,
  /\bphoto ?-?booth\b/,
  /\banalytics\b/,
  /\btelemetry\b/,
  /\bdownloads?\b/,
  /\bclaim (?:page|views?)\b/,
  /\binstagram\b/,
  /\btik ?tok\b/,
  /\bgoogle reviews?\b/,
  /\bsocial (?:cta|clicks?)\b/,
  /\bcta\b/,
  /\bfeedback\b/,
  /\bratings?\b/,
  /\b(?:delivery|booth) sessions?\b/,
  /\bhow many sessions\b/,
  /\bunfinali[sz]ed\b/,
  /\bdelivery (?:issues?|problems?|health)\b/,
  /\b(?:latest|last|recent|previous) event\b/,
  /\bcompare\b.*\bevents?\b/,
];

/** Words that tie an utterance to the mailbox, e.g. "summarize the feedback email". */
const MAILBOX_ANCHORS = /\b(?:e-?mails?|messages?|inbox|mailbox|drafts?|reply|replies|sender)\b/;

export function normalizeUtterance(utterance: string): string {
  return utterance.toLowerCase().trim().replace(/[.,!?;:]/g, '').replace(/\s+/g, ' ');
}

/** True when an utterance (normalized) is a Photo Booth analytics question. */
export function isPhotoBoothAnalyticsRequest(norm: string): boolean {
  if (!ANALYTICS_PATTERNS.some((p) => p.test(norm))) return false;
  // Inbox subjects mention the booth too ("the photo booth birthday email"), so mailbox
  // words keep the owner in the mailbox unless they explicitly ask for analytics.
  if (MAILBOX_ANCHORS.test(norm) && !/\banalytics\b|\btelemetry\b/.test(norm)) return false;
  return true;
}

/** "Go back to my inbox", "back to email", "inbox", plain "go back". */
export function isReturnToInboxRequest(norm: string): boolean {
  if (['go back', 'back', 'return', 'inbox', 'my inbox', 'mailbox', 'emails', 'my emails', 'email'].includes(norm)) return true;
  return /\b(?:back|return|switch|go)\b.*\b(?:inbox|mailbox|e-?mails?|messages?)\b/.test(norm) || /\bcheck my (?:inbox|e-?mails?)\b/.test(norm);
}

/**
 * Mailbox actions that must never run from the analytics domain. They get guidance
 * instead of being silently executed against a message the owner can no longer hear.
 */
export function isMailboxActionCommand(norm: string): boolean {
  return (
    /^(?:approve|approve it|approve draft|i approve|reject|reject it|decline|confirm approval|confirm the approval|confirm rejection|confirm the rejection)$/.test(norm) ||
    /\bdraft (?:a )?(?:response|reply)\b/.test(norm) ||
    norm === 'draft' ||
    norm === 'reply' ||
    /^(?:message|email|number) (?:one|two|three|1|2|3)$/.test(norm)
  );
}

export function spokenAnalyticsFailure(kind: PhotoBoothErrorKind | 'unknown_tool' | 'internal' | 'agent'): string {
  switch (kind) {
    case 'config':
      return "Photo Booth analytics isn't configured right now.";
    case 'unauthorized':
      return "I can't authenticate with the Photo Booth analytics service.";
    case 'timeout':
    case 'network':
    case 'upstream_error':
      return "The Photo Booth analytics service isn't responding right now.";
    case 'malformed_response':
      return "I received an invalid analytics response, so I won't report those numbers.";
    case 'invalid_input':
    case 'bad_request':
      return "The analytics service couldn't use that event. You can ask about the latest event instead.";
    default:
      return "I couldn't analyze the Photo Booth data right now.";
  }
}

export interface PhotoBoothVoiceResult {
  text: string;
  ok: boolean;
  /** Event the answer was about, when one was resolved. */
  eventId: string | null;
  /** Safe tool names only, for the session audit trail. */
  tools: string[];
  /** High-level outcome for logs: answered, or the failure kind. */
  outcome: string;
}

/** Asks the existing Photo Booth agent a question and returns a speakable result. Never throws. */
export async function askPhotoBoothForVoice(
  question: string,
  context: PhotoBoothVoiceContext | null,
  deps: PhotoBoothVoiceDeps = {}
): Promise<PhotoBoothVoiceResult> {
  const fail = (kind: Parameters<typeof spokenAnalyticsFailure>[0], tools: string[] = []): PhotoBoothVoiceResult => ({
    text: spokenAnalyticsFailure(kind),
    ok: false,
    eventId: null,
    tools,
    outcome: kind,
  });

  let analytics: PhotoBoothAnalyticsClient;
  try {
    analytics = deps.analytics ?? PhotoBoothAnalyticsClient.fromEnv();
  } catch (err) {
    return fail(err instanceof PhotoBoothAnalyticsError ? err.kind : 'internal');
  }

  const conversation: PhotoBoothConversationContext | undefined = context
    ? { eventId: context.eventId, previousQuestion: context.lastQuestion, previousAnswer: context.lastAnswer }
    : undefined;

  try {
    const result = await answerPhotoBoothQuestion(question, {
      analytics,
      anthropic: deps.anthropic,
      model: deps.model,
      channel: 'voice',
      conversation,
    });
    const tools = result.toolCalls.map((c) => c.name);
    const firstFailure = result.toolCalls.find((c) => !c.ok);
    // If nothing succeeded, speak the failure itself: never let the model soften an outage into "no activity".
    if (firstFailure && !result.toolCalls.some((c) => c.ok)) {
      return fail(firstFailure.errorKind ?? 'internal', tools);
    }
    if (!result.answer) return fail('agent', tools);
    return { text: result.answer, ok: true, eventId: result.eventId, tools, outcome: `answered:${result.source}` };
  } catch (err) {
    // Model/provider failure. Log the error class only; provider messages are not needed on a call.
    console.warn(`[voice:analytics] Photo Booth agent failed (${err instanceof Error ? err.name : 'unknown'}).`);
    return fail('agent');
  }
}
