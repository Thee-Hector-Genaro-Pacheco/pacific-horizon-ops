import { normalizeUtterance } from '../voice/analytics.js';
import { CONFLICT_INTENT } from '../voice/calendar.js';
import { ACTION_TERMS } from './canonicalize.js';
import type { IntentName } from './types.js';

/**
 * Narrow follow-up resolver. An utterance the router could not classify inherits the
 * active read domain ONLY when it matches that domain's bounded follow-up grammar
 * ("What about tomorrow?", "Read the second one.", "What about digital delivery?").
 * Everything else ("Thank you.", "No.", ASR fragments, unrelated questions) resolves to
 * an acknowledgement or a clarification with no tool. Unknown never means "run the last
 * tool again".
 *
 * Inheritance is read-only by construction: the resolver can only return read intents,
 * and any utterance naming an action (approve, send, delete, schedule, trade, ...) is
 * never inherited. Lifecycle commands keep their exact deterministic rules elsewhere.
 */

export type ReadDomainState = 'CALENDAR' | 'KNOWLEDGE' | 'EMAIL_READ' | 'PHOTO_BOOTH_ANALYTICS';

export type FollowUpResolution =
  | { kind: 'read'; intent: IntentName; toolId: string; inheritedDomain: ReadDomainState; reason: string }
  | { kind: 'acknowledgement'; reason: string }
  | { kind: 'clarify'; reason: string };

/** Safe, display-only record of why a follow-up inherited a domain (for traces). */
export interface FollowUpTrace {
  inheritedDomain: string;
  inheritedIntent: IntentName;
  reason: string;
}

const ACKNOWLEDGEMENT =
  /^(?:(?:ok|okay|alright|all right|cool|great|perfect|nice|good|awesome|got it|understood|sounds good|all good|that's all|thats all|that's it|thats it|nothing|nothing else|never mind|nevermind|no|nope|no thanks|no thank you|yes|yeah|yep|yup|sure|hmm|mhm|uh huh|thank you|thanks|thank you so much|thanks a lot|appreciate it)[\s,]*)+$/;
const THANKS = /\b(?:thank|thanks|appreciate)\b/;

const DAY = /\b(?:today|tonight|tomorrow|yesterday|weekend|this week|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|after that|before that)\b/;
const ORDINAL_REF = /\b(?:first|second|third|1st|2nd|3rd|last|next|previous|that|this|it)(?: one| event| email| message)?\b/;
const FREE_BUSY = /\b(?:free|available|availability|busy|open)\b/;
const CALENDAR_SCOPE = /\b(?:check|now check|look at|include)\b.*\b(?:everything|all|business|personal|work|both)\b/;
const CALENDAR_DETAIL = /\b(?:what time|when|where|how long|start|starts|end|ends|location)\b/;

const EMAIL_READ_VERB = /^(?:please )?(?:read|open|summari[sz]e|what does|what did|what's in|whats in|tell me about)\b/;
const EMAIL_WHO = /^who (?:sent|wrote|is) (?:that|it|this|the (?:first|second|third|last|next) one)\b/;

const BOOTH_TERMS =
  /\b(?:downloads?|sessions?|photos?|prints?|shares?|instagram|reviews?|feedback|ratings?|deliver(?:y|ies)|qr|guests?|attendance|compare|comparison|previous event|last event|that event|the booth|how many|how much|how did|problems?|issues?|errors?|failures?|sms|texts?)\b/;

const FOLLOW_UP_ABOUT = /^(?:and |so |ok |okay |now )?(?:what|how) about (.+)$/;
const PROVENANCE = /\b(?:where does it say|where did (?:that|it) come from|which (?:document|doc|source)|what(?:'s| is) the source|source for that|what document)\b/;

const FILLER = new Set('uh um er ah like so well okay ok yeah hey please just thing things stuff the a an our that this it about what is are'.split(' '));

const words = (s: string) => s.match(/[a-z0-9']+/g) ?? [];

export function resolveFollowUp(utterance: string, domain: ReadDomainState): FollowUpResolution {
  const norm = normalizeUtterance(utterance);
  if (!norm) return { kind: 'clarify', reason: 'empty' };
  if (ACKNOWLEDGEMENT.test(norm)) return { kind: 'acknowledgement', reason: THANKS.test(norm) ? 'thanks' : 'acknowledgement' };
  const read = (intent: IntentName, toolId: string, reason: string): FollowUpResolution => ({ kind: 'read', intent, toolId, inheritedDomain: domain, reason });
  // "Who sent that?" asks about a past send; it is a read, checked before the action guard.
  if (domain === 'EMAIL_READ' && EMAIL_WHO.test(norm)) return read('gmail.inbox', 'gmail.read', 'sender_follow_up');
  // Actions are never inherited from a read context.
  if (ACTION_TERMS.test(norm)) return { kind: 'clarify', reason: 'action_not_inherited' };

  const n = words(norm).length;

  switch (domain) {
    case 'CALENDAR': {
      if (CONFLICT_INTENT.test(norm)) return read('calendar.conflicts', 'calendar.conflicts', 'conflict_follow_up');
      if (FREE_BUSY.test(norm) && n <= 12) return read('calendar.availability', 'calendar.read', 'availability_follow_up');
      if (DAY.test(norm) && n <= 8) return read('calendar.schedule', 'calendar.read', 'day_follow_up');
      if (CALENDAR_SCOPE.test(norm)) return read('calendar.schedule', 'calendar.read', 'scope_follow_up');
      if (CALENDAR_DETAIL.test(norm) && ORDINAL_REF.test(norm) && n <= 10) return read('calendar.schedule', 'calendar.read', 'event_detail_follow_up');
      break;
    }
    case 'EMAIL_READ': {
      if (EMAIL_READ_VERB.test(norm) && ORDINAL_REF.test(norm) && n <= 8) return read('gmail.inbox', 'gmail.read', 'message_follow_up');
      if (/^(?:the )?(?:first|second|third|last|next) one$/.test(norm)) return read('gmail.inbox', 'gmail.read', 'message_follow_up');
      break;
    }
    case 'KNOWLEDGE': {
      if (PROVENANCE.test(norm)) return read('knowledge.query', 'knowledge.provenance', 'provenance_follow_up');
      const about = FOLLOW_UP_ABOUT.exec(norm);
      if (about && words(about[1]).some((w) => !FILLER.has(w))) return read('knowledge.query', 'knowledge.search', 'topic_follow_up');
      break;
    }
    case 'PHOTO_BOOTH_ANALYTICS': {
      const about = FOLLOW_UP_ABOUT.exec(norm);
      if (BOOTH_TERMS.test(norm) && n <= 12) return read('photobooth.analytics', 'photobooth.analytics', 'metric_follow_up');
      if (about && words(about[1]).some((w) => !FILLER.has(w)) && n <= 6) return read('photobooth.analytics', 'photobooth.analytics', 'topic_follow_up');
      break;
    }
  }
  return { kind: 'clarify', reason: 'no_resolvable_referent' };
}

export function followUpTrace(r: Extract<FollowUpResolution, { kind: 'read' }>): FollowUpTrace {
  return { inheritedDomain: r.inheritedDomain, inheritedIntent: r.intent, reason: r.reason };
}
