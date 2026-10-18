import { CalendarDays, ChevronLeft, ChevronRight, CircleAlert, Clock, Info, Radar } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Agenda, MonthGrid, TimeGrid } from '../components/CalendarViews';
import { DetailDrawer, DrawerSection } from '../components/DetailDrawer';
import { Chip, EmptyState, ErrorState, PageHeader, Panel, Segmented, SkeletonRows, SourceBadge } from '../components/primitives';
import type { CalendarEventDTO, CalendarHubDTO } from '../data/contract';
import { useData } from '../data/DataProvider';
import { useResource } from '../data/useResource';
import { availabilityLines, connectionLabel, dayHeading, localDateKey, scopeFromVoice, scopeOptions, scopeToSourceIds, type ScopeKey } from '../lib/calendarHub';
import { eventDetailFields, sourcePalette } from '../lib/calendarLayout';
import { useNow } from '../lib/useNow';

type CalView = 'month' | 'week' | 'day' | 'upcoming';

/**
 * Read-only multi-account calendar. Month / Week / Day / Upcoming over one API fetch per
 * visible range; dates, navigation and labels come from the API in the business timezone.
 * There are no create, edit, delete, drag or RSVP controls by design.
 */
export function CalendarPage() {
  const { mode } = useData();
  const [view, setView] = useState<CalView>('week');
  const [anchor, setAnchor] = useState<string | null>(null);
  const [scope, setScope] = useState<ScopeKey>('all');
  const [known, setKnown] = useState<CalendarHubDTO | undefined>(undefined);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [open, setOpen] = useState<CalendarEventDTO | null>(null);
  const now = new Date(useNow());
  const sourceIds = scopeToSourceIds(scope, known);

  const hub = useResource(
    async (s) => {
      const data = await s.calendar.getHub({ view, date: anchor, sourceIds });
      setKnown(data);
      return data;
    },
    [view, anchor, sourceIds?.join(',') ?? 'all'],
    ['calls']
  );
  const h = hub.data;
  const tz = h?.timeZone ?? 'America/Los_Angeles';
  const palette = useMemo(() => sourcePalette(h?.sources.map((s) => s.sourceId) ?? []), [h?.sources]);
  const options = h ? scopeOptions(h) : [{ value: 'all', label: 'All calendars' }];

  const go = (date: string) => {
    setAnchor(date);
    setSelectedDay(null);
  };
  const showDay = (date: string) => {
    setView('day');
    go(date);
  };
  const voiceDay = h?.voice ? localDateKey(h.voice.windowStart, tz) : null;
  const voiceSingleDay = h?.voice ? Date.parse(h.voice.windowEnd) - Date.parse(h.voice.windowStart) <= 25 * 3_600_000 : false;
  const applyVoice = () => {
    if (!h?.voice || !voiceDay) return;
    setScope(scopeFromVoice(h.voice, h));
    setView(voiceSingleDay ? 'day' : 'week');
    go(voiceDay);
  };

  // Availability panel: the selected/anchor day in month view, every visible day otherwise.
  const availDays = !h
    ? []
    : view === 'month'
      ? h.availability.filter((a) => a.date === (selectedDay ?? (h.days.some((d) => d.date === h.nav.today) ? h.nav.today : h.nav.anchor)))
      : h.availability;

  return (
    <>
      <PageHeader
        eyebrow="Operations"
        title="Calendar"
        description="Every connected Google calendar in one read-only view. Pacific Ops uses the same sources, privacy and availability."
        actions={<SourceBadge kind={mode} />}
      />

      {h?.voice && (
        <div className="cal-voice" role="status">
          <Radar size={14} aria-hidden />
          <span>
            Pacific Ops last checked <strong>{h.voice.scopeLabel}</strong>
            {h.voice.dayLabel ? <> · {h.voice.dayLabel}</> : null}
          </span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={applyVoice}>
            Show this scope
          </button>
        </div>
      )}

      <div className="cal-toolbar">
        {view !== 'upcoming' && (
          <div className="cal-nav" role="group" aria-label="Calendar navigation">
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => h && go(h.nav.prev)} aria-label="Previous" disabled={!h}>
              <ChevronLeft size={14} aria-hidden />
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => h && go(h.nav.today)} disabled={!h}>
              Today
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => h && go(h.nav.next)} aria-label="Next" disabled={!h}>
              <ChevronRight size={14} aria-hidden />
            </button>
          </div>
        )}
        <h2 className="cal-range-label">{h?.range.label ?? ' '}</h2>
        <Segmented
          label="Calendar view"
          value={view}
          onChange={(v) => {
            setView(v);
            setSelectedDay(null);
          }}
          options={[
            { value: 'month', label: 'Month' },
            { value: 'week', label: 'Week' },
            { value: 'day', label: 'Day' },
            { value: 'upcoming', label: 'Upcoming' },
          ]}
        />
        <label className="cal-scope">
          <span className="muted">Showing</span>
          <select value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Calendars to show">
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {h && <Chip>{h.scope.label}</Chip>}
      </div>

      {hub.error && !h ? (
        <Panel>
          <ErrorState error={hub.error} onRetry={hub.reload} />
        </Panel>
      ) : !h ? (
        <Panel>
          <SkeletonRows rows={4} label="Loading calendars" />
        </Panel>
      ) : (
        <>
          {h.failures.length > 0 && (
            <p className="cal-warning" role="alert">
              <CircleAlert size={14} aria-hidden />
              {h.status === 'failed' ? "Couldn't load any selected calendar: " : 'Partial results. Not checked: '}
              {h.failures.map((f) => `${f.label} (${connectionLabel(f.kind).toLowerCase()})`).join(', ')}
            </p>
          )}

          <div className="cal-grid">
            <Panel className="cal-main" flush>
              {view === 'month' && (
                <MonthGrid
                  days={h.days}
                  events={h.events}
                  tz={tz}
                  palette={palette}
                  onOpen={setOpen}
                  selected={selectedDay}
                  onSelectDay={setSelectedDay}
                  onShowDay={showDay}
                />
              )}
              {(view === 'week' || view === 'day') && (
                <TimeGrid days={h.days} availability={h.availability} events={h.events} tz={tz} palette={palette} onOpen={setOpen} now={now} />
              )}
              {view === 'upcoming' &&
                (h.events.length ? (
                  <Agenda events={h.events} tz={tz} palette={palette} onOpen={setOpen} now={now} />
                ) : (
                  <EmptyState icon={CalendarDays} title={h.status === 'failed' ? 'No calendar data' : 'Nothing scheduled'} compact>
                    {h.status === 'failed'
                      ? 'None of the selected calendars could be read.'
                      : h.status === 'partial'
                        ? 'Nothing on the calendars that answered. Some calendars could not be checked.'
                        : 'No upcoming events for the selected calendars.'}
                  </EmptyState>
                ))}
              {view !== 'upcoming' && h.events.length === 0 && (
                <p className="muted cal-empty-note">{h.status === 'complete' ? 'No events in this range for the selected calendars.' : 'No events on the calendars that answered.'}</p>
              )}
            </Panel>

            <div className="cal-side">
              <Panel title="Availability" icon={Clock}>
                <p className="muted cal-note">
                  <Info size={12} aria-hidden /> 8 AM – 10 PM, merged across {h.scope.label.toLowerCase()} via Google free/busy.
                </p>
                {view === 'month' && <p className="muted cal-note">Select a date to see its availability.</p>}
                {availDays.map((d) => {
                  const lines = availabilityLines(d, tz);
                  return (
                    <div key={d.date} className="cal-avail">
                      <h3 className="cal-day-title">{dayHeading(d.date, tz, now)}</h3>
                      {lines.note && <p className="cal-warning cal-warning--inline">{lines.note}</p>}
                      {lines.free && (
                        <div>
                          <span className="cal-avail-label">Free</span>
                          {lines.free.length ? lines.free.map((l) => <div key={l}>{l}</div>) : <div className="muted">No open time</div>}
                        </div>
                      )}
                      {d.status !== 'failed' && (
                        <div>
                          <span className="cal-avail-label">{d.status === 'partial' ? 'Busy (calendars checked)' : 'Busy'}</span>
                          {lines.busy.length ? lines.busy.map((l) => <div key={l}>{l}</div>) : <div className="muted">Nothing busy</div>}
                        </div>
                      )}
                    </div>
                  );
                })}
              </Panel>

              <Panel title="Accounts">
                <ul className="cal-accounts">
                  {h.profiles.map((p) => (
                    <li key={p.profileId}>
                      <strong>{p.label}</strong>
                      <span className={p.connection === 'connected' ? 'cal-ok' : p.connection ? 'cal-bad' : 'muted'}>{connectionLabel(p.connection)}</span>
                      <div className="cal-legend">
                        {h.sources
                          .filter((s) => s.profileId === p.profileId)
                          .map((s) => (
                            <span key={s.sourceId} className={`cal-src cal-src--${palette.get(s.sourceId) ?? 0} cal-legend-item`}>
                              {s.calendarLabel}
                              {s.privacy === 'busy_only' ? ' (titles hidden)' : ''}
                            </span>
                          ))}
                      </div>
                    </li>
                  ))}
                </ul>
              </Panel>
            </div>
          </div>
        </>
      )}

      <DetailDrawer open={open !== null} onClose={() => setOpen(null)} eyebrow={open?.sourceLabel} title={open?.title ?? ''}>
        {open && (
          <DrawerSection title="Event">
            <dl className="cal-detail">
              {eventDetailFields(open, tz, dayHeading(localDateKey(open.start, tz), tz, now)).map(([k, v]) => (
                <div key={k} className="cal-detail-row">
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </DrawerSection>
        )}
      </DetailDrawer>
    </>
  );
}
