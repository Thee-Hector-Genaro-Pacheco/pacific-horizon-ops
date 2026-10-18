/**
 * Scheduling-conflict semantics shared by the Calendar Hub API and Pacific Ops voice.
 *
 * A conflict is two or more busy, timed events whose intervals strictly overlap
 * (a.start < b.end && b.start < a.end). Back-to-back events (5–6 PM then 6–7 PM) do not
 * conflict. All-day events and "Show as: Free" events never take part.
 */

export interface ConflictCandidate {
  start: string;
  end: string;
  busy: boolean;
  allDay: boolean;
  profileId: string;
}

export interface ConflictWindow<E extends ConflictCandidate = ConflictCandidate> {
  /** Union of the overlapping portions (ISO). */
  start: string;
  end: string;
  /** Every event that overlaps another event inside this window. */
  events: E[];
  /** Distinct profiles involved, in order of appearance. */
  profileIds: string[];
  crossAccount: boolean;
}

export function canConflict(e: ConflictCandidate): boolean {
  return e.busy && !e.allDay;
}

export function eventsOverlap(a: ConflictCandidate, b: ConflictCandidate): boolean {
  return Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end);
}

/** Other conflict-eligible events overlapping `e` (empty when `e` itself can't conflict). */
export function overlappingWith<E extends ConflictCandidate>(e: E, events: E[]): E[] {
  if (!canConflict(e)) return [];
  return events.filter((o) => o !== e && canConflict(o) && eventsOverlap(e, o));
}

/**
 * Distinct conflict windows, chronologically. Overlapping portions of every overlapping
 * pair are merged, so three events stacked on one interval form one window.
 */
export function conflictWindows<E extends ConflictCandidate>(events: E[]): ConflictWindow<E>[] {
  const eligible = events.filter(canConflict);
  const pieces: Array<{ s: number; e: number; members: E[] }> = [];
  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const a = eligible[i];
      const b = eligible[j];
      if (!eventsOverlap(a, b)) continue;
      pieces.push({
        s: Math.max(Date.parse(a.start), Date.parse(b.start)),
        e: Math.min(Date.parse(a.end), Date.parse(b.end)),
        members: [a, b],
      });
    }
  }
  pieces.sort((x, y) => x.s - y.s || x.e - y.e);
  const windows: Array<{ s: number; e: number; members: Set<E> }> = [];
  for (const p of pieces) {
    const last = windows[windows.length - 1];
    if (last && p.s < last.e) {
      last.e = Math.max(last.e, p.e);
      p.members.forEach((m) => last.members.add(m));
    } else {
      windows.push({ s: p.s, e: p.e, members: new Set(p.members) });
    }
  }
  return windows.map((w) => {
    const members = [...w.members].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    const profileIds = [...new Set(members.map((m) => m.profileId))];
    return {
      start: new Date(w.s).toISOString(),
      end: new Date(w.e).toISOString(),
      events: members,
      profileIds,
      crossAccount: profileIds.length > 1,
    };
  });
}
