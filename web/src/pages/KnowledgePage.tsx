import { BookOpen, Database, FileText, Search, Sparkles } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { MetricCard } from '../components/ops';
import { EmptyState, ErrorState, PageHeader, Panel, SkeletonRows, SourceBadge } from '../components/primitives';
import type { KnowledgeSearchDTO } from '../data/contract';
import { useData } from '../data/DataProvider';
import { useResource } from '../data/useResource';
import { relativeTime } from '../lib/format';

/**
 * Read-only knowledge diagnostics: store health, counts, last ingestion, recent searches,
 * and a search box that shows ranked evidence with provenance. Ingestion stays CLI-only.
 */
export function KnowledgePage() {
  const { mode, services } = useData();
  const status = useResource((s) => s.knowledge.getStatus(), [], ['activity']);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<KnowledgeSearchDTO | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const s = status.data;

  async function onSearch(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await services.knowledge.search(q));
      status.reload();
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Search failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Intelligence"
        title="Knowledge"
        description="Stored company knowledge Pacific Ops can cite. Ingestion runs from the local CLI; this view is read-only."
        actions={<SourceBadge kind={mode} />}
      />

      {status.error && !s ? (
        <Panel>
          <ErrorState error={status.error} onRetry={status.reload} />
        </Panel>
      ) : (
        <>
          {s && s.database !== 'online' && (
            <p className="cal-warning" role="alert">
              <Database size={14} aria-hidden /> {s.database === 'not_configured' ? 'Knowledge store not configured.' : 'Knowledge database offline.'} {s.detail}
            </p>
          )}
          <div className="metric-strip">
            <MetricCard label="Database" icon={Database} value={s ? (s.database === 'online' ? 'Online' : s.database === 'offline' ? 'Offline' : 'Not set up') : undefined} sub={s?.organizationId} loading={status.loading} />
            <MetricCard label="Documents" icon={FileText} value={s?.documents} sub={s ? `${s.sources} sources` : undefined} loading={status.loading} />
            <MetricCard label="Chunks" icon={BookOpen} value={s?.chunks} sub={s ? `${s.chunksWithVectors} with vectors` : undefined} loading={status.loading} />
            <MetricCard label="Embeddings" icon={Sparkles} value={s ? (s.embedding ? s.embedding.model.replace(/^ollama:/, '') : 'None') : undefined} sub={s?.embedding ? `${s.embedding.dimension} dims` : 'Lexical only'} loading={status.loading} />
          </div>

          <div className="analytics-grid">
            <Panel title="Search stored knowledge" icon={Search}>
              <form onSubmit={onSearch} className="kn-search">
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Do guests pay at sponsored events?" aria-label="Search stored knowledge" maxLength={500} />
                <button type="submit" className="btn btn--sm" disabled={busy || !query.trim()}>
                  {busy ? 'Searching…' : 'Search'}
                </button>
              </form>
              {error && <ErrorState error={error} compact />}
              {result && (
                <div className="kn-results">
                  <p className="muted kn-meta">
                    {result.mode === 'hybrid' ? 'Hybrid (lexical + vector)' : 'Lexical only'}
                    {result.degraded ? ` · vector search unavailable` : ''} · {result.results.length} results · {result.latencyMs} ms
                  </p>
                  {result.results.length === 0 ? (
                    <EmptyState icon={BookOpen} title="No relevant stored knowledge" compact>
                      Pacific Ops would answer: "I don't have enough stored company knowledge to answer that yet."
                    </EmptyState>
                  ) : (
                    <ol className="kn-list">
                      {result.results.map((r) => (
                        <li key={r.rank}>
                          <div className="kn-title">
                            {r.title}
                            {r.section ? <span className="muted"> › {r.section}</span> : null}
                          </div>
                          <div className="kn-excerpt">{r.excerpt}</div>
                          <div className="muted kn-scores">
                            {r.sourceLabel} · score {r.score.toFixed(2)} · terms {Math.round(r.coverage * 100)}% · vector {r.vectorScore === null ? 'n/a' : r.vectorScore.toFixed(2)}
                          </div>
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              )}
            </Panel>

            <Panel title="Ingestion and recent searches">
              {!s ? (
                <SkeletonRows rows={3} label="Loading knowledge status" />
              ) : (
                <>
                  <p className="kn-meta">
                    {s.lastIngestion
                      ? `Last ingestion ${s.lastIngestion.status} ${relativeTime(s.lastIngestion.startedAt)}: ${s.lastIngestion.documentsChanged} changed, ${s.lastIngestion.documentsUnchanged} unchanged, ${s.lastIngestion.chunksWritten} chunks, ${s.lastIngestion.errorCount} errors.`
                      : 'No ingestion yet. Run: npm run knowledge:ingest -- knowledge/pacific-horizon-labs'}
                  </p>
                  {s.recentQueries.length ? (
                    <ul className="kn-recent">
                      {s.recentQueries.map((q) => (
                        <li key={`${q.at}-${q.query}`}>
                          <span>{q.query}</span>
                          <span className="muted">
                            {q.resultCount} · {q.mode === 'hybrid' ? 'hybrid' : 'lexical'} · {q.latencyMs} ms · {relativeTime(q.at)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted">No searches yet.</p>
                  )}
                </>
              )}
            </Panel>
          </div>
        </>
      )}
    </>
  );
}
