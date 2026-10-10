import { describe, expect, it } from 'vitest';
import type { CommandCenterDTO, RuntimeStateDTO } from '../data/contract';
import { deriveOpsFlow } from './opsFlow';

const rt = (over: Partial<RuntimeStateDTO>): RuntimeStateDTO => ({
  state: 'idle', sessionActive: true, sessionId: 's', operation: null, task: null, status: '', context: null, at: null, settledBy: 'none', voiceGateway: 'online', ...over,
});
const counts = { inbox: 9, needsAttention: 1, pendingApprovals: 2, drafted: 2, sent: 3, failed: 0, activeLeads: 7, calls: 2, callsToday: 2 } as CommandCenterDTO['counts'];
const statuses = (f: ReturnType<typeof deriveOpsFlow>) => f.map((s) => s.status);

describe('operational flow', () => {
  it('ambient: shows real queue sizes and no live position', () => {
    const f = deriveOpsFlow(null, false, counts);
    expect(f.map((s) => s.detail)).toEqual(['1 new', 'Standing by', '2 drafted', '2 waiting', '3 sent']);
    expect(statuses(f)).toEqual(['idle', 'idle', 'idle', 'attention', 'idle']);
  });

  it('ambient without data shows nothing invented', () => {
    expect(deriveOpsFlow(null, false, undefined).map((s) => s.detail)).toEqual([null, 'Standing by', null, null, null]);
  });

  it('live: advances through the real voice journey', () => {
    expect(statuses(deriveOpsFlow(rt({ state: 'listening', operation: 'mailbox_review' }), true, counts))).toEqual(['active', 'idle', 'idle', 'idle', 'idle']);
    expect(statuses(deriveOpsFlow(rt({ state: 'thinking', operation: 'message_review' }), true, counts))).toEqual(['done', 'active', 'idle', 'idle', 'idle']);
    expect(statuses(deriveOpsFlow(rt({ state: 'speaking', operation: 'draft_review' }), true, counts))).toEqual(['done', 'done', 'active', 'idle', 'idle']);
    expect(statuses(deriveOpsFlow(rt({ state: 'awaiting_approval', operation: 'approval' }), true, counts))).toEqual(['done', 'done', 'done', 'attention', 'idle']);
    expect(statuses(deriveOpsFlow(rt({ state: 'executing', operation: 'send_email' }), true, counts))).toEqual(['done', 'done', 'done', 'done', 'active']);
  });

  it('never shows a send as done unless the runtime reported success', () => {
    const exec = deriveOpsFlow(rt({ state: 'executing', operation: 'send_email' }), true, counts);
    expect(exec[4]).toMatchObject({ status: 'active', detail: 'Sending' });
    expect(deriveOpsFlow(rt({ state: 'success', operation: 'send_email' }), true, counts)[4]).toMatchObject({ status: 'done', detail: 'Sent' });
    expect(deriveOpsFlow(rt({ state: 'error', operation: 'send_email' }), true, counts)[4]).toMatchObject({ status: 'fault', detail: 'Failed' });
  });

  it('awaiting approval is attention, never done', () => {
    const f = deriveOpsFlow(rt({ state: 'awaiting_approval', operation: 'approval' }), true, counts);
    expect(f[3]).toMatchObject({ status: 'attention', detail: 'Awaiting you' });
    expect(f[4].status).toBe('idle');
  });
});
