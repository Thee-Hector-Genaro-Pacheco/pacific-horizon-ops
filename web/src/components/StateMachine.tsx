import type { ActionStatusDTO } from '../data/contract';
import { cn } from '../lib/cn';

const HAPPY_PATH: ActionStatusDTO[] = ['RECEIVED', 'CLASSIFIED', 'DRAFTED', 'AWAITING_APPROVAL', 'APPROVED', 'EXECUTING', 'SENT'];

const LABEL: Partial<Record<ActionStatusDTO, string>> = {
  AWAITING_APPROVAL: 'AWAITING',
  EXECUTION_FAILED: 'EXEC FAILED',
};

/**
 * Read-only view of where an action sits in the deterministic backend state machine
 * (src/actions/transitions.ts). Terminal off-path states replace the remaining steps.
 */
export function StateMachine({ status }: { status: ActionStatusDTO }) {
  const idx = HAPPY_PATH.indexOf(status === 'EXECUTED' ? 'SENT' : status);
  const offPath = idx === -1;
  const steps = offPath ? [...HAPPY_PATH.slice(0, 4), status] : HAPPY_PATH;
  const current = offPath ? steps.length - 1 : idx;

  return (
    <ol className="state-machine" aria-label={`Action state: ${status}`}>
      {steps.map((s, i) => (
        <li key={s} style={{ display: 'contents' }}>
          <span
            className={cn(i < current && 'is-done', i === current && 'is-current')}
            aria-current={i === current ? 'step' : undefined}
            style={
              i === current && (status === 'SENT' || status === 'EXECUTED')
                ? { color: 'var(--ok)', borderColor: 'rgba(62,203,133,0.35)', background: 'var(--ok-soft)' }
                : i === current && offPath && status !== 'REJECTED'
                  ? { color: 'var(--fail)', borderColor: 'rgba(239,90,95,0.35)', background: 'var(--fail-soft)' }
                  : undefined
            }
          >
            {LABEL[s] ?? s}
          </span>
          {i < steps.length - 1 && <span aria-hidden style={{ border: 0, padding: 0, color: 'var(--text-4)' }}>→</span>}
        </li>
      ))}
    </ol>
  );
}
