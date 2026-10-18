import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { createTestDb, HashTestEmbedder } from './helpers/knowledgeFakes.js';
import type { SqlDb } from '../src/knowledge/db.js';
import { migrate } from '../src/knowledge/migrations.js';
import { ingestKnowledge } from '../src/knowledge/ingest.js';
import { knowledgeRoots } from '../src/knowledge/paths.js';
import { retrieveKnowledge, type RetrievalResult } from '../src/knowledge/retrieval.js';
import { answerFromContext, toEvidence } from '../src/knowledge/grounding.js';
import { assembleContext } from '../src/cognition/context.js';
import { subjectTerms, stem } from '../src/cognition/sufficiency.js';
import { runRagEval, type EvalAnswer, type EvalCase } from '../src/knowledge/status.js';
import type { MessagesClient } from '../src/photobooth/agent.js';

const ORG = 'pacific-horizon-labs';
const LEASE = 'Can Pacific Ops automatically sign a lease?';
const VENDOR = 'Can Pacific Ops sign vendor contracts?';
const WIFI = 'What is the wifi password at the warehouse?';
const fixture = JSON.parse(fs.readFileSync('test/fixtures/knowledge-eval.json', 'utf-8')) as { cases: EvalCase[]; k: number };

/**
 * Worst-case answerer: always claims "supported" and quotes the evidence sentence that
 * best overlaps the question. The sufficiency gate, not the model's honesty, must hold.
 */
function overconfidentModel(): MessagesClient {
  return {
    messages: {
      async create(params) {
        const user = String(params.messages[0].content);
        const question = /<question>\n([\s\S]*?)\n<\/question>/.exec(user)?.[1] ?? '';
        const subject = subjectTerms(question);
        let best = { id: 'E1', quote: '', score: -1 };
        for (const m of user.matchAll(/<evidence id="(E\d+)"[^>]*>\n([\s\S]*?)\n<\/evidence>/g)) {
          for (const sentence of m[2].split(/(?<=[.!?])\s+|\n+/)) {
            const words = (sentence.toLowerCase().match(/[a-z]+/g) ?? []).map(stem);
            const score = subject.filter((s) => words.some((w) => w.startsWith(s) || s.startsWith(w))).length;
            if (sentence.trim().length >= 12 && score > best.score) best = { id: m[1], quote: sentence.trim(), score };
          }
        }
        const body = JSON.stringify({ verdict: 'supported', answer: `Definitely: ${best.quote}`, claims: [{ claim: best.quote, evidenceId: best.id, quote: best.quote }] });
        return { id: 'm', type: 'message', role: 'assistant', model: 't', content: [{ type: 'text', text: body, citations: null }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null } } as Anthropic.Message;
      },
    },
  };
}

describe('RAG evaluation contract', () => {
  let db: SqlDb;
  const emb = new HashTestEmbedder();
  /** Live embeddings return related Pacific Ops text for the authority questions; reproduce that here. */
  const RELATED: Record<string, string> = {
    [LEASE]: 'Can Pacific Ops send an email without owner approval?',
    [VENDOR]: 'Can Pacific Ops send an email without owner approval?',
  };
  const retrieve = async (q: string): Promise<RetrievalResult[]> =>
    (await retrieveKnowledge(db, emb, { organizationId: ORG, query: RELATED[q] ?? q, limit: fixture.k, record: false })).results;
  const gatedAnswer = async (q: string): Promise<EvalAnswer> => {
    const ctx = await assembleContext({ question: q, organizationId: ORG }, [{ name: 'knowledge', collect: async () => ({ evidence: toEvidence(await retrieve(q)) }) }]);
    const a = await answerFromContext(ctx, { anthropic: overconfidentModel(), verifier: async () => true });
    return { status: a.status, citedDocKeys: a.citations.map((c) => c.provenance.docKey ?? '?') };
  };

  before(async () => {
    db = await createTestDb();
    await migrate(db);
    await ingestKnowledge({ db, embedder: emb, organizationId: ORG, sourceLabel: 'Seed', path: path.resolve('knowledge/pacific-horizon-labs'), roots: knowledgeRoots() });
  });
  after(async () => db.close());

  it('the full fixture passes end to end through the real sufficiency gate, with separate metrics', async () => {
    const report = await runRagEval({ cases: fixture.cases, k: fixture.k, retrieve, answer: gatedAnswer });
    for (const c of report.cases) assert.ok(c.pass, `${c.question}: ${c.failures.join('; ')}`);
    assert.deepEqual(report.metrics, {
      retrievalHitAtK: 1,
      retrievalMrr: report.metrics.retrievalMrr,
      unrelatedNoRetrieval: 1,
      answerStatusAccuracy: 1,
      unsupportedRejection: 1,
      citationCorrectness: 1,
    });
    assert.ok(report.metrics.retrievalMrr >= 0.9, `MRR ${report.metrics.retrievalMrr}`);
  });

  it('1. lease retrieves related Pacific Ops text yet passes: insufficient_evidence, zero citations', async () => {
    const report = await runRagEval({ cases: fixture.cases.filter((c) => c.question === LEASE), retrieve, answer: gatedAnswer });
    const lease = report.cases[0];
    assert.ok(lease.retrieved.includes('pacific-horizon-labs/company-overview.md'), 'related evidence was retrieved');
    assert.deepEqual([lease.pass, lease.answerStatus, lease.cited], [true, 'insufficient_evidence', []]);
  });

  it('2. warehouse wifi is a genuine no-retrieval case', async () => {
    const report = await runRagEval({ cases: fixture.cases.filter((c) => c.question === WIFI), retrieve, answer: gatedAnswer });
    assert.deepEqual([report.cases[0].retrieved, report.cases[0].answerStatus, report.cases[0].pass], [[], 'insufficient_evidence', true]);
  });

  it('3-4. sponsored-event and email-approval answers stay supported and correctly cited', async () => {
    const report = await runRagEval({
      cases: fixture.cases.filter((c) => /sponsored events\?|owner approval/.test(c.question)),
      retrieve,
      answer: gatedAnswer,
    });
    assert.deepEqual(
      report.cases.map((c) => [c.question, c.answerStatus, c.cited]),
      [
        ['Do guests pay at sponsored events?', 'answered', ['pacific-horizon-labs/photo-booth-operating-policy.md']],
        ['Can Pacific Ops send an email without owner approval?', 'answered', ['pacific-horizon-labs/company-overview.md']],
      ]
    );
  });

  it('5-7. the evaluator fails definitive unsupported answers, cited refusals, and wrong-source citations', async () => {
    const cases: EvalCase[] = [
      { question: LEASE, kind: 'insufficient' },
      { question: VENDOR, kind: 'insufficient' },
      { question: 'Do guests pay at sponsored events?', kind: 'answerable', expectedDocuments: ['pacific-horizon-labs/photo-booth-operating-policy.md'] },
    ];
    const bad: Record<string, EvalAnswer> = {
      [LEASE]: { status: 'answered', citedDocKeys: ['pacific-horizon-labs/company-overview.md'] },
      [VENDOR]: { status: 'insufficient_evidence', citedDocKeys: ['pacific-horizon-labs/company-overview.md'] },
      'Do guests pay at sponsored events?': { status: 'answered', citedDocKeys: ['pacific-horizon-labs/company-overview.md'] },
    };
    const report = await runRagEval({ cases, retrieve, answer: async (q) => bad[q] });
    assert.deepEqual(
      report.cases.map((c) => [c.pass, c.failures]),
      [
        [false, ['unsupported question was answered']],
        [false, ['insufficient_evidence included citations']],
        [false, ['cited a non-supporting source (pacific-horizon-labs/company-overview.md)']],
      ]
    );
    assert.equal(report.metrics.unsupportedRejection, 0);
    assert.equal(report.metrics.citationCorrectness, 0);
    assert.equal(report.passed, 0);
  });

  it('8. retrieval hit@K and MRR stay meaningful: a missing expected document fails retrieval', async () => {
    const report = await runRagEval({
      cases: [{ question: 'Do guests pay at sponsored events?', kind: 'answerable', expectedDocuments: ['pacific-horizon-labs/company-overview.md'] }],
      retrieve: async (q) => (await retrieve(q)).filter((r) => r.metadata.docKey !== 'pacific-horizon-labs/company-overview.md'),
    });
    assert.deepEqual([report.metrics.retrievalHitAtK, report.metrics.retrievalMrr, report.cases[0].failures], [0, 0, ['expected document not in top 3']]);
    assert.equal(report.answersEvaluated, false);
    assert.equal(report.metrics.answerStatusAccuracy, null);
  });

  it('an unrelated case that retrieves evidence fails the retrieval check', async () => {
    const report = await runRagEval({ cases: [{ question: WIFI, kind: 'unrelated' }], retrieve: async () => retrieve('Do guests pay at sponsored events?') });
    assert.deepEqual(report.cases[0].failures, ['unrelated question retrieved evidence']);
    assert.equal(report.metrics.unrelatedNoRetrieval, 0);
  });
});
