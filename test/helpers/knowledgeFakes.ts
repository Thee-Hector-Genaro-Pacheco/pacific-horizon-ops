import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { KnowledgeError, type SqlDb } from '../../src/knowledge/db.js';
import type { EmbeddingProvider } from '../../src/knowledge/embeddings.js';
import { EMBEDDING_DIMENSION } from '../../src/knowledge/migrations.js';

/**
 * TEST-ONLY knowledge fakes. A real in-process Postgres (PGlite + pgvector) and a
 * deterministic hashed bag-of-words embedder. Nothing here is used by src/.
 */

export async function createTestDb(): Promise<SqlDb & { raw: PGlite }> {
  const raw = await PGlite.create({ extensions: { vector } });
  const adapt = (q: { query: PGlite['query'] }): SqlDb['query'] =>
    async <T>(text: string, params?: unknown[]) => {
      const res = await q.query<T>(text, params as unknown[]);
      return { rows: res.rows };
    };
  const db: SqlDb & { raw: PGlite } = {
    raw,
    query: adapt(raw),
    async transaction(fn) {
      return raw.transaction(async (tx) => {
        const inner: SqlDb = { query: adapt(tx as unknown as { query: PGlite['query'] }), transaction: (f) => f(inner), close: async () => {} };
        return fn(inner);
      });
    },
    async close() {
      await raw.close();
    },
  };
  return db;
}

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'is', 'are', 'do', 'does', 'what', 'our', 'we', 'can', 'it', 'be', 'with', 'by']);

/** Crude stem so "events"/"event", "sponsored"/"sponsor" share buckets. */
function stem(w: string): string {
  return w.replace(/(ing|ed|es|s)$/, '');
}

/**
 * Deterministic test embedder: words hashed into signed buckets, L2-normalized.
 * Similar wording -> similar vectors; it is NOT a semantic model and never ships.
 */
export class HashTestEmbedder implements EmbeddingProvider {
  readonly model = 'test:hash-bow';
  readonly dimension = EMBEDDING_DIMENSION;
  calls = 0;
  fail = false;

  async embed(texts: string[]): Promise<number[][]> {
    this.calls++;
    if (this.fail) throw new KnowledgeError('embedding_unavailable', 'Test embedder is offline.');
    return texts.map((t) => {
      const v = new Array<number>(this.dimension).fill(0);
      for (const raw of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        if (STOP.has(raw)) continue;
        const h = crypto.createHash('sha256').update(stem(raw)).digest();
        const idx = h.readUInt16BE(0) % this.dimension;
        v[idx] += h[2] & 1 ? 1 : -1;
      }
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  }
}
