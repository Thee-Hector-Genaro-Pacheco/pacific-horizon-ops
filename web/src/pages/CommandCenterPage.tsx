import {
  Activity,
  ArrowUpRight,
  CircleAlert,
  Inbox,
  Mail,
  Phone,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { useRef } from 'react';
import { Link } from 'react-router-dom';
import { CallMeButton } from '../components/ApprovalCard';
import { ActivityItem } from '../components/ops';
import { EmptyState, ErrorState, PageHeader, Panel, SkeletonRows, SourceBadge, StatusBadge } from '../components/primitives';
import { CommunicationCard } from '../components/rows';
import type { SystemHealthDTO } from '../data/contract';
import { useData } from '../data/DataProvider';
import { useResource } from '../data/useResource';
import { runtimeHeadline, runtimeHud } from '../data/runtime';
import { usePacificOpsRuntime } from '../data/useRuntime';
import { cn } from '../lib/cn';
import { relativeTime } from '../lib/format';
import { ACTION_STATUS, HEALTH, PRESENCE_STATE } from '../lib/status';
import { useNow } from '../lib/useNow';
import { deriveOpsFlow } from '../lib/opsFlow';
import { usePointerParallax } from '../lib/usePointerParallax';
import { PacificOpsPresence, type PresenceServiceItem, type PresenceTelemetry } from '../presence/PacificOpsPresence';

function telemetryFor(health: SystemHealthDTO | undefined): PresenceTelemetry[] {
  if (!health) return [{ label: 'Systems', value: 'CHECKING', tone: 'tone-idle' }];
  const by = Object.fromEntries(health.components.map((c) => [c.key, c]));
  const item = (key: string, label: string, online: string): PresenceTelemetry => {
    const c = by[key];
    // No signal is reported as unknown, never as healthy.
    if (!c) return { label, value: 'NO SIGNAL', tone: 'tone-idle' };
    const value = c.status === 'online' ? online : c.status === 'configured' ? 'CONFIGURED' : c.status.toUpperCase();
    return { label, value, tone: HEALTH[c.status].tone };
  };
  return [
    item('voice', 'Voice link', 'ACTIVE'),
    item('gmail', 'Gmail', 'CONNECTED'),
    item('twilio', 'Twilio', 'CONNECTED'),
    {
      label: 'Core',
      value: health.overall === 'healthy' ? 'NOMINAL' : health.overall.toUpperCase(),
      tone: health.overall === 'healthy' ? 'tone-ok' : health.overall === 'down' ? 'tone-fail' : 'tone-warn',
    },
  ];
}

export function CommandCenterPage() {
  const now = useNow();
  const { mode, refreshAll } = useData();
  const summary = useResource((s) => s.dashboard.getCommandCenter(), [], ['actions', 'inbox', 'calls']);
  const health = useResource((s) => s.dashboard.getHealth(), [], ['health']);
  const inbox = useResource((s) => s.mailbox.listInbox(), [], ['inbox']);
  const actions = useResource((s) => s.actions.listActions(), [], ['actions']);
  const activity = useResource((s) => s.activity.listActivity(12), [], ['activity']);
  const calls = useResource((s) => s.calls.listCalls(), [], ['calls']);

  const counts = summary.data?.counts;
  // The hologram follows the live Pacific Ops runtime (real voice events), never the
  // read-model summary or a timer. No live link means STANDBY / NO SIGNAL, not a stale state.
  const { runtime, view } = usePacificOpsRuntime();
  const presenceState = view.state;
  const presenceTone =
    view.signal === 'offline' ? 'tone-fail' : view.signal === 'degraded' ? 'tone-warn' : (PRESENCE_STATE[presenceState]?.tone ?? 'tone-ok');
  let statusLabel = view.label;
  if (presenceState === 'idle' && view.signal !== 'offline' && view.signal !== 'degraded') {
    if (health.data?.overall === 'down') statusLabel = 'OFFLINE';
    else if (health.data?.overall === 'degraded') statusLabel = 'DEGRADED';
  }
  const sessionHud = runtimeHud(runtime, view);
  const heroRef = useRef<HTMLElement>(null);
  usePointerParallax(heroRef);
  const sessionHeadline = runtimeHeadline(runtime, view);

  const pending = (actions.data ?? []).filter((a) => a.status === 'AWAITING_APPROVAL');
  const inFlight = (actions.data ?? []).filter((a) => a.status === 'APPROVED' || a.status === 'EXECUTING');
  const recent = (inbox.data ?? []).filter((i) => !i.fromOwner && i.category !== 'system_notification' && i.category !== 'vendor_or_marketing').slice(0, 6);

  const annotations: PresenceTelemetry[] = counts
    ? [
        { label: `${counts.needsAttention} new message${counts.needsAttention === 1 ? '' : 's'}`, tone: counts.needsAttention > 0 ? 'tone-info' : 'tone-idle' },
        {
          label: `${counts.pendingApprovals} approval${counts.pendingApprovals === 1 ? '' : 's'} required`,
          tone: counts.pendingApprovals > 0 ? 'tone-warn' : 'tone-idle',
        },
        { label: `${counts.callsToday} voice session${counts.callsToday === 1 ? '' : 's'} today`, tone: 'tone-idle' },
        ...(counts.failed > 0 ? [{ label: `${counts.failed} failed`, tone: 'tone-fail' as const }] : []),
      ]
    : [];

  const by = health.data ? Object.fromEntries(health.data.components.map((c) => [c.key, c])) : {};
  const serviceIndicators: PresenceServiceItem[] = [
    {
      name: 'GMAIL',
      tone: by.gmail ? HEALTH[by.gmail.status].tone : 'tone-idle',
      statusText: by.gmail ? `Gmail: ${by.gmail.status.toUpperCase()}` : 'Gmail: no health signal',
    },
    {
      name: 'TWILIO',
      tone: by.twilio ? HEALTH[by.twilio.status].tone : 'tone-idle',
      statusText: by.twilio ? `Twilio: ${by.twilio.status.toUpperCase()}` : 'Twilio: no health signal',
    },
    {
      name: 'VOICE',
      tone: by.voice?.status === 'online' ? 'tone-ok' : by.voice ? HEALTH[by.voice.status].tone : 'tone-idle',
      statusText: by.voice ? `Voice link: ${by.voice.status.toUpperCase()}` : 'Voice link: no health signal',
    },
  ];

  if (summary.error && !summary.data) {
    return (
      <>
        <PageHeader eyebrow="Pacific Rising Ops" title="Command Center" />
        <Panel>
          <ErrorState error={summary.error} onRetry={summary.reload} />
        </Panel>
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="Pacific Rising Ops"
        title="Command Center"
        description="Live operational state across inbox, approvals, voice and leads."
        actions={
          <>
            <SourceBadge kind={mode} />
            <button type="button" className="btn btn--ghost btn--sm" onClick={refreshAll} aria-label="Refresh all data">
              <RefreshCw aria-hidden className={summary.refreshing ? 'spin' : undefined} /> Refresh
            </button>
          </>
        }
      />

      {/* Hero card matching exact Pacific Ops architecture */}
      <section
        ref={heroRef}
        className={cn('cc-command-hero', view.sessionActive && 'is-live', view.signal !== 'live' && view.signal !== 'demo' && 'is-degraded')}
        data-presence={presenceState}
        aria-label="Pacific Ops Command Hero"
      >
        <header className="cc-command-header">
          <div className="cc-command-brand">
            <h1 className="cc-command-title">Pacific Rising Ops</h1>
            <span className="cc-command-sub">Command Center · Pacific Horizon Labs</span>
          </div>
          {view.sessionActive && (
            <span className="cc-live-chip" role="status">
              <i aria-hidden /> Live voice session
            </span>
          )}
          <div className={cn('cc-command-status', presenceTone)}>
            <div className="cc-command-status-id">
              <span>Pacific Ops</span>
              <i className={cn('dot', presenceTone, presenceState !== 'error' && 'dot--live')} aria-hidden />
            </div>
            <div className="cc-command-status-label">{statusLabel}</div>
          </div>
        </header>

        <div className="cc-command-stage">
          <PacificOpsPresence
            state={presenceState}
            systemHealth={health.data?.overall}
            headline={
              sessionHeadline ??
              (view.signal === 'offline'
                ? 'Command Center API unreachable · no live signal'
                : view.signal === 'degraded'
                  ? 'Live link interrupted · reconnecting'
                  : counts && counts.needsAttention > 0
                    ? `${counts.needsAttention} new business message${counts.needsAttention === 1 ? '' : 's'}`
                    : 'Standing by')
            }
            telemetry={sessionHud ?? telemetryFor(health.data)}
            annotations={annotations}
            services={serviceIndicators}
            hideStatusPill
          />
        </div>

        <ol className="cc-flow" aria-label="Operational flow">
          {deriveOpsFlow(runtime, view.sessionActive, counts).map((stage) => (
            <li key={stage.key} className={cn('cc-flow-stage', `is-${stage.status}`)}>
              <span className="cc-flow-node" aria-hidden />
              <span className="cc-flow-label">{stage.label}</span>
              {stage.detail && <span className="cc-flow-detail">{stage.detail}</span>}
            </li>
          ))}
        </ol>

        <footer className="cc-command-ribbon" aria-label="Operational metrics">
          <Link to="/inbox" className="cc-ribbon-col">
            <span className="cc-ribbon-label">Inbox</span>
            <span className="cc-ribbon-value">{counts?.inbox ?? '—'}</span>
            <span className="cc-ribbon-sub">
              {!counts ? 'No data' : counts.needsAttention ? `${counts.needsAttention} need attention` : 'Inbox nominal'}
            </span>
          </Link>
          <Link
            to="/approvals"
            className={cn('cc-ribbon-col', counts && counts.pendingApprovals > 0 && 'cc-ribbon-col--alert')}
          >
            <span className="cc-ribbon-label">Approvals</span>
            <span className="cc-ribbon-value">{counts?.pendingApprovals ?? 0}</span>
            <span className={cn('cc-ribbon-sub', counts && counts.pendingApprovals > 0 && 'alert')}>
              {!counts ? 'No data' : counts.pendingApprovals > 0 ? 'Approval required' : 'Nothing waiting'}
            </span>
          </Link>
          <Link to="/leads" className="cc-ribbon-col">
            <span className="cc-ribbon-label">Leads</span>
            <span className="cc-ribbon-value">{counts?.activeLeads ?? '—'}</span>
            <span className="cc-ribbon-sub">Active pipeline</span>
          </Link>
          <Link to="/calls" className="cc-ribbon-col">
            <span className="cc-ribbon-label">Calls</span>
            <span className="cc-ribbon-value">{counts?.callsToday ?? counts?.calls ?? '—'}</span>
            <span className="cc-ribbon-sub">
              {summary.data?.lastCallAt ? `Last ${relativeTime(summary.data.lastCallAt, now)}` : counts ? `${counts.callsToday} sessions today` : 'No data'}
            </span>
          </Link>
        </footer>
      </section>

      {counts && counts.pendingApprovals > 0 && (
        <aside className="cc-action-banner" role="alert">
          <div className="cc-action-banner-info">
            <i className="dot tone-warn dot--live" aria-hidden />
            <div>
              <span className="cc-action-banner-title">Approval required</span>
              <span className="cc-action-banner-desc">
                {counts.pendingApprovals} reply draft{counts.pendingApprovals === 1 ? '' : 's'} waiting on owner review
              </span>
            </div>
          </div>
          <div className="cc-action-banner-actions">
            <Link to="/approvals" className="btn btn--sm btn--primary">
              <ShieldCheck aria-hidden /> Review approvals
            </Link>
            <CallMeButton small />
          </div>
        </aside>
      )}

      <div className="cc-telemetry-bar">
        <div className="cc-telemetry-items">
          <span className="cc-telemetry-item">
            <i className={cn('dot', !health.data ? 'tone-idle' : health.data.overall === 'healthy' ? 'tone-ok' : 'tone-warn')} aria-hidden />
            <span>Core: <strong>{health.data?.overall?.toUpperCase() ?? 'NO SIGNAL'}</strong></span>
          </span>
          <span className="cc-telemetry-item">
            <span>Last agent cycle: <strong>{relativeTime(summary.data?.lastAgentRunAt ?? null, now)}</strong></span>
          </span>
          <span className="cc-telemetry-item">
            <span>Health check: <strong>{health.data ? relativeTime(health.data.components[0]?.checkedAt, now) : '—'}</strong></span>
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Link to="/settings#presence" className="btn btn--ghost btn--xs" style={{ fontSize: 10.5 }}>
            Presence Lab →
          </Link>
        </div>
      </div>

      <div className="grid-2" style={{ marginBottom: 'var(--s-4)' }}>
        <Panel
          title="Recent communications"
          icon={Mail}
          id="cc-comms"
          flush
          actions={
            <Link to="/inbox" className="btn btn--ghost btn--sm">
              Inbox <ArrowUpRight aria-hidden />
            </Link>
          }
        >
          {inbox.loading ? (
            <SkeletonRows rows={5} />
          ) : inbox.error && !inbox.data ? (
            <ErrorState error={inbox.error} onRetry={inbox.reload} compact />
          ) : recent.length === 0 ? (
            <EmptyState icon={Inbox} title="No business messages yet" compact>
              New customer email will appear here as soon as Pacific Ops triages it.
            </EmptyState>
          ) : (
            <div>
              {recent.map((item) => (
                <CommunicationCard key={item.id} item={item} to={`/inbox/${encodeURIComponent(item.id)}`} />
              ))}
            </div>
          )}
        </Panel>

        <Panel
          title="Pending actions"
          icon={ShieldCheck}
          count={pending.length + inFlight.length}
          id="cc-pending"
          flush
          actions={
            <Link to="/approvals" className="btn btn--ghost btn--sm">
              Approvals <ArrowUpRight aria-hidden />
            </Link>
          }
        >
          {actions.loading ? (
            <SkeletonRows rows={3} />
          ) : actions.error && !actions.data ? (
            <ErrorState error={actions.error} onRetry={actions.reload} compact />
          ) : pending.length + inFlight.length === 0 ? (
            <EmptyState icon={ShieldCheck} title="Nothing waiting on you" compact>
              Drafted replies that need approval will queue here.
            </EmptyState>
          ) : (
            <div>
              {[...pending, ...inFlight].slice(0, 5).map((a) => (
                <div className="pending-row" key={a.id}>
                  <div className="row-stack">
                    <span className="row-title">
                      {a.contact.name} <span className="muted" style={{ fontWeight: 400 }}>— Reply draft</span>
                    </span>
                    <span className="row-sub">{a.subject}</span>
                    <span style={{ marginTop: 6 }}>
                      <StatusBadge meta={ACTION_STATUS[a.status]} />
                    </span>
                  </div>
                  <div className="pending-actions">
                    <Link to={`/approvals/${encodeURIComponent(a.id)}`} className="btn btn--sm btn--primary">
                      Review
                    </Link>
                    {a.status === 'AWAITING_APPROVAL' && <CallMeButton small />}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <div className="grid-2">
        <Panel
          title="Live agent activity"
          icon={Activity}
          id="cc-activity"
          flush
          actions={
            <Link to="/activity" className="btn btn--ghost btn--sm">
              All activity <ArrowUpRight aria-hidden />
            </Link>
          }
        >
          {activity.loading ? (
            <SkeletonRows rows={6} />
          ) : activity.error && !activity.data ? (
            <ErrorState error={activity.error} onRetry={activity.reload} compact />
          ) : (activity.data ?? []).length === 0 ? (
            <EmptyState icon={Activity} title="No agent activity yet" compact />
          ) : (
            <ul className="activity-list" style={{ padding: '6px 0' }}>
              {activity.data!.map((a) => (
                <ActivityItem key={a.id} item={a} />
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="Recent calls"
          icon={Phone}
          id="cc-calls"
          flush
          actions={
            <Link to="/calls" className="btn btn--ghost btn--sm">
              Calls <ArrowUpRight aria-hidden />
            </Link>
          }
        >
          {calls.loading ? (
            <SkeletonRows rows={4} />
          ) : calls.error && !calls.data ? (
            <ErrorState error={calls.error} onRetry={calls.reload} compact />
          ) : (calls.data ?? []).length === 0 ? (
            <EmptyState icon={Phone} title="No calls yet" compact>
              Owner review calls placed by Pacific Ops will be listed here.
            </EmptyState>
          ) : (
            <div>
              {calls.data!.slice(0, 5).map((c) => (
                <Link key={c.id} to={`/calls/${encodeURIComponent(c.id)}`} className="row comm-row">
                  <span className={`avatar ${c.tone === 'success' ? 'tone-ok' : c.tone === 'failure' ? 'tone-fail' : 'tone-idle'}`} style={{ color: 'var(--tone)' }} aria-hidden>
                    {c.tone === 'failure' ? <CircleAlert size={14} /> : <Phone size={14} />}
                  </span>
                  <span className="row-stack">
                    <span className="row-title">{c.outcome}</span>
                    <span className="row-sub">
                      {c.mode === 'mailbox_review' ? 'Mailbox review' : 'Approval review'} · {relativeTime(c.startedAt, now)}
                    </span>
                  </span>
                  <span className="row-meta mono">{c.durationSec !== null ? `${Math.floor(c.durationSec / 60)}:${String(c.durationSec % 60).padStart(2, '0')}` : '—'}</span>
                </Link>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
