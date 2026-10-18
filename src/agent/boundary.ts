import type { ApprovalGateway, ApprovalVerdict } from './approval.js';
import { evaluatePolicy, type PolicyOutcome, type Trigger } from './policy.js';
import type { HarnessDeps, ToolRegistry } from './tools.js';
import type { AgentRequest, SessionContext } from './types.js';

/**
 * The only way a tool runs. Every execution requires: a registered tool with an
 * implementation, schema-valid arguments, a policy "allow", a verified confirmation for
 * mutating tools, and a bound action identity (checked by the domain's approval gateway).
 * Tools are looked up by exact registered ID in a Map: there is no dynamic dispatch, no
 * eval, and an LLM-produced name can only ever resolve to a registered tool or nothing.
 */

export interface ExecutionRequest {
  toolId: string;
  args: unknown;
  request: AgentRequest;
  session: SessionContext;
  trigger: Trigger;
  deps: HarnessDeps;
}

export type ExecutionOutcome<R = unknown> =
  | { ok: true; toolId: string; policy: PolicyOutcome; approval: ApprovalVerdict | null; result: R; summary: { ok: boolean; outcome: string } }
  | { ok: false; toolId: string; policy: PolicyOutcome; approval: ApprovalVerdict | null; error: string };

export class ExecutionBoundary {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly approvals: Map<string, ApprovalGateway> = new Map()
  ) {}

  async execute<R = unknown>(req: ExecutionRequest): Promise<ExecutionOutcome<R>> {
    const tool = this.registry.get(req.toolId);
    const deny = (policy: PolicyOutcome, approval: ApprovalVerdict | null, error: string): ExecutionOutcome<R> => ({ ok: false, toolId: req.toolId, policy, approval, error });

    if (!tool) return deny({ decision: 'deny', reason: 'unregistered_tool' }, null, `Tool "${req.toolId}" is not registered.`);
    const args = tool.args.safeParse(req.args);
    if (!args.success) return deny({ decision: 'deny', reason: 'invalid_arguments' }, null, 'Tool arguments failed validation.');
    if (!tool.implementation) {
      return deny({ decision: 'deny', reason: 'not_executable_here' }, null, `Tool "${tool.id}" is handled by its domain's own lifecycle, not the harness.`);
    }

    let approval: ApprovalVerdict | null = null;
    if (tool.approvalPolicy === 'confirmation_required') {
      const gateway = this.approvals.get(tool.domain);
      approval = gateway ? await gateway.verify(tool.id, args.data, req.session) : { state: 'absent', reason: 'no_approval_gateway_for_domain' };
    }

    const policy = evaluatePolicy({ tool, request: req.request, session: req.session, trigger: req.trigger, approval: approval ?? undefined });
    if (policy.decision !== 'allow') return deny(policy, approval, `Policy ${policy.decision}: ${policy.reason}`);

    try {
      const result = (await tool.implementation(args.data, { request: req.request, session: req.session, deps: req.deps })) as R;
      const summary = tool.summarize ? tool.summarize(result) : { ok: true, outcome: 'completed' };
      return { ok: true, toolId: tool.id, policy, approval, result, summary };
    } catch (err) {
      return deny(policy, approval, err instanceof Error ? err.message.slice(0, 200) : 'Tool failed.');
    }
  }
}
