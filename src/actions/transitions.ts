import { type ActionStatus } from './types.js';

export class InvalidStateTransitionError extends Error {
  public readonly currentStatus: ActionStatus;
  public readonly targetStatus: ActionStatus;
  public readonly actionId?: string;

  constructor(currentStatus: ActionStatus, targetStatus: ActionStatus, actionId?: string) {
    const idMsg = actionId ? ` for action "${actionId}"` : '';
    super(
      `Invalid state transition${idMsg}: cannot transition from "${currentStatus}" to "${targetStatus}".`
    );
    this.name = 'InvalidStateTransitionError';
    this.currentStatus = currentStatus;
    this.targetStatus = targetStatus;
    this.actionId = actionId;
  }
}

/**
 * Deterministic transition rules for ActionRecord lifecycle.
 */
export const ALLOWED_TRANSITIONS: Record<ActionStatus, readonly ActionStatus[]> = {
  RECEIVED: ['CLASSIFIED', 'FAILED'],
  CLASSIFIED: ['DRAFTED', 'FAILED'],
  DRAFTED: ['AWAITING_APPROVAL', 'FAILED'],
  AWAITING_APPROVAL: ['APPROVED', 'REJECTED', 'FAILED'],
  APPROVED: ['EXECUTED', 'FAILED'],
  REJECTED: [],
  EXECUTED: [],
  FAILED: [],
};

/**
 * Returns true if transitioning from currentStatus to targetStatus is allowed.
 */
export function canTransition(currentStatus: ActionStatus, targetStatus: ActionStatus): boolean {
  const allowed = ALLOWED_TRANSITIONS[currentStatus];
  if (!allowed) {
    return false;
  }
  return allowed.includes(targetStatus);
}

/**
 * Asserts that the transition is valid, throwing InvalidStateTransitionError if not.
 */
export function assertValidTransition(
  currentStatus: ActionStatus,
  targetStatus: ActionStatus,
  actionId?: string
): void {
  if (!canTransition(currentStatus, targetStatus)) {
    throw new InvalidStateTransitionError(currentStatus, targetStatus, actionId);
  }
}
