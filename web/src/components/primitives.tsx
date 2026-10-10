import { Check, Copy, FlaskConical, RefreshCw, Search, TriangleAlert, type LucideIcon } from 'lucide-react';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { initials } from '../lib/format';
import type { StatusMeta, ToneClass } from '../lib/status';
import { useToast } from './Toast';

/* ------------------------------------------------------------------ */
/* Status                                                               */
/* ------------------------------------------------------------------ */

export function Dot({ tone, live, label }: { tone: ToneClass; live?: boolean; label?: string }) {
  return <i className={cn('dot', tone, live && 'dot--live')} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}

export function StatusBadge({ meta, quiet }: { meta: StatusMeta; quiet?: boolean }) {
  return (
    <span className={cn('badge', meta.tone, quiet && 'badge--quiet')}>
      <Dot tone={meta.tone} live={meta.live} />
      {meta.label}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Layout                                                               */
/* ------------------------------------------------------------------ */

export function Panel({
  title,
  icon: Icon,
  count,
  actions,
  children,
  flush,
  className,
  footer,
  id,
}: {
  title?: ReactNode;
  icon?: LucideIcon;
  count?: number | string;
  actions?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  className?: string;
  footer?: ReactNode;
  id?: string;
}) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section className={cn('panel', className)} aria-labelledby={headingId}>
      {(title || actions) && (
        <header className="panel-header">
          {title && (
            <h2 className="panel-title" id={headingId}>
              {Icon && <Icon size={13} aria-hidden />}
              {title}
              {count !== undefined && <span className="count">{count}</span>}
            </h2>
          )}
          {actions && <div className="panel-actions">{actions}</div>}
        </header>
      )}
      <div className={cn('panel-body', flush && 'panel-body--flush')}>{children}</div>
      {footer && <div className="panel-footer">{footer}</div>}
    </section>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div style={{ minWidth: 0 }}>
        {eyebrow && <div className="page-eyebrow">{eyebrow}</div>}
        <h1 className="page-title">{title}</h1>
        {description && <p className="page-desc">{description}</p>}
      </div>
      {actions && <div className="page-head-actions">{actions}</div>}
    </header>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="section-label">{children}</div>;
}

/* ------------------------------------------------------------------ */
/* Small atoms                                                          */
/* ------------------------------------------------------------------ */

export function Avatar({ name, size, system }: { name: string; size?: 'lg'; system?: boolean }) {
  return (
    <span className={cn('avatar', size === 'lg' && 'avatar--lg', system && 'avatar--sys')} aria-hidden>
      {system ? 'PO' : initials(name)}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function Chip({ icon: Icon, children, title }: { icon?: LucideIcon; children: ReactNode; title?: string }) {
  return (
    <span className="chip" title={title}>
      {Icon && <Icon aria-hidden />}
      {children}
    </span>
  );
}

export function Tooltip({ content, children, side }: { content: ReactNode; children: ReactNode; side?: 'right' }) {
  return (
    <span className={cn('tip', side === 'right' && 'tip--right')}>
      {children}
      <span className="tip-bubble" role="tooltip">
        {content}
      </span>
    </span>
  );
}

export function SourceBadge({ kind }: { kind: 'live' | 'demo' | 'derived' }) {
  if (kind === 'demo') {
    return (
      <span className="source-badge source-badge--demo" title="Sample data — not real operations">
        <FlaskConical size={11} aria-hidden /> Demo
      </span>
    );
  }
  if (kind === 'derived') {
    return (
      <span className="source-badge source-badge--derived" title="Inferred from inbox and action records">
        Derived
      </span>
    );
  }
  return (
    <span className="source-badge source-badge--live" title="Real PHRO operational data">
      <i className="dot tone-ok" style={{ width: 5, height: 5, boxShadow: 'none' }} aria-hidden /> Live
    </span>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string; count?: number }>;
  label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
          {o.count !== undefined && <span className="n">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function SearchField({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  label: string;
}) {
  return (
    <label className="search">
      <Search aria-hidden />
      <span className="sr-only">{label}</span>
      <input type="search" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

export function CopyCommand({ command, label }: { command: string; label?: string }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      toast({ title: 'Command copied', body: label ?? command, tone: 'ok', durationMs: 2600 });
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast({ title: 'Copy failed', body: 'Clipboard access is blocked in this browser.', tone: 'warn' });
    }
  };
  return (
    <div className="cmd">
      <code>{command}</code>
      <button type="button" className="icon-btn" style={{ width: 26, height: 26 }} onClick={copy} aria-label={`Copy command: ${command}`}>
        {copied ? <Check /> : <Copy />}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Loading / empty / error                                              */
/* ------------------------------------------------------------------ */

export function Skeleton({ w, h = 10, r, style }: { w?: number | string; h?: number; r?: number; style?: CSSProperties }) {
  return <span className="skeleton" style={{ width: w ?? '100%', height: h, borderRadius: r, ...style }} aria-hidden />;
}

export function SkeletonRows({ rows = 5, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div className="skeleton-row" key={i}>
          <Skeleton w={30} h={30} r={7} />
          <div style={{ flex: 1, display: 'grid', gap: 7 }}>
            <Skeleton w={`${48 + ((i * 17) % 30)}%`} h={10} />
            <Skeleton w={`${28 + ((i * 23) % 40)}%`} h={8} />
          </div>
          <Skeleton w={64} h={18} r={3} />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
  compact,
}: {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={cn('state', compact && 'state--compact')}>
      <div className="state-icon">
        <Icon aria-hidden />
      </div>
      <div className="state-title">{title}</div>
      {children && <div className="state-body">{children}</div>}
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry, compact }: { error: Error; onRetry?: () => void; compact?: boolean }) {
  const unavailable = error.name === 'ApiUnavailableError';
  return (
    <div className={cn('state', 'state--error', compact && 'state--compact')} role="alert">
      <div className="state-icon">
        <TriangleAlert aria-hidden />
      </div>
      <div className="state-title">{unavailable ? 'Command Center API offline' : 'Could not load this view'}</div>
      <div className="state-body">
        {unavailable ? (
          <>
            Start the read-only API with <code className="mono">npm run dashboard:serve</code>, or switch to demo data from Settings.
          </>
        ) : (
          error.message
        )}
      </div>
      {onRetry && (
        <button type="button" className="btn btn--sm" onClick={onRetry}>
          <RefreshCw aria-hidden /> Retry
        </button>
      )}
    </div>
  );
}
