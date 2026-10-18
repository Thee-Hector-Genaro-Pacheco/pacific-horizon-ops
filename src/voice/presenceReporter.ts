import type { ActionExecutor } from '../actions/executor.js';
import {
  estimatePlaybackMs,
  type PacificOpsRuntimeEvent,
  type PacificOpsRuntimeState,
  type RuntimeOperation,
} from '../runtime/pacificOpsRuntime.js';
import type { VoiceStore } from './store.js';
import type { VoiceConversationState } from './types.js';

/**
 * Translates real voice-lifecycle moments into Pacific Ops runtime events.
 *
 * Observational only. The reporter never reads action state to make decisions, never
 * calls the action store, and swallows its own failures so a disk or logging problem
 * can never interrupt a call, an approval or a send.
 */

export interface RuntimeSink {
  publish(input: Omit<PacificOpsRuntimeEvent, 'eventId' | 'seq' | 'at'>): unknown;
}

export interface ReporterOptions {
  /** Override for tests; defaults to the shared ConversationRelay playback estimate. */
  playbackMs?: (text: string) => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (msg: string) => void;
}

interface SessionTrack {
  settle: unknown | null;
  executing: boolean;
  outcome: 'success' | 'error' | null;
  last: PacificOpsRuntimeState | null;
  /** Owner speech already reported for the current burst. */
  ownerTalking: boolean;
}

const TASK_BY_CONVERSATION: Record<VoiceConversationState, { task: string; operation: RuntimeOperation }> = {
  GREETING: { task: 'Greeting owner', operation: 'call' },
  MAILBOX_SELECTING: { task: 'Reviewing mailbox', operation: 'mailbox_review' },
  READY: { task: 'Reviewing message', operation: 'message_review' },
  READING_SUMMARY: { task: 'Summarizing message', operation: 'message_review' },
  READING_DRAFT: { task: 'Reviewing draft reply', operation: 'draft_review' },
  AWAITING_APPROVAL_CONFIRMATION: { task: 'Awaiting approval confirmation', operation: 'approval' },
  AWAITING_REJECTION_CONFIRMATION: { task: 'Awaiting rejection confirmation', operation: 'approval' },
  PHOTO_BOOTH_ANALYTICS: { task: 'Photo Booth analytics', operation: 'photo_booth_analytics' },
  CALENDAR: { task: 'Checking calendar', operation: 'calendar_read' },
  COMPLETE: { task: 'Wrapping up', operation: 'wrap_up' },
};

export class VoicePresenceReporter {
  private readonly sessions = new Map<string, SessionTrack>();
  private readonly playbackMs: (text: string) => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly log: (msg: string) => void;

  constructor(
    private readonly sink: RuntimeSink,
    private readonly voiceStore: VoiceStore,
    options: ReporterOptions = {}
  ) {
    this.playbackMs = options.playbackMs ?? estimatePlaybackMs;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref());
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    this.log = options.log ?? ((m) => console.warn(m));
  }

  /** Voice process started: nothing is in progress, whatever an earlier process last wrote. */
  gatewayOnline(): void {
    this.emit(null, 'idle', { source: 'system', status: 'Voice gateway online', sessionActive: false, task: null, operation: null });
  }

  sessionConnected(sessionId: string): void {
    this.track(sessionId);
    this.emit(sessionId, 'idle', { status: 'Voice session connected', task: 'Connecting call', operation: 'call' });
  }

  /**
   * Pacific Ops sent text to ConversationRelay for playback. `stillWorking` marks a progress
   * line spoken while the request is still being handled, so playback settles back to
   * thinking rather than listening.
   */
  speaking(sessionId: string, text: string, opts: { final?: boolean; stillWorking?: boolean } = {}): void {
    const t = this.track(sessionId);
    if (t.executing || t.outcome) return; // the outcome of an action outranks the words describing it
    this.clearSettle(t);
    t.ownerTalking = false;
    this.emit(sessionId, 'speaking', { status: 'Pacific Ops speaking' });
    if (opts.final) return; // the call is ending; sessionEnded() settles it
    t.settle = this.setTimer(() => {
      t.settle = null;
      if (t.executing || t.outcome) return;
      const conv = this.voiceStore.getSession(sessionId)?.conversationState;
      if (conv === 'COMPLETE') return;
      if (opts.stillWorking) {
        this.emit(sessionId, 'thinking', { status: 'Processing request' });
      } else if (conv === 'AWAITING_APPROVAL_CONFIRMATION') {
        this.emit(sessionId, 'awaiting_approval', { status: 'Waiting for “confirm approval”' });
      } else {
        this.emit(sessionId, 'listening', { status: 'Waiting for owner' });
      }
    }, this.playbackMs(text));
  }

  /** Interim speech recognized, or the owner barged in over playback. */
  ownerSpeaking(sessionId: string): void {
    const t = this.track(sessionId);
    if (t.executing || t.outcome) return;
    this.clearSettle(t);
    if (t.ownerTalking) return; // interim chunks arrive in bursts; one event is enough
    t.ownerTalking = true;
    this.emit(sessionId, 'listening', { status: 'Owner speaking' });
  }

  /** A final utterance is being handled. */
  processing(sessionId: string): void {
    const t = this.track(sessionId);
    if (t.executing || t.outcome) return;
    this.clearSettle(t);
    t.ownerTalking = false;
    this.emit(sessionId, 'thinking', { status: 'Processing request' });
  }

  executionStarted(sessionId: string): void {
    const t = this.track(sessionId);
    this.clearSettle(t);
    t.executing = true;
    this.emit(sessionId, 'executing', { status: 'Sending approved email', task: 'Sending email', operation: 'send_email', source: 'executor' });
  }

  executionFinished(sessionId: string, success: boolean): void {
    // The owner may hang up while a send is in flight: report the real outcome anyway,
    // but do not resurrect a session that has already ended.
    const stillConnected = this.sessions.has(sessionId);
    if (stillConnected) {
      const t = this.track(sessionId);
      t.executing = false;
      t.outcome = success ? 'success' : 'error';
    }
    this.emit(sessionId, success ? 'success' : 'error', {
      sessionActive: stillConnected,
      status: success ? 'Email sent' : 'Send failed · not marked as sent',
      task: 'Sending email',
      operation: 'send_email',
      source: 'executor',
    });
  }

  /** A fault reported by ConversationRelay or the socket. Not terminal: later events may recover. */
  fault(sessionId: string, status: string): void {
    const t = this.track(sessionId);
    this.clearSettle(t);
    this.emit(sessionId, 'error', { status });
  }

  sessionEnded(sessionId: string): void {
    const t = this.sessions.get(sessionId);
    if (t) this.clearSettle(t);
    this.sessions.delete(sessionId);
    this.emit(sessionId, 'idle', { status: 'Voice session ended', sessionActive: false, task: null, operation: null });
  }

  /* ---------------------------------------------------------------- */

  private track(sessionId: string): SessionTrack {
    let t = this.sessions.get(sessionId);
    if (!t) {
      t = { settle: null, executing: false, outcome: null, last: null, ownerTalking: false };
      this.sessions.set(sessionId, t);
    }
    return t;
  }

  private clearSettle(t: SessionTrack): void {
    if (t.settle !== null) {
      this.clearTimer(t.settle);
      t.settle = null;
    }
  }

  private emit(
    sessionId: string | null,
    state: PacificOpsRuntimeState,
    over: Partial<Omit<PacificOpsRuntimeEvent, 'eventId' | 'seq' | 'at' | 'state' | 'sessionId'>> & { status: string }
  ): void {
    try {
      const session = sessionId ? this.voiceStore.getSession(sessionId) : null;
      const conv = session?.conversationState;
      const derived = conv ? TASK_BY_CONVERSATION[conv] : null;
      const selected = session?.metadata?.selectedMessage as { senderName?: unknown; subject?: unknown } | null | undefined;
      this.sink.publish({
        state,
        sessionId,
        sessionActive: over.sessionActive ?? sessionId !== null,
        source: over.source ?? 'voice',
        operation: over.operation !== undefined ? over.operation : (derived?.operation ?? null),
        task: over.task !== undefined ? over.task : (derived?.task ?? null),
        status: over.status,
        context: selected ? { senderName: selected.senderName as string, subject: selected.subject as string } : null,
      });
      if (sessionId) {
        const t = this.sessions.get(sessionId);
        if (t) t.last = state;
      }
    } catch (err) {
      this.log(`[voice:presence] runtime event not written (${state}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Wraps an executor so the Command Center can observe execution. The wrapped call,
 * its arguments, its result and any thrown error are passed through unchanged.
 */
export function observeExecutor(executor: ActionExecutor, reporter: VoicePresenceReporter, sessionId: string): ActionExecutor {
  return {
    async executeApprovedAction(actionId, options) {
      reporter.executionStarted(sessionId);
      try {
        const result = await executor.executeApprovedAction(actionId, options);
        reporter.executionFinished(sessionId, result.success);
        return result;
      } catch (err) {
        reporter.executionFinished(sessionId, false);
        throw err;
      }
    },
  };
}
