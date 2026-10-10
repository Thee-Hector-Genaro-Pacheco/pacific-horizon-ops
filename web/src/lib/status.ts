import type {
  ActionStatusDTO,
  ComponentHealth,
  InboxStatus,
  LeadStage,
  PacificOpsState,
  Tone,
} from '../data/contract';

export type ToneClass = 'tone-ok' | 'tone-warn' | 'tone-fail' | 'tone-info' | 'tone-idle';

export interface StatusMeta {
  label: string;
  tone: ToneClass;
  live?: boolean;
}

export function toneClass(tone: Tone): ToneClass {
  switch (tone) {
    case 'success':
      return 'tone-ok';
    case 'attention':
      return 'tone-warn';
    case 'failure':
      return 'tone-fail';
    case 'info':
      return 'tone-info';
    default:
      return 'tone-idle';
  }
}

export const INBOX_STATUS: Record<InboxStatus, StatusMeta> = {
  NEW: { label: 'New', tone: 'tone-info' },
  REVIEWED: { label: 'Reviewed', tone: 'tone-idle' },
  DRAFTED: { label: 'Drafted', tone: 'tone-info' },
  AWAITING_APPROVAL: { label: 'Awaiting approval', tone: 'tone-warn', live: true },
  APPROVED: { label: 'Approved', tone: 'tone-ok' },
  EXECUTING: { label: 'Executing', tone: 'tone-info', live: true },
  SENT: { label: 'Sent', tone: 'tone-ok' },
  REJECTED: { label: 'Rejected', tone: 'tone-idle' },
  SKIPPED: { label: 'Skipped', tone: 'tone-idle' },
  FAILED: { label: 'Failed', tone: 'tone-fail' },
};

export const ACTION_STATUS: Record<ActionStatusDTO, StatusMeta> = {
  RECEIVED: { label: 'Received', tone: 'tone-idle' },
  CLASSIFIED: { label: 'Classified', tone: 'tone-idle' },
  DRAFTED: { label: 'Drafted', tone: 'tone-info' },
  AWAITING_APPROVAL: { label: 'Awaiting approval', tone: 'tone-warn', live: true },
  APPROVED: { label: 'Approved', tone: 'tone-ok' },
  REJECTED: { label: 'Rejected', tone: 'tone-idle' },
  EXECUTING: { label: 'Executing', tone: 'tone-info', live: true },
  SENT: { label: 'Sent', tone: 'tone-ok' },
  EXECUTED: { label: 'Executed', tone: 'tone-ok' },
  EXECUTION_FAILED: { label: 'Execution failed', tone: 'tone-fail' },
  FAILED: { label: 'Failed', tone: 'tone-fail' },
};

export const LEAD_STAGES: Array<{ stage: LeadStage; label: string }> = [
  { stage: 'NEW', label: 'New' },
  { stage: 'QUALIFIED', label: 'Qualified' },
  { stage: 'CONTACTED', label: 'Contacted' },
  { stage: 'QUOTE_PREPARED', label: 'Quote prepared' },
  { stage: 'AWAITING_CUSTOMER', label: 'Awaiting customer' },
  { stage: 'BOOKED', label: 'Booked' },
  { stage: 'CLOSED', label: 'Closed' },
  { stage: 'LOST', label: 'Lost' },
];

export const LEAD_STAGE: Record<LeadStage, StatusMeta> = {
  NEW: { label: 'New', tone: 'tone-info' },
  QUALIFIED: { label: 'Qualified', tone: 'tone-info' },
  CONTACTED: { label: 'Contacted', tone: 'tone-idle' },
  QUOTE_PREPARED: { label: 'Quote prepared', tone: 'tone-warn' },
  AWAITING_CUSTOMER: { label: 'Awaiting customer', tone: 'tone-idle' },
  BOOKED: { label: 'Booked', tone: 'tone-ok' },
  CLOSED: { label: 'Closed', tone: 'tone-idle' },
  LOST: { label: 'Lost', tone: 'tone-idle' },
};

export const HEALTH: Record<ComponentHealth, StatusMeta> = {
  online: { label: 'Connected', tone: 'tone-ok', live: true },
  configured: { label: 'Configured', tone: 'tone-ok' },
  degraded: { label: 'Degraded', tone: 'tone-warn' },
  offline: { label: 'Offline', tone: 'tone-fail' },
  unknown: { label: 'Unknown', tone: 'tone-idle' },
};

export const PRESENCE_STATE: Record<PacificOpsState, { label: string; tone: ToneClass }> = {
  idle: { label: 'Online', tone: 'tone-ok' },
  listening: { label: 'Listening', tone: 'tone-info' },
  thinking: { label: 'Processing', tone: 'tone-info' },
  speaking: { label: 'Speaking', tone: 'tone-info' },
  awaiting_approval: { label: 'Approval required', tone: 'tone-warn' },
  executing: { label: 'Executing action', tone: 'tone-info' },
  success: { label: 'Action complete', tone: 'tone-ok' },
  error: { label: 'Fault', tone: 'tone-fail' },
};

export const CATEGORY_LABEL: Record<string, string> = {
  booking_inquiry: 'Booking inquiry',
  quote_followup: 'Quote follow-up',
  event_logistics: 'Event logistics',
  payment: 'Payment',
  reschedule_or_cancel: 'Reschedule / cancel',
  post_event: 'Post-event',
  vendor_or_marketing: 'Vendor / marketing',
  system_notification: 'System notice',
  personal: 'Personal',
  other: 'Other',
  voice_test: 'Voice test',
  general: 'General',
};

export function categoryLabel(category: string | null | undefined): string {
  if (!category) return 'Unclassified';
  return CATEGORY_LABEL[category] ?? category.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/**
 * Overall Pacific Ops agent status shown in the persistent status pill.
 * ONLINE only when the voice gateway actually responds.
 */
export function opsAvailability(voice: ComponentHealth | undefined, overall: 'healthy' | 'degraded' | 'down' | undefined): {
  label: string;
  tone: ToneClass;
  live: boolean;
} {
  if (!voice || !overall) return { label: 'Checking', tone: 'tone-idle', live: false };
  if (overall === 'down') return { label: 'Offline', tone: 'tone-fail', live: false };
  if (voice === 'online') return { label: 'Online', tone: 'tone-ok', live: true };
  return { label: 'Standby', tone: 'tone-idle', live: false };
}
