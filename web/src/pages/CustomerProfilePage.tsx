import { ArrowLeft, ArrowRight, CalendarDays, CreditCard, FileText, Mail, MapPin, MessageSquare, NotebookPen, Phone, Ticket, Users } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { Timeline } from '../components/ops';
import { Avatar, Chip, EmptyState, ErrorState, Panel, SkeletonRows, SourceBadge, StatusBadge } from '../components/primitives';
import type { ActivityKind } from '../data/contract';
import { useResource } from '../data/useResource';
import { dateTime, pluralize } from '../lib/format';
import { LEAD_STAGE } from '../lib/status';

const EMAIL_KINDS = new Set<ActivityKind>(['email_received', 'email_classified', 'draft_generated', 'email_sent', 'approval_requested', 'approval_confirmed', 'approval_rejected', 'execution_started']);
const CALL_KINDS = new Set<ActivityKind>(['call_initiated', 'call_connected', 'call_completed', 'call_failed', 'voice_turn']);

export function CustomerProfilePage() {
  const { id = '' } = useParams();
  const customer = useResource((s) => s.leads.getCustomer(id), [id], ['inbox', 'actions', 'calls']);
  const c = customer.data;
  const lead = c?.lead ?? null;
  const kinds = new Set(c?.timeline.map((t) => t.kind) ?? []);
  const hasEmail = [...kinds].some((k) => EMAIL_KINDS.has(k));
  const hasCall = [...kinds].some((k) => CALL_KINDS.has(k));

  const channels = [
    { label: 'Email', icon: Mail, active: hasEmail },
    { label: 'Call', icon: Phone, active: hasCall },
    { label: 'SMS', icon: MessageSquare, active: false },
    { label: 'Quote', icon: FileText, active: false },
    { label: 'Booking', icon: Ticket, active: lead?.stage === 'BOOKED' },
    { label: 'Payment', icon: CreditCard, active: false },
    { label: 'Note', icon: NotebookPen, active: kinds.has('note') },
  ];

  return (
    <>
      <Link to="/customers" className="btn btn--ghost btn--sm" style={{ marginBottom: 16 }}>
        <ArrowLeft aria-hidden /> Customers
      </Link>

      {customer.error && !c ? (
        <Panel>
          <ErrorState error={customer.error} onRetry={customer.reload} />
        </Panel>
      ) : !c ? (
        <Panel>
          <SkeletonRows rows={5} label="Loading customer" />
        </Panel>
      ) : (
        <div className="profile">
          <Panel>
            <div className="profile-card">
              <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
                <Avatar name={c.name} size="lg" />
                <div style={{ minWidth: 0 }}>
                  <h1 className="profile-name">{c.name}</h1>
                  <div className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
                    {c.email ?? 'No email on file'}
                  </div>
                </div>
              </div>

              {lead && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <StatusBadge meta={LEAD_STAGE[lead.stage]} />
                  {lead.derived && <SourceBadge kind="derived" />}
                </div>
              )}

              <div className="profile-facts">
                {lead?.eventType && <div>{lead.eventType}</div>}
                {lead?.eventDate && (
                  <div>
                    <CalendarDays aria-hidden /> {lead.eventDate}
                  </div>
                )}
                {lead?.location && (
                  <div>
                    <MapPin aria-hidden /> {lead.location}
                  </div>
                )}
                {lead?.guestCount && (
                  <div>
                    <Users aria-hidden /> {lead.guestCount} guests
                  </div>
                )}
                {!lead && <div className="muted">Not a booking lead</div>}
              </div>

              {lead?.nextAction && (
                <div className="lead-next" style={{ fontSize: 'var(--fs-sm)' }}>
                  <ArrowRight aria-hidden />
                  Next: {lead.nextAction}
                </div>
              )}

              {lead?.notes && (
                <div>
                  <div className="section-label">Notes</div>
                  <p className="dim" style={{ fontSize: 'var(--fs-sm)' }}>
                    {lead.notes}
                  </p>
                </div>
              )}

              <dl className="kv">
                <dt>First seen</dt>
                <dd>{dateTime(c.firstSeenAt)}</dd>
                <dt>Last contact</dt>
                <dd>{dateTime(c.lastSeenAt)}</dd>
                <dt>Messages</dt>
                <dd>{pluralize(c.messageCount, 'message')}</dd>
                {lead && (
                  <>
                    <dt>Calls</dt>
                    <dd>{pluralize(lead.callIds.length, 'linked call')}</dd>
                    <dt>Actions</dt>
                    <dd>
                      {lead.actionIds.length === 0
                        ? 'None'
                        : lead.actionIds.map((a, i) => (
                            <Link key={a} to={`/approvals/${encodeURIComponent(a)}`} style={{ color: 'var(--cyan-ice)', marginRight: 8 }}>
                              Reply {i + 1}
                            </Link>
                          ))}
                    </dd>
                  </>
                )}
              </dl>
            </div>
          </Panel>

          <Panel title="Unified timeline" count={c.timeline.length} actions={<span className="muted" style={{ fontSize: 'var(--fs-xs)' }}>Oldest first</span>}>
            <div className="future-kinds" aria-label="Timeline channels" style={{ marginBottom: 20 }}>
              {channels.map((ch) => (
                <span key={ch.label} style={{ opacity: ch.active ? 1 : 0.45 }} title={ch.active ? `${ch.label} events present` : `${ch.label} events will appear here when connected`}>
                  <Chip icon={ch.icon}>{ch.label}</Chip>
                </span>
              ))}
            </div>
            {c.timeline.length === 0 ? (
              <EmptyState icon={Mail} title="No events yet" compact />
            ) : (
              <Timeline events={c.timeline} />
            )}
          </Panel>
        </div>
      )}
    </>
  );
}
