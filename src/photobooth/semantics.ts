import type {
  CompareEventsResult,
  DeliveryHealth,
  EventSummary,
  FeedbackSummary,
  LatestEventResult,
} from './types.js';

/**
 * Metric meanings the agent must preserve. Injected into the system prompt and
 * enforced after generation by findSemanticViolations().
 */
export const PHOTO_BOOTH_METRIC_RULES = `Photo Booth metric meanings (non-negotiable):
- sessions.total / sessionsCreated = booth delivery sessions created. NOT unique people or guests. Say "97 booth delivery sessions were created", never "97 people/guests used the booth".
- ready = the delivery session reached ready state. completionRate = ready sessions / created sessions. It is NOT a download rate, conversion rate, or proof media was saved on a phone.
- preparing / unfinalizedSessions = sessions that remain unfinalized. NEVER call them failed uploads, failures, or crashes; the current telemetry cannot establish the cause. Say "9 sessions remain unfinalized".
- claim_viewed / claims.uniqueSessionsViewed = distinct booth sessions whose claim page was viewed. Not unique people.
- download_clicked / downloads.uniqueSessionsDownloaded = sessions that clicked the download control. It does NOT prove the file was saved to the device. Say "55 distinct sessions clicked download", never "55 guests saved their photos".
- instagramClicks / tiktokClicks = outbound CTA link clicks. They do NOT prove follows. Never say anyone "followed" or that followers were gained.
- googleReviewClicks = clicks on the Google Review CTA. It does NOT prove a review was submitted. Always say "Google Review CTA clicks", never "Google reviews".
- feedback.averageRating / ratings = PRIVATE booth feedback submitted to our own system. NOT Google star ratings. Always call it "private booth feedback".`;

export const PHOTO_BOOTH_DATASET_RULES = `Dataset caveats:
- There is no event metadata yet. An event is identified only by its UUID. Never invent an event title, client name, or event type (no "wedding", "Big 50", etc.) unless a trusted source in this conversation supplies it.
- An event UUID may include testing activity if the same iPad event configuration was reused over time, so do not present session counts as confirmed real-event guest traffic.
- Use startedAt and lastActivityAt when timing matters. If the user asks about "tonight" or a specific day and the data spans a broader window, say so explicitly.`;

/** Deterministic caveats attached to each tool result so the model sees them next to the numbers. */
export function caveatsForLatestEvent(r: LatestEventResult): string[] {
  if (r.eventId === null) {
    return ['No booth activity has been recorded yet. This is a valid empty result, not an error.'];
  }
  return [
    'sessionCount is delivery sessions created, not unique guests.',
    'Event is identified by UUID only; no event name or client is available.',
  ];
}

export function caveatsForEventSummary(s: EventSummary): string[] {
  const caveats = [
    'Event is identified by UUID only; it may include testing activity if the iPad event configuration was reused.',
    `Activity window: ${s.startedAt ?? 'unknown'} to ${s.lastActivityAt ?? 'unknown'}.`,
  ];
  if (s.sessions.total === 0) {
    caveats.push('No delivery sessions exist for this event. This is a valid empty result, not an error.');
  }
  if (s.delivery.unfinalizedSessions > 0) {
    caveats.push(
      `${s.delivery.unfinalizedSessions} session(s) remain unfinalized (preparing). The telemetry does not record why; do not call them failures.`
    );
  }
  return caveats;
}

export function caveatsForFeedbackSummary(f: FeedbackSummary): string[] {
  const caveats = ['Ratings are private booth feedback submitted to our own system, not Google reviews or Google star ratings.'];
  if (f.submissions === 0) caveats.push('No private feedback was submitted for this event.');
  return caveats;
}

export function caveatsForDeliveryHealth(d: DeliveryHealth): string[] {
  const caveats = ['completionRate = ready sessions / created sessions. It is not a download or conversion rate.'];
  if (d.hasUnfinalizedSessions) {
    caveats.push(
      `${d.sessionsPreparing} session(s) remain unfinalized (preparing). The cause is not recorded; do not call them failed uploads.`
    );
  }
  return caveats;
}

export function caveatsForCompareEvents(c: CompareEventsResult): string[] {
  return [
    'Deltas are event B minus event A.',
    'Both events are identified by UUID only and may include testing activity.',
    `Event A window: ${c.eventA.startedAt ?? 'unknown'} to ${c.eventA.lastActivityAt ?? 'unknown'}. Event B window: ${c.eventB.startedAt ?? 'unknown'} to ${c.eventB.lastActivityAt ?? 'unknown'}.`,
  ];
}

export interface SemanticViolation {
  rule: 'social_follows' | 'google_reviews' | 'google_rating' | 'unfinalized_as_failure' | 'sessions_as_people' | 'download_as_save' | 'completion_as_conversion';
  match: string;
}

const VIOLATION_PATTERNS: Array<{ rule: SemanticViolation['rule']; pattern: RegExp }> = [
  { rule: 'social_follows', pattern: /\b\d[\d,]*\s+(?:new\s+)?(?:\w+\s+){0,2}(?:followers?|follows)\b/gi },
  { rule: 'social_follows', pattern: /\b(?:people|guests|users|visitors|sessions?|someone|they)\s+(?:\w+\s+)?followed\b/gi },
  { rule: 'social_follows', pattern: /\b(?:gained|got|earned|new)\s+(?:\d[\d,]*\s+)?(?:new\s+)?followers?\b/gi },
  { rule: 'google_reviews', pattern: /\b(?:\d[\d,]*|one|two|three|a|an|no)\s+(?:new\s+)?google\s+reviews?\b(?!\s+(?:cta|link|button|prompt))/gi },
  { rule: 'google_reviews', pattern: /\b(?:left|wrote|submitted|posted|received)\s+(?:\w+\s+){0,2}google\s+reviews?\b(?!\s+(?:cta|link|button|prompt))/gi },
  { rule: 'google_rating', pattern: /\bgoogle\s+(?:star\s+)?ratings?\b/gi },
  { rule: 'unfinalized_as_failure', pattern: /\b(?:failed|unsuccessful|broken|crashed)\s+(?:uploads?|sessions?|deliver(?:y|ies))\b/gi },
  { rule: 'unfinalized_as_failure', pattern: /\b(?:uploads?|sessions?|deliver(?:y|ies))\s+(?:have\s+|had\s+)?(?:failed|crashed)\b/gi },
  { rule: 'unfinalized_as_failure', pattern: /\b(?:upload|delivery|session)\s+(?:failures?|crash(?:es)?)\b/gi },
  { rule: 'sessions_as_people', pattern: /\b\d[\d,]*\s+(?:unique\s+|distinct\s+|different\s+|individual\s+)?(?:people|persons|guests|users|visitors|attendees|customers|individuals)\b/gi },
  { rule: 'download_as_save', pattern: /\b(?:successfully\s+)?(?:saved|downloaded|stored)\s+(?:their\s+|the\s+|his\s+|her\s+)?(?:photos?|media|videos?|files?|pictures?)\b/gi },
  { rule: 'download_as_save', pattern: /\b(?:successful|confirmed|completed)\s+(?:downloads?|saves?)\b/gi },
  { rule: 'completion_as_conversion', pattern: /\b(?:conversion|download)\s+rate\b/gi },
];

const NEGATION = /\b(?:not|no|never|cannot|can't|doesn't|don't|didn't|isn't|aren't|wasn't|without|nor|rather than|instead of)\b|n't\b/i;

/**
 * Flags phrasings that overstate what the telemetry proves. A match preceded
 * closely by a negation ("does not prove 20 people followed") is allowed, since
 * that is the agent correctly stating the caveat.
 */
export function findSemanticViolations(text: string): SemanticViolation[] {
  const violations: SemanticViolation[] = [];
  for (const { rule, pattern } of VIOLATION_PATTERNS) {
    for (const m of text.matchAll(pattern)) {
      const start = m.index ?? 0;
      const sentenceStart = Math.max(text.lastIndexOf('.', start - 1), text.lastIndexOf('\n', start - 1)) + 1;
      const lead = text.slice(Math.max(sentenceStart, start - 40), start);
      if (NEGATION.test(lead)) continue;
      violations.push({ rule, match: m[0] });
    }
  }
  return violations;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Deterministic, semantically safe plain-text report of an event summary.
 * Used as the CLI "report" output and as the agent's fallback if the model
 * cannot produce an answer that passes the semantic checks.
 */
export function describeEventSummary(s: EventSummary): string {
  if (s.sessions.total === 0 && s.feedback.submissions === 0) {
    return `Booth event ${s.eventId} has no recorded delivery sessions or private feedback.`;
  }

  const parts: string[] = [];
  const window = s.startedAt && s.lastActivityAt ? ` Activity spans ${s.startedAt} to ${s.lastActivityAt}.` : '';
  parts.push(`Booth event ${s.eventId} has ${plural(s.sessions.total, 'delivery session', 'delivery sessions')}.${window}`);

  const status = [`${s.sessions.ready} reached ready state`];
  if (s.delivery.unfinalizedSessions > 0) status.push(`${s.delivery.unfinalizedSessions} remain unfinalized`);
  if (s.sessions.expired > 0) status.push(`${s.sessions.expired} expired`);
  parts.push(`${joinList(status)}.`.replace(/^./, (c) => c.toUpperCase()));

  parts.push(
    `The claim page was viewed from ${plural(s.claims.uniqueSessionsViewed, 'distinct session', 'distinct sessions')}, and ${plural(s.downloads.uniqueSessionsDownloaded, 'distinct session', 'distinct sessions')} clicked download.`
  );
  parts.push(
    `The event recorded ${plural(s.social.instagramClicks, 'Instagram CTA click', 'Instagram CTA clicks')}, ${plural(s.social.tiktokClicks, 'TikTok CTA click', 'TikTok CTA clicks')}, and ${plural(s.social.googleReviewClicks, 'Google Review CTA click', 'Google Review CTA clicks')}.`
  );

  if (s.feedback.submissions === 0) {
    parts.push('No private booth feedback was submitted.');
  } else {
    const avg = s.feedback.averageRating !== null ? ` with an average rating of ${s.feedback.averageRating.toFixed(1)}` : '';
    parts.push(`${plural(s.feedback.submissions, 'private booth feedback submission was', 'private booth feedback submissions were')} received${avg}.`);
  }

  let text = parts.join(' ');
  if (s.delivery.unfinalizedSessions > 0) {
    text += `\n\nOne operational item worth reviewing is the ${plural(s.delivery.unfinalizedSessions, 'session', 'sessions')} still in preparing state. The current telemetry does not establish why ${s.delivery.unfinalizedSessions === 1 ? 'it was' : 'they were'} not finalized.`;
  }
  return text;
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}
