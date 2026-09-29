import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  type ActionRecord,
  type ActionEvent,
  type ActionStatus,
  type ActionType,
  type ApprovalRecord,
  ActionRecordSchema,
} from './types.js';
import { assertValidTransition } from './transitions.js';

export interface ActionStoreOptions {
  dataDir?: string;
  actionsFilePath?: string;
  eventsFilePath?: string;
}

export interface CreateDraftActionParams {
  messageId: string;
  threadId: string;
  draftId: string;
  subject: string;
  from: string;
  classificationCategory: string;
  confidence: number;
  draftReply: string;
}

export class ActionStore {
  private readonly dataDir: string;
  private readonly actionsFilePath: string;
  private readonly eventsFilePath: string;

  constructor(options: ActionStoreOptions = {}) {
    this.dataDir = options.dataDir || path.resolve(process.cwd(), 'data');
    this.actionsFilePath =
      options.actionsFilePath || path.join(this.dataDir, 'actions.json');
    this.eventsFilePath =
      options.eventsFilePath || path.join(this.dataDir, 'action-events.jsonl');
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  /**
   * Loads all actions from actions.json
   */
  public loadActions(): Map<string, ActionRecord> {
    this.ensureDir();
    if (!fs.existsSync(this.actionsFilePath)) {
      return new Map();
    }

    try {
      const raw = fs.readFileSync(this.actionsFilePath, 'utf-8');
      if (!raw.trim()) {
        return new Map();
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return new Map();
      }

      const map = new Map<string, ActionRecord>();
      for (const item of parsed) {
        const validated = ActionRecordSchema.parse(item);
        map.set(validated.actionId, validated);
      }
      return map;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to load actions from ${this.actionsFilePath}: ${msg}`);
    }
  }

  /**
   * Safely writes actions map to actions.json using a temp-file + atomic rename pattern
   */
  private persistActions(actions: Map<string, ActionRecord>): void {
    this.ensureDir();
    const actionList = Array.from(actions.values());
    const serialized = JSON.stringify(actionList, null, 2);

    const tempFilePath = path.join(
      this.dataDir,
      `actions.json.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`
    );

    fs.writeFileSync(tempFilePath, serialized, 'utf-8');
    fs.renameSync(tempFilePath, this.actionsFilePath);
  }

  /**
   * Appends an audit event to action-events.jsonl
   */
  public appendEvent(event: ActionEvent): void {
    this.ensureDir();
    fs.appendFileSync(this.eventsFilePath, `${JSON.stringify(event)}\n`, 'utf-8');
  }

  /**
   * Finds an existing action by messageId and actionType (idempotency check)
   */
  public findActionByMessageAndType(
    messageId: string,
    actionType: ActionType
  ): ActionRecord | undefined {
    const actions = this.loadActions();
    for (const action of actions.values()) {
      if (action.messageId === messageId && action.actionType === actionType) {
        return action;
      }
    }
    return undefined;
  }

  /**
   * Gets an action by actionId
   */
  public getAction(actionId: string): ActionRecord | undefined {
    const actions = this.loadActions();
    return actions.get(actionId);
  }

  /**
   * Lists actions, optionally filtered by status
   */
  public listActions(filter?: { status?: ActionStatus }): ActionRecord[] {
    const actions = Array.from(this.loadActions().values());
    if (filter?.status) {
      return actions.filter((a) => a.status === filter.status);
    }
    return actions;
  }

  /**
   * Registers a draft action resulting from live email processing.
   * If an action for this (messageId, CREATE_EMAIL_DRAFT) already exists, returns existing action (idempotent).
   * Otherwise, creates the action progressing through RECEIVED -> CLASSIFIED -> DRAFTED -> AWAITING_APPROVAL.
   */
  public createDraftAction(params: CreateDraftActionParams): {
    action: ActionRecord;
    isNew: boolean;
  } {
    const existing = this.findActionByMessageAndType(params.messageId, 'CREATE_EMAIL_DRAFT');
    if (existing) {
      return { action: existing, isNew: false };
    }

    const actionId = `act_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();

    const action: ActionRecord = {
      actionId,
      createdAt: now,
      updatedAt: now,
      messageId: params.messageId,
      threadId: params.threadId,
      draftId: params.draftId,
      actionType: 'CREATE_EMAIL_DRAFT',
      status: 'AWAITING_APPROVAL',
      subject: params.subject,
      from: params.from,
      classificationCategory: params.classificationCategory,
      confidence: params.confidence,
      proposedAction: {
        type: 'CREATE_EMAIL_DRAFT',
        description: `Draft reply created in Gmail thread ${params.threadId}`,
        payload: {
          draftId: params.draftId,
          draftReply: params.draftReply,
        },
      },
      approvalMetadata: null,
      executionMetadata: null,
      failureReason: null,
    };

    // Record lifecycle events up to AWAITING_APPROVAL
    this.appendEvent({
      eventId: `evt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      actionId,
      timestamp: now,
      fromStatus: null,
      toStatus: 'RECEIVED',
      actor: 'system',
      reason: 'Incoming email message received',
    });

    this.appendEvent({
      eventId: `evt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      actionId,
      timestamp: now,
      fromStatus: 'RECEIVED',
      toStatus: 'CLASSIFIED',
      actor: 'system:claude',
      reason: `Email classified as ${params.classificationCategory} (confidence: ${params.confidence})`,
    });

    this.appendEvent({
      eventId: `evt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      actionId,
      timestamp: now,
      fromStatus: 'CLASSIFIED',
      toStatus: 'DRAFTED',
      actor: 'system:gmail',
      reason: `Draft created in Gmail (draftId: ${params.draftId})`,
      metadata: { draftId: params.draftId },
    });

    this.appendEvent({
      eventId: `evt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      actionId,
      timestamp: now,
      fromStatus: 'DRAFTED',
      toStatus: 'AWAITING_APPROVAL',
      actor: 'system',
      reason: 'Draft ready for human approval',
    });

    const actions = this.loadActions();
    actions.set(actionId, action);
    this.persistActions(actions);

    return { action, isNew: true };
  }

  /**
   * Transitions an action to a new status with validation guards and audit logging.
   */
  public transitionAction(
    actionId: string,
    nextStatus: ActionStatus,
    options: {
      actor: string;
      reason?: string;
      approval?: ApprovalRecord;
      failureReason?: string;
      metadata?: Record<string, unknown>;
    }
  ): ActionRecord {
    const actions = this.loadActions();
    const action = actions.get(actionId);

    if (!action) {
      throw new Error(`Action "${actionId}" not found.`);
    }

    // Guard: deterministic transition rules
    assertValidTransition(action.status, nextStatus, actionId);

    const now = new Date().toISOString();
    const previousStatus = action.status;

    action.status = nextStatus;
    action.updatedAt = now;

    if (options.approval) {
      action.approvalMetadata = options.approval;
    }
    if (options.failureReason) {
      action.failureReason = options.failureReason;
    }

    // Append audit event
    this.appendEvent({
      eventId: `evt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      actionId,
      timestamp: now,
      fromStatus: previousStatus,
      toStatus: nextStatus,
      actor: options.actor,
      reason: options.reason,
      metadata: options.metadata,
    });

    // Atomic persistence
    actions.set(actionId, action);
    this.persistActions(actions);

    return action;
  }

  /**
   * Approves an action that is currently AWAITING_APPROVAL
   */
  public approveAction(actionId: string, approval: ApprovalRecord): ActionRecord {
    return this.transitionAction(actionId, 'APPROVED', {
      actor: `${approval.approvalSource}:${approval.approvedBy}`,
      reason: approval.notes || `Approved via ${approval.approvalSource}`,
      approval,
      metadata: { approval },
    });
  }

  /**
   * Rejects an action that is currently AWAITING_APPROVAL
   */
  public rejectAction(actionId: string, rejection: ApprovalRecord): ActionRecord {
    return this.transitionAction(actionId, 'REJECTED', {
      actor: `${rejection.approvalSource}:${rejection.approvedBy}`,
      reason: rejection.notes || `Rejected via ${rejection.approvalSource}`,
      approval: rejection,
      metadata: { rejection },
    });
  }
}

export const defaultActionStore = new ActionStore();
