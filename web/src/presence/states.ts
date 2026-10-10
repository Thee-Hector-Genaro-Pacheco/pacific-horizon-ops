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
  /** slow ambient drift speed multiplier (low = suspended) */
  drift: number;
  /** peripheral particles pulled inward toward the form (listening) */
  converge: number;
  /** activity of pulses travelling along neural pathways */
  neural: number;
  /** visibility of the slowly rotating data rings */
  rings: number;
}

export const STATE_PARAMS: Record<PacificOpsState, PresenceParams> = {
  // Partially resolved (~70% form), slow drift, quiet chest pulse.
  idle: { form: 0.62, energy: 0.8, amber: 0.16, core: 0.45, orbit: 0.1, stream: 0, wave: 0, scan: 0.35, jitter: 0, red: 0, green: 0, voice: 0, drift: 1, converge: 0, neural: 0.35, rings: 0.5 },
  // Face assembles, periphery converges, cyan rings radiate from the head.
  listening: { form: 0.78, energy: 0.92, amber: 0.2, core: 0.6, orbit: 0.08, stream: 0, wave: 1, scan: 0.5, jitter: 0, red: 0, green: 0, voice: 0, drift: 0.7, converge: 0.75, neural: 0.5, rings: 0.6 },
  // Amber cognition field rises, neural traces orbit the head.
  thinking: { form: 0.86, energy: 0.95, amber: 0.95, core: 0.62, orbit: 1, stream: 0, wave: 0.1, scan: 0.7, jitter: 0, red: 0, green: 0, voice: 0, drift: 0.6, converge: 0.3, neural: 1, rings: 0.9 },
  // Contours pulse with audio; neck and chest pathways react.
  speaking: { form: 0.97, energy: 1, amber: 0.5, core: 0.85, orbit: 0.15, stream: 0, wave: 0.2, scan: 0.25, jitter: 0, red: 0, green: 0, voice: 1, drift: 0.55, converge: 0.2, neural: 0.8, rings: 0.6 },
  // Restrained amber, motion suspended.
  awaiting_approval: { form: 0.84, energy: 0.82, amber: 0.7, core: 0.5, orbit: 0.04, stream: 0, wave: 0, scan: 0.3, jitter: 0, red: 0, green: 0, voice: 0, drift: 0.22, converge: 0.15, neural: 0.4, rings: 0.4 },
  // Chest core intensifies, streams leave the core.
  executing: { form: 0.92, energy: 1, amber: 0.3, core: 1, orbit: 0.3, stream: 1, wave: 0, scan: 0.45, jitter: 0, red: 0, green: 0, voice: 0, drift: 0.6, converge: 0.2, neural: 0.9, rings: 0.8 },
  // Clean cyan-to-green pulse; form briefly stabilises.
  success: { form: 1, energy: 0.95, amber: 0.12, core: 0.85, orbit: 0, stream: 0, wave: 0, scan: 0, jitter: 0, red: 0, green: 0.5, voice: 0, drift: 0.5, converge: 0.3, neural: 0.5, rings: 0.6 },
  // Mild decoherence; red stays on localized diagnostic fragments only.
  error: { form: 0.6, energy: 0.66, amber: 0, core: 0.25, orbit: 0, stream: 0, wave: 0, scan: 0, jitter: 1, red: 1, green: 0, voice: 0, drift: 1.2, converge: 0, neural: 0.1, rings: 0.2 },
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
