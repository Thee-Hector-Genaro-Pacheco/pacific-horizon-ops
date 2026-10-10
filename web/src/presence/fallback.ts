import { framingFor } from './engine';
import { buildGeometry, CORE_POINT, FACE_CENTER, FIGURE_KINDS, KIND } from './geometry';
import { paramsFor, type PacificOpsState } from './states';

/**
 * Static Canvas 2D rendering of the formed presence. Used when WebGL is unavailable,
 * the context is lost, or the user prefers reduced data. Same geometry and framing as
 * the WebGL engine, single frame, drawn onto a transparent canvas over the stage's
 * near-black background (never a white or empty surface).
 */
export function drawStaticPresence(canvas: HTMLCanvasElement, state: PacificOpsState, framing: 'hero' | 'compact') {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || 400;
  const h = canvas.clientHeight || 360;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'lighter';

  const p = paramsFor(state);
  const geo = buildGeometry(5200, 11);
  const { zoom, centerY } = framingFor(framing, w / h);
  const yaw = 0.3;

  const glow = (x: number, y: number, r: number, color: string) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  };

  const project = (x: number, y: number, z: number) => {
    const rx = Math.cos(yaw) * x + Math.sin(yaw) * z;
    const rz = -Math.sin(yaw) * x + Math.cos(yaw) * z;
    const persp = (2.35 * zoom) / Math.max(0.5, 4.4 - rz);
    return [w / 2 + ((rx * persp) / (w / h)) * (w / 2), h / 2 - (y - centerY) * persp * (h / 2), persp] as const;
  };

  const [fx, fy] = project(...FACE_CENTER);
  const [cx, cy] = project(...CORE_POINT);
  if (p.amber > 0.05) glow(fx, fy, h * 0.16, `rgba(239,165,69,${0.16 * p.amber})`);
  glow(cx, cy, h * 0.09, `rgba(180,240,248,${0.22 * p.core})`);

  for (let i = 0; i < geo.count; i++) {
    const kind = geo.info[i * 4 + 1];
    const layer = geo.extra[i * 4 + 1];
    if (kind === KIND.orbit || kind === KIND.stream || kind === KIND.glow || kind === KIND.ring) continue;
    if (kind === KIND.ambient && layer > 1.5) continue;
    const figure = FIGURE_KINDS.has(kind);
    const dissolve = geo.extra[i * 4];
    const seed = geo.info[i * 4];
    // Mirror the shader's assembly: a particle shows formed once the state's form passes its threshold.
    const formed = !figure || seed * 0.6 + 0.06 < p.form * 1.12 * (1 - dissolve * 0.6);
    const src = formed ? geo.target : geo.scatter;
    const [sx, sy, persp] = project(src[i * 3], src[i * 3 + 1], src[i * 3 + 2]);
    if (sx < -4 || sx > w + 4 || sy < -4 || sy > h + 4) continue;

    let alpha = 0.2;
    let color = '80,215,235';
    if (kind === KIND.ambient) alpha = layer > 0.5 ? 0.12 : 0.2;
    else if (kind === KIND.contour || kind === KIND.neural) alpha = 0.6;
    else if (kind === KIND.core) {
      alpha = 0.85;
      color = '210,248,255';
    } else if (kind === KIND.cognition) {
      alpha = 0.3 + 0.5 * p.amber;
      color = '239,165,69';
    } else if (kind === KIND.fragment) {
      alpha = 0.35;
      if (p.red > 0 && seed > 0.55) color = '255,92,97';
    } else if (kind === KIND.ribbon) alpha = 0.45;
    else if (kind === KIND.surface) alpha = 0.32;
    if (!formed) alpha *= 0.4;

    ctx.fillStyle = `rgba(${color},${Math.min(1, alpha * p.energy * 1.3)})`;
    const r = Math.max(0.7, (kind === KIND.core ? 1.6 : 1.0) * persp * 1.6);
    ctx.fillRect(sx - r / 2, sy - r / 2, r, r);
  }
}
