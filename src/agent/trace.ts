import fs from 'node:fs';
import path from 'node:path';
import type { NormalizationTrace } from './canonicalize.js';
import type { FollowUpTrace } from './followUp.js';
import type { PolicyDecision, Trigger } from './policy.js';
import type { AgentStatus, Channel, Completeness, IntentName } from './types.js';

/**
 * Agent traces answer "why did Pacific Ops do this?" with structured, redacted facts:
 * the intent, the context plan, providers used, tools considered, policy outcomes and the
 * final status. Never prompts, tokens, keys, database URLs, email bodies or hidden titles.
 */

export interface AgentTrace {
  traceId: string;
  requestId: string;
  sessionId: string;
  organizationId: string;
  channel: Channel;
  at: string;
  /** Redacted, clipped preview of the owner's words (the raw transcript, never the rewrite). */
  inputPreview: string;
  /** Read-only knowledge canonicalization, when it ran. canonicalPreview is redacted too. */
  normalization?: NormalizationTrace;
  /** Present only when a turn inherited the active read domain through the follow-up resolver. */
  followUp?: FollowUpTrace;
  /** Domain the request resolved to, and the domain of the tool whose result was produced. Must match. */
  resolvedDomain?: string;
  responseDomain?: string | null;
  /** Present for turns that ran no tool on purpose (acknowledgement or clarification). */
  resolution?: { kind: 'acknowledgement' | 'clarification' | 'context_answer'; reason: string };
  intent: { intent: IntentName; domain: string; source: string; highRisk: boolean; confidence: number };
  plan: { providers: string[]; completeness: Completeness } | null;
  providersInvoked: string[];
  toolsConsidered: string[];
  policy: Array<{ toolId: string; decision: PolicyDecision; reason: string; trigger: Trigger }>;
  approvalRequired: boolean;
  toolOutcome: { toolId: string; ok: boolean; outcome: string } | null;
  notices: Array<{ provider: string; status: string }>;
  latencyMs: number;
  status: AgentStatus;
  dryRun: boolean;
}

export interface TraceRecorder {
  record(trace: AgentTrace): void;
  recent(limit?: number): AgentTrace[];
}

const REDACTIONS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[private key]'],
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, '[api key]'],
  [/\bsk-[A-Za-z0-9]{20,}/g, '[api key]'],
  [/\bya29\.[A-Za-z0-9_-]{10,}/g, '[oauth token]'],
  [/\b1\/\/0[A-Za-z0-9_-]{10,}/g, '[oauth token]'],
  [/\bGOCSPX-[A-Za-z0-9_-]{8,}/g, '[oauth secret]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[aws key]'],
  [/\bxox[abpr]-[A-Za-z0-9-]{8,}/g, '[slack token]'],
  [/\bBearer\s+[A-Za-z0-9._-]{12,}/gi, 'Bearer [token]'],
  [/\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s]+/gi, '[database url]'],
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]'],
  [/\+?\d[\d\s().-]{8,}\d/g, '[number]'],
];

/** Redacts secrets and contact details and clips the result. */
export function redact(text: string, max = 160): string {
  let out = text;
  for (const [re, label] of REDACTIONS) out = out.replace(re, label);
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/** Harness-generated identifiers and timestamps: structural, never free text, so not run through redact(). */
const STRUCTURAL_KEYS = new Set(['traceId', 'requestId', 'sessionId', 'organizationId', 'channel', 'at']);

/** Recursively redacts every free-text string in a trace before it is stored. */
export function redactTrace(trace: AgentTrace): AgentTrace {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redact(v, 200);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const structural = Object.fromEntries([...STRUCTURAL_KEYS].map((k) => [k, trace[k as keyof AgentTrace]]));
  return { ...(walk(trace) as AgentTrace), ...structural, inputPreview: redact(trace.inputPreview, 120) };
}

export class MemoryTraceRecorder implements TraceRecorder {
  readonly traces: AgentTrace[] = [];
  record(trace: AgentTrace): void {
    this.traces.push(redactTrace(trace));
  }
  recent(limit = 50): AgentTrace[] {
    return this.traces.slice(-limit).reverse();
  }
}

export const AGENT_TRACE_FILE = 'agent-traces.jsonl';

/** Append-only JSONL in the (gitignored) data directory. Never throws into a call. */
export class FileTraceRecorder implements TraceRecorder {
  private readonly file: string;
  constructor(dataDir: string) {
    this.file = path.join(dataDir, AGENT_TRACE_FILE);
  }
  record(trace: AgentTrace): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, `${JSON.stringify(redactTrace(trace))}\n`, { encoding: 'utf-8', mode: 0o600 });
    } catch {
      /* tracing must never break a request */
    }
  }
  recent(limit = 50): AgentTrace[] {
    return readTraces(path.dirname(this.file), limit);
  }
}

/** Last `limit` traces, newest first. Tolerates a missing or partially written file. */
export function readTraces(dataDir: string, limit = 50): AgentTrace[] {
  const file = path.join(dataDir, AGENT_TRACE_FILE);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean).slice(-limit);
  const out: AgentTrace[] = [];
  for (const line of lines.reverse()) {
    try {
      out.push(JSON.parse(line) as AgentTrace);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}
