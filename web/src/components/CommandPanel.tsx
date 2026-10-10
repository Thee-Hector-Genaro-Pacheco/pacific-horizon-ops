import {
  ArrowRight,
  CornerDownLeft,
  FlaskConical,
  Mail,
  Phone,
  Radar,
  RefreshCw,
  Search,
  ShieldAlert,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import type { ActionDTO, CallDTO, CustomerDTO, InboxItemDTO } from '../data/contract';
import { useData } from '../data/DataProvider';
import { NAV_ITEMS } from '../shell/nav';
import { Kbd } from './primitives';

interface PaletteItem {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: LucideIcon;
  keywords?: string;
  run: () => void;
}

interface SearchCorpus {
  inbox: InboxItemDTO[];
  customers: CustomerDTO[];
  actions: ActionDTO[];
  calls: CallDTO[];
}

function score(text: string, query: string): number {
  const t = text.toLowerCase();
  const q = query.toLowerCase().trim();
  if (!q) return 1;
  if (t.startsWith(q)) return 3;
  if (t.includes(` ${q}`)) return 2;
  if (t.includes(q)) return 1;
  // loose subsequence match
  let i = 0;
  for (const ch of t) if (ch === q[i]) i++;
  return i === q.length ? 0.5 : 0;
}

export function CommandPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const { services, mode, setMode, refreshAll } = useData();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [corpus, setCorpus] = useState<SearchCorpus | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    inputRef.current?.focus();
    Promise.allSettled([services.mailbox.listInbox(), services.leads.listCustomers(), services.actions.listActions(), services.calls.listCalls()]).then(
      ([inbox, customers, actions, calls]) => {
        if (cancelled) return;
        setCorpus({
          inbox: inbox.status === 'fulfilled' ? inbox.value : [],
          customers: customers.status === 'fulfilled' ? customers.value : [],
          actions: actions.status === 'fulfilled' ? actions.value : [],
          calls: calls.status === 'fulfilled' ? calls.value : [],
        });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [open, services]);

  const close = () => {
    setQuery('');
    setActive(0);
    onClose();
  };

  const go = (path: string) => () => {
    navigate(path);
    close();
  };

  const items = useMemo<PaletteItem[]>(() => {
    const latestCall = corpus?.calls[0];
    const commands: PaletteItem[] = [
      { id: 'cmd-inbox', group: 'Commands', label: 'Review inbox', icon: Mail, keywords: 'email messages new', run: go('/inbox') },
      { id: 'cmd-approvals', group: 'Commands', label: 'View pending approvals', icon: ShieldAlert, keywords: 'approve actions drafts', run: go('/approvals') },
      ...(latestCall
        ? [{ id: 'cmd-call', group: 'Commands', label: 'Open latest call', hint: latestCall.outcome, icon: Phone, keywords: 'voice phone', run: go(`/calls/${encodeURIComponent(latestCall.id)}`) }]
        : []),
      { id: 'cmd-presence', group: 'Commands', label: 'Preview Pacific Ops states', icon: Radar, keywords: 'presence visual agent', run: go('/settings#presence') },
      {
        id: 'cmd-refresh',
        group: 'Commands',
        label: 'Refresh all data',
        icon: RefreshCw,
        keywords: 'reload sync',
        run: () => {
          refreshAll();
          close();
        },
      },
      {
        id: 'cmd-mode',
        group: 'Commands',
        label: mode === 'demo' ? 'Switch to live data' : 'Switch to demo data',
        hint: mode === 'demo' ? 'Real PHRO state' : 'Sample data, clearly labeled',
        icon: FlaskConical,
        keywords: 'demo live source',
        run: () => {
          setMode(mode === 'demo' ? 'live' : 'demo');
          close();
        },
      },
    ];
    const nav: PaletteItem[] = NAV_ITEMS.map((n) => ({ id: `nav-${n.to}`, group: 'Go to', label: n.label, icon: n.icon, run: go(n.to) }));

    const records: PaletteItem[] = corpus
      ? [
          ...corpus.inbox.map((m) => ({
            id: `m-${m.id}`,
            group: 'Email',
            label: m.subject,
            hint: m.sender.name,
            icon: Mail,
            keywords: `${m.sender.name} ${m.sender.email ?? ''}`,
            run: go(`/inbox/${encodeURIComponent(m.id)}`),
          })),
          ...corpus.customers.map((c) => ({
            id: `c-${c.id}`,
            group: 'Customers',
            label: c.name,
            hint: c.lead?.eventType ?? c.email ?? undefined,
            icon: UserRound,
            keywords: c.email ?? '',
            run: go(`/customers/${encodeURIComponent(c.id)}`),
          })),
          ...corpus.actions.map((a) => ({
            id: `a-${a.id}`,
            group: 'Actions',
            label: `Reply to ${a.contact.name}`,
            hint: a.subject,
            icon: ShieldAlert,
            keywords: `${a.subject} ${a.status}`,
            run: go(`/approvals/${encodeURIComponent(a.id)}`),
          })),
          ...corpus.calls.map((c) => ({
            id: `k-${c.id}`,
            group: 'Calls',
            label: `${c.mode === 'mailbox_review' ? 'Mailbox review' : 'Approval review'} · ${c.outcome}`,
            hint: new Date(c.startedAt).toLocaleString(),
            icon: Phone,
            keywords: `${c.action?.subject ?? ''} call voice`,
            run: go(`/calls/${encodeURIComponent(c.id)}`),
          })),
        ]
      : [];

    if (!query.trim()) return [...commands, ...nav];

    return [...commands, ...nav, ...records]
      .map((item) => ({ item, s: Math.max(score(item.label, query), score(`${item.hint ?? ''} ${item.keywords ?? ''}`, query) * 0.8) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map((x) => x.item);
    // go/close are stable enough for the lifetime of an open palette
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [corpus, query, mode]);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const grouped: Array<[string, Array<{ item: PaletteItem; index: number }>]> = [];
  items.forEach((item, index) => {
    const g = grouped.find(([name]) => name === item.group);
    if (g) g[1].push({ item, index });
    else grouped.push([item.group, [{ item, index }]]);
  });

  const activeIndex = Math.min(active, Math.max(0, items.length - 1));

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((activeIndex + 1) % Math.max(1, items.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((activeIndex - 1 + items.length) % Math.max(1, items.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      items[activeIndex]?.run();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };

  return createPortal(
    <div className="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKeyDown}>
        <div className="palette-input">
          <Search aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            placeholder="Search email, customers, actions, calls…"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={items[activeIndex] ? `pal-${items[activeIndex].id}` : undefined}
            aria-autocomplete="list"
          />
          <Kbd>esc</Kbd>
        </div>
        <div className="palette-list" id={listId} role="listbox" ref={listRef} aria-label="Results">
          {items.length === 0 && (
            <div className="state state--compact">
              <div className="state-title">No matches</div>
              <div className="state-body">Try a customer name, subject, or a command like “approvals”.</div>
            </div>
          )}
          {grouped.map(([group, entries]) => (
            <div key={group} role="group" aria-label={group}>
              <div className="palette-group">{group}</div>
              {entries.map(({ item, index }) => {
                const Icon = item.icon;
                return (
                  <div
                    key={item.id}
                    id={`pal-${item.id}`}
                    role="option"
                    aria-selected={index === activeIndex}
                    className="palette-item"
                    onMouseMove={() => index !== activeIndex && setActive(index)}
                    onClick={item.run}
                  >
                    <Icon aria-hidden />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
                    {item.hint && <span className="hint">{item.hint}</span>}
                    {index === activeIndex && <ArrowRight aria-hidden style={{ marginLeft: item.hint ? 0 : 'auto', width: 13, height: 13 }} />}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="palette-foot" aria-hidden>
          <span>
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> navigate
          </span>
          <span>
            <Kbd>
              <CornerDownLeft size={10} />
            </Kbd>{' '}
            open
          </span>
          <span style={{ marginLeft: 'auto' }}>Read-only · no actions execute from here</span>
        </div>
      </div>
    </div>,
    document.body
  );
}
