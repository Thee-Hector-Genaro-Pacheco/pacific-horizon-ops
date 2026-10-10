/**
 * Procedural point cloud for the Pacific Ops presence.
 *
 * An abstract, implied head and upper torso built from contour rings, meridians and
 * sparse surface samples. No eyes, skin or likeness: only the structural cues
 * (brow, nose ridge, jaw, shoulders) needed to read as a presence.
 *
 * Coordinates: y up, +z toward the viewer. Head centre ~ (0, 0.55, 0).
 */

export const KIND = {
  surface: 0,
  contour: 1,
  torso: 2,
  core: 3,
  ambient: 4,
  orbit: 5,
  stream: 6,
  glow: 7,
} as const;

export const HEAD_CENTER: [number, number, number] = [0, 0.47, 0];
export const FACE_CENTER: [number, number, number] = [0, 0.36, 0.46];
export const CORE_POINT: [number, number, number] = [0, -0.98, 0.36];

export interface PresenceGeometry {
  count: number;
  /** Formed position (xyz). */
  target: Float32Array;
  /** Dispersed position (xyz). */
  scatter: Float32Array;
  /** seed, kind, band (0..1 parametric position), size */
  info: Float32Array;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const bell = (t: number, c: number, s: number) => Math.exp(-(((t - c) / s) ** 2));
const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** t in [-1, 1] (chin -> crown), theta: 0 faces the viewer. */
export function headPoint(t: number, theta: number): [number, number, number] {
  const y = HEAD_CENTER[1] + 0.64 * t;
  let w = Math.sqrt(Math.max(0, 1 - t * t));
  if (t < 0.1) w *= 1 - 0.3 * smooth(0.1, -1, t) - 0.12 * smooth(-0.55, -1, t); // rounded jaw taper toward the chin
  if (t > -0.1 && t < 0.5) w *= 1 + 0.04 * Math.sin(((t + 0.1) / 0.6) * Math.PI); // temples / cheek fullness
  if (t > 0.5) w *= 1 - 0.1 * ((t - 0.5) / 0.5); // softer crown
  const front = Math.cos(theta);
  let x = 0.53 * w * Math.sin(theta);
  let z = (front >= 0 ? 0.52 : 0.6) * w * front;
  if (front > 0) z *= 0.9 + 0.1 * (1 - front); // flatten the face plane slightly

  const a = Math.abs(theta);
  const facing = front > 0 ? 1 : 0;
  const bump =
    facing *
    (Math.exp(-((theta / 0.15) ** 2)) * bell(t, -0.1, 0.2) * 0.085 + // nose ridge
      Math.exp(-(((a - 0.42) / 0.3) ** 2)) * bell(t, 0.22, 0.07) * 0.032 + // brow
      Math.exp(-(((a - 0.4) / 0.16) ** 2)) * bell(t, 0.08, 0.08) * -0.05 + // orbital recess (no eyes)
      Math.exp(-(((a - 0.78) / 0.25) ** 2)) * bell(t, -0.06, 0.12) * 0.022 + // cheekbone
      Math.exp(-((theta / 0.3) ** 2)) * bell(t, -0.46, 0.06) * 0.016 + // lip line
      Math.exp(-((theta / 0.36) ** 2)) * bell(t, -0.74, 0.1) * 0.032); // chin
  x += Math.sin(theta) * bump;
  z += Math.cos(theta) * bump;
  return [x, y, z];
}

/** u in [-1, 1] across the shoulders, v in [0, 1] downward. Front surface unless `back`. */
export function torsoPoint(u: number, v: number, back = false): [number, number, number] {
  const a = Math.abs(u);
  const halfWidth = 1.16 + 0.04 * v;
  // Shoulder line: flat at the neck base, trapezius slope, then a rounded deltoid.
  const trap = 0.2 * smooth(0.14, 0.62, a);
  const deltoid = 0.2 * Math.pow(smooth(0.68, 1, a), 2);
  const yTop = -0.47 - trap - deltoid;
  const y = yTop - v * 1.3;
  // Arms fall away slightly at the outer edge so the silhouette rounds off.
  const x = u * halfWidth * (1 - 0.07 * smooth(0.75, 1, a) * (1 - v));
  const chest = 0.26 + 0.06 * smooth(0, 0.35, v);
  const zf = chest * Math.sqrt(Math.max(0, 1 - Math.pow(a, 2.4))) + 0.05;
  return [x, y, back ? -zf * 0.8 : zf];
}

function neckPoint(theta: number, h: number): [number, number, number] {
  const r = 0.18 + 0.05 * h;
  return [r * Math.sin(theta), -0.08 - 0.42 * h, r * Math.cos(theta) * 0.9 + 0.0];
}

export function buildGeometry(total: number, seed = 7): PresenceGeometry {
  const rand = mulberry32(seed);
  const pts: Array<{ p: [number, number, number]; kind: number; band: number; size: number }> = [];
  const push = (p: [number, number, number], kind: number, band: number, size: number) => pts.push({ p, kind, band, size });
  const frontTheta = (exp: number) => (rand() < 0.5 ? -1 : 1) * Math.PI * Math.pow(rand(), exp);

  const n = (f: number) => Math.max(8, Math.round(total * f));

  // Head surface scatter, biased toward the face.
  for (let i = 0, c = n(0.2); i < c; i++) {
    const t = rand() * 2 - 1;
    push(headPoint(t * 0.98, frontTheta(1.45)), KIND.surface, (t + 1) / 2, 1.15 + rand() * 0.5);
  }

  // Horizontal contour rings (scan lines describing the face).
  const rings = 30;
  const ringPts = n(0.17);
  for (let i = 0; i < ringPts; i++) {
    const r = Math.floor(rand() * rings);
    const t = -0.94 + (r / (rings - 1)) * 1.86;
    const theta = (rand() * 2 - 1) * Math.PI;
    if (Math.cos(theta) < -0.2 && rand() < 0.7) continue; // thin out the back
    push(headPoint(t, theta), KIND.contour, (t + 1) / 2, 1.5);
  }

  // Meridians across the face.
  const meridians = [-0.95, -0.66, -0.4, -0.2, 0, 0.2, 0.4, 0.66, 0.95];
  for (let i = 0, c = n(0.05); i < c; i++) {
    const theta = meridians[Math.floor(rand() * meridians.length)];
    const t = rand() * 1.9 - 0.95;
    push(headPoint(t, theta), KIND.contour, (t + 1) / 2, 1.35);
  }

  // Neck.
  for (let i = 0, c = n(0.04); i < c; i++) {
    push(neckPoint(frontTheta(1.2), rand()), KIND.torso, 0.5, 1.1);
  }

  // Torso surface (front dense, back sparse).
  for (let i = 0, c = n(0.16); i < c; i++) {
    const back = rand() < 0.1;
    const v = Math.pow(rand(), 0.85);
    push(torsoPoint(rand() * 2 - 1, v, back), KIND.torso, v, 1.05 + rand() * 0.4);
  }

  // Torso contour lines + sternum line.
  for (let i = 0, c = n(0.08); i < c; i++) {
    const edge = rand();
    if (edge < 0.3) {
      // Shoulder silhouette, the strongest line of the torso.
      push(torsoPoint(rand() * 2 - 1, rand() * 0.015), KIND.contour, 0.5, 1.45);
    } else if (edge < 0.45) {
      const v = rand() * 0.9;
      push(torsoPoint(0, v), KIND.contour, 0.5 + v * 0.5, 1.3);
    } else {
      const line = Math.floor(rand() * 9);
      const v = 0.04 + line * 0.1;
      push(torsoPoint(rand() * 2 - 1, v), KIND.contour, 0.5 + v * 0.5, 1.3);
    }
  }

  // Energy core (chest node).
  for (let i = 0, c = n(0.025); i < c; i++) {
    const ring = rand() < 0.45;
    const a = rand() * Math.PI * 2;
    const r = ring ? 0.085 + rand() * 0.012 : Math.abs(gauss(rand) * 0.032);
    push([CORE_POINT[0] + Math.cos(a) * r, CORE_POINT[1] + Math.sin(a) * r, CORE_POINT[2] + gauss(rand) * 0.01], KIND.core, ring ? 1 : 0, ring ? 1.4 : 2.2);
  }

  // Ambient dust.
  for (let i = 0, c = n(0.11); i < c; i++) {
    const dir = unit(rand);
    const r = 1.5 + rand() * 2.2;
    push([dir[0] * r * 1.25, dir[1] * r * 0.75 - 0.3, dir[2] * r * 0.6], KIND.ambient, rand(), 0.9 + rand() * 1.1);
  }

  // Orbit tracers (thinking) and outbound streams (executing).
  for (let i = 0, c = n(0.06); i < c; i++) push([0, 0, 0], KIND.orbit, rand(), 1.4);
  for (let i = 0, c = n(0.08); i < c; i++) push([0, 0, 0], KIND.stream, rand(), 1.5);

  // Shuffle so any prefix is a representative sample (adaptive quality draws a prefix).
  for (let i = pts.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pts[i], pts[j]] = [pts[j], pts[i]];
  }

  // Soft holographic ambient glow nodes
  const glows: typeof pts = [
    { p: FACE_CENTER, kind: KIND.glow, band: 0, size: 70 },
    { p: CORE_POINT, kind: KIND.glow, band: 1, size: 55 },
    { p: [0, 0.2, 0], kind: KIND.glow, band: 0.5, size: 110 },
  ];
  const all = [...glows, ...pts];

  const count = all.length;
  const target = new Float32Array(count * 3);
  const scatter = new Float32Array(count * 3);
  const info = new Float32Array(count * 4);

  all.forEach((pt, i) => {
    const [x, y, z] = pt.p;
    target.set([x, y, z], i * 3);

    let s: [number, number, number];
    if (pt.kind === KIND.ambient || pt.kind === KIND.glow) {
      s = [x, y, z];
    } else if (pt.kind === KIND.stream || pt.kind === KIND.orbit) {
      const d = unit(rand);
      const r = 1.2 + rand() * 2.2;
      s = [d[0] * r, d[1] * r * 0.8 - 0.2, d[2] * r * 0.7];
    } else {
      // Dissolve outward and slightly upward from the formed position.
      const d = unit(rand);
      const r = 0.45 + Math.pow(rand(), 0.6) * 1.7;
      s = [x * 1.2 + d[0] * r, y * 1.05 + d[1] * r * 0.8 + 0.1, z + d[2] * r * 0.8];
    }
    scatter.set(s, i * 3);
    info.set([rand(), pt.kind, pt.band, pt.size], i * 4);
  });

  return { count, target, scatter, info };
}

function gauss(rand: () => number): number {
  const u = Math.max(1e-6, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

function unit(rand: () => number): [number, number, number] {
  const z = rand() * 2 - 1;
  const a = rand() * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  return [r * Math.cos(a), r * Math.sin(a), z];
}
