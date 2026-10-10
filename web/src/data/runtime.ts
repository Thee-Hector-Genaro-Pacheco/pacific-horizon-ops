import type { PacificOpsState, RuntimeStateDTO } from './contract';
import type { RuntimeLink, RuntimeService } from './services';

/**
 * Client side of the Pacific Ops runtime stream.
 *
 *   GET /api/runtime/state   current resolved state (used on load and while the stream is down)
 *   GET /api/runtime/events  SSE: `event: runtime` frames, one per change, current state first
 *
 * The browser only receives. Nothing here can approve, send or call.
 */

/** How long a dropped stream may keep retrying before we call the backend offline. */
export const RECONNECT_GRACE_MS = 15_000;
/** While not live, re-read the current state at this interval. */
export const STATE_POLL_MS = 5_000;

type EventSourceLike = Pick<EventSource, 'addEventListener' | 'close' | 'readyState'> & {
  onerror: ((this: EventSource, ev: Event) => unknown) | null;
  onopen: ((this: EventSource, ev: Event) => unknown) | null;
};

export interface SseRuntimeDeps {
  createSource?: (url: string) => EventSourceLike | null;
  fetchState?: () => Promise<RuntimeStateDTO>;
  setInterval?: (fn: () => void, ms: number) => number;
  clearInterval?: (id: number) => void;
  setTimeout?: (fn: () => void, ms: number) => number;
  clearTimeout?: (id: number) => void;
}

export function createSseRuntime(base = '/api', deps: SseRuntimeDeps = {}): RuntimeService {
  const fetchState =
    deps.fetchState ??
    (async () => {
      const res = await fetch(`${base}/runtime/state`, { headers: { Accept: 'application/json' } });
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !type.includes('application/json')) throw new Error('runtime unavailable');
      return ((await res.json()) as { data: RuntimeStateDTO }).data;
    });
  const createSource =
    deps.createSource ?? ((url: string) => (typeof EventSource !== 'undefined' ? (new EventSource(url) as EventSourceLike) : null));
  const setI = deps.setInterval ?? ((fn, ms) => window.setInterval(fn, ms));
  const clearI = deps.clearInterval ?? ((id) => window.clearInterval(id));
  const setT = deps.setTimeout ?? ((fn, ms) => window.setTimeout(fn, ms));
  const clearT = deps.clearTimeout ?? ((id) => window.clearTimeout(id));

  return {
    getState: fetchState,
    subscribe({ onState, onLink }) {
      let link: RuntimeLink = 'connecting';
      let closed = false;
      let graceTimer: number | null = null;
      const setLink = (next: RuntimeLink) => {
        if (next === link) return;
        link = next;
        onLink(next);
      };
      onLink('connecting');

      const readState = () =>
        fetchState()
          .then((s) => {
            if (closed) return;
            onState(s);
            // A reachable API with a dead stream is degraded, not offline.
            if (link === 'offline') setLink('reconnecting');
          })
          .catch(() => {
            if (!closed && link !== 'live') setLink('offline');
          });

      void readState();

      const source = createSource(`${base}/runtime/events`);
      if (source) {
        source.addEventListener('runtime', (e) => {
          if (graceTimer !== null) {
            clearT(graceTimer);
            graceTimer = null;
          }
          setLink('live');
          try {
            onState(JSON.parse((e as MessageEvent<string>).data) as RuntimeStateDTO);
          } catch {
            /* ignore malformed frames */
          }
        });
        source.onerror = () => {
          if (closed) return;
          // EventSource retries on its own; CLOSED (2) means it gave up.
          if (source.readyState === 2) {
            setLink('offline');
            return;
          }
          if (link === 'live' || link === 'connecting') setLink(link === 'live' ? 'reconnecting' : link);
          if (graceTimer === null) {
            graceTimer = setT(() => {
              graceTimer = null;
              if (link !== 'live') setLink('offline');
            }, RECONNECT_GRACE_MS);
          }
        };
      }

      const poll = setI(() => {
        if (link !== 'live') void readState();
      }, STATE_POLL_MS);

      return () => {
        closed = true;
        clearI(poll);
        if (graceTimer !== null) clearT(graceTimer);
        source?.close();
      };
    },
  };
}

/* ------------------------------------------------------------------ */
/* Presentation: what the Command Center shows for a runtime + link     */
/* ------------------------------------------------------------------ */

export interface RuntimePresentation {
  /** Visual state for <PacificOpsPresence>. */
  state: PacificOpsState;
  /** Short operator label for the header. */
  label: string;
  /** Signal quality of the runtime link itself. */
  signal: 'live' | 'degraded' | 'offline' | 'demo';
  /** True only when a real voice session is connected and the link is live. */
  sessionActive: boolean;
}

const LABEL: Record<PacificOpsState, string> = {
  idle: 'STANDBY',
  listening: 'LISTENING',
  thinking: 'PROCESSING',
  speaking: 'SPEAKING',
  awaiting_approval: 'AWAITING APPROVAL',
  executing: 'EXECUTING',
  success: 'COMPLETE',
  error: 'FAULT',
};

/**
 * Pure mapping used by the Command Center. Without a live link it never shows an
 * in-progress or outcome state, so a dropped connection cannot leave the hologram
 * stuck on EXECUTING or SUCCESS.
 */
export function presentRuntime(runtime: RuntimeStateDTO | null, link: RuntimeLink): RuntimePresentation {
  if (link === 'offline') return { state: 'idle', label: 'NO SIGNAL', signal: 'offline', sessionActive: false };
  if (link === 'connecting') return { state: 'idle', label: 'CONNECTING', signal: 'degraded', sessionActive: false };
  if (link === 'reconnecting') return { state: 'idle', label: 'RECONNECTING', signal: 'degraded', sessionActive: false };
  const signal = link === 'demo' ? 'demo' : 'live';
  if (!runtime) return { state: 'idle', label: 'STANDBY', signal, sessionActive: false };
  if (runtime.voiceGateway === 'offline' && !runtime.sessionActive && runtime.state === 'idle') {
    return { state: 'idle', label: 'VOICE OFFLINE', signal, sessionActive: false };
  }
  return { state: runtime.state, label: LABEL[runtime.state], signal, sessionActive: runtime.sessionActive };
}

/* ------------------------------------------------------------------ */
/* Session HUD                                                          */
/* ------------------------------------------------------------------ */

export interface RuntimeHudItem {
  label: string;
  value: string;
  tone: 'tone-ok' | 'tone-info' | 'tone-warn' | 'tone-fail' | 'tone-idle';
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Telemetry for a live voice session, or null when there is none. Uses display-safe
 * fields only (task, sender display name); no ids, addresses or message bodies.
 */
export function runtimeHud(runtime: RuntimeStateDTO | null, view: RuntimePresentation): RuntimeHudItem[] | null {
  if (!runtime || !view.sessionActive) return null;
  const items: RuntimeHudItem[] = [{ label: 'Voice session', value: 'ACTIVE', tone: 'tone-ok' }];
  if (runtime.task) items.push({ label: 'Current task', value: clip(runtime.task.toUpperCase(), 30), tone: 'tone-info' });
  if (runtime.context?.senderName) {
    items.push({ label: 'Selected message', value: clip(runtime.context.senderName.toUpperCase(), 26), tone: 'tone-info' });
  }
  const action: Partial<Record<PacificOpsState, RuntimeHudItem>> = {
    awaiting_approval: { label: 'Action', value: 'AWAITING APPROVAL', tone: 'tone-warn' },
    executing: { label: 'Execution', value: 'SENDING EMAIL', tone: 'tone-info' },
    success: { label: 'Execution', value: 'EMAIL SENT', tone: 'tone-ok' },
    error: { label: 'Execution', value: 'FAILED', tone: 'tone-fail' },
  };
  const a = action[runtime.state];
  if (a) items.push(a);
  return items;
}

/** One display-safe line for the hologram headline during a session. */
export function runtimeHeadline(runtime: RuntimeStateDTO | null, view: RuntimePresentation): string | null {
  if (!runtime || !view.sessionActive) return null;
  const subject = runtime.context?.subject;
  return subject ? `${runtime.status} · ${clip(subject, 48)}` : runtime.status;
}
