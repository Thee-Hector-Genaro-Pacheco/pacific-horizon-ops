import { useEffect, useRef } from "react";
import { Swords } from "lucide-react";
import type {
  CalendarDayAvailabilityDTO,
  CalendarDayDTO,
  CalendarEventDTO,
} from "../data/contract";
import { cn } from "../lib/cn";
import { clock, dayHeading, groupByDay, timeRange } from "../lib/calendarHub";
import {
  MINUTES_PER_DAY,
  layoutDay,
  localStamp,
  monthCell,
} from "../lib/calendarLayout";

/**
 * Read-only calendar views. Events are buttons that open the detail drawer; there is
 * no drag, resize, create, edit or delete affordance anywhere.
 */

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HOUR_PX = 52;
const FIRST_VISIBLE_HOUR = 7;

export interface ViewProps {
  events: CalendarEventDTO[];
  tz: string;
  palette: Map<string, number>;
  onOpen: (e: CalendarEventDTO) => void;
}

function sourceClass(palette: Map<string, number>, sourceId: string): string {
  return `cal-src cal-src--${palette.get(sourceId) ?? 0}`;
}

function eventLabel(e: CalendarEventDTO, tz: string): string {
  return `${e.title}, ${timeRange(e, tz)}, ${e.sourceLabel}${e.crossAccountConflict ? ", conflicts with another account" : e.conflict ? ", overlaps another event" : ""}`;
}

function ConflictMark({ e }: { e: CalendarEventDTO }) {
  if (!e.conflict) return null;
  return (
    <span
      className={cn("cal-mark", e.crossAccountConflict && "cal-mark--cross")}
      title={
        e.crossAccountConflict
          ? "Conflict across accounts"
          : "Overlaps another event"
      }
    >
      <Swords size={10} aria-hidden />
      {e.crossAccountConflict ? "Cross-account" : "Overlap"}
    </span>
  );
}

/* ------------------------------- Month ------------------------------- */

export function MonthGrid({
  days,
  selected,
  onSelectDay,
  onShowDay,
  ...view
}: ViewProps & {
  days: CalendarDayDTO[];
  selected: string | null;
  onSelectDay: (date: string) => void;
  onShowDay: (date: string) => void;
}) {
  const weeks: CalendarDayDTO[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  return (
    <div className="cal-month" role="grid" aria-label="Month">
      <div className="cal-month-head" role="row">
        {WEEKDAY_SHORT.map((d) => (
          <div key={d} role="columnheader">
            {d}
          </div>
        ))}
      </div>
      {weeks.map((week) => (
        <div className="cal-month-row" role="row" key={week[0].date}>
          {week.map((d) => {
            const { visible, more } = monthCell(view.events, d.date, view.tz);
            return (
              <div
                key={d.date}
                role="gridcell"
                aria-selected={selected === d.date}
                className={cn(
                  "cal-month-cell",
                  !d.inPeriod && "cal-month-cell--out",
                  d.isToday && "cal-month-cell--today",
                  selected === d.date && "cal-month-cell--selected",
                )}
              >
                <button
                  type="button"
                  className="cal-month-date"
                  onClick={() => onSelectDay(d.date)}
                  aria-label={`Select ${d.date}`}
                >
                  {Number(d.date.slice(8))}
                </button>
                {visible.map((e) => (
                  <button
                    key={`${e.id}-${d.date}`}
                    type="button"
                    className={cn(
                      "cal-chip",
                      sourceClass(view.palette, e.sourceId),
                      e.conflict && "cal-chip--conflict",
                    )}
                    onClick={() => view.onOpen(e)}
                    aria-label={eventLabel(e, view.tz)}
                  >
                    <span className="cal-chip-line">
                      {!e.allDay &&
                        localStamp(e.start, view.tz).date === d.date && (
                          <span className="cal-chip-time">
                            {clock(e.start, view.tz)}
                          </span>
                        )}
                      <span className="cal-chip-title">{e.title}</span>
                    </span>
                    <span className="cal-chip-source">{e.sourceLabel}</span>
                  </button>
                ))}
                {more > 0 && (
                  <button
                    type="button"
                    className="cal-more"
                    onClick={() => onShowDay(d.date)}
                  >
                    +{more} more
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/* --------------------------- Week / Day grid --------------------------- */

export function TimeGrid({
  days,
  availability,
  now,
  ...view
}: ViewProps & {
  days: CalendarDayDTO[];
  availability: CalendarDayAvailabilityDTO[];
  now: Date;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const firstDate = days[0]?.date;
  useEffect(() => {
    // Start the scroll at 7 AM whenever the visible range changes.
    if (scroller.current && firstDate)
      scroller.current.scrollTop = FIRST_VISIBLE_HOUR * HOUR_PX;
  }, [firstDate]);
  const current = localStamp(now.toISOString(), view.tz);
  const layouts = days.map((d) => ({
    day: d,
    ...layoutDay(view.events, d.date, view.tz),
  }));
  const single = days.length === 1;

  return (
    <div
      className={cn("cal-time", single && "cal-time--day")}
      style={{ ["--cal-cols" as string]: days.length }}
    >
      <div className="cal-time-head">
        <div className="cal-gutter" />
        {days.map((d) => (
          <div
            key={d.date}
            className={cn("cal-col-head", d.isToday && "cal-col-head--today")}
          >
            <span>{WEEKDAY_SHORT[d.weekday]}</span>{" "}
            <strong>{Number(d.date.slice(8))}</strong>
          </div>
        ))}
      </div>
      <div className="cal-allday">
        <div className="cal-gutter">all-day</div>
        {layouts.map(({ day, allDay }) => (
          <div key={day.date} className="cal-allday-cell">
            {allDay.map((e) => (
              <button
                key={e.id}
                type="button"
                className={cn(
                  "cal-chip",
                  sourceClass(view.palette, e.sourceId),
                )}
                onClick={() => view.onOpen(e)}
                aria-label={eventLabel(e, view.tz)}
              >
                <span className="cal-chip-title">{e.title}</span>
                <span className="cal-chip-source">{e.sourceLabel}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="cal-time-body" ref={scroller}>
        <div className="cal-time-inner" style={{ height: 24 * HOUR_PX }}>
          <div className="cal-gutter cal-hours">
            {Array.from({ length: 24 }, (_, h) => (
              <div
                key={h}
                className="cal-hour-label"
                style={{ top: h * HOUR_PX }}
              >
                {h === 0
                  ? ""
                  : h === 12
                    ? "Noon"
                    : `${h % 12} ${h < 12 ? "AM" : "PM"}`}
              </div>
            ))}
          </div>
          {layouts.map(({ day, timed }) => {
            const avail = availability.find((a) => a.date === day.date);
            return (
              <div
                key={day.date}
                className={cn("cal-col", day.isToday && "cal-col--today")}
                aria-label={dayHeading(day.date, view.tz, now)}
              >
                {avail &&
                  avail.status !== "failed" &&
                  avail.busy.map((b) => {
                    const s = localStamp(b.start, view.tz).minutes;
                    const e =
                      localStamp(b.end, view.tz).minutes || MINUTES_PER_DAY;
                    return (
                      <div
                        key={b.start}
                        className="cal-busy-band"
                        style={{
                          top: (s / 60) * HOUR_PX,
                          height: ((e - s) / 60) * HOUR_PX,
                        }}
                        aria-hidden
                      />
                    );
                  })}
                {timed.map((seg) => {
                  const height = Math.max(
                    ((seg.endMin - seg.startMin) / 60) * HOUR_PX - 2,
                    18,
                  );
                  return (
                    <button
                      key={seg.event.id}
                      type="button"
                      className={cn(
                        "cal-block",
                        sourceClass(view.palette, seg.event.sourceId),
                        height < 40 && "cal-block--compact",
                        seg.event.conflict && "cal-block--conflict",
                        seg.event.crossAccountConflict && "cal-block--cross",
                      )}
                      style={{
                        top: (seg.startMin / 60) * HOUR_PX,
                        height,
                        left: `calc(${(seg.lane / seg.lanes) * 100}% + 2px)`,
                        width: `calc(${100 / seg.lanes}% - 4px)`,
                      }}
                      onClick={() => view.onOpen(seg.event)}
                      aria-label={eventLabel(seg.event, view.tz)}
                    >
                      <span className="cal-block-title">{seg.event.title}</span>
                      <span className="cal-block-time">
                        {seg.continuesBefore ? "…" : ""}
                        {timeRange(seg.event, view.tz)}
                        {seg.continuesAfter ? "…" : ""}
                      </span>
                      <span className="cal-chip-source">
                        {seg.event.sourceLabel}
                      </span>
                      <ConflictMark e={seg.event} />
                    </button>
                  );
                })}
                {day.isToday && day.date === current.date && (
                  <div
                    className="cal-now"
                    style={{ top: (current.minutes / 60) * HOUR_PX }}
                    aria-label="Current time"
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ Upcoming ------------------------------ */

export function Agenda({ now, ...view }: ViewProps & { now: Date }) {
  const groups = groupByDay(view.events, view.tz);
  return (
    <div>
      {groups.map((g) => (
        <div key={g.date} className="cal-day">
          <h3 className="cal-day-title">{dayHeading(g.date, view.tz, now)}</h3>
          <ul className="cal-events">
            {g.events.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  className={cn(
                    "cal-event",
                    sourceClass(view.palette, e.sourceId),
                  )}
                  onClick={() => view.onOpen(e)}
                  aria-label={eventLabel(e, view.tz)}
                >
                  <span className="cal-event-time">
                    {timeRange(e, view.tz)}
                  </span>
                  <span className="cal-event-title">{e.title}</span>
                  <span className="cal-event-source">{e.sourceLabel}</span>
                  <ConflictMark e={e} />
                  {!e.busy && (
                    <span className="cal-free-tag">Shown as free</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
