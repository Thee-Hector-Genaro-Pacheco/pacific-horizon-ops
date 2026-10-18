import type { ApprovalVerdict } from './approval.js';
import type { ToolDefinition } from './tools.js';
import type { AgentRequest, SessionContext } from './types.js';

/**
 * Deterministic policy engine. The model never decides whether it has permission:
 * decisions come only from the tool's declared effect/risk/approval policy, the actor,
 * organization, session state and the approval gateway's verdict.
 */

export type PolicyDecision = 'allow' | 'deny' | 'requires_approval';

/** Where a tool request originated. Model-originated requests can only ever read. */
export type Trigger = 'deterministic_command' | 'model' | 'system';

export interface PolicyInput {
  tool: ToolDefinition<unknown, unknown> | undefined;
  request: AgentRequest;
  session: SessionContext;
  trigger: Trigger;
  approval?: ApprovalVerdict;
}

export interface PolicyOutcome {
  decision: PolicyDecision;
  reason: string;
}

export function evaluatePolicy(input: PolicyInput): PolicyOutcome {
  const { tool, request, session, trigger } = input;
  if (!tool) return { decision: 'deny', reason: 'unregistered_tool' };
  if (request.organizationId !== session.organizationId) return { decision: 'deny', reason: 'organization_mismatch' };
  if (request.sessionId !== session.sessionId) return { decision: 'deny', reason: 'session_mismatch' };
  if (request.actor.kind !== 'owner') return { decision: 'deny', reason: 'actor_not_authorized' };

  if (tool.effect === 'read') {
    // A pending two-step confirmation owns the conversation; reads must not interrupt it.
    if (session.awaitingConfirmation) return { decision: 'deny', reason: 'confirmation_in_progress' };
    return { decision: 'allow', reason: 'read_only' };
  }

  if (trigger === 'model') return { decision: 'deny', reason: 'model_cannot_initiate_mutation' };

  if (tool.approvalPolicy === 'owner_command') {
    return trigger === 'deterministic_command' ? { decision: 'allow', reason: 'explicit_owner_command' } : { decision: 'deny', reason: 'requires_explicit_owner_command' };
  }

  // write / financial / high / critical
  if (input.approval?.state === 'confirmed') return { decision: 'allow', reason: 'confirmation_verified' };
  if (input.approval?.state === 'invalid') return { decision: 'deny', reason: `approval_invalid:${input.approval.reason}` };
  return { decision: 'requires_approval', reason: input.approval ? `approval_${input.approval.state}:${input.approval.reason}` : 'approval_not_verified' };
}
