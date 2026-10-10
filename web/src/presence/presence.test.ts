import { describe, expect, it } from 'vitest';
import { buildGeometry, KIND } from './geometry';
import { PRESENCE_STATES, STATE_PARAMS, STATE_STATUS } from './states';

describe('presence geometry', () => {
  it('builds the requested particle budget with glow sprites first', () => {
    const g = buildGeometry(6000);
    expect(g.count).toBeGreaterThan(5000);
    expect(g.count).toBeLessThan(7000);
    expect(g.target.length).toBe(g.count * 3);
    expect(g.info.length).toBe(g.count * 4);
    for (let i = 0; i < 3; i++) expect(g.info[i * 4 + 1]).toBe(KIND.glow);
    expect(Array.from(g.target).every(Number.isFinite)).toBe(true);
  });

  it('is deterministic for a seed', () => {
    expect(Array.from(buildGeometry(2000, 3).target.slice(0, 60))).toEqual(Array.from(buildGeometry(2000, 3).target.slice(0, 60)));
  });
});

describe('presence states', () => {
  it('defines parameters and a status line for every runtime state', () => {
    expect(PRESENCE_STATES).toHaveLength(8);
    for (const s of PRESENCE_STATES) {
      expect(STATE_PARAMS[s]).toBeDefined();
      expect(STATE_STATUS[s]).toBeTruthy();
    }
  });
  it('keeps red reserved for the error state', () => {
    expect(PRESENCE_STATES.filter((s) => STATE_PARAMS[s].red > 0)).toEqual(['error']);
  });
  it('forms more structure as Pacific Ops becomes active', () => {
    expect(STATE_PARAMS.idle.form).toBeLessThan(STATE_PARAMS.listening.form);
    expect(STATE_PARAMS.listening.form).toBeLessThan(STATE_PARAMS.thinking.form);
    expect(STATE_PARAMS.thinking.form).toBeLessThan(STATE_PARAMS.speaking.form);
  });

  it('matches all specified Pacific Ops states', () => {
    const expected = ['idle', 'listening', 'thinking', 'speaking', 'awaiting_approval', 'executing', 'success', 'error'];
    expect(PRESENCE_STATES).toEqual(expected);
    expect(STATE_STATUS.idle).toBe('PACIFIC OPS • ONLINE');
    expect(STATE_STATUS.listening).toBe('LISTENING');
    expect(STATE_STATUS.thinking).toBe('PROCESSING');
    expect(STATE_STATUS.speaking).toBe('SPEAKING');
    expect(STATE_STATUS.awaiting_approval).toBe('APPROVAL REQUIRED');
    expect(STATE_STATUS.executing).toBe('EXECUTING ACTION');
    expect(STATE_STATUS.success).toBe('ACTION COMPLETE');
  });
});
