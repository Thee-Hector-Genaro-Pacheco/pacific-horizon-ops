import { UsersRound } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Avatar, EmptyState, ErrorState, PageHeader, Panel, SearchField, Skeleton, StatusBadge } from '../components/primitives';
import { useResource } from '../data/useResource';
import { pluralize, relativeTime } from '../lib/format';
import { LEAD_STAGE } from '../lib/status';
import { useNow } from '../lib/useNow';

export function CustomersPage() {
  const now = useNow();
  const [query, setQuery] = useState('');
  const customers = useResource((s) => s.leads.listCustomers(), [], ['inbox', 'actions', 'calls']);
  const q = query.trim().toLowerCase();
  const list = (customers.data ?? []).filter((c) => !q || `${c.name} ${c.email ?? ''} ${c.lead?.eventType ?? ''}`.toLowerCase().includes(q));

  return (
    <>
      <PageHeader
        eyebrow="Relationships"
        title="Customers"
        description="Every person Pacific Ops has corresponded with, each with one unified timeline across email, voice and actions."
      />
      <div className="toolbar">
        <SearchField value={query} onChange={setQuery} placeholder="Search customers…" label="Search customers" />
      </div>

      {customers.error && !customers.data ? (
        <Panel>
          <ErrorState error={customers.error} onRetry={customers.reload} />
        </Panel>
      ) : customers.loading ? (
        <div className="customer-grid">
          {[0, 1, 2, 3].map((i) => (
            <div className="customer-card" key={i}>
              <Skeleton w="50%" h={14} />
              <Skeleton w="70%" h={10} />
              <Skeleton w="35%" h={18} />
            </div>
          ))}
        </div>
      ) : list.length === 0 ? (
        <Panel>
          <EmptyState icon={UsersRound} title={q ? 'No matching customers' : 'No customers yet'}>
            Customers are created from human business email. Automated notifications are excluded.
          </EmptyState>
        </Panel>
      ) : (
        <div className="customer-grid">
          {list.map((c) => (
            <Link key={c.id} to={`/customers/${encodeURIComponent(c.id)}`} className="customer-card">
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <Avatar name={c.name} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="row-title">{c.name}</div>
                  <div className="row-sub">{c.lead?.eventType ?? c.email ?? '—'}</div>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
                {c.lead ? <StatusBadge meta={LEAD_STAGE[c.lead.stage]} /> : <span className="badge badge--quiet">Contact</span>}
                <span className="row-meta">
                  {pluralize(c.messageCount, 'message')} · {relativeTime(c.lastSeenAt, now)}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
