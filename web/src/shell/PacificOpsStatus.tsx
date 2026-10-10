import { Inbox, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { CallMeButton } from '../components/ApprovalCard';
import { Dot } from '../components/primitives';
import type { CommandCenterDTO, SystemHealthDTO } from '../data/contract';
import { cn } from '../lib/cn';
import { relativeTime } from '../lib/format';
import { HEALTH, opsAvailability, PRESENCE_STATE } from '../lib/status';
import { useNow } from '../lib/useNow';

/**
 * Persistent Pacific Ops status: agent availability, integrations and the
 * operational counters that matter right now. Used in the top bar popover.
 */
export function PacificOpsStatus({
  health,
  summary,
  onNavigate,
}: {
  health: SystemHealthDTO | undefined;
  summary: CommandCenterDTO | undefined;
  onNavigate?: () => void;
}) {
  const now = useNow();
  const byKey = Object.fromEntries((health?.components ?? []).map((c) => [c.key, c]));
  const availability = opsAvailability(byKey.voice?.status, health?.overall);
  const presence = summary?.presence;
  const presenceMeta = presence ? PRESENCE_STATE[presence.state] : null;

  const rows: Array<{ label: string; value: string; tone: string; live?: boolean }> = [
    ...(['gmail', 'twilio'] as const).map((k) => {
      const c = byKey[k];
      const meta = c ? HEALTH[c.status] : null;
      return { label: c?.label ?? k, value: meta?.label ?? 'Checking', tone: meta?.tone ?? 'tone-idle', live: meta?.live };
    }),
    {
      label: 'Voice',
      value: byKey.voice?.status === 'online' ? 'Ready' : byKey.voice ? 'Standby' : 'Checking',
      tone: byKey.voice?.status === 'online' ? 'tone-ok' : 'tone-idle',
    },
    {
      label: 'Actions',
      value: summary ? `${summary.counts.pendingApprovals} pending` : '—',
      tone: summary && summary.counts.pendingApprovals > 0 ? 'tone-warn' : 'tone-ok',
    },
    { label: 'Last call', value: relativeTime(summary?.lastCallAt ?? null, now), tone: 'tone-idle' },
  ];

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="ops-pill-name">PACIFIC OPS</span>
        <span className={cn('ops-pill-state', availability.tone)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Dot tone={availability.tone} live={availability.live} />
          {availability.label.toUpperCase()}
        </span>
      </div>
      {presence && presenceMeta && (
        <div className={presenceMeta.tone} style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-2)' }}>
          <span className="mono" style={{ fontSize: 10, letterSpacing: '0.08em', color: 'var(--tone)', textTransform: 'uppercase' }}>
            {presenceMeta.label}
          </span>
          <div>{presence.headline}</div>
        </div>
      )}
      <ul className="health-list">
        {rows.map((r) => (
          <li key={r.label} className={r.tone} style={{ gridTemplateColumns: '12px 1fr auto', padding: '7px 0' }}>
            <Dot tone={r.tone as never} live={r.live} />
            <span className="health-label">{r.label}</span>
            <span className="health-state">{r.value}</span>
          </li>
        ))}
      </ul>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Link to="/inbox" className="btn btn--sm" onClick={onNavigate}>
          <Inbox aria-hidden /> Review inbox
        </Link>
        <Link to="/approvals" className="btn btn--sm" onClick={onNavigate}>
          <ShieldCheck aria-hidden /> Pending approvals
        </Link>
        <CallMeButton small />
      </div>
    </div>
  );
}
