import { describe, expect, it } from 'vitest';
import { framingFor } from './engine';
import { buildGeometry, FIGURE_KINDS, KIND } from './geometry';
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

  it('carries per-point dissolve, depth layer and phase', () => {
    const g = buildGeometry(6000);
    expect(g.extra.length).toBe(g.count * 4);
    for (let i = 0; i < g.count; i++) {
      expect(g.extra[i * 4]).toBeGreaterThanOrEqual(0);
      expect(g.extra[i * 4]).toBeLessThanOrEqual(1);
      expect([0, 1, 2]).toContain(g.extra[i * 4 + 1]);
    }
  });

  it('dissolves the left side more than the right (controlled asymmetry)', () => {
    const g = buildGeometry(11000);
    const side = (sign: number) => {
      let sum = 0;
      let n = 0;
      for (let i = 0; i < g.count; i++) {
        const kind = g.info[i * 4 + 1];
        const x = g.target[i * 3];
        if (!FIGURE_KINDS.has(kind) || x * sign < 0.4) continue;
        sum += g.extra[i * 4];
        n++;
      }
      return sum / n;
    };
    expect(side(-1)).toBeGreaterThan(side(1) + 0.1);
  });

  it('builds the head larger than the shoulders are tall and keeps the chest core', () => {
    const g = buildGeometry(6000);
    const ys = { head: [] as number[], core: 0 };
    for (let i = 0; i < g.count; i++) {
      const kind = g.info[i * 4 + 1];
      if (kind === KIND.surface) ys.head.push(g.target[i * 3 + 1]);
      if (kind === KIND.core) ys.core++;
    }
    const headHeight = Math.max(...ys.head) - Math.min(...ys.head);
    expect(headHeight).toBeGreaterThan(1.2);
    expect(ys.core).toBeGreaterThan(100);
  });

  it('is deterministic for a seed', () => {
    expect(Array.from(buildGeometry(2000, 3).target.slice(0, 60))).toEqual(Array.from(buildGeometry(2000, 3).target.slice(0, 60)));
  });
});

describe('presence framing', () => {
  it('frames portrait / phone stages on the head instead of shrinking the bust', () => {
    const wide = framingFor('hero', 2);
    const tall = framingFor('hero', 0.6);
    expect(tall.centerY).toBeGreaterThan(wide.centerY);
    expect(tall.zoom).toBeGreaterThan(wide.zoom);
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
  it('suspends motion while awaiting approval and converges while listening', () => {
    expect(STATE_PARAMS.awaiting_approval.drift).toBeLessThan(STATE_PARAMS.idle.drift / 2);
    expect(STATE_PARAMS.listening.converge).toBeGreaterThan(STATE_PARAMS.idle.converge);
    expect(STATE_PARAMS.thinking.amber).toBeGreaterThan(STATE_PARAMS.idle.amber);
    expect(STATE_PARAMS.executing.stream).toBe(1);
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
