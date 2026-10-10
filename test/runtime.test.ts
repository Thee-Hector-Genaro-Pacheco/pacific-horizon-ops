import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import {
  ACTIVE_STALE_MS,
  OUTCOME_HOLD_MS,
  PacificOpsRuntimeStore,
  RUNTIME_FILES,
  readRuntimeState,
  resolveRuntimeState,
  safeContext,
  type PacificOpsRuntimeEvent,
} from '../src/runtime/pacificOpsRuntime.js';
import { VoicePresenceReporter, observeExecutor, type RuntimeSink } from '../src/voice/presenceReporter.js';
import { VoiceStore } from '../src/voice/store.js';
import { ActionStore } from '../src/actions/store.js';
import { createVoiceServer } from '../src/voice/server.js';
import { createDashboardServer } from '../src/dashboard/server.js';
import type { ActionExecutor } from '../src/actions/executor.js';
import type { EligibleInboxMessage } from '../src/voice/mailbox.js';

type Published = Omit<PacificOpsRuntimeEvent, 'eventId' | 'seq' | 'at'>;

class CaptureSink implements RuntimeSink {
  events: Published[] = [];
  publish(input: Published) {
    this.events.push(input);
  }
  states() {
    return this.events.map((e) => e.state);
  }
}

/** Manual timers so settle behaviour is deterministic. */
function manualTimers() {
  const pending = new Map<number, () => void>();
  let id = 0;
  return {
    setTimer: (fn: () => void) => {
      pending.set(++id, fn);
      return id;
    },
    clearTimer: (h: unknown) => pending.delete(h as number),
    flush() {
      const fns = [...pending.values()];
      pending.clear();
      fns.forEach((f) => f());
    },
    get size() {
      return pending.size;
    },
  };
}

function tmpDir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function voiceStoreIn(dir: string) {
  return new VoiceStore({ dataDir: dir, sessionsFilePath: path.join(dir, 'voice-sessions.json'), eventsFilePath: path.join(dir, 'voice-events.jsonl') });
}

/* ------------------------------------------------------------------ */

describe('Pacific Ops runtime model', () => {
  let dir: string;
  beforeEach(() => (dir = tmpDir('phro-runtime-')));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('keeps only display-safe context: no addresses or phone numbers, bounded length', () => {
    const ctx = safeContext({ senderName: 'Alice <alice@example.com>', subject: 'Call me at +1 949 555 0100 about the booth ' + 'x'.repeat(200) });
    assert.equal(ctx?.senderName, 'Alice');
    assert.ok(!ctx?.subject?.includes('949'));
    assert.ok((ctx?.subject?.length ?? 0) <= 80);
    assert.equal(safeContext({ senderName: 'bob@example.com' }), null);
  });

  it('publishes the current state atomically and appends to the event log', () => {
    const store = new PacificOpsRuntimeStore({ dataDir: dir });
    store.publish({ state: 'speaking', sessionId: 's1', sessionActive: true, source: 'voice', operation: 'call', task: 'Greeting owner', status: 'Pacific Ops speaking', context: null });
    store.publish({ state: 'listening', sessionId: 's1', sessionActive: true, source: 'voice', operation: 'call', task: null, status: 'Waiting', context: null });
    const current = readRuntimeState(dir);
    assert.equal(current?.state, 'listening');
    assert.equal(current?.seq, 2);
    const log = fs.readFileSync(path.join(dir, RUNTIME_FILES.events), 'utf-8').trim().split('\n');
    assert.equal(log.length, 2);
    assert.ok(!fs.readdirSync(dir).some((f) => f.includes('.tmp.')), 'no temp files left behind');
  });

  it('reads a missing or corrupt runtime file as no runtime', () => {
    assert.equal(readRuntimeState(dir), null);
    fs.writeFileSync(path.join(dir, RUNTIME_FILES.state), '{ not json');
    assert.equal(readRuntimeState(dir), null);
    fs.writeFileSync(path.join(dir, RUNTIME_FILES.state), JSON.stringify({ state: 'hacking', at: new Date().toISOString() }));
    assert.equal(readRuntimeState(dir), null);
  });

  describe('resolveRuntimeState', () => {
    const at = (state: PacificOpsRuntimeEvent['state'], ageMs: number, sessionActive = true): PacificOpsRuntimeEvent => ({
      eventId: 'e',
      seq: 1,
      state,
      sessionId: 's',
      sessionActive,
      at: new Date(1_000_000_000 - ageMs).toISOString(),
      source: 'voice',
      operation: null,
      task: null,
      status: 'x',
      context: null,
    });
    const now = 1_000_000_000;

    it('no runtime yet -> idle', () => {
      assert.equal(resolveRuntimeState(null, { now, voiceGateway: 'unknown' }).state, 'idle');
    });
    it('shows a fresh in-call state as-is', () => {
      assert.equal(resolveRuntimeState(at('executing', 1000), { now, voiceGateway: 'online' }).state, 'executing');
    });
    it('success and error are held briefly, then settle to idle', () => {
      assert.equal(resolveRuntimeState(at('success', OUTCOME_HOLD_MS - 1), { now, voiceGateway: 'online' }).state, 'success');
      const settled = resolveRuntimeState(at('success', OUTCOME_HOLD_MS + 1), { now, voiceGateway: 'online' });
      assert.equal(settled.state, 'idle');
      assert.equal(settled.settledBy, 'outcome_elapsed');
      assert.equal(resolveRuntimeState(at('error', OUTCOME_HOLD_MS + 1), { now, voiceGateway: 'online' }).state, 'idle');
    });
    it('never leaves EXECUTING forever: stale active states settle', () => {
      const r = resolveRuntimeState(at('executing', ACTIVE_STALE_MS + 1), { now, voiceGateway: 'online' });
      assert.equal(r.state, 'idle');
      assert.equal(r.settledBy, 'stale');
    });
    it('an offline voice gateway cannot be speaking', () => {
      const r = resolveRuntimeState(at('speaking', 500), { now, voiceGateway: 'offline' });
      assert.equal(r.state, 'idle');
      assert.equal(r.settledBy, 'gateway_offline');
    });
  });
});

/* ------------------------------------------------------------------ */

describe('VoicePresenceReporter', () => {
  let dir: string;
  let voiceStore: VoiceStore;
  let sink: CaptureSink;
  let timers: ReturnType<typeof manualTimers>;
  let reporter: VoicePresenceReporter;
  let sessionId: string;

  beforeEach(() => {
    dir = tmpDir('phro-reporter-');
    voiceStore = voiceStoreIn(dir);
    sink = new CaptureSink();
    timers = manualTimers();
    reporter = new VoicePresenceReporter(sink, voiceStore, { setTimer: timers.setTimer, clearTimer: timers.clearTimer, playbackMs: () => 1, log: () => {} });
    sessionId = voiceStore.createSession({ actionId: 'mailbox', toPhone: '+15551234567', fromPhone: '+15559876543', conversationState: 'MAILBOX_SELECTING', metadata: { mode: 'mailbox' } }).sessionId;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('speaking settles to listening once playback is done', () => {
    reporter.sessionConnected(sessionId);
    reporter.speaking(sessionId, 'I found three recent business emails.');
    timers.flush();
    assert.deepEqual(sink.states(), ['idle', 'speaking', 'listening']);
    assert.equal(sink.events[1].task, 'Reviewing mailbox');
  });

  it('settles to AWAITING_APPROVAL when the conversation is waiting for "confirm approval"', () => {
    voiceStore.updateConversationState(sessionId, 'AWAITING_APPROVAL_CONFIRMATION', { reason: 'test' });
    reporter.speaking(sessionId, 'To send this draft, please say confirm approval.');
    timers.flush();
    assert.deepEqual(sink.states(), ['speaking', 'awaiting_approval']);
    assert.equal(sink.events[1].operation, 'approval');
  });

  it('owner speech cancels the settle and is reported once per burst', () => {
    reporter.speaking(sessionId, 'hello');
    reporter.ownerSpeaking(sessionId);
    reporter.ownerSpeaking(sessionId);
    reporter.ownerSpeaking(sessionId);
    assert.equal(timers.size, 0);
    reporter.processing(sessionId);
    assert.deepEqual(sink.states(), ['speaking', 'listening', 'thinking']);
  });

  it('owner speech after playback settled is still reported as "Owner speaking"', () => {
    reporter.speaking(sessionId, 'hello');
    timers.flush(); // settled: listening / "Waiting for owner"
    reporter.ownerSpeaking(sessionId);
    assert.deepEqual(sink.states(), ['speaking', 'listening', 'listening']);
    assert.equal(sink.events.at(-1)?.status, 'Owner speaking');
  });

  it('execution outranks speech and is followed by a real outcome', () => {
    reporter.executionStarted(sessionId);
    reporter.speaking(sessionId, 'Sending now');
    reporter.processing(sessionId);
    reporter.executionFinished(sessionId, true);
    reporter.speaking(sessionId, 'The email has been sent. Goodbye!', { final: true });
    reporter.sessionEnded(sessionId);
    assert.deepEqual(sink.states(), ['executing', 'success', 'idle']);
    assert.equal(sink.events.at(-1)?.sessionActive, false);
  });

  it('a failed send reports ERROR, never SUCCESS', () => {
    reporter.executionStarted(sessionId);
    reporter.executionFinished(sessionId, false);
    assert.deepEqual(sink.states(), ['executing', 'error']);
  });

  it('includes only the selected sender display name and subject', () => {
    voiceStore.updateSessionMetadata(sessionId, {
      mode: 'mailbox',
      selectedMessage: { senderName: 'Alice Johnson', subject: 'Photo Booth for Birthday', from: 'alice@example.com', body: 'private body', messageId: 'msg_1' },
    });
    reporter.processing(sessionId);
    const ctx = sink.events[0].context;
    assert.deepEqual(ctx, { senderName: 'Alice Johnson', subject: 'Photo Booth for Birthday' });
    assert.ok(!JSON.stringify(sink.events).includes('private body'));
    assert.ok(!JSON.stringify(sink.events).includes('alice@example.com'));
  });

  it('a failing sink never throws into the voice flow', () => {
    const broken = new VoicePresenceReporter({ publish: () => { throw new Error('disk full'); } }, voiceStore, { log: () => {} });
    assert.doesNotThrow(() => {
      broken.sessionConnected(sessionId);
      broken.speaking(sessionId, 'x');
      broken.executionStarted(sessionId);
      broken.executionFinished(sessionId, true);
      broken.sessionEnded(sessionId);
    });
  });

  describe('observeExecutor', () => {
    it('passes arguments and result through unchanged', async () => {
      const calls: unknown[] = [];
      const inner: ActionExecutor = {
        async executeApprovedAction(actionId, options) {
          calls.push([actionId, options]);
          return { success: true, status: 'SENT', messageId: 'm1' };
        },
      };
      const wrapped = observeExecutor(inner, reporter, sessionId);
      const result = await wrapped.executeApprovedAction('act_1', { actor: 'voice:owner_voice', approvalSource: 'voice' });
      assert.deepEqual(result, { success: true, status: 'SENT', messageId: 'm1' });
      assert.deepEqual(calls, [['act_1', { actor: 'voice:owner_voice', approvalSource: 'voice' }]]);
      assert.deepEqual(sink.states(), ['executing', 'success']);
    });

    it('re-throws executor errors after reporting ERROR', async () => {
      const inner: ActionExecutor = { async executeApprovedAction() { throw new Error('gmail down'); } };
      await assert.rejects(() => observeExecutor(inner, reporter, sessionId).executeApprovedAction('act_1'), /gmail down/);
      assert.deepEqual(sink.states(), ['executing', 'error']);
    });

    it('reports a non-success result (e.g. BLOCKED_MODIFIED) as ERROR', async () => {
      const inner: ActionExecutor = { async executeApprovedAction() { return { success: false, status: 'BLOCKED_MODIFIED', error: 'draft changed' }; } };
      const r = await observeExecutor(inner, reporter, sessionId).executeApprovedAction('act_1');
      assert.equal(r.status, 'BLOCKED_MODIFIED');
      assert.deepEqual(sink.states(), ['executing', 'error']);
    });
  });
});

/* ------------------------------------------------------------------ */

describe('Voice server emits runtime events from the real mailbox flow', () => {
  let dir: string;
  let actionStore: ActionStore;
  let voiceStore: VoiceStore;
  const messages: EligibleInboxMessage[] = [
    { index: 1, messageId: 'msg_001', threadId: 'th_001', from: 'Alice Johnson <alice@example.com>', senderName: 'Alice Johnson', subject: 'Photo Booth for Birthday Party', date: '2026-10-04T12:00:00Z', internalDate: 3, body: 'Hi Hector, I would like to book a photo booth for my birthday on Nov 14th in Irvine.' },
    { index: 2, messageId: 'msg_002', threadId: 'th_002', from: 'Bob Smith <bob@example.com>', senderName: 'Bob Smith', subject: 'Corporate Holiday Gala Inquiry', date: '2026-10-04T11:00:00Z', internalDate: 2, body: 'Hello, we need a photo booth for 200 guests on Dec 10th.' },
    { index: 3, messageId: 'msg_003', threadId: 'th_003', from: 'Carol White <carol@example.com>', senderName: 'Carol White', subject: 'Wedding Photo Booth Availability', date: '2026-10-04T10:00:00Z', internalDate: 1, body: 'Are you available for a Newport Beach wedding on Jan 20th?' },
  ];

  beforeEach(() => {
    dir = tmpDir('phro-runtime-ws-');
    actionStore = new ActionStore({ dataDir: dir, actionsFilePath: path.join(dir, 'actions.json'), eventsFilePath: path.join(dir, 'action-events.jsonl') });
    voiceStore = voiceStoreIn(dir);
    process.env.PHRO_SKIP_TWILIO_SIGNATURE_VALIDATION = 'true';
  });
  afterEach(() => {
    delete process.env.PHRO_SKIP_TWILIO_SIGNATURE_VALIDATION;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function runCall(script: (send: (text: string) => void, token: string, ws: WebSocket) => void | Promise<void>, executor: ActionExecutor) {
    const sink = new CaptureSink();
    const server = createVoiceServer({
      port: 0,
      actionStore,
      voiceStore,
      executor,
      mailboxMessages: messages,
      draftCreator: async (p) => ({ draftId: 'draft_rt_1', messageId: 'msg_rt_1', threadId: p.threadId }),
      endCallBufferMs: 30,
      runtime: sink,
      presenceOptions: { playbackMs: () => 5 },
    });
    await server.start();
    const session = voiceStore.createSession({ actionId: 'mailbox', toPhone: '+15551234567', fromPhone: '+15559876543', conversationState: 'MAILBOX_SELECTING', metadata: { mode: 'mailbox', availableMessages: messages } });
    const ws = new WebSocket(`ws://localhost:${server.getPort()}/voice/ws?sessionId=${session.sessionId}`);
    const send = (text: string) => ws.send(JSON.stringify({ type: 'prompt', voicePrompt: text, last: true }));
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({ type: 'setup', callSid: 'CA_rt', sessionId: session.sessionId })));
      ws.on('message', async (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'text') await script(send, msg.token, ws);
        if (msg.type === 'end') resolve();
      });
      ws.on('close', () => resolve());
      ws.on('error', reject);
    });
    await new Promise((r) => setTimeout(r, 60));
    await server.stop();
    return sink;
  }

  it('greeting -> select -> draft -> approve -> confirm approval -> send maps to real presence states', async () => {
    let sends = 0;
    const executor: ActionExecutor = {
      async executeApprovedAction(actionId) {
        sends++;
        actionStore.transitionAction(actionId, 'SENT', { actor: 'test' });
        return { success: true, status: 'SENT', messageId: 'sent_1' };
      },
    };
    const sink = await runCall(async (send, token, ws) => {
      if (token.includes('I found three recent business emails')) {
        // Interim recognition first: owner is talking.
        ws.send(JSON.stringify({ type: 'prompt', voicePrompt: 'number', last: false }));
        send('number one');
      } else if (token.includes('Selected message 1')) send('draft a response');
      else if (token.includes('I created a draft reply in Gmail')) send('approve');
      else if (token.includes('confirm approval') && !token.includes('Approval confirmed')) {
        await new Promise((r) => setTimeout(r, 40)); // let playback settle into AWAITING_APPROVAL
        send('confirm approval');
      }
    }, executor);

    const states = sink.states();
    assert.equal(sends, 1, 'exactly one send');
    // Ordered subsequence of the expected live journey.
    const expected = ['idle', 'speaking', 'listening', 'thinking', 'speaking', 'thinking', 'speaking', 'thinking', 'speaking', 'awaiting_approval', 'thinking', 'executing', 'success', 'idle'];
    let i = 0;
    for (const s of states) if (s === expected[i]) i++;
    assert.equal(i, expected.length, `missing transitions; got ${states.join(' > ')}`);

    // "Approve" alone never produced EXECUTING: execution only follows AWAITING_APPROVAL then a new utterance.
    const firstExec = states.indexOf('executing');
    const awaiting = states.indexOf('awaiting_approval');
    assert.ok(awaiting > -1 && firstExec > awaiting);
    // After success, the closing speech does not overwrite the outcome.
    assert.equal(states[states.indexOf('success') + 1], 'idle');
    assert.equal(sink.events.at(-1)?.sessionActive, false);
    // HUD context present and display-safe.
    const withCtx = sink.events.find((e) => e.context);
    assert.deepEqual(withCtx?.context, { senderName: 'Alice Johnson', subject: 'Photo Booth for Birthday Party' });
  });

  it('hanging up while awaiting approval ends in IDLE with no execution', async () => {
    let sends = 0;
    const executor: ActionExecutor = { async executeApprovedAction() { sends++; return { success: true, status: 'SENT' }; } };
    const sink = await runCall(async (send, token, ws) => {
      if (token.includes('I found three recent business emails')) send('number one');
      else if (token.includes('Selected message 1')) send('draft a response');
      else if (token.includes('I created a draft reply in Gmail')) send('approve');
      else if (token.includes('confirm approval')) ws.close();
    }, executor);
    assert.equal(sends, 0);
    assert.ok(!sink.states().includes('executing'));
    assert.equal(sink.states().at(-1), 'idle');
  });
});

/* ------------------------------------------------------------------ */

describe('Command Center runtime endpoints', () => {
  let dir: string;
  let api: ReturnType<typeof createDashboardServer>;
  let base: string;

  beforeEach(async () => {
    dir = tmpDir('phro-runtime-api-');
    api = createDashboardServer({ port: 0, dataDir: dir, baseDir: dir, staticDir: null, voiceHealthUrl: null, env: {} });
    await api.start();
    base = `http://127.0.0.1:${api.getPort()}`;
  });
  afterEach(async () => {
    await api.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('GET /api/runtime/state reports idle before any voice session', async () => {
    const res = await fetch(`${base}/api/runtime/state`);
    const body = (await res.json()) as { data: { state: string; settledBy: string } };
    assert.equal(body.data.state, 'idle');
    assert.equal(body.data.settledBy, 'no_runtime');
  });

  it('GET /api/runtime/state returns the current written state', async () => {
    new PacificOpsRuntimeStore({ dataDir: dir }).publish({ state: 'awaiting_approval', sessionId: 's', sessionActive: true, source: 'voice', operation: 'approval', task: 'Awaiting approval confirmation', status: 'Waiting', context: { senderName: 'Alice', subject: 'Booth' } });
    const body = (await (await fetch(`${base}/api/runtime/state`)).json()) as { data: { state: string; task: string; context: unknown } };
    assert.equal(body.data.state, 'awaiting_approval');
    assert.equal(body.data.task, 'Awaiting approval confirmation');
    assert.deepEqual(body.data.context, { senderName: 'Alice', subject: 'Booth' });
  });

  it('GET /api/runtime/events streams the current state first, then live changes', async () => {
    const store = new PacificOpsRuntimeStore({ dataDir: dir });
    store.publish({ state: 'speaking', sessionId: 's', sessionActive: true, source: 'voice', operation: 'call', task: null, status: 'Speaking', context: null });
    const controller = new AbortController();
    const res = await fetch(`${base}/api/runtime/events`, { signal: controller.signal });
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const seen: string[] = [];
    const deadline = Date.now() + 4000;
    let published = false;
    while (Date.now() < deadline && !seen.includes('executing')) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: boolean }>((r) => setTimeout(() => r({ value: undefined, done: false }), 300)),
      ]);
      if (done) break;
      if (value) buf += decoder.decode(value, { stream: true });
      for (const m of buf.matchAll(/event: runtime\ndata: (.+)\n/g)) {
        const st = (JSON.parse(m[1]) as { state: string }).state;
        if (seen.at(-1) !== st) seen.push(st);
      }
      buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
      if (!published && seen[0] === 'speaking') {
        published = true;
        store.publish({ state: 'executing', sessionId: 's', sessionActive: true, source: 'executor', operation: 'send_email', task: 'Sending email', status: 'Sending', context: null });
      }
    }
    controller.abort();
    assert.deepEqual(seen.slice(0, 2), ['speaking', 'executing']);
  });

  it('the runtime API is read-only', async () => {
    const res = await fetch(`${base}/api/runtime/state`, { method: 'POST' });
    assert.equal(res.status, 405);
  });
});
