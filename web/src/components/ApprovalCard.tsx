import { ArrowUpRight, BadgeCheck, CircleX, Lock, PhoneOutgoing, ShieldCheck, Sparkles } from 'lucide-react';
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ActionDTO } from '../data/contract';
import { useData } from '../data/DataProvider';
import { cn } from '../lib/cn';
import { relativeTime } from '../lib/format';
import { ACTION_STATUS, categoryLabel } from '../lib/status';
import { useNow } from '../lib/useNow';
import { CopyCommand, StatusBadge, Tooltip } from './primitives';

/**
 * Approval routes. The dashboard is intentionally read-only: approving and sending
 * remain on the existing voice flow (approve -> confirm approval -> exact-draft send)
 * and the CLI, which both go through the deterministic action state machine.
 */
export function ApprovalRoutes({ action, decision }: { action: ActionDTO; decision: 'approve' | 'reject' | null }) {
  const { mode } = useData();
  if (mode === 'demo') {
    return (
      <div className="approval-note" style={{ padding: '10px 12px', border: '1px dashed var(--line-2)', borderRadius: 'var(--r-md)' }}>
        <Lock aria-hidden /> Demo record. Approval commands are only shown for live actions.
      </div>
    );
  }
  return (
    <div style={{ display: 'grid', gap: 12, padding: 14, borderRadius: 'var(--r-md)', background: 'var(--bg-1)', border: '1px solid var(--line-2)' }}>
      <div style={{ display: 'grid', gap: 6 }}>
        <div className="approval-intent" style={{ color: 'var(--cyan)' }}>
          Voice · approves and sends
        </div>
        <p className="dim" style={{ fontSize: 'var(--fs-sm)' }}>
          Pacific Ops calls you and reads the exact draft. You say <em>approve</em>, then <em>confirm approval</em>. It verifies the draft and sends it once.
        </p>
        <CopyCommand command={`npm run voice:call -- ${action.id}`} label="Start a voice approval call" />
      </div>
      <div style={{ display: 'grid', gap: 6 }}>
        <div className="approval-intent">CLI · records decision only</div>
        <p className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
          Moves the action to {decision === 'reject' ? 'REJECTED' : 'APPROVED'} with an audit event. It does not send email.
        </p>
        <CopyCommand
          command={`npm run approvals:${decision === 'reject' ? 'reject' : 'approve'} -- ${action.id}`}
          label={decision === 'reject' ? 'Reject via CLI' : 'Approve via CLI'}
        />
      </div>
    </div>
  );
}

export function CallMeButton({ small }: { small?: boolean }) {
  return (
    <Tooltip content="Dashboard-initiated calls are disabled. Start a call with npm run voice:call from the server.">
      <button type="button" className={cn('btn', small && 'btn--sm')} disabled aria-disabled="true">
        <PhoneOutgoing aria-hidden />
        Call me
        <Lock size={11} aria-hidden style={{ marginLeft: 2 }} />
      </button>
    </Tooltip>
  );
}

export function ApprovalCard({ action, compact }: { action: ActionDTO; compact?: boolean }) {
  const now = useNow();
  const [decision, setDecision] = useState<'approve' | 'reject' | null>(null);
  const routesId = useId();
  const pending = action.status === 'AWAITING_APPROVAL';
  const meta = ACTION_STATUS[action.status];

  return (
    <article className={cn('approval', pending && 'approval--pending')} aria-label={`Reply to ${action.contact.name}: ${action.subject}`}>
      <div className="approval-head">
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="approval-intent">Pacific Ops proposes · email reply</div>
          <h3 className="approval-title">Reply to {action.contact.name}</h3>
          <div className="approval-subject">{action.subject}</div>
        </div>
        <StatusBadge meta={meta} />
      </div>

      {!compact && (
        <dl className="approval-grid">
          <div className="approval-cell">
            <dt>What</dt>
            <dd>Send drafted reply</dd>
          </div>
          <div className="approval-cell">
            <dt>Who</dt>
            <dd title={action.contact.email ?? undefined}>{action.contact.email ?? action.contact.name}</dd>
          </div>
          <div className="approval-cell">
            <dt>Why</dt>
            <dd>
              {categoryLabel(action.category)} · {Math.round(action.confidence * 100)}%
            </dd>
          </div>
          <div className="approval-cell">
            <dt>State</dt>
            <dd>
              {meta.label} · {relativeTime(action.updatedAt, now)}
            </dd>
          </div>
        </dl>
      )}

      {action.proposal.body && (
        <div>
          <div className="proposal-label">
            <Sparkles aria-hidden /> Proposed response
          </div>
          <div className={cn('proposal', compact && 'proposal--clamped')}>{action.proposal.body}</div>
        </div>
      )}

      <div className="approval-actions">
        <Link to={`/approvals/${encodeURIComponent(action.id)}`} className="btn btn--primary">
          Review <ArrowUpRight aria-hidden />
        </Link>
        {pending && (
          <>
            <button
              type="button"
              className="btn"
              aria-expanded={decision === 'approve'}
              aria-controls={routesId}
              onClick={() => setDecision((d) => (d === 'approve' ? null : 'approve'))}
            >
              <BadgeCheck aria-hidden /> Approve
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              aria-expanded={decision === 'reject'}
              aria-controls={routesId}
              onClick={() => setDecision((d) => (d === 'reject' ? null : 'reject'))}
            >
              <CircleX aria-hidden /> Reject
            </button>
            <CallMeButton />
          </>
        )}
        {!pending && action.approval && (
          <span className="approval-note">
            <ShieldCheck aria-hidden />
            {action.approval.decision === 'approved' ? 'Approved' : 'Rejected'} via {action.approval.source} · {relativeTime(action.approval.at, now)}
          </span>
        )}
      </div>

      {decision && (
        <div id={routesId}>
          <ApprovalRoutes action={action} decision={decision} />
        </div>
      )}
    </article>
  );
}
