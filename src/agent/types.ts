import crypto from 'node:crypto';
import { z } from 'zod';
import type { EvidenceItem, ProviderNotice } from '../cognition/context.js';

/**
 * Canonical shapes for the Pacific Rising Ops agent harness. Transport details (Twilio,
 * WebSocket, HTTP) stay in adapters; nothing here carries tokens, credentials or raw IDs
 * from external providers.
 */

export const ChannelSchema = z.enum(['voice', 'web', 'api']);
export type Channel = z.infer<typeof ChannelSchema>;

/** Who is asking. Only the authenticated owner exists today; anything else is denied by policy. */
export const ActorSchema = z.object({
  kind: z.enum(['owner', 'system', 'unknown']),
  /** Opaque, display-safe identifier (never a phone number or email). */
  id: z.string().min(1).max(64),
});
export type Actor = z.infer<typeof ActorSchema>;

export const AgentRequestSchema = z
  .object({
    requestId: z.string().min(8).max(64),
    sessionId: z.string().min(1).max(64),
    organizationId: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
    channel: ChannelSchema,
    actor: ActorSchema,
    input: z.string().trim().min(1).max(2000),
    timestamp: z.string().datetime(),
    /** Small, display-safe metadata only (validated as primitives). */
    metadata: z.record(z.union([z.string().max(200), z.number(), z.boolean(), z.null()])).default({}),
  })
  .strict();
export type AgentRequest = z.infer<typeof AgentRequestSchema>;

export function newRequestId(): string {
  return `req_${crypto.randomUUID()}`;
}

export function newTraceId(): string {
  return `trace_${crypto.randomUUID()}`;
}

/** Validates and normalizes a request. Throws on anything malformed. */
export function createAgentRequest(input: Omit<AgentRequest, 'requestId' | 'timestamp' | 'metadata'> & Partial<Pick<AgentRequest, 'requestId' | 'timestamp' | 'metadata'>>): AgentRequest {
  return AgentRequestSchema.parse({
    requestId: input.requestId ?? newRequestId(),
    timestamp: input.timestamp ?? new Date().toISOString(),
    metadata: input.metadata ?? {},
    ...input,
  });
}

export type Domain = 'knowledge' | 'calendar' | 'gmail' | 'photo_booth' | 'session' | 'unknown';

/** Session context the harness may read. Built from channel state; never holds secrets or message bodies. */
export interface SessionContext {
  sessionId: string;
  organizationId: string;
  channel: Channel;
  /** Current conversational domain (e.g. the voice conversation state). */
  domain: string;
  /** Account/calendar scope from the last read, e.g. "all" or ["business"]. */
  scope: { calendar: 'all' | string[] | null; inbox: 'all' | string[] | null };
  /** Bound Gmail approval lifecycle, if any (internal action ID + draft ID, no content). */
  boundAction: { actionId: string; draftId: string | null } | null;
  /** True while the owner is inside a two-step confirmation; read requests must not interrupt it. */
  awaitingConfirmation: 'approval' | 'rejection' | null;
  lastSafeResponse: string | null;
  now: string;
  timeZone: string;
  /** Reserved for durable memory (PHRO-AI-003+). Always empty in AI-002. */
  memoryRefs: string[];
}

export type IntentName =
  | 'knowledge.query'
  | 'calendar.schedule'
  | 'calendar.availability'
  | 'calendar.conflicts'
  | 'gmail.inbox'
  | 'gmail.select'
  | 'gmail.draft'
  | 'gmail.approve'
  | 'gmail.confirm'
  | 'gmail.reject'
  | 'photobooth.analytics'
  | 'session.repeat'
  | 'session.return'
  | 'session.end'
  | 'unknown';

export interface IntentResult {
  domain: Domain;
  intent: IntentName;
  confidence: number;
  /** How the intent was decided. High-risk intents are only ever "deterministic". */
  source: 'deterministic' | 'model_assisted';
  /** True for intents that can lead to a mutation; never model-assisted. */
  highRisk: boolean;
  entities: Record<string, string>;
  requestedScope: 'all' | string[] | null;
}

export type Completeness = 'all_sources' | 'best_effort';

export interface ContextPlan {
  providers: string[];
  limits: { maxEvidence: number };
  timeWindow: string | null;
  accountScope: 'all' | string[] | null;
  /** all_sources: any provider gap must be reported as incomplete, never as a clean answer. */
  requiredCompleteness: Completeness;
}

export type ToolEffect = 'read' | 'prepare' | 'write' | 'financial';
export type ToolRisk = 'low' | 'medium' | 'high' | 'critical';

export type AgentStatus = 'answered' | 'insufficient' | 'needs_clarification' | 'acknowledged' | 'unknown' | 'unavailable' | 'needs_approval' | 'denied' | 'not_handled' | 'error';

export interface ToolResultSummary {
  toolId: string;
  ok: boolean;
  outcome: string;
}

export interface ProposedAction {
  toolId: string;
  effect: ToolEffect;
  risk: ToolRisk;
  description: string;
}

export const AgentResultSchema = z
  .object({
    requestId: z.string(),
    traceId: z.string(),
    status: z.enum(['answered', 'insufficient', 'needs_clarification', 'acknowledged', 'unknown', 'unavailable', 'needs_approval', 'denied', 'not_handled', 'error']),
    answer: z.string().max(4000).nullable(),
    evidence: z.array(z.object({ title: z.string(), section: z.string().nullable(), sourceLabel: z.string() })),
    notices: z.array(z.object({ provider: z.string(), status: z.string(), detail: z.string() })),
    proposedActions: z.array(z.object({ toolId: z.string(), effect: z.string(), risk: z.string(), description: z.string() })),
    approvalRequest: z.object({ toolId: z.string(), reason: z.string() }).nullable(),
    toolResults: z.array(z.object({ toolId: z.string(), ok: z.boolean(), outcome: z.string() })),
  })
  .strict();
export type AgentResult = z.infer<typeof AgentResultSchema>;

/** Display-safe evidence (titles only, no IDs) for an AgentResult. */
export function safeEvidence(items: EvidenceItem[]): AgentResult['evidence'] {
  return items.map((e) => ({ title: e.title, section: e.section, sourceLabel: e.sourceLabel }));
}

export function safeNotices(items: ProviderNotice[]): AgentResult['notices'] {
  return items.map((n) => ({ provider: n.provider, status: n.status, detail: n.detail.slice(0, 200) }));
}
