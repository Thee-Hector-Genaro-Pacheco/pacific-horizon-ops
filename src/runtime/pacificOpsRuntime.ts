import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Canonical Pacific Ops runtime model.
 *
 * This is the single, observational description of what Pacific Ops is doing right
 * now. The voice process writes it; the Command Center reads it. It is never an
 * input to business logic: nothing in the action / approval / execution path reads
 * this state, so a presence event can never authorize, approve or send anything.
 *
 * Transport between processes reuses the existing local-store pattern: an atomic
 * current-state file plus an append-only event log in the runtime data directory,
 * which the read-only dashboard server watches and streams over SSE.
 */

export const PACIFIC_OPS_RUNTIME_STATES = [
  'idle',
  'listening',
  'thinking',
  'speaking',
  'awaiting_approval',
  'executing',
  'success',
  'error',
] as const;

export type PacificOpsRuntimeState = (typeof PACIFIC_OPS_RUNTIME_STATES)[number];

/** What produced the event. */
export type RuntimeSource = 'voice' | 'executor' | 'system';

/** Coarse operation the session is engaged in; display-only. */
export type RuntimeOperation =
  | 'call'
  | 'mailbox_review'
  | 'message_review'
  | 'draft_review'
  | 'approval'
  | 'send_email'
  | 'wrap_up';

/** Display-safe context. Sender display name and subject only: no addresses, bodies or IDs. */
export interface RuntimeContext {
  senderName?: string;
  subject?: string;
}

export interface PacificOpsRuntimeEvent {
  eventId: string;
  /** Monotonic per writer process start; lets readers ignore out-of-order writes. */
  seq: number;
  state: PacificOpsRuntimeState;
  /** Voice session the event belongs to, or null for gateway-level events. */
  sessionId: string | null;
  /** True while a voice session is connected. */
  sessionActive: boolean;
  at: string;
  source: RuntimeSource;
  operation: RuntimeOperation | null;
  /** Human-facing task label, e.g. "Reviewing mailbox". */
  task: string | null;
  /** One display-safe sentence describing the moment. */
  status: string;
  context: RuntimeContext | null;
}

export const RUNTIME_FILES = {
  state: 'pacific-ops-runtime.json',
  events: 'pacific-ops-runtime-events.jsonl',
} as const;

const MAX_SUBJECT = 80;
const MAX_NAME = 48;

export function isRuntimeState(value: unknown): value is PacificOpsRuntimeState {
  return typeof value === 'string' && (PACIFIC_OPS_RUNTIME_STATES as readonly string[]).includes(value);
}

/** Strips anything that looks like an email address or phone number and bounds length. */
export function safeText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value
    .replace(/[^\s<>()]+@[^\s<>()]+/g, '')
    .replace(/\+?\d[\d\s().-]{8,}\d/g, '')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return undefined;
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

export function safeContext(input: { senderName?: unknown; subject?: unknown } | null | undefined): RuntimeContext | null {
  if (!input) return null;
  const senderName = safeText(input.senderName, MAX_NAME);
  const subject = safeText(input.subject, MAX_SUBJECT);
  if (!senderName && !subject) return null;
  return { ...(senderName ? { senderName } : {}), ...(subject ? { subject } : {}) };
}

/**
 * Estimated time for ConversationRelay to synthesize and play `text`.
 *
 * ConversationRelay does not report when playback finishes, so this estimate is the
 * only available signal. The voice server already uses the same formula to delay the
 * end-of-call message; sharing it keeps both behaviours consistent.
 */
export function estimatePlaybackMs(text: string): number {
  return Math.max(3500, Math.min(8000, text.length * 60));
}

export interface RuntimeStoreOptions {
  dataDir: string;
  now?: () => number;
}

/** Writer side: owned by the voice process. */
export class PacificOpsRuntimeStore {
  private readonly dataDir: string;
  private readonly now: () => number;
  private seq = 0;

  constructor(options: RuntimeStoreOptions) {
    this.dataDir = options.dataDir;
    this.now = options.now ?? Date.now;
  }

  get statePath(): string {
    return path.join(this.dataDir, RUNTIME_FILES.state);
  }

  get eventsPath(): string {
    return path.join(this.dataDir, RUNTIME_FILES.events);
  }

  publish(input: Omit<PacificOpsRuntimeEvent, 'eventId' | 'seq' | 'at'>): PacificOpsRuntimeEvent {
    const event: PacificOpsRuntimeEvent = {
      eventId: crypto.randomUUID(),
      seq: ++this.seq,
      at: new Date(this.now()).toISOString(),
      ...input,
      context: safeContext(input.context),
      status: safeText(input.status, 140) ?? '',
      task: input.task ? (safeText(input.task, 60) ?? null) : null,
    };
    if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = path.join(this.dataDir, `${RUNTIME_FILES.state}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`);
    fs.writeFileSync(tmp, JSON.stringify(event, null, 2), 'utf-8');
    fs.renameSync(tmp, this.statePath);
    fs.appendFileSync(this.eventsPath, `${JSON.stringify(event)}\n`, 'utf-8');
    return event;
  }

  read(): PacificOpsRuntimeEvent | null {
    return readRuntimeState(this.dataDir);
  }
}

/** Reader side: tolerant of a missing or partially written file. */
export function readRuntimeState(dataDir: string): PacificOpsRuntimeEvent | null {
  const file = path.join(dataDir, RUNTIME_FILES.state);
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<PacificOpsRuntimeEvent>;
    if (!isRuntimeState(parsed.state) || typeof parsed.at !== 'string') return null;
    return {
      eventId: String(parsed.eventId ?? ''),
      seq: Number(parsed.seq ?? 0),
      state: parsed.state,
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
      sessionActive: parsed.sessionActive === true,
      at: parsed.at,
      source: parsed.source === 'executor' || parsed.source === 'system' ? parsed.source : 'voice',
      operation: (parsed.operation ?? null) as RuntimeOperation | null,
      task: typeof parsed.task === 'string' ? parsed.task : null,
      status: typeof parsed.status === 'string' ? parsed.status : '',
      context: safeContext(parsed.context ?? null),
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Read-side resolution: what the Command Center should show            */
/* ------------------------------------------------------------------ */

/** Success / error are moments, not resting states. */
export const OUTCOME_HOLD_MS = 20_000;
/** An in-call state with no new event for this long is treated as stale (e.g. a crashed process). */
export const ACTIVE_STALE_MS = 10 * 60_000;

export interface ResolvedRuntimeState {
  state: PacificOpsRuntimeState;
  sessionActive: boolean;
  sessionId: string | null;
  operation: RuntimeOperation | null;
  task: string | null;
  status: string;
  context: RuntimeContext | null;
  /** Timestamp of the underlying event, or null when no runtime has ever been written. */
  at: string | null;
  /** Why the shown state differs from the raw event, if it does. */
  settledBy: 'none' | 'outcome_elapsed' | 'stale' | 'gateway_offline' | 'no_runtime';
  voiceGateway: 'online' | 'offline' | 'unknown';
}

/**
 * Turns the last written event into what should be displayed now. Pure, so it can be
 * tested and re-evaluated on a timer without new writes.
 */
export function resolveRuntimeState(
  event: PacificOpsRuntimeEvent | null,
  opts: { now: number; voiceGateway: 'online' | 'offline' | 'unknown' }
): ResolvedRuntimeState {
  const idle = (settledBy: ResolvedRuntimeState['settledBy'], status: string): ResolvedRuntimeState => ({
    state: 'idle',
    sessionActive: false,
    sessionId: null,
    operation: null,
    task: null,
    status,
    context: null,
    at: event?.at ?? null,
    settledBy,
    voiceGateway: opts.voiceGateway,
  });

  if (!event) return idle('no_runtime', 'No voice session yet');

  const age = opts.now - new Date(event.at).getTime();
  const live = event.state !== 'idle' && event.state !== 'success' && event.state !== 'error';

  // A voice process that is not running cannot be listening, speaking or executing.
  if (opts.voiceGateway === 'offline' && (live || event.sessionActive)) return idle('gateway_offline', 'Voice gateway offline');
  if ((event.state === 'success' || event.state === 'error') && age > OUTCOME_HOLD_MS) return idle('outcome_elapsed', 'Standing by');
  if (live && age > ACTIVE_STALE_MS) return idle('stale', 'No recent voice activity');

  return {
    state: event.state,
    sessionActive: event.sessionActive,
    sessionId: event.sessionId,
    operation: event.operation,
    task: event.task,
    status: event.status,
    context: event.context,
    at: event.at,
    settledBy: 'none',
    voiceGateway: opts.voiceGateway,
  };
}
