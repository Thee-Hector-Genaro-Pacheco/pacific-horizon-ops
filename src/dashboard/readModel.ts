import crypto from 'node:crypto';
import type { ActionRecord, ActionEvent } from '../actions/types.js';
import { maskPhoneNumber, maskPhoneNumbersInText, type VoiceSession, type VoiceEvent } from '../voice/types.js';
import type { RawSnapshot, TriageRunEntry } from './sources.js';
import type {
  ActionDTO,
  ActionStatusDTO,
  ActivityDTO,
  ActivityKind,
  AnalyticsDTO,
  CallDTO,
  CommandCenterDTO,
  ContactRef,
  CustomerDTO,
  InboxItemDTO,
  InboxStatus,
  LeadDTO,
  LeadStage,
  PacificOpsState,
  PresenceDTO,
  SeriesPoint,
  TimelineEventDTO,
  Tone,
} from './types.js';

/**
 * Pure projection from raw store records to dashboard DTOs.
 *
 * Everything that leaves this module is sanitized: Gmail message/thread/draft IDs
 * are replaced by opaque hashes, call SIDs are dropped and phone numbers masked.
 */

export interface ReadModelOptions {
  now?: number;
  /** Owner mailbox addresses; mail from these (without a named customer) is treated as internal. */
  ownerEmails?: string[];
}

const PUBLIC_MAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'me.com', 'proton.me']);

export function ownerMatcher(ownerEmails: string[] = []): (email: string | null) => boolean {
  const emails = new Set(ownerEmails.map((e) => e.trim().toLowerCase()).filter(Boolean));
  const domains = new Set(
    [...emails].map((e) => e.split('@')[1]).filter((d): d is string => !!d && !PUBLIC_MAIL_DOMAINS.has(d))
  );
  return (email) => {
    if (!email) return false;
    const lower = email.toLowerCase();
    return emails.has(lower) || domains.has(lower.split('@')[1] ?? '');
  };
}

export interface ReadModel {
  inbox: InboxItemDTO[];
  actions: ActionDTO[];
  calls: CallDTO[];
  activity: ActivityDTO[];
  leads: LeadDTO[];
  customers: CustomerDTO[];
  commandCenter: CommandCenterDTO;
  analytics: AnalyticsDTO;
}

const LEAD_CATEGORIES = new Set([
  'booking_inquiry',
  'quote_followup',
  'event_logistics',
  'reschedule_or_cancel',
  'payment',
  'post_event',
]);

const AUTOMATED_CATEGORIES = new Set(['system_notification', 'vendor_or_marketing']);
const AUTOMATED_SENDER = /(no-?reply|notifications?|notify|mailer-daemon|postmaster|newsletter|workspace-noreply)@/i;

const LIVE_CALL_WINDOW_MS = 10 * 60 * 1000;
const STALE_CALL_MS = 30 * 60 * 1000;
const SUCCESS_WINDOW_MS = 3 * 60 * 1000;
const ERROR_WINDOW_MS = 15 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* Text + identity helpers                                              */
/* ------------------------------------------------------------------ */

export function opaqueId(prefix: string, raw: string): string {
  return `${prefix}_${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12)}`;
}

export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * Strips internal identifiers from free-text audit reasons and masks phone numbers.
 */
export function sanitizeText(text: string | null | undefined): string | null {
  if (!text) return null;
  const cleaned = maskPhoneNumbersInText(
    decodeEntities(text)
      .replace(/\s*\((?:draftId|messageId|threadId|actionId|callSid)[^)]*\)/gi, '')
      .replace(/\b(?:draftId|messageId|threadId|callSid)[:=]\s*\S+/gi, '')
      .replace(/\bCA[0-9a-f]{32}\b/gi, '[call]')
      .replace(/\bact_\d+_[0-9a-f]+\b/g, '[action]')
      .replace(/\bvses_\d+_[0-9a-f]+\b/g, '[session]')
  )
    .replace(/\s{2,}/g, ' ')
    .trim();
  return cleaned || null;
}

export function parseSender(from: string): { name: string; email: string | null } {
  const raw = decodeEntities((from || '').trim());
  const angle = raw.match(/^"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  if (angle) {
    const email = angle[2].trim().toLowerCase();
    const name = angle[1].trim() || email.split('@')[0];
    return { name, email };
  }
  if (raw.includes('@')) {
    const email = raw.toLowerCase();
    return { name: email.split('@')[0], email };
  }
  return { name: raw || 'Unknown sender', email: null };
}

function contactFor(from: string, customerName?: string | null): ContactRef {
  const sender = parseSender(from);
  const name = customerName?.trim() || sender.name;
  // Customer name wins over sender address: one mailbox can relay several customers.
  const keySource = customerName?.trim()
    ? `name:${customerName.trim().toLowerCase()}`
    : sender.email
      ? `email:${sender.email}`
      : `name:${sender.name.toLowerCase()}`;
  return { name, email: sender.email, key: opaqueId('c', keySource) };
}

function snippetOf(text: string | null | undefined, max = 280): string | null {
  if (!text) return null;
  const flat = decodeEntities(text).replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return maskPhoneNumbersInText(flat.length > max ? `${flat.slice(0, max - 1)}…` : flat);
}

function toIso(value: string | number | undefined | null): string | null {
  if (value === undefined || value === null || value === '') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function ms(iso: string | null | undefined): number {
  return iso ? new Date(iso).getTime() : 0;
}

function byNewest<T>(get: (item: T) => string | null | undefined) {
  return (a: T, b: T) => ms(get(b)) - ms(get(a));
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function isAutomated(category: string | null, email: string | null): boolean {
  if (category && AUTOMATED_CATEGORIES.has(category)) return true;
  return !!email && AUTOMATED_SENDER.test(email);
}

/* ------------------------------------------------------------------ */
/* Actor + event vocabulary                                             */
/* ------------------------------------------------------------------ */

export function describeActor(actor: string): string {
  if (actor === 'system') return 'Pacific Ops';
  if (actor === 'system:claude') return 'Classifier';
  if (actor === 'system:gmail') return 'Gmail';
  if (actor === 'system:voice') return 'Voice gateway';
  if (actor === 'voice:agent') return 'Pacific Ops · voice';
  if (actor.startsWith('voice:')) return 'Owner · voice';
  if (actor.startsWith('cli:')) return 'Owner · CLI';
  if (actor.startsWith('dashboard:')) return 'Owner · dashboard';
  if (actor.startsWith('system:')) return 'Pacific Ops';
  return 'Operator';
}

const ACTION_EVENT_MAP: Record<ActionStatusDTO, { kind: ActivityKind; title: string; tone: Tone }> = {
  RECEIVED: { kind: 'email_received', title: 'Email received', tone: 'neutral' },
  CLASSIFIED: { kind: 'email_classified', title: 'Email classified', tone: 'neutral' },
  DRAFTED: { kind: 'draft_generated', title: 'Reply drafted', tone: 'info' },
  AWAITING_APPROVAL: { kind: 'approval_requested', title: 'Approval requested', tone: 'attention' },
  APPROVED: { kind: 'approval_confirmed', title: 'Approval confirmed', tone: 'success' },
  REJECTED: { kind: 'approval_rejected', title: 'Draft rejected', tone: 'neutral' },
  EXECUTING: { kind: 'execution_started', title: 'Gmail send executing', tone: 'info' },
  SENT: { kind: 'email_sent', title: 'Email sent', tone: 'success' },
  EXECUTED: { kind: 'email_sent', title: 'Action completed', tone: 'success' },
  EXECUTION_FAILED: { kind: 'execution_failed', title: 'Execution failed', tone: 'failure' },
  FAILED: { kind: 'execution_failed', title: 'Action failed', tone: 'failure' },
};

function actionEventToTimeline(event: ActionEvent): TimelineEventDTO {
  const meta = ACTION_EVENT_MAP[event.toStatus];
  let title = meta.title;
  if (event.toStatus === 'APPROVED') {
    const src = event.actor.split(':')[0];
    title = src === 'voice' ? 'Owner approved via voice' : src === 'cli' ? 'Owner approved via CLI' : 'Approval confirmed';
  }
  return {
    id: event.eventId,
    at: event.timestamp,
    kind: meta.kind,
    title,
    detail: sanitizeText(event.reason),
    actor: describeActor(event.actor),
    tone: meta.tone,
  };
}

function voiceEventToActivity(event: VoiceEvent, subject: string | null): ActivityDTO | null {
  const statusChanged = event.fromStatus !== event.toStatus;
  let kind: ActivityKind;
  let title: string;
  let tone: Tone = 'neutral';

  if (statusChanged) {
    switch (event.toStatus) {
      case 'CALL_REQUESTED':
        kind = 'call_initiated';
        title = 'Voice call initiated';
        tone = 'info';
        break;
      case 'CONNECTED':
        kind = 'call_connected';
        title = 'Voice link connected';
        tone = 'info';
        break;
      case 'COMPLETED':
        kind = 'call_completed';
        title = 'Voice call completed';
        break;
      case 'FAILED':
        kind = 'call_failed';
        title = 'Voice call failed';
        tone = 'failure';
        break;
      default:
        return null;
    }
  } else {
    if (!event.reason) return null;
    kind = 'voice_turn';
    title = sanitizeText(event.reason) ?? 'Voice conversation update';
    tone = /approv/i.test(event.reason) ? 'attention' : 'neutral';
    if (/sent successfully/i.test(event.reason)) tone = 'success';
  }

  return {
    id: event.eventId,
    at: event.timestamp,
    kind,
    title,
    detail: kind === 'voice_turn' ? null : sanitizeText(event.reason),
    actor: describeActor(event.actor),
    tone,
    subject,
    ref: { type: 'call', id: event.sessionId },
  };
}

/* ------------------------------------------------------------------ */
/* Inbox                                                                */
/* ------------------------------------------------------------------ */

function actionStatusToInbox(status: ActionStatusDTO): InboxStatus {
  switch (status) {
    case 'RECEIVED':
      return 'NEW';
    case 'CLASSIFIED':
      return 'REVIEWED';
    case 'DRAFTED':
      return 'DRAFTED';
    case 'AWAITING_APPROVAL':
      return 'AWAITING_APPROVAL';
    case 'APPROVED':
      return 'APPROVED';
    case 'EXECUTING':
      return 'EXECUTING';
    case 'SENT':
    case 'EXECUTED':
      return 'SENT';
    case 'REJECTED':
      return 'REJECTED';
    case 'EXECUTION_FAILED':
    case 'FAILED':
      return 'FAILED';
  }
}

interface InboxAccumulator {
  messageId: string;
  from: string;
  subject: string;
  receivedAt: string | null;
  snippet: string | null;
  run: TriageRunEntry | null;
  voiceSelected: boolean;
  voiceSeen: boolean;
  callIds: Set<string>;
}

interface VoiceMailboxMessage {
  messageId?: string;
  from?: string;
  senderName?: string;
  subject?: string;
  date?: string;
  internalDate?: number;
  body?: string;
  snippet?: string;
}

function voiceMessages(session: VoiceSession): VoiceMailboxMessage[] {
  const list = session.metadata?.availableMessages;
  return Array.isArray(list) ? (list as VoiceMailboxMessage[]) : [];
}

function selectedVoiceMessage(session: VoiceSession): VoiceMailboxMessage | null {
  const sel = session.metadata?.selectedMessage;
  return sel && typeof sel === 'object' ? (sel as VoiceMailboxMessage) : null;
}

function boundActionId(session: VoiceSession): string | null {
  if (session.actionId && session.actionId !== 'mailbox') return session.actionId;
  const bound = session.metadata?.boundActionId;
  return typeof bound === 'string' ? bound : null;
}

function buildInbox(
  snapshot: RawSnapshot,
  actionsByMessage: Map<string, ActionRecord>,
  isOwner: (email: string | null) => boolean
): InboxItemDTO[] {
  const acc = new Map<string, InboxAccumulator>();
  const get = (messageId: string): InboxAccumulator => {
    let entry = acc.get(messageId);
    if (!entry) {
      entry = {
        messageId,
        from: '',
        subject: '',
        receivedAt: null,
        snippet: null,
        run: null,
        voiceSelected: false,
        voiceSeen: false,
        callIds: new Set(),
      };
      acc.set(messageId, entry);
    }
    return entry;
  };

  // Triage runs: later live runs override earlier dry runs for the same message.
  const runs = [...snapshot.runs].sort((a, b) => ms(a.timestamp) - ms(b.timestamp));
  for (const run of runs) {
    const entry = get(run.messageId);
    const isLive = run.mode !== 'dry-run';
    if (!entry.run || isLive || entry.run.mode === 'dry-run') {
      entry.run = run;
    }
    entry.from ||= run.from;
    entry.subject ||= run.subject;
    entry.receivedAt ??= toIso(run.timestamp);
  }

  // Voice mailbox snapshots carry the real received time and a body excerpt.
  for (const session of snapshot.sessions) {
    const selected = selectedVoiceMessage(session);
    for (const msg of voiceMessages(session)) {
      if (!msg.messageId) continue;
      const entry = get(msg.messageId);
      entry.voiceSeen = true;
      entry.callIds.add(session.sessionId);
      entry.from = msg.from || entry.from;
      entry.subject = msg.subject || entry.subject;
      const received = toIso(msg.internalDate ?? msg.date ?? null);
      if (received) entry.receivedAt = received;
      entry.snippet = snippetOf(msg.body || msg.snippet) ?? entry.snippet;
      if (selected?.messageId === msg.messageId) entry.voiceSelected = true;
    }
  }

  for (const action of snapshot.actions) {
    if (!action.messageId) continue;
    const entry = get(action.messageId);
    entry.from ||= action.from;
    entry.subject ||= action.subject;
    entry.receivedAt ??= action.createdAt;
  }

  const items: InboxItemDTO[] = [];
  for (const entry of acc.values()) {
    const action = actionsByMessage.get(entry.messageId) ?? null;
    const c = entry.run?.classification ?? null;
    const sender = contactFor(entry.from, c?.customerName);
    const category = c?.category ?? action?.classificationCategory ?? null;

    let status: InboxStatus;
    if (action) {
      status = actionStatusToInbox(action.status);
    } else if (entry.run) {
      status = /^skipped/i.test(entry.run.decision) && entry.run.mode !== 'dry-run' ? 'SKIPPED' : 'REVIEWED';
      if (entry.run.decision.startsWith('failed')) status = 'FAILED';
    } else {
      status = entry.voiceSelected ? 'REVIEWED' : 'NEW';
    }

    const observedIn: InboxItemDTO['observedIn'] = [];
    if (entry.run) observedIn.push('triage');
    if (entry.voiceSeen) observedIn.push('voice_review');
    if (action) observedIn.push('action');

    if (action) {
      for (const session of snapshot.sessions) {
        if (boundActionId(session) === action.actionId) entry.callIds.add(session.sessionId);
      }
    }

    items.push({
      id: opaqueId('msg', entry.messageId),
      sender,
      subject: decodeEntities(entry.subject || '(no subject)'),
      receivedAt: entry.receivedAt ?? new Date(0).toISOString(),
      snippet: entry.snippet,
      summary: sanitizeText(c?.summary),
      category,
      priority: c?.priority ?? null,
      status,
      reviewed: !!entry.run || entry.voiceSelected || !!action,
      hasDraft: !!action?.draftId || !!entry.run?.draftId,
      approvalRequired: action?.status === 'AWAITING_APPROVAL',
      responded: action?.status === 'SENT' || action?.status === 'EXECUTED',
      requiresResponse: c?.requiresResponse ?? (action ? true : null),
      actionId: action?.actionId ?? null,
      callIds: [...entry.callIds],
      event:
        c && (c.eventType || c.eventDate || c.location)
          ? { type: c.eventType ?? null, date: c.eventDate ?? null, location: c.location ?? null }
          : null,
      missingInformation: Array.isArray(c?.missingInformation) ? c!.missingInformation! : [],
      fromOwner: !c?.customerName && isOwner(sender.email),
      observedIn,
    });
  }

  return items.sort(byNewest((i) => i.receivedAt));
}

/* ------------------------------------------------------------------ */
/* Actions                                                              */
/* ------------------------------------------------------------------ */

function buildActions(
  snapshot: RawSnapshot,
  eventsByAction: Map<string, ActionEvent[]>,
  inboxByMessage: Map<string, InboxItemDTO>
): ActionDTO[] {
  return snapshot.actions
    .map((action): ActionDTO => {
      const events = (eventsByAction.get(action.actionId) ?? []).sort((a, b) => ms(a.timestamp) - ms(b.timestamp));
      const sentEvent = events.find((e) => e.toStatus === 'SENT' || e.toStatus === 'EXECUTED');
      const inboxItem = inboxByMessage.get(action.messageId);
      const payload = action.proposedAction.payload as Record<string, unknown>;
      const body = typeof payload.draftReply === 'string' ? payload.draftReply : null;

      return {
        id: action.actionId,
        status: action.status,
        type: action.actionType,
        category: action.classificationCategory,
        confidence: action.confidence,
        subject: decodeEntities(action.subject),
        contact: inboxItem?.sender ?? contactFor(action.from),
        createdAt: action.createdAt,
        updatedAt: action.updatedAt,
        proposal: {
          description: action.status === 'SENT' ? 'Reply sent from the approved Gmail draft' : 'Send the drafted reply from the business Gmail account',
          body: body ? maskPhoneNumbersInText(body) : null,
        },
        hasDraft: !!action.draftId,
        approval: action.approvalMetadata
          ? {
              decision: action.approvalMetadata.decision,
              source: action.approvalMetadata.approvalSource,
              by: action.approvalMetadata.approvalSource === 'voice' ? 'Owner (voice)' : action.approvalMetadata.approvedBy,
              at: action.approvalMetadata.approvedAt,
            }
          : null,
        sentAt: sentEvent?.timestamp ?? action.executionMetadata?.executedAt ?? null,
        failureReason: sanitizeText(action.failureReason),
        timeline: events.map(actionEventToTimeline),
        callIds: snapshot.sessions.filter((s) => boundActionId(s) === action.actionId).map((s) => s.sessionId),
      };
    })
    .sort(byNewest((a) => a.updatedAt));
}

/* ------------------------------------------------------------------ */
/* Calls                                                                */
/* ------------------------------------------------------------------ */

function buildCalls(snapshot: RawSnapshot, actionsById: Map<string, ActionRecord>, now: number): CallDTO[] {
  const eventsBySession = new Map<string, VoiceEvent[]>();
  for (const e of snapshot.voiceEvents) {
    const list = eventsBySession.get(e.sessionId) ?? [];
    list.push(e);
    eventsBySession.set(e.sessionId, list);
  }

  return snapshot.sessions
    .map((session): CallDTO => {
      const events = (eventsBySession.get(session.sessionId) ?? []).sort((a, b) => ms(a.timestamp) - ms(b.timestamp));
      const terminal = session.status === 'COMPLETED' || session.status === 'FAILED';
      const connected =
        session.transcript.length > 0 ||
        events.some((e) => e.toStatus === 'CONNECTED' || e.toStatus === 'ACTIVE');
      const firstConnect = events.find((e) => e.toStatus === 'CONNECTED' || e.toStatus === 'ACTIVE');
      const endedAt = terminal ? session.completedAt ?? session.updatedAt : null;
      const startForDuration = firstConnect?.timestamp ?? session.createdAt;
      const durationSec =
        endedAt && connected ? Math.max(0, Math.round((ms(endedAt) - ms(startForDuration)) / 1000)) : null;
      const stale = !terminal && now - ms(session.updatedAt) > STALE_CALL_MS;

      const actionId = boundActionId(session);
      const action = actionId ? actionsById.get(actionId) ?? null : null;

      let approvalResult: CallDTO['approvalResult'] = null;
      if (action?.approvalMetadata?.approvalSource === 'voice') {
        const at = ms(action.approvalMetadata.approvedAt);
        // Unfinished sessions only claim approvals recorded while they were still updating.
        const windowEnd = (endedAt ? ms(endedAt) : ms(session.updatedAt)) + 60_000;
        if (at >= ms(session.createdAt) && at <= windowEnd) {
          approvalResult = action.approvalMetadata.decision;
        }
      }

      let outcome: string;
      let tone: Tone;
      if (session.status === 'FAILED') {
        outcome = 'Call failed';
        tone = 'failure';
      } else if (stale) {
        outcome = connected ? 'No completion received' : 'Never connected';
        tone = 'neutral';
      } else if (!terminal) {
        outcome = 'In progress';
        tone = 'info';
      } else if (approvalResult === 'approved') {
        outcome = action?.status === 'SENT' || action?.status === 'EXECUTED' ? 'Approved · email sent' : 'Approved';
        tone = 'success';
      } else if (approvalResult === 'rejected') {
        outcome = 'Draft rejected';
        tone = 'neutral';
      } else if (session.transcript.some((t) => t.role === 'user')) {
        outcome = 'Reviewed · no decision';
        tone = 'neutral';
      } else {
        outcome = connected ? 'Ended before review' : 'Not answered';
        tone = 'neutral';
      }

      const selected = selectedVoiceMessage(session);
      const isMailbox = session.actionId === 'mailbox' || session.metadata?.mode === 'mailbox';

      return {
        id: session.sessionId,
        direction: 'outbound',
        mode: isMailbox ? 'mailbox_review' : 'action_review',
        contact: { name: 'Owner', phoneMasked: maskPhoneNumber(session.toPhone) },
        status: session.status,
        conversationState: session.conversationState,
        startedAt: session.createdAt,
        endedAt,
        durationSec,
        relay: connected ? 'connected' : terminal || stale ? 'not_connected' : 'unknown',
        outcome,
        tone,
        approvalResult,
        action: action ? { id: action.actionId, subject: decodeEntities(action.subject), status: action.status } : null,
        selectedMessage: selected
          ? {
              sender: selected.senderName || parseSender(selected.from ?? '').name,
              subject: decodeEntities(selected.subject ?? ''),
            }
          : null,
        error: sanitizeText(session.error),
        transcript: session.transcript.map((t) => ({
          role: t.role,
          text: sanitizeText(t.text) ?? '',
          at: t.timestamp,
        })),
        stale,
      };
    })
    .sort(byNewest((c) => c.startedAt));
}

/* ------------------------------------------------------------------ */
/* Activity                                                             */
/* ------------------------------------------------------------------ */

function buildActivity(snapshot: RawSnapshot, actionsById: Map<string, ActionRecord>): ActivityDTO[] {
  const out: ActivityDTO[] = [];

  for (const event of snapshot.actionEvents) {
    const action = actionsById.get(event.actionId);
    const t = actionEventToTimeline(event);
    out.push({
      ...t,
      subject: action ? decodeEntities(action.subject) : null,
      ref: action ? { type: 'action', id: action.actionId } : null,
    });
  }

  const sessionsById = new Map(snapshot.sessions.map((s) => [s.sessionId, s]));
  for (const event of snapshot.voiceEvents) {
    const session = sessionsById.get(event.sessionId);
    const actionId = session ? boundActionId(session) : null;
    const subject = actionId ? actionsById.get(actionId)?.subject ?? null : null;
    const activity = voiceEventToActivity(event, subject ? decodeEntities(subject) : null);
    if (activity) out.push(activity);
  }

  for (const run of snapshot.runs) {
    if (run.mode === 'dry-run' || run.actionId) continue;
    const skipped = /^skipped/i.test(run.decision);
    out.push({
      id: opaqueId('run', `${run.messageId}:${run.timestamp}`),
      at: run.timestamp,
      kind: 'email_triaged',
      title: skipped ? 'Email triaged · no reply needed' : 'Email triaged',
      detail: sanitizeText(run.classification?.summary ?? run.decision),
      actor: 'Classifier',
      tone: run.decision.startsWith('failed') ? 'failure' : 'neutral',
      subject: decodeEntities(run.subject),
      ref: { type: 'inbox', id: opaqueId('msg', run.messageId) },
    });
  }

  for (const event of snapshot.planEvents) {
    out.push({
      id: event.eventId,
      at: event.timestamp,
      kind: 'mailbox_plan',
      title: `Mailbox cleanup plan · ${event.toStatus.toLowerCase().replace(/_/g, ' ')}`,
      detail: sanitizeText(event.reason),
      actor: describeActor(event.actor),
      tone: event.toStatus === 'FAILED' ? 'failure' : event.toStatus === 'COMPLETED' ? 'success' : 'neutral',
      subject: null,
      ref: { type: 'plan', id: event.planId },
    });
  }

  return out.sort(byNewest((a) => a.at));
}

/* ------------------------------------------------------------------ */
/* Leads + customers                                                    */
/* ------------------------------------------------------------------ */

function deriveStage(actions: ActionDTO[]): { stage: LeadStage; nextAction: string } {
  const statuses = new Set(actions.map((a) => a.status));
  if (statuses.has('SENT') || statuses.has('EXECUTED')) {
    return { stage: 'CONTACTED', nextAction: 'Follow up if no customer reply' };
  }
  if (statuses.has('EXECUTING') || statuses.has('APPROVED')) {
    return { stage: 'QUALIFIED', nextAction: 'Reply approved · awaiting send' };
  }
  if (statuses.has('AWAITING_APPROVAL')) {
    return { stage: 'QUALIFIED', nextAction: 'Approve drafted reply' };
  }
  if (statuses.has('REJECTED')) {
    return { stage: 'QUALIFIED', nextAction: 'Draft rejected · reply manually' };
  }
  return { stage: 'NEW', nextAction: 'Draft a reply' };
}

function buildLeadsAndCustomers(
  inbox: InboxItemDTO[],
  actions: ActionDTO[],
  calls: CallDTO[]
): { leads: LeadDTO[]; customers: CustomerDTO[] } {
  const actionsById = new Map(actions.map((a) => [a.id, a]));
  const callsById = new Map(calls.map((c) => [c.id, c]));
  const groups = new Map<string, InboxItemDTO[]>();

  for (const item of inbox) {
    if (item.fromOwner || isAutomated(item.category, item.sender.email)) continue;
    const list = groups.get(item.sender.key) ?? [];
    list.push(item);
    groups.set(item.sender.key, list);
  }

  const leads: LeadDTO[] = [];
  const customers: CustomerDTO[] = [];

  for (const [key, items] of groups) {
    const sorted = [...items].sort((a, b) => ms(a.receivedAt) - ms(b.receivedAt));
    const latest = sorted[sorted.length - 1];
    const linkedActions = sorted
      .map((i) => (i.actionId ? actionsById.get(i.actionId) : undefined))
      .filter((a): a is ActionDTO => !!a);
    const callIds = [...new Set(sorted.flatMap((i) => i.callIds))];

    const isLead = sorted.some((i) => (i.category && LEAD_CATEGORIES.has(i.category)) || !!i.actionId);
    const withEvent = [...sorted].reverse().find((i) => i.event);

    const timeline: TimelineEventDTO[] = [];
    for (const item of sorted) {
      const action = item.actionId ? actionsById.get(item.actionId) : undefined;
      if (action) {
        timeline.push(...action.timeline.map((t) => ({ ...t, detail: t.kind === 'email_received' ? item.subject : t.detail })));
      } else {
        timeline.push({
          id: `${item.id}_rx`,
          at: item.receivedAt,
          kind: 'email_received',
          title: 'Email received',
          detail: item.subject,
          actor: item.sender.name,
          tone: 'neutral',
        });
        if (item.summary) {
          timeline.push({
            id: `${item.id}_cl`,
            at: item.receivedAt,
            kind: 'email_classified',
            title: 'Pacific Ops classified inquiry',
            detail: item.summary,
            actor: 'Classifier',
            tone: 'neutral',
          });
        }
      }
    }
    for (const callId of callIds) {
      const call = callsById.get(callId);
      if (!call || call.relay !== 'connected') continue;
      timeline.push({
        id: `${callId}_call`,
        at: call.startedAt,
        kind: call.tone === 'failure' ? 'call_failed' : 'call_completed',
        title: call.mode === 'mailbox_review' ? 'Reviewed on owner voice call' : 'Owner voice review call',
        detail: call.outcome,
        actor: 'Pacific Ops · voice',
        tone: call.tone,
      });
    }
    timeline.sort((a, b) => ms(a.at) - ms(b.at));

    const lastContactAt = [latest.receivedAt, ...linkedActions.map((a) => a.sentAt ?? a.updatedAt)]
      .sort((a, b) => ms(b) - ms(a))[0];

    let lead: LeadDTO | null = null;
    if (isLead) {
      const { stage, nextAction } = deriveStage(linkedActions);
      lead = {
        id: opaqueId('lead', key),
        customerId: key,
        name: latest.sender.name,
        email: latest.sender.email,
        phoneMasked: null,
        source: 'email',
        eventType: withEvent?.event?.type ?? null,
        eventDate: withEvent?.event?.date ?? null,
        location: withEvent?.event?.location ?? null,
        guestCount: null,
        stage,
        notes: [...sorted].reverse().find((i) => i.summary)?.summary ?? latest.snippet,
        lastContactAt,
        nextAction,
        inquiryCount: sorted.length,
        actionIds: linkedActions.map((a) => a.id),
        callIds,
        inboxIds: sorted.map((i) => i.id),
        derived: true,
      };
      leads.push(lead);
    }

    customers.push({
      id: key,
      name: latest.sender.name,
      email: latest.sender.email,
      lead,
      firstSeenAt: sorted[0].receivedAt,
      lastSeenAt: lastContactAt,
      messageCount: sorted.length,
      timeline,
    });
  }

  return {
    leads: leads.sort(byNewest((l) => l.lastContactAt)),
    customers: customers.sort(byNewest((c) => c.lastSeenAt)),
  };
}

/* ------------------------------------------------------------------ */
/* Presence                                                             */
/* ------------------------------------------------------------------ */

export function derivePresence(
  actions: ActionDTO[],
  calls: CallDTO[],
  inbox: InboxItemDTO[],
  now: number
): PresenceDTO {
  const liveCall = calls.find(
    (c) => (c.status === 'CONNECTED' || c.status === 'ACTIVE') && !c.stale && now - ms(c.startedAt) < LIVE_CALL_WINDOW_MS * 6
  );
  if (liveCall) {
    let state: PacificOpsState = 'listening';
    let headline = 'Voice link active';
    switch (liveCall.conversationState) {
      case 'GREETING':
      case 'READING_SUMMARY':
      case 'READING_DRAFT':
        state = 'speaking';
        headline = 'Speaking with owner';
        break;
      case 'AWAITING_APPROVAL_CONFIRMATION':
      case 'AWAITING_REJECTION_CONFIRMATION':
        state = 'awaiting_approval';
        headline = 'Awaiting spoken confirmation';
        break;
      case 'COMPLETE':
        state = 'success';
        headline = 'Call wrapping up';
        break;
      default:
        state = 'listening';
        headline = 'Listening';
    }
    // Fine-grained call state (thinking / speaking / executing) comes from the live
    // Pacific Ops runtime stream, not from transcript timing.
    return { state, headline, reason: 'Live owner voice session', since: liveCall.startedAt, liveCallId: liveCall.id };
  }

  const executing = actions.find((a) => a.status === 'EXECUTING');
  if (executing) {
    return {
      state: 'executing',
      headline: 'Executing action',
      reason: `Sending reply · ${executing.subject}`,
      since: executing.updatedAt,
      liveCallId: null,
    };
  }

  const recentFailure = [
    ...actions.filter((a) => a.status === 'FAILED' || a.status === 'EXECUTION_FAILED').map((a) => a.updatedAt),
    ...calls.filter((c) => c.status === 'FAILED').map((c) => c.endedAt ?? c.startedAt),
  ].find((at) => now - ms(at) < ERROR_WINDOW_MS);
  if (recentFailure) {
    return { state: 'error', headline: 'Attention required', reason: 'A recent action or call failed', since: recentFailure, liveCallId: null };
  }

  const recentSend = actions.find((a) => a.sentAt && now - ms(a.sentAt) < SUCCESS_WINDOW_MS);
  if (recentSend) {
    return { state: 'success', headline: 'Email sent', reason: recentSend.subject, since: recentSend.sentAt, liveCallId: null };
  }

  const pending = actions.filter((a) => a.status === 'AWAITING_APPROVAL');
  if (pending.length > 0) {
    return {
      state: 'awaiting_approval',
      headline: pending.length === 1 ? '1 approval required' : `${pending.length} approvals required`,
      reason: pending[0].subject,
      since: pending[pending.length - 1].createdAt,
      liveCallId: null,
    };
  }

  const attention = inbox.filter((i) => i.status === 'NEW').length;
  return {
    state: 'idle',
    headline: attention > 0 ? `${attention} new business message${attention === 1 ? '' : 's'}` : 'All clear',
    reason: 'Monitoring business inbox',
    since: null,
    liveCallId: null,
  };
}

/* ------------------------------------------------------------------ */
/* Analytics                                                            */
/* ------------------------------------------------------------------ */

function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

function dailySeries(dates: string[], days: number, now: number): SeriesPoint[] {
  const counts = new Map<string, number>();
  for (const d of dates) counts.set(dayKey(d), (counts.get(dayKey(d)) ?? 0) + 1);
  const out: SeriesPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = dayKey(new Date(now - i * 86_400_000).toISOString());
    out.push({ date: key, value: counts.get(key) ?? 0 });
  }
  return out;
}

function buildAnalytics(
  inbox: InboxItemDTO[],
  actions: ActionDTO[],
  calls: CallDTO[],
  activity: ActivityDTO[],
  leads: LeadDTO[],
  now: number,
  windowDays = 30
): AnalyticsDTO {
  const since = now - windowDays * 86_400_000;
  const inWindow = (iso: string | null) => !!iso && ms(iso) >= since;

  const sent = actions.filter((a) => a.sentAt && inWindow(a.sentAt));
  const approvalToSend = sent
    .filter((a) => a.approval)
    .map((a) => (ms(a.sentAt) - ms(a.approval!.at)) / 1000)
    .filter((v) => v >= 0);
  const inboxByAction = new Map(inbox.filter((i) => i.actionId).map((i) => [i.actionId!, i]));
  const receiveToSend = sent
    .map((a) => {
      const received = inboxByAction.get(a.id)?.receivedAt ?? a.createdAt;
      return (ms(a.sentAt) - ms(received)) / 1000;
    })
    .filter((v) => v >= 0);

  const sourceCounts = new Map<string, number>();
  for (const a of actions) {
    if (a.approval && inWindow(a.approval.at)) {
      sourceCounts.set(a.approval.source, (sourceCounts.get(a.approval.source) ?? 0) + 1);
    }
  }
  const categoryCounts = new Map<string, number>();
  for (const i of inbox) {
    if (!inWindow(i.receivedAt)) continue;
    const key = i.category ?? 'unclassified';
    categoryCounts.set(key, (categoryCounts.get(key) ?? 0) + 1);
  }

  const windowCalls = calls.filter((c) => inWindow(c.startedAt));
  const windowLeads = leads.filter((l) => inWindow(l.lastContactAt));

  return {
    windowDays,
    emailsReceived: inbox.filter((i) => inWindow(i.receivedAt)).length,
    responsesSent: sent.length,
    medianApprovalToSendSec: median(approvalToSend),
    medianReceiveToSendSec: median(receiveToSend),
    pendingApprovals: actions.filter((a) => a.status === 'AWAITING_APPROVAL').length,
    callsCompleted: windowCalls.filter((c) => c.status === 'COMPLETED' && c.relay === 'connected').length,
    callsFailed: windowCalls.filter((c) => c.status === 'FAILED').length,
    leadsCreated: windowLeads.length,
    leadsContacted: windowLeads.filter((l) => l.stage !== 'NEW' && l.stage !== 'QUALIFIED').length,
    approvalSources: [...sourceCounts].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count),
    categories: [...categoryCounts].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
    activityByDay: dailySeries(activity.map((a) => a.at), 14, now),
    emailsByDay: dailySeries(inbox.map((i) => i.receivedAt), 14, now),
  };
}

/* ------------------------------------------------------------------ */
/* Entry point                                                          */
/* ------------------------------------------------------------------ */

export function buildReadModel(snapshot: RawSnapshot, options: ReadModelOptions = {}): ReadModel {
  const now = options.now ?? Date.now();
  const isOwner = ownerMatcher(options.ownerEmails);
  const actionsById = new Map(snapshot.actions.map((a) => [a.actionId, a]));
  const actionsByMessage = new Map<string, ActionRecord>();
  for (const a of snapshot.actions) {
    if (!a.messageId) continue;
    const existing = actionsByMessage.get(a.messageId);
    if (!existing || ms(a.updatedAt) > ms(existing.updatedAt)) actionsByMessage.set(a.messageId, a);
  }
  const eventsByAction = new Map<string, ActionEvent[]>();
  for (const e of snapshot.actionEvents) {
    const list = eventsByAction.get(e.actionId) ?? [];
    list.push(e);
    eventsByAction.set(e.actionId, list);
  }

  const inbox = buildInbox(snapshot, actionsByMessage, isOwner);
  const inboxByMessage = new Map<string, InboxItemDTO>();
  for (const [messageId] of actionsByMessage) {
    const item = inbox.find((i) => i.id === opaqueId('msg', messageId));
    if (item) inboxByMessage.set(messageId, item);
  }

  const actions = buildActions(snapshot, eventsByAction, inboxByMessage);
  const calls = buildCalls(snapshot, actionsById, now);
  const activity = buildActivity(snapshot, actionsById);
  const { leads, customers } = buildLeadsAndCustomers(inbox, actions, calls);
  const presence = derivePresence(actions, calls, inbox, now);
  const analytics = buildAnalytics(inbox, actions, calls, activity, leads, now);

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const lastRun = [...snapshot.runs].sort((a, b) => ms(b.timestamp) - ms(a.timestamp))[0];

  const commandCenter: CommandCenterDTO = {
    counts: {
      inbox: inbox.length,
      needsAttention: inbox.filter((i) => i.status === 'NEW' || (i.status === 'REVIEWED' && i.requiresResponse === true)).length,
      pendingApprovals: actions.filter((a) => a.status === 'AWAITING_APPROVAL').length,
      drafted: actions.filter((a) => a.hasDraft && a.status !== 'SENT' && a.status !== 'EXECUTED').length,
      sent: actions.filter((a) => a.status === 'SENT' || a.status === 'EXECUTED').length,
      failed: actions.filter((a) => a.status === 'FAILED' || a.status === 'EXECUTION_FAILED').length,
      activeLeads: leads.filter((l) => l.stage !== 'CLOSED' && l.stage !== 'LOST').length,
      calls: calls.filter((c) => c.relay === 'connected').length,
      callsToday: calls.filter((c) => ms(c.startedAt) >= startOfToday.getTime()).length,
    },
    presence,
    lastCallAt: calls[0]?.startedAt ?? null,
    lastAgentRunAt: lastRun?.timestamp ?? null,
  };

  return { inbox, actions, calls, activity, leads, customers, commandCenter, analytics };
}
