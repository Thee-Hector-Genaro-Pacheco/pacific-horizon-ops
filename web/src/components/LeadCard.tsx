import { ArrowRight, CalendarDays, MapPin, Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { LeadDTO } from '../data/contract';
import { relativeTime } from '../lib/format';
import { useNow } from '../lib/useNow';
import { Avatar, Chip } from './primitives';

export function LeadCard({ lead, to }: { lead: LeadDTO; to: string }) {
  const now = useNow();
  return (
    <Link to={to} className="lead-card" aria-label={`${lead.name}${lead.eventType ? `, ${lead.eventType}` : ''}`}>
      <div className="lead-card-head">
        <Avatar name={lead.name} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="lead-card-name">{lead.name}</div>
          <div className="row-sub">{lead.eventType ?? 'Event type unknown'}</div>
        </div>
        <span className="row-meta">{relativeTime(lead.lastContactAt, now)}</span>
      </div>
      {(lead.eventDate || lead.location || lead.guestCount) && (
        <div className="lead-facts">
          {lead.eventDate && <Chip icon={CalendarDays}>{lead.eventDate}</Chip>}
          {lead.location && <Chip icon={MapPin}>{lead.location}</Chip>}
          {lead.guestCount && <Chip icon={Users}>{lead.guestCount}</Chip>}
        </div>
      )}
      {lead.nextAction && (
        <div className="lead-next">
          <ArrowRight aria-hidden />
          {lead.nextAction}
        </div>
      )}
    </Link>
  );
}
