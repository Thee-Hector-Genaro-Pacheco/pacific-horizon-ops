import { Info, Target } from 'lucide-react';
import { LeadCard } from '../components/LeadCard';
import { MetricCard } from '../components/ops';
import { EmptyState, ErrorState, PageHeader, Panel, Skeleton, SourceBadge } from '../components/primitives';
import { useData } from '../data/DataProvider';
import { useResource } from '../data/useResource';
import { LEAD_STAGE, LEAD_STAGES } from '../lib/status';

export function LeadsPage() {
  const { mode } = useData();
  const leads = useResource((s) => s.leads.listLeads(), [], ['inbox', 'actions']);
  const list = leads.data ?? [];
  const open = list.filter((l) => l.stage !== 'CLOSED' && l.stage !== 'LOST');
  const derived = list.some((l) => l.derived);

  return (
    <>
      <PageHeader
        eyebrow="Relationships"
        title="Leads"
        description="Inquiries Pacific Ops identified as potential bookings, organized by pipeline stage."
        actions={derived ? <SourceBadge kind="derived" /> : mode === 'demo' ? <SourceBadge kind="demo" /> : undefined}
      />

      {derived && (
        <p className="analytics-note">
          <Info size={14} aria-hidden />
          Stages are inferred from inbox classification and action state. Quote, booking and payment stages fill in once CRM records exist.
        </p>
      )}

      <div className="metric-strip">
        <MetricCard label="Open leads" icon={Target} value={open.length} loading={leads.loading} />
        <MetricCard label="Awaiting reply approval" value={list.filter((l) => l.nextAction === 'Approve drafted reply').length} loading={leads.loading} />
        <MetricCard label="Contacted" value={list.filter((l) => l.stage === 'CONTACTED').length} loading={leads.loading} />
        <MetricCard label="Booked" value={list.filter((l) => l.stage === 'BOOKED').length} loading={leads.loading} />
      </div>

      {leads.error && !leads.data ? (
        <Panel>
          <ErrorState error={leads.error} onRetry={leads.reload} />
        </Panel>
      ) : !leads.loading && list.length === 0 ? (
        <Panel>
          <EmptyState icon={Target} title="No leads yet">
            Booking inquiries classified by Pacific Ops will appear here automatically.
          </EmptyState>
        </Panel>
      ) : (
        <div className="pipeline" role="list" aria-label="Lead pipeline">
          {LEAD_STAGES.map(({ stage, label }) => {
            const items = list.filter((l) => l.stage === stage);
            return (
              <section key={stage} className="stage" role="listitem" aria-label={`${label}: ${items.length}`}>
                <header className="stage-head">
                  <i className={`dot ${LEAD_STAGE[stage].tone}`} aria-hidden />
                  {label}
                  <span className="n">{leads.loading ? '·' : items.length}</span>
                </header>
                {leads.loading ? (
                  <Skeleton h={92} r={7} />
                ) : items.length === 0 ? (
                  <div className="stage-empty">No leads</div>
                ) : (
                  items.map((l) => <LeadCard key={l.id} lead={l} to={`/customers/${encodeURIComponent(l.customerId)}`} />)
                )}
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
