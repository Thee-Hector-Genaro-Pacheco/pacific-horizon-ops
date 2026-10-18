import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestDb, HashTestEmbedder } from './helpers/knowledgeFakes.js';
import { KnowledgeError, loadKnowledgeDbConfig, type SqlDb } from '../src/knowledge/db.js';
import { migrate, ensureOrganization, MIGRATIONS } from '../src/knowledge/migrations.js';
import { normalizeText, contentHash, findSecretLikeContent } from '../src/knowledge/normalize.js';
import { chunkDocument, documentTitle, ChunkingError } from '../src/knowledge/chunker.js';
import { listKnowledgeFiles, resolveSafeKnowledgePath, knowledgeRoots } from '../src/knowledge/paths.js';
import { ingestKnowledge } from '../src/knowledge/ingest.js';
import { OllamaEmbeddingProvider, createEmbeddingProvider } from '../src/knowledge/embeddings.js';

const ORG = 'pacific-horizon-labs';

function tmpRoot() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'phro-kn-'));
  const root = path.join(base, 'knowledge');
  fs.mkdirSync(root);
  return { base, root: fs.realpathSync(root) };
}
const write = (dir: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};

describe('Knowledge schema', () => {
  let db: SqlDb;
  before(async () => {
    db = await createTestDb();
  });
  after(async () => db.close());

  it('migrates once, is idempotent, and creates the default organization', async () => {
    assert.deepEqual(await migrate(db), MIGRATIONS.map((m) => m.id));
    assert.deepEqual(await migrate(db), []);
    const orgs = await db.query<{ id: string }>('SELECT id FROM organizations');
    assert.deepEqual(orgs.rows.map((r) => r.id), [ORG]);
    const tables = await db.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`);
    for (const t of ['knowledge_sources', 'knowledge_documents', 'knowledge_chunks', 'ingestion_runs', 'knowledge_queries', 'organizations']) {
      assert.ok(tables.rows.some((r) => r.table_name === t), t);
    }
    const cols = await db.query<{ column_name: string; udt_name: string }>(`SELECT column_name, udt_name FROM information_schema.columns WHERE table_name = 'knowledge_chunks'`);
    assert.equal(cols.rows.find((c) => c.column_name === 'embedding')?.udt_name, 'vector');
    assert.ok(cols.rows.some((c) => c.column_name === 'organization_id'));
  });

  it('requires an explicit database URL (no silent default)', () => {
    assert.throws(() => loadKnowledgeDbConfig({}), (e: unknown) => e instanceof KnowledgeError && e.kind === 'config');
    assert.throws(() => loadKnowledgeDbConfig({ PHRO_KNOWLEDGE_DATABASE_URL: 'mysql://x' }), /postgres/);
    assert.ok(loadKnowledgeDbConfig({ PHRO_KNOWLEDGE_DATABASE_URL: 'postgres://u:p@127.0.0.1:5435/k' }).url);
  });
});

describe('Normalization and chunking', () => {
  it('normalizes deterministically and hashes the normalized text', () => {
    const a = normalizeText('﻿Hello\r\nworld  \r\n\r\n\r\n\r\nEnd\u0007');
    assert.equal(a, 'Hello\nworld\n\nEnd');
    assert.equal(contentHash(a), contentHash(normalizeText('Hello\nworld\n\n\nEnd')));
    assert.notEqual(contentHash(a), contentHash('Hello\nworld\n\nEnd!'));
    assert.equal(normalizeText('café'), 'café');
  });

  it('chunks by heading and paragraph with stable order and section metadata', () => {
    const md = '# Policy\n\nIntro paragraph.\n\n## Sponsored events\n\nGuests never pay.\n\n## Delivery\n\nInstant sharing.';
    const chunks = chunkDocument(md, 'text/markdown', 'Policy');
    assert.deepEqual(chunks.map((c) => [c.ordinal, c.section, c.text]), [
      [0, 'Policy', 'Intro paragraph.'],
      [1, 'Sponsored events', 'Guests never pay.'],
      [2, 'Delivery', 'Instant sharing.'],
    ]);
    assert.deepEqual(chunks[1].headings, ['Policy', 'Sponsored events']);
    assert.deepEqual(chunkDocument(md, 'text/markdown', 'Policy'), chunks, 'deterministic');
    assert.equal(documentTitle(md, 'text/markdown', 'x/policy.md'), 'Policy');
    assert.equal(documentTitle('plain', 'text/plain', 'x/service-rules.txt'), 'service rules');
  });

  it('never exceeds the chunk size, even for one enormous sentence, and overlaps neighbours modestly', () => {
    const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
    const paragraphs = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} ${'detail '.repeat(30)}.`).join('\n\n');
    for (const text of [long, paragraphs]) {
      const chunks = chunkDocument(text, 'text/plain', 'T', { maxChars: 400, overlapChars: 80 });
      assert.ok(chunks.length > 1);
      for (const c of chunks) assert.ok(c.charCount <= 400, `chunk ${c.ordinal} is ${c.charCount}`);
      assert.deepEqual(chunks.map((c) => c.ordinal), chunks.map((_, i) => i));
    }
    const multi = chunkDocument(paragraphs, 'text/plain', 'T', { maxChars: 400, overlapChars: 80 });
    const firstTail = multi[0].text.slice(-40).split(' ').pop()!;
    assert.ok(multi[1].text.includes(firstTail), 'next chunk starts with overlap from the previous one');
  });

  it('renders JSON as path/value lines grouped by top-level key, and rejects malformed JSON', () => {
    const chunks = chunkDocument(JSON.stringify({ deposit: { refundable: false }, regions: ['Orange County', 'Los Angeles County'] }), 'application/json', 'Rules');
    assert.deepEqual(chunks.map((c) => [c.section, c.text]), [
      ['deposit', 'deposit.refundable: false'],
      ['regions', 'regions.0: Orange County\n\nregions.1: Los Angeles County'],
    ]);
    assert.throws(() => chunkDocument('{"broken": ', 'application/json', 'X'), ChunkingError);
  });

  it('recognizes credential-like content', () => {
    for (const s of ['key sk-ant-api03-abcdefghijklmnopqrstuvwxyz', '-----BEGIN RSA PRIVATE KEY-----', 'token ya29.abcdefghijklmnopqrstuvwxyz0123', 'postgres://phro:hunter2@db:5432/x', '"refresh_token": "1//0abcdefghi"']) {
      assert.ok(findSecretLikeContent(s), s);
    }
    assert.equal(findSecretLikeContent('Sponsored events never charge the guest.'), null);
  });
});

describe('Ingestion path safety', () => {
  let base: string;
  let root: string;
  beforeEach(() => ({ base, root } = tmpRoot()));
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it('denies secrets, credentials, tokens, keys, dumps and denied directories', () => {
    write(root, 'policy.md', '# Policy\n\nOk.');
    for (const f of ['.env', '.env.local', 'credentials.json', 'credentials.personal.json', 'token.business.json', 'google-profiles.json', 'server.pem', 'id_rsa', 'backup.sql', 'db.dump', 'secrets-notes.md', 'notes.exe']) write(root, f, 'x');
    for (const d of ['.git/config.md', 'node_modules/pkg/readme.md', 'data/x.md', 'secrets/a.md']) write(root, d, 'x');
    const { files, skipped } = listKnowledgeFiles(root, [root]);
    assert.deepEqual(files.map((f) => f.docKey), ['policy.md']);
    const reasons = Object.fromEntries(skipped.map((s) => [s.docKey, s.reason]));
    for (const f of ['.env', '.env.local', 'credentials.json', 'token.business.json', 'google-profiles.json', 'server.pem', 'id_rsa', 'backup.sql', 'secrets-notes.md']) assert.equal(reasons[f], 'denied file name', f);
    assert.equal(reasons['node_modules'], 'denied directory');
    assert.equal(reasons['notes.exe'], 'unsupported file type');
    assert.throws(() => resolveSafeKnowledgePath(path.join(root, '.env'), [root]), (e: unknown) => e instanceof KnowledgeError && e.kind === 'unsafe_path');
    assert.throws(() => resolveSafeKnowledgePath(path.join(root, 'secrets'), [root]), /denied directory/);
  });

  it('rejects paths outside the knowledge roots, including prefix tricks and symlink escapes', () => {
    write(base, 'outside.md', 'nope');
    write(base, 'knowledge2/x.md', 'nope');
    assert.throws(() => resolveSafeKnowledgePath(path.join(base, 'outside.md'), [root]), /outside the allowed knowledge roots/);
    assert.throws(() => resolveSafeKnowledgePath(path.join(base, 'knowledge2'), [root]), /outside the allowed knowledge roots/);
    assert.throws(() => resolveSafeKnowledgePath(path.join(root, '..', 'outside.md'), [root]), /outside/);
    assert.throws(() => resolveSafeKnowledgePath('/etc/passwd', [root]), /outside/);
    fs.symlinkSync(path.join(base, 'outside.md'), path.join(root, 'link.md'));
    assert.throws(() => resolveSafeKnowledgePath(path.join(root, 'link.md'), [root]), /outside/);
    assert.deepEqual(listKnowledgeFiles(root, [root]).skipped, [{ docKey: 'link.md', reason: 'symbolic links are not followed' }]);
  });

  it('only ./knowledge (plus PHRO_KNOWLEDGE_ROOTS) is a root', () => {
    assert.deepEqual(knowledgeRoots({}, base), [root]);
  });
});

describe('Ingestion pipeline', () => {
  let db: SqlDb;
  let base: string;
  let root: string;
  let emb: HashTestEmbedder;
  const ingest = (p = root, extra: Partial<Parameters<typeof ingestKnowledge>[0]> = {}) =>
    ingestKnowledge({ db, embedder: emb, organizationId: ORG, sourceLabel: 'Handbook', path: p, roots: [root], ...extra });
  const activeChunks = async (org = ORG) =>
    (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id AND d.active WHERE c.organization_id = $1', [org])).rows[0].n;

  beforeEach(async () => {
    db = await createTestDb();
    await migrate(db);
    ({ base, root } = tmpRoot());
    emb = new HashTestEmbedder();
    write(root, 'policy.md', '# Operating Policy\n\n## Sponsored events\n\nSponsored and promotional events never charge the guest.\n\n## Delivery\n\nGuests receive photos instantly.');
    write(root, 'rules.json', JSON.stringify({ deposit: 'non-refundable retainer' }));
  });
  afterEach(async () => {
    await db.close();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('ingests deterministically with provenance metadata and vectors', async () => {
    const r = await ingest();
    assert.equal(r.status, 'completed');
    assert.deepEqual([r.documentsSeen, r.documentsChanged, r.chunksWritten], [2, 2, 3]);
    const rows = await db.query<{ ordinal: number; metadata: Record<string, unknown>; model: string; has: boolean }>(
      `SELECT c.ordinal, c.metadata, c.embedding_model AS model, c.embedding IS NOT NULL AS has FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id WHERE d.doc_key = 'policy.md' ORDER BY c.ordinal`
    );
    assert.deepEqual(rows.rows.map((x) => [x.ordinal, x.metadata.section, x.metadata.docKey, x.metadata.sourceLabel, x.model, x.has]), [
      [0, 'Sponsored events', 'policy.md', 'Handbook', 'test:hash-bow', true],
      [1, 'Delivery', 'policy.md', 'Handbook', 'test:hash-bow', true],
    ]);
    const run = (await db.query<{ status: string; chunks_written: number }>('SELECT status, chunks_written FROM ingestion_runs')).rows[0];
    assert.deepEqual(run, { status: 'completed', chunks_written: 3 });
  });

  it('re-ingesting identical content writes no new chunks and makes no embedding calls', async () => {
    await ingest();
    const calls = emb.calls;
    const r = await ingest();
    assert.deepEqual([r.documentsChanged, r.documentsUnchanged, r.chunksWritten], [0, 2, 0]);
    assert.equal(emb.calls, calls);
    assert.equal(await activeChunks(), 3);
  });

  it('a changed document gets a new version; old chunks are not left active', async () => {
    await ingest();
    write(root, 'policy.md', '# Operating Policy\n\n## Sponsored events\n\nSponsored events never charge the guest, ever.');
    const r = await ingest();
    assert.deepEqual([r.documentsChanged, r.documentsUnchanged], [1, 1]);
    const docs = await db.query<{ version: number; active: boolean }>(`SELECT version, active FROM knowledge_documents WHERE doc_key = 'policy.md' ORDER BY version`);
    assert.deepEqual(docs.rows, [{ version: 1, active: false }, { version: 2, active: true }]);
    assert.equal(await activeChunks(), 2);
    const total = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM knowledge_chunks')).rows[0].n;
    assert.equal(total, 2, 'superseded chunks are removed');
  });

  it('documents removed from disk are retired', async () => {
    await ingest();
    fs.rmSync(path.join(root, 'rules.json'));
    const r = await ingest();
    assert.equal(r.documentsRetired, 1);
    assert.equal(await activeChunks(), 2);
  });

  it('malformed and secret-bearing documents fail safely without stopping the run', async () => {
    write(root, 'broken.json', '{"oops": ');
    write(root, 'leaky.md', '# Notes\n\nUse key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 for the bot.');
    write(root, 'empty.txt', '   \n\n ');
    const r = await ingest();
    assert.equal(r.status, 'partial');
    const reasons = Object.fromEntries(r.errors.map((e) => [e.docKey, e.reason]));
    assert.match(reasons['broken.json'], /Malformed JSON/);
    assert.match(reasons['leaky.md'], /credential-like content \(Anthropic API key\)/);
    assert.match(reasons['empty.txt'], /empty/);
    const stored = (await db.query<{ t: string }>("SELECT string_agg(text, ' ') AS t FROM knowledge_chunks")).rows[0].t;
    assert.ok(!stored.includes('sk-ant'), 'secret never stored');
  });

  it('ingestion without an embedder requires an explicit lexical-only flag', async () => {
    await assert.rejects(ingest(root, { embedder: null }), (e: unknown) => e instanceof KnowledgeError && e.kind === 'embedding_unavailable');
    const r = await ingest(root, { embedder: null, lexicalOnly: true });
    assert.equal(r.status, 'completed');
    const n = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM knowledge_chunks WHERE embedding IS NULL')).rows[0].n;
    assert.equal(n, 3);
  });

  it('an embedding outage fails the run explicitly and records it', async () => {
    emb.fail = true;
    await assert.rejects(ingest(), (e: unknown) => e instanceof KnowledgeError && e.kind === 'embedding_unavailable');
    const run = (await db.query<{ status: string }>('SELECT status FROM ingestion_runs')).rows[0];
    assert.equal(run.status, 'failed');
    assert.equal(await activeChunks(), 0, 'no half-indexed documents');
  });

  it('organizations are isolated: same label and files, separate rows, no cross-org counts', async () => {
    await ensureOrganization(db, 'other-co', 'Other Co');
    await ingest();
    await ingest(root, { organizationId: 'other-co' });
    assert.equal(await activeChunks(ORG), 3);
    assert.equal(await activeChunks('other-co'), 3);
    const srcs = await db.query<{ organization_id: string }>('SELECT organization_id FROM knowledge_sources ORDER BY 1');
    assert.deepEqual(srcs.rows.map((r) => r.organization_id), ['other-co', ORG]);
    await assert.rejects(ingest(root, { organizationId: 'unknown-org' }), 'unknown organizations are rejected by the foreign key');
  });
});

describe('Embedding providers', () => {
  it('Ollama provider: request shape, nomic task prefixes, dimension validation', async () => {
    const sent: Array<{ url: string; body: { model: string; input: string[] } }> = [];
    const provider = new OllamaEmbeddingProvider({
      fetchImpl: async (url, init) => {
        const body = JSON.parse(String(init.body));
        sent.push({ url, body });
        return new Response(JSON.stringify({ embeddings: body.input.map(() => new Array(768).fill(0.01)) }), { status: 200 });
      },
    });
    assert.equal(provider.model, 'ollama:nomic-embed-text');
    assert.equal(provider.dimension, 768);
    const v = await provider.embed(['hello'], 'query');
    assert.equal(v[0].length, 768);
    assert.equal(sent[0].url, 'http://127.0.0.1:11434/api/embed');
    assert.deepEqual(sent[0].body, { model: 'nomic-embed-text', input: ['search_query: hello'] });
    await provider.embed(['doc'], 'document');
    assert.equal(sent[1].body.input[0], 'search_document: doc');
  });

  it('fails explicitly: wrong dimension, missing model, unreachable service (never fake vectors)', async () => {
    const bad = new OllamaEmbeddingProvider({ fetchImpl: async () => new Response(JSON.stringify({ embeddings: [[1, 2, 3]] })) });
    await assert.rejects(bad.embed(['x'], 'query'), (e: unknown) => e instanceof KnowledgeError && e.kind === 'embedding_unavailable');
    const missing = new OllamaEmbeddingProvider({ fetchImpl: async () => new Response('{}', { status: 404 }) });
    await assert.rejects(missing.embed(['x'], 'query'), /ollama pull nomic-embed-text/);
    const down = new OllamaEmbeddingProvider({ baseUrl: 'http://127.0.0.1:9', timeoutMs: 1000 });
    await assert.rejects(down.embed(['x'], 'query'), /not reachable/);
  });

  it('factory: ollama by default, explicit none, unknown rejected', () => {
    assert.ok(createEmbeddingProvider({}) instanceof OllamaEmbeddingProvider);
    assert.equal(createEmbeddingProvider({ PHRO_EMBEDDINGS_PROVIDER: 'none' }), null);
    assert.throws(() => createEmbeddingProvider({ PHRO_EMBEDDINGS_PROVIDER: 'random' }), /Unknown/);
  });
});
