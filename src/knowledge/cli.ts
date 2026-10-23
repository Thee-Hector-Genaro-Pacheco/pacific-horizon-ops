import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_ORGANIZATION_ID, KnowledgeError, createPgDb, loadKnowledgeDbConfig, type SqlDb } from './db.js';
import { createEmbeddingProvider } from './embeddings.js';
import { askKnowledge } from './grounding.js';
import { ingestKnowledge } from './ingest.js';
import { consoleKnowledgeLogger } from './log.js';
import { migrate } from './migrations.js';
import { knowledgeRoots } from './paths.js';
import { retrieveKnowledge } from './retrieval.js';
import { knowledgeStatus, runRagEval, summarizeStability, type EvalCase, type EvalReport } from './status.js';

/**
 * Local admin CLI for the knowledge store. Ingestion is CLI-only by design: the dashboard
 * API is read-only and never accepts file paths from a browser.
 *
 *   npm run knowledge:migrate
 *   npm run knowledge:status
 *   npm run knowledge:ingest -- knowledge/pacific-horizon-labs [--source "Company handbook"] [--lexical-only]
 *   npm run knowledge:search -- "What is our photo booth policy?"
 *   npm run knowledge:ask -- "Do guests pay at sponsored events?"
 *   npm run knowledge:eval
 *   npm run knowledge:eval -- --repeat 5        (per-case stability across repeated runs)
 */

const ORG = process.env.PHRO_ORGANIZATION_ID?.trim() || DEFAULT_ORGANIZATION_ID;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function withDb<T>(fn: (db: SqlDb) => Promise<T>): Promise<T> {
  const db = createPgDb(loadKnowledgeDbConfig());
  try {
    await migrate(db);
    return await fn(db);
  } finally {
    await db.close();
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--source'].includes(args[i - 1])));

  switch (command) {
    case 'migrate':
      return withDb(async () => console.log('\nKnowledge schema is up to date.\n'));
    case 'status':
      return withDb(async (db) => {
        const s = await knowledgeStatus(db, ORG, createEmbeddingProvider());
        console.log(`\nOrganization: ${s.organizationId}`);
        console.log(`Sources: ${s.sources} · Documents: ${s.documents} · Chunks: ${s.chunks} (${s.chunksWithVectors} with vectors)`);
        console.log(`Embeddings: ${s.embedding ? `${s.embedding.model} (${s.embedding.dimension} dims)` : 'none (lexical only)'}`);
        if (s.lastIngestion) {
          const l = s.lastIngestion;
          console.log(`Last ingestion: ${l.status} at ${l.startedAt} · ${l.documentsChanged} changed, ${l.documentsUnchanged} unchanged, ${l.chunksWritten} chunks, ${l.errorCount} errors`);
        } else console.log('Last ingestion: none');
        console.log('');
      });
    case 'ingest': {
      const target = positional[0];
      if (!target) throw new KnowledgeError('invalid_input', 'Usage: npm run knowledge:ingest -- <path inside ./knowledge> [--source <label>] [--lexical-only]');
      const lexicalOnly = args.includes('--lexical-only');
      const embedder = lexicalOnly ? null : createEmbeddingProvider();
      const sourceLabel = flag(args, '--source') ?? path.basename(path.resolve(target));
      return withDb(async (db) => {
        const r = await ingestKnowledge({ db, embedder, organizationId: ORG, sourceLabel, path: target, roots: knowledgeRoots(), lexicalOnly, logger: consoleKnowledgeLogger });
        console.log(`\nIngestion ${r.status}: ${r.documentsSeen} seen, ${r.documentsChanged} changed, ${r.documentsUnchanged} unchanged, ${r.documentsRetired} retired, ${r.chunksWritten} chunks.`);
        for (const e of r.errors) console.log(`  ! ${e.docKey}: ${e.reason}`);
        for (const s of r.skipped) console.log(`  - skipped ${s.docKey}: ${s.reason}`);
        console.log('');
      });
    }
    case 'search': {
      const query = positional.join(' ');
      return withDb(async (db) => {
        const res = await retrieveKnowledge(db, createEmbeddingProvider(), { organizationId: ORG, query, limit: 5 }, consoleKnowledgeLogger);
        console.log(`\nMode: ${res.mode}${res.degraded ? ` (degraded: ${res.degraded})` : ''} · ${res.results.length} results · ${res.latencyMs} ms`);
        for (const [i, r] of res.results.entries()) {
          console.log(`\n${i + 1}. ${r.title}${r.section ? ` › ${r.section}` : ''}  [${r.sourceLabel}]`);
          console.log(`   score ${r.score.toFixed(3)} · coverage ${r.coverage} · lexical ${r.lexicalScore.toFixed(3)} · vector ${r.vectorScore === null ? 'n/a' : r.vectorScore.toFixed(3)}`);
          console.log(`   ${r.text.replace(/\s+/g, ' ').slice(0, 220)}`);
        }
        if (res.results.length === 0) console.log('\nNo relevant stored knowledge.');
        console.log('');
      });
    }
    case 'ask': {
      const question = positional.join(' ');
      return withDb(async (db) => {
        const a = await askKnowledge(question, { db, embedder: createEmbeddingProvider(), organizationId: ORG, logger: consoleKnowledgeLogger });
        console.log(`\n${a.status === 'answered' ? 'According to stored company knowledge: ' : ''}${a.answer}`);
        for (const c of a.citations) console.log(`  [${c.id}] ${c.title}${c.section ? ` › ${c.section}` : ''} (${c.sourceLabel})`);
        console.log(`  status: ${a.status} · sufficiency: ${a.sufficiency} · evidence retrieved: ${a.context.evidence.length} · cited: ${a.citations.length}`);
        for (const n of a.context.notices) console.log(`  note: ${n.provider} ${n.status} (${n.detail})`);
        console.log('');
      });
    }
    case 'eval': {
      const fixture = flag(args, '--file') ?? 'test/fixtures/knowledge-eval.json';
      const retrievalOnly = args.includes('--retrieval-only');
      const repeat = Math.max(1, Math.min(20, Number(flag(args, '--repeat') ?? 1) || 1));
      const { cases, k } = JSON.parse(fs.readFileSync(fixture, 'utf-8')) as { cases: EvalCase[]; k: number };
      return withDb(async (db) => {
        const embedder = createEmbeddingProvider();
        // Generation counters across every grounded answer in this eval (safe counts only).
        const gen = { answers: 0, parseFailures: 0, retries: 0, retrySuccesses: 0, generationFailed: 0 };
        const genLine = () =>
          `Generation: ${gen.answers} answers · parse failures ${gen.parseFailures} · retries ${gen.retries} · retry successes ${gen.retrySuccesses} · generation failed ${gen.generationFailed}`;
        const evalOnce = () => runRagEval({
          cases,
          k,
          retrieve: async (q) => (await retrieveKnowledge(db, embedder, { organizationId: ORG, query: q, limit: k, record: false })).results,
          answer: retrievalOnly
            ? undefined
            : async (q) => {
                const a = await askKnowledge(q, { db, embedder, organizationId: ORG });
                const g = a.generation;
                if (g.status !== 'not_run') gen.answers++;
                gen.parseFailures += g.failures.length;
                if (g.retried) gen.retries++;
                if (g.retried && g.status === 'ok') gen.retrySuccesses++;
                if (a.status === 'generation_failed') gen.generationFailed++;
                return {
                  status: a.status,
                  citedDocKeys: a.citations.map((c) => c.provenance.docKey ?? c.title),
                  generation: { attempts: g.attempts, retried: g.retried, failedAttempts: g.failures.length },
                };
              },
        });
        const pct = (v: number | null) => (v === null ? 'n/a' : `${Math.round(v * 100)}%`);
        if (repeat > 1) {
          const reports: EvalReport[] = [];
          for (let i = 1; i <= repeat; i++) {
            const r = await evalOnce();
            reports.push(r);
            const m = r.metrics;
            console.log(
              `run ${i}/${repeat}: ${r.passed}/${r.total} · hit@${k} ${pct(m.retrievalHitAtK)} · MRR ${m.retrievalMrr.toFixed(2)} · status ${pct(m.answerStatusAccuracy)} · unsupported rejected ${pct(m.unsupportedRejection)} · citations ${pct(m.citationCorrectness)}`
            );
          }
          console.log('\nPer-case stability:');
          const stability = summarizeStability(reports);
          for (const c of stability) {
            const statuses = Object.entries(c.statuses).map(([s, n]) => `${s} ${n}/${c.runs}`).join(', ');
            console.log(`${c.passes === c.runs ? 'STABLE' : 'UNSTABLE'}  ${c.passes}/${c.runs}  [${c.kind}] ${c.question}`);
            console.log(`        status: ${statuses} · retrieval ${c.retrievalStable ? 'identical every run' : 'VARIED'}`);
          }
          console.log(`\n${genLine()}`);
          const stable = stability.filter((c) => c.passes === c.runs).length;
          console.log(`\n${stable}/${stability.length} cases passed ${repeat}/${repeat} runs\n`);
          if (stable !== stability.length) process.exitCode = 1;
          return;
        }
        const report = await evalOnce();
        for (const c of report.cases) {
          const answer = c.answerStatus ? ` · ${c.answerStatus}${c.cited.length ? ` citing ${c.cited.join(', ')}` : ''}` : '';
          console.log(`${c.pass ? 'PASS' : 'FAIL'}  [${c.kind}] ${c.question}`);
          console.log(`        retrieved: ${c.retrieved.join(', ') || '(nothing)'}${answer}`);
          for (const f of c.failures) console.log(`        ! ${f}`);
        }
        const m = report.metrics;
        console.log(`\nRetrieval: hit@${k} ${pct(m.retrievalHitAtK)} · MRR ${m.retrievalMrr.toFixed(2)} · unrelated with no retrieval ${pct(m.unrelatedNoRetrieval)}`);
        console.log(
          report.answersEvaluated
            ? `Answers:   status accuracy ${pct(m.answerStatusAccuracy)} · unsupported rejected ${pct(m.unsupportedRejection)} · citation correctness ${pct(m.citationCorrectness)}`
            : 'Answers:   not evaluated (--retrieval-only)'
        );
        if (report.answersEvaluated) console.log(genLine());
        console.log(`${report.passed}/${report.total} cases passed\n`);
        if (report.passed !== report.total) process.exitCode = 1;
      });
    }
    default:
      console.log('Commands: migrate | status | ingest <path> [--source <label>] [--lexical-only] | search "<query>" | ask "<question>" | eval [--file <fixture>] [--repeat N]');
  }
}

if (process.argv[1]?.endsWith('knowledge/cli.ts') || process.argv[1]?.endsWith('knowledge/cli.js')) {
  main().catch((err) => {
    const msg = err instanceof KnowledgeError ? `${err.kind}: ${err.message}` : err instanceof Error ? err.message : String(err);
    console.error(`\nKnowledge CLI Error: ${msg}\n`);
    process.exit(1);
  });
}
