import type { VoiceSession } from '../voice/types.js';
import { redact } from './trace.js';
import type { Channel, SessionContext } from './types.js';

/**
 * Builds the harness SessionContext from channel state. Copies only what cognition needs:
 * domain, scopes, the bound action identity and confirmation state. Never message bodies,
 * inbox lists, tokens or phone numbers.
 */
export function sessionContextFromVoice(
  session: VoiceSession,
  opts: { organizationId: string; timeZone?: string; now?: Date; channel?: Channel }
): SessionContext {
  const m = session.metadata ?? {};
  const selection = (v: unknown): 'all' | string[] | null => (v === 'all' ? 'all' : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null);
  const boundActionId = typeof m.boundActionId === 'string' ? m.boundActionId : null;
  return {
    sessionId: session.sessionId,
    organizationId: opts.organizationId,
    channel: opts.channel ?? 'voice',
    domain: session.conversationState,
    scope: {
      calendar: selection((m.calendar as { selection?: unknown } | undefined)?.selection),
      inbox: selection((m.inboxRead as { selection?: unknown } | undefined)?.selection),
    },
    boundAction: boundActionId ? { actionId: boundActionId, draftId: typeof m.draftId === 'string' ? m.draftId : null } : null,
    awaitingConfirmation:
      session.conversationState === 'AWAITING_APPROVAL_CONFIRMATION' ? 'approval' : session.conversationState === 'AWAITING_REJECTION_CONFIRMATION' ? 'rejection' : null,
    lastSafeResponse: session.lastSpokenText ? redact(session.lastSpokenText, 300) : null,
    now: (opts.now ?? new Date()).toISOString(),
    timeZone: opts.timeZone ?? process.env.PHRO_TIMEZONE?.trim() ?? 'America/Los_Angeles',
    memoryRefs: [],
  };
}

/** A fresh, empty session context (CLI / API callers without channel state). */
export function emptySessionContext(sessionId: string, organizationId: string, channel: Channel): SessionContext {
  return {
    sessionId,
    organizationId,
    channel,
    domain: 'NONE',
    scope: { calendar: null, inbox: null },
    boundAction: null,
    awaitingConfirmation: null,
    lastSafeResponse: null,
    now: new Date().toISOString(),
    timeZone: process.env.PHRO_TIMEZONE?.trim() || 'America/Los_Angeles',
    memoryRefs: [],
  };
}
