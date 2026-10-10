import { buildGeometry, CORE_POINT, FACE_CENTER, KIND } from './geometry';
import { paramsFor, type PacificOpsState } from './states';

/**
 * Static Canvas 2D rendering of the formed presence. Used when WebGL is unavailable,
 * the context is lost, or the user prefers reduced data. Same geometry, single frame.
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
  const geo = buildGeometry(3200, 11);
  const compact = framing === 'compact';
  const zoom = (compact ? 1.3 : 0.94) * Math.min(1, w / h / (compact ? 0.6 : 0.82));
  const centerY = compact ? -0.08 : -0.24;
  const yaw = 0.18;

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
    return [w / 2 + ((rx * persp) / (w / h)) * (w / 2), h / 2 - (y - centerY) * persp * (h / 2), rz] as const;
  };

  const [fx, fy] = project(...FACE_CENTER);
  const [cx, cy] = project(...CORE_POINT);
  if (p.amber > 0.05) glow(fx, fy, h * 0.18, `rgba(239,165,69,${0.18 * p.amber})`);
  glow(cx, cy, h * 0.1, `rgba(180,240,248,${0.25 * p.core})`);

  for (let i = 0; i < geo.count; i++) {
    const kind = geo.info[i * 4 + 1];
    if (kind === KIND.orbit || kind === KIND.stream || kind === KIND.glow) continue;
    const ambient = kind === KIND.ambient;
    const src = ambient ? geo.target : p.form > 0.5 || kind === KIND.core ? geo.target : geo.scatter;
    const [sx, sy] = project(src[i * 3], src[i * 3 + 1], src[i * 3 + 2]);
    const y = geo.target[i * 3 + 1];
    if (!ambient && y < -1.75) continue;
    const alpha = ambient ? 0.18 : kind === KIND.contour ? 0.55 : kind === KIND.core ? 0.9 : 0.3;
    ctx.fillStyle = kind === KIND.core ? `rgba(225,250,255,${alpha})` : `rgba(80,215,235,${alpha * p.energy})`;
    const r = kind === KIND.core ? 1.4 : 0.8;
    ctx.fillRect(sx - r / 2, sy - r / 2, r, r);
  }
}
