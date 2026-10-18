import { DEFAULT_ORGANIZATION_ID, DEFAULT_ORGANIZATION_NAME, KnowledgeError, type SqlDb } from './db.js';

/**
 * Knowledge store schema. Every row carries organization_id; every query filters on it.
 * Embedding dimension is fixed per schema (768, nomic-embed-text) so the HNSW index is
 * valid; the model that produced each vector is recorded beside it.
 */
export const EMBEDDING_DIMENSION = 768;

export interface Migration {
  id: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: '001_knowledge_core',
    sql: `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  source_type TEXT NOT NULL CHECK (source_type IN ('local_files', 'manual_note')),
  label TEXT NOT NULL,
  external_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, label)
);

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  source_id UUID NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  doc_key TEXT NOT NULL,
  title TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('text/plain', 'text/markdown', 'application/json')),
  version INTEGER NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, doc_key, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_documents_one_active
  ON knowledge_documents (source_id, doc_key) WHERE active;

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  document_id UUID NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  char_count INTEGER NOT NULL,
  token_estimate INTEGER NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding vector(768),
  embedding_model TEXT,
  tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(metadata->>'title', '') || ' ' || coalesce(metadata->>'section', '') || ' ' || text)
  ) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, ordinal)
);
CREATE INDEX IF NOT EXISTS knowledge_chunks_org ON knowledge_chunks (organization_id);
CREATE INDEX IF NOT EXISTS knowledge_chunks_tsv ON knowledge_chunks USING GIN (tsv);
CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS ingestion_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  source_id UUID REFERENCES knowledge_sources(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'partial', 'failed')),
  documents_seen INTEGER NOT NULL DEFAULT 0,
  documents_changed INTEGER NOT NULL DEFAULT 0,
  documents_unchanged INTEGER NOT NULL DEFAULT 0,
  documents_retired INTEGER NOT NULL DEFAULT 0,
  chunks_written INTEGER NOT NULL DEFAULT 0,
  errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  embedding_model TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS knowledge_queries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  query TEXT NOT NULL,
  mode TEXT NOT NULL,
  result_count INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`,
  },
];

export async function migrate(db: SqlDb): Promise<string[]> {
  const applied: string[] = [];
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS knowledge_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    const done = new Set((await db.query<{ id: string }>('SELECT id FROM knowledge_migrations')).rows.map((r) => r.id));
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      await db.transaction(async (tx) => {
        for (const statement of splitStatements(m.sql)) await tx.query(statement);
        await tx.query('INSERT INTO knowledge_migrations (id) VALUES ($1)', [m.id]);
      });
      applied.push(m.id);
    }
    await ensureOrganization(db, DEFAULT_ORGANIZATION_ID, DEFAULT_ORGANIZATION_NAME);
  } catch (err) {
    if (err instanceof KnowledgeError) throw err;
    throw new KnowledgeError('migration_failed', `Knowledge schema migration failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return applied;
}

export async function ensureOrganization(db: SqlDb, id: string, name: string): Promise<void> {
  await db.query('INSERT INTO organizations (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [id, name]);
}

/** Splits on semicolons at line ends (the migrations contain no procedural bodies). */
function splitStatements(sql: string): string[] {
  return sql
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}
