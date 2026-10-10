import fs from 'node:fs';
import path from 'node:path';
import { ActionRecordSchema, ActionEventSchema, type ActionRecord, type ActionEvent } from '../actions/types.js';
import { VoiceSessionSchema, VoiceEventSchema, type VoiceSession, type VoiceEvent } from '../voice/types.js';

/**
 * Read-only loaders for the files the existing stores persist.
 *
 * The dashboard never writes to these files. Unlike the store classes, these
 * loaders do not create the data directory and tolerate individual malformed
 * records so a single bad line cannot blank the whole Command Center.
 */

export interface TriageRunEntry {
  timestamp: string;
  mode?: 'live' | 'dry-run';
  messageId: string;
  threadId?: string;
  from: string;
  subject: string;
  classification: {
    category?: string;
    priority?: 'high' | 'medium' | 'low';
    requiresResponse?: boolean;
    summary?: string;
    customerName?: string | null;
    eventType?: string | null;
    eventDate?: string | null;
    location?: string | null;
    missingInformation?: string[];
    draftReply?: string | null;
    confidence?: number;
  } | null;
  decision: string;
  draftId?: string | null;
  actionId?: string | null;
}

export interface CleanupPlanSummary {
  id: string;
  createdAt: string;
  status: string;
  query: string;
  candidateCount: number;
}

export interface CleanupPlanEvent {
  eventId: string;
  planId: string;
  timestamp: string;
  fromStatus: string | null;
  toStatus: string;
  actor: string;
  reason?: string;
}

export interface RawSnapshot {
  actions: ActionRecord[];
  actionEvents: ActionEvent[];
  sessions: VoiceSession[];
  voiceEvents: VoiceEvent[];
  runs: TriageRunEntry[];
  plans: CleanupPlanSummary[];
  planEvents: CleanupPlanEvent[];
}

export const DATA_FILES = {
  actions: 'actions.json',
  actionEvents: 'action-events.jsonl',
  sessions: 'voice-sessions.json',
  voiceEvents: 'voice-events.jsonl',
  runs: 'runs.jsonl',
  plans: 'mailbox-cleanup-plans.json',
  planEvents: 'mailbox-cleanup-events.jsonl',
} as const;

function readJsonArray(filePath: string): unknown[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf-8');
  if (!raw.trim()) return [];
  const parsed: unknown = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function readJsonLines(filePath: string): unknown[] {
  if (!fs.existsSync(filePath)) return [];
  const out: unknown[] = [];
  for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A partially-written trailing line is skipped, not fatal.
    }
  }
  return out;
}

function keepValid<T>(items: unknown[], parse: (item: unknown) => T | null): T[] {
  const out: T[] = [];
  for (const item of items) {
    const parsed = parse(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function loadSnapshot(dataDir: string): RawSnapshot {
  const file = (name: string) => path.join(dataDir, name);

  const actions = keepValid(readJsonArray(file(DATA_FILES.actions)), (item) => {
    const r = ActionRecordSchema.safeParse(item);
    return r.success ? r.data : null;
  });
  const actionEvents = keepValid(readJsonLines(file(DATA_FILES.actionEvents)), (item) => {
    const r = ActionEventSchema.safeParse(item);
    return r.success ? r.data : null;
  });
  const sessions = keepValid(readJsonArray(file(DATA_FILES.sessions)), (item) => {
    const r = VoiceSessionSchema.safeParse(item);
    return r.success ? r.data : null;
  });
  const voiceEvents = keepValid(readJsonLines(file(DATA_FILES.voiceEvents)), (item) => {
    const r = VoiceEventSchema.safeParse(item);
    return r.success ? r.data : null;
  });
  const runs = keepValid(readJsonLines(file(DATA_FILES.runs)), (item) => {
    if (!isRecord(item)) return null;
    if (typeof item.messageId !== 'string' || typeof item.timestamp !== 'string') return null;
    return {
      ...(item as unknown as TriageRunEntry),
      from: typeof item.from === 'string' ? item.from : '',
      subject: typeof item.subject === 'string' ? item.subject : '',
      decision: typeof item.decision === 'string' ? item.decision : '',
      classification: isRecord(item.classification)
        ? (item.classification as TriageRunEntry['classification'])
        : null,
    };
  });
  const plans = keepValid(readJsonArray(file(DATA_FILES.plans)), (item) => {
    if (!isRecord(item) || typeof item.id !== 'string') return null;
    return {
      id: item.id,
      createdAt: String(item.createdAt ?? ''),
      status: String(item.status ?? ''),
      query: String(item.query ?? ''),
      candidateCount: typeof item.candidateCount === 'number' ? item.candidateCount : 0,
    };
  });
  const planEvents = keepValid(readJsonLines(file(DATA_FILES.planEvents)), (item) => {
    if (!isRecord(item) || typeof item.planId !== 'string' || typeof item.timestamp !== 'string') {
      return null;
    }
    return {
      eventId: String(item.eventId ?? `${item.planId}_${item.timestamp}`),
      planId: item.planId,
      timestamp: item.timestamp,
      fromStatus: typeof item.fromStatus === 'string' ? item.fromStatus : null,
      toStatus: String(item.toStatus ?? ''),
      actor: String(item.actor ?? 'system'),
      reason: typeof item.reason === 'string' ? item.reason : undefined,
    };
  });

  return { actions, actionEvents, sessions, voiceEvents, runs, plans, planEvents };
}

/**
 * Cheap change fingerprint so the server can reuse a built read model until a file changes.
 */
export function snapshotFingerprint(dataDir: string): string {
  return Object.values(DATA_FILES)
    .map((name) => {
      try {
        const stat = fs.statSync(path.join(dataDir, name));
        return `${name}:${stat.mtimeMs}:${stat.size}`;
      } catch {
        return `${name}:-`;
      }
    })
    .join('|');
}
