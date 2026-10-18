import type { ContextProvider, LiveContextItem, ProviderNotice } from '../cognition/context.js';
import { MultiCalendar, type CalendarSource } from '../calendar/multi.js';
import { formatClockRange } from '../calendar/speech.js';
import { readInboxes, type InboxSource } from '../google/gmailRead.js';
import { knowledgeContextProvider } from '../knowledge/grounding.js';
import type { SqlDb } from '../knowledge/db.js';
import type { EmbeddingProvider } from '../knowledge/embeddings.js';
import type { PhotoBoothAnalyticsClient } from '../photobooth/client.js';
import { describeEventSummary } from '../photobooth/semantics.js';

/**
 * Context providers for cross-domain reasoning. Each wraps an existing read path and is
 * only invoked when a ContextPlan lists it. They produce display-safe summaries: Calendar
 * titles follow privacy policy, inbox items carry sender name and subject only.
 */

export function knowledgeProvider(deps: { db: SqlDb; embedder: EmbeddingProvider | null }): ContextProvider {
  return { ...knowledgeContextProvider(deps), capabilities: ['knowledge.read'] };
}

export function calendarProvider(deps: { sources: CalendarSource[]; timeZone: string; window: { start: Date; end: Date } }): ContextProvider {
  return {
    name: 'calendar',
    capabilities: ['calendar.read'],
    async collect() {
      const { events, meta } = await new MultiCalendar(deps.sources, deps.timeZone).listEvents(deps.window.start, deps.window.end);
      const asOf = new Date().toISOString();
      const liveContext: LiveContextItem[] = events.slice(0, 20).map((e) => ({
        kind: 'calendar',
        label: `${e.sourceLabel} · ${e.calendarLabel}`,
        summary: `${e.title}: ${e.allDay ? 'all day' : formatClockRange(e.start, e.end, deps.timeZone)}`,
        asOf,
      }));
      const notices: ProviderNotice[] = meta.failed.map((f) => ({ provider: 'calendar', status: 'unavailable', detail: `${f.label} calendar could not be checked (${f.kind}).` }));
      return { liveContext, notices };
    },
  };
}

export function gmailProvider(deps: { sources: InboxSource[] }): ContextProvider {
  return {
    name: 'gmail',
    capabilities: ['gmail.read'],
    async collect() {
      const agg = await readInboxes(deps.sources, { max: 5 });
      const asOf = new Date().toISOString();
      return {
        liveContext: agg.items.slice(0, 10).map((i) => ({ kind: 'gmail', label: i.profileLabel, summary: `From ${i.senderName}: ${i.subject}`, asOf })),
        notices: agg.failed.map((f) => ({ provider: 'gmail', status: 'unavailable', detail: `${f.label} inbox could not be checked (${f.kind}).` })),
      };
    },
  };
}

export function photoBoothProvider(deps: { client: PhotoBoothAnalyticsClient }): ContextProvider {
  return {
    name: 'photo_booth',
    capabilities: ['photobooth.read'],
    async collect() {
      const latest = await deps.client.latestEvent();
      if (!latest.eventId) return { liveContext: [], notices: [{ provider: 'photo_booth', status: 'degraded', detail: 'No booth activity recorded yet.' }] };
      const summary = await deps.client.eventSummary(latest.eventId);
      return { liveContext: [{ kind: 'photo_booth', label: 'Latest booth event', summary: describeEventSummary(summary, { spoken: true }), asOf: new Date().toISOString() }] };
    },
  };
}
