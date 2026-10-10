/**
 * Pacific Rising Ops — Command Center read contract.
 *
 * These DTOs are the only shapes the dashboard API returns. They are derived from
 * the action, voice and triage stores and deliberately omit internal Gmail
 * identifiers (message/thread/draft IDs), Twilio call SIDs and unmasked phone numbers.
 *
 * This file must stay free of Node imports: the web client imports it as types.
 */

export type DataSourceKind = 'live' | 'demo';

export interface Envelope<T> {
  data: T;
  generatedAt: string;
  source: DataSourceKind;
}

/* ------------------------------------------------------------------ */
/* Status vocabulary                                                    */
/* ------------------------------------------------------------------ */

/** Mirrors the backend ActionStatus enum (src/actions/types.ts). */
export type ActionStatusDTO =
  | 'RECEIVED'
  | 'CLASSIFIED'
  | 'DRAFTED'
  | 'AWAITING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXECUTING'
  | 'SENT'
  | 'EXECUTION_FAILED'
  | 'EXECUTED'
  | 'FAILED';

/** Operator-facing inbox status, derived from triage + action state. */
export type InboxStatus =
  | 'NEW'
  | 'REVIEWED'
  | 'DRAFTED'
  | 'AWAITING_APPROVAL'
  | 'APPROVED'
  | 'EXECUTING'
  | 'SENT'
  | 'REJECTED'
  | 'SKIPPED'
  | 'FAILED';

export type CallStatusDTO =
  | 'CREATED'
  | 'CALL_REQUESTED'
  | 'CONNECTED'
  | 'ACTIVE'
  | 'COMPLETED'
  | 'FAILED';

export type ConversationStateDTO =
  | 'GREETING'
  | 'MAILBOX_SELECTING'
  | 'READY'
  | 'READING_SUMMARY'
  | 'READING_DRAFT'
  | 'AWAITING_APPROVAL_CONFIRMATION'
  | 'AWAITING_REJECTION_CONFIRMATION'
  | 'COMPLETE';

export type Tone = 'neutral' | 'info' | 'success' | 'attention' | 'failure';

export type PacificOpsState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'awaiting_approval'
  | 'executing'
  | 'success'
  | 'error';

/* ------------------------------------------------------------------ */
/* Systems                                                              */
/* ------------------------------------------------------------------ */

export type ComponentHealth = 'online' | 'configured' | 'degraded' | 'offline' | 'unknown';

export interface SystemComponentDTO {
  key: 'gmail' | 'twilio' | 'voice' | 'agent';
  label: string;
  status: ComponentHealth;
  detail: string;
  checkedAt: string;
}

export interface SystemHealthDTO {
  overall: 'healthy' | 'degraded' | 'down';
  components: SystemComponentDTO[];
}

/* ------------------------------------------------------------------ */
/* Contacts                                                             */
/* ------------------------------------------------------------------ */

export interface ContactRef {
  name: string;
  email: string | null;
  /** Stable opaque key used to group a person's records. */
  key: string;
}

/* ------------------------------------------------------------------ */
/* Actions / approvals                                                  */
/* ------------------------------------------------------------------ */

export interface ApprovalDTO {
  decision: 'approved' | 'rejected';
  source: 'cli' | 'dashboard' | 'voice';
  by: string;
  at: string;
}

export interface TimelineEventDTO {
  id: string;
  at: string;
  kind: ActivityKind;
  title: string;
  detail: string | null;
  actor: string;
  tone: Tone;
}

export interface ActionDTO {
  id: string;
  status: ActionStatusDTO;
  type: string;
  category: string;
  confidence: number;
  subject: string;
  contact: ContactRef;
  createdAt: string;
  updatedAt: string;
  proposal: {
    description: string;
    body: string | null;
  };
  hasDraft: boolean;
  approval: ApprovalDTO | null;
  sentAt: string | null;
  failureReason: string | null;
  timeline: TimelineEventDTO[];
  callIds: string[];
}

/* ------------------------------------------------------------------ */
/* Inbox                                                                */
/* ------------------------------------------------------------------ */

export interface InboxItemDTO {
  id: string;
  sender: ContactRef;
  subject: string;
  receivedAt: string;
  snippet: string | null;
  summary: string | null;
  category: string | null;
  priority: 'high' | 'medium' | 'low' | null;
  status: InboxStatus;
  reviewed: boolean;
  hasDraft: boolean;
  approvalRequired: boolean;
  responded: boolean;
  requiresResponse: boolean | null;
  actionId: string | null;
  callIds: string[];
  event: {
    type: string | null;
    date: string | null;
    location: string | null;
  } | null;
  missingInformation: string[];
  /** Sent from one of the owner's own accounts (internal test or forward), not a customer. */
  fromOwner: boolean;
  /** Where this record was observed (triage run, voice review, action store). */
  observedIn: Array<'triage' | 'voice_review' | 'action'>;
}

/* ------------------------------------------------------------------ */
/* Calls                                                                */
/* ------------------------------------------------------------------ */

export interface TranscriptLineDTO {
  role: 'agent' | 'user';
  text: string;
  at: string;
}

export interface CallDTO {
  id: string;
  direction: 'outbound' | 'inbound';
  mode: 'action_review' | 'mailbox_review';
  contact: { name: string; phoneMasked: string };
  status: CallStatusDTO;
  conversationState: ConversationStateDTO;
  startedAt: string;
  endedAt: string | null;
  durationSec: number | null;
  relay: 'connected' | 'not_connected' | 'unknown';
  outcome: string;
  tone: Tone;
  approvalResult: 'approved' | 'rejected' | null;
  action: { id: string; subject: string; status: ActionStatusDTO } | null;
  selectedMessage: { sender: string; subject: string } | null;
  error: string | null;
  transcript: TranscriptLineDTO[];
  stale: boolean;
}

/* ------------------------------------------------------------------ */
/* Activity                                                             */
/* ------------------------------------------------------------------ */

export type ActivityKind =
  | 'email_received'
  | 'email_classified'
  | 'email_triaged'
  | 'lead_identified'
  | 'draft_generated'
  | 'approval_requested'
  | 'approval_confirmed'
  | 'approval_rejected'
  | 'execution_started'
  | 'email_sent'
  | 'execution_failed'
  | 'call_initiated'
  | 'call_connected'
  | 'call_completed'
  | 'call_failed'
  | 'voice_turn'
  | 'mailbox_plan'
  | 'note';

export interface ActivityDTO {
  id: string;
  at: string;
  kind: ActivityKind;
  title: string;
  detail: string | null;
  actor: string;
  tone: Tone;
  subject: string | null;
  ref: { type: 'action' | 'call' | 'inbox' | 'plan'; id: string } | null;
}

/* ------------------------------------------------------------------ */
/* Leads & customers                                                    */
/* ------------------------------------------------------------------ */

export type LeadStage =
  | 'NEW'
  | 'QUALIFIED'
  | 'CONTACTED'
  | 'QUOTE_PREPARED'
  | 'AWAITING_CUSTOMER'
  | 'BOOKED'
  | 'CLOSED'
  | 'LOST';

export interface LeadDTO {
  id: string;
  /** Customer profile this lead belongs to. */
  customerId: string;
  name: string;
  email: string | null;
  phoneMasked: string | null;
  source: 'email' | 'voice' | 'manual';
  eventType: string | null;
  eventDate: string | null;
  location: string | null;
  guestCount: number | null;
  stage: LeadStage;
  notes: string | null;
  lastContactAt: string;
  nextAction: string | null;
  inquiryCount: number;
  actionIds: string[];
  callIds: string[];
  inboxIds: string[];
  /** True when stage was inferred from action state rather than set by a human. */
  derived: boolean;
}

export interface CustomerDTO {
  id: string;
  name: string;
  email: string | null;
  lead: LeadDTO | null;
  firstSeenAt: string;
  lastSeenAt: string;
  messageCount: number;
  timeline: TimelineEventDTO[];
}

/* ------------------------------------------------------------------ */
/* Command center / analytics                                           */
/* ------------------------------------------------------------------ */

export interface PresenceDTO {
  state: PacificOpsState;
  headline: string;
  reason: string;
  since: string | null;
  liveCallId: string | null;
}

export interface CommandCenterDTO {
  counts: {
    inbox: number;
    needsAttention: number;
    pendingApprovals: number;
    drafted: number;
    sent: number;
    failed: number;
    activeLeads: number;
    calls: number;
    callsToday: number;
  };
  presence: PresenceDTO;
  lastCallAt: string | null;
  lastAgentRunAt: string | null;
}

export interface SeriesPoint {
  date: string;
  value: number;
}

export interface AnalyticsDTO {
  windowDays: number;
  emailsReceived: number;
  responsesSent: number;
  medianApprovalToSendSec: number | null;
  medianReceiveToSendSec: number | null;
  pendingApprovals: number;
  callsCompleted: number;
  callsFailed: number;
  leadsCreated: number;
  leadsContacted: number;
  approvalSources: Array<{ source: string; count: number }>;
  categories: Array<{ category: string; count: number }>;
  activityByDay: SeriesPoint[];
  emailsByDay: SeriesPoint[];
}

/* ------------------------------------------------------------------ */
/* Live stream                                                          */
/* ------------------------------------------------------------------ */

export interface ChangeEventDTO {
  at: string;
  topics: Array<'actions' | 'calls' | 'inbox' | 'activity'>;
}
