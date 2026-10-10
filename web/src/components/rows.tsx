import { Eye, FilePen, Phone, PhoneMissed, Send, ShieldAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { CallDTO, InboxItemDTO } from '../data/contract';
import { cn } from '../lib/cn';
import { clockTime, duration, relativeTime } from '../lib/format';
import { categoryLabel, INBOX_STATUS, toneClass } from '../lib/status';
import { useNow } from '../lib/useNow';
import { Avatar, Dot, StatusBadge } from './primitives';

/* ------------------------------------------------------------------ */
/* EmailRow                                                             */
/* ------------------------------------------------------------------ */

function Flag({ on, icon: Icon, label, color }: { on: boolean; icon: typeof Eye; label: string; color?: string }) {
  return (
    <span className={cn(on && (color ?? 'on'))} title={`${label}: ${on ? 'yes' : 'no'}`}>
      <Icon aria-hidden />
      <span className="sr-only">
        {label}: {on ? 'yes' : 'no'}
      </span>
    </span>
  );
}

export function EmailRow({ item, to, selected }: { item: InboxItemDTO; to: string; selected?: boolean }) {
  const now = useNow();
  return (
    <Link to={to} className={cn('row', 'email-row')} aria-current={selected ? 'true' : undefined}>
      <span className="c-av">
        <Avatar name={item.sender.name} />
      </span>
      <span className="c-who row-stack">
        <span className="row-title">{item.sender.name}</span>
        <span className="row-sub">{item.fromOwner ? 'Owner account' : item.sender.email ?? ' '}</span>
      </span>
      <span className="c-subj row-stack">
        <span className="row-title" style={{ fontWeight: item.status === 'NEW' ? 650 : 500 }}>
          {item.subject}
        </span>
        <span className="row-sub">{item.summary ?? item.snippet ?? ' '}</span>
      </span>
      <span className="c-cat row-meta">{categoryLabel(item.category)}</span>
      <span className="c-flags row-flags" aria-label="Processing flags">
        <Flag on={item.reviewed} icon={Eye} label="Reviewed by Pacific Ops" />
        <Flag on={item.hasDraft} icon={FilePen} label="Draft exists" color="on-cyan" />
        <Flag on={item.approvalRequired} icon={ShieldAlert} label="Approval required" color="on-amber" />
        <Flag on={item.responded} icon={Send} label="Response sent" color="on-ok" />
      </span>
      <span className="c-status">
        <StatusBadge meta={INBOX_STATUS[item.status]} />
      </span>
      <time className="c-time row-meta" dateTime={item.receivedAt} style={{ textAlign: 'right' }}>
        {relativeTime(item.receivedAt, now)}
      </time>
    </Link>
  );
}

export const EMAIL_ROW_HEAD = ['', 'Sender', 'Subject', 'Category', 'Signals', 'Status', 'Received'];

/* ------------------------------------------------------------------ */
/* CallRow                                                              */
/* ------------------------------------------------------------------ */

export function CallRow({ call, to, selected }: { call: CallDTO; to: string; selected?: boolean }) {
  const now = useNow();
  const tone = toneClass(call.tone);
  const Icon = call.relay === 'connected' ? Phone : PhoneMissed;
  return (
    <Link to={to} className={cn('row', 'call-row')} aria-current={selected ? 'true' : undefined}>
      <span className="c-av">
        <span className={cn('avatar', tone)} style={{ color: 'var(--tone)' }} aria-hidden>
          <Icon size={14} />
        </span>
      </span>
      <span className="c-who row-stack">
        <span className="row-title">{call.mode === 'mailbox_review' ? 'Mailbox review' : 'Approval review'}</span>
        <span className="row-sub">
          {call.direction === 'outbound' ? 'Outbound' : 'Inbound'} · {call.contact.name} {call.contact.phoneMasked}
        </span>
      </span>
      <span className="c-out row-stack">
        <span className="row-title" style={{ fontWeight: 500 }}>
          <Dot tone={tone} /> <span style={{ marginLeft: 6 }}>{call.outcome}</span>
        </span>
        <span className="row-sub">{call.action?.subject ?? call.selectedMessage?.subject ?? (call.error ? call.error : 'No action linked')}</span>
      </span>
      <span className="c-dur row-meta mono">{duration(call.durationSec)}</span>
      <span className="c-relay row-meta">{call.relay === 'connected' ? 'Relay connected' : call.relay === 'unknown' ? 'Pending' : 'Not connected'}</span>
      <span className="c-status row-meta">
        {new Date(call.startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · {clockTime(call.startedAt)}
      </span>
      <time className="c-time row-meta" dateTime={call.startedAt} style={{ textAlign: 'right' }}>
        {relativeTime(call.startedAt, now)}
      </time>
    </Link>
  );
}

export const CALL_ROW_HEAD = ['', 'Call', 'Outcome', 'Duration', 'Relay', 'Started', ''];

/* ------------------------------------------------------------------ */
/* CommunicationCard (compact, Command Center)                          */
/* ------------------------------------------------------------------ */

export function CommunicationCard({ item, to }: { item: InboxItemDTO; to: string }) {
  const now = useNow();
  return (
    <Link to={to} className="row comm-row">
      <Avatar name={item.sender.name} />
      <span className="row-stack">
        <span className="row-title">
          {item.sender.name} <span className="muted" style={{ fontWeight: 400 }}>— {item.subject}</span>
        </span>
        <span className="row-sub">
          {relativeTime(item.receivedAt, now)} · {categoryLabel(item.category)}
        </span>
      </span>
      <StatusBadge meta={INBOX_STATUS[item.status]} />
    </Link>
  );
}

export function TableHead({ columns, className }: { columns: string[]; className: string }) {
  return (
    <div className={cn('table-head', 'table-head--collapsible', className)} aria-hidden>
      {columns.map((c, i) => (
        <span key={i} style={i === columns.length - 1 ? { textAlign: 'right' } : undefined}>
          {c}
        </span>
      ))}
    </div>
  );
}
