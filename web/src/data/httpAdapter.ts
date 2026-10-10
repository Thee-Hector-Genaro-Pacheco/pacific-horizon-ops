import type { ChangeEventDTO, Envelope } from './contract';
import {
  ApiUnavailableError,
  NotFoundError,
  type LinkState,
  type PacificServices,
  type RealtimeService,
} from './services';

const POLL_INTERVAL_MS = 30_000;

async function getJson<T>(path: string, what: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { headers: { Accept: 'application/json' } });
  } catch {
    throw new ApiUnavailableError();
  }
  if (res.status === 404) throw new NotFoundError(what);
  // Vite's dev proxy answers 5xx when the API process is down.
  if (res.status >= 500) throw new ApiUnavailableError();
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) throw new ApiUnavailableError();
  const body = (await res.json()) as Envelope<T>;
  return body.data;
}

const enc = encodeURIComponent;

/**
 * Server-Sent Events with a polling fallback. EventSource reconnects on its own;
 * while it is down we emit a synthetic "everything changed" tick so views stay fresh.
 */
export function createSseRealtime(url = '/api/stream'): RealtimeService {
  return {
    subscribe({ onChange, onLinkState }) {
      let state: LinkState = 'connecting';
      const setState = (next: LinkState) => {
        if (next !== state) {
          state = next;
          onLinkState(next);
        }
      };
      onLinkState('connecting');

      let source: EventSource | null = null;
      if (typeof EventSource !== 'undefined') {
        source = new EventSource(url);
        source.addEventListener('ready', () => setState('live'));
        source.addEventListener('change', (e) => {
          try {
            onChange(JSON.parse((e as MessageEvent<string>).data) as ChangeEventDTO);
          } catch {
            /* ignore malformed frames */
          }
        });
        source.onerror = () => setState('polling');
      }

      const poll = window.setInterval(() => {
        if (state !== 'live') {
          onChange({ at: new Date().toISOString(), topics: ['actions', 'calls', 'inbox', 'activity'] });
        }
      }, POLL_INTERVAL_MS);

      return () => {
        window.clearInterval(poll);
        source?.close();
      };
    },
  };
}

export function createHttpServices(base = '/api'): PacificServices {
  return {
    kind: 'live',
    dashboard: {
      getCommandCenter: () => getJson(`${base}/command-center`, 'Command center'),
      getHealth: () => getJson(`${base}/health`, 'Health'),
      getAnalytics: () => getJson(`${base}/analytics`, 'Analytics'),
    },
    mailbox: {
      listInbox: () => getJson(`${base}/inbox`, 'Inbox'),
      getInboxItem: (id) => getJson(`${base}/inbox/${enc(id)}`, 'Message'),
    },
    actions: {
      listActions: () => getJson(`${base}/actions`, 'Actions'),
      getAction: (id) => getJson(`${base}/actions/${enc(id)}`, 'Action'),
    },
    calls: {
      listCalls: () => getJson(`${base}/calls`, 'Calls'),
      getCall: (id) => getJson(`${base}/calls/${enc(id)}`, 'Call'),
    },
    leads: {
      listLeads: () => getJson(`${base}/leads`, 'Leads'),
      listCustomers: () => getJson(`${base}/customers`, 'Customers'),
      getCustomer: (id) => getJson(`${base}/customers/${enc(id)}`, 'Customer'),
    },
    activity: {
      listActivity: (limit = 100) => getJson(`${base}/activity?limit=${limit}`, 'Activity'),
    },
    realtime: createSseRealtime(`${base}/stream`),
  };
}
