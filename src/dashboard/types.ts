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
  | 'PHOTO_BOOTH_ANALYTICS'
  | 'CALENDAR'
  | 'EMAIL_READ'
  | 'KNOWLEDGE'
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

/** Live Pacific Ops runtime as resolved for display (see src/runtime/pacificOpsRuntime.ts). */
export interface RuntimeStateDTO {
  state: PacificOpsState;
  sessionActive: boolean;
  sessionId: string | null;
  operation: 'call' | 'mailbox_review' | 'message_review' | 'draft_review' | 'approval' | 'send_email' | 'photo_booth_analytics' | 'calendar_read' | 'email_read' | 'knowledge_read' | 'wrap_up' | null;
  task: string | null;
  status: string;
  context: { senderName?: string; subject?: string } | null;
  at: string | null;
  settledBy: 'none' | 'outcome_elapsed' | 'stale' | 'gateway_offline' | 'no_runtime';
  voiceGateway: 'online' | 'offline' | 'unknown';
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

/* ------------------------------------------------------------------ */
/* Calendar Hub (read-only, multi-account)                              */
/* ------------------------------------------------------------------ */

/** `today` is kept as an alias of `day` anchored on today. */
export type CalendarHubView = 'month' | 'week' | 'day' | 'upcoming' | 'today';

/** One calendar cell/column in the business timezone. */
export interface CalendarDayDTO {
  /** YYYY-MM-DD */
  date: string;
  /** 0 = Sunday */
  weekday: number;
  isToday: boolean;
  /** False for month-grid padding days from the previous/next month. */
  inPeriod: boolean;
}

/** Server-computed navigation in the business timezone (YYYY-MM-DD anchors). */
export interface CalendarNavDTO {
  anchor: string;
  today: string;
  prev: string;
  next: string;
}
export type CalendarAggregateStatus = 'complete' | 'partial' | 'failed' | 'no_sources';
export type CalendarConnectionDTO = 'connected' | 'not_connected' | 'missing_scope' | 'unauthorized' | 'error';

/** One readable calendar. `sourceId` is opaque ("<profile>.<n>"); Google Calendar IDs never leave the server. */
export interface CalendarSourceDTO {
  sourceId: string;
  profileId: string;
  profileLabel: string;
  calendarLabel: string;
  /** "Business · Primary" */
  label: string;
  privacy: 'titles' | 'busy_only';
  selected: boolean;
  /** null when not part of the current selection (not queried). */
  status: CalendarConnectionDTO | null;
}

export interface CalendarProfileDTO {
  profileId: string;
  label: string;
  sourceIds: string[];
  /** Worst status across this profile's queried calendars; null if none were queried. */
  connection: CalendarConnectionDTO | null;
}

/** Privacy-safe event. `id` is an opaque hash of {profileId, calendarId, eventId}. */
export interface CalendarEventDTO {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  busy: boolean;
  sourceId: string;
  profileLabel: string;
  calendarLabel: string;
  sourceLabel: string;
  /** Overlaps another busy event in the current selection. */
  conflict: boolean;
  /** At least one overlapping event comes from a different account. */
  crossAccountConflict: boolean;
}

export interface CalendarIntervalDTO {
  start: string;
  end: string;
}

export interface CalendarDayAvailabilityDTO {
  /** YYYY-MM-DD in the business timezone. */
  date: string;
  /** Owner day window used for free/busy (8 AM to 10 PM local). */
  window: CalendarIntervalDTO;
  status: 'complete' | 'partial' | 'failed';
  /** Busy time on the calendars that answered. */
  busy: CalendarIntervalDTO[];
  /** Only when every selected calendar answered; null otherwise (never claim free on partial data). */
  free: CalendarIntervalDTO[] | null;
}

export interface CalendarVoiceScopeDTO {
  /** "All calendars", "Business", "Business + Personal". */
  scopeLabel: string;
  /** Profile IDs the voice question covered (null = all). */
  profileIds: string[] | null;
  /** "tomorrow", "Saturday", ... or null. */
  dayLabel: string | null;
  windowStart: string;
  windowEnd: string;
  at: string;
}

export interface CalendarHubDTO {
  generatedAt: string;
  timeZone: string;
  view: CalendarHubView;
  /** e.g. "October 2026", "October 18–24, 2026", "Sunday, October 18". */
  range: CalendarIntervalDTO & { label: string };
  nav: CalendarNavDTO;
  /** Visible days: month grid (whole weeks, Sunday first), week (Sun–Sat), day, or upcoming days. */
  days: CalendarDayDTO[];
  scope: { mode: 'all' | 'filtered'; label: string; sourceIds: string[] };
  status: CalendarAggregateStatus;
  failures: Array<{ label: string; kind: string }>;
  profiles: CalendarProfileDTO[];
  sources: CalendarSourceDTO[];
  events: CalendarEventDTO[];
  availability: CalendarDayAvailabilityDTO[];
  /** Real scope of the most recent Pacific Ops Calendar question, if any recent one exists. */
  voice: CalendarVoiceScopeDTO | null;
}

/* ------------------------------------------------------------------ */
/* Knowledge diagnostics (read-only; ingestion is CLI-only)             */
/* ------------------------------------------------------------------ */

export interface KnowledgeStatusDTO {
  database: 'online' | 'offline' | 'not_configured';
  detail: string | null;
  organizationId: string;
  sources: number;
  documents: number;
  chunks: number;
  chunksWithVectors: number;
  embedding: { model: string; dimension: number } | null;
  lastIngestion: {
    status: string;
    startedAt: string;
    completedAt: string | null;
    documentsChanged: number;
    documentsUnchanged: number;
    chunksWritten: number;
    errorCount: number;
  } | null;
  recentQueries: Array<{ query: string; mode: string; resultCount: number; latencyMs: number; at: string }>;
}

/** Search hit without internal database IDs. */
export interface KnowledgeHitDTO {
  rank: number;
  title: string;
  section: string | null;
  sourceLabel: string;
  excerpt: string;
  score: number;
  coverage: number;
  lexicalScore: number;
  vectorScore: number | null;
}

export interface KnowledgeSearchDTO {
  query: string;
  mode: 'hybrid' | 'lexical_only';
  degraded: string | null;
  latencyMs: number;
  results: KnowledgeHitDTO[];
}

/* ------------------------------------------------------------------ */
/* Agent traces (read-only, already redacted at write time)             */
/* ------------------------------------------------------------------ */

export interface AgentTraceDTO {
  traceId: string;
  at: string;
  channel: 'voice' | 'web' | 'api';
  inputPreview: string;
  /** Read-only knowledge canonicalization: what the owner said vs. the question that was searched. */
  normalization: { changed: boolean; confidence: number; method: string; canonicalPreview: string | null } | null;
  /** Why a turn inherited the active read domain (follow-up resolver), if it did. */
  followUp: { inheritedDomain: string; inheritedIntent: string; reason: string } | null;
  /** Turns that ran no tool on purpose: acknowledgement, clarification, or a reply from stored context. */
  resolution: { kind: string; reason: string } | null;
  /** Response ownership: the domain the request resolved to and the domain that answered. */
  resolvedDomain: string | null;
  responseDomain: string | null;
  intent: { intent: string; domain: string; source: string; highRisk: boolean; confidence: number };
  plan: { providers: string[]; completeness: string } | null;
  providersInvoked: string[];
  toolsConsidered: string[];
  policy: Array<{ toolId: string; decision: string; reason: string; trigger: string }>;
  approvalRequired: boolean;
  toolOutcome: { toolId: string; ok: boolean; outcome: string } | null;
  latencyMs: number;
  status: string;
  dryRun: boolean;
}
