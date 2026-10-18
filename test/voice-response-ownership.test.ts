import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { ActionStore } from '../src/actions/store.js';
import type { ActionExecutor } from '../src/actions/executor.js';
import { AgentHarness } from '../src/agent/harness.js';
import { emptySessionContext } from '../src/agent/session.js';
import { MemoryTraceRecorder, readTraces, type AgentTrace } from '../src/agent/trace.js';
import { createAgentRequest, type IntentResult } from '../src/agent/types.js';
import { acceptBoundResult } from '../src/agent/voiceAdapter.js';
import { CalendarService, type CalendarTransport } from '../src/calendar/service.js';
import type { CalendarSource } from '../src/calendar/multi.js';
import type { GmailReadTransport, InboxSource } from '../src/google/gmailRead.js';
import { INSUFFICIENT_KNOWLEDGE, type GroundedAnswer } from '../src/knowledge/grounding.js';
import { handleVoiceUtterance } from '../src/voice/conversation.js';
import type { EligibleInboxMessage } from '../src/voice/mailbox.js';
import { createVoiceServer } from '../src/voice/server.js';
import { VoiceStore } from '../src/voice/store.js';
import { EVENT_A, captureConsole, fakeAnthropic, makeClient, mockFetch, textMessage, toolMessage } from './helpers/photoBoothFakes.js';

const TZ = 'America/Los_Angeles';
const NOW = new Date('2026-10-14T19:00:00Z');
const ORG = 'pacific-horizon-labs';
const SPONSORED = 'Sponsored and promotional events never charge the guest.';
const KNOWLEDGE_ANSWER = "According to stored company knowledge, sponsored and promotional events never charge the guest. That's from Photo Booth Operating Policy.";
const MAILBOX_LIST = /I found (?:two|three) recent business emails/;

const ev = (id: string, summary: string, start: string, end: string) => ({ id, summary, start: { dateTime: start }, end: { dateTime: end } });

function calSource(events: unknown[]) {
  const transport: CalendarTransport = {
    async listEvents(p) {
      return {
        items: events.filter((e) => {
          const x = e as { start: { dateTime: string }; end: { dateTime: string } };
          return Date.parse(x.end.dateTime) > Date.parse(p.timeMin) && Date.parse(x.start.dateTime) < Date.parse(p.timeMax);
        }),
      };
    },
    async getEvent() {
      return null;
    },
    async freeBusy() {
      return { calendars: {} };
    },
  };
  const calendarId = 'business-cal@group.calendar.google.com';
  const svc = new CalendarService(transport, { calendarId, timeZone: TZ, timeoutMs: 1000 });
  const s: CalendarSource = { sourceId: 'business.0', profileId: 'business', label: 'Business', calendarId, calendarLabel: 'Primary', privacy: 'titles', getService: async () => svc };
  return s;
}

function inboxSource(profileId: string, label: string, msgs: Array<{ id: string; from: string; subject: string; at: number }>, delayMs = 0) {
  const transport: GmailReadTransport = {
    async listMessageIds() {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return { messages: msgs.map((m) => ({ id: m.id })) };
    },
    async getMessageMetadata(id) {
      const m = msgs.find((x) => x.id === id)!;
      return { id, threadId: id, internalDate: String(m.at), snippet: `Snippet of ${m.subject}`, labelIds: ['INBOX'], payload: { headers: [{ name: 'From', value: m.from }, { name: 'Subject', value: m.subject }] } };
    },
  };
  const s: InboxSource = { profileId, label, getTransport: async () => transport };
  return s;
}

function grounded(question: string): GroundedAnswer {
  const ctx = { question, organizationId: ORG, evidence: [], liveContext: [], constraints: [], notices: [] };
  if (/sponsored event/i.test(question)) {
    return {
      status: 'answered',
      answer: SPONSORED,
      citations: [{ id: 'E1', title: 'Photo Booth Operating Policy', sourceLabel: 'Seed', section: 'Sponsored and promotional events', excerpt: SPONSORED, provenance: { chunkId: 'c', documentId: 'd', sourceId: 's', docKey: null, ordinal: 0, score: 1, lexicalScore: 1, vectorScore: 1 } }],
      context: ctx,
      sufficiency: 'supported',
    };
  }
  return { status: 'insufficient_evidence', answer: INSUFFICIENT_KNOWLEDGE, citations: [], context: ctx, sufficiency: 'answerer_insufficient' } as GroundedAnswer;
}

const messages: EligibleInboxMessage[] = [
  { index: 1, messageId: 'm1', threadId: 't1', from: 'Google <no-reply@accounts.example.com>', senderName: 'Google', subject: 'Security alert', date: '2026-10-09T12:00:00Z', internalDate: 3, body: 'New sign-in.' },
  { index: 2, messageId: 'm2', threadId: 't2', from: 'Bob <bob@example.com>', senderName: 'Bob', subject: 'Invoice', date: '2026-10-09T11:00:00Z', internalDate: 2, body: 'Invoice attached.' },
];

const personalInbox = () =>
  inboxSource('personal', 'Personal', [
    { id: 'p1', from: 'Mom <mom@example.com>', subject: 'Dinner Sunday', at: 5 },
    { id: 'p2', from: 'School <office@example.edu>', subject: 'Field trip form', at: 4 },
  ]);

/* ------------------------------------------------------------------ */

describe('Response ownership: each turn speaks only its own domain', () => {
  let dir: string;
  let voiceStore: VoiceStore;
  let actionStore: ActionStore;
  let sessionId: string;
  let sends: number;
  let consoleCapture: ReturnType<typeof captureConsole>;
  const executor: ActionExecutor = {
    async executeApprovedAction() {
      sends++;
      return { success: true, status: 'SENT' };
    },
  };
  const booth = mockFetch();

  const say = (utterance: string, ai = fakeAnthropic([])) =>
    handleVoiceUtterance({
      session: voiceStore.getSession(sessionId)!,
      utterance,
      voiceStore,
      actionStore,
      executor,
      calendar: { sources: [calSource([ev('b1', 'Client meeting', '2026-10-14T18:00:00-07:00', '2026-10-14T20:00:00-07:00'), ev('b2', 'Overlap', '2026-10-14T19:00:00-07:00', '2026-10-14T21:00:00-07:00')])], timeZone: TZ, now: () => NOW },
      email: { sources: [personalInbox()] },
      knowledge: { answer: async (q) => grounded(q), rewrite: null },
      photoBooth: { analytics: makeClient(booth.fetchImpl), anthropic: ai.client, model: 'test-model' },
    });
  const lastTrace = (): AgentTrace => readTraces(dir, 1)[0];
  const assertOwned = (domain: string) => {
    const t = lastTrace();
    assert.equal(t.resolvedDomain, domain);
    assert.equal(t.responseDomain, domain);
  };
  const assertKnowledgeOnly = (text: string) => {
    assert.equal(text, KNOWLEDGE_ANSWER);
    assert.doesNotMatch(text, /email|inbox|Dinner|Field trip|Security alert|calendar|conflict|session/i);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phro-ownership-'));
    voiceStore = new VoiceStore({ dataDir: dir, sessionsFilePath: path.join(dir, 's.json'), eventsFilePath: path.join(dir, 'e.jsonl') });
    actionStore = new ActionStore({ dataDir: dir, actionsFilePath: path.join(dir, 'a.json'), eventsFilePath: path.join(dir, 'ae.jsonl') });
    sends = 0;
    sessionId = voiceStore.createSession({ actionId: 'mailbox', toPhone: '+15550000001', fromPhone: '+15550000002', conversationState: 'MAILBOX_SELECTING', metadata: { mode: 'mailbox', availableMessages: messages } }).sessionId;
    consoleCapture = captureConsole();
  });
  afterEach(() => {
    consoleCapture.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('1 + 5 + 11. Gmail then Knowledge: the second turn speaks only the grounded policy', async () => {
    const inbox = await say('Check my personal inbox.');
    assert.match(inbox.responseText, /Dinner Sunday/);
    assertOwned('gmail');
    const k = await say('What is our sponsored event policy?');
    assertKnowledgeOnly(k.responseText);
    assert.notEqual(k.responseText, inbox.responseText, 'the previous Gmail response is never replayed');
    assertOwned('knowledge');
  });

  it('2. Knowledge then Gmail: each turn speaks its own result', async () => {
    assertKnowledgeOnly((await say('What is our sponsored event policy?')).responseText);
    assertOwned('knowledge');
    const inbox = await say('Check my personal inbox.');
    assert.match(inbox.responseText, /Dinner Sunday/);
    assert.doesNotMatch(inbox.responseText, /sponsored|stored company knowledge/i);
    assertOwned('gmail');
  });

  it('3. Calendar then Knowledge', async () => {
    assert.match((await say('Do I have any conflicts today?')).responseText, /conflict/);
    assertOwned('calendar');
    assertKnowledgeOnly((await say('What is our sponsored event policy?')).responseText);
    assertOwned('knowledge');
  });

  it('4. Photo Booth then Knowledge', async () => {
    const ai = fakeAnthropic([toolMessage('t1', 'get_latest_photo_booth_event', {}), toolMessage('t2', 'get_photo_booth_event_summary', { eventId: EVENT_A }), textMessage('The latest event had 97 sessions.')]);
    assert.equal((await say('How did the latest photo booth event perform?', ai)).responseText, 'The latest event had 97 sessions.');
    assertOwned('photo_booth');
    assertKnowledgeOnly((await say('What is our sponsored event policy?')).responseText);
    assertOwned('knowledge');
  });

  it("10. the current result picks the renderer, not the session's previous domain or stored context", async () => {
    await say('Check my personal inbox.');
    // Stale state from the inbox turn is still in the session; the knowledge turn must ignore it.
    assert.equal(voiceStore.getSession(sessionId)!.conversationState, 'EMAIL_READ');
    assert.ok(voiceStore.getSession(sessionId)!.metadata?.inboxRead);
    assertKnowledgeOnly((await say('Sponsored event policies.')).responseText);
    assertOwned('knowledge');
  });

  it('12-13. unknown runs no tool; safe follow-ups still resolve', async () => {
    await say('Do I have any conflicts today?');
    await say('Thank you.');
    const t = lastTrace();
    assert.deepEqual([t.toolsConsidered, t.toolOutcome, t.responseDomain], [[], null, 'session']);
    await say('What about tomorrow?');
    assertOwned('calendar');
    assert.equal(lastTrace().followUp?.inheritedIntent, 'calendar.schedule');
  });

  it('14-15. no mutation from any of these turns', async () => {
    for (const q of ['Check my personal inbox.', 'What is our sponsored event policy?', 'Do I have any conflicts today?', 'Send that email.', 'yes']) await say(q);
    assert.equal(sends, 0);
    assert.equal(actionStore.listActions().length, 0);
  });
});

describe('Request binding (unit)', () => {
  const expected = { requestId: 'req_current', sessionId: 'vses_1', domain: 'knowledge' };

  it('8-9. rejects a result from another request, another session, or another domain', () => {
    assert.equal(acceptBoundResult({ requestId: 'req_current', sessionId: 'vses_1', domain: 'knowledge' }, expected), true);
    assert.equal(acceptBoundResult({ requestId: 'req_previous', sessionId: 'vses_1', domain: 'knowledge' }, expected), false);
    assert.equal(acceptBoundResult({ requestId: 'req_current', sessionId: 'vses_2', domain: 'knowledge' }, expected), false);
    assert.equal(acceptBoundResult({ requestId: 'req_current', sessionId: 'vses_1', domain: 'gmail' }, expected), false);
    assert.equal(acceptBoundResult({ requestId: 'req_current', sessionId: 'vses_1', domain: null }, expected), false);
  });

  it('9. the harness refuses to run a tool for a request resolved to another domain, and traces the mismatch', async () => {
    let reads = 0;
    const recorder = new MemoryTraceRecorder();
    const harness = new AgentHarness({ recorder, deps: { email: { sources: [] }, knowledge: { answer: async (q) => (reads++, grounded(q)) } } });
    const intent: IntentResult = { domain: 'knowledge', intent: 'knowledge.query', confidence: 1, source: 'deterministic', highRisk: false, entities: {}, requestedScope: null };
    const req = createAgentRequest({ sessionId: 's1', organizationId: ORG, channel: 'voice', actor: { kind: 'owner', id: 'owner' }, input: 'What is our sponsored event policy?' });
    const out = await harness.runTool('gmail.read', req, emptySessionContext('s1', ORG, 'voice'), { question: req.input }, 'deterministic_command', { intent });
    assert.equal(out.result.status, 'denied');
    assert.equal(out.raw, null);
    assert.equal(out.binding.domain, null);
    const [t] = recorder.recent();
    assert.deepEqual([t.resolvedDomain, t.responseDomain, t.policy[0].reason], ['knowledge', null, 'domain_mismatch:knowledge->gmail']);
    assert.equal(reads, 0);

    const ok = await harness.runTool('knowledge.search', req, emptySessionContext('s1', ORG, 'voice'), { question: req.input }, 'deterministic_command', { intent });
    assert.deepEqual(ok.binding, { requestId: req.requestId, sessionId: 's1', domain: 'knowledge' });
    assert.equal(recorder.recent()[0].responseDomain, 'knowledge');
  });
});

describe('ConversationRelay: late and out-of-order responses', () => {
  let dir: string;
  let voiceStore: VoiceStore;
  let actionStore: ActionStore;
  let consoleCapture: ReturnType<typeof captureConsole>;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phro-ownership-ws-'));
    voiceStore = new VoiceStore({ dataDir: dir });
    actionStore = new ActionStore({ dataDir: dir });
    consoleCapture = captureConsole();
    process.env.PHRO_SKIP_TWILIO_SIGNATURE_VALIDATION = 'true';
  });
  afterEach(() => {
    delete process.env.PHRO_SKIP_TWILIO_SIGNATURE_VALIDATION;
    consoleCapture.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Opens a call; `script` gets a prompt sender and the list of spoken texts so far. */
  async function call(
    options: Partial<Parameters<typeof createVoiceServer>[0]>,
    script: (prompt: (t: string) => void, spoken: string[]) => Promise<void>
  ): Promise<{ spoken: string[]; sessionId: string }> {
    const server = createVoiceServer({ port: 0, actionStore, voiceStore, endCallBufferMs: 30, ...options });
    await server.start();
    // Inbound shape: no preloaded messages, so setup must load the inbox.
    const session = voiceStore.createSession({ actionId: 'mailbox', toPhone: '+15551234567', fromPhone: '+15559876543', conversationState: 'MAILBOX_SELECTING', metadata: { mode: 'mailbox' } });
    const ws = new WebSocket(`ws://localhost:${server.getPort()}/voice/ws?sessionId=${session.sessionId}`);
    const spoken: string[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'text') spoken.push(msg.token);
        });
        ws.on('error', reject);
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'setup', callSid: 'CA_own', sessionId: session.sessionId }));
          script((t) => ws.send(JSON.stringify({ type: 'prompt', voicePrompt: t, last: true })), spoken).then(resolve, reject);
        });
      });
    } finally {
      ws.close();
      await server.stop();
    }
    return { spoken, sessionId: session.sessionId };
  }
  const until = async (cond: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    assert.ok(cond(), 'condition not reached in time');
  };

  it('6. the live bug: a late inbox load cannot speak the mailbox list or take over after the owner moved to Knowledge', async () => {
    let releaseInbox!: () => void;
    const inboxLoaded = new Promise<void>((r) => (releaseInbox = r));
    let sessionId = '';
    const { spoken } = await call(
      {
        loadMailboxMessages: async () => {
          await inboxLoaded;
          return messages;
        },
        calendar: { sources: [calSource([])], timeZone: TZ, now: () => NOW },
        knowledge: { answer: async (q) => grounded(q), rewrite: null },
      },
      async (prompt, said) => {
        sessionId = voiceStore.listSessions().at(-1)!.sessionId;
        prompt('Do I have any conflicts today?');
        await until(() => said.some((t) => /conflicts? today/i.test(t) && !/^One moment/.test(t)));
        prompt('Sponsored event policies.');
        await until(() => said.includes(KNOWLEDGE_ANSWER));
        releaseInbox(); // the slow Gmail load finishes only now
        await new Promise((r) => setTimeout(r, 150));
      }
    );
    assert.equal(spoken.filter((t) => MAILBOX_LIST.test(t)).length, 0, 'the late mailbox list is never spoken');
    assert.equal(spoken.at(-1), KNOWLEDGE_ANSWER);
    const s = voiceStore.getSession(sessionId)!;
    assert.equal(s.conversationState, 'KNOWLEDGE', 'the late greeting did not reset the conversation');
    assert.ok(s.metadata?.knowledge, 'newer context was not overwritten by the connection-time snapshot');
    assert.equal((s.metadata?.availableMessages as unknown[]).length, 2, 'messages are kept for "go back to my inbox"');
  });

  it('6b. when the owner has not spoken yet, the mailbox greeting is delivered as before', async () => {
    const { spoken } = await call({ loadMailboxMessages: async () => messages }, async (_prompt, said) => {
      await until(() => said.some((t) => MAILBOX_LIST.test(t)));
    });
    assert.equal(spoken.filter((t) => MAILBOX_LIST.test(t)).length, 1);
  });

  it('7. a slow Knowledge turn cannot speak after the Gmail turn that followed it', async () => {
    let releaseKnowledge!: () => void;
    const knowledgeGate = new Promise<void>((r) => (releaseKnowledge = r));
    const { spoken } = await call(
      {
        loadMailboxMessages: async () => messages,
        email: { sources: [personalInbox()] },
        knowledge: {
          answer: async (q) => {
            await knowledgeGate;
            return grounded(q);
          },
          rewrite: null,
        },
      },
      async (prompt, said) => {
        await until(() => said.some((t) => MAILBOX_LIST.test(t)));
        prompt('What is our sponsored event policy?');
        await until(() => said.includes('One moment, checking company knowledge.'));
        prompt('Check my personal inbox.'); // arrives while knowledge is still running
        await new Promise((r) => setTimeout(r, 100));
        assert.ok(!said.some((t) => /Dinner Sunday/.test(t)), 'the Gmail turn waits its turn');
        releaseKnowledge();
        await until(() => said.some((t) => /Dinner Sunday/.test(t)));
      }
    );
    const kIdx = spoken.indexOf(KNOWLEDGE_ANSWER);
    const gIdx = spoken.findIndex((t) => /Dinner Sunday/.test(t));
    assert.ok(kIdx > -1 && gIdx > kIdx, `knowledge answer, then inbox: ${JSON.stringify(spoken.map((t) => t.slice(0, 40)))}`);
    assert.ok(/Dinner Sunday/.test(spoken.at(-1)!), 'nothing from the knowledge turn is spoken after the inbox turn');
  });
});
