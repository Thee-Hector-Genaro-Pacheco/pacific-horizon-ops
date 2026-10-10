import type { PacificOpsState } from '../data/contract';

export type { PacificOpsState };

/**
 * Visual parameters per runtime state. The engine eases between these, so state
 * changes animate as continuous transitions rather than cuts. This table is the
 * only place that decides what a state looks like.
 */
export interface PresenceParams {
  /** 0 dispersed -> 1 fully formed head and torso */
  form: number;
  /** overall cyan energy / brightness */
  energy: number;
  /** amber processing glow around the face centre */
  amber: number;
  /** chest core intensity */
  core: number;
  /** orbit tracers around the head (thinking) */
  orbit: number;
  /** outbound data streams from the core (executing) */
  stream: number;
  /** concentric waveform rings (listening) */
  wave: number;
  /** vertical scan sweep */
  scan: number;
  /** structural instability (error) */
  jitter: number;
  /** red fault tint */
  red: number;
  /** green success tint */
  green: number;
  /** synthetic voice activity when no audio level is supplied */
  voice: number;
  /** slow ambient drift speed multiplier */
  drift: number;
}

export const STATE_PARAMS: Record<PacificOpsState, PresenceParams> = {
  idle: { form: 0.3, energy: 0.72, amber: 0.06, core: 0.38, orbit: 0, stream: 0, wave: 0, scan: 0.25, jitter: 0, red: 0, green: 0, voice: 0, drift: 1 },
  listening: { form: 0.62, energy: 0.9, amber: 0.12, core: 0.6, orbit: 0, stream: 0, wave: 1, scan: 0.55, jitter: 0, red: 0, green: 0, voice: 0, drift: 0.8 },
  thinking: { form: 0.84, energy: 0.95, amber: 0.85, core: 0.65, orbit: 1, stream: 0, wave: 0.15, scan: 0.8, jitter: 0, red: 0, green: 0, voice: 0, drift: 0.7 },
  speaking: { form: 1, energy: 1, amber: 0.55, core: 0.9, orbit: 0.15, stream: 0, wave: 0.25, scan: 0.2, jitter: 0, red: 0, green: 0, voice: 1, drift: 0.6 },
  awaiting_approval: { form: 0.8, energy: 0.82, amber: 0.6, core: 0.5, orbit: 0, stream: 0, wave: 0, scan: 0.35, jitter: 0, red: 0, green: 0, voice: 0, drift: 0.8 },
  executing: { form: 0.92, energy: 1, amber: 0.3, core: 1, orbit: 0.3, stream: 1, wave: 0, scan: 0.4, jitter: 0, red: 0, green: 0, voice: 0, drift: 0.7 },
  success: { form: 0.95, energy: 0.95, amber: 0.12, core: 0.8, orbit: 0, stream: 0, wave: 0, scan: 0, jitter: 0, red: 0, green: 0.4, voice: 0, drift: 0.7 },
  error: { form: 0.55, energy: 0.62, amber: 0, core: 0.22, orbit: 0, stream: 0, wave: 0, scan: 0, jitter: 1, red: 1, green: 0, voice: 0, drift: 1.2 },
};

export const PRESENCE_STATES: PacificOpsState[] = [
  'idle',
  'listening',
  'thinking',
  'speaking',
  'awaiting_approval',
  'executing',
  'success',
  'error',
];

/** Operator-facing status line for each state. */
export const STATE_STATUS: Record<PacificOpsState, string> = {
  idle: 'PACIFIC OPS • ONLINE',
  listening: 'LISTENING',
  thinking: 'PROCESSING',
  speaking: 'SPEAKING',
  awaiting_approval: 'APPROVAL REQUIRED',
  executing: 'EXECUTING ACTION',
  success: 'ACTION COMPLETE',
  error: 'FAULT DETECTED',
};

export function paramsFor(state: PacificOpsState): PresenceParams {
  return STATE_PARAMS[state] ?? STATE_PARAMS.idle;
}
