import { inboxSourcesFromRegistry, readInboxes, type InboxItem, type InboxSource } from '../google/gmailRead.js';
import { BUSINESS_PROFILE_ID, loadGoogleProfiles } from '../google/profiles.js';
import { joinLabels } from '../calendar/speech.js';

/**
 * Read-only multi-inbox voice domain (EMAIL_READ). The interactive business mailbox
 * (select, draft, approve, send) is untouched; this domain only lists and reads, and
 * never drafts from any account.
 */

export interface EmailVoiceDeps {
  /** Every inbox Pacific Ops may read. Defaults to the Google profile registry. */
  sources?: InboxSource[];
}

export type InboxSelection = 'all' | string[];

/** Minimal context: scope and the spoken items' display fields. No bodies, no addresses. */
export interface EmailVoiceContext {
  selection: InboxSelection;
  items: Array<Pick<InboxItem, 'key' | 'profileId' | 'profileLabel' | 'senderName' | 'subject' | 'internalDate' | 'snippet'>>;
  focusIndex: number | null;
}

export const EMAIL_PROGRESS_TEXT = 'One moment, checking your inboxes.';
export const READ_ONLY_DRAFT_TEXT = "That account is connected read-only, so I can't draft from it.";
export const BUSINESS_DRAFT_GUIDANCE =
  'To reply from your business account, say "go back to my business inbox" and pick that message there.';
export const EMAIL_READ_HELP =
  'You can ask me to check all your inboxes or one account\'s inbox, or say "read the second one". Say "go back to my business inbox" to return to drafting and approvals.';
export const EMAIL_MAILBOX_COMMAND_GUIDANCE =
  'This is a read-only inbox check. Say "go back to my business inbox" to select, draft, or approve emails.';

const MAX_SPOKEN = 3;
const ORDINALS: Record<string, number> = { first: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2, last: -1 };

export interface ProfileRef {
  id: string;
  label: string;
}

/** Gmail-readable profiles: from injected sources, else the registry (business only if it can't load). */
export function emailProfiles(deps: EmailVoiceDeps = {}): ProfileRef[] {
  if (deps.sources) return deps.sources.map((s) => ({ id: s.profileId, label: s.label }));
  try {
    return loadGoogleProfiles().withCapability('gmail.read').map((p) => ({ id: p.id, label: p.label }));
  } catch {
    return [{ id: BUSINESS_PROFILE_ID, label: 'Business' }];
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseInboxSelection(norm: string, profiles: ProfileRef[]): InboxSelection | null {
  if (
    /\b(?:all|every|both)\b(?: of)?(?: my| the)? (?:inboxes|inbox|e-?mails?|email accounts|mail|accounts)\b|\bacross (?:all )?(?:my )?(?:e-?mails?|inboxes|email accounts|accounts)\b|\bwhat'?s new across\b/.test(
      norm
    )
  ) {
    return 'all';
  }
  const named = profiles.filter((p) =>
    new RegExp(`\\b(?:${escapeRe(p.id)}|${escapeRe(p.label.toLowerCase())}) (?:inbox|inboxes|e-?mails?|mail|gmail)\\b`).test(norm)
  );
  return named.length > 0 ? named.map((p) => p.id) : null;
}

/**
 * Multi-inbox read requests: "all inboxes" or any non-business account. Business-only
 * phrasing ("my business inbox") stays with the existing interactive mailbox.
 */
export function isEmailReadRequest(norm: string, profiles: ProfileRef[]): boolean {
  const sel = parseInboxSelection(norm, profiles);
  if (sel === null) return false;
  if (sel === 'all') return true;
  return sel.some((id) => id !== BUSINESS_PROFILE_ID);
}

export function isDraftCommand(norm: string): boolean {
  return /\b(?:draft|reply|respond|write back|answer it)\b/.test(norm);
}

/** The read-only refusal for drafting from the focused item, never switching accounts silently. */
export function draftRefusalFor(context: EmailVoiceContext | null): string {
  const item = context?.items[context.focusIndex ?? 0];
  if (item && item.profileId === BUSINESS_PROFILE_ID) return BUSINESS_DRAFT_GUIDANCE;
  return READ_ONLY_DRAFT_TEXT;
}

export interface EmailVoiceResult {
  text: string;
  ok: boolean;
  context: EmailVoiceContext | null;
  outcome: string;
  scopeLabel: string;
  /** Number of providers queried (0 for context-only answers). */
  reads: number;
}

function failureText(kind: string, label: string | null): string {
  const which = label ? `your ${label.toLowerCase()} inbox` : 'your inboxes';
  switch (kind) {
    case 'missing_scope':
      return `I don't have permission to read ${which} yet.`;
    case 'unauthorized':
      return `I can't authenticate with ${which} right now.`;
    case 'malformed_response':
      return `I couldn't safely interpret the response from ${which}.`;
    default:
      return `I couldn't check ${which} right now.`;
  }
}

function describeItem(i: InboxItem | EmailVoiceContext['items'][number], withSource: boolean): string {
  const src = withSource ? ` in ${i.profileLabel.toLowerCase()}` : '';
  return `from ${i.senderName} about "${i.subject}"${src}`;
}

export async function answerEmailQuestion(
  utterance: string,
  context: EmailVoiceContext | null,
  deps: EmailVoiceDeps = {}
): Promise<EmailVoiceResult> {
  const norm = utterance.toLowerCase().replace(/[.,!?;:]/g, '').replace(/\s+/g, ' ').trim();
  const profiles = emailProfiles(deps);
  const parsed = parseInboxSelection(norm, profiles);
  const selection: InboxSelection = parsed ?? context?.selection ?? 'all';

  // "Read the second one" from context, no provider call.
  const ordinal = /\b(first|second|third|1st|2nd|3rd|last)\b/.exec(norm);
  if (ordinal && !parsed && context?.items.length) {
    const raw = ORDINALS[ordinal[1]];
    const idx = raw === -1 ? context.items.length - 1 : raw;
    const item = context.items[idx];
    if (!item) {
      return { text: `I only read ${context.items.length} messages.`, ok: true, context, outcome: 'item_missing', scopeLabel: '', reads: 0 };
    }
    const snippet = item.snippet ? ` It says: ${item.snippet}` : '';
    return {
      text: `That one is ${describeItem(item, true)}.${snippet}`,
      ok: true,
      context: { ...context, focusIndex: idx },
      outcome: 'item',
      scopeLabel: '',
      reads: 0,
    };
  }

  let all: InboxSource[];
  try {
    all = deps.sources ?? inboxSourcesFromRegistry('all');
  } catch {
    return { text: failureText('config', null), ok: false, context: null, outcome: 'config', scopeLabel: '', reads: 0 };
  }
  const selected = selection === 'all' ? all : all.filter((s) => selection.includes(s.profileId));
  const labels = selected.map((s) => s.label);
  const scopeLabel = selection === 'all' && all.length > 1 ? 'All inboxes' : labels.join(' + ');
  if (selected.length === 0) {
    return { text: "I don't have that inbox connected.", ok: true, context, outcome: 'unknown_inbox', scopeLabel, reads: 0 };
  }

  const importantOnly = /\bimportant\b/.test(norm);
  const agg = await readInboxes(selected, { max: 5 });
  if (agg.status === 'failed') {
    const f = agg.failed[0];
    return { text: failureText(f.kind, agg.failed.length === 1 ? f.label : null), ok: false, context: null, outcome: `failed:${f.kind}`, scopeLabel, reads: selected.length };
  }

  const items = importantOnly ? agg.items.filter((i) => i.important) : agg.items;
  const multi = selected.length > 1;
  const where = multi ? `Across your ${joinLabels(agg.checked.map((l) => l.toLowerCase()))} inboxes` : `In your ${labels[0].toLowerCase()} inbox`;
  let text: string;
  if (items.length === 0) {
    text = importantOnly ? `${where}, nothing recent is marked important.` : `${where}, there are no recent messages.`;
  } else {
    const spoken = items.slice(0, MAX_SPOKEN).map((i) => describeItem(i, multi));
    const lead = importantOnly ? 'the latest important messages are' : `the latest ${spoken.length === 1 ? 'message is' : 'messages are'}`;
    text = `${where}, ${lead} ${joinLabels(spoken)}.`;
  }
  if (agg.status === 'partial') {
    const failed = agg.failed.map((f) => f.label.toLowerCase());
    text += ` I couldn't check your ${joinLabels(failed)} inbox${failed.length > 1 ? 'es' : ''}.`;
  }

  const ctx: EmailVoiceContext = {
    selection,
    items: items.slice(0, MAX_SPOKEN).map(({ key, profileId, profileLabel, senderName, subject, internalDate, snippet }) => ({
      key,
      profileId,
      profileLabel,
      senderName,
      subject,
      internalDate,
      snippet,
    })),
    focusIndex: null,
  };
  return { text, ok: true, context: ctx, outcome: `read:${agg.status}`, scopeLabel, reads: selected.length };
}
