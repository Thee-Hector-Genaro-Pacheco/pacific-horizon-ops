/**
 * Timezone-explicit date math for Calendar reads.
 *
 * Every function takes an IANA timezone and works from Intl, never from the machine's
 * local timezone, so results are identical on a laptop, a server in UTC, or in tests.
 */

export interface LocalDate {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
}

export interface LocalParts extends LocalDate {
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday ... 6 = Saturday */
  weekday: number;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const formatters = new Map<string, Intl.DateTimeFormat>();

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'long',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** Wall-clock fields of an instant in `tz`. */
export function localParts(instant: Date, tz: string): LocalParts {
  const out: Record<string, string> = {};
  for (const p of formatterFor(tz).formatToParts(instant)) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: WEEKDAYS.indexOf(out.weekday.toLowerCase() as (typeof WEEKDAYS)[number]),
  };
}

export function localDateOf(instant: Date, tz: string): LocalDate {
  const { year, month, day } = localParts(instant, tz);
  return { year, month, day };
}

/** Offset of `tz` from UTC at `instantMs`, in ms (e.g. -7h for PDT). */
function offsetMs(tz: string, instantMs: number): number {
  const p = localParts(new Date(instantMs), tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/**
 * The instant at which the wall clock in `tz` reads date/hour/minute. Two-pass offset
 * correction handles DST: nonexistent spring-forward times move forward, and ambiguous
 * fall-back times resolve to one consistent instant.
 */
export function zonedToUtc(tz: string, date: LocalDate, hour = 0, minute = 0): Date {
  const wall = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  let t = wall - offsetMs(tz, wall);
  const second = offsetMs(tz, t);
  if (wall - second !== t) t = wall - second;
  return new Date(t);
}

/** Pure calendar-date arithmetic (no timezone involved). */
export function addDays(date: LocalDate, days: number): LocalDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function weekdayOf(date: LocalDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

export function sameDate(a: LocalDate, b: LocalDate): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

export function formatLocalDate(d: LocalDate): string {
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

export function parseLocalDate(s: string): LocalDate | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  return formatLocalDate(addDays(d, 0)) === s ? d : null;
}

/* ------------------------------------------------------------------ */
/* Natural time phrases                                                 */
/* ------------------------------------------------------------------ */

export interface ResolvedWindow {
  start: Date;
  end: Date;
  /** Spoken label, e.g. "tomorrow", "Saturday", "this weekend". */
  label: string;
  /** Local date when the window lies within one day. */
  day: LocalDate | null;
  /** True when the phrase named a time of day (e.g. "from 5 to 10", "morning", "after 7"). */
  hasTimeOfDay: boolean;
}

/**
 * Phrase semantics (all resolved in the configured business timezone):
 *
 *   today / tomorrow / day after tomorrow   that local day, 00:00 to next day 00:00
 *   tonight                                 today 17:00 to 24:00
 *   <weekday>, this <weekday>, on <weekday> next occurrence on or after today
 *   next <weekday>                          that weekday in the following Mon-Sun week
 *   this weekend                            Saturday 00:00 to Monday 00:00 of the current week
 *                                           (on a Saturday or Sunday: the weekend in progress)
 *   next weekend                            this weekend + 7 days
 *   this week                               now to the coming Monday 00:00
 *   next week                               next Monday 00:00 to the Monday after
 *   morning / afternoon / evening / night   06-12 / 12-17 / 17-21 / 17-24 on the named day
 *   from X to Y, X to Y, between X and Y    that window on the named day (default: context day, else today)
 *   after X / before X                      X to end of day / start of day to X
 *
 * Hours without am/pm: a start of 1-7 means PM, 8-11 means AM, 12 means noon (owner
 * events are mostly afternoon/evening). An end without am/pm is the first reading
 * later than the start ("5 to 10" = 5 PM to 10 PM; "9 to 5" = 9 AM to 5 PM).
 */
export function resolveTimePhrase(
  utterance: string,
  now: Date,
  tz: string,
  contextDay: LocalDate | null = null
): ResolvedWindow | null {
  const text = normalizeTimeText(utterance);
  const today = localDateOf(now, tz);
  const dayStart = (d: LocalDate) => zonedToUtc(tz, d);

  let day: LocalDate | null = null;
  let label = '';
  let span: { start: Date; end: Date; label: string } | null = null;

  const wdMatch = /\b(next |this |on )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\b/.exec(text);

  if (/\bnext weekend\b/.test(text) || /\bthis weekend\b|\bthe weekend\b|\bweekend\b/.test(text)) {
    const sat = currentWeekendSaturday(today);
    const start = /\bnext weekend\b/.test(text) ? addDays(sat, 7) : sat;
    span = {
      start: dayStart(start),
      end: dayStart(addDays(start, 2)),
      label: /\bnext weekend\b/.test(text) ? 'next weekend' : 'this weekend',
    };
  } else if (/\bnext week\b/.test(text)) {
    const monday = addDays(today, ((8 - weekdayOf(today)) % 7) || 7);
    span = { start: dayStart(monday), end: dayStart(addDays(monday, 7)), label: 'next week' };
  } else if (/\bthis week\b/.test(text)) {
    const monday = addDays(today, ((8 - weekdayOf(today)) % 7) || 7);
    span = { start: now, end: dayStart(monday), label: 'this week' };
  } else if (/\bday after tomorrow\b/.test(text)) {
    day = addDays(today, 2);
    label = 'the day after tomorrow';
  } else if (/\btomorrow\b/.test(text)) {
    day = addDays(today, 1);
    label = 'tomorrow';
  } else if (/\btoday\b|\btonight\b/.test(text)) {
    day = today;
    label = 'today';
  } else if (wdMatch) {
    const target = WEEKDAYS.indexOf(wdMatch[2] as (typeof WEEKDAYS)[number]);
    if (wdMatch[1] === 'next ') {
      const nextMonday = addDays(today, ((8 - weekdayOf(today)) % 7) || 7);
      day = addDays(nextMonday, (target + 6) % 7);
      label = `next ${capitalize(wdMatch[2])}`;
    } else {
      day = addDays(today, (target - weekdayOf(today) + 7) % 7);
      label = capitalize(wdMatch[2]);
    }
  }

  if (span) return { ...span, day: null, hasTimeOfDay: false };

  const time = resolveTimeOfDay(text);
  if (/\btonight\b/.test(text) && label === 'today') label = 'tonight';
  if (!day) {
    if (!time) return null;
    day = contextDay ?? today;
    label = contextDay ? '' : 'today';
  }
  if (!time) {
    return { start: dayStart(day), end: dayStart(addDays(day, 1)), label, day, hasTimeOfDay: false };
  }

  const start = time.startMin === null ? dayStart(day) : zonedToUtc(tz, day, Math.floor(time.startMin / 60), time.startMin % 60);
  const end =
    time.endMin === null || time.endMin >= 24 * 60
      ? dayStart(addDays(day, 1))
      : zonedToUtc(tz, day, Math.floor(time.endMin / 60), time.endMin % 60);
  return { start, end, label, day, hasTimeOfDay: true };
}

function currentWeekendSaturday(today: LocalDate): LocalDate {
  const wd = weekdayOf(today);
  if (wd === 6) return today;
  if (wd === 0) return addDays(today, -1);
  return addDays(today, 6 - wd);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Lowercase, keep ":" for times, fold "p.m." / "p m" into "pm". */
export function normalizeTimeText(utterance: string): string {
  return utterance
    .toLowerCase()
    .replace(/\b([ap])\.?\s?m\b\.?/g, '$1m')
    .replace(/[,!?;"]/g, ' ')
    .replace(/\.(?!\d)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface TimeOfDay {
  /** Minutes after local midnight, or null for start of day. */
  startMin: number | null;
  /** Minutes after local midnight (may be 1440), or null for end of day. */
  endMin: number | null;
}

const PARTS_OF_DAY: Record<string, [number, number]> = {
  morning: [6, 12],
  afternoon: [12, 17],
  evening: [17, 21],
  night: [17, 24],
  tonight: [17, 24],
};

const CLOCK = String.raw`(\d{1,2})(?::(\d{2}))?\s*(am|pm)?|noon|midnight`;

function resolveTimeOfDay(text: string): TimeOfDay | null {
  const range = new RegExp(String.raw`\b(?:from |between )?(${CLOCK})\s*(?:to|until|till|through|-|and)\s*(${CLOCK})\b`).exec(text);
  if (range) {
    const morning = /\bmorning\b/.test(text);
    const start = clockMinutes(range[1], morning ? 'am' : null);
    if (start !== null) {
      const end = endAfter(range[5], start);
      if (end !== null) return { startMin: start, endMin: end };
    }
  }
  const after = new RegExp(String.raw`\bafter (${CLOCK})\b`).exec(text);
  if (after) {
    const start = clockMinutes(after[1], null);
    if (start !== null) return { startMin: start, endMin: null };
  }
  const before = new RegExp(String.raw`\bbefore (${CLOCK})\b`).exec(text);
  if (before) {
    const end = clockMinutes(before[1], null);
    if (end !== null) return { startMin: null, endMin: end };
  }
  for (const [word, [s, e]] of Object.entries(PARTS_OF_DAY)) {
    if (new RegExp(`\\b${word}\\b`).test(text)) return { startMin: s * 60, endMin: e * 60 };
  }
  return null;
}

/** Minutes after midnight for a spoken clock time; `hint` overrides the default meridiem. */
function clockMinutes(raw: string, hint: 'am' | 'pm' | null): number | null {
  const s = raw.trim();
  if (s === 'noon') return 12 * 60;
  if (s === 'midnight') return 0;
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (h > 23 || min > 59) return null;
  const meridiem = (m[3] as 'am' | 'pm' | undefined) ?? hint;
  if (h > 12) return h * 60 + min; // 24-hour clock
  if (meridiem === 'am') return (h % 12) * 60 + min;
  if (meridiem === 'pm') return ((h % 12) + 12) * 60 + min;
  if (h === 12) return 12 * 60 + min;
  return (h >= 1 && h <= 7 ? h + 12 : h) * 60 + min;
}

/** End time: explicit meridiem wins; otherwise the first reading after `startMin`. */
function endAfter(raw: string, startMin: number): number | null {
  const s = raw.trim();
  if (s === 'midnight') return 24 * 60;
  if (/(am|pm)$/.test(s) || s === 'noon') {
    const v = clockMinutes(s, null);
    return v !== null && v > startMin ? v : v !== null && v === 0 ? 24 * 60 : null;
  }
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (h > 23 || min > 59) return null;
  if (h > 12) return h * 60 + min > startMin ? h * 60 + min : null;
  for (const candidate of [(h % 12) * 60 + min, ((h % 12) + 12) * 60 + min, 24 * 60 + (h % 12) * 60 + min]) {
    if (candidate > startMin && candidate <= 24 * 60) return candidate;
  }
  return null;
}
