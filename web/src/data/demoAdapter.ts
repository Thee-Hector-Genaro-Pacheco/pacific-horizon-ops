import type {
  ActionDTO,
  ActionStatusDTO,
  ActivityDTO,
  AnalyticsDTO,
  CallDTO,
  CommandCenterDTO,
  ContactRef,
  CustomerDTO,
  InboxItemDTO,
  InboxStatus,
  LeadDTO,
  LeadStage,
  RuntimeStateDTO,
  SystemHealthDTO,
  TimelineEventDTO,
} from './contract';
import type { CalendarHubDTO, CalendarHubView } from './contract';
import { NotFoundError, type PacificServices } from './services';

/**
 * DEMO DATA — sample records for exploring the Command Center without a running
 * PHRO backend. Nothing here reflects real operations. Every id is prefixed `demo_`
 * and every surface that renders it shows a DEMO badge.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export interface DemoDataset {
  inbox: InboxItemDTO[];
  actions: ActionDTO[];
  calls: CallDTO[];
  activity: ActivityDTO[];
  leads: LeadDTO[];
  customers: CustomerDTO[];
  commandCenter: CommandCenterDTO;
  health: SystemHealthDTO;
  analytics: AnalyticsDTO;
}

interface Person {
  key: string;
  name: string;
  email: string;
}

const people = {
  sarah: { key: 'demo_c_sarah', name: 'Sarah Martinez', email: 'sarah.martinez@example.com' },
  monica: { key: 'demo_c_monica', name: 'Monica Reyes', email: 'monica.reyes@example.com' },
  daniel: { key: 'demo_c_daniel', name: 'Daniel Okafor', email: 'd.okafor@example.org' },
  priya: { key: 'demo_c_priya', name: 'Priya Shah', email: 'priya.shah@example.com' },
  jordan: { key: 'demo_c_jordan', name: 'Jordan Lee', email: 'jlee@example.edu' },
  elena: { key: 'demo_c_elena', name: 'Elena Torres', email: 'elena@example.com' },
  aisha: { key: 'demo_c_aisha', name: 'Aisha Rahman', email: 'aisha.r@example.com' },
  marcus: { key: 'demo_c_marcus', name: 'Marcus Bell', email: 'marcus.bell@example.net' },
  kevin: { key: 'demo_c_kevin', name: 'Kevin Park', email: 'kevin.park@example.com' },
} satisfies Record<string, Person>;

const contact = (p: Person): ContactRef => ({ name: p.name, email: p.email, key: p.key });

const STEP_META: Record<ActionStatusDTO, Omit<TimelineEventDTO, 'id' | 'at'>> = {
  RECEIVED: { kind: 'email_received', title: 'Email received', detail: null, actor: 'Pacific Ops', tone: 'neutral' },
  CLASSIFIED: { kind: 'email_classified', title: 'Email classified', detail: 'Booking inquiry · high confidence', actor: 'Classifier', tone: 'neutral' },
  DRAFTED: { kind: 'draft_generated', title: 'Reply drafted', detail: 'Draft created in business Gmail', actor: 'Gmail', tone: 'info' },
  AWAITING_APPROVAL: { kind: 'approval_requested', title: 'Approval requested', detail: 'Draft ready for human approval', actor: 'Pacific Ops', tone: 'attention' },
  APPROVED: { kind: 'approval_confirmed', title: 'Owner approved via voice', detail: 'Confirmed and approved via voice call', actor: 'Owner · voice', tone: 'success' },
  REJECTED: { kind: 'approval_rejected', title: 'Draft rejected', detail: null, actor: 'Owner · voice', tone: 'neutral' },
  EXECUTING: { kind: 'execution_started', title: 'Gmail send executing', detail: 'Sending exact approved draft', actor: 'Owner · voice', tone: 'info' },
  SENT: { kind: 'email_sent', title: 'Email sent', detail: 'Draft sent successfully via Gmail', actor: 'Owner · voice', tone: 'success' },
  EXECUTED: { kind: 'email_sent', title: 'Action completed', detail: null, actor: 'Pacific Ops', tone: 'success' },
  EXECUTION_FAILED: { kind: 'execution_failed', title: 'Execution failed', detail: 'Gmail API returned an error', actor: 'Pacific Ops', tone: 'failure' },
  FAILED: { kind: 'execution_failed', title: 'Action failed', detail: null, actor: 'Pacific Ops', tone: 'failure' },
};

function timeline(id: string, steps: Array<[ActionStatusDTO, number]>, now: number): TimelineEventDTO[] {
  return steps.map(([status, ago], i) => ({ id: `${id}_e${i}`, at: new Date(now - ago).toISOString(), ...STEP_META[status] }));
}

const iso = (now: number, ago: number) => new Date(now - ago).toISOString();

export function buildDemoDataset(now: number = Date.now()): DemoDataset {
  /* ------------------------------ actions ------------------------------ */
  const actionSpecs: Array<{
    id: string;
    who: Person;
    subject: string;
    status: ActionStatusDTO;
    steps: Array<[ActionStatusDTO, number]>;
    body: string;
    approvalAgo?: number;
    sentAgo?: number;
  }> = [
    {
      id: 'demo_act_sarah',
      who: people.sarah,
      subject: 'Wedding Photo Booth Inquiry',
      status: 'AWAITING_APPROVAL',
      steps: [['RECEIVED', 4 * MIN], ['CLASSIFIED', 3.8 * MIN], ['DRAFTED', 3.5 * MIN], ['AWAITING_APPROVAL', 3.4 * MIN]],
      body:
        'Hi Sarah,\n\nThank you for reaching out, and congratulations on your upcoming wedding! We would love to be part of your celebration in Irvine on November 14.\n\nTo put together an accurate quote, could you share:\n- Your venue name and the hours you would like the booth\n- Whether you are interested in on-site prints, digital sharing, or both\n- Any custom branding you have in mind for your template\n\nOnce we have those details we will send over package options.\n\nBest regards,\nPacific Horizon Labs',
    },
    {
      id: 'demo_act_daniel',
      who: people.daniel,
      subject: 'Holiday party — photo booth availability',
      status: 'AWAITING_APPROVAL',
      steps: [['RECEIVED', 52 * MIN], ['CLASSIFIED', 51 * MIN], ['DRAFTED', 50 * MIN], ['AWAITING_APPROVAL', 50 * MIN]],
      body:
        'Hi Daniel,\n\nThanks for thinking of us for your company holiday party on December 12. We do serve Costa Mesa and would be glad to check availability.\n\nCould you confirm the expected guest count, event hours, and whether you would like custom company branding on the photo template?\n\nBest regards,\nPacific Horizon Labs',
    },
    {
      id: 'demo_act_monica',
      who: people.monica,
      subject: 'Pricing question for a birthday',
      status: 'SENT',
      steps: [
        ['RECEIVED', 2.4 * HOUR],
        ['CLASSIFIED', 2.39 * HOUR],
        ['DRAFTED', 2.38 * HOUR],
        ['AWAITING_APPROVAL', 2.38 * HOUR],
        ['APPROVED', 18 * MIN],
        ['EXECUTING', 18 * MIN - 2000],
        ['SENT', 18 * MIN - 3000],
      ],
      approvalAgo: 18 * MIN,
      sentAgo: 18 * MIN - 3000,
      body:
        'Hi Monica,\n\nThank you for your message! We would be happy to help with your birthday celebration. Our packages vary by hours and whether you would like on-site prints.\n\nCould you share your date, location, and how many hours you have in mind? We will follow up with options that fit.\n\nBest regards,\nPacific Horizon Labs',
    },
    {
      id: 'demo_act_priya',
      who: people.priya,
      subject: 'Sweet sixteen — backdrop options',
      status: 'SENT',
      steps: [
        ['RECEIVED', 26 * HOUR],
        ['CLASSIFIED', 26 * HOUR - MIN],
        ['DRAFTED', 26 * HOUR - 2 * MIN],
        ['AWAITING_APPROVAL', 26 * HOUR - 2 * MIN],
        ['APPROVED', 23 * HOUR],
        ['EXECUTING', 23 * HOUR - 1500],
        ['SENT', 23 * HOUR - 2500],
      ],
      approvalAgo: 23 * HOUR,
      sentAgo: 23 * HOUR - 2500,
      body: 'Hi Priya,\n\nThanks for asking about backdrops! We offer several premium physical and digital backdrop options and can match a color theme.\n\nBest regards,\nPacific Horizon Labs',
    },
    {
      id: 'demo_act_jordan',
      who: people.jordan,
      subject: 'School fundraiser — quote request',
      status: 'SENT',
      steps: [
        ['RECEIVED', 3 * DAY],
        ['CLASSIFIED', 3 * DAY - MIN],
        ['DRAFTED', 3 * DAY - 2 * MIN],
        ['AWAITING_APPROVAL', 3 * DAY - 2 * MIN],
        ['APPROVED', 2.9 * DAY],
        ['EXECUTING', 2.9 * DAY - 1200],
        ['SENT', 2.9 * DAY - 2200],
      ],
      approvalAgo: 2.9 * DAY,
      sentAgo: 2.9 * DAY - 2200,
      body: 'Hi Jordan,\n\nThank you for reaching out about the fundraiser. We have prepared a quote based on the details you shared and attached it here.\n\nBest regards,\nPacific Horizon Labs',
    },
  ];

  const actions: ActionDTO[] = actionSpecs.map((a) => {
    const tl = timeline(a.id, a.steps, now);
    return {
      id: a.id,
      status: a.status,
      type: 'CREATE_EMAIL_DRAFT',
      category: 'booking_inquiry',
      confidence: 0.93,
      subject: a.subject,
      contact: contact(a.who),
      createdAt: tl[0].at,
      updatedAt: tl[tl.length - 1].at,
      proposal: {
        description: a.status === 'SENT' ? 'Reply sent from the approved Gmail draft' : 'Send the drafted reply from the business Gmail account',
        body: a.body,
      },
      hasDraft: true,
      approval: a.approvalAgo ? { decision: 'approved', source: 'voice', by: 'Owner (voice)', at: iso(now, a.approvalAgo) } : null,
      sentAt: a.sentAgo ? iso(now, a.sentAgo) : null,
      failureReason: null,
      timeline: tl,
      callIds: a.id === 'demo_act_monica' ? ['demo_call_1'] : a.id === 'demo_act_priya' ? ['demo_call_3'] : [],
    };
  });
  const actionById = new Map(actions.map((a) => [a.id, a]));

  /* ------------------------------- inbox ------------------------------- */
  const inboxSpec: Array<{
    id: string;
    who: Person | { key: string; name: string; email: string };
    subject: string;
    ago: number;
    status: InboxStatus;
    category: string;
    actionId?: string;
    summary: string;
    snippet: string;
    event?: InboxItemDTO['event'];
    priority?: InboxItemDTO['priority'];
    missing?: string[];
  }> = [
    {
      id: 'demo_msg_sarah',
      who: people.sarah,
      subject: 'Wedding Photo Booth Inquiry',
      ago: 4 * MIN,
      status: 'AWAITING_APPROVAL',
      category: 'booking_inquiry',
      actionId: 'demo_act_sarah',
      summary: 'Wedding on November 14 in Irvine, ~140 guests. Asking about availability and print options.',
      snippet: 'Hi! We are getting married November 14 at a venue in Irvine and would love a photo booth for the reception…',
      event: { type: 'Wedding', date: 'November 14', location: 'Irvine, CA' },
      priority: 'high',
      missing: ['Venue name', 'Booth hours'],
    },
    {
      id: 'demo_msg_kevin',
      who: people.kevin,
      subject: 'Graduation party booth?',
      ago: 21 * MIN,
      status: 'NEW',
      category: 'booking_inquiry',
      summary: 'Graduation party in Fullerton next spring. Wants to know if a digital-only booth is available.',
      snippet: 'Hey there, my daughter graduates in May and we are planning a backyard party in Fullerton…',
      event: { type: 'Graduation party', date: 'May 2027', location: 'Fullerton, CA' },
      priority: 'medium',
    },
    {
      id: 'demo_msg_daniel',
      who: people.daniel,
      subject: 'Holiday party — photo booth availability',
      ago: 52 * MIN,
      status: 'AWAITING_APPROVAL',
      category: 'booking_inquiry',
      actionId: 'demo_act_daniel',
      summary: 'Corporate holiday party December 12 in Costa Mesa. Wants branded templates.',
      snippet: 'Hello, our team is hosting a holiday party on December 12 in Costa Mesa and we are looking for a booth with custom branding…',
      event: { type: 'Corporate holiday party', date: 'December 12', location: 'Costa Mesa, CA' },
      priority: 'high',
    },
    {
      id: 'demo_msg_monica',
      who: people.monica,
      subject: 'Pricing question for a birthday',
      ago: 2.4 * HOUR,
      status: 'SENT',
      category: 'booking_inquiry',
      actionId: 'demo_act_monica',
      summary: 'Asking about package pricing for a 30th birthday.',
      snippet: 'Hi, how much would it be to rent a booth for my 30th birthday? Thinking 3 hours…',
      event: { type: 'Birthday', date: null, location: null },
      priority: 'medium',
    },
    {
      id: 'demo_msg_notice',
      who: { key: 'demo_c_ws', name: 'Workspace Notifications', email: 'workspace-noreply@example.com' },
      subject: 'Your weekly storage summary',
      ago: 5 * HOUR,
      status: 'SKIPPED',
      category: 'system_notification',
      summary: 'Automated storage summary. No response required.',
      snippet: 'Here is your weekly storage summary…',
    },
    {
      id: 'demo_msg_priya',
      who: people.priya,
      subject: 'Sweet sixteen — backdrop options',
      ago: 26 * HOUR,
      status: 'SENT',
      category: 'booking_inquiry',
      actionId: 'demo_act_priya',
      summary: 'Sweet sixteen in Laguna Beach; asking which backdrops are available.',
      snippet: 'Hi! Do you have a rose gold or blush backdrop? Party is in Laguna Beach…',
      event: { type: 'Sweet sixteen', date: 'January 9', location: 'Laguna Beach, CA' },
      priority: 'medium',
    },
    {
      id: 'demo_msg_elena',
      who: people.elena,
      subject: 'Re: Booking confirmation — signed agreement',
      ago: 2 * DAY,
      status: 'REVIEWED',
      category: 'event_logistics',
      summary: 'Customer returned the signed rental agreement and asked about setup time.',
      snippet: 'Attached is the signed agreement. What time will your team arrive for setup?',
      event: { type: 'Anniversary gala', date: 'October 24', location: 'Newport Beach, CA' },
      priority: 'medium',
    },
    {
      id: 'demo_msg_jordan',
      who: people.jordan,
      subject: 'School fundraiser — quote request',
      ago: 3 * DAY,
      status: 'SENT',
      category: 'booking_inquiry',
      actionId: 'demo_act_jordan',
      summary: 'PTA fundraiser in Anaheim, ~300 attendees.',
      snippet: 'Our PTA is planning a spring fundraiser and would love a booth…',
      event: { type: 'School fundraiser', date: 'March 7', location: 'Anaheim, CA' },
      priority: 'medium',
    },
    {
      id: 'demo_msg_vendor',
      who: { key: 'demo_c_vendor', name: 'Print Supply Co.', email: 'news@example-supply.com' },
      subject: 'New media rolls in stock',
      ago: 4 * DAY,
      status: 'SKIPPED',
      category: 'vendor_or_marketing',
      summary: 'Vendor promotion.',
      snippet: 'Restock alert: 4x6 media rolls…',
    },
  ];

  const inbox: InboxItemDTO[] = inboxSpec.map((m) => {
    const action = m.actionId ? actionById.get(m.actionId) : undefined;
    return {
      id: m.id,
      sender: { name: m.who.name, email: m.who.email, key: m.who.key },
      subject: m.subject,
      receivedAt: iso(now, m.ago),
      snippet: m.snippet,
      summary: m.summary,
      category: m.category,
      priority: m.priority ?? 'low',
      status: m.status,
      reviewed: m.status !== 'NEW',
      hasDraft: !!action,
      approvalRequired: m.status === 'AWAITING_APPROVAL',
      responded: m.status === 'SENT',
      requiresResponse: m.category === 'booking_inquiry' || m.category === 'event_logistics',
      actionId: m.actionId ?? null,
      callIds: action?.callIds ?? [],
      event: m.event ?? null,
      missingInformation: m.missing ?? [],
      fromOwner: false,
      observedIn: action ? ['triage', 'action'] : ['triage'],
    };
  });

  /* ------------------------------- calls ------------------------------- */
  const t = (role: 'agent' | 'user', text: string, ago: number) => ({ role, text, at: iso(now, ago) });
  const calls: CallDTO[] = [
    {
      id: 'demo_call_1',
      direction: 'outbound',
      mode: 'mailbox_review',
      contact: { name: 'Owner', phoneMasked: '+1******0000' },
      status: 'COMPLETED',
      conversationState: 'COMPLETE',
      startedAt: iso(now, 21 * MIN),
      endedAt: iso(now, 17.5 * MIN),
      durationSec: 205,
      relay: 'connected',
      outcome: 'Approved · email sent',
      tone: 'success',
      approvalResult: 'approved',
      action: { id: 'demo_act_monica', subject: 'Pricing question for a birthday', status: 'SENT' },
      selectedMessage: { sender: 'Monica Reyes', subject: 'Pricing question for a birthday' },
      error: null,
      transcript: [
        t('agent', 'I found three recent business emails. Message one is from Monica Reyes about a birthday pricing question. Which would you like to review?', 21 * MIN),
        t('user', 'One.', 20.6 * MIN),
        t('agent', 'Selected message one. Monica is asking about package pricing for a 30th birthday. Should I read the drafted reply?', 20.5 * MIN),
        t('user', 'Read the draft.', 20.1 * MIN),
        t('agent', 'Here is the draft: Hi Monica, thank you for your message…', 20 * MIN),
        t('user', 'Approve.', 18.4 * MIN),
        t('agent', 'Are you sure you want to approve sending this draft? Say confirm approval to send.', 18.3 * MIN),
        t('user', 'Confirm approval.', 18.05 * MIN),
        t('agent', 'Approval confirmed. The email has been sent successfully.', 17.9 * MIN),
      ],
      stale: false,
    },
    {
      id: 'demo_call_2',
      direction: 'outbound',
      mode: 'mailbox_review',
      contact: { name: 'Owner', phoneMasked: '+1******0000' },
      status: 'COMPLETED',
      conversationState: 'MAILBOX_SELECTING',
      startedAt: iso(now, 3.2 * HOUR),
      endedAt: iso(now, 3.17 * HOUR),
      durationSec: 92,
      relay: 'connected',
      outcome: 'Reviewed · no decision',
      tone: 'neutral',
      approvalResult: null,
      action: null,
      selectedMessage: null,
      error: null,
      transcript: [
        t('agent', 'I found two recent business emails. Which would you like to review?', 3.2 * HOUR),
        t('user', 'Not right now, goodbye.', 3.18 * HOUR),
        t('agent', 'Understood. Goodbye.', 3.17 * HOUR),
      ],
      stale: false,
    },
    {
      id: 'demo_call_3',
      direction: 'outbound',
      mode: 'action_review',
      contact: { name: 'Owner', phoneMasked: '+1******0000' },
      status: 'COMPLETED',
      conversationState: 'COMPLETE',
      startedAt: iso(now, 23.05 * HOUR),
      endedAt: iso(now, 22.98 * HOUR),
      durationSec: 141,
      relay: 'connected',
      outcome: 'Approved · email sent',
      tone: 'success',
      approvalResult: 'approved',
      action: { id: 'demo_act_priya', subject: 'Sweet sixteen — backdrop options', status: 'SENT' },
      selectedMessage: null,
      error: null,
      transcript: [
        t('agent', 'You have a reply draft for Priya Shah about backdrop options. Say summary, read draft, approve, or reject.', 23.05 * HOUR),
        t('user', 'Approve.', 23.01 * HOUR),
        t('agent', 'Say confirm approval to send.', 23.005 * HOUR),
        t('user', 'Confirm approval.', 23.001 * HOUR),
        t('agent', 'Approval confirmed. The email has been sent successfully.', 23 * HOUR),
      ],
      stale: false,
    },
    {
      id: 'demo_call_4',
      direction: 'outbound',
      mode: 'mailbox_review',
      contact: { name: 'Owner', phoneMasked: '+1******0000' },
      status: 'FAILED',
      conversationState: 'GREETING',
      startedAt: iso(now, 2 * DAY),
      endedAt: iso(now, 2 * DAY - 30_000),
      durationSec: null,
      relay: 'not_connected',
      outcome: 'Call failed',
      tone: 'failure',
      approvalResult: null,
      action: null,
      selectedMessage: null,
      error: 'Call ended with status: no-answer',
      transcript: [],
      stale: false,
    },
  ];

  /* ----------------------------- activity ------------------------------ */
  const activity: ActivityDTO[] = [];
  for (const a of actions) {
    for (const e of a.timeline) {
      activity.push({ ...e, subject: a.subject, ref: { type: 'action', id: a.id } });
    }
  }
  for (const c of calls) {
    activity.push({
      id: `${c.id}_start`,
      at: c.startedAt,
      kind: 'call_initiated',
      title: 'Voice call initiated',
      detail: c.mode === 'mailbox_review' ? 'Mailbox review' : 'Action review',
      actor: 'Pacific Ops',
      tone: 'info',
      subject: c.action?.subject ?? null,
      ref: { type: 'call', id: c.id },
    });
    if (c.endedAt) {
      activity.push({
        id: `${c.id}_end`,
        at: c.endedAt,
        kind: c.status === 'FAILED' ? 'call_failed' : 'call_completed',
        title: c.status === 'FAILED' ? 'Voice call failed' : 'Voice call completed',
        detail: c.status === 'FAILED' ? c.error : c.outcome,
        actor: 'Voice gateway',
        tone: c.status === 'FAILED' ? 'failure' : 'neutral',
        subject: c.action?.subject ?? null,
        ref: { type: 'call', id: c.id },
      });
    }
  }
  for (const m of inbox.filter((i) => !i.actionId)) {
    activity.push({
      id: `${m.id}_triage`,
      at: m.receivedAt,
      kind: m.category === 'booking_inquiry' ? 'lead_identified' : 'email_triaged',
      title: m.category === 'booking_inquiry' ? 'Lead identified' : 'Email triaged · no reply needed',
      detail: m.summary,
      actor: 'Classifier',
      tone: m.category === 'booking_inquiry' ? 'info' : 'neutral',
      subject: m.subject,
      ref: { type: 'inbox', id: m.id },
    });
  }
  activity.sort((a, b) => b.at.localeCompare(a.at));

  /* --------------------------- leads/customers -------------------------- */
  const leadSpec: Array<{
    who: Person;
    stage: LeadStage;
    eventType: string;
    eventDate: string | null;
    location: string | null;
    guests: number | null;
    next: string | null;
    notes: string;
    lastAgo: number;
    actionIds?: string[];
    inboxIds?: string[];
    callIds?: string[];
  }> = [
    { who: people.kevin, stage: 'NEW', eventType: 'Graduation party', eventDate: 'May 2027', location: 'Fullerton, CA', guests: 60, next: 'Draft a reply', notes: 'Interested in a digital-only booth.', lastAgo: 21 * MIN, inboxIds: ['demo_msg_kevin'] },
    { who: people.sarah, stage: 'QUALIFIED', eventType: 'Wedding', eventDate: 'November 14', location: 'Irvine, CA', guests: 140, next: 'Approve drafted reply', notes: 'Wants prints and digital sharing. Venue TBD.', lastAgo: 4 * MIN, actionIds: ['demo_act_sarah'], inboxIds: ['demo_msg_sarah'] },
    { who: people.daniel, stage: 'QUALIFIED', eventType: 'Corporate holiday party', eventDate: 'December 12', location: 'Costa Mesa, CA', guests: 220, next: 'Approve drafted reply', notes: 'Custom company branding requested.', lastAgo: 52 * MIN, actionIds: ['demo_act_daniel'], inboxIds: ['demo_msg_daniel'] },
    { who: people.monica, stage: 'CONTACTED', eventType: 'Birthday', eventDate: null, location: null, guests: null, next: 'Follow up if no customer reply', notes: '30th birthday, ~3 hours.', lastAgo: 18 * MIN, actionIds: ['demo_act_monica'], inboxIds: ['demo_msg_monica'], callIds: ['demo_call_1'] },
    { who: people.jordan, stage: 'QUOTE_PREPARED', eventType: 'School fundraiser', eventDate: 'March 7', location: 'Anaheim, CA', guests: 300, next: 'Confirm quote received', notes: 'PTA event. Quote sent with standard package.', lastAgo: 2.9 * DAY, actionIds: ['demo_act_jordan'], inboxIds: ['demo_msg_jordan'] },
    { who: people.priya, stage: 'AWAITING_CUSTOMER', eventType: 'Sweet sixteen', eventDate: 'January 9', location: 'Laguna Beach, CA', guests: 80, next: 'Waiting on backdrop choice', notes: 'Rose gold theme.', lastAgo: 23 * HOUR, actionIds: ['demo_act_priya'], inboxIds: ['demo_msg_priya'], callIds: ['demo_call_3'] },
    { who: people.elena, stage: 'BOOKED', eventType: 'Anniversary gala', eventDate: 'October 24', location: 'Newport Beach, CA', guests: 180, next: 'Confirm setup time', notes: 'Agreement signed. Retainer received.', lastAgo: 2 * DAY, inboxIds: ['demo_msg_elena'] },
    { who: people.aisha, stage: 'CLOSED', eventType: 'Baby shower', eventDate: 'September 20', location: 'Tustin, CA', guests: 45, next: null, notes: 'Event delivered. Gallery shared.', lastAgo: 12 * DAY },
    { who: people.marcus, stage: 'LOST', eventType: 'Product launch', eventDate: 'October 2', location: 'Los Angeles, CA', guests: 400, next: null, notes: 'Went with an in-house option.', lastAgo: 9 * DAY },
  ];

  const leads: LeadDTO[] = leadSpec.map((l) => ({
    id: `demo_lead_${l.who.key.replace('demo_c_', '')}`,
    customerId: l.who.key,
    name: l.who.name,
    email: l.who.email,
    phoneMasked: null,
    source: 'email',
    eventType: l.eventType,
    eventDate: l.eventDate,
    location: l.location,
    guestCount: l.guests,
    stage: l.stage,
    notes: l.notes,
    lastContactAt: iso(now, l.lastAgo),
    nextAction: l.next,
    inquiryCount: Math.max(1, l.inboxIds?.length ?? 1),
    actionIds: l.actionIds ?? [],
    callIds: l.callIds ?? [],
    inboxIds: l.inboxIds ?? [],
    derived: false,
  }));

  const customers: CustomerDTO[] = leads.map((lead) => {
    const key = lead.customerId;
    const tl: TimelineEventDTO[] = [];
    for (const id of lead.actionIds) tl.push(...(actionById.get(id)?.timeline ?? []));
    for (const id of lead.inboxIds) {
      const m = inbox.find((i) => i.id === id);
      if (m && !m.actionId) {
        tl.push({ id: `${id}_rx`, at: m.receivedAt, kind: 'email_received', title: 'Email received', detail: m.subject, actor: lead.name, tone: 'neutral' });
      }
    }
    for (const id of lead.callIds) {
      const c = calls.find((x) => x.id === id);
      if (c) tl.push({ id: `${id}_tl`, at: c.startedAt, kind: 'call_completed', title: 'Owner voice review call', detail: c.outcome, actor: 'Pacific Ops · voice', tone: c.tone });
    }
    if (lead.stage === 'BOOKED') {
      tl.push({ id: `${lead.id}_book`, at: iso(now, 2 * DAY + HOUR), kind: 'note', title: 'Booking confirmed', detail: 'Signed agreement received', actor: 'Owner', tone: 'success' });
    }
    if (tl.length === 0) {
      tl.push({ id: `${lead.id}_note`, at: lead.lastContactAt, kind: 'note', title: lead.stage === 'LOST' ? 'Marked lost' : 'Closed', detail: lead.notes, actor: 'Owner', tone: 'neutral' });
    }
    tl.sort((a, b) => a.at.localeCompare(b.at));
    return {
      id: key,
      name: lead.name,
      email: lead.email,
      lead,
      firstSeenAt: tl[0].at,
      lastSeenAt: lead.lastContactAt,
      messageCount: lead.inboxIds.length,
      timeline: tl,
    };
  });

  /* ----------------------- summary / health / analytics ----------------------- */
  const pending = actions.filter((a) => a.status === 'AWAITING_APPROVAL');
  const commandCenter: CommandCenterDTO = {
    counts: {
      inbox: inbox.length,
      needsAttention: inbox.filter((i) => i.status === 'NEW').length,
      pendingApprovals: pending.length,
      drafted: pending.length,
      sent: actions.filter((a) => a.status === 'SENT').length,
      failed: 0,
      activeLeads: leads.filter((l) => l.stage !== 'CLOSED' && l.stage !== 'LOST').length,
      calls: calls.filter((c) => c.relay === 'connected').length,
      callsToday: 2,
    },
    presence: {
      state: 'awaiting_approval',
      headline: `${pending.length} approvals required`,
      reason: pending[0].subject,
      since: pending[0].createdAt,
      liveCallId: null,
    },
    lastCallAt: calls[0].startedAt,
    lastAgentRunAt: iso(now, 4 * MIN),
  };

  const checkedAt = new Date(now).toISOString();
  const health: SystemHealthDTO = {
    overall: 'healthy',
    components: [
      { key: 'gmail', label: 'Gmail', status: 'online', detail: 'Business account · recent activity', checkedAt },
      { key: 'twilio', label: 'Twilio', status: 'online', detail: 'Calls connecting', checkedAt },
      { key: 'voice', label: 'Pacific Ops', status: 'online', detail: 'Voice gateway responding', checkedAt },
      { key: 'agent', label: 'Agent', status: 'online', detail: 'Classifier ready', checkedAt },
    ],
  };

  const series = (values: number[]) =>
    values.map((value, i) => ({ date: new Date(now - (values.length - 1 - i) * DAY).toISOString().slice(0, 10), value }));

  const analytics: AnalyticsDTO = {
    windowDays: 30,
    emailsReceived: 64,
    responsesSent: 23,
    medianApprovalToSendSec: 2.1,
    medianReceiveToSendSec: 2.6 * HOUR / 1000,
    pendingApprovals: pending.length,
    callsCompleted: 17,
    callsFailed: 2,
    leadsCreated: 21,
    leadsContacted: 15,
    approvalSources: [
      { source: 'voice', count: 19 },
      { source: 'cli', count: 4 },
    ],
    categories: [
      { category: 'booking_inquiry', count: 27 },
      { category: 'system_notification', count: 14 },
      { category: 'event_logistics', count: 8 },
      { category: 'vendor_or_marketing', count: 7 },
      { category: 'quote_followup', count: 5 },
      { category: 'payment', count: 3 },
    ],
    activityByDay: series([12, 18, 9, 4, 3, 21, 26, 17, 14, 22, 8, 5, 19, 24]),
    emailsByDay: series([4, 6, 3, 1, 1, 7, 8, 5, 4, 6, 2, 1, 6, 7]),
  };

  return { inbox, actions, calls, activity, leads, customers, commandCenter, health, analytics };
}

function find<T extends { id: string }>(list: T[], id: string, what: string): T {
  const item = list.find((x) => x.id === id);
  if (!item) throw new NotFoundError(what);
  return item;
}

export function createDemoServices(latencyMs = 220): PacificServices {
  const data = buildDemoDataset();
  const wait = <T,>(value: () => T): Promise<T> =>
    new Promise((resolve, reject) =>
      setTimeout(() => {
        try {
          resolve(structuredClone(value()));
        } catch (err) {
          reject(err);
        }
      }, latencyMs)
    );

  return {
    kind: 'demo',
    dashboard: {
      getCommandCenter: () => wait(() => data.commandCenter),
      getHealth: () => wait(() => data.health),
      getAnalytics: () => wait(() => data.analytics),
    },
    mailbox: {
      listInbox: () => wait(() => data.inbox),
      getInboxItem: (id) => wait(() => find(data.inbox, id, 'Message')),
    },
    actions: {
      listActions: () => wait(() => data.actions),
      getAction: (id) => wait(() => find(data.actions, id, 'Action')),
    },
    calls: {
      listCalls: () => wait(() => data.calls),
      getCall: (id) => wait(() => find(data.calls, id, 'Call')),
    },
    leads: {
      listLeads: () => wait(() => data.leads),
      listCustomers: () => wait(() => data.customers),
      getCustomer: (id) => wait(() => find(data.customers, id, 'Customer')),
    },
    activity: {
      listActivity: (limit = 100) => wait(() => data.activity.slice(0, limit)),
    },
    calendar: {
      getHub: ({ view, date, sourceIds }) => wait(() => demoCalendarHub(view, date ?? null, sourceIds)),
    },
    realtime: {
      subscribe({ onLinkState }) {
        onLinkState('demo');
        return () => {};
      },
    },
    // DEMO: a fixed runtime derived from the sample command center. No voice session is ever active.
    runtime: {
      getState: () => wait(() => demoRuntime(data.commandCenter.presence.state)),
      subscribe({ onState, onLink }) {
        onLink('demo');
        onState(demoRuntime(data.commandCenter.presence.state));
        return () => {};
      },
    },
  };
}

function demoRuntime(state: RuntimeStateDTO['state']): RuntimeStateDTO {
  return {
    state,
    sessionActive: false,
    sessionId: null,
    operation: null,
    task: null,
    status: 'Demo data',
    context: null,
    at: null,
    settledBy: 'none',
    voiceGateway: 'unknown',
  };
}

/**
 * DEMO Calendar Hub: three sample calendars across two accounts, with a cross-account
 * Saturday conflict, an all-day event, a multi-day event and a busy-only personal
 * calendar. Clearly sample data, never real events. Times are in America/Los_Angeles.
 */
const DEMO_TZ = 'America/Los_Angeles';
const DEMO_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DEMO_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function demoKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function demoAdd(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number);
  return demoKey(new Date(Date.UTC(y, m - 1, d + n)));
}
function demoWeekday(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
/** Instant at local wall time in DEMO_TZ (offset-corrected, DST-safe). */
function demoAt(key: string, h = 0, min = 0): string {
  const [y, m, d] = key.split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d, h, min);
  const offsetAt = (t: number) => {
    const p: Record<string, string> = {};
    for (const x of new Intl.DateTimeFormat('en-US', { timeZone: DEMO_TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(t))) p[x.type] = x.value;
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - t;
  };
  let t = wall - offsetAt(wall);
  t = wall - offsetAt(t);
  return new Date(t).toISOString();
}

function demoCalendarHub(view: CalendarHubView, date: string | null, sourceIds: string[] | null): CalendarHubDTO {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: DEMO_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const anchor = view === 'today' || view === 'upcoming' || !date ? today : date;
  let days: string[];
  let label: string;
  let prev = anchor;
  let next = anchor;
  const [ay, am] = anchor.split('-').map(Number);
  if (view === 'month') {
    const first = `${ay}-${String(am).padStart(2, '0')}-01`;
    const nextMonth = demoKey(new Date(Date.UTC(ay, am, 1)));
    const last = demoAdd(nextMonth, -1);
    const gridStart = demoAdd(first, -demoWeekday(first));
    const gridEnd = demoAdd(last, 6 - demoWeekday(last));
    days = [];
    for (let k = gridStart; k <= gridEnd; k = demoAdd(k, 1)) days.push(k);
    label = `${DEMO_MONTHS[am - 1]} ${ay}`;
    prev = demoKey(new Date(Date.UTC(ay, am - 2, 1)));
    next = nextMonth;
  } else if (view === 'week') {
    const sunday = demoAdd(anchor, -demoWeekday(anchor));
    days = Array.from({ length: 7 }, (_, i) => demoAdd(sunday, i));
    const [, sm, sd] = sunday.split('-').map(Number);
    const [ey, em, ed] = days[6].split('-').map(Number);
    label = sm === em ? `${DEMO_MONTHS[sm - 1]} ${sd}–${ed}, ${ey}` : `${DEMO_MONTHS[sm - 1].slice(0, 3)} ${sd} – ${DEMO_MONTHS[em - 1].slice(0, 3)} ${ed}, ${ey}`;
    prev = demoAdd(anchor, -7);
    next = demoAdd(anchor, 7);
  } else if (view === 'day' || view === 'today') {
    days = [anchor];
    const [, , dd] = anchor.split('-').map(Number);
    label = `${DEMO_DAYS[demoWeekday(anchor)]}, ${DEMO_MONTHS[am - 1]} ${dd}`;
    prev = demoAdd(anchor, -1);
    next = demoAdd(anchor, 1);
  } else {
    days = Array.from({ length: 7 }, (_, i) => demoAdd(today, i));
    label = 'Upcoming';
  }

  const sources = [
    { sourceId: 'business.0', profileId: 'business', profileLabel: 'Business', calendarLabel: 'Primary', label: 'Business · Primary', privacy: 'titles' as const },
    { sourceId: 'business.1', profileId: 'business', profileLabel: 'Business', calendarLabel: 'Bookings', label: 'Business · Bookings', privacy: 'titles' as const },
    { sourceId: 'personal.0', profileId: 'personal', profileLabel: 'Personal', calendarLabel: 'Primary', label: 'Personal · Primary', privacy: 'busy_only' as const },
  ];
  const chosen = sourceIds?.length ? sources.filter((s) => sourceIds.includes(s.sourceId)) : sources;
  const saturday = demoAdd(today, (6 - demoWeekday(today) + 7) % 7 || 7);
  const raw = [
    { id: 'd1', title: 'Client walkthrough', src: 0, start: demoAt(demoAdd(today, 1), 10), end: demoAt(demoAdd(today, 1), 11) },
    { id: 'd2', title: 'Personal event', src: 2, start: demoAt(demoAdd(today, 1), 14), end: demoAt(demoAdd(today, 1), 15) },
    { id: 'd3', title: 'Garcia booth booking', src: 1, start: demoAt(saturday, 18), end: demoAt(saturday, 20) },
    { id: 'd4', title: 'Personal event', src: 2, start: demoAt(saturday, 19), end: demoAt(saturday, 21) },
    { id: 'd5', title: 'Equipment check', src: 0, start: demoAt(saturday, 16), end: demoAt(saturday, 17) },
    { id: 'd6', title: 'Booth maintenance', src: 1, start: demoAt(demoAdd(today, 3)), end: demoAt(demoAdd(today, 4)), allDay: true },
    { id: 'd7', title: 'Expo setup', src: 1, start: demoAt(demoAdd(today, 8), 9), end: demoAt(demoAdd(today, 10), 17) },
    { id: 'd8', title: 'Team sync', src: 0, start: demoAt(today, 9), end: demoAt(today, 9, 30) },
  ];
  const rangeStart = view === 'upcoming' ? new Date().toISOString() : demoAt(days[0]);
  const rangeEnd = view === 'upcoming' ? demoAt(demoAdd(today, 14)) : demoAt(demoAdd(days[days.length - 1], 1));
  const visible = raw
    .filter((e) => chosen.includes(sources[e.src]) && e.end > rangeStart && e.start < rangeEnd)
    .sort((a, b) => a.start.localeCompare(b.start));
  const overlapping = (a: (typeof raw)[number], b: (typeof raw)[number]) => a !== b && !a.allDay && !b.allDay && a.start < b.end && b.start < a.end;
  const events = visible.map((e) => {
    const src = sources[e.src];
    const clashes = visible.filter((o) => overlapping(e, o));
    return {
      id: e.id,
      title: e.title,
      start: e.start,
      end: e.end,
      allDay: !!e.allDay,
      busy: true,
      sourceId: src.sourceId,
      profileLabel: src.profileLabel,
      calendarLabel: src.calendarLabel,
      sourceLabel: src.label,
      conflict: clashes.length > 0,
      crossAccountConflict: clashes.some((o) => sources[o.src].profileId !== src.profileId),
    };
  });
  const availability = days.map((d) => {
    const ws = demoAt(d, 8);
    const we = demoAt(d, 22);
    const busy = visible
      .filter((e) => e.end > ws && e.start < we)
      .map((e) => ({ start: e.start < ws ? ws : e.start, end: e.end > we ? we : e.end }))
      .sort((a, b) => a.start.localeCompare(b.start))
      .reduce<Array<{ start: string; end: string }>>((acc, b) => {
        const last = acc[acc.length - 1];
        if (last && b.start <= last.end) last.end = b.end > last.end ? b.end : last.end;
        else acc.push({ ...b });
        return acc;
      }, []);
    const free: Array<{ start: string; end: string }> = [];
    let cur = ws;
    for (const b of busy) {
      if (b.start > cur) free.push({ start: cur, end: b.start });
      if (b.end > cur) cur = b.end;
    }
    if (we > cur) free.push({ start: cur, end: we });
    return { date: d, window: { start: ws, end: we }, status: 'complete' as const, busy, free };
  });

  return {
    generatedAt: new Date().toISOString(),
    timeZone: DEMO_TZ,
    view,
    range: { start: rangeStart, end: rangeEnd, label },
    nav: { anchor, today, prev, next },
    days: days.map((d) => ({ date: d, weekday: demoWeekday(d), isToday: d === today, inPeriod: view !== 'month' || d.slice(0, 7) === anchor.slice(0, 7) })),
    scope: { mode: sourceIds?.length ? 'filtered' : 'all', label: sourceIds?.length ? chosen.map((c) => c.label).join(' + ') : 'All calendars', sourceIds: chosen.map((c) => c.sourceId) },
    status: 'complete',
    failures: [],
    profiles: [
      { profileId: 'business', label: 'Business', sourceIds: ['business.0', 'business.1'], connection: 'connected' },
      { profileId: 'personal', label: 'Personal', sourceIds: ['personal.0'], connection: 'connected' },
    ],
    sources: sources.map((s) => ({ ...s, selected: chosen.includes(s), status: chosen.includes(s) ? ('connected' as const) : null })),
    events,
    availability,
    voice: null,
  };
}
