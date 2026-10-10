import { describe, expect, it } from 'vitest';
import { ACTION_STATUS, INBOX_STATUS, LEAD_STAGES, opsAvailability } from './status';

describe('status vocabulary', () => {
  it('reserves red for real failures only', () => {
    const failing = Object.entries(ACTION_STATUS).filter(([, m]) => m.tone === 'tone-fail').map(([k]) => k);
    expect(failing.sort()).toEqual(['EXECUTION_FAILED', 'FAILED']);
    expect(Object.entries(INBOX_STATUS).filter(([, m]) => m.tone === 'tone-fail').map(([k]) => k)).toEqual(['FAILED']);
  });
  it('uses amber for approval-required states', () => {
    expect(ACTION_STATUS.AWAITING_APPROVAL.tone).toBe('tone-warn');
    expect(INBOX_STATUS.AWAITING_APPROVAL.tone).toBe('tone-warn');
  });
  it('covers the full lead pipeline in order', () => {
    expect(LEAD_STAGES.map((s) => s.stage)).toEqual(['NEW', 'QUALIFIED', 'CONTACTED', 'QUOTE_PREPARED', 'AWAITING_CUSTOMER', 'BOOKED', 'CLOSED', 'LOST']);
  });
  it('only reports Pacific Ops ONLINE when the voice gateway responds', () => {
    expect(opsAvailability('online', 'healthy').label).toBe('Online');
    expect(opsAvailability('offline', 'degraded').label).toBe('Standby');
    expect(opsAvailability('online', 'down').label).toBe('Offline');
    expect(opsAvailability(undefined, undefined).label).toBe('Checking');
  });
});
