import { KnowledgeError, toVectorLiteral, type SqlDb } from './db.js';
import type { EmbeddingProvider } from './embeddings.js';
import { silentKnowledgeLogger, type KnowledgeLogger } from './log.js';

/**
 * One shared hybrid retrieval service.
 *
 *   candidates  = top-N lexical (Postgres full text, OR over query lexemes)
 *               ∪ top-N vector (pgvector cosine), both org-scoped, active documents only
 *   fusion      = Reciprocal Rank Fusion (k = 60), optional recency weighting
 *   relevance   = a chunk is evidence only if it covers ≥ minCoverage of the query terms
 *                 or its vector similarity ≥ minSimilarity; weak matches are dropped so
 *                 "no evidence" stays distinguishable from "some loosely related text".
 */

export interface RetrieveRequest {
  organizationId: string;
  query: string;
  limit?: number;
  sourceTypes?: string[];
  sourceIds?: string[];
  /** Fraction of query terms a chunk must contain to count lexically (default 0.5). */
  minCoverage?: number;
  /** Cosine similarity floor for vector-only evidence (default PHRO_KNOWLEDGE_MIN_SIMILARITY or 0.55). */
  minSimilarity?: number;
  /** Optional: newer documents get up to +10% (half-life in days). Off by default. */
  recencyHalfLifeDays?: number;
  /** Record the query for diagnostics (default true). */
  record?: boolean;
}

export interface RetrievalResult {
  chunkId: string;
  documentId: string;
  sourceId: string;
  title: string;
  section: string | null;
  sourceLabel: string;
  ordinal: number;
  text: string;
  /** Fused score in [0, 1]. */
  score: number;
  /** ts_rank_cd value, or 0 when not a lexical match. */
  lexicalScore: number;
  /** Fraction of query terms present in the chunk. */
  coverage: number;
  /** Cosine similarity, or null when vectors were not used. */
  vectorScore: number | null;
  metadata: Record<string, unknown>;
}

export interface RetrievalResponse {
  results: RetrievalResult[];
  /** hybrid: lexical + vector. lexical_only: no embedder configured, or the query could not be embedded (see `degraded`). */
  mode: 'hybrid' | 'lexical_only';
  degraded: 'embedding_unavailable' | null;
  latencyMs: number;
  candidates: number;
}

const CANDIDATES = 24;
const RRF_K = 60;

interface Row {
  chunk_id: string;
  document_id: string;
  source_id: string;
  title: string;
  text: string;
  ordinal: number;
  metadata: Record<string, unknown>;
  source_label: string;
  updated_at: string | Date;
}

function filters(req: RetrieveRequest, params: unknown[]): string {
  let sql = '';
  if (req.sourceTypes?.length) {
    params.push(req.sourceTypes);
    sql += ` AND s.source_type = ANY($${params.length}::text[])`;
  }
  if (req.sourceIds?.length) {
    params.push(req.sourceIds);
    sql += ` AND s.id = ANY($${params.length}::uuid[])`;
  }
  return sql;
}

const BASE = `
  FROM knowledge_chunks c
  JOIN knowledge_documents d ON d.id = c.document_id AND d.active AND d.organization_id = c.organization_id
  JOIN knowledge_sources s ON s.id = d.source_id AND s.organization_id = c.organization_id`;

const COLUMNS = `c.id AS chunk_id, c.document_id, d.source_id, d.title, c.text, c.ordinal, c.metadata, s.label AS source_label, d.updated_at`;

export async function retrieveKnowledge(
  db: SqlDb,
  embedder: EmbeddingProvider | null,
  req: RetrieveRequest,
  logger: KnowledgeLogger = silentKnowledgeLogger
): Promise<RetrievalResponse> {
  const started = Date.now();
  const query = req.query.trim().slice(0, 2000);
  if (!req.organizationId) throw new KnowledgeError('invalid_input', 'organizationId is required.');
  if (!query) throw new KnowledgeError('invalid_input', 'A query is required.');
  const limit = Math.min(Math.max(req.limit ?? 5, 1), 20);
  const minCoverage = req.minCoverage ?? 0.5;
  const minSimilarity = req.minSimilarity ?? (Number(process.env.PHRO_KNOWLEDGE_MIN_SIMILARITY) || 0.55);

  try {
    // Stemmed query lexemes from Postgres itself, so query and index use the same analyzer.
    const lex = await db.query<{ lexemes: string[] | null }>(
      `SELECT array_agg(DISTINCT lexeme) AS lexemes FROM unnest(to_tsvector('english', $1))`,
      [query]
    );
    const lexemes = (lex.rows[0]?.lexemes ?? []).filter((l) => /^[\p{L}\p{N}]+$/u.test(l)).slice(0, 32);

    const lexical = new Map<string, Row & { rank: number; ts: number; coverage: number }>();
    if (lexemes.length) {
      const params: unknown[] = [req.organizationId, lexemes.join(' | '), lexemes];
      const where = filters(req, params);
      params.push(CANDIDATES);
      const rows = await db.query<Row & { ts: number; coverage: number }>(
        `SELECT ${COLUMNS},
           ts_rank_cd(c.tsv, to_tsquery('simple', $2)) AS ts,
           (SELECT count(*) FROM unnest($3::text[]) l WHERE c.tsv @@ to_tsquery('simple', l))::float / ${lexemes.length} AS coverage
         ${BASE}
         WHERE c.organization_id = $1 AND c.tsv @@ to_tsquery('simple', $2)${where}
         ORDER BY ts DESC, c.id
         LIMIT $${params.length}`,
        params
      );
      rows.rows.forEach((r, i) => lexical.set(r.chunk_id, { ...r, ts: Number(r.ts), coverage: Number(r.coverage), rank: i + 1 }));
    }

    let mode: RetrievalResponse['mode'] = 'lexical_only';
    let degraded: RetrievalResponse['degraded'] = null;
    const vector = new Map<string, Row & { rank: number; similarity: number }>();
    if (embedder) {
      let qv: number[] | null = null;
      try {
        [qv] = await embedder.embed([query], 'query');
      } catch {
        degraded = 'embedding_unavailable';
        logger('embedding.failed', { stage: 'query' });
      }
      if (qv) {
        mode = 'hybrid';
        const params: unknown[] = [req.organizationId, toVectorLiteral(qv), embedder.model];
        const where = filters(req, params);
        params.push(CANDIDATES);
        const rows = await db.query<Row & { similarity: number }>(
          `SELECT ${COLUMNS}, 1 - (c.embedding <=> $2::vector) AS similarity
           ${BASE}
           WHERE c.organization_id = $1 AND c.embedding IS NOT NULL AND c.embedding_model = $3${where}
           ORDER BY c.embedding <=> $2::vector, c.id
           LIMIT $${params.length}`,
          params
        );
        rows.rows.forEach((r, i) => vector.set(r.chunk_id, { ...r, similarity: Number(r.similarity), rank: i + 1 }));
      }
    }

    const ids = new Set([...lexical.keys(), ...vector.keys()]);
    const maxFused = (lexemes.length ? 1 : 0) / (RRF_K + 1) + (mode === 'hybrid' ? 1 : 0) / (RRF_K + 1) || 1;
    const now = Date.now();
    const fused: RetrievalResult[] = [];
    for (const id of ids) {
      const l = lexical.get(id);
      const v = vector.get(id);
      const coverage = l?.coverage ?? 0;
      const similarity = v?.similarity ?? null;
      const relevant = coverage >= minCoverage || (similarity !== null && similarity >= minSimilarity);
      if (!relevant) continue;
      let score = ((l ? 1 / (RRF_K + l.rank) : 0) + (v ? 1 / (RRF_K + v.rank) : 0)) / maxFused;
      const row = (l ?? v)!;
      if (req.recencyHalfLifeDays && req.recencyHalfLifeDays > 0) {
        const ageDays = (now - new Date(row.updated_at).getTime()) / 86_400_000;
        score *= 1 + 0.1 * Math.pow(0.5, ageDays / req.recencyHalfLifeDays);
      }
      fused.push({
        chunkId: row.chunk_id,
        documentId: row.document_id,
        sourceId: row.source_id,
        title: row.title,
        section: (row.metadata?.section as string | null | undefined) ?? null,
        sourceLabel: row.source_label,
        ordinal: row.ordinal,
        text: row.text,
        score: Math.min(1, Number(score.toFixed(6))),
        lexicalScore: l ? Number(l.ts.toFixed(6)) : 0,
        coverage: Number(coverage.toFixed(4)),
        vectorScore: similarity === null ? null : Number(similarity.toFixed(6)),
        metadata: row.metadata ?? {},
      });
    }
    fused.sort((a, b) => b.score - a.score || b.coverage - a.coverage || a.chunkId.localeCompare(b.chunkId));
    const results = fused.slice(0, limit);
    const latencyMs = Date.now() - started;

    if (req.record !== false) {
      await db
        .query('INSERT INTO knowledge_queries (organization_id, query, mode, result_count, latency_ms) VALUES ($1, $2, $3, $4, $5)', [
          req.organizationId,
          query.slice(0, 200),
          mode,
          results.length,
          latencyMs,
        ])
        .catch(() => {});
    }
    logger('retrieval.completed', { mode, degraded, results: results.length, candidates: ids.size, latencyMs });
    return { results, mode, degraded, latencyMs, candidates: ids.size };
  } catch (err) {
    logger('retrieval.failed', { kind: err instanceof KnowledgeError ? err.kind : 'database' });
    throw err;
  }
}
