import type {
  ActionDTO,
  ActivityDTO,
  AnalyticsDTO,
  CalendarHubDTO,
  CalendarHubView,
  CallDTO,
  KnowledgeSearchDTO,
  KnowledgeStatusDTO,
  ChangeEventDTO,
  CommandCenterDTO,
  CustomerDTO,
  DataSourceKind,
  InboxItemDTO,
  LeadDTO,
  RuntimeStateDTO,
  SystemHealthDTO,
} from './contract';

/**
 * Service boundary between UI and data. Components never fetch directly; they ask a
 * service. Two implementations exist: the HTTP adapter (real PHRO state via the
 * read-only Command Center API) and the demo adapter (clearly labeled sample data).
 *
 * Every service is read-only. Approval, send and call execution stay on the
 * existing voice / CLI paths that own the deterministic action state machine.
 */

export interface DashboardService {
  getCommandCenter(): Promise<CommandCenterDTO>;
  getHealth(): Promise<SystemHealthDTO>;
  getAnalytics(): Promise<AnalyticsDTO>;
}

export interface MailboxService {
  listInbox(): Promise<InboxItemDTO[]>;
  getInboxItem(id: string): Promise<InboxItemDTO>;
}

export interface ActionService {
  listActions(): Promise<ActionDTO[]>;
  getAction(id: string): Promise<ActionDTO>;
}

export interface CallService {
  listCalls(): Promise<CallDTO[]>;
  getCall(id: string): Promise<CallDTO>;
}

export interface LeadService {
  listLeads(): Promise<LeadDTO[]>;
  listCustomers(): Promise<CustomerDTO[]>;
  getCustomer(id: string): Promise<CustomerDTO>;
}

/** Read-only multi-account Calendar Hub. There is deliberately no create/update/delete. */
export interface CalendarHubService {
  getHub(query: { view: CalendarHubView; date?: string | null; sourceIds: string[] | null }): Promise<CalendarHubDTO>;
}

/** Read-only knowledge diagnostics. Ingestion is CLI-only; there is no write method. */
export interface KnowledgeService {
  getStatus(): Promise<KnowledgeStatusDTO>;
  search(query: string): Promise<KnowledgeSearchDTO>;
}

export interface ActivityService {
  listActivity(limit?: number): Promise<ActivityDTO[]>;
}

export type Topic = ChangeEventDTO['topics'][number] | 'health';
export const ALL_TOPICS: Topic[] = ['actions', 'calls', 'inbox', 'activity', 'health'];

/** live = push stream connected; polling = stream unavailable, refreshing on an interval. */
export type LinkState = 'connecting' | 'live' | 'polling' | 'offline' | 'demo';

export interface RealtimeService {
  subscribe(handlers: {
    onChange: (event: ChangeEventDTO) => void;
    onLinkState: (state: LinkState) => void;
  }): () => void;
}

/**
 * Live Pacific Ops runtime link.
 * live: stream connected · reconnecting: stream dropped, retrying · offline: API unreachable
 */
export type RuntimeLink = 'connecting' | 'live' | 'reconnecting' | 'offline' | 'demo';

export interface RuntimeService {
  getState(): Promise<RuntimeStateDTO>;
  subscribe(handlers: { onState: (state: RuntimeStateDTO) => void; onLink: (link: RuntimeLink) => void }): () => void;
}

export interface PacificServices {
  kind: DataSourceKind;
  dashboard: DashboardService;
  mailbox: MailboxService;
  actions: ActionService;
  calls: CallService;
  leads: LeadService;
  activity: ActivityService;
  calendar: CalendarHubService;
  knowledge: KnowledgeService;
  realtime: RealtimeService;
  /** Observational Pacific Ops runtime (voice state). Read-only, like everything here. */
  runtime: RuntimeService;
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = 'NotFoundError';
  }
}

export class ApiUnavailableError extends Error {
  constructor(message = 'The Command Center API is not reachable') {
    super(message);
    this.name = 'ApiUnavailableError';
  }
}
