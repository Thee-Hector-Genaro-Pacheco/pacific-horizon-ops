const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function toMs(value: string | number | Date): number {
  return value instanceof Date ? value.getTime() : typeof value === 'number' ? value : new Date(value).getTime();
}

/** "just now", "4m ago", "3h ago", "Yesterday", "Sep 29" */
export function relativeTime(value: string | number | Date | null | undefined, now: number = Date.now()): string {
  if (value === null || value === undefined) return '—';
  const t = toMs(value);
  if (Number.isNaN(t) || t <= 0) return '—';
  const diff = now - t;
  if (diff < 0) {
    const ahead = -diff;
    if (ahead < 90_000) return 'just now'; // tolerate server/client clock skew
    if (ahead < HOUR) return `in ${Math.max(1, Math.round(ahead / MINUTE))}m`;
    if (ahead < DAY) return `in ${Math.round(ahead / HOUR)}h`;
    return shortDate(t);
  }
  if (diff < 45_000) return 'just now';
  if (diff < HOUR) return `${Math.max(1, Math.round(diff / MINUTE))}m ago`;
  if (diff < DAY) return `${Math.round(diff / HOUR)}h ago`;
  if (diff < 2 * DAY) return 'Yesterday';
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d ago`;
  return shortDate(t);
}

export function shortDate(value: string | number | Date): string {
  const d = new Date(toMs(value));
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

export function clockTime(value: string | number | Date): string {
  return new Date(toMs(value)).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function dateTime(value: string | number | Date): string {
  return new Date(toMs(value)).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** 0 -> "0s", 75 -> "1m 15s", 3700 -> "1h 1m" */
export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r ? `${m}m ${r}s` : `${m}m`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

export function initials(name: string): string {
  const cleaned = name.replace(/\(.*?\)/g, '').trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function humanize(token: string | null | undefined): string {
  if (!token) return '—';
  const s = token.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function dayLabel(isoDate: string): string {
  const d = new Date(`${isoDate}T12:00:00`);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
