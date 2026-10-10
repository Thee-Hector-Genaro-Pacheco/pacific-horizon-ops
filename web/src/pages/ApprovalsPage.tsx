import { Lock, Phone, ShieldCheck, UserRound } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApprovalCard, ApprovalRoutes, CallMeButton } from '../components/ApprovalCard';
import { DetailDrawer, DrawerSection } from '../components/DetailDrawer';
import { Timeline } from '../components/ops';
import { EmptyState, ErrorState, PageHeader, Panel, Segmented, Skeleton, SkeletonRows, StatusBadge } from '../components/primitives';
import { StateMachine } from '../components/StateMachine';
import type { ActionDTO } from '../data/contract';
import { useResource } from '../data/useResource';
import { dateTime } from '../lib/format';
import { ACTION_STATUS, categoryLabel } from '../lib/status';

type View = 'pending' | 'inflight' | 'history';

const IN_FLIGHT = new Set(['APPROVED', 'EXECUTING']);

function viewOf(a: ActionDTO): View {
  if (a.status === 'AWAITING_APPROVAL') return 'pending';
  if (IN_FLIGHT.has(a.status)) return 'inflight';
  return 'history';
}

export function ApprovalsPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [view, setView] = useState<View>('pending');
  const actions = useResource((s) => s.actions.listActions(), [], ['actions']);

  const grouped = useMemo(() => {
    const out: Record<View, ActionDTO[]> = { pending: [], inflight: [], history: [] };
    for (const a of actions.data ?? []) out[viewOf(a)].push(a);
    return out;
  }, [actions.data]);

  const list = grouped[view];

  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Approvals"
        description="Everything Pacific Ops wants to do on your behalf, with what, who, why, and the current state. Nothing sends without your spoken confirmation."
      />

      <div className="toolbar">
        <Segmented
          label="Approval view"
          value={view}
          onChange={setView}
          options={[
            { value: 'pending', label: 'Awaiting approval', count: grouped.pending.length },
            { value: 'inflight', label: 'Approved · not sent', count: grouped.inflight.length },
            { value: 'history', label: 'History', count: grouped.history.length },
          ]}
        />
      </div>

      <div className="approvals-layout">
        <div className="approvals-list">
          {actions.loading ? (
            [0, 1].map((i) => (
              <div className="approval" key={i}>
                <Skeleton w="40%" h={12} />
                <Skeleton w="60%" h={18} />
                <Skeleton h={90} />
              </div>
            ))
          ) : actions.error && !actions.data ? (
            <Panel>
              <ErrorState error={actions.error} onRetry={actions.reload} />
            </Panel>
          ) : list.length === 0 ? (
            <Panel>
              <EmptyState icon={ShieldCheck} title={view === 'pending' ? 'No approvals waiting' : view === 'inflight' ? 'Nothing approved and unsent' : 'No history yet'}>
                {view === 'pending'
                  ? 'When Pacific Ops drafts a reply, it waits here until you approve it by voice.'
                  : view === 'inflight'
                    ? 'Approved actions move here until the Gmail send completes.'
                    : 'Sent, rejected and failed actions are kept here with their audit trail.'}
              </EmptyState>
            </Panel>
          ) : (
            list.map((a) => <ApprovalCard key={a.id} action={a} compact={view !== 'pending'} />)
          )}
        </div>

        <aside className="stack" aria-label="How approval works">
          <Panel title="How approval works" icon={ShieldCheck}>
            <div className="safety-card">
              <div className="safety-step">
                <b>1</b>
                <span>Pacific Ops drafts the reply in Gmail and records the action as AWAITING_APPROVAL.</span>
              </div>
              <div className="safety-step">
                <b>2</b>
                <span>
                  On a voice call you say <em>approve</em>, then <em>confirm approval</em>. Two steps, every time.
                </span>
              </div>
              <div className="safety-step">
                <b>3</b>
                <span>The exact approved draft is verified, then sent once. Repeat sends are blocked.</span>
              </div>
              <div className="safety-step">
                <b>4</b>
                <span>Every transition is appended to the audit log.</span>
              </div>
            </div>
          </Panel>
          <Panel>
            <div className="approval-note" style={{ alignItems: 'flex-start' }}>
              <Lock aria-hidden style={{ marginTop: 2 }} />
              <span>
                This dashboard is read-only. Approve and Reject show the voice and CLI commands that drive the backend state machine. There is no separate send path from the browser.
              </span>
            </div>
          </Panel>
        </aside>
      </div>

      <ActionDetail id={id} onClose={() => navigate('/approvals')} />
    </>
  );
}

function ActionDetail({ id, onClose }: { id: string | undefined; onClose: () => void }) {
  const action = useResource((s) => (id ? s.actions.getAction(id) : Promise.resolve(null)), [id], ['actions']);
  const a = action.data;
  const pending = a?.status === 'AWAITING_APPROVAL';

  return (
    <DetailDrawer
      open={!!id}
      onClose={onClose}
      eyebrow="Pacific Ops proposes · email reply"
      title={a ? `Reply to ${a.contact.name}` : action.error ? 'Action unavailable' : 'Loading…'}
      headerExtra={
        a && (
          <>
            <StatusBadge meta={ACTION_STATUS[a.status]} />
            <span className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
              {a.subject}
            </span>
          </>
        )
      }
      footer={
        a && (
          <>
            <Link to={`/customers/${encodeURIComponent(a.contact.key)}`} className="btn">
              <UserRound aria-hidden /> Customer
            </Link>
            {pending && <CallMeButton />}
          </>
        )
      }
    >
      {action.error && !a ? (
        <ErrorState error={action.error} onRetry={action.reload} compact />
      ) : !a ? (
        <SkeletonRows rows={4} />
      ) : (
        <>
          <dl className="approval-grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
            <div className="approval-cell">
              <dt>What</dt>
              <dd>{a.proposal.description}</dd>
            </div>
            <div className="approval-cell">
              <dt>Who</dt>
              <dd>{a.contact.email ?? a.contact.name}</dd>
            </div>
            <div className="approval-cell">
              <dt>Why</dt>
              <dd>
                {categoryLabel(a.category)} · {Math.round(a.confidence * 100)}% confidence
              </dd>
            </div>
            <div className="approval-cell">
              <dt>Updated</dt>
              <dd>{dateTime(a.updatedAt)}</dd>
            </div>
          </dl>

          <DrawerSection title="State machine">
            <StateMachine status={a.status} />
            {a.failureReason && (
              <p style={{ marginTop: 10, color: 'var(--fail)', fontSize: 'var(--fs-sm)' }} role="alert">
                {a.failureReason}
              </p>
            )}
          </DrawerSection>

          {a.proposal.body && (
            <DrawerSection title={a.status === 'SENT' ? 'Sent response' : 'Proposed response'}>
              <div className="proposal">{a.proposal.body}</div>
            </DrawerSection>
          )}

          {pending && (
            <DrawerSection title="Approve or reject">
              <ApprovalRoutes action={a} decision="approve" />
            </DrawerSection>
          )}

          {a.approval && (
            <DrawerSection title="Approval record">
              <dl className="kv">
                <dt>Decision</dt>
                <dd style={{ textTransform: 'capitalize' }}>{a.approval.decision}</dd>
                <dt>Source</dt>
                <dd style={{ textTransform: 'capitalize' }}>{a.approval.source}</dd>
                <dt>By</dt>
                <dd>{a.approval.by}</dd>
                <dt>At</dt>
                <dd>{dateTime(a.approval.at)}</dd>
                {a.sentAt && (
                  <>
                    <dt>Sent</dt>
                    <dd>{dateTime(a.sentAt)}</dd>
                  </>
                )}
              </dl>
            </DrawerSection>
          )}

          <DrawerSection title="Agent timeline">
            <Timeline events={a.timeline} />
          </DrawerSection>

          {a.callIds.length > 0 && (
            <DrawerSection title="Linked calls">
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {a.callIds.map((c, i) => (
                  <Link key={c} to={`/calls/${encodeURIComponent(c)}`} className="chip" style={{ color: 'var(--cyan-ice)' }}>
                    <Phone aria-hidden /> Voice call {i + 1}
                  </Link>
                ))}
              </div>
            </DrawerSection>
          )}
        </>
      )}
    </DetailDrawer>
  );
}
