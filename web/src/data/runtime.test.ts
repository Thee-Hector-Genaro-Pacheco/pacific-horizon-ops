import { describe, expect, it } from 'vitest';
import type { RuntimeStateDTO } from './contract';
import { createSseRuntime, presentRuntime, RECONNECT_GRACE_MS, runtimeHeadline, runtimeHud } from './runtime';
import type { RuntimeLink } from './services';

const rt = (over: Partial<RuntimeStateDTO> = {}): RuntimeStateDTO => ({
  state: 'idle',
  sessionActive: false,
  sessionId: null,
  operation: null,
  task: null,
  status: 'Standing by',
  context: null,
  at: '2026-10-09T00:00:00.000Z',
  settledBy: 'none',
  voiceGateway: 'online',
  ...over,
});

/** Minimal controllable EventSource + timers. */
function harness(fetchState: () => Promise<RuntimeStateDTO>) {
  const listeners = new Map<string, (e: MessageEvent<string>) => void>();
  const source = {
    readyState: 0,
    onerror: null as null | (() => void),
    onopen: null,
    closed: false,
    addEventListener(type: string, fn: (e: MessageEvent<string>) => void) {
      listeners.set(type, fn);
    },
    close() {
      this.closed = true;
    },
  };
  let t = 0;
  const timers = new Map<number, { at: number; fn: () => void; every?: number }>();
  let id = 0;
  const deps = {
    createSource: () => source as unknown as EventSource,
    fetchState,
    setInterval: (fn: () => void, ms: number) => (timers.set(++id, { at: t + ms, fn, every: ms }), id),
    clearInterval: (i: number) => void timers.delete(i),
    setTimeout: (fn: () => void, ms: number) => (timers.set(++id, { at: t + ms, fn }), id),
    clearTimeout: (i: number) => void timers.delete(i),
  };
  return {
    deps,
    source,
    emit: (state: RuntimeStateDTO) => listeners.get('runtime')!({ data: JSON.stringify(state) } as MessageEvent<string>),
    error: (readyState = 0) => {
      source.readyState = readyState;
      source.onerror?.();
    },
    advance(ms: number) {
      t += ms;
      for (const [k, v] of [...timers]) {
        if (v.at <= t) {
          v.fn();
          if (v.every) v.at = t + v.every;
          else timers.delete(k);
        }
      }
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('runtime adapter (SSE)', () => {
  it('loads current state immediately, then follows live events', async () => {
    const h = harness(async () => rt({ state: 'idle' }));
    const states: string[] = [];
    const links: RuntimeLink[] = [];
    const svc = createSseRuntime('/api', h.deps);
    const stop = svc.subscribe({ onState: (s) => states.push(s.state), onLink: (l) => links.push(l) });
    await flush();
    expect(states).toEqual(['idle']);
    h.emit(rt({ state: 'speaking', sessionActive: true }));
    h.emit(rt({ state: 'awaiting_approval', sessionActive: true }));
    expect(states).toEqual(['idle', 'speaking', 'awaiting_approval']);
    expect(links).toEqual(['connecting', 'live']);
    stop();
    expect(h.source.closed).toBe(true);
  });

  it('a dropped stream is "reconnecting", then "offline" after the grace period', async () => {
    const h = harness(async () => {
      throw new Error('down');
    });
    const links: RuntimeLink[] = [];
    createSseRuntime('/api', h.deps).subscribe({ onState: () => {}, onLink: (l) => links.push(l) });
    h.emit(rt());
    await flush();
    h.error();
    expect(links.at(-1)).toBe('reconnecting');
    h.advance(RECONNECT_GRACE_MS + 1);
    await flush();
    expect(links.at(-1)).toBe('offline');
  });

  it('recovers to "live" when the stream returns', async () => {
    const h = harness(async () => rt());
    const links: RuntimeLink[] = [];
    createSseRuntime('/api', h.deps).subscribe({ onState: () => {}, onLink: (l) => links.push(l) });
    h.emit(rt());
    h.error();
    h.emit(rt({ state: 'listening', sessionActive: true }));
    expect(links.slice(-2)).toEqual(['reconnecting', 'live']);
  });

  it('API unreachable from the start is "offline"', async () => {
    const h = harness(async () => {
      throw new Error('down');
    });
    const links: RuntimeLink[] = [];
    createSseRuntime('/api', h.deps).subscribe({ onState: () => {}, onLink: (l) => links.push(l) });
    await flush();
    expect(links.at(-1)).toBe('offline');
  });
});

describe('presentRuntime (Command Center binding)', () => {
  it('maps live runtime states straight through', () => {
    expect(presentRuntime(rt({ state: 'awaiting_approval', sessionActive: true }), 'live')).toMatchObject({ state: 'awaiting_approval', label: 'AWAITING APPROVAL', signal: 'live', sessionActive: true });
    expect(presentRuntime(rt({ state: 'executing', sessionActive: true }), 'live').state).toBe('executing');
    expect(presentRuntime(rt({ state: 'success', sessionActive: true }), 'live').label).toBe('COMPLETE');
    expect(presentRuntime(rt({ state: 'error', sessionActive: true }), 'live').state).toBe('error');
  });

  it('no session -> STANDBY idle', () => {
    expect(presentRuntime(rt(), 'live')).toMatchObject({ state: 'idle', label: 'STANDBY', sessionActive: false });
  });

  it('never holds EXECUTING or SUCCESS without a live link', () => {
    for (const link of ['reconnecting', 'offline', 'connecting'] as RuntimeLink[]) {
      expect(presentRuntime(rt({ state: 'executing', sessionActive: true }), link).state).toBe('idle');
      expect(presentRuntime(rt({ state: 'success', sessionActive: true }), link).state).toBe('idle');
    }
    expect(presentRuntime(null, 'offline')).toMatchObject({ label: 'NO SIGNAL', signal: 'offline' });
    expect(presentRuntime(null, 'reconnecting')).toMatchObject({ label: 'RECONNECTING', signal: 'degraded' });
  });

  it('labels an offline voice gateway honestly', () => {
    expect(presentRuntime(rt({ voiceGateway: 'offline' }), 'live').label).toBe('VOICE OFFLINE');
  });
});

describe('session HUD', () => {
  it('is absent without an active session', () => {
    expect(runtimeHud(rt(), presentRuntime(rt(), 'live'))).toBeNull();
  });

  it('shows session, task, sender and approval without ids', () => {
    const r = rt({
      state: 'awaiting_approval',
      sessionActive: true,
      sessionId: 'vses_secret',
      task: 'Awaiting approval confirmation',
      status: 'Waiting for confirm approval',
      context: { senderName: 'Alice Johnson', subject: 'Photo Booth for Birthday Party' },
    });
    const hud = runtimeHud(r, presentRuntime(r, 'live'))!;
    expect(hud.map((h) => h.label)).toEqual(['Voice session', 'Current task', 'Selected message', 'Action']);
    expect(hud.at(-1)).toMatchObject({ value: 'AWAITING APPROVAL', tone: 'tone-warn' });
    expect(JSON.stringify(hud)).not.toContain('vses_secret');
    expect(runtimeHeadline(r, presentRuntime(r, 'live'))).toBe('Waiting for confirm approval · Photo Booth for Birthday Party');
  });

  it('reports execution outcome', () => {
    const r = rt({ state: 'executing', sessionActive: true, task: 'Sending email' });
    expect(runtimeHud(r, presentRuntime(r, 'live'))!.at(-1)).toMatchObject({ label: 'Execution', value: 'SENDING EMAIL' });
    const ok = rt({ state: 'success', sessionActive: true });
    expect(runtimeHud(ok, presentRuntime(ok, 'live'))!.at(-1)).toMatchObject({ value: 'EMAIL SENT' });
  });
});
