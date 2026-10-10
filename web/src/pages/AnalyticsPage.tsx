import { Clock, Info, Mail, Phone, Send, ShieldCheck, Target, Timer } from 'lucide-react';
import { BarChart, HBarList } from '../components/Charts';
import { MetricCard } from '../components/ops';
import { ErrorState, PageHeader, Panel, Skeleton, SourceBadge } from '../components/primitives';
import { useData } from '../data/DataProvider';
import { useResource } from '../data/useResource';
import { duration } from '../lib/format';
import { categoryLabel } from '../lib/status';

export function AnalyticsPage() {
  const { mode } = useData();
  const analytics = useResource((s) => s.dashboard.getAnalytics(), [], ['actions', 'inbox', 'calls', 'activity']);
  const a = analytics.data;
  const loading = analytics.loading;
  const contactRate = a && a.leadsCreated > 0 ? Math.round((a.leadsContacted / a.leadsCreated) * 100) : null;

  return (
    <>
      <PageHeader
        eyebrow="Intelligence"
        title="Analytics"
        description="Throughput, responsiveness and voice operations, computed directly from PHRO records."
        actions={<SourceBadge kind={mode} />}
      />

      <p className="analytics-note">
        <Info size={14} aria-hidden />
        {mode === 'demo'
          ? 'Demo figures for layout only. They do not describe real operations.'
          : `Computed from local action, voice and triage records over the last ${a?.windowDays ?? 30} days. No estimates or projections.`}
      </p>

      {analytics.error && !a ? (
        <Panel>
          <ErrorState error={analytics.error} onRetry={analytics.reload} />
        </Panel>
      ) : (
        <>
          <div className="metric-strip">
            <MetricCard label="Emails received" icon={Mail} value={a?.emailsReceived} sub="Tracked messages" loading={loading} />
            <MetricCard label="Responses sent" icon={Send} value={a?.responsesSent} sub="Approved and sent" loading={loading} />
            <MetricCard label="Inquiry → reply" icon={Clock} value={a ? duration(a.medianReceiveToSendSec) : undefined} sub="Median time to send" loading={loading} />
            <MetricCard label="Approval → send" icon={Timer} value={a ? duration(a.medianApprovalToSendSec) : undefined} sub="Median execution time" loading={loading} />
            <MetricCard
              label="Pending"
              icon={ShieldCheck}
              value={a?.pendingApprovals}
              sub="Awaiting approval"
              emphasis={a && a.pendingApprovals > 0 ? 'attention' : undefined}
              loading={loading}
            />
            <MetricCard label="Calls completed" icon={Phone} value={a?.callsCompleted} sub={a ? `${a.callsFailed} failed` : undefined} loading={loading} />
            <MetricCard label="Leads" icon={Target} value={a?.leadsCreated} sub={contactRate === null ? 'No leads yet' : `${contactRate}% contacted`} loading={loading} />
          </div>

          <div className="analytics-grid">
            <Panel title="Agent activity · last 14 days">
              {a ? <BarChart data={a.activityByDay} label="Agent events per day" /> : <Skeleton h={160} />}
            </Panel>
            <Panel title="Emails received · last 14 days">
              {a ? <BarChart data={a.emailsByDay} label="Emails received per day" /> : <Skeleton h={160} />}
            </Panel>
            <Panel title="Inbox by category">
              {a ? (
                a.categories.length ? (
                  <HBarList label="Messages by category" items={a.categories.map((c) => ({ label: categoryLabel(c.category), value: c.count }))} />
                ) : (
                  <p className="muted">No messages in this window.</p>
                )
              ) : (
                <Skeleton h={140} />
              )}
            </Panel>
            <Panel title="Approval channel">
              {a ? (
                a.approvalSources.length ? (
                  <HBarList
                    label="Approvals by channel"
                    items={a.approvalSources.map((s) => ({ label: s.source === 'cli' ? 'CLI' : s.source.charAt(0).toUpperCase() + s.source.slice(1), value: s.count }))}
                  />
                ) : (
                  <p className="muted">No approvals in this window.</p>
                )
              ) : (
                <Skeleton h={140} />
              )}
            </Panel>
          </div>
        </>
      )}
    </>
  );
}
