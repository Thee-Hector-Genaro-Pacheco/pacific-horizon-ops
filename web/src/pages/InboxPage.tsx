import { ArrowUpRight, Eye, FilePen, Inbox, Mail, Phone, Send, ShieldAlert, Sparkles, UserRound } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DetailDrawer, DrawerSection } from '../components/DetailDrawer';
import { Timeline } from '../components/ops';
import { Chip, EmptyState, ErrorState, PageHeader, Panel, SearchField, Segmented, SkeletonRows, StatusBadge } from '../components/primitives';
import { EMAIL_ROW_HEAD, EmailRow, TableHead } from '../components/rows';
import { StateMachine } from '../components/StateMachine';
import type { InboxItemDTO, TimelineEventDTO } from '../data/contract';
import { useResource } from '../data/useResource';
import { cn } from '../lib/cn';
import { dateTime, humanize } from '../lib/format';
import { categoryLabel, INBOX_STATUS } from '../lib/status';

type Filter = 'business' | 'attention' | 'approval' | 'sent' | 'all';

const AUTOMATED = new Set(['system_notification', 'vendor_or_marketing']);
const AUTOMATED_SENDER = /(no-?reply|notifications?|notify|mailer-daemon)@/i;

function matches(item: InboxItemDTO, filter: Filter): boolean {
  switch (filter) {
    case 'business':
      return !item.fromOwner && !AUTOMATED.has(item.category ?? '') && !AUTOMATED_SENDER.test(item.sender.email ?? '');
    case 'attention':
      return item.status === 'NEW' || (item.status === 'REVIEWED' && item.requiresResponse === true);
    case 'approval':
      return item.status === 'AWAITING_APPROVAL' || item.status === 'APPROVED' || item.status === 'EXECUTING';
    case 'sent':
      return item.status === 'SENT';
    default:
      return true;
  }
}

export function InboxPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>('business');
  const [query, setQuery] = useState('');
  const inbox = useResource((s) => s.mailbox.listInbox(), [], ['inbox']);

  const counts = useMemo(() => {
    const list = inbox.data ?? [];
    return {
      business: list.filter((i) => matches(i, 'business')).length,
      attention: list.filter((i) => matches(i, 'attention')).length,
      approval: list.filter((i) => matches(i, 'approval')).length,
      sent: list.filter((i) => matches(i, 'sent')).length,
      all: list.length,
    };
  }, [inbox.data]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (inbox.data ?? []).filter(
      (i) =>
        matches(i, filter) &&
        (!q || `${i.sender.name} ${i.sender.email ?? ''} ${i.subject} ${i.summary ?? ''}`.toLowerCase().includes(q))
    );
  }, [inbox.data, filter, query]);

  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Inbox"
        description="Business email as Pacific Ops sees it: triage, drafts, approvals and replies, in one operational view."
      />

      <div className="toolbar">
        <Segmented
          label="Filter messages"
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'business', label: 'Business', count: counts.business },
            { value: 'attention', label: 'Needs attention', count: counts.attention },
            { value: 'approval', label: 'In approval', count: counts.approval },
            { value: 'sent', label: 'Replied', count: counts.sent },
            { value: 'all', label: 'All', count: counts.all },
          ]}
        />
        <span className="toolbar-spacer" />
        <SearchField value={query} onChange={setQuery} placeholder="Search sender, subject…" label="Search inbox" />
      </div>

      <Panel flush className="list-panel">
        <TableHead columns={EMAIL_ROW_HEAD} className="email-row" />
        {inbox.loading ? (
          <SkeletonRows rows={8} label="Loading inbox" />
        ) : inbox.error && !inbox.data ? (
          <ErrorState error={inbox.error} onRetry={inbox.reload} />
        ) : visible.length === 0 ? (
          <EmptyState icon={Inbox} title={query ? 'No matching messages' : 'Nothing in this view'}>
            {query ? 'Try a different name or subject.' : 'Messages appear here after Pacific Ops triages the business inbox.'}
          </EmptyState>
        ) : (
          <div role="list" aria-label="Messages">
            {visible.map((item) => (
              <div role="listitem" key={item.id}>
                <EmailRow item={item} to={`/inbox/${encodeURIComponent(item.id)}`} selected={item.id === id} />
              </div>
            ))}
          </div>
        )}
      </Panel>

      <InboxDetail id={id} onClose={() => navigate('/inbox')} />
    </>
  );
}

function InboxDetail({ id, onClose }: { id: string | undefined; onClose: () => void }) {
  const item = useResource((s) => (id ? s.mailbox.getInboxItem(id) : Promise.resolve(null)), [id], ['inbox']);
  const actionId = item.data?.actionId ?? null;
  const action = useResource((s) => (actionId ? s.actions.getAction(actionId) : Promise.resolve(null)), [actionId], ['actions']);
  const m = item.data;

  const timeline: TimelineEventDTO[] = action.data?.timeline ??
    (m
      ? [
          { id: 'rx', at: m.receivedAt, kind: 'email_received', title: 'Email received', detail: null, actor: m.sender.name, tone: 'neutral' },
          ...(m.summary
            ? [{ id: 'cl', at: m.receivedAt, kind: 'email_classified' as const, title: 'Classified', detail: categoryLabel(m.category), actor: 'Classifier', tone: 'neutral' as const }]
            : []),
        ]
      : []);

  return (
    <DetailDrawer
      open={!!id}
      onClose={onClose}
      eyebrow={m ? `${categoryLabel(m.category)} · ${dateTime(m.receivedAt)}` : 'Message'}
      title={m?.subject ?? (item.error ? 'Message unavailable' : 'Loading…')}
      headerExtra={m && <StatusBadge meta={INBOX_STATUS[m.status]} />}
      footer={
        m && (
          <>
            {m.actionId && (
              <Link to={`/approvals/${encodeURIComponent(m.actionId)}`} className="btn btn--primary">
                Open action <ArrowUpRight aria-hidden />
              </Link>
            )}
            {!m.fromOwner && (
              <Link to={`/customers/${encodeURIComponent(m.sender.key)}`} className="btn">
                <UserRound aria-hidden /> Customer profile
              </Link>
            )}
          </>
        )
      }
    >
      {item.error && !m ? (
        <ErrorState error={item.error} onRetry={item.reload} compact />
      ) : !m ? (
        <SkeletonRows rows={4} />
      ) : (
        <>
          <DrawerSection title="Pacific Ops summary">
            <div className="ai-summary">
              <div className="proposal-label">
                <Sparkles aria-hidden /> Assessment
              </div>
              {m.summary ?? 'Not classified by the triage agent yet. It was seen during a voice mailbox review.'}
              {m.missingInformation.length > 0 && (
                <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <span className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
                    Missing:
                  </span>
                  {m.missingInformation.map((x) => (
                    <Chip key={x}>{x}</Chip>
                  ))}
                </div>
              )}
            </div>
          </DrawerSection>

          <div className="signal-grid" aria-label="Processing signals">
            {[
              { on: m.reviewed, icon: Eye, label: 'Reviewed', yes: 'By Pacific Ops', no: 'Not yet', tone: 'tone-info' },
              { on: m.hasDraft, icon: FilePen, label: 'Draft', yes: 'In Gmail', no: 'None', tone: 'tone-info' },
              { on: m.approvalRequired, icon: ShieldAlert, label: 'Approval', yes: 'Required', no: 'Not pending', tone: 'tone-warn' },
              { on: m.responded, icon: Send, label: 'Response', yes: 'Sent', no: 'Not sent', tone: 'tone-ok' },
            ].map((sig) => (
              <div key={sig.label} className={cn('signal', sig.on && 'on', sig.on && sig.tone)}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <sig.icon size={12} aria-hidden /> {sig.label}
                </span>
                <strong>{sig.on ? sig.yes : sig.no}</strong>
              </div>
            ))}
          </div>

          {m.snippet && (
            <DrawerSection title="Original email" aside="excerpt · full message stays in Gmail">
              <div className="proposal" style={{ fontSize: 'var(--fs-base)' }}>
                {m.snippet}
              </div>
            </DrawerSection>
          )}

          <DrawerSection title="Sender">
            <dl className="kv">
              <dt>Name</dt>
              <dd>{m.sender.name}</dd>
              <dt>Email</dt>
              <dd>{m.fromOwner ? 'Owner account' : m.sender.email ?? '—'}</dd>
              <dt>Category</dt>
              <dd>{categoryLabel(m.category)}</dd>
              <dt>Priority</dt>
              <dd>{humanize(m.priority)}</dd>
              {m.event && (
                <>
                  <dt>Event</dt>
                  <dd>{[m.event.type, m.event.date, m.event.location].filter(Boolean).join(' · ') || '—'}</dd>
                </>
              )}
            </dl>
          </DrawerSection>

          {action.data?.proposal.body && (
            <DrawerSection title="Proposed response">
              <div className="proposal">{action.data.proposal.body}</div>
            </DrawerSection>
          )}

          {action.data && (
            <DrawerSection title="Current action state">
              <StateMachine status={action.data.status} />
            </DrawerSection>
          )}

          <DrawerSection title="Agent timeline">
            <Timeline events={timeline} />
          </DrawerSection>

          <DrawerSection title="Thread history" aside="linked records">
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {m.observedIn.map((o) => (
                <Chip key={o} icon={o === 'voice_review' ? Phone : o === 'action' ? ShieldAlert : Mail}>
                  {o === 'triage' ? 'Triage run' : o === 'voice_review' ? 'Voice mailbox review' : 'Action record'}
                </Chip>
              ))}
              {m.callIds.map((c, i) => (
                <Link key={c} to={`/calls/${encodeURIComponent(c)}`} className="chip" style={{ color: 'var(--cyan-ice)' }}>
                  <Phone aria-hidden /> Call {i + 1}
                </Link>
              ))}
            </div>
          </DrawerSection>
        </>
      )}
    </DetailDrawer>
  );
}
