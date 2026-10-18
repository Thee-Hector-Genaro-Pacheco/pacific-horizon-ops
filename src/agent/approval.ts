import type { ActionStore } from '../actions/store.js';
import { isTerminalStatus } from '../actions/transitions.js';
import type { SessionContext } from './types.js';

/**
 * Approval gateway: the harness's read-only view of each domain's own approval lifecycle.
 * It never creates or changes approvals; it only reports whether the domain's
 * deterministic confirmation path has already recorded one for this exact action.
 *
 * Not authorization, ever:
 *   - a casual "yes", "sure", "send it"      (only the exact two-step phrase approves)
 *   - a timeout or a dropped call             (the action simply stays AWAITING_APPROVAL)
 *   - model output claiming approval          (models cannot write lifecycle state)
 *   - text in retrieved knowledge             (evidence is data, not instructions)
 *   - a different or stale action             (identity must match the session binding)
 */

export type ApprovalState = 'confirmed' | 'pending' | 'absent' | 'invalid';

export interface ApprovalVerdict {
  state: ApprovalState;
  reason: string;
}

export interface ApprovalGateway {
  /** Domain this gateway speaks for, e.g. "gmail". */
  readonly domain: string;
  verify(toolId: string, args: unknown, session: SessionContext): Promise<ApprovalVerdict>;
}

/** Gmail: confirmed only when the existing two-step flow has moved this bound action to APPROVED. */
export class GmailApprovalGateway implements ApprovalGateway {
  readonly domain = 'gmail';
  constructor(private readonly actionStore: ActionStore) {}

  async verify(_toolId: string, args: unknown, session: SessionContext): Promise<ApprovalVerdict> {
    const actionId = (args as { actionId?: unknown } | null)?.actionId;
    if (typeof actionId !== 'string') return { state: 'absent', reason: 'no_action_identity' };
    const bound = session.boundAction;
    if (!bound || bound.actionId !== actionId) return { state: 'invalid', reason: 'action_not_bound_to_session' };
    const action = this.actionStore.getAction(actionId);
    if (!action) return { state: 'invalid', reason: 'action_missing' };
    const actionDraft = action.draftId || (action.proposedAction.payload?.draftId as string | undefined) || null;
    if (bound.draftId && actionDraft !== bound.draftId) return { state: 'invalid', reason: 'draft_mismatch' };
    if (action.status === 'AWAITING_APPROVAL') return { state: 'pending', reason: 'awaiting_two_step_confirmation' };
    if (action.status === 'APPROVED') {
      const m = action.approvalMetadata;
      if (m?.decision === 'approved' && (m.approvalSource === 'voice' || m.approvalSource === 'cli')) return { state: 'confirmed', reason: 'two_step_confirmation_recorded' };
      return { state: 'invalid', reason: 'approval_record_incomplete' };
    }
    if (isTerminalStatus(action.status)) return { state: 'invalid', reason: `terminal_${action.status.toLowerCase()}` };
    return { state: 'invalid', reason: `status_${action.status.toLowerCase()}` };
  }
}
