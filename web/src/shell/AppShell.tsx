import { ChevronRight, Ellipsis, FlaskConical, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { CommandPanel } from '../components/CommandPanel';
import { Dot, Kbd, SourceBadge } from '../components/primitives';
import { useToast } from '../components/Toast';
import type { ActionStatusDTO, CommandCenterDTO } from '../data/contract';
import { useData } from '../data/DataProvider';
import type { LinkState } from '../data/services';
import { useResource } from '../data/useResource';
import { cn } from '../lib/cn';
import { relativeTime } from '../lib/format';
import { ACTION_STATUS, opsAvailability } from '../lib/status';
import { useNow } from '../lib/useNow';
import { BrandMark } from './BrandMark';
import { NAV_GROUPS, NAV_ITEMS, type NavCountKey } from './nav';
import { PacificOpsStatus } from './PacificOpsStatus';

function countFor(key: NavCountKey | undefined, summary: CommandCenterDTO | undefined): number | null {
  if (!key || !summary) return null;
  const n = key === 'approvals' ? summary.counts.pendingApprovals : summary.counts.needsAttention;
  return n > 0 ? n : null;
}

const LINK_LABEL: Record<LinkState, { label: string; tone: 'tone-ok' | 'tone-warn' | 'tone-idle' | 'tone-fail' }> = {
  connecting: { label: 'Connecting', tone: 'tone-idle' },
  live: { label: 'Live', tone: 'tone-ok' },
  polling: { label: 'Polling', tone: 'tone-warn' },
  offline: { label: 'Offline', tone: 'tone-fail' },
  demo: { label: 'Demo data', tone: 'tone-idle' },
};

/** Announces real action state transitions (e.g. AWAITING_APPROVAL -> SENT) as they arrive. */
function LiveActionToasts() {
  const toast = useToast();
  const { mode } = useData();
  const { data } = useResource((s) => s.actions.listActions(), [], ['actions']);
  const previous = useRef<Map<string, ActionStatusDTO> | null>(null);

  useEffect(() => {
    if (!data) return;
    const next = new Map(data.map((a) => [a.id, a.status]));
    const prev = previous.current;
    previous.current = next;
    if (!prev || mode !== 'live') return;
    for (const a of data) {
      const before = prev.get(a.id);
      if (before && before !== a.status) {
        const meta = ACTION_STATUS[a.status];
        toast({
          title: `${meta.label} · ${a.contact.name}`,
          body: `${ACTION_STATUS[before].label} → ${meta.label} · ${a.subject}`,
          tone: meta.tone === 'tone-fail' ? 'fail' : meta.tone === 'tone-ok' ? 'ok' : meta.tone === 'tone-warn' ? 'warn' : 'info',
        });
      } else if (!before) {
        toast({ title: 'New action', body: `Reply to ${a.contact.name} · ${a.subject}`, tone: 'warn' });
      }
    }
  }, [data, mode, toast]);

  return null;
}

export function AppShell() {
  const location = useLocation();
  const now = useNow();
  const { mode, setMode, link, lastChangeAt } = useData();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const statusRef = useRef<HTMLDivElement>(null);

  const summary = useResource((s) => s.dashboard.getCommandCenter(), [], ['actions', 'inbox', 'calls']);
  const health = useResource((s) => s.dashboard.getHealth(), [], ['health']);

  const voice = health.data?.components.find((c) => c.key === 'voice');
  const availability = opsAvailability(voice?.status, health.data?.overall);
  const current = [...NAV_ITEMS].sort((a, b) => b.to.length - a.to.length).find((n) => (n.to === '/' ? location.pathname === '/' : location.pathname.startsWith(n.to)));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!statusOpen) return;
    const onDown = (e: MouseEvent) => {
      if (statusRef.current && !statusRef.current.contains(e.target as Node)) setStatusOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setStatusOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [statusOpen]);

  const linkMeta = mode === 'demo' ? LINK_LABEL.demo : summary.error ? LINK_LABEL.offline : LINK_LABEL[link];
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

  return (
    <div className="app">
      <a href="#content" className="skip-link">
        Skip to content
      </a>

      <aside className="sidebar" aria-label="Primary">
        <div className="brand">
          <BrandMark />
          <div className="brand-text">
            <div className="brand-name">PACIFIC RISING OPS</div>
            <div className="brand-org">Pacific Horizon Labs</div>
          </div>
        </div>

        <button type="button" className="sidebar-search" onClick={() => setPaletteOpen(true)} aria-label="Open command palette">
          <Search aria-hidden />
          <span>Search or jump to…</span>
          <span className="kbds" aria-hidden>
            <Kbd>{isMac ? '⌘' : 'Ctrl'}</Kbd>
            <Kbd>K</Kbd>
          </span>
        </button>

        <nav className="nav" aria-label="Main navigation">
          {NAV_GROUPS.map((group) => (
            <div key={group}>
              <div className="nav-group-label">{group}</div>
              <ul style={{ display: 'grid', gap: 2 }}>
                {NAV_ITEMS.filter((n) => n.group === group).map((n) => {
                  const count = countFor(n.count, summary.data);
                  const Icon = n.icon;
                  return (
                    <li key={n.to}>
                      <NavLink to={n.to} end={n.to === '/'} className={({ isActive }) => cn('nav-item', isActive && 'active')} title={n.label}>
                        <Icon aria-hidden />
                        <span className="nav-label">{n.label}</span>
                        {count !== null && (
                          <span className={cn('nav-count', n.count === 'approvals' && 'nav-count--attention')} aria-label={`${count} pending`}>
                            {count}
                          </span>
                        )}
                      </NavLink>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="sidebar-foot">
          <button type="button" className="ops-card" onClick={() => setStatusOpen(true)} aria-label={`Pacific Ops ${availability.label}. Open status`}>
            <span className="ops-card-head">
              <Dot tone={availability.tone} live={availability.live} />
              <span className="ops-card-name">PACIFIC OPS</span>
              <span className={cn('ops-card-state', availability.tone)}>{availability.label.toUpperCase()}</span>
            </span>
            <span className="ops-card-grid">
              {(health.data?.components ?? []).map((c) => (
                <span key={c.key}>
                  <Dot tone={c.status === 'offline' ? 'tone-fail' : c.status === 'online' || c.status === 'configured' ? 'tone-ok' : 'tone-idle'} />
                  {c.key === 'voice' ? 'Voice' : c.label}
                </span>
              ))}
            </span>
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar-brand">
            <BrandMark />
            <span className="brand-name">PACIFIC RISING OPS</span>
          </div>
          <div className="crumbs">
            <span>Pacific Rising Ops</span>
            <ChevronRight aria-hidden />
            <strong>{current?.label ?? 'Not found'}</strong>
          </div>

          <div className="topbar-right">
            <span className={cn('link-state', linkMeta.tone)} title={lastChangeAt ? `Last live change ${relativeTime(lastChangeAt, now)}` : undefined}>
              <Dot tone={linkMeta.tone} live={linkMeta.tone === 'tone-ok' && mode === 'live'} />
              {linkMeta.label}
            </span>
            {mode === 'demo' && <SourceBadge kind="demo" />}
            <button type="button" className="icon-btn" onClick={() => setPaletteOpen(true)} aria-label="Search">
              <Search />
            </button>
            <div ref={statusRef} style={{ position: 'relative' }}>
              <button
                type="button"
                className={cn('ops-pill', availability.tone)}
                aria-expanded={statusOpen}
                aria-haspopup="dialog"
                onClick={() => setStatusOpen((o) => !o)}
              >
                <Dot tone={availability.tone} live={availability.live} />
                <span className="ops-pill-name">PACIFIC OPS</span>
                <span className="ops-pill-sep" aria-hidden />
                <span className="ops-pill-state">{availability.label.toUpperCase()}</span>
              </button>
              {statusOpen && (
                <div className="popover" role="dialog" aria-label="Pacific Ops status">
                  <PacificOpsStatus health={health.data} summary={summary.data} onNavigate={() => setStatusOpen(false)} />
                </div>
              )}
            </div>
          </div>
        </header>

        {mode === 'demo' && (
          <div className="demo-banner" role="note">
            <FlaskConical aria-hidden />
            <span>
              <strong>Demo data.</strong> Sample records for exploring the interface. Nothing here reflects real operations.
            </span>
            <button type="button" onClick={() => setMode('live')}>
              Switch to live
            </button>
          </div>
        )}

        <main id="content" className="content" key={mode} tabIndex={-1}>
          <Outlet />
        </main>
      </div>

      <nav className="tabbar" aria-label="Primary">
        {NAV_ITEMS.filter((n) => n.primaryMobile).map((n) => {
          const Icon = n.icon;
          const count = countFor(n.count, summary.data);
          return (
            <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => cn('tab', isActive && 'active')}>
              <Icon aria-hidden />
              {n.to === '/' ? 'Command' : n.label}
              {count !== null && <span className={cn('nav-count', n.count === 'approvals' && 'nav-count--attention')}>{count}</span>}
            </NavLink>
          );
        })}
        <button type="button" className={cn('tab', moreOpen && 'active')} onClick={() => setMoreOpen(true)} aria-haspopup="dialog">
          <Ellipsis aria-hidden />
          More
        </button>
      </nav>

      {moreOpen && (
        <>
          <div className="sheet-backdrop" onClick={() => setMoreOpen(false)} aria-hidden />
          <div className="sheet" role="dialog" aria-label="More navigation">
            <div className="sheet-grab" />
            <ul style={{ display: 'grid', gap: 2 }}>
              {NAV_ITEMS.filter((n) => !n.primaryMobile).map((n) => {
                const Icon = n.icon;
                return (
                  <li key={n.to}>
                    <NavLink to={n.to} className={({ isActive }) => cn('nav-item', isActive && 'active')} onClick={() => setMoreOpen(false)}>
                      <Icon aria-hidden />
                      <span className="nav-label">{n.label}</span>
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </div>
        </>
      )}

      <CommandPanel open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <LiveActionToasts />
    </div>
  );
}
