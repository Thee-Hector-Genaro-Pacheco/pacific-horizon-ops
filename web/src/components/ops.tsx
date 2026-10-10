import {
  BadgeCheck,
  Bot,
  CircleCheck,
  CircleX,
  FilePen,
  Inbox,
  Mail,
  MailOpen,
  NotebookPen,
  Phone,
  PhoneCall,
  PhoneOff,
  PhoneOutgoing,
  Send,
  ShieldAlert,
  Tags,
  Target,
  TriangleAlert,
  Trash2,
  Waypoints,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ActivityDTO, ActivityKind, SystemComponentDTO, TimelineEventDTO } from '../data/contract';
import { cn } from '../lib/cn';
import { clockTime, relativeTime, shortDate } from '../lib/format';
import { HEALTH, toneClass, type ToneClass } from '../lib/status';
import { useNow } from '../lib/useNow';
import { Dot } from './primitives';

/* ------------------------------------------------------------------ */
/* MetricCard                                                           */
/* ------------------------------------------------------------------ */

export function MetricCard({
  label,
  value,
  unit,
  sub,
  icon: Icon,
  to,
  emphasis,
  loading,
}: {
  label: string;
  value: number | string | null | undefined;
  unit?: string;
  sub?: ReactNode;
  icon?: LucideIcon;
  to?: string;
  emphasis?: 'attention' | 'fail';
  loading?: boolean;
}) {
  const body = (
    <>
      {emphasis && <span className="metric-accent" style={{ ['--tone' as string]: emphasis === 'fail' ? 'var(--fail)' : 'var(--amber)' }} />}
      <span className="metric-label">
        {Icon && <Icon aria-hidden />}
        {label}
      </span>
      <span className="metric-value">
        {loading ? <span className="skeleton" style={{ display: 'inline-block', width: 44, height: 26 }} /> : value ?? '—'}
        {!loading && unit && <small>{unit}</small>}
      </span>
      {sub && <span className="metric-sub">{sub}</span>}
    </>
  );
  const cls = cn('metric', emphasis === 'attention' && 'metric--attention', emphasis === 'fail' && 'metric--fail');
  return to ? (
    <Link to={to} className={cls} aria-label={`${label}: ${value ?? 'unknown'}`}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/* ------------------------------------------------------------------ */
/* SystemHealthIndicator                                                */
/* ------------------------------------------------------------------ */

export function SystemHealthIndicator({ component, variant = 'inline' }: { component: SystemComponentDTO; variant?: 'inline' | 'row' }) {
  const meta = HEALTH[component.status];
  if (variant === 'row') {
    return (
      <li className={meta.tone}>
        <Dot tone={meta.tone} live={meta.live} />
        <div style={{ minWidth: 0 }}>
          <div className="health-label">{component.label}</div>
          <div className="health-detail">{component.detail}</div>
        </div>
        <span className="health-state">{meta.label}</span>
      </li>
    );
  }
  return (
    <span className={cn('health', meta.tone)} title={component.detail}>
      <Dot tone={meta.tone} live={meta.live} />
      <span className="health-label">{component.label}</span>
      <span className="health-state">{meta.label}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Activity + timeline                                                  */
/* ------------------------------------------------------------------ */

export const ACTIVITY_ICON: Record<ActivityKind, LucideIcon> = {
  email_received: Mail,
  email_classified: Tags,
  email_triaged: MailOpen,
  lead_identified: Target,
  draft_generated: FilePen,
  approval_requested: ShieldAlert,
  approval_confirmed: BadgeCheck,
  approval_rejected: CircleX,
  execution_started: Waypoints,
  email_sent: Send,
  execution_failed: TriangleAlert,
  call_initiated: PhoneOutgoing,
  call_connected: PhoneCall,
  call_completed: Phone,
  call_failed: PhoneOff,
  voice_turn: Bot,
  mailbox_plan: Trash2,
  note: NotebookPen,
};

function refHref(ref: ActivityDTO['ref']): string | null {
  if (!ref) return null;
  switch (ref.type) {
    case 'action':
      return `/approvals/${encodeURIComponent(ref.id)}`;
    case 'call':
      return `/calls/${encodeURIComponent(ref.id)}`;
    case 'inbox':
      return `/inbox/${encodeURIComponent(ref.id)}`;
    default:
      return null;
  }
}

export function ActivityItem({ item, isNew, compact }: { item: ActivityDTO; isNew?: boolean; compact?: boolean }) {
  const now = useNow();
  const Icon = ACTIVITY_ICON[item.kind] ?? CircleCheck;
  const tone: ToneClass = toneClass(item.tone);
  const href = refHref(item.ref);
  const content = (
    <>
      <span className="activity-rail" aria-hidden />
      <span className={cn('activity-icon', tone)} aria-hidden>
        <Icon />
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="activity-title">{item.title}</div>
        {!compact && (item.subject || item.detail) && (
          <div className="activity-detail">{[item.subject, item.detail].filter(Boolean).join(' · ')}</div>
        )}
        <div className="activity-meta">
          <span>{item.actor}</span>
        </div>
      </div>
      <time className="activity-time" dateTime={item.at} title={new Date(item.at).toLocaleString()}>
        {relativeTime(item.at, now)}
      </time>
    </>
  );
  const cls = cn('activity', isNew && 'is-new', href && 'activity--link');
  return (
    <li>
      {href ? (
        <Link to={href} className={cls} aria-label={`${item.title}${item.subject ? `, ${item.subject}` : ''}`}>
          {content}
        </Link>
      ) : (
        <div className={cls}>{content}</div>
      )}
    </li>
  );
}

export function TimelineEvent({ event, strong }: { event: TimelineEventDTO; strong?: boolean }) {
  const Icon = ACTIVITY_ICON[event.kind] ?? CircleCheck;
  const tone = toneClass(event.tone);
  return (
    <li className={cn('tl-event', tone, strong && 'is-strong')}>
      <time className="tl-time" dateTime={event.at}>
        {clockTime(event.at)}
        <span>{shortDate(event.at)}</span>
      </time>
      <span className="tl-node" aria-hidden>
        <i />
      </span>
      <div className="tl-body">
        <div className="tl-title">
          <Icon aria-hidden />
          {event.title}
        </div>
        {event.detail && <div className="tl-detail">{event.detail}</div>}
        <div className="tl-actor">{event.actor}</div>
      </div>
    </li>
  );
}

export function Timeline({ events, emptyLabel = 'No events recorded yet.' }: { events: TimelineEventDTO[]; emptyLabel?: string }) {
  if (events.length === 0) {
    return (
      <p className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
        <Inbox size={13} aria-hidden style={{ verticalAlign: -2, marginRight: 6 }} />
        {emptyLabel}
      </p>
    );
  }
  return (
    <ol className="timeline" aria-label="Timeline">
      {events.map((e, i) => (
        <TimelineEvent key={e.id} event={e} strong={i === events.length - 1 || e.tone === 'success' || e.tone === 'failure'} />
      ))}
    </ol>
  );
}
