import { DEFAULT_ORGANIZATION_ID, KnowledgeError, createPgDb, loadKnowledgeDbConfig, type SqlDb } from '../knowledge/db.js';
import { createEmbeddingProvider } from '../knowledge/embeddings.js';
import { INSUFFICIENT_KNOWLEDGE, askKnowledge, type GroundedAnswer } from '../knowledge/grounding.js';
import { consoleKnowledgeLogger } from '../knowledge/log.js';
import { migrate } from '../knowledge/migrations.js';
import type { QueryRewriter } from '../agent/canonicalize.js';

/**
 * Read-only company-knowledge questions for Pacific Ops voice. Answers come only from
 * retrieved evidence through the shared grounding contract; nothing here can draft, send,
 * approve, schedule or call a tool.
 */

export interface KnowledgeVoiceDeps {
  /** Injected in tests; defaults to the configured knowledge store + Anthropic. */
  answer?: (question: string) => Promise<GroundedAnswer>;
  /**
   * Read-only transcript rewriter. undefined: the model-backed default when the live
   * store is used (never with an injected answerer); null: deterministic rules only.
   */
  rewrite?: QueryRewriter | null;
}

export interface KnowledgeVoiceContext {
  lastQuestion: string;
  /** Display-safe provenance of the last answer (no database IDs). */
  citations: Array<{ title: string; section: string | null; sourceLabel: string }>;
}

export const KNOWLEDGE_PROGRESS_TEXT = 'One moment, checking company knowledge.';
export const KNOWLEDGE_UNAVAILABLE = "Company knowledge isn't available right now.";
export const KNOWLEDGE_VOICE_HELP =
  'You can ask what our policy or documentation says about something, for example sponsored events or digital delivery. Say "go back to my inbox" to return to your emails.';
export const KNOWLEDGE_MAILBOX_COMMAND_GUIDANCE =
  'We are on company knowledge right now. Say "go back to my inbox" to return to your emails first.';

const KNOWLEDGE_PATTERNS: RegExp[] = [
  /\b(?:our|company|the company'?s) (?:policy|policies|documentation|docs|guidelines|rules|procedures?|process|handbook|playbook|manual)\b/,
  /\bwhat does (?:our|the) (?:documentation|docs|handbook|manual|playbook|policy) say\b/,
  /\bwhat do we know about\b/,
  /\b(?:knowledge base|company knowledge|stored knowledge)\b/,
  /\baccording to (?:our|the) (?:docs|documentation|policy|policies|handbook)\b/,
];

/** Mailbox words: "the email about the privacy policy" stays with the mailbox. */
const MAILBOX_ANCHORS = /\b(?:e-?mails?|messages?|inbox|mailbox|drafts?|reply|replies|sender)\b/;

/**
 * Questions about what Pacific Ops / the AI is allowed to do on its own are company-policy
 * questions ("Should AI have signed a lease for the company on its own?"). Read-only:
 * grounding decides whether stored knowledge actually answers them.
 */
const AUTHORITY_QUESTION =
  /^(?:can|could|should|would|is|are|may|does|do|did)\b.*\b(?:pacific ops|the ai|ai|the agent|the assistant)\b.*\b(?:on its own|by itself|automatically|without (?:my |the owner'?s? |owner )?(?:approval|permission)|allowed to|permitted to|authori[sz]ed to)\b/;

export function isKnowledgeRequest(norm: string): boolean {
  if (KNOWLEDGE_PATTERNS.some((p) => p.test(norm))) return true;
  if (AUTHORITY_QUESTION.test(norm)) return true;
  // "What is our sponsored event policy?", "What's the cancellation policy?"
  return /\b(?:policy|policies)\b/.test(norm) && !MAILBOX_ANCHORS.test(norm);
}

let shared: { db: SqlDb; ready: Promise<unknown> } | null = null;

async function defaultAnswer(question: string): Promise<GroundedAnswer> {
  if (!shared) {
    const db = createPgDb(loadKnowledgeDbConfig());
    shared = { db, ready: migrate(db) };
  }
  try {
    await shared.ready;
  } catch (err) {
    shared = null;
    throw err;
  }
  return askKnowledge(question, {
    db: shared.db,
    embedder: createEmbeddingProvider(),
    organizationId: process.env.PHRO_ORGANIZATION_ID?.trim() || DEFAULT_ORGANIZATION_ID,
    style: 'voice',
    logger: consoleKnowledgeLogger,
  });
}

export interface KnowledgeVoiceResult {
  text: string;
  ok: boolean;
  context: KnowledgeVoiceContext | null;
  outcome: string;
}

function lowerFirst(s: string): string {
  return /^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

/** Never throws. Unavailable stores and missing evidence are spoken as such. */
export async function answerKnowledgeForVoice(question: string, deps: KnowledgeVoiceDeps = {}): Promise<KnowledgeVoiceResult> {
  let result: GroundedAnswer;
  try {
    result = await (deps.answer ?? defaultAnswer)(question);
  } catch (err) {
    const kind = err instanceof KnowledgeError ? err.kind : 'error';
    console.warn(`[voice:knowledge] Knowledge answer failed (${kind}).`);
    return { text: KNOWLEDGE_UNAVAILABLE, ok: false, context: null, outcome: `unavailable:${kind}` };
  }
  if (result.status === 'unavailable') return { text: KNOWLEDGE_UNAVAILABLE, ok: false, context: null, outcome: 'unavailable' };
  if (result.status !== 'answered' || result.citations.length === 0) {
    return { text: INSUFFICIENT_KNOWLEDGE, ok: true, context: { lastQuestion: question, citations: [] }, outcome: 'insufficient' };
  }
  const titles = [...new Set(result.citations.map((c) => c.title))];
  const from = titles.length === 1 ? ` That's from ${titles[0]}.` : ` That's from ${titles.slice(0, -1).join(', ')} and ${titles[titles.length - 1]}.`;
  const answer = result.answer.replace(/\s+/g, ' ').trim();
  return {
    text: `According to stored company knowledge, ${lowerFirst(answer)}${/[.!?]$/.test(answer) ? '' : '.'}${from}`,
    ok: true,
    context: { lastQuestion: question, citations: result.citations.map((c) => ({ title: c.title, section: c.section, sourceLabel: c.sourceLabel })) },
    outcome: `answered:${result.citations.length}`,
  };
}
