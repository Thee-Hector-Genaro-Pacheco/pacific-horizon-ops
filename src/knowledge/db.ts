import pg from 'pg';

/**
 * Minimal SQL surface for the knowledge store. Implemented by `pg` (Docker Postgres +
 * pgvector in development/production) and by PGlite in automated tests, so the same SQL
 * runs against a real Postgres engine in both.
 */
export interface SqlDb {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Runs `fn` in a transaction; rolls back on throw. */
  transaction<T>(fn: (tx: SqlDb) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export type KnowledgeErrorKind =
  | 'config'
  | 'database_unavailable'
  | 'embedding_unavailable'
  | 'unsafe_path'
  | 'invalid_input'
  | 'migration_failed';

export class KnowledgeError extends Error {
  readonly kind: KnowledgeErrorKind;
  constructor(kind: KnowledgeErrorKind, message: string) {
    super(message);
    this.name = 'KnowledgeError';
    this.kind = kind;
  }
}

export const DEFAULT_ORGANIZATION_ID = 'pacific-horizon-labs';
export const DEFAULT_ORGANIZATION_NAME = 'Pacific Horizon Labs';

export interface KnowledgeDbConfig {
  url: string;
}

/**
 * PHRO_KNOWLEDGE_DATABASE_URL, e.g. postgres://phro:<password>@127.0.0.1:5435/phro_knowledge.
 * There is deliberately no default: the knowledge store never silently connects anywhere.
 */
export function loadKnowledgeDbConfig(env: NodeJS.ProcessEnv = process.env): KnowledgeDbConfig {
  const url = env.PHRO_KNOWLEDGE_DATABASE_URL?.trim();
  if (!url) {
    throw new KnowledgeError('config', 'PHRO_KNOWLEDGE_DATABASE_URL is not set. See README "Knowledge store (PHRO-AI-001)".');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new KnowledgeError('config', 'PHRO_KNOWLEDGE_DATABASE_URL is not a valid URL.');
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
    throw new KnowledgeError('config', 'PHRO_KNOWLEDGE_DATABASE_URL must be a postgres:// URL.');
  }
  return { url };
}

/** Database connection failures, normalized. Never includes the connection string. */
export function toKnowledgeDbError(err: unknown): KnowledgeError {
  if (err instanceof KnowledgeError) return err;
  const code = (err as { code?: string })?.code ?? '';
  const message = err instanceof Error ? err.message : String(err);
  if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', '57P03', '3D000', '28P01', '28000'].includes(code) || /connect|terminat|timeout/i.test(message)) {
    return new KnowledgeError('database_unavailable', `Knowledge database is unavailable (${code || 'connection error'}).`);
  }
  return new KnowledgeError('database_unavailable', 'Knowledge database query failed.');
}

/** `pg` pool adapter. Connection errors surface as KnowledgeError('database_unavailable'). */
export function createPgDb(config: KnowledgeDbConfig): SqlDb {
  const pool = new pg.Pool({ connectionString: config.url, max: 5, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 10_000 });
  // An idle client error must not crash the process.
  pool.on('error', () => {});
  const wrap = (q: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>): SqlDb['query'] =>
    async <T>(text: string, params?: unknown[]) => {
      try {
        const res = await q(text, params);
        return { rows: res.rows as T[] };
      } catch (err) {
        const code = (err as { code?: string })?.code ?? '';
        // SQL errors (syntax, constraint) are bugs or bad input, not "database unavailable".
        if (/^[0-9A-Z]{5}$/.test(code) && !['57P03', '3D000', '28P01', '28000'].includes(code)) throw err;
        throw toKnowledgeDbError(err);
      }
    };
  return {
    query: wrap((text, params) => pool.query(text, params as unknown[])),
    async transaction(fn) {
      let client: pg.PoolClient;
      try {
        client = await pool.connect();
      } catch (err) {
        throw toKnowledgeDbError(err);
      }
      const tx: SqlDb = {
        query: wrap((text, params) => client.query(text, params as unknown[])),
        transaction: (inner) => inner(tx),
        close: async () => {},
      };
      try {
        await client.query('BEGIN');
        const out = await fn(tx);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

/** pgvector literal for a parameter: '[0.1,0.2,...]' (cast with ::vector in SQL). */
export function toVectorLiteral(v: number[]): string {
  return `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(',')}]`;
}
