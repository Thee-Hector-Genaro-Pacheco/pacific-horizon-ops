import { isMailboxActionCommand, isReturnToInboxRequest, normalizeUtterance } from '../voice/analytics.js';
import { CONFLICT_INTENT, isCalendarRequest, parseCalendarSelection, routeReadDomain } from '../voice/calendar.js';
import { isConfirmationPhrase, isRepeatRequest } from '../voice/conversation.js';
import { emailProfiles, isDraftCommand, isEmailReadRequest, parseInboxSelection, type EmailVoiceDeps } from '../voice/email.js';
import { isKnowledgeRequest } from '../voice/knowledge.js';
import { parseMessageSelection } from '../voice/mailbox.js';
import type { Domain, IntentName, IntentResult } from './types.js';

/**
 * Central intent router. Wraps the existing deterministic routing rules; it does not
 * replace them. Approval, confirmation, draft and send intents are matched only by
 * deterministic phrase rules and fail closed. A model-assisted resolver may be consulted
 * only when no deterministic rule matched, and it can only choose a read-only domain.
 */

/** Read-only intents a model-assisted resolver is ever allowed to return. */
export const MODEL_ASSIST_ALLOWED: readonly IntentName[] = ['knowledge.query', 'calendar.schedule', 'gmail.inbox', 'photobooth.analytics'];

/** Optional, separately injected: resolves an ambiguous utterance to a read-only intent. */
export type AmbiguityResolver = (utterance: string) => Promise<{ intent: IntentName; confidence: number } | null>;

const HIGH_RISK: ReadonlySet<IntentName> = new Set(['gmail.draft', 'gmail.approve', 'gmail.confirm', 'gmail.reject']);

const DOMAIN_OF: Record<IntentName, Domain> = {
  'knowledge.query': 'knowledge',
  'calendar.schedule': 'calendar',
  'calendar.availability': 'calendar',
  'calendar.conflicts': 'calendar',
  'gmail.inbox': 'gmail',
  'gmail.select': 'gmail',
  'gmail.draft': 'gmail',
  'gmail.approve': 'gmail',
  'gmail.confirm': 'gmail',
  'gmail.reject': 'gmail',
  'photobooth.analytics': 'photo_booth',
  'session.repeat': 'session',
  'session.return': 'session',
  'session.end': 'session',
  unknown: 'unknown',
};

function result(intent: IntentName, entities: Record<string, string> = {}, requestedScope: IntentResult['requestedScope'] = null, source: IntentResult['source'] = 'deterministic', confidence = 1): IntentResult {
  return { domain: DOMAIN_OF[intent], intent, confidence, source, highRisk: HIGH_RISK.has(intent), entities, requestedScope };
}

export interface RouterOptions {
  /** Inbox profiles, for "check my personal inbox" routing. */
  email?: EmailVoiceDeps;
  /** Calendar profile labels, for scope extraction. */
  calendarProfiles?: Array<{ id: string; label: string }>;
}

/** Deterministic routing only. Never calls a model. */
export function routeIntentDeterministic(utterance: string, opts: RouterOptions = {}): IntentResult {
  const norm = normalizeUtterance(utterance);

  // High-risk mailbox lifecycle: exact deterministic phrases only.
  if (isConfirmationPhrase(utterance, 'approval')) return result('gmail.confirm');
  if (isConfirmationPhrase(utterance, 'rejection')) return result('gmail.reject', { phase: 'confirm' });
  if (/^(?:approve|approve it|approve draft|i approve)$/.test(norm)) return result('gmail.approve');
  if (/^(?:reject|reject it|decline)$/.test(norm)) return result('gmail.reject');
  if (isDraftCommand(norm) && !isKnowledgeRequest(norm)) return result('gmail.draft');
  const selection = parseMessageSelection(utterance);
  if (selection !== null && isMailboxActionCommand(norm)) return result('gmail.select', { index: String(selection) });

  if (/^(?:bye|goodbye|hang up|end call)$/.test(norm)) return result('session.end');
  if (isRepeatRequest(norm)) return result('session.repeat');

  // Read domains, in the same precedence the voice conversation uses.
  if (isKnowledgeRequest(norm)) return result('knowledge.query');
  const profiles = emailProfiles(opts.email);
  if (isEmailReadRequest(norm, profiles)) return result('gmail.inbox', {}, parseInboxSelection(norm, profiles));
  if (isReturnToInboxRequest(norm)) return result('session.return');
  const route = routeReadDomain(norm);
  if (route === 'calendar' || (route === null && isCalendarRequest(norm))) {
    const selection = opts.calendarProfiles ? parseCalendarSelection(norm, opts.calendarProfiles) : null;
    const scope = selection === 'all' || Array.isArray(selection) ? selection : null;
    if (CONFLICT_INTENT.test(norm)) return result('calendar.conflicts', {}, scope);
    if (/\b(?:free|available|availability|open|busy)\b/.test(norm)) return result('calendar.availability', {}, scope);
    return result('calendar.schedule', {}, scope);
  }
  if (route === 'photo_booth') return result('photobooth.analytics');
  return result('unknown', {}, null, 'deterministic', 0);
}

/**
 * Deterministic first. Only if nothing matched, an optional resolver may suggest a
 * read-only intent; anything outside MODEL_ASSIST_ALLOWED (or low confidence) is ignored.
 */
export async function routeIntent(utterance: string, opts: RouterOptions & { resolver?: AmbiguityResolver; minConfidence?: number } = {}): Promise<IntentResult> {
  const deterministic = routeIntentDeterministic(utterance, opts);
  if (deterministic.intent !== 'unknown' || !opts.resolver) return deterministic;
  let suggestion: Awaited<ReturnType<AmbiguityResolver>> = null;
  try {
    suggestion = await opts.resolver(utterance);
  } catch {
    return deterministic;
  }
  if (!suggestion || !MODEL_ASSIST_ALLOWED.includes(suggestion.intent) || suggestion.confidence < (opts.minConfidence ?? 0.7)) return deterministic;
  return result(suggestion.intent, {}, null, 'model_assisted', suggestion.confidence);
}
