import { ArrowUpRight, Phone, ShieldOff } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DetailDrawer, DrawerSection } from '../components/DetailDrawer';
import { MetricCard } from '../components/ops';
import { Dot, EmptyState, ErrorState, PageHeader, Panel, Segmented, SkeletonRows, StatusBadge } from '../components/primitives';
import { CALL_ROW_HEAD, CallRow, TableHead } from '../components/rows';
import type { CallDTO } from '../data/contract';
import { useResource } from '../data/useResource';
import { clockTime, dateTime, duration, humanize } from '../lib/format';
import { ACTION_STATUS, toneClass } from '../lib/status';

type Filter = 'all' | 'connected' | 'approvals' | 'failed';

function matches(c: CallDTO, f: Filter): boolean {
  if (f === 'connected') return c.relay === 'connected';
  if (f === 'approvals') return c.approvalResult !== null;
  if (f === 'failed') return c.status === 'FAILED' || c.relay === 'not_connected';
  return true;
}

export function CallsPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>('all');
  const calls = useResource((s) => s.calls.listCalls(), [], ['calls']);
  const list = useMemo(() => calls.data ?? [], [calls.data]);
  const visible = list.filter((c) => matches(c, filter));

  const stats = useMemo(() => {
    const connected = list.filter((c) => c.relay === 'connected');
    const durations = connected.map((c) => c.durationSec).filter((d): d is number => d !== null);
    return {
      connected: connected.length,
      approvals: list.filter((c) => c.approvalResult === 'approved').length,
      failed: list.filter((c) => c.status === 'FAILED').length,
      avg: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
    };
  }, [list]);

  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Calls"
        description="Every Pacific Ops voice session over Twilio ConversationRelay: what was reviewed, what you decided, and how it ended."
      />

      <div className="metric-strip">
        <MetricCard label="Connected" icon={Phone} value={stats.connected} sub={`${list.length} sessions total`} loading={calls.loading} />
        <MetricCard label="Voice approvals" value={stats.approvals} sub="Approved on a call" loading={calls.loading} />
        <MetricCard label="Avg duration" value={stats.avg === null ? '—' : duration(stats.avg)} sub="Connected calls" loading={calls.loading} />
        <MetricCard label="Failed" value={stats.failed} sub="Twilio-reported failures" emphasis={stats.failed > 0 ? 'fail' : undefined} loading={calls.loading} />
      </div>

      <div className="toolbar">
        <Segmented
          label="Filter calls"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All', count: list.length },
            { value: 'connected', label: 'Connected', count: list.filter((c) => matches(c, 'connected')).length },
            { value: 'approvals', label: 'With decision', count: list.filter((c) => matches(c, 'approvals')).length },
            { value: 'failed', label: 'Failed / unanswered', count: list.filter((c) => matches(c, 'failed')).length },
          ]}
        />
      </div>

      <Panel flush className="list-panel">
        <TableHead columns={CALL_ROW_HEAD} className="call-row" />
        {calls.loading ? (
          <SkeletonRows rows={6} label="Loading calls" />
        ) : calls.error && !calls.data ? (
          <ErrorState error={calls.error} onRetry={calls.reload} />
        ) : visible.length === 0 ? (
          <EmptyState icon={Phone} title="No calls in this view">
            Calls are placed by <code className="mono">npm run voice:call</code> and appear here with their outcome.
          </EmptyState>
        ) : (
          <div role="list" aria-label="Calls">
            {visible.map((c) => (
              <div role="listitem" key={c.id}>
                <CallRow call={c} to={`/calls/${encodeURIComponent(c.id)}`} selected={c.id === id} />
              </div>
            ))}
          </div>
        )}
      </Panel>

      <CallDetail id={id} onClose={() => navigate('/calls')} />
    </>
  );
}

function CallDetail({ id, onClose }: { id: string | undefined; onClose: () => void }) {
  const call = useResource((s) => (id ? s.calls.getCall(id) : Promise.resolve(null)), [id], ['calls']);
  const c = call.data;
  const tone = c ? toneClass(c.tone) : 'tone-idle';

  return (
    <DetailDrawer
      open={!!id}
      onClose={onClose}
      eyebrow={c ? `${c.direction} · ${c.mode === 'mailbox_review' ? 'mailbox review' : 'approval review'}` : 'Call'}
      title={c ? c.outcome : call.error ? 'Call unavailable' : 'Loading…'}
      headerExtra={
        c && (
          <>
            <span className={`badge ${tone}`}>
              <Dot tone={tone} />
              {humanize(c.status)}
            </span>
            <span className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
              {dateTime(c.startedAt)}
            </span>
          </>
        )
      }
      footer={
        c?.action && (
          <Link to={`/approvals/${encodeURIComponent(c.action.id)}`} className="btn btn--primary">
            Open linked action <ArrowUpRight aria-hidden />
          </Link>
        )
      }
    >
      {call.error && !c ? (
        <ErrorState error={call.error} onRetry={call.reload} compact />
      ) : !c ? (
        <SkeletonRows rows={4} />
      ) : (
        <>
          <DrawerSection title="Session">
            <dl className="kv">
              <dt>Direction</dt>
              <dd style={{ textTransform: 'capitalize' }}>{c.direction}</dd>
              <dt>Contact</dt>
              <dd>
                {c.contact.name} <span className="mono muted">{c.contact.phoneMasked}</span>
              </dd>
              <dt>Started</dt>
              <dd>{dateTime(c.startedAt)}</dd>
              <dt>Ended</dt>
              <dd>{c.endedAt ? clockTime(c.endedAt) : c.stale ? 'No completion received' : 'In progress'}</dd>
              <dt>Duration</dt>
              <dd className="mono">{duration(c.durationSec)}</dd>
              <dt>Relay</dt>
              <dd>{c.relay === 'connected' ? 'ConversationRelay connected' : c.relay === 'unknown' ? 'Awaiting connection' : 'Never connected'}</dd>
              <dt>Conversation</dt>
              <dd className="mono" style={{ fontSize: 'var(--fs-xs)' }}>
                {c.conversationState}
              </dd>
              {c.approvalResult && (
                <>
                  <dt>Decision</dt>
                  <dd style={{ textTransform: 'capitalize', color: c.approvalResult === 'approved' ? 'var(--ok)' : undefined }}>{c.approvalResult} by voice</dd>
                </>
              )}
            </dl>
            {c.error && (
              <p role="alert" style={{ marginTop: 12, color: 'var(--fail)', fontSize: 'var(--fs-sm)' }}>
                {c.error}
              </p>
            )}
          </DrawerSection>

          {(c.action || c.selectedMessage) && (
            <DrawerSection title="Associated work">
              <div style={{ display: 'grid', gap: 8 }}>
                {c.selectedMessage && (
                  <div className="email-hero" style={{ padding: 12 }}>
                    <span className="approval-intent">Selected by voice</span>
                    <span>
                      {c.selectedMessage.sender} — {c.selectedMessage.subject}
                    </span>
                  </div>
                )}
                {c.action && (
                  <Link to={`/approvals/${encodeURIComponent(c.action.id)}`} className="email-hero" style={{ padding: 12 }}>
                    <span className="approval-intent">Action</span>
                    <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                      {c.action.subject}
                      <StatusBadge meta={ACTION_STATUS[c.action.status]} />
                    </span>
                  </Link>
                )}
              </div>
            </DrawerSection>
          )}

          <DrawerSection title="Transcript" aside={c.transcript.length ? `${c.transcript.length} turns · phone numbers masked` : undefined}>
            {c.transcript.length === 0 ? (
              <p className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
                No speech recorded for this session.
              </p>
            ) : (
              <ol className="transcript">
                {c.transcript.map((t, i) => (
                  <li key={i} className={`utt utt--${t.role}`}>
                    <span className="utt-who">{t.role === 'agent' ? 'Pacific Ops' : 'Owner'}</span>
                    <span className="utt-text">{t.text}</span>
                  </li>
                ))}
              </ol>
            )}
          </DrawerSection>

          <DrawerSection title="Call intelligence" aside="not captured yet">
            <ul className="health-list">
              {['Call summary', 'Customer intent', 'Structured extraction', 'Next action'].map((label) => (
                <li key={label} style={{ gridTemplateColumns: '12px 1fr auto' }}>
                  <ShieldOff size={11} aria-hidden style={{ color: 'var(--text-4)' }} />
                  <span className="health-label" style={{ color: 'var(--text-3)' }}>
                    {label}
                  </span>
                  <span className="health-state">Planned</span>
                </li>
              ))}
            </ul>
          </DrawerSection>
        </>
      )}
    </DetailDrawer>
  );
}
