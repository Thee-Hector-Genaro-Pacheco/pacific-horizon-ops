import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ActionStore } from '../src/actions/store.js';
import { VoiceStore } from '../src/voice/store.js';
import { loadSnapshot } from '../src/dashboard/sources.js';
import { buildReadModel, sanitizeText, parseSender, ownerMatcher } from '../src/dashboard/readModel.js';
import { createDashboardServer } from '../src/dashboard/server.js';
import { FileTraceRecorder } from '../src/agent/trace.js';

const OWNER_PHONE = '+15555550123';
const BUSINESS_PHONE = '+15555550999';

function seed(dataDir: string) {
  const actions = new ActionStore({ dataDir });
  const voice = new VoiceStore({ dataDir });

  const pending = actions.createDraftAction({
    messageId: 'gmail_msg_pending_1',
    threadId: 'gmail_thread_pending_1',
    draftId: 'r-draft-secret-1',
    subject: 'Wedding Photo Booth Inquiry',
    from: 'Sarah Martinez <sarah@example.com>',
    classificationCategory: 'booking_inquiry',
    confidence: 0.94,
    draftReply: 'Hi Sarah, thank you for reaching out! Call us at +15555550188.',
  }).action;

  const sent = actions.createDraftAction({
    messageId: 'gmail_msg_sent_1',
    threadId: 'gmail_thread_sent_1',
    draftId: 'r-draft-secret-2',
    subject: 'Pricing Question',
    from: 'Monica Reyes <monica@example.com>',
    classificationCategory: 'booking_inquiry',
    confidence: 0.9,
    draftReply: 'Hi Monica, here is our pricing.',
  }).action;
  const session = voice.createSession({
    actionId: sent.actionId,
    toPhone: OWNER_PHONE,
    fromPhone: BUSINESS_PHONE,
  });
  voice.updateSessionStatus(session.sessionId, 'CALL_REQUESTED', { callSid: 'CA0123456789abcdef0123456789abcdef' });
  voice.updateSessionStatus(session.sessionId, 'ACTIVE');
  voice.appendTranscript(session.sessionId, { role: 'agent', text: `Calling ${OWNER_PHONE} now`, timestamp: new Date().toISOString() });
  voice.appendTranscript(session.sessionId, { role: 'user', text: 'approve', timestamp: new Date().toISOString() });
  actions.approveAction(sent.actionId, {
    decision: 'approved',
    approvedBy: 'owner_voice',
    approvedAt: new Date().toISOString(),
    approvalSource: 'voice',
  });
  actions.transitionAction(sent.actionId, 'EXECUTING', { actor: 'voice:owner_voice', metadata: { draftId: 'r-draft-secret-2' } });
  actions.transitionAction(sent.actionId, 'SENT', {
    actor: 'voice:owner_voice',
    reason: 'Draft sent successfully via Gmail API',
    metadata: { messageId: 'gmail_sent_reply_1' },
  });

  voice.updateSessionStatus(session.sessionId, 'COMPLETED');

  fs.appendFileSync(
    path.join(dataDir, 'runs.jsonl'),
    [
      {
        timestamp: '2026-09-29T03:36:01.310Z',
        mode: 'live',
        messageId: 'gmail_msg_noise_1',
        from: 'Google <notify-noreply@google.com>',
        subject: 'Welcome',
        classification: { category: 'system_notification', requiresResponse: false, summary: 'Welcome note', confidence: 0.98 },
        decision: 'skipped (does not require response)',
      },
      {
        timestamp: '2026-09-29T03:40:00.000Z',
        mode: 'live',
        messageId: 'gmail_msg_owner_1',
        from: 'Owner <owner@pacific.test>',
        subject: 'Internal test',
        classification: { category: 'other', requiresResponse: false, confidence: 0.9 },
        decision: 'skipped (does not require response)',
      },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n'
  );

  return { pending, sent, session };
}

describe('Command Center read model', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phro-dashboard-test-'));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('never exposes Gmail IDs, draft IDs, call SIDs or raw phone numbers', () => {
    seed(dataDir);
    const model = buildReadModel(loadSnapshot(dataDir));
    const serialized = JSON.stringify(model);

    for (const secret of [
      'gmail_msg_pending_1',
      'gmail_thread_pending_1',
      'r-draft-secret-1',
      'r-draft-secret-2',
      'gmail_sent_reply_1',
      'CA0123456789abcdef0123456789abcdef',
      OWNER_PHONE,
      BUSINESS_PHONE,
      '+15555550188',
    ]) {
      assert.equal(serialized.includes(secret), false, `read model leaked ${secret}`);
    }
  });

  it('maps action state into inbox status, approvals and counts', () => {
    const { pending, sent } = seed(dataDir);
    const model = buildReadModel(loadSnapshot(dataDir));

    const pendingItem = model.inbox.find((i) => i.actionId === pending.actionId);
    assert.equal(pendingItem?.status, 'AWAITING_APPROVAL');
    assert.equal(pendingItem?.approvalRequired, true);
    assert.equal(pendingItem?.hasDraft, true);

    const sentItem = model.inbox.find((i) => i.actionId === sent.actionId);
    assert.equal(sentItem?.status, 'SENT');
    assert.equal(sentItem?.responded, true);

    const noise = model.inbox.find((i) => i.subject === 'Welcome');
    assert.equal(noise?.status, 'SKIPPED');

    assert.equal(model.commandCenter.counts.pendingApprovals, 1);
    assert.equal(model.commandCenter.counts.sent, 1);

    const sentAction = model.actions.find((a) => a.id === sent.actionId);
    assert.ok(sentAction?.sentAt);
    assert.equal(sentAction?.approval?.source, 'voice');
    assert.deepEqual(
      sentAction?.timeline.map((t) => t.kind),
      ['email_received', 'email_classified', 'draft_generated', 'approval_requested', 'approval_confirmed', 'execution_started', 'email_sent']
    );
  });

  it('links voice calls to the approval they produced', () => {
    const { sent, session } = seed(dataDir);
    const model = buildReadModel(loadSnapshot(dataDir));
    const call = model.calls.find((c) => c.id === session.sessionId);

    assert.equal(call?.relay, 'connected');
    assert.equal(call?.approvalResult, 'approved');
    assert.equal(call?.outcome, 'Approved · email sent');
    assert.equal(call?.action?.id, sent.actionId);
    assert.match(call?.contact.phoneMasked ?? '', /^\+1\*+0123$/);
    assert.ok(call?.transcript[0].text.includes('0123'));
    assert.equal(call?.transcript[0].text.includes(OWNER_PHONE), false);
  });

  it('does not attribute later approvals to calls that never connected', () => {
    const { sent } = seed(dataDir);
    const voice = new VoiceStore({ dataDir });
    // An earlier, abandoned session for the same action that never progressed.
    const sessions = JSON.parse(fs.readFileSync(path.join(dataDir, 'voice-sessions.json'), 'utf-8'));
    const stale = voice.createSession({ actionId: sent.actionId, toPhone: OWNER_PHONE, fromPhone: BUSINESS_PHONE });
    const all = JSON.parse(fs.readFileSync(path.join(dataDir, 'voice-sessions.json'), 'utf-8'));
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    for (const s of all) if (s.sessionId === stale.sessionId) Object.assign(s, { createdAt: old, updatedAt: old, status: 'CALL_REQUESTED' });
    fs.writeFileSync(path.join(dataDir, 'voice-sessions.json'), JSON.stringify(all));
    assert.equal(all.length, sessions.length + 1);

    const model = buildReadModel(loadSnapshot(dataDir));
    const staleCall = model.calls.find((c) => c.id === stale.sessionId);
    assert.equal(staleCall?.approvalResult, null);
    assert.equal(staleCall?.outcome, 'Never connected');
    assert.equal(model.calls.filter((c) => c.approvalResult === 'approved').length, 1);
  });

  it('derives leads from booking inquiries and excludes automated and owner mail', () => {
    seed(dataDir);
    const model = buildReadModel(loadSnapshot(dataDir), { ownerEmails: ['owner@pacific.test'] });
    const names = model.leads.map((l) => l.name).sort();

    assert.deepEqual(names, ['Monica Reyes', 'Sarah Martinez']);
    assert.equal(model.leads.find((l) => l.name === 'Monica Reyes')?.stage, 'CONTACTED');
    assert.equal(model.leads.find((l) => l.name === 'Sarah Martinez')?.stage, 'QUALIFIED');
    assert.equal(model.leads.every((l) => l.derived), true);
    assert.equal(model.customers.some((c) => c.email === 'owner@pacific.test'), false);
    assert.equal(model.inbox.find((i) => i.subject === 'Internal test')?.fromOwner, true);
  });

  it('reports awaiting_approval presence when approvals are pending and nothing is live', () => {
    seed(dataDir);
    const later = Date.now() + 60 * 60 * 1000;
    const model = buildReadModel(loadSnapshot(dataDir), { now: later });
    assert.equal(model.commandCenter.presence.state, 'awaiting_approval');
    assert.equal(model.commandCenter.presence.headline, '1 approval required');
  });

  it('reports success presence right after a send', () => {
    seed(dataDir);
    const model = buildReadModel(loadSnapshot(dataDir));
    assert.equal(model.commandCenter.presence.state, 'success');
  });

  it('tolerates missing and malformed data files', () => {
    fs.writeFileSync(path.join(dataDir, 'action-events.jsonl'), '{"broken": \n{"also":"invalid"}\n');
    const model = buildReadModel(loadSnapshot(dataDir));
    assert.equal(model.inbox.length, 0);
    assert.equal(model.commandCenter.presence.state, 'idle');
  });
});

describe('Command Center text helpers', () => {
  it('strips internal identifiers from audit reasons', () => {
    assert.equal(sanitizeText('Draft created in Gmail (draftId: r-8606289203336126011)'), 'Draft created in Gmail');
    assert.equal(sanitizeText('Call CA763abff732bd584647159bf2d2aa4146 ended'), 'Call [call] ended');
    assert.equal(sanitizeText('Calling +19492810572'), 'Calling +1******0572');
  });

  it('parses sender headers', () => {
    assert.deepEqual(parseSender('"Sarah M" <Sarah@Example.com>'), { name: 'Sarah M', email: 'sarah@example.com' });
    assert.deepEqual(parseSender('client@example.com'), { name: 'client', email: 'client@example.com' });
  });

  it('matches owner addresses and private owner domains only', () => {
    const isOwner = ownerMatcher(['hector@pacific.test', 'me@gmail.com']);
    assert.equal(isOwner('hector@pacific.test'), true);
    assert.equal(isOwner('ops@pacific.test'), true);
    assert.equal(isOwner('me@gmail.com'), true);
    assert.equal(isOwner('someone@gmail.com'), false);
  });
});

describe('Command Center API server', () => {
  let dataDir: string;
  let api: ReturnType<typeof createDashboardServer>;
  let base: string;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phro-dashboard-api-'));
    seed(dataDir);
    api = createDashboardServer({
      port: 0,
      dataDir,
      baseDir: dataDir,
      staticDir: null,
      voiceHealthUrl: null,
      env: {},
    });
    await api.start();
    base = `http://127.0.0.1:${api.getPort()}`;
  });

  afterEach(async () => {
    await api.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('serves read-only JSON envelopes', async () => {
    const res = await fetch(`${base}/api/command-center`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    const body = (await res.json()) as { source: string; data: { counts: { pendingApprovals: number } } };
    assert.equal(body.source, 'live');
    assert.equal(body.data.counts.pendingApprovals, 1);
  });

  it('serves redacted agent traces read-only, without session or request IDs', async () => {
    const empty = (await (await fetch(`${base}/api/agent/traces`)).json()) as { data: unknown[] };
    assert.deepEqual(empty.data, []);
    const recorder = new FileTraceRecorder(dataDir);
    recorder.record({
      traceId: 'trace_1', requestId: 'req_secret_1', sessionId: 'sess_secret_1', organizationId: 'pacific-horizon-labs', channel: 'voice',
      at: new Date().toISOString(), inputPreview: 'mail owner@example.com key sk-ant-api03-abcdefghijk',
      intent: { intent: 'knowledge.query', domain: 'knowledge', source: 'deterministic', highRisk: false, confidence: 1 },
      plan: { providers: ['knowledge'], completeness: 'best_effort' }, providersInvoked: ['knowledge'], toolsConsidered: ['knowledge.search'],
      policy: [{ toolId: 'knowledge.search', decision: 'allow', reason: 'read_only', trigger: 'deterministic_command' }],
      approvalRequired: false, toolOutcome: { toolId: 'knowledge.search', ok: true, outcome: 'answered:1' }, notices: [], latencyMs: 5, status: 'answered', dryRun: false,
    });
    const res = await fetch(`${base}/api/agent/traces?limit=5`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.doesNotMatch(text, /sess_secret_1|req_secret_1|owner@example\.com|sk-ant-api03/);
    const body = JSON.parse(text) as { data: Array<{ intent: { intent: string } }> };
    assert.equal(body.data[0].intent.intent, 'knowledge.query');
    assert.equal((await fetch(`${base}/api/agent/traces`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/api/agent/run`)).status, 404);
  });

  it('rejects every non-GET method so approvals cannot be bypassed', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(`${base}/api/actions`, { method });
      assert.equal(res.status, 405, `${method} should be rejected`);
    }
  });

  it('reports unconfigured integrations as offline without leaking env values', async () => {
    const res = await fetch(`${base}/api/health`);
    const body = (await res.json()) as { data: { components: Array<{ key: string; status: string }> } };
    const byKey = Object.fromEntries(body.data.components.map((c) => [c.key, c.status]));
    assert.equal(byKey.twilio, 'offline');
    assert.equal(byKey.voice, 'offline');
    assert.equal(byKey.gmail, 'offline');
  });

  it('pushes a change event over SSE when the action store changes', async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/api/stream`, { signal: controller.signal });
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const read = async (until: string) => {
      const deadline = Date.now() + 4000;
      while (!buffer.includes(until) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value);
      }
      return buffer.includes(until);
    };
    assert.equal(await read('event: ready'), true);

    new ActionStore({ dataDir }).createDraftAction({
      messageId: 'gmail_msg_live_2',
      threadId: 'gmail_thread_live_2',
      draftId: 'r-draft-live-2',
      subject: 'Live update',
      from: 'Live <live@example.com>',
      classificationCategory: 'booking_inquiry',
      confidence: 0.9,
      draftReply: 'Hi',
    });

    assert.equal(await read('event: change'), true);
    assert.match(buffer, /"topics":\[[^\]]*"actions"/);
    controller.abort();
  });

  it('returns 404 for unknown records', async () => {
    const res = await fetch(`${base}/api/actions/act_does_not_exist`);
    assert.equal(res.status, 404);
  });
});
