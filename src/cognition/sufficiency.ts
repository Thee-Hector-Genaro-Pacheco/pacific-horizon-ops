import type { EvidenceItem } from './context.js';

/**
 * Evidence-sufficiency gate, reusable by RAG, memory and future decision systems.
 *
 * A definite answer is allowed only when the evidence DIRECTLY SUPPORTS it. Related
 * context and silence are not support: "the documents don't mention X" is never turned
 * into "X is prohibited" or "X is allowed".
 *
 * The gate is structural, not a longer prompt:
 *   1. Claim grounding: every claim carries an evidence ID and a quote; the quote must
 *      appear verbatim in that evidence (no paraphrased or invented support).
 *   2. Topic anchoring: the supporting quotes must address the question's own subject
 *      terms (action/object), not just shared names like "Pacific Ops". A small synonym
 *      map keeps legitimate synonyms working.
 *   3. Independent verification: a separate check sees only the question and the quotes
 *      (not the drafted answer) and must confirm they directly establish the answer.
 * Only evidence behind claims that pass is cited.
 */

export type SupportVerdict = 'supported' | 'insufficient';

export interface ClaimDraft {
  claim: string;
  evidenceId: string;
  quote: string;
}

export interface SufficiencyInput {
  question: string;
  evidence: EvidenceItem[];
  /** The answerer's own verdict and claims. */
  verdict: unknown;
  claims: unknown;
}

export interface SufficiencyResult {
  verdict: SupportVerdict;
  /** Machine-readable reason for audit/logging. */
  reason:
    | 'supported'
    | 'answerer_insufficient'
    | 'no_claims'
    | 'unknown_evidence'
    | 'quote_not_in_evidence'
    | 'off_topic_support'
    | 'verifier_rejected';
  /** Evidence that materially supports the answer (empty unless supported). */
  supporting: EvidenceItem[];
  claims: ClaimDraft[];
}

/** Independent check: do these quotes directly establish an answer to the question? */
export type SupportVerifier = (question: string, quotes: string[]) => Promise<boolean>;

const MIN_QUOTE = 12;

/** Agent/organization names and question scaffolding: shared with almost any evidence, so never anchors. */
const NON_ANCHOR = new Set([
  'pacific', 'rising', 'horizon', 'labs', 'ops', 'operations', 'phro', 'company', 'business', 'we', 'our', 'us', 'you', 'your', 'i', 'my',
  'can', 'could', 'may', 'might', 'should', 'would', 'will', 'shall', 'must', 'do', 'does', 'did', 'is', 'are', 'was', 'were', 'be', 'been', 'have', 'has', 'had',
  'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how', 'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'by', 'with', 'about', 'from', 'into', 'it', 'its',
  'any', 'there', 'this', 'that', 'these', 'those', 'policy', 'policies', 'rule', 'rules', 'documentation', 'docs', 'say', 'says', 'know', 'tell', 'me', 'allowed', 'permitted', 'able',
  'automatically', 'ever', 'also', 'just', 'only', 'really', 'yes', 'no', 'not', 'without', 'need', 'needs', 'get', 'got',
]);

/** Small business-vocabulary synonym groups (stems). Extend deliberately, not by inference. */
const SYNONYM_GROUPS: string[][] = [
  ['guest', 'attende', 'visitor', 'customer', 'client'],
  ['pay', 'charg', 'fee', 'cost', 'price', 'pric', 'bill', 'paid'],
  ['refund', 'refundabl', 'returnabl', 'reimburs', 'money back'],
  ['deposit', 'retainer', 'down payment'],
  ['email', 'messag', 'repli', 'reply', 'communic', 'draft'],
  ['send', 'sent', 'deliv'],
  ['approv', 'authoriz', 'permiss', 'consent'],
  ['sponsor', 'promot', 'promo'],
  ['event', 'gig', 'party', 'parti', 'booking'],
  ['galler', 'photo', 'pictur', 'media'],
  ['area', 'counti', 'region', 'cover', 'coverag', 'travel'],
  ['hour', 'open', 'schedul'],
  ['contract', 'agreement'],
];

/** Crude, deterministic English stemmer (enough for anchoring, not linguistics). */
export function stem(word: string): string {
  let w = word.toLowerCase();
  for (const suffix of ['ations', 'ation', 'ingly', 'ings', 'ing', 'edly', 'ed', 'ies', 'es', 's', 'ly', 'ion']) {
    if (w.length > suffix.length + 3 && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  return w.replace(/(.)\1$/, '$1');
}

function terms(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z'-]*/g) ?? []).map((t) => t.replace(/'s$|'/g, ''));
}

/** Subject terms of a question: content words minus agent/organization names and scaffolding. */
export function subjectTerms(question: string): string[] {
  return [...new Set(terms(question).filter((t) => t.length > 2 && !NON_ANCHOR.has(t)).map(stem))];
}

function group(stemmed: string): string[] {
  const g = SYNONYM_GROUPS.find((members) => members.some((m) => stemmed.startsWith(m) || m.startsWith(stemmed)));
  return g ?? [stemmed];
}

/** True when some question subject term (or a listed synonym) appears in the support text. */
export function anchorsQuestion(question: string, support: string): boolean {
  const subject = subjectTerms(question);
  if (subject.length === 0) return false;
  const supportStems = terms(support)
    .filter((t) => t.length > 2 && !NON_ANCHOR.has(t))
    .map(stem);
  const supportText = support.toLowerCase();
  return subject.some((s) =>
    group(s).some((alt) => (alt.includes(' ') ? supportText.includes(alt) : supportStems.some((x) => x.startsWith(alt) || alt.startsWith(x))))
  );
}

function normalizeQuote(s: string): string {
  return s.toLowerCase().replace(/[“”"']/g, '').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
}

function parseClaims(raw: unknown): ClaimDraft[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((c) => c as { claim?: unknown; evidence?: unknown; evidenceId?: unknown; quote?: unknown })
    .map((c) => ({
      claim: typeof c.claim === 'string' ? c.claim.trim() : '',
      evidenceId: typeof c.evidenceId === 'string' ? c.evidenceId : Array.isArray(c.evidence) && typeof c.evidence[0] === 'string' ? c.evidence[0] : '',
      quote: typeof c.quote === 'string' ? c.quote.trim() : '',
    }))
    .filter((c) => c.claim || c.quote);
}

/** Runs the gate. Never throws for bad model output: anything malformed is insufficient. */
export async function assessEvidenceSufficiency(input: SufficiencyInput, verify: SupportVerifier): Promise<SufficiencyResult> {
  const claims = parseClaims(input.claims);
  const insufficient = (reason: SufficiencyResult['reason']): SufficiencyResult => ({ verdict: 'insufficient', reason, supporting: [], claims });
  if (input.verdict !== 'supported') return insufficient('answerer_insufficient');
  if (claims.length === 0) return insufficient('no_claims');

  const byId = new Map(input.evidence.map((e) => [e.id, e]));
  for (const c of claims) {
    const ev = byId.get(c.evidenceId);
    if (!ev) return insufficient('unknown_evidence');
    if (c.quote.length < MIN_QUOTE || !normalizeQuote(ev.excerpt).includes(normalizeQuote(c.quote))) return insufficient('quote_not_in_evidence');
  }
  const quotes = [...new Set(claims.map((c) => c.quote))];
  if (!anchorsQuestion(input.question, quotes.join(' '))) return insufficient('off_topic_support');
  if (!(await verify(input.question, quotes))) return insufficient('verifier_rejected');

  const supporting = [...new Set(claims.map((c) => c.evidenceId))].map((id) => byId.get(id)!);
  return { verdict: 'supported', reason: 'supported', supporting, claims };
}
