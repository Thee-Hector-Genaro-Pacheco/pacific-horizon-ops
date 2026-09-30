import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  type MailboxCleanupPlan,
  type MailboxCleanupEvent,
  type PlanStatus,
  MailboxCleanupPlanSchema,
} from './types.js';

export interface MailboxStoreOptions {
  dataDir?: string;
  plansFilePath?: string;
  eventsFilePath?: string;
}

export class MailboxStore {
  private readonly dataDir: string;
  private readonly plansFilePath: string;
  private readonly eventsFilePath: string;

  constructor(options: MailboxStoreOptions = {}) {
    this.dataDir = options.dataDir || path.resolve(process.cwd(), 'data');
    this.plansFilePath =
      options.plansFilePath || path.join(this.dataDir, 'mailbox-cleanup-plans.json');
    this.eventsFilePath =
      options.eventsFilePath || path.join(this.dataDir, 'mailbox-cleanup-events.jsonl');
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  /**
   * Loads all cleanup plans from mailbox-cleanup-plans.json
   */
  public loadPlans(): Map<string, MailboxCleanupPlan> {
    this.ensureDir();
    if (!fs.existsSync(this.plansFilePath)) {
      return new Map();
    }

    try {
      const raw = fs.readFileSync(this.plansFilePath, 'utf-8');
      if (!raw.trim()) {
        return new Map();
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return new Map();
      }

      const map = new Map<string, MailboxCleanupPlan>();
      for (const item of parsed) {
        const validated = MailboxCleanupPlanSchema.parse(item);
        map.set(validated.id, validated);
      }
      return map;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to load mailbox cleanup plans from ${this.plansFilePath}: ${msg}`);
    }
  }

  /**
   * Atomically persists all plans using temp-file + rename pattern
   */
  private persistPlans(plans: Map<string, MailboxCleanupPlan>): void {
    this.ensureDir();
    const list = Array.from(plans.values());
    const serialized = JSON.stringify(list, null, 2);

    const tempFilePath = path.join(
      this.dataDir,
      `mailbox-cleanup-plans.json.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`
    );

    fs.writeFileSync(tempFilePath, serialized, 'utf-8');
    fs.renameSync(tempFilePath, this.plansFilePath);
  }

  /**
   * Appends an audit event to mailbox-cleanup-events.jsonl
   */
  public appendEvent(event: MailboxCleanupEvent): void {
    this.ensureDir();
    fs.appendFileSync(this.eventsFilePath, `${JSON.stringify(event)}\n`, 'utf-8');
  }

  /**
   * Gets a plan by ID
   */
  public getPlan(planId: string): MailboxCleanupPlan | undefined {
    return this.loadPlans().get(planId);
  }

  /**
   * Lists plans, optionally filtered by status
   */
  public listPlans(filter?: { status?: PlanStatus }): MailboxCleanupPlan[] {
    const list = Array.from(this.loadPlans().values());
    if (filter?.status) {
      return list.filter((p) => p.status === filter.status);
    }
    return list;
  }

  /**
   * Saves or updates a cleanup plan
   */
  public savePlan(plan: MailboxCleanupPlan): void {
    const plans = this.loadPlans();
    plans.set(plan.id, plan);
    this.persistPlans(plans);
  }

  /**
   * Explicitly approves a plan that is currently in REVIEW_REQUIRED status
   */
  public approvePlan(planId: string, actor: string = 'cli'): MailboxCleanupPlan {
    const plans = this.loadPlans();
    const plan = plans.get(planId);

    if (!plan) {
      throw new Error(`Cleanup plan "${planId}" not found.`);
    }

    if (plan.status !== 'REVIEW_REQUIRED' && plan.status !== 'CREATED') {
      throw new Error(
        `Cannot approve plan "${planId}": current status is "${plan.status}", expected "REVIEW_REQUIRED".`
      );
    }

    const prevStatus = plan.status;
    const now = new Date().toISOString();

    plan.status = 'APPROVED';
    plan.approvedAt = now;
    plan.approvedBy = actor;

    plans.set(planId, plan);
    this.persistPlans(plans);

    this.appendEvent({
      eventId: `mbevt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      planId,
      timestamp: now,
      fromStatus: prevStatus,
      toStatus: 'APPROVED',
      actor,
      reason: 'Plan approved by user for subsequent execution',
    });

    return plan;
  }

  /**
   * Updates plan status with an audit event
   */
  public updatePlanStatus(
    planId: string,
    status: PlanStatus,
    details?: {
      failure?: string;
      actor?: string;
      reason?: string;
      executedAt?: string;
      metadata?: Record<string, unknown>;
    }
  ): MailboxCleanupPlan {
    const plans = this.loadPlans();
    const plan = plans.get(planId);

    if (!plan) {
      throw new Error(`Cleanup plan "${planId}" not found.`);
    }

    const prevStatus = plan.status;
    const now = new Date().toISOString();

    plan.status = status;
    if (details?.failure !== undefined) {
      plan.failure = details.failure;
    }
    if (details?.executedAt !== undefined) {
      plan.executedAt = details.executedAt;
    }

    plans.set(planId, plan);
    this.persistPlans(plans);

    this.appendEvent({
      eventId: `mbevt_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      planId,
      timestamp: now,
      fromStatus: prevStatus,
      toStatus: status,
      actor: details?.actor || 'system:mailbox',
      reason: details?.reason,
      metadata: details?.metadata,
    });

    return plan;
  }

  /**
   * Reads all audit events, optionally filtering by planId
   */
  public listEvents(planId?: string): MailboxCleanupEvent[] {
    this.ensureDir();
    if (!fs.existsSync(this.eventsFilePath)) {
      return [];
    }
    const raw = fs.readFileSync(this.eventsFilePath, 'utf-8').trim();
    if (!raw) return [];
    const lines = raw.split('\n');
    const events: MailboxCleanupEvent[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (!planId || parsed.planId === planId) {
          events.push(parsed);
        }
      } catch {
        // ignore malformed line
      }
    }
    return events;
  }
}

export const defaultMailboxStore = new MailboxStore();
