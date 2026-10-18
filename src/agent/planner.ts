import type { ContextPlan, IntentName, IntentResult, SessionContext } from './types.js';

/**
 * Context planner: decides which providers a request actually needs, so nothing fetches
 * every source for every question. Availability and conflict questions demand complete
 * coverage: any provider gap must surface as "incomplete", never as a clean answer.
 */

const PLANS: Partial<Record<IntentName, Omit<ContextPlan, 'accountScope' | 'timeWindow'>>> = {
  'knowledge.query': { providers: ['knowledge'], limits: { maxEvidence: 5 }, requiredCompleteness: 'best_effort' },
  'calendar.schedule': { providers: ['calendar'], limits: { maxEvidence: 10 }, requiredCompleteness: 'best_effort' },
  'calendar.availability': { providers: ['calendar'], limits: { maxEvidence: 10 }, requiredCompleteness: 'all_sources' },
  'calendar.conflicts': { providers: ['calendar'], limits: { maxEvidence: 10 }, requiredCompleteness: 'all_sources' },
  'gmail.inbox': { providers: ['gmail'], limits: { maxEvidence: 5 }, requiredCompleteness: 'best_effort' },
  'photobooth.analytics': { providers: ['photo_booth'], limits: { maxEvidence: 1 }, requiredCompleteness: 'best_effort' },
};

/** Tool that answers each read intent. Mailbox lifecycle intents have no harness tool on purpose. */
export const READ_TOOL_FOR_INTENT: Partial<Record<IntentName, string>> = {
  'knowledge.query': 'knowledge.search',
  'calendar.schedule': 'calendar.read',
  'calendar.availability': 'calendar.read',
  'calendar.conflicts': 'calendar.conflicts',
  'gmail.inbox': 'gmail.read',
  'photobooth.analytics': 'photobooth.analytics',
};

/** Tools a lifecycle intent would involve (classified for traces/inspect; executed by legacy flows). */
export const LIFECYCLE_TOOLS_FOR_INTENT: Partial<Record<IntentName, string[]>> = {
  'gmail.draft': ['gmail.prepareDraft'],
  'gmail.approve': ['gmail.sendApprovedDraft'],
  'gmail.confirm': ['gmail.sendApprovedDraft'],
};

export function planContext(intent: IntentResult, session: SessionContext): ContextPlan {
  const base = PLANS[intent.intent];
  if (!base) return { providers: [], limits: { maxEvidence: 0 }, timeWindow: null, accountScope: null, requiredCompleteness: 'best_effort' };
  const sessionScope = intent.domain === 'calendar' ? session.scope.calendar : intent.domain === 'gmail' ? session.scope.inbox : null;
  return {
    ...base,
    providers: [...base.providers],
    timeWindow: intent.entities.timeWindow ?? null,
    accountScope: intent.requestedScope ?? sessionScope ?? (intent.domain === 'calendar' || intent.domain === 'gmail' ? 'all' : null),
  };
}
