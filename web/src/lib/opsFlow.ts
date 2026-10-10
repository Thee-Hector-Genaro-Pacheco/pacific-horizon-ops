import type { CommandCenterDTO, RuntimeStateDTO } from '../data/contract';

/**
 * The operational story the Command Center tells: input → intelligence → decision →
 * approval → execution. Derived only from real state: the live runtime during a voice
 * session, read-model counts otherwise. Nothing here implies an approval or a send
 * that the backend has not reported.
 */

export type FlowStageKey = 'inbox' | 'pacific_ops' | 'draft' | 'approval' | 'execution';
export type FlowStageStatus = 'idle' | 'done' | 'active' | 'attention' | 'fault';

export interface FlowStage {
  key: FlowStageKey;
  label: string;
  status: FlowStageStatus;
  /** Short real value, e.g. "1 new"; null when there is nothing honest to show. */
  detail: string | null;
}

const ORDER: FlowStageKey[] = ['inbox', 'pacific_ops', 'draft', 'approval', 'execution'];
const LABEL: Record<FlowStageKey, string> = {
  inbox: 'Inbox',
  pacific_ops: 'Pacific Ops',
  draft: 'Draft',
  approval: 'Approval',
  execution: 'Execution',
};

function activeStage(runtime: RuntimeStateDTO): FlowStageKey | null {
  if (runtime.state === 'executing' || runtime.state === 'success' || runtime.state === 'error' || runtime.operation === 'send_email') {
    return 'execution';
  }
  if (runtime.state === 'awaiting_approval' || runtime.operation === 'approval') return 'approval';
  if (runtime.operation === 'draft_review') return 'draft';
  if (runtime.operation === 'message_review') return 'pacific_ops';
  if (runtime.operation === 'mailbox_review' || runtime.operation === 'call') return 'inbox';
  return null;
}

export function deriveOpsFlow(
  runtime: RuntimeStateDTO | null,
  sessionActive: boolean,
  counts: CommandCenterDTO['counts'] | undefined
): FlowStage[] {
  const live = sessionActive && runtime ? activeStage(runtime) : null;

  if (live && runtime) {
    const at = ORDER.indexOf(live);
    return ORDER.map((key, i) => {
      let status: FlowStageStatus = i < at ? 'done' : i === at ? 'active' : 'idle';
      if (key === live && key === 'approval') status = 'attention';
      if (key === live && key === 'execution') {
        status = runtime.state === 'success' ? 'done' : runtime.state === 'error' ? 'fault' : 'active';
      }
      const detail =
        key === live
          ? runtime.state === 'success'
            ? 'Sent'
            : runtime.state === 'error'
              ? 'Failed'
              : key === 'approval'
                ? 'Awaiting you'
                : key === 'execution'
                  ? 'Sending'
                  : 'Now'
          : null;
      return { key, label: LABEL[key], status, detail };
    });
  }

  // Ambient: real queue sizes, no live position.
  return ORDER.map((key) => {
    let detail: string | null = null;
    let status: FlowStageStatus = 'idle';
    if (counts) {
      if (key === 'inbox' && counts.needsAttention > 0) detail = `${counts.needsAttention} new`;
      if (key === 'draft' && counts.drafted > 0) detail = `${counts.drafted} drafted`;
      if (key === 'approval' && counts.pendingApprovals > 0) {
        detail = `${counts.pendingApprovals} waiting`;
        status = 'attention';
      }
      if (key === 'execution' && counts.failed > 0) {
        detail = `${counts.failed} failed`;
        status = 'fault';
      } else if (key === 'execution' && counts.sent > 0) detail = `${counts.sent} sent`;
    }
    if (key === 'pacific_ops') detail = sessionActive ? 'In call' : 'Standing by';
    return { key, label: LABEL[key], status, detail };
  });
}
