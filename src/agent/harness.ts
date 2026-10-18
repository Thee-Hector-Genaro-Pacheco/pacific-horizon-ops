import { ExecutionBoundary, type ExecutionOutcome } from './boundary.js';
import type { FollowUpTrace } from './followUp.js';
import { canonicalizeReadQuery, KNOWLEDGE_CLARIFY_TEXT, normalizationTrace, type CanonicalQuery, type NormalizationTrace, type QueryRewriter } from './canonicalize.js';
import type { ApprovalGateway } from './approval.js';
import { routeIntent, routeIntentDeterministic, type AmbiguityResolver, type RouterOptions } from './intents.js';
import { LIFECYCLE_TOOLS_FOR_INTENT, READ_TOOL_FOR_INTENT, planContext } from './planner.js';
import { evaluatePolicy, type PolicyOutcome, type Trigger } from './policy.js';
import { createDefaultToolRegistry, type HarnessDeps, type ToolRegistry } from './tools.js';
import { MemoryTraceRecorder, redact, type AgentTrace, type TraceRecorder } from './trace.js';
import {
  AgentRequestSchema,
  AgentResultSchema,
  newTraceId,
  type AgentRequest,
  type AgentResult,
  type AgentStatus,
  type ContextPlan,
  type IntentResult,
  type SessionContext,
} from './types.js';

/**
 * AgentHarness: the central, policy-governed orchestration layer.
 *
 *   AgentRequest -> IntentRouter -> ContextPlanner -> ToolRegistry -> PolicyEngine
 *     -> ApprovalGateway (mutating tools) -> ExecutionBoundary -> TraceRecorder -> AgentResult
 *
 * AI-002 executes read tools only. Mailbox lifecycle intents (draft, approve, confirm,
 * reject) are classified and traced but answered with status "not_handled" so the
 * existing deterministic mailbox flow keeps ownership of drafting and sending.
 */

export interface HarnessOptions {
  registry?: ToolRegistry;
  approvals?: ApprovalGateway[];
  recorder?: TraceRecorder;
  deps?: HarnessDeps;
  router?: RouterOptions & { resolver?: AmbiguityResolver };
  /** Read-only knowledge query rewriter (tool-less). Absent: deterministic canonicalization only. */
  rewriter?: QueryRewriter | null;
}

export interface InspectReport {
  request: Pick<AgentRequest, 'requestId' | 'channel' | 'organizationId'>;
  intent: IntentResult;
  plan: ContextPlan;
  toolsConsidered: string[];
  policy: Array<{ toolId: string; effect: string; risk: string; decision: PolicyOutcome['decision']; reason: string }>;
  executes: boolean;
}

/** Identifies whose answer a result is. Channels must check it before rendering. */
export interface ResultBinding {
  requestId: string;
  sessionId: string;
  /** Domain of the tool that produced the result (e.g. "knowledge"), or null when nothing ran. */
  domain: string | null;
}

interface RunOutput<R> {
  result: AgentResult;
  binding: ResultBinding;
  /** The domain tool's own result (for channel adapters that render it). */
  raw: R | null;
  outcome: ExecutionOutcome<R> | null;
}

function statusFromOutcome(outcome: ExecutionOutcome<unknown>): AgentStatus {
  if (!outcome.ok) return outcome.policy.decision === 'requires_approval' ? 'needs_approval' : outcome.policy.decision === 'deny' ? 'denied' : 'error';
  const o = outcome.summary.outcome;
  if (!outcome.summary.ok) return /unavailable|config|failed|timeout|network|unauthorized|missing_scope|all_failed/.test(o) ? 'unavailable' : 'error';
  if (/^clarify/.test(o)) return 'needs_clarification';
  if (/^insufficient|unknown_(calendar|inbox)|^needs_day/.test(o)) return 'insufficient';
  return 'answered';
}

export class AgentHarness {
  readonly registry: ToolRegistry;
  private readonly boundary: ExecutionBoundary;
  private readonly recorder: TraceRecorder;
  private readonly approvals: Map<string, ApprovalGateway>;

  constructor(private readonly opts: HarnessOptions = {}) {
    this.registry = opts.registry ?? createDefaultToolRegistry();
    this.approvals = new Map((opts.approvals ?? []).map((g) => [g.domain, g]));
    this.boundary = new ExecutionBoundary(this.registry, this.approvals);
    this.recorder = opts.recorder ?? new MemoryTraceRecorder();
  }

  /** Dry run: classify, plan and evaluate policy without executing anything. */
  async inspect(rawRequest: AgentRequest, session: SessionContext): Promise<InspectReport> {
    const started = Date.now();
    const request = AgentRequestSchema.parse(rawRequest);
    const intent = await routeIntent(request.input, this.opts.router);
    const plan = planContext(intent, session);
    const toolsConsidered = [READ_TOOL_FOR_INTENT[intent.intent], ...(LIFECYCLE_TOOLS_FOR_INTENT[intent.intent] ?? [])].filter((t): t is string => !!t);
    const policy: InspectReport['policy'] = [];
    for (const id of toolsConsidered) {
      const tool = this.registry.get(id);
      const approval = tool?.approvalPolicy === 'confirmation_required' ? await this.approvals.get(tool.domain)?.verify(id, { actionId: session.boundAction?.actionId }, session) : undefined;
      const p = evaluatePolicy({ tool, request, session, trigger: 'deterministic_command', approval });
      policy.push({ toolId: id, effect: tool?.effect ?? 'unknown', risk: tool?.risk ?? 'unknown', decision: p.decision, reason: p.reason });
    }
    const executes = !!READ_TOOL_FOR_INTENT[intent.intent];
    this.trace(request, intent, plan, { toolsConsidered, policy: policy.map((p) => ({ ...p, trigger: 'deterministic_command' as Trigger })), status: 'not_handled', started, dryRun: true });
    return { request: { requestId: request.requestId, channel: request.channel, organizationId: request.organizationId }, intent, plan, toolsConsidered, policy, executes };
  }

  /** Full pipeline for one request. Only read intents execute; everything else is classified. */
  async run<R = unknown>(rawRequest: AgentRequest, session: SessionContext, opts: { context?: unknown } = {}): Promise<RunOutput<R>> {
    const request = AgentRequestSchema.parse(rawRequest);
    const intent = await routeIntent(request.input, this.opts.router);
    const toolId = READ_TOOL_FOR_INTENT[intent.intent];
    if (!toolId) {
      const started = Date.now();
      const plan = planContext(intent, session);
      const toolsConsidered = LIFECYCLE_TOOLS_FOR_INTENT[intent.intent] ?? [];
      // Unknown means "no executable intent yet": nothing runs, nothing is inherited.
      const status: AgentStatus = intent.intent === 'unknown' ? 'unknown' : 'not_handled';
      const traceId = this.trace(request, intent, intent.intent === 'unknown' ? null : plan, { toolsConsidered, policy: [], status, started });
      return { result: this.result(request, traceId, status, null), binding: { requestId: request.requestId, sessionId: request.sessionId, domain: null }, raw: null, outcome: null };
    }
    const trigger: Trigger = intent.source === 'model_assisted' ? 'model' : 'deterministic_command';
    if (toolId === 'knowledge.search') return this.runKnowledgeQuery<R>(request, session, { trigger, intent });
    // A model-assisted intent may only read; the trigger records where it came from.
    return this.execute<R>(toolId, request, session, { question: request.input, ...(opts.context ? { context: opts.context } : {}) }, intent.source === 'model_assisted' ? 'model' : 'deterministic_command', intent);
  }

  /**
   * For channel adapters that have already routed deterministically: run one registered
   * tool through policy, the execution boundary and tracing.
   */
  async runTool<R = unknown>(
    toolId: string,
    rawRequest: AgentRequest,
    session: SessionContext,
    args: unknown,
    trigger: Trigger,
    opts: { intent?: IntentResult; followUp?: FollowUpTrace } = {}
  ): Promise<RunOutput<R>> {
    const request = AgentRequestSchema.parse(rawRequest);
    return this.execute<R>(toolId, request, session, args, trigger, opts.intent ?? routeIntentDeterministic(request.input, this.opts.router), undefined, opts.followUp);
  }

  /**
   * A turn that deliberately ran no tool: an acknowledgement, a clarification, or a reply
   * from stored display-safe context. Traced with no providers, tools, policy or outcome.
   */
  recordTurn(
    rawRequest: AgentRequest,
    turn: { status: 'acknowledged' | 'needs_clarification' | 'answered'; kind: 'acknowledgement' | 'clarification' | 'context_answer'; reason: string; intent?: IntentResult; followUp?: FollowUpTrace }
  ): AgentResult {
    const request = AgentRequestSchema.parse(rawRequest);
    const started = Date.now();
    const intent = turn.intent ?? { domain: 'unknown', intent: 'unknown', confidence: 0, source: 'deterministic', highRisk: false, entities: {}, requestedScope: null };
    const traceId = this.trace(request, intent, null, {
      toolsConsidered: [],
      policy: [],
      status: turn.status,
      started,
      resolution: { kind: turn.kind, reason: turn.reason },
      followUp: turn.followUp,
      resolvedDomain: intent.domain,
      // Acknowledgements/clarifications are session replies; a context answer belongs to its domain.
      responseDomain: turn.kind === 'context_answer' ? intent.domain : 'session',
    });
    return this.result(request, traceId, turn.status, null);
  }

  /**
   * Knowledge questions: canonicalize the transcript (read-only), then retrieve and ground
   * with the canonical question. The raw transcript stays the request input and the trace
   * preview. Low-confidence speech gets a clarification instead of a guessed question.
   */
  async runKnowledgeQuery<R = unknown>(
    rawRequest: AgentRequest,
    session: SessionContext,
    opts: { trigger?: Trigger; intent?: IntentResult; lastQuestion?: string | null; followUp?: FollowUpTrace } = {}
  ): Promise<RunOutput<R> & { canonical: CanonicalQuery; clarification: string | null }> {
    const request = AgentRequestSchema.parse(rawRequest);
    const started = Date.now();
    const intent = opts.intent ?? { ...routeIntentDeterministic(request.input, this.opts.router), intent: 'knowledge.query' as const, domain: 'knowledge' as const, highRisk: false };
    const canonical = await canonicalizeReadQuery({
      rawTranscript: request.input,
      intent: intent.intent,
      currentDomain: session.domain,
      conversationContext: { lastQuestion: opts.lastQuestion ?? null },
      rewriter: this.opts.rewriter ?? null,
    });
    const normalization = normalizationTrace(canonical);
    if (canonical.action === 'clarify') {
      const plan = planContext(intent, session);
      const traceId = this.trace(request, intent, plan, {
        toolsConsidered: ['knowledge.search'],
        policy: [],
        toolOutcome: { toolId: 'knowledge.search', ok: true, outcome: `clarify:${canonical.reason}` },
        status: 'needs_clarification',
        started,
        normalization,
        followUp: opts.followUp,
        resolvedDomain: 'knowledge',
        responseDomain: 'knowledge',
      });
      return {
        result: this.result(request, traceId, 'needs_clarification', KNOWLEDGE_CLARIFY_TEXT),
        binding: { requestId: request.requestId, sessionId: request.sessionId, domain: 'knowledge' },
        raw: null,
        outcome: null,
        canonical,
        clarification: KNOWLEDGE_CLARIFY_TEXT,
      };
    }
    const out = await this.execute<R>('knowledge.search', request, session, { question: canonical.canonical }, opts.trigger ?? 'deterministic_command', intent, normalization, opts.followUp);
    return { ...out, canonical, clarification: null };
  }

  private async execute<R>(
    toolId: string,
    request: AgentRequest,
    session: SessionContext,
    args: unknown,
    trigger: Trigger,
    intent: IntentResult,
    normalization?: NormalizationTrace,
    followUp?: FollowUpTrace
  ): Promise<RunOutput<R>> {
    const started = Date.now();
    const plan = planContext(intent, session);
    const tool = this.registry.get(toolId);
    const binding: ResultBinding = { requestId: request.requestId, sessionId: request.sessionId, domain: tool?.domain ?? null };

    // Response ownership: a tool may only answer a request that resolved to its own domain.
    if (tool && intent.domain !== tool.domain) {
      const reason = `domain_mismatch:${intent.domain}->${tool.domain}`;
      const traceId = this.trace(request, intent, plan, {
        toolsConsidered: [toolId],
        policy: [{ toolId, decision: 'deny', reason, trigger }],
        status: 'denied',
        started,
        resolvedDomain: intent.domain,
        responseDomain: null,
        normalization,
        followUp,
      });
      return { result: this.result(request, traceId, 'denied', null), binding: { ...binding, domain: null }, raw: null, outcome: null };
    }

    const outcome = await this.boundary.execute<R>({ toolId, args, request, session, trigger, deps: this.opts.deps ?? {} });
    const status = statusFromOutcome(outcome as ExecutionOutcome<unknown>);
    const raw = outcome.ok ? outcome.result : null;
    const traceId = this.trace(request, intent, plan, {
      toolsConsidered: [toolId],
      policy: [{ toolId, decision: outcome.policy.decision, reason: outcome.policy.reason, trigger }],
      providersInvoked: outcome.ok ? plan.providers : [],
      toolOutcome: { toolId, ok: outcome.ok && outcome.summary.ok, outcome: outcome.ok ? outcome.summary.outcome : outcome.policy.reason },
      approvalRequired: outcome.policy.decision === 'requires_approval',
      status,
      started,
      normalization,
      followUp,
      resolvedDomain: intent.domain,
      responseDomain: outcome.ok ? binding.domain : null,
    });
    const rawText = (raw as { text?: unknown } | null)?.text;
    const text = typeof rawText === 'string' ? rawText : null;
    const citations = ((raw as { context?: { citations?: Array<{ title: string; section: string | null; sourceLabel: string }> } } | null)?.context?.citations ?? []).map((c) => ({
      title: c.title,
      section: c.section,
      sourceLabel: c.sourceLabel,
    }));
    const result = this.result(request, traceId, status, text, {
      evidence: citations,
      toolResults: [{ toolId, ok: outcome.ok ? outcome.summary.ok : false, outcome: outcome.ok ? outcome.summary.outcome : outcome.policy.reason }],
      approvalRequest: outcome.policy.decision === 'requires_approval' ? { toolId, reason: outcome.policy.reason } : null,
      proposedActions: tool && tool.effect !== 'read' && !outcome.ok ? [{ toolId, effect: tool.effect, risk: tool.risk, description: tool.description }] : [],
    });
    return { result, binding, raw, outcome };
  }

  private result(request: AgentRequest, traceId: string, status: AgentStatus, answer: string | null, extra: Partial<AgentResult> = {}): AgentResult {
    return AgentResultSchema.parse({
      requestId: request.requestId,
      traceId,
      status,
      answer: answer ? answer.slice(0, 4000) : null,
      evidence: [],
      notices: [],
      proposedActions: [],
      approvalRequest: null,
      toolResults: [],
      ...extra,
    });
  }

  private trace(
    request: AgentRequest,
    intent: IntentResult,
    plan: ContextPlan | null,
    t: {
      toolsConsidered: string[];
      policy: AgentTrace['policy'];
      status: AgentStatus;
      started: number;
      providersInvoked?: string[];
      toolOutcome?: AgentTrace['toolOutcome'];
      approvalRequired?: boolean;
      dryRun?: boolean;
      normalization?: NormalizationTrace;
      followUp?: FollowUpTrace;
      resolution?: AgentTrace['resolution'];
      resolvedDomain?: string;
      responseDomain?: string | null;
    }
  ): string {
    const traceId = newTraceId();
    this.recorder.record({
      traceId,
      requestId: request.requestId,
      sessionId: request.sessionId,
      organizationId: request.organizationId,
      channel: request.channel,
      at: new Date().toISOString(),
      inputPreview: redact(request.input, 120),
      ...(t.normalization ? { normalization: { ...t.normalization, canonicalPreview: t.normalization.canonicalPreview ? redact(t.normalization.canonicalPreview, 160) : null } } : {}),
      intent: { intent: intent.intent, domain: intent.domain, source: intent.source, highRisk: intent.highRisk, confidence: intent.confidence },
      plan: plan ? { providers: plan.providers, completeness: plan.requiredCompleteness } : null,
      ...(t.followUp ? { followUp: t.followUp } : {}),
      ...(t.resolution ? { resolution: t.resolution } : {}),
      ...(t.resolvedDomain !== undefined ? { resolvedDomain: t.resolvedDomain, responseDomain: t.responseDomain ?? null } : {}),
      providersInvoked: t.providersInvoked ?? [],
      toolsConsidered: t.toolsConsidered,
      policy: t.policy,
      approvalRequired: t.approvalRequired ?? false,
      toolOutcome: t.toolOutcome ?? null,
      notices: [],
      latencyMs: Date.now() - t.started,
      status: t.status,
      dryRun: t.dryRun ?? false,
    });
    return traceId;
  }
}
