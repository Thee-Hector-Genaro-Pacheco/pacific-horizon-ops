import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { ActionStore } from "../src/actions/store.js";
import type { ActionExecutor } from "../src/actions/executor.js";
import { GmailApprovalGateway } from "../src/agent/approval.js";
import { ExecutionBoundary } from "../src/agent/boundary.js";
import {
  resolveFollowUp,
  type ReadDomainState,
} from "../src/agent/followUp.js";
import { AgentHarness } from "../src/agent/harness.js";
import { routeIntentDeterministic } from "../src/agent/intents.js";
import { emptySessionContext } from "../src/agent/session.js";
import { createDefaultToolRegistry } from "../src/agent/tools.js";
import {
  MemoryTraceRecorder,
  readTraces,
  type AgentTrace,
} from "../src/agent/trace.js";
import { createAgentRequest } from "../src/agent/types.js";
import {
  CalendarService,
  type CalendarTransport,
} from "../src/calendar/service.js";
import type { CalendarSource } from "../src/calendar/multi.js";
import type {
  GmailReadTransport,
  InboxSource,
} from "../src/google/gmailRead.js";
import {
  INSUFFICIENT_KNOWLEDGE,
  type GroundedAnswer,
} from "../src/knowledge/grounding.js";
import { handleVoiceUtterance } from "../src/voice/conversation.js";
import type { EligibleInboxMessage } from "../src/voice/mailbox.js";
import { createVoiceServer } from "../src/voice/server.js";
import { VoiceStore } from "../src/voice/store.js";
import {
  EVENT_A,
  captureConsole,
  fakeAnthropic,
  makeClient,
  mockFetch,
  textMessage,
  toolMessage,
} from "./helpers/photoBoothFakes.js";

const TZ = "America/Los_Angeles";
/** Wednesday, October 14, 2026, 12:00 PDT. */
const NOW = new Date("2026-10-14T19:00:00Z");
const ORG = "pacific-horizon-labs";
const SPONSORED = "Sponsored and promotional events never charge the guest.";

const ev = (id: string, summary: string, start: string, end: string) => ({
  id,
  summary,
  start: { dateTime: start },
  end: { dateTime: end },
});

function calSource(profileId: string, label: string, events: unknown[]) {
  const calls: string[] = [];
  const transport: CalendarTransport = {
    async listEvents(p) {
      calls.push("listEvents");
      return {
        items: events.filter((e) => {
          const x = e as {
            start: { dateTime: string };
            end: { dateTime: string };
          };
          return (
            Date.parse(x.end.dateTime) > Date.parse(p.timeMin) &&
            Date.parse(x.start.dateTime) < Date.parse(p.timeMax)
          );
        }),
      };
    },
    async getEvent() {
      return null;
    },
    async freeBusy() {
      calls.push("freeBusy");
      return { calendars: {} };
    },
  };
  const calendarId = `${profileId}-cal@group.calendar.google.com`;
  const svc = new CalendarService(transport, {
    calendarId,
    timeZone: TZ,
    timeoutMs: 1000,
  });
  const s: CalendarSource = {
    sourceId: `${profileId}.0`,
    profileId,
    label,
    calendarId,
    calendarLabel: "Primary",
    privacy: "titles",
    getService: async () => svc,
  };
  return { s, calls };
}

function inboxSource(
  profileId: string,
  label: string,
  msgs: Array<{ id: string; from: string; subject: string; at: number }>,
) {
  const calls: string[] = [];
  const transport: GmailReadTransport = {
    async listMessageIds() {
      calls.push("list");
      return { messages: msgs.map((m) => ({ id: m.id })) };
    },
    async getMessageMetadata(id) {
      calls.push("get");
      const m = msgs.find((x) => x.id === id)!;
      return {
        id,
        threadId: id,
        internalDate: String(m.at),
        snippet: `Snippet of ${m.subject}`,
        labelIds: ["INBOX"],
        payload: {
          headers: [
            { name: "From", value: m.from },
            { name: "Subject", value: m.subject },
          ],
        },
      };
    },
  };
  const s: InboxSource = {
    profileId,
    label,
    getTransport: async () => transport,
  };
  return { s, calls };
}

function grounded(question: string): GroundedAnswer {
  const ctx = {
    question,
    organizationId: ORG,
    evidence: [],
    liveContext: [],
    constraints: [],
    notices: [],
  };
  if (/sponsored event|digital delivery/i.test(question)) {
    return {
      status: "answered",
      answer: /digital/i.test(question)
        ? "Guests receive a digital gallery link."
        : SPONSORED,
      citations: [
        {
          id: "E1",
          title: "Photo Booth Operating Policy",
          sourceLabel: "Seed",
          section: "Sponsored and promotional events",
          excerpt: SPONSORED,
          provenance: {
            chunkId: "c",
            documentId: "d",
            sourceId: "s",
            docKey: null,
            ordinal: 0,
            score: 1,
            lexicalScore: 1,
            vectorScore: 1,
          },
        },
      ],
      context: ctx,
      sufficiency: "supported",
    };
  }
  return {
    status: "insufficient_evidence",
    answer: INSUFFICIENT_KNOWLEDGE,
    citations: [],
    context: ctx,
    sufficiency: "answerer_insufficient",
  } as GroundedAnswer;
}

const messages: EligibleInboxMessage[] = [
  {
    index: 1,
    messageId: "m1",
    threadId: "t1",
    from: "Alice Johnson <alice@example.com>",
    senderName: "Alice Johnson",
    subject: "Photo Booth for Birthday Party",
    date: "2026-10-09T12:00:00Z",
    internalDate: 3,
    body: "Hi, I would like to book a photo booth.",
  },
  {
    index: 2,
    messageId: "m2",
    threadId: "t2",
    from: "Bob <bob@example.com>",
    senderName: "Bob",
    subject: "Invoice",
    date: "2026-10-09T11:00:00Z",
    internalDate: 2,
    body: "Invoice attached.",
  },
];

describe("Follow-up resolver (unit)", () => {
  const r = (q: string, d: ReadDomainState) => resolveFollowUp(q, d);

  it("acknowledgements and noise never resolve to a tool", () => {
    for (const d of [
      "CALENDAR",
      "KNOWLEDGE",
      "EMAIL_READ",
      "PHOTO_BOOTH_ANALYTICS",
    ] as const) {
      for (const q of [
        "Thank you.",
        "No.",
        "All good.",
        "Okay.",
        "yes",
        "sure",
        "Thanks!",
      ])
        assert.equal(r(q, d).kind, "acknowledgement", `${d}: ${q}`);
      for (const q of [
        "Panade.",
        "N a I",
        "Order company",
        "procedures.",
        "What is that?",
        "What's the weather like?",
        "do it",
        "okay do it now",
      ]) {
        assert.equal(r(q, d).kind, "clarify", `${d}: ${q}`);
      }
    }
  });

  it("bounded grammar inherits only the matching read intent", () => {
    const read = (q: string, d: ReadDomainState) => {
      const x = r(q, d);
      return x.kind === "read" ? [x.intent, x.toolId] : [x.kind];
    };
    assert.deepEqual(read("What about tomorrow?", "CALENDAR"), [
      "calendar.schedule",
      "calendar.read",
    ]);
    assert.deepEqual(read("And Saturday?", "CALENDAR"), [
      "calendar.schedule",
      "calendar.read",
    ]);
    assert.deepEqual(read("What time is the first one?", "CALENDAR"), [
      "calendar.schedule",
      "calendar.read",
    ]);
    assert.deepEqual(read("Any conflicts?", "CALENDAR"), [
      "calendar.conflicts",
      "calendar.conflicts",
    ]);
    assert.deepEqual(read("What about digital delivery?", "KNOWLEDGE"), [
      "knowledge.query",
      "knowledge.search",
    ]);
    assert.deepEqual(read("What about deposits?", "KNOWLEDGE"), [
      "knowledge.query",
      "knowledge.search",
    ]);
    assert.deepEqual(read("Where does it say that?", "KNOWLEDGE"), [
      "knowledge.query",
      "knowledge.provenance",
    ]);
    assert.deepEqual(read("Read the next one.", "EMAIL_READ"), [
      "gmail.inbox",
      "gmail.read",
    ]);
    assert.deepEqual(read("Who sent that?", "EMAIL_READ"), [
      "gmail.inbox",
      "gmail.read",
    ]);
    assert.deepEqual(read("Summarize it.", "EMAIL_READ"), [
      "gmail.inbox",
      "gmail.read",
    ]);
    assert.deepEqual(read("How many downloads?", "PHOTO_BOOTH_ANALYTICS"), [
      "photobooth.analytics",
      "photobooth.analytics",
    ]);
    // No cross-domain inheritance: a Calendar follow-up shape means nothing in Knowledge.
    assert.deepEqual(read("What about tomorrow?", "EMAIL_READ"), ["clarify"]);
    assert.deepEqual(read("Any conflicts?", "KNOWLEDGE"), ["clarify"]);
  });

  it("13. high-risk commands are never inherited, in any domain", () => {
    const risky = [
      "approve",
      "confirm approval",
      "send it",
      "send that email",
      "reject",
      "execute it",
      "delete that",
      "move it to tomorrow",
      "schedule it for Saturday",
      "add that to my calendar",
      "cancel the meeting",
      "raise the ads budget",
      "buy bitcoin",
      "sell it",
      "pay the invoice",
      "reply to it",
      "draft a reply",
    ];
    for (const d of [
      "CALENDAR",
      "KNOWLEDGE",
      "EMAIL_READ",
      "PHOTO_BOOTH_ANALYTICS",
    ] as const) {
      for (const q of risky)
        assert.notEqual(r(q, d).kind, "read", `${d}: ${q}`);
    }
  });
});

describe("Unknown-intent contract in the harness", () => {
  it("10-12. unknown runs nothing: no tools, no policy, no outcome, no mutation", async () => {
    const recorder = new MemoryTraceRecorder();
    let calls = 0;
    const harness = new AgentHarness({
      recorder,
      deps: {
        knowledge: { answer: async (q) => (calls++, grounded(q)) },
        calendar: { sources: [], timeZone: TZ, now: () => NOW },
      },
    });
    const session = emptySessionContext("s1", ORG, "api");
    for (const q of ["Thank you.", "Panade.", "N a I", "Order company"]) {
      const req = createAgentRequest({
        sessionId: "s1",
        organizationId: ORG,
        channel: "api",
        actor: { kind: "owner", id: "owner" },
        input: q,
      });
      const { result, outcome } = await harness.run(req, {
        ...session,
        domain: "CALENDAR",
      });
      assert.equal(result.status, "unknown", q);
      assert.equal(outcome, null);
      assert.deepEqual(result.toolResults, []);
      assert.deepEqual(result.proposedActions, []);
    }
    assert.equal(calls, 0);
    for (const t of recorder.recent()) {
      assert.deepEqual(
        [
          t.intent.intent,
          t.providersInvoked,
          t.toolsConsidered,
          t.policy,
          t.toolOutcome,
          t.plan,
        ],
        ["unknown", [], [], [], null, null],
      );
    }
  });
});

describe("Read-domain follow-ups by voice", () => {
  let dir: string;
  let voiceStore: VoiceStore;
  let actionStore: ActionStore;
  let sessionId: string;
  let business: ReturnType<typeof calSource>;
  let inbox: ReturnType<typeof inboxSource>;
  let knowledgeAsked: string[];
  let booth: ReturnType<typeof mockFetch>;
  let sends: number;
  let drafts: number;
  let consoleCapture: ReturnType<typeof captureConsole>;

  const executor: ActionExecutor = {
    async executeApprovedAction(actionId) {
      sends++;
      actionStore.transitionAction(actionId, "SENT", { actor: "test" });
      return { success: true, status: "SENT" };
    },
  };

  async function say(utterance: string, ai = fakeAnthropic([])) {
    return handleVoiceUtterance({
      session: voiceStore.getSession(sessionId)!,
      utterance,
      voiceStore,
      actionStore,
      executor,
      draftCreator: async (p) => {
        drafts++;
        return { draftId: `d${drafts}`, threadId: p.threadId };
      },
      calendar: { sources: [business.s], timeZone: TZ, now: () => NOW },
      email: { sources: [inbox.s] },
      knowledge: {
        answer: async (q) => (knowledgeAsked.push(q), grounded(q)),
        rewrite: null,
      },
      photoBooth: {
        analytics: makeClient(booth.fetchImpl),
        anthropic: ai.client,
        model: "test-model",
      },
    });
  }
  const calendarReads = () =>
    business.calls.filter((c) => c === "listEvents" || c === "freeBusy").length;
  const state = () => voiceStore.getSession(sessionId)!.conversationState;
  const lastTrace = (): AgentTrace => readTraces(dir, 1)[0];
  const assertNoTool = (t: AgentTrace, status: string) => {
    assert.equal(t.status, status);
    assert.deepEqual(
      [
        t.intent.intent,
        t.providersInvoked,
        t.toolsConsidered,
        t.policy,
        t.toolOutcome,
      ],
      ["unknown", [], [], [], null],
    );
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "phro-followup-"));
    voiceStore = new VoiceStore({
      dataDir: dir,
      sessionsFilePath: path.join(dir, "s.json"),
      eventsFilePath: path.join(dir, "e.jsonl"),
    });
    actionStore = new ActionStore({
      dataDir: dir,
      actionsFilePath: path.join(dir, "a.json"),
      eventsFilePath: path.join(dir, "ae.jsonl"),
    });
    business = calSource("business", "Business", [
      ev(
        "b1",
        "Client meeting",
        "2026-10-14T18:00:00-07:00",
        "2026-10-14T20:00:00-07:00",
      ),
      ev(
        "b2",
        "Overlap",
        "2026-10-14T19:00:00-07:00",
        "2026-10-14T21:00:00-07:00",
      ),
      ev(
        "b3",
        "Setup",
        "2026-10-15T09:00:00-07:00",
        "2026-10-15T10:00:00-07:00",
      ),
    ]);
    inbox = inboxSource("business", "Business", [
      {
        id: "g1",
        from: "Alice <alice@example.com>",
        subject: "Booth inquiry",
        at: 3,
      },
      { id: "g2", from: "Bob <bob@example.com>", subject: "Invoice", at: 2 },
    ]);
    booth = mockFetch();
    knowledgeAsked = [];
    sends = 0;
    drafts = 0;
    sessionId = voiceStore.createSession({
      actionId: "mailbox",
      toPhone: "+15550000001",
      fromPhone: "+15550000002",
      conversationState: "MAILBOX_SELECTING",
      metadata: { mode: "mailbox", availableMessages: messages },
    }).sessionId;
    consoleCapture = captureConsole();
  });
  afterEach(() => {
    consoleCapture.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('1-2. "Thank you." and "No." after Calendar run no Calendar read', async () => {
    await say("Do I have any conflicts today?");
    assert.equal(state(), "CALENDAR");
    const reads = calendarReads();
    assert.equal(lastTrace().toolOutcome?.toolId, "calendar.conflicts");

    const thanks = await say("Thank you.");
    assert.match(thanks.responseText, /^You're welcome\./);
    assertNoTool(lastTrace(), "acknowledged");
    const no = await say("No.");
    assert.match(no.responseText, /^Okay\./);
    assertNoTool(lastTrace(), "acknowledged");
    assert.equal(
      calendarReads(),
      reads,
      "no Calendar reads for conversational turns",
    );
    assert.equal(state(), "CALENDAR", "the domain is kept for real follow-ups");
  });

  it("4 + 9. the live ASR fragments and unrelated questions run no tool", async () => {
    await say("What do I have today?");
    const reads = calendarReads();
    for (const q of [
      "Panade.",
      "N a I",
      "Order company",
      "procedures.",
      "What's the weather like?",
    ]) {
      const t = await say(q);
      assert.match(t.responseText, /^Sorry, I didn't catch that/, q);
      assertNoTool(lastTrace(), "needs_clarification");
    }
    assert.equal(calendarReads(), reads);
  });

  it("16. the lease question never falls into Calendar: it is a knowledge question, refused by grounding", async () => {
    await say("Do I have any conflicts today?");
    const reads = calendarReads();
    for (const q of [
      "Should AI have signed a lease the company on its own?",
      "Should AI have signed a lease for the company on its own?",
    ]) {
      const t = await say(q);
      assert.equal(t.responseText, INSUFFICIENT_KNOWLEDGE, q);
      const trace = lastTrace();
      assert.equal(trace.intent.intent, "knowledge.query");
      assert.equal(trace.toolOutcome?.toolId, "knowledge.search");
      assert.equal(trace.toolOutcome?.outcome, "insufficient");
      assert.equal(
        trace.normalization?.changed,
        false,
        "the transcript reaches grounding verbatim",
      );
    }
    assert.equal(calendarReads(), reads);
  });

  it("5-6 + 20. real Calendar follow-ups still inherit, with the follow-up recorded", async () => {
    await say("What do I have today?");
    const tomorrow = await say("What about tomorrow?");
    assert.match(tomorrow.responseText, /Setup/);
    assert.deepEqual(lastTrace().followUp, {
      inheritedDomain: "CALENDAR",
      inheritedIntent: "calendar.schedule",
      reason: "day_follow_up",
    });
    assert.equal(lastTrace().toolOutcome?.toolId, "calendar.read");
    await say("What about today?");
    const conflicts = await say("Any conflicts?");
    assert.match(conflicts.responseText, /conflict/i);
    assert.equal(lastTrace().toolOutcome?.toolId, "calendar.conflicts");
    assert.equal(lastTrace().intent.intent, "calendar.conflicts");
  });

  it('3 + 7 + 19. Knowledge: "All good." runs nothing; "What about digital delivery?" is a resolved follow-up', async () => {
    const first = await say("What is our sponsored event policy?");
    assert.match(first.responseText, /never charge the guest/);
    const ok = await say("All good.");
    assert.match(ok.responseText, /^Okay\./);
    assertNoTool(lastTrace(), "acknowledged");
    assert.equal(knowledgeAsked.length, 1);

    await say("What about digital delivery?");
    assert.equal(
      knowledgeAsked[1],
      "What does our company knowledge say about digital delivery?",
    );
    const t = lastTrace();
    assert.deepEqual(t.followUp, {
      inheritedDomain: "KNOWLEDGE",
      inheritedIntent: "knowledge.query",
      reason: "topic_follow_up",
    });
    assert.equal(t.intent.intent, "knowledge.query");

    const where = await say("Where does it say that?");
    assert.match(
      where.responseText,
      /^That came from Photo Booth Operating Policy/,
    );
    assert.equal(
      knowledgeAsked.length,
      2,
      "provenance comes from stored citations, no retrieval",
    );
    assert.deepEqual(lastTrace().toolsConsidered, []);

    const asr = await say("Sponsored United policies?");
    assert.match(
      asr.responseText,
      /never charge the guest/,
      "canonicalization still works",
    );
  });

  it('8. "Read the next one." after an inbox check inherits the inbox read', async () => {
    await say("Check all my inboxes.");
    assert.equal(state(), "EMAIL_READ");
    const before = inbox.calls.length;
    await say("Read the second one.");
    await say("Read the next one.");
    const t = lastTrace();
    assert.equal(t.toolOutcome?.toolId, "gmail.read");
    assert.equal(t.followUp?.inheritedIntent, "gmail.inbox");
    assert.ok(inbox.calls.length >= before);
    const thanks = await say("Thanks.");
    assert.match(thanks.responseText, /^You're welcome\./);
    assertNoTool(lastTrace(), "acknowledged");
  });

  it("23. Photo Booth analytics and its metric follow-ups are unchanged", async () => {
    const ai = fakeAnthropic([
      toolMessage("t1", "get_latest_photo_booth_event", {}),
      toolMessage("t2", "get_photo_booth_event_summary", { eventId: EVENT_A }),
      textMessage("The latest event had 97 sessions."),
      textMessage("There were 40 downloads."),
    ]);
    assert.equal(
      (await say("How did the latest photo booth event perform?", ai))
        .responseText,
      "The latest event had 97 sessions.",
    );
    assert.equal(
      (await say("How many downloads?", ai)).responseText,
      "There were 40 downloads.",
    );
    assert.equal(lastTrace().toolOutcome?.toolId, "photobooth.analytics");
    const requests = booth.requests.length;
    await say("Thank you.", ai);
    assert.equal(
      booth.requests.length,
      requests,
      "no analytics call for thanks",
    );
  });

  it("12-15 + 21. unknown and casual turns cannot mutate; approval stays exact", async () => {
    await say("message one");
    await say("draft a response");
    await say("approve");
    assert.equal(state(), "AWAITING_APPROVAL_CONFIRMATION");
    for (const casual of [
      "yes",
      "okay",
      "do it",
      "sure send it",
      "yeah go ahead",
    ]) {
      await say(casual);
      assert.equal(sends, 0, casual);
    }
    const action = actionStore.listActions()[0];
    assert.equal(
      action.status,
      "AWAITING_APPROVAL",
      "casual speech never approves",
    );

    // 15. A dropped call or timeout leaves it pending: nothing in the harness can treat that as approval.
    const boundary = new ExecutionBoundary(
      createDefaultToolRegistry(),
      new Map([["gmail", new GmailApprovalGateway(actionStore)]]),
    );
    const session = {
      ...emptySessionContext(sessionId, ORG, "voice"),
      boundAction: {
        actionId: action.actionId,
        draftId: action.draftId ?? null,
      },
    };
    const req = createAgentRequest({
      sessionId,
      organizationId: ORG,
      channel: "voice",
      actor: { kind: "owner", id: "owner" },
      input: "send it",
    });
    const out = await boundary.execute({
      toolId: "gmail.sendApprovedDraft",
      args: { actionId: action.actionId },
      request: req,
      session,
      trigger: "deterministic_command",
      deps: { actionStore, executor },
    });
    assert.equal(out.policy.decision, "requires_approval");
    assert.equal(sends, 0);

    // 21. The exact two-step phrase still works.
    await say("confirm approval");
    assert.equal(sends, 1);
    assert.ok(
      ["yes", "okay", "do it"].every(
        (q) => routeIntentDeterministic(q).intent !== "gmail.confirm",
      ),
    );
  });

  it('"Send that email." from a read domain with no bound approval does nothing', async () => {
    await say("Do I have any conflicts today?");
    const t = await say("Send that email.");
    assert.doesNotMatch(t.responseText, /\bsent\b|sending/i);
    assert.equal(sends, 0);
    assert.equal(drafts, 0);
    assert.equal(actionStore.listActions().length, 0);
  });
});

describe("ConversationRelay transcript lifecycle", () => {
  let dir: string;
  let voiceStore: VoiceStore;
  let actionStore: ActionStore;
  let consoleCapture: ReturnType<typeof captureConsole>;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "phro-relay-final-"));
    voiceStore = new VoiceStore({ dataDir: dir });
    actionStore = new ActionStore({ dataDir: dir });
    consoleCapture = captureConsole();
    process.env.PHRO_SKIP_TWILIO_SIGNATURE_VALIDATION = "true";
  });
  afterEach(() => {
    delete process.env.PHRO_SKIP_TWILIO_SIGNATURE_VALIDATION;
    consoleCapture.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("17-18. interim chunks never run; a duplicate final runs once; distinct finals each run", async () => {
    let knowledgeCalls = 0;
    const server = createVoiceServer({
      port: 0,
      actionStore,
      voiceStore,
      mailboxMessages: messages,
      endCallBufferMs: 30,
      knowledge: {
        answer: async (q) => (knowledgeCalls++, grounded(q)),
        rewrite: null,
      },
    });
    await server.start();
    const session = voiceStore.createSession({
      actionId: "mailbox",
      toPhone: "+15551234567",
      fromPhone: "+15559876543",
      conversationState: "MAILBOX_SELECTING",
      metadata: { mode: "mailbox", availableMessages: messages },
    });
    const ws = new WebSocket(
      `ws://localhost:${server.getPort()}/voice/ws?sessionId=${session.sessionId}`,
    );
    const prompt = (voicePrompt: string, last: boolean) =>
      ws.send(JSON.stringify({ type: "prompt", voicePrompt, last }));
    let greeted = false;
    try {
      await new Promise<void>((resolve, reject) => {
        ws.on("open", () =>
          ws.send(
            JSON.stringify({
              type: "setup",
              callSid: "CA_final",
              sessionId: session.sessionId,
            }),
          ),
        );
        ws.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type !== "text" || greeted) return;
          greeted = true;
          prompt("Order", false);
          prompt("Order company", false);
          prompt("Order company procedures.", true);
          prompt("Order company procedures.", true); // same final delivered twice
          setTimeout(() => {
            prompt("Thank you.", true);
            setTimeout(resolve, 250);
          }, 150);
        });
        ws.on("error", reject);
      });
    } finally {
      ws.close();
      await server.stop();
    }
    const userTurns = (
      voiceStore.getSession(session.sessionId)?.transcript ?? []
    )
      .filter((t) => t.role === "user")
      .map((t) => t.text);
    assert.deepEqual(userTurns, ["Order company procedures.", "Thank you."]);
    assert.equal(knowledgeCalls, 1, "the duplicate final did not query twice");
  });
});
