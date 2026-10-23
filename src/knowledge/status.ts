import type { SqlDb } from './db.js';
import type { EmbeddingProvider } from './embeddings.js';
import type { RetrievalResult } from './retrieval.js';

export interface KnowledgeStatus {
  database: 'online';
  organizationId: string;
  sources: number;
  documents: number;
  chunks: number;
  chunksWithVectors: number;
  embedding: { model: string; dimension: number } | null;
  lastIngestion: {
    status: string;
    startedAt: string;
    completedAt: string | null;
    documentsChanged: number;
    documentsUnchanged: number;
    chunksWritten: number;
    errorCount: number;
  } | null;
  recentQueries: Array<{ query: string; mode: string; resultCount: number; latencyMs: number; at: string }>;
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

export async function knowledgeStatus(db: SqlDb, organizationId: string, embedder: EmbeddingProvider | null): Promise<KnowledgeStatus> {
  const counts = await db.query<{ sources: number; documents: number; chunks: number; vectors: number }>(
    `SELECT
       (SELECT count(*) FROM knowledge_sources WHERE organization_id = $1)::int AS sources,
       (SELECT count(*) FROM knowledge_documents WHERE organization_id = $1 AND active)::int AS documents,
       (SELECT count(*) FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id AND d.active WHERE c.organization_id = $1)::int AS chunks,
       (SELECT count(*) FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id AND d.active WHERE c.organization_id = $1 AND c.embedding IS NOT NULL)::int AS vectors`,
    [organizationId]
  );
  const run = await db.query<{ status: string; started_at: unknown; completed_at: unknown; documents_changed: number; documents_unchanged: number; chunks_written: number; errors: unknown[] }>(
    `SELECT status, started_at, completed_at, documents_changed, documents_unchanged, chunks_written, errors
     FROM ingestion_runs WHERE organization_id = $1 ORDER BY started_at DESC LIMIT 1`,
    [organizationId]
  );
  const queries = await db.query<{ query: string; mode: string; result_count: number; latency_ms: number; created_at: unknown }>(
    `SELECT query, mode, result_count, latency_ms, created_at FROM knowledge_queries WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 10`,
    [organizationId]
  );
  const c = counts.rows[0];
  const r = run.rows[0];
  return {
    database: 'online',
    organizationId,
    sources: Number(c.sources),
    documents: Number(c.documents),
    chunks: Number(c.chunks),
    chunksWithVectors: Number(c.vectors),
    embedding: embedder ? { model: embedder.model, dimension: embedder.dimension } : null,
    lastIngestion: r
      ? {
          status: r.status,
          startedAt: iso(r.started_at),
          completedAt: r.completed_at ? iso(r.completed_at) : null,
          documentsChanged: Number(r.documents_changed),
          documentsUnchanged: Number(r.documents_unchanged),
          chunksWritten: Number(r.chunks_written),
          errorCount: Array.isArray(r.errors) ? r.errors.length : 0,
        }
      : null,
    recentQueries: queries.rows.map((q) => ({ query: q.query, mode: q.mode, resultCount: Number(q.result_count), latencyMs: Number(q.latency_ms), at: iso(q.created_at) })),
  };
}

/**
 * RAG evaluation contract. Retrieval relevance and answer sufficiency are separate:
 *
 *   answerable    expected document(s) must be in the top K (retrieval), and the final
 *                 answer must be `answered`, citing only expected documents (grounding).
 *   insufficient  retrieval MAY return related evidence; the final answer must be
 *                 `insufficient_evidence` with zero citations.
 *   unrelated     retrieval must return no qualifying evidence, and the final answer must
 *                 be `insufficient_evidence` with zero citations.
 */
export type EvalKind = 'answerable' | 'insufficient' | 'unrelated';

export interface EvalCase {
  question: string;
  kind: EvalKind;
  /** docKeys that legitimately support the answer (answerable cases). */
  expectedDocuments?: string[];
}

export interface EvalAnswer {
  status: 'answered' | 'insufficient_evidence' | 'unavailable' | 'generation_failed';
  citedDocKeys: string[];
  /** Structured-generation counters for this answer (attempts, whether a format retry ran). */
  generation?: { attempts: number; retried: boolean; failedAttempts: number };
}

export interface EvalCaseResult {
  question: string;
  kind: EvalKind;
  pass: boolean;
  failures: string[];
  retrieved: string[];
  rank: number | null;
  answerStatus: EvalAnswer['status'] | null;
  cited: string[];
}

export interface EvalReport {
  k: number;
  answersEvaluated: boolean;
  cases: EvalCaseResult[];
  metrics: {
    /** answerable: an expected document is in the top K. */
    retrievalHitAtK: number;
    /** answerable: mean reciprocal rank of the first expected document. */
    retrievalMrr: number;
    /** unrelated: retrieval returned nothing. */
    unrelatedNoRetrieval: number;
    /** every case: the final status matched the expected status. */
    answerStatusAccuracy: number | null;
    /** insufficient + unrelated: refused with zero citations. */
    unsupportedRejection: number | null;
    /** answerable answers: cited at least one expected document and nothing else. */
    citationCorrectness: number | null;
  };
  passed: number;
  total: number;
}

const ratio = (n: number, d: number): number => (d === 0 ? 1 : n / d);

/**
 * Runs retrieval for every case, and, when `answer` is supplied, the full grounded answer.
 * Without `answer` only retrieval metrics are scored (and insufficient cases are not judged).
 */
export async function runRagEval(opts: {
  cases: EvalCase[];
  k?: number;
  retrieve: (question: string) => Promise<RetrievalResult[]>;
  answer?: (question: string) => Promise<EvalAnswer>;
}): Promise<EvalReport> {
  const k = opts.k ?? 3;
  const results: EvalCaseResult[] = [];
  for (const c of opts.cases) {
    const retrieved = (await opts.retrieve(c.question)).slice(0, k).map((r) => String(r.metadata.docKey ?? r.title));
    const expected = c.expectedDocuments ?? [];
    const rankIdx = retrieved.findIndex((d) => expected.includes(d));
    const failures: string[] = [];

    if (c.kind === 'answerable') {
      if (expected.length === 0) failures.push('answerable case has no expectedDocuments');
      if (rankIdx < 0) failures.push(`expected document not in top ${k}`);
    }
    if (c.kind === 'unrelated' && retrieved.length > 0) failures.push('unrelated question retrieved evidence');

    let answer: EvalAnswer | null = null;
    if (opts.answer) {
      answer = await opts.answer(c.question);
      if (c.kind === 'answerable') {
        if (answer.status !== 'answered') failures.push(`expected answered, got ${answer.status}`);
        else if (answer.citedDocKeys.length === 0) failures.push('answered without citations');
        else if (answer.citedDocKeys.some((d) => !expected.includes(d))) failures.push(`cited a non-supporting source (${answer.citedDocKeys.filter((d) => !expected.includes(d)).join(', ')})`);
      } else {
        if (answer.status !== 'insufficient_evidence') failures.push(`unsupported question was ${answer.status}`);
        else if (answer.citedDocKeys.length > 0) failures.push('insufficient_evidence included citations');
      }
    }
    results.push({
      question: c.question,
      kind: c.kind,
      pass: failures.length === 0,
      failures,
      retrieved,
      rank: rankIdx >= 0 ? rankIdx + 1 : null,
      answerStatus: answer?.status ?? null,
      cited: answer?.citedDocKeys ?? [],
    });
  }

  const answerable = results.filter((r) => r.kind === 'answerable');
  const unrelated = results.filter((r) => r.kind === 'unrelated');
  const unsupported = results.filter((r) => r.kind !== 'answerable');
  const evaluated = !!opts.answer;
  const answeredOk = answerable.filter((r) => r.answerStatus === 'answered');
  return {
    k,
    answersEvaluated: evaluated,
    cases: results,
    metrics: {
      retrievalHitAtK: ratio(answerable.filter((r) => r.rank !== null).length, answerable.length),
      retrievalMrr: answerable.length ? answerable.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / answerable.length : 1,
      unrelatedNoRetrieval: ratio(unrelated.filter((r) => r.retrieved.length === 0).length, unrelated.length),
      answerStatusAccuracy: evaluated
        ? ratio(results.filter((r) => r.answerStatus === (r.kind === 'answerable' ? 'answered' : 'insufficient_evidence')).length, results.length)
        : null,
      unsupportedRejection: evaluated ? ratio(unsupported.filter((r) => r.answerStatus === 'insufficient_evidence' && r.cited.length === 0).length, unsupported.length) : null,
      citationCorrectness: evaluated
        ? ratio(
            answeredOk.filter((r) => {
              const exp = opts.cases.find((c) => c.question === r.question)?.expectedDocuments ?? [];
              return r.cited.length > 0 && r.cited.every((d) => exp.includes(d));
            }).length,
            answeredOk.length
          )
        : null,
    },
    passed: results.filter((r) => r.pass).length,
    total: results.length,
  };
}

export interface StabilityCase {
  question: string;
  kind: EvalCase['kind'];
  runs: number;
  passes: number;
  /** Final answer status counts across runs, e.g. { answered: 5 }. */
  statuses: Record<string, number>;
  /** True when every run retrieved the same top-K documents in the same order. */
  retrievalStable: boolean;
  /** True when every run reached the same final status. */
  statusStable: boolean;
}

/** Per-case consistency across repeated eval runs over the same corpus. */
export function summarizeStability(reports: EvalReport[]): StabilityCase[] {
  if (reports.length === 0) return [];
  return reports[0].cases.map((first, i) => {
    const runs = reports.map((r) => r.cases[i]);
    const statuses: Record<string, number> = {};
    for (const c of runs) {
      const s = c.answerStatus ?? 'not_evaluated';
      statuses[s] = (statuses[s] ?? 0) + 1;
    }
    const sig = (c: EvalCaseResult) => c.retrieved.join('|');
    return {
      question: first.question,
      kind: first.kind,
      runs: runs.length,
      passes: runs.filter((c) => c.pass).length,
      statuses,
      retrievalStable: runs.every((c) => sig(c) === sig(first)),
      statusStable: Object.keys(statuses).length === 1,
    };
  });
}
