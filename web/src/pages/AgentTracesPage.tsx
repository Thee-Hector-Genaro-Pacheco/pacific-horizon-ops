import { Workflow } from 'lucide-react';
import { EmptyState, ErrorState, PageHeader, Panel, SkeletonRows, SourceBadge } from '../components/primitives';
import { useData } from '../data/DataProvider';
import { useResource } from '../data/useResource';
import { relativeTime } from '../lib/format';

/**
 * Read-only harness diagnostics: why Pacific Ops did what it did. Shows redacted traces
 * only (intent, plan, tools, policy, outcome, latency). No prompts, no IDs, no secrets.
 */
export function AgentTracesPage() {
  const { mode } = useData();
  const traces = useResource((s) => s.agent.listTraces(50), [], ['calls', 'activity']);

  return (
    <>
      <PageHeader
        eyebrow="Intelligence"
        title="Agent"
        description="How the agent harness routed recent requests: intent, context plan, tools, policy and outcome. Redacted; read-only."
        actions={<SourceBadge kind={mode} />}
      />
      <Panel title="Recent traces" icon={Workflow} count={traces.data?.length} flush>
        {traces.error && !traces.data ? (
          <ErrorState error={traces.error} onRetry={traces.reload} />
        ) : !traces.data ? (
          <SkeletonRows rows={4} label="Loading traces" />
        ) : traces.data.length === 0 ? (
          <EmptyState icon={Workflow} title="No traces yet" compact>
            Ask Pacific Ops a knowledge, Calendar, inbox or Photo Booth question, or run npm run agent:inspect.
          </EmptyState>
        ) : (
          <ul className="ag-list">
            {traces.data.map((t) => (
              <li key={t.traceId} className="ag-item">
                <div className="ag-head">
                  <strong>{t.intent.intent}</strong>
                  {t.toolsConsidered.length === 0 && <span className="muted">· no tool</span>}
                  <span className={`ag-status ag-status--${t.status}`}>{t.status.replace('_', ' ')}</span>
                  {t.intent.highRisk && <span className="ag-risk">high risk</span>}
                  {t.dryRun && <span className="muted">dry run</span>}
                  <span className="muted ag-time">
                    {t.channel} · {t.latencyMs} ms · {relativeTime(t.at)}
                  </span>
                </div>
                {t.normalization?.canonicalPreview && t.intent.intent === 'knowledge.query' ? (
                  <>
                    <div className="ag-input">Heard: “{t.inputPreview}”</div>
                    <div className="ag-input">
                      Interpreted: “{t.normalization.canonicalPreview}” <span className="muted">({t.normalization.method})</span>
                    </div>
                  </>
                ) : (
                  <div className="ag-input">“{t.inputPreview}”</div>
                )}
                {t.followUp && (
                  <div className="muted ag-meta">
                    follow-up · inherited {t.followUp.inheritedIntent} from {t.followUp.inheritedDomain} ({t.followUp.reason})
                  </div>
                )}
                {t.resolution && (
                  <div className="muted ag-meta">
                    {t.resolution.kind === 'context_answer' ? 'answered from stored context' : t.resolution.kind} · {t.resolution.reason}
                  </div>
                )}
                <div className="muted ag-meta">
                  providers {t.providersInvoked.join(', ') || t.plan?.providers.join(', ') || 'none'} · {t.plan?.completeness ?? 'n/a'}
                  {t.toolOutcome ? ` · ${t.toolOutcome.toolId}: ${t.toolOutcome.outcome}` : ''}
                </div>
                {t.policy.map((p) => (
                  <div key={p.toolId} className="muted ag-meta">
                    policy {p.toolId}: {p.decision} ({p.reason})
                  </div>
                ))}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </>
  );
}
