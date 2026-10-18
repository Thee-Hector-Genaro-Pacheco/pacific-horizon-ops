import { z } from 'zod';
import type { ActionExecutor } from '../actions/executor.js';
import type { ActionStore } from '../actions/store.js';
import { answerCalendarQuestion, type CalendarVoiceContext, type CalendarVoiceDeps } from '../voice/calendar.js';
import { answerEmailQuestion, type EmailVoiceContext, type EmailVoiceDeps } from '../voice/email.js';
import { answerKnowledgeForVoice, type KnowledgeVoiceDeps } from '../voice/knowledge.js';
import { askPhotoBoothForVoice, type PhotoBoothVoiceContext, type PhotoBoothVoiceDeps } from '../voice/analytics.js';
import type { AgentRequest, SessionContext, ToolEffect, ToolRisk } from './types.js';

/**
 * Central registry of what Pacific Ops CAN do. Each tool declares its effect, risk and
 * approval policy; the PolicyEngine and ExecutionBoundary enforce them. Implementations
 * wrap existing, already-tested domain code; nothing new talks to an external API here.
 */

export type ApprovalPolicy =
  /** Read-only: no confirmation. */
  | 'none'
  /** Must come from an explicit, deterministically matched owner command (never from a model). */
  | 'owner_command'
  /** Requires a verified, completed two-step confirmation in the domain's own lifecycle. */
  | 'confirmation_required';

/** Domain dependencies supplied by the adapter (voice, CLI, tests). No secrets. */
export interface HarnessDeps {
  knowledge?: KnowledgeVoiceDeps;
  calendar?: CalendarVoiceDeps;
  email?: EmailVoiceDeps;
  photoBooth?: PhotoBoothVoiceDeps;
  actionStore?: ActionStore;
  executor?: ActionExecutor;
}

export interface ToolContext {
  request: AgentRequest;
  session: SessionContext;
  deps: HarnessDeps;
}

export interface ToolDefinition<A = unknown, R = unknown> {
  id: string;
  domain: string;
  description: string;
  effect: ToolEffect;
  risk: ToolRisk;
  approvalPolicy: ApprovalPolicy;
  capabilities: string[];
  /** Arguments are validated against this schema before anything runs. */
  args: z.ZodType<A>;
  /**
   * Absent for capabilities whose execution stays in a legacy, lifecycle-owning flow
   * (e.g. the mailbox draft step). Such tools can be classified but never executed here.
   */
  implementation?: (args: A, ctx: ToolContext) => Promise<R>;
  /** Display-safe outcome for traces and AgentResult. */
  summarize?: (result: R) => { ok: boolean; outcome: string };
}

const TOOL_ID = /^[a-z][a-z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+$/;

/**
 * Capabilities documented as future contracts. They are data, never registrable, so a
 * model naming one can only ever hit "not registered".
 */
export const FUTURE_TOOL_CONTRACTS: ReadonlyArray<{ id: string; domain: string; effect: ToolEffect; risk: ToolRisk; approvalPolicy: ApprovalPolicy; note: string }> = [
  { id: 'calendar.create', domain: 'calendar', effect: 'write', risk: 'high', approvalPolicy: 'confirmation_required', note: 'Calendar writes are out of scope (needs a Calendar write scope and its own approval lifecycle).' },
  { id: 'ads.google.read', domain: 'ads', effect: 'read', risk: 'low', approvalPolicy: 'none', note: 'Google Ads reporting (no Ads API yet).' },
  { id: 'ads.google.modify', domain: 'ads', effect: 'financial', risk: 'critical', approvalPolicy: 'confirmation_required', note: 'Budget/bid/campaign changes spend money.' },
  { id: 'crypto.marketData', domain: 'crypto', effect: 'read', risk: 'low', approvalPolicy: 'none', note: 'Market data (no exchange API yet).' },
  { id: 'crypto.validator.health', domain: 'crypto', effect: 'read', risk: 'low', approvalPolicy: 'none', note: 'Validator telemetry (no validator integration yet).' },
  { id: 'crypto.paperTrade', domain: 'crypto', effect: 'prepare', risk: 'medium', approvalPolicy: 'owner_command', note: 'Simulated orders only.' },
  { id: 'crypto.liveTrade', domain: 'crypto', effect: 'financial', risk: 'critical', approvalPolicy: 'confirmation_required', note: 'Real orders move real money.' },
];

export class ToolRegistryError extends Error {}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<unknown, unknown>>();

  register<A, R>(tool: ToolDefinition<A, R>): void {
    if (!TOOL_ID.test(tool.id)) throw new ToolRegistryError(`Invalid tool id "${tool.id}".`);
    if (this.tools.has(tool.id)) throw new ToolRegistryError(`Duplicate tool id "${tool.id}".`);
    if (FUTURE_TOOL_CONTRACTS.some((c) => c.id === tool.id)) {
      throw new ToolRegistryError(`"${tool.id}" is a future contract and cannot be registered in this version.`);
    }
    if (tool.effect === 'read' && tool.approvalPolicy !== 'none') throw new ToolRegistryError(`Read tool "${tool.id}" must not require approval.`);
    if ((tool.effect === 'write' || tool.effect === 'financial') && tool.approvalPolicy !== 'confirmation_required') {
      throw new ToolRegistryError(`Mutating tool "${tool.id}" must require confirmation.`);
    }
    if (tool.risk === 'critical' && tool.approvalPolicy !== 'confirmation_required') throw new ToolRegistryError(`Critical tool "${tool.id}" must require confirmation.`);
    this.tools.set(tool.id, tool as ToolDefinition<unknown, unknown>);
  }

  get(id: string): ToolDefinition<unknown, unknown> | undefined {
    return this.tools.get(id);
  }

  list(): ToolDefinition<unknown, unknown>[] {
    return [...this.tools.values()];
  }
}

const QuestionArgs = z.object({ question: z.string().trim().min(1).max(2000), context: z.unknown().optional() }).strict();
type QuestionArgs = z.infer<typeof QuestionArgs>;

const okOutcome = (r: { ok: boolean; outcome: string }) => ({ ok: r.ok, outcome: r.outcome });

/** The tools that exist today. Read tools wrap the existing answerers unchanged. */
export function createDefaultToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register<QuestionArgs, Awaited<ReturnType<typeof answerKnowledgeForVoice>>>({
    id: 'knowledge.search',
    domain: 'knowledge',
    description: 'Answer from stored company knowledge with provenance; refuses when evidence is insufficient.',
    effect: 'read',
    risk: 'low',
    approvalPolicy: 'none',
    capabilities: ['knowledge.read'],
    args: QuestionArgs,
    implementation: (a, ctx) => answerKnowledgeForVoice(a.question, ctx.deps.knowledge),
    summarize: okOutcome,
  });

  for (const [id, description] of [
    ['calendar.read', 'Read schedules, next/first events and availability across selected Google calendars.'],
    ['calendar.conflicts', 'Find strictly overlapping busy events across selected Google calendars.'],
  ] as const) {
    registry.register<QuestionArgs, Awaited<ReturnType<typeof answerCalendarQuestion>>>({
      id,
      domain: 'calendar',
      description,
      effect: 'read',
      risk: 'low',
      approvalPolicy: 'none',
      capabilities: ['calendar.read'],
      args: QuestionArgs,
      implementation: (a, ctx) => answerCalendarQuestion(a.question, (a.context as CalendarVoiceContext | null) ?? null, ctx.deps.calendar),
      summarize: okOutcome,
    });
  }

  registry.register<QuestionArgs, Awaited<ReturnType<typeof answerEmailQuestion>>>({
    id: 'gmail.read',
    domain: 'gmail',
    description: 'Read recent inbox messages across connected Google accounts (bounded, metadata only).',
    effect: 'read',
    risk: 'low',
    approvalPolicy: 'none',
    capabilities: ['gmail.read'],
    args: QuestionArgs,
    implementation: (a, ctx) => answerEmailQuestion(a.question, (a.context as EmailVoiceContext | null) ?? null, ctx.deps.email),
    summarize: okOutcome,
  });

  registry.register<QuestionArgs, Awaited<ReturnType<typeof askPhotoBoothForVoice>>>({
    id: 'photobooth.analytics',
    domain: 'photo_booth',
    description: 'Read-only Photo Booth event analytics with metric-meaning safeguards.',
    effect: 'read',
    risk: 'low',
    approvalPolicy: 'none',
    capabilities: ['photobooth.read'],
    args: QuestionArgs,
    implementation: (a, ctx) => askPhotoBoothForVoice(a.question, (a.context as PhotoBoothVoiceContext | null) ?? null, ctx.deps.photoBooth),
    summarize: okOutcome,
  });

  registry.register({
    id: 'gmail.prepareDraft',
    domain: 'gmail',
    description: 'Create a business Gmail reply draft bound to a new approval lifecycle (legacy mailbox flow).',
    effect: 'prepare',
    risk: 'medium',
    approvalPolicy: 'owner_command',
    capabilities: ['gmail.compose'],
    args: z.object({ messageIndex: z.number().int().min(1).max(3) }).strict(),
    // No implementation: drafting stays in the existing mailbox flow, which owns draft/action binding.
  });

  registry.register<{ actionId: string }, Awaited<ReturnType<ActionExecutor['executeApprovedAction']>>>({
    id: 'gmail.sendApprovedDraft',
    domain: 'gmail',
    description: 'Send the exact approved business Gmail draft. Requires a completed two-step confirmation.',
    effect: 'write',
    risk: 'high',
    approvalPolicy: 'confirmation_required',
    capabilities: ['gmail.send'],
    args: z.object({ actionId: z.string().regex(/^act_[A-Za-z0-9_]+$/) }).strict(),
    implementation: async (a, ctx) => {
      if (!ctx.deps.executor || !ctx.deps.actionStore) throw new Error('Send executor is not configured.');
      // The existing executor re-checks APPROVED status, exact draft content and idempotency.
      return ctx.deps.executor.executeApprovedAction(a.actionId, { actor: 'agent:harness', approvalSource: 'voice', actionStore: ctx.deps.actionStore });
    },
    summarize: (r) => ({ ok: r.success, outcome: r.success ? 'sent' : 'send_failed' }),
  });

  return registry;
}
