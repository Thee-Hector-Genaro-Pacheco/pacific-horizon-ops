import fs from 'node:fs';
import path from 'node:path';
import { ChunkingError, chunkDocument, documentTitle, type ChunkOptions } from './chunker.js';
import { KnowledgeError, toVectorLiteral, type SqlDb } from './db.js';
import type { EmbeddingProvider } from './embeddings.js';
import { silentKnowledgeLogger, type KnowledgeLogger } from './log.js';
import { PIPELINE_VERSION, contentHash, findSecretLikeContent, normalizeText } from './normalize.js';
import { listKnowledgeFiles, resolveSafeKnowledgePath, type KnowledgeFile } from './paths.js';

export interface IngestOptions {
  db: SqlDb;
  /** Required unless `lexicalOnly` is set. */
  embedder: EmbeddingProvider | null;
  organizationId: string;
  /** Display label for the source, e.g. "Company handbook". Unique per organization. */
  sourceLabel: string;
  /** Requested path (file or directory) inside an allowed knowledge root. */
  path: string;
  roots: string[];
  /** Explicitly store chunks without vectors (lexical retrieval only). */
  lexicalOnly?: boolean;
  chunkOptions?: ChunkOptions;
  logger?: KnowledgeLogger;
}

export interface IngestResult {
  runId: string;
  status: 'completed' | 'partial' | 'failed';
  documentsSeen: number;
  documentsChanged: number;
  documentsUnchanged: number;
  documentsRetired: number;
  chunksWritten: number;
  errors: Array<{ docKey: string; reason: string }>;
  skipped: Array<{ docKey: string; reason: string }>;
}

interface Prepared {
  file: KnowledgeFile;
  title: string;
  hash: string;
  chunks: ReturnType<typeof chunkDocument>;
}

export async function ingestKnowledge(opts: IngestOptions): Promise<IngestResult> {
  const log = opts.logger ?? silentKnowledgeLogger;
  if (!opts.embedder && !opts.lexicalOnly) {
    throw new KnowledgeError('embedding_unavailable', 'No embedding provider is configured. Start Ollama, or pass --lexical-only to ingest without vectors.');
  }
  const { real, root } = resolveSafeKnowledgePath(opts.path, opts.roots);
  const { files, skipped } = listKnowledgeFiles(opts.path, opts.roots);
  // Documents under the requested path that are not seen this run are retired.
  const scopePrefix = path.relative(root, real).split(path.sep).join('/');

  const source = await opts.db.query<{ id: string }>(
    `INSERT INTO knowledge_sources (organization_id, source_type, label, external_ref)
     VALUES ($1, 'local_files', $2, $3)
     ON CONFLICT (organization_id, label) DO UPDATE SET updated_at = now()
     RETURNING id`,
    [opts.organizationId, opts.sourceLabel, path.basename(root)]
  );
  const sourceId = source.rows[0].id;
  const run = await opts.db.query<{ id: string }>(
    `INSERT INTO ingestion_runs (organization_id, source_id, status, embedding_model) VALUES ($1, $2, 'running', $3) RETURNING id`,
    [opts.organizationId, sourceId, opts.lexicalOnly ? null : opts.embedder?.model ?? null]
  );
  const runId = run.rows[0].id;
  log('ingestion.started', { runId, files: files.length, skipped: skipped.length, lexicalOnly: !!opts.lexicalOnly });

  const result: IngestResult = {
    runId,
    status: 'completed',
    documentsSeen: files.length,
    documentsChanged: 0,
    documentsUnchanged: 0,
    documentsRetired: 0,
    chunksWritten: 0,
    errors: [],
    skipped,
  };
  const seen = new Set<string>();

  try {
    for (const file of files) {
      seen.add(file.docKey);
      let prepared: Prepared;
      try {
        prepared = prepare(file, opts.chunkOptions);
      } catch (err) {
        result.errors.push({ docKey: file.docKey, reason: err instanceof Error ? err.message : 'Unreadable document.' });
        log('ingestion.document', { runId, docKey: file.docKey, outcome: 'error' });
        continue;
      }

      const active = await opts.db.query<{ id: string; content_hash: string; version: number }>(
        `SELECT id, content_hash, version FROM knowledge_documents
         WHERE organization_id = $1 AND source_id = $2 AND doc_key = $3 AND active`,
        [opts.organizationId, sourceId, file.docKey]
      );
      if (active.rows[0]?.content_hash === prepared.hash) {
        result.documentsUnchanged++;
        log('ingestion.document', { runId, docKey: file.docKey, outcome: 'unchanged' });
        continue;
      }

      let vectors: number[][] | null = null;
      if (!opts.lexicalOnly && opts.embedder) {
        try {
          vectors = await opts.embedder.embed(
            prepared.chunks.map((c) => `${prepared.title}${c.section && c.section !== prepared.title ? ` — ${c.section}` : ''}\n${c.text}`),
            'document'
          );
        } catch (err) {
          log('embedding.failed', { runId, docKey: file.docKey, kind: err instanceof KnowledgeError ? err.kind : 'unknown' });
          throw err; // embeddings are required for this run: stop rather than store a half-indexed source
        }
      }

      await opts.db.transaction(async (tx) => {
        const maxVersion = await tx.query<{ v: number | null }>(
          'SELECT max(version) AS v FROM knowledge_documents WHERE source_id = $1 AND doc_key = $2',
          [sourceId, file.docKey]
        );
        if (active.rows[0]) {
          await tx.query('DELETE FROM knowledge_chunks WHERE document_id = $1', [active.rows[0].id]);
          await tx.query('UPDATE knowledge_documents SET active = false, updated_at = now() WHERE id = $1', [active.rows[0].id]);
        }
        const doc = await tx.query<{ id: string }>(
          `INSERT INTO knowledge_documents (organization_id, source_id, doc_key, title, content_hash, mime_type, version)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [opts.organizationId, sourceId, file.docKey, prepared.title, prepared.hash, file.mimeType, (Number(maxVersion.rows[0]?.v) || 0) + 1]
        );
        for (const [i, c] of prepared.chunks.entries()) {
          const metadata = {
            title: prepared.title,
            section: c.section,
            headings: c.headings,
            docKey: file.docKey,
            sourceLabel: opts.sourceLabel,
            mimeType: file.mimeType,
            pipelineVersion: PIPELINE_VERSION,
          };
          await tx.query(
            `INSERT INTO knowledge_chunks (organization_id, document_id, ordinal, text, char_count, token_estimate, metadata, embedding, embedding_model)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::vector, $9)`,
            [
              opts.organizationId,
              doc.rows[0].id,
              c.ordinal,
              c.text,
              c.charCount,
              c.tokenEstimate,
              JSON.stringify(metadata),
              vectors ? toVectorLiteral(vectors[i]) : null,
              vectors ? opts.embedder!.model : null,
            ]
          );
        }
      });
      result.documentsChanged++;
      result.chunksWritten += prepared.chunks.length;
      log('ingestion.document', { runId, docKey: file.docKey, outcome: active.rows[0] ? 'updated' : 'added', chunks: prepared.chunks.length });
    }

    // Retire documents that disappeared from the ingested path.
    const stale = await opts.db.query<{ id: string; doc_key: string }>(
      `SELECT id, doc_key FROM knowledge_documents WHERE organization_id = $1 AND source_id = $2 AND active`,
      [opts.organizationId, sourceId]
    );
    for (const d of stale.rows) {
      const inScope = scopePrefix === '' || d.doc_key === scopePrefix || d.doc_key.startsWith(`${scopePrefix}/`);
      if (!inScope || seen.has(d.doc_key)) continue;
      await opts.db.transaction(async (tx) => {
        await tx.query('DELETE FROM knowledge_chunks WHERE document_id = $1', [d.id]);
        await tx.query('UPDATE knowledge_documents SET active = false, updated_at = now() WHERE id = $1', [d.id]);
      });
      result.documentsRetired++;
    }

    result.status = result.errors.length === 0 ? 'completed' : result.documentsChanged + result.documentsUnchanged > 0 ? 'partial' : 'failed';
  } catch (err) {
    result.status = 'failed';
    const reason = err instanceof KnowledgeError ? err.message : 'Ingestion aborted.';
    result.errors.push({ docKey: '*', reason });
    await finishRun(opts.db, result);
    log('ingestion.failed', { runId, kind: err instanceof KnowledgeError ? err.kind : 'unknown', documentsChanged: result.documentsChanged });
    throw err;
  }

  await finishRun(opts.db, result);
  log('ingestion.completed', {
    runId,
    status: result.status,
    documentsSeen: result.documentsSeen,
    documentsChanged: result.documentsChanged,
    documentsUnchanged: result.documentsUnchanged,
    documentsRetired: result.documentsRetired,
    chunksWritten: result.chunksWritten,
    errors: result.errors.length,
  });
  return result;
}

function prepare(file: KnowledgeFile, chunkOptions: ChunkOptions | undefined): Prepared {
  const raw = fs.readFileSync(file.absolutePath, 'utf-8');
  const text = normalizeText(raw);
  if (!text) throw new Error('Document is empty.');
  const secret = findSecretLikeContent(text);
  if (secret) throw new Error(`Refused: document contains credential-like content (${secret}).`);
  const title = documentTitle(text, file.mimeType, file.docKey);
  let chunks;
  try {
    chunks = chunkDocument(text, file.mimeType, title, chunkOptions);
  } catch (err) {
    throw new Error(err instanceof ChunkingError ? err.message : 'Document could not be chunked.');
  }
  if (chunks.length === 0) throw new Error('Document has no content to index.');
  return { file, title, hash: contentHash(text), chunks };
}

async function finishRun(db: SqlDb, r: IngestResult): Promise<void> {
  await db.query(
    `UPDATE ingestion_runs SET status = $2, documents_seen = $3, documents_changed = $4, documents_unchanged = $5,
       documents_retired = $6, chunks_written = $7, errors = $8::jsonb, completed_at = now() WHERE id = $1`,
    [r.runId, r.status, r.documentsSeen, r.documentsChanged, r.documentsUnchanged, r.documentsRetired, r.chunksWritten, JSON.stringify(r.errors.slice(0, 100))]
  );
}
