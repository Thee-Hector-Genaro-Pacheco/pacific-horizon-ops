/**
 * Procedural point cloud for the Pacific Ops presence (V2).
 *
 * An intelligence materialising from data rather than a drawn body:
 *   - a large, elongated head made of layered contour shells, facial planes and
 *     surface neural pathways, with an amber cognition lattice inside it
 *   - no torso surface to speak of: shoulders are curved data ribbons, the chest is
 *     implied by field lines converging on a ringed cyan core
 *   - controlled asymmetry: the right side is assembled, the left side and the lower
 *     body dissolve into telemetry fragments
 *   - three depth layers (far field, mid dust, near defocused particles) plus slowly
 *     rotating data rings for volume
 *
 * No eyes, skin, likeness or helmet: only structural cues (brow, nose ridge, cheek,
 * jaw) needed to read as a presence.
 *
 * Coordinates: y up, +z toward the viewer. Head centre ~ (0, 0.62, 0).
 *
 * Per-point attributes:
 *   target  formed position (for KIND.ring: radius, height, tilt)
 *   scatter dispersed position
 *   info    seed, kind, band (0..1 parametric position), size
 *   extra   dissolve weight (0..1), depth layer (0 figure/mid, 1 far, 2 near),
 *           phase (shared along a path so pulses travel coherently), spare
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
  cognition: 8,
  neural: 9,
  ribbon: 10,
  field: 11,
  fragment: 12,
  ring: 13,
  plane: 14,
} as const;

export const HEAD_CENTER: [number, number, number] = [0, 0.62, 0];
/** Centre of the amber cognition lattice, inside the head behind the brow. */
export const FACE_CENTER: [number, number, number] = [0, 0.7, 0.16];
export const CORE_POINT: [number, number, number] = [0, -0.74, 0.3];

/** Kinds that make up the formed entity (as opposed to atmosphere and effects). */
export const FIGURE_KINDS: ReadonlySet<number> = new Set([
  KIND.surface,
  KIND.contour,
  KIND.torso,
  KIND.core,
  KIND.cognition,
  KIND.neural,
  KIND.ribbon,
  KIND.field,
  KIND.plane,
]);

export interface PresenceGeometry {
  count: number;
  target: Float32Array;
  scatter: Float32Array;
  info: Float32Array;
  extra: Float32Array;
}

type Vec3 = [number, number, number];

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

/**
 * t in [-1, 1] (chin -> crown), theta: 0 faces the viewer. `shell` scales the surface
 * outward for the translucent contour shells.
 */
export function headPoint(t: number, theta: number, shell = 1): Vec3 {
  const y = HEAD_CENTER[1] + 0.7 * t * (0.97 + 0.03 * shell);
  let w = Math.sqrt(Math.max(0, 1 - t * t));
  if (t < 0.0) w *= 1 - 0.16 * smooth(0.0, -1, t) - 0.26 * smooth(-0.5, -1, t); // cheek-to-jaw taper into an oval chin
  if (t > -0.1 && t < 0.55) w *= 1 + 0.035 * Math.sin(((t + 0.1) / 0.65) * Math.PI); // temples
  if (t > 0.55) w *= 1 - 0.08 * ((t - 0.55) / 0.45); // elongated crown
  const front = Math.cos(theta);
  let x = 0.5 * w * Math.sin(theta) * shell;
  let z = (front >= 0 ? 0.5 : 0.58) * w * front * shell;
  if (front > 0) z *= 0.9 + 0.1 * (1 - front);

  const a = Math.abs(theta);
  const facing = front > 0 ? 1 : 0;
  const bump =
    facing *
    (Math.exp(-((theta / 0.14) ** 2)) * bell(t, -0.1, 0.2) * 0.075 + // nose ridge
      Math.exp(-(((a - 0.42) / 0.3) ** 2)) * bell(t, 0.2, 0.07) * 0.03 + // brow
      Math.exp(-(((a - 0.4) / 0.16) ** 2)) * bell(t, 0.07, 0.08) * -0.045 + // orbital recess (no eyes)
      Math.exp(-(((a - 0.78) / 0.25) ** 2)) * bell(t, -0.08, 0.12) * 0.024 + // cheekbone
      Math.exp(-((theta / 0.36) ** 2)) * bell(t, -0.76, 0.1) * 0.03); // chin
  x += Math.sin(theta) * bump * shell;
  z += Math.cos(theta) * bump * shell;
  return [x, y, z];
}

/** Kept for compatibility with callers that sample a generic chest surface. */
export function torsoPoint(u: number, v: number, back = false): Vec3 {
  const a = Math.abs(u);
  const yTop = -0.36 - 0.22 * smooth(0.12, 0.65, a) - 0.18 * Math.pow(smooth(0.7, 1, a), 2);
  const y = yTop - v * 1.25;
  const x = u * (1.08 + 0.04 * v);
  const zf = (0.24 + 0.06 * smooth(0, 0.35, v)) * Math.sqrt(Math.max(0, 1 - Math.pow(a, 2.4))) + 0.05;
  return [x, y, back ? -zf * 0.8 : zf];
}

function cubic(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, u: number): Vec3 {
  const v = 1 - u;
  const a = v * v * v;
  const b = 3 * v * v * u;
  const c = 3 * v * u * u;
  const d = u * u * u;
  return [
    a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
    a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
    a * p0[2] + b * p1[2] + c * p2[2] + d * p3[2],
  ];
}

/** Left side dissolves more than the right; everything dissolves toward the waist. */
function dissolveAt(p: Vec3, rand: () => number): number {
  const side = smooth(-0.2, -1.1, p[0]) * 0.48;
  const low = smooth(-1.05, -1.75, p[1]);
  const back = smooth(-0.05, -0.4, p[2]) * 0.35;
  return Math.min(1, Math.max(side * (0.55 + 0.45 * rand()), low, back * rand()));
}

export function buildGeometry(total: number, seed = 7): PresenceGeometry {
  const rand = mulberry32(seed);
  interface Pt {
    p: Vec3;
    kind: number;
    band: number;
    size: number;
    dissolve: number;
    layer: number;
    phase: number;
  }
  const pts: Pt[] = [];
  const push = (p: Vec3, kind: number, band: number, size: number, o: Partial<Pick<Pt, 'dissolve' | 'layer' | 'phase'>> = {}) =>
    pts.push({ p, kind, band, size, dissolve: o.dissolve ?? dissolveAt(p, rand), layer: o.layer ?? 0, phase: o.phase ?? rand() });
  const n = (f: number) => Math.max(6, Math.round(total * f));
  const frontTheta = (exp: number) => (rand() < 0.5 ? -1 : 1) * Math.PI * Math.pow(rand(), exp);

  // ---- Head -------------------------------------------------------------------------

  // Fine point cloud, densest across forehead, cheeks and jaw.
  for (let i = 0, c = n(0.17); i < c; i++) {
    let t = rand() * 2 - 1;
    if (rand() < 0.35) t = (rand() < 0.5 ? 0.35 + rand() * 0.3 : -0.6 + rand() * 0.5); // forehead / cheek-jaw bias
    push(headPoint(t * 0.98, frontTheta(1.55)), KIND.surface, (t + 1) / 2, 1.0 + rand() * 0.45);
  }

  // Translucent contour shells: inner shell dense, outer shells sparse partial arcs.
  const shells = [
    { s: 1.0, rings: 34, f: 0.085, arc: 1.0 },
    { s: 1.075, rings: 16, f: 0.035, arc: 0.55 },
    { s: 1.15, rings: 9, f: 0.02, arc: 0.32 },
  ];
  for (const sh of shells) {
    for (let i = 0, c = n(sh.f); i < c; i++) {
      const r = Math.floor(rand() * sh.rings);
      const t = -0.86 + (r / (sh.rings - 1)) * 1.8;
      // Points per ring proportional to its circumference, so small rings near the chin
      // and crown do not condense into bright knots.
      if (rand() > Math.sqrt(Math.max(0, 1 - t * t))) continue;
      // Outer shells only exist as front arcs, offset per ring so they read as fragments.
      const centre = (r * 0.37) % 1.2 - 0.6;
      const theta = sh.arc >= 1 ? (rand() * 2 - 1) * Math.PI : centre + (rand() * 2 - 1) * Math.PI * sh.arc;
      if (Math.cos(theta) < -0.2 && rand() < 0.75) continue;
      push(headPoint(t, theta, sh.s), KIND.contour, (t + 1) / 2, sh.s > 1 ? 1.15 : 1.4, { phase: r / sh.rings });
    }
  }

  // Facial planes: layered translucent plates floating just off the face.
  const planes = [
    { t0: 0.28, t1: 0.58, th: 0.85, off: 1.04 }, // forehead
    { t0: -0.42, t1: 0.0, th: 0.32, off: 1.05 }, // mid-face
    { t0: -0.2, t1: 0.12, th: 0.55, off: 1.09 }, // cheek plane, offset further
  ];
  for (let i = 0, c = n(0.045); i < c; i++) {
    const pl = planes[Math.floor(rand() * planes.length)];
    const t = pl.t0 + rand() * (pl.t1 - pl.t0);
    let theta = (rand() * 2 - 1) * pl.th;
    if (pl === planes[2]) theta = (rand() < 0.5 ? -1 : 1) * (0.55 + rand() * 0.45);
    push(headPoint(t, theta, pl.off), KIND.plane, (t + 1) / 2, 1.05);
  }

  // Feature lines: the few contours that make the shell read as a face.
  const feature = (fn: (u: number) => [number, number], frac: number, size = 1.45) => {
    const phase = rand();
    for (let i = 0, c = n(frac); i < c; i++) {
      const u = rand();
      const [t, th] = fn(u);
      push(headPoint(t, th, 1.012), KIND.contour, u, size, { phase });
    }
  };
  for (const sd of [1, -1]) {
    feature((u) => [0.22 + 0.025 * Math.sin(u * Math.PI) - 0.07 * u * u, sd * (0.12 + u * 0.7)], 0.006, 1.3); // brow arc, falling to the temple
    feature((u) => [-0.06 - 0.03 * Math.sin(u * Math.PI), sd * (0.55 + u * 0.55)], 0.007, 1.3); // cheekbone
    // Jawline: a quarter-ellipse from below the ear round to the chin.
    feature((u) => [-0.1 - 0.74 * Math.pow(Math.sin((u * Math.PI) / 2), 1.25), sd * (0.04 + 1.36 * Math.cos((u * Math.PI) / 2))], 0.012);
    feature((u) => [0.62 - u * 0.5, sd * 1.35], 0.006, 1.2); // temple / profile edge
  }
  feature((u) => [0.16 - u * 0.48, 0.0], 0.008, 1.5); // nose ridge
  feature((u) => [-0.47, (u * 2 - 1) * 0.28], 0.003, 1.2); // lip line (no mouth)

  // Surface neural pathways: wandering paths that carry travelling pulses.
  for (let pth = 0, paths = 16; pth < paths; pth++) {
    let t = rand() * 1.5 - 0.7;
    let th = (rand() * 2 - 1) * 1.3;
    const steps = Math.max(10, Math.round((total * 0.05) / paths));
    let dirT = (rand() - 0.5) * 0.08;
    let dirTh = (rand() - 0.5) * 0.12;
    const phase = rand();
    for (let s = 0; s < steps; s++) {
      dirT += (rand() - 0.5) * 0.03;
      dirTh += (rand() - 0.5) * 0.04;
      dirT = Math.max(-0.06, Math.min(0.06, dirT));
      dirTh = Math.max(-0.09, Math.min(0.09, dirTh));
      t = Math.max(-0.9, Math.min(0.92, t + dirT * 0.5));
      th = Math.max(-1.6, Math.min(1.6, th + dirTh * 0.5));
      push(headPoint(t, th, 0.985), KIND.neural, s / (steps - 1), 1.25, { phase });
    }
  }

  // Cognition lattice: filaments looping around a point inside the head, not a ball.
  for (let fil = 0, fils = 12; fil < fils; fil++) {
    const d = unit(rand);
    const bend = unit(rand);
    const len = 0.1 + rand() * 0.16;
    const steps = Math.max(8, Math.round((total * 0.022) / fils));
    const phase = rand();
    for (let s = 0; s < steps; s++) {
      const u = s / (steps - 1);
      const r = 0.025 + len * u;
      const wob = Math.sin(u * Math.PI) * 0.05;
      push(
        [
          FACE_CENTER[0] + d[0] * r * 1.1 + bend[0] * wob,
          FACE_CENTER[1] + d[1] * r * 0.9 + bend[1] * wob,
          FACE_CENTER[2] + d[2] * r * 0.6 + bend[2] * wob,
        ],
        KIND.cognition,
        u,
        1.2,
        { dissolve: 0, phase }
      );
    }
  }

  // ---- Neck / spine: vertical pathways from jaw to core --------------------------------

  for (let strand = 0, strands = 6; strand < strands; strand++) {
    const x0 = (strand / (strands - 1) - 0.5) * 0.4;
    const phase = rand();
    const steps = Math.max(10, Math.round((total * 0.03) / strands));
    const p0: Vec3 = [x0 * 0.9, -0.02, 0.1 - Math.abs(x0) * 0.4];
    const p3: Vec3 = [CORE_POINT[0] + x0 * 0.2, CORE_POINT[1] + 0.05, CORE_POINT[2]];
    const p1: Vec3 = [x0 * 1.05, -0.28, 0.1];
    const p2: Vec3 = [x0 * 0.75, -0.52, 0.26];
    for (let s = 0; s < steps; s++) {
      const u = s / (steps - 1);
      const p = cubic(p0, p1, p2, p3, u);
      push([p[0] + (rand() - 0.5) * 0.008, p[1], p[2] + (rand() - 0.5) * 0.008], KIND.neural, u, 1.2, { phase });
    }
  }

  // Sparse neck contours give the column volume without drawing a solid neck.
  for (let i = 0, c = n(0.012); i < c; i++) {
    const h = 0.25 + (Math.floor(rand() * 4) / 3) * 0.75;
    const th = (rand() * 2 - 1) * Math.PI * 0.75;
    const r = 0.2 + 0.04 * h;
    push([r * Math.sin(th), -0.06 - 0.3 * h, r * Math.cos(th) * 0.85], KIND.contour, 0.45, 1.1, { phase: h });
  }

  // ---- Shoulders: curved data ribbons ------------------------------------------------

  for (const s of [1, -1]) {
    for (let r = 0, ribbons = 6; r < ribbons; r++) {
      const p0: Vec3 = [s * (0.14 + r * 0.01), -0.2 - r * 0.028, 0.02 - r * 0.01];
      const p1: Vec3 = [s * 0.6, -0.27 - r * 0.035, 0.08 - r * 0.02];
      const p2: Vec3 = [s * 1.06, -0.48 - r * 0.05, -0.02 - r * 0.02];
      const p3: Vec3 = [s * (1.2 + r * 0.02), -0.98 - r * 0.09, -0.14];
      const steps = Math.max(12, Math.round((total * 0.075) / 12));
      const phase = rand();
      for (let k = 0; k < steps; k++) {
        const u = k / (steps - 1);
        // Left ribbons are broken into segments and fade out early.
        if (s < 0 && Math.sin(u * 19 + r * 2.3) > 0.7) continue;
        if (s < 0 && u > 0.62 + r * 0.04 && rand() < 0.55) continue;
        const p = cubic(p0, p1, p2, p3, u);
        const jitter = 0.006 + u * 0.01;
        push([p[0] + (rand() - 0.5) * jitter, p[1] + (rand() - 0.5) * jitter, p[2] + (rand() - 0.5) * jitter], KIND.ribbon, u, 1.2, { phase });
      }
    }
    // Clavicle arc.
    for (let k = 0, steps = n(0.006); k < steps; k++) {
      const u = k / (steps - 1);
      push([s * (0.05 + u * 0.5), -0.4 + 0.07 * Math.sin(u * Math.PI) - u * 0.02, 0.22 - u * 0.1], KIND.contour, 0.4, 1.25, { phase: 0.3 });
    }
  }

  // ---- Chest: field lines converging on the core ---------------------------------------

  for (let line = 0, lines = 18; line < lines; line++) {
    const ang = Math.PI * (0.05 + 0.9 * (line / (lines - 1))) + (rand() - 0.5) * 0.1; // upper arc
    const sideAng = rand() < 0.3 ? -ang : ang; // a few lines from below
    const r0 = 0.55 + rand() * 0.4;
    const start: Vec3 = [CORE_POINT[0] + Math.cos(sideAng) * r0 * 1.3, CORE_POINT[1] + Math.sin(sideAng) * r0 * 0.75, 0.12];
    const bendDir = rand() < 0.5 ? -1 : 1;
    const steps = Math.max(8, Math.round((total * 0.04) / lines));
    const phase = rand();
    for (let k = 0; k < steps; k++) {
      const u = k / (steps - 1);
      const e = u * u * (3 - 2 * u);
      const x = start[0] + (CORE_POINT[0] - start[0]) * e + bendDir * Math.sin(u * Math.PI) * 0.08;
      const y = start[1] + (CORE_POINT[1] - start[1]) * e;
      const z = start[2] + (CORE_POINT[2] - start[2]) * e + Math.sin(u * Math.PI) * 0.06;
      push([x, y, z], KIND.field, u, 1.0, { phase });
    }
  }

  // Sparse implied chest surface (upper only).
  for (let i = 0, c = n(0.04); i < c; i++) {
    const v = Math.pow(rand(), 1.4) * 0.6;
    push(torsoPoint(rand() * 2 - 1, v), KIND.torso, v, 0.95 + rand() * 0.35);
  }

  // ---- Chest core: nucleus, rings, radial field dashes -------------------------------

  for (let i = 0, c = n(0.04); i < c; i++) {
    const roll = rand();
    const a = rand() * Math.PI * 2;
    if (roll < 0.3) {
      const r = Math.abs(gauss(rand) * 0.024);
      push([CORE_POINT[0] + Math.cos(a) * r, CORE_POINT[1] + Math.sin(a) * r, CORE_POINT[2] + gauss(rand) * 0.01], KIND.core, 0, 2.1, { dissolve: 0 });
    } else if (roll < 0.8) {
      const ring = Math.floor(rand() * 3);
      const r = [0.065, 0.12, 0.19][ring] + gauss(rand) * 0.002;
      push([CORE_POINT[0] + Math.cos(a) * r, CORE_POINT[1] + Math.sin(a) * r * 0.96, CORE_POINT[2] + 0.01], KIND.core, 0.25 + ring * 0.25, 1.3, { dissolve: 0, phase: ring / 3 });
    } else {
      const r = 0.23 + rand() * 0.17;
      const spoke = Math.round((a / (Math.PI * 2)) * 24) / 24 * Math.PI * 2;
      push([CORE_POINT[0] + Math.cos(spoke) * r, CORE_POINT[1] + Math.sin(spoke) * r * 0.9, CORE_POINT[2] - 0.02], KIND.core, 1, 1.0, { dissolve: 0, phase: rand() });
    }
  }

  // ---- Dissolution: telemetry fragments ----------------------------------------------

  for (let frag = 0, budget = n(0.045); frag < budget; ) {
    const len = 3 + Math.floor(rand() * 5);
    const left = rand() < 0.4;
    const base: Vec3 = left
      ? [-0.45 - rand() * 1.0, -0.3 + rand() * 1.4, (rand() - 0.5) * 0.6] // left side, beside head and shoulder
      : [(rand() * 2 - 1) * 1.1, -1.1 - rand() * 0.9, (rand() - 0.3) * 0.5]; // lower body
    const phase = rand();
    for (let k = 0; k < len; k++, frag++) {
      push([base[0] + k * 0.016, base[1], base[2]], KIND.fragment, k / len, 1.15, { dissolve: 1, phase });
    }
  }

  // ---- Atmosphere: three depth layers ------------------------------------------------

  for (let i = 0, c = n(0.05); i < c; i++) {
    const dir = unit(rand);
    const r = 1.5 + rand() * 1.8;
    push([dir[0] * r * 1.25, dir[1] * r * 0.75 - 0.3, dir[2] * r * 0.6], KIND.ambient, rand(), 0.85 + rand() * 0.9, { dissolve: 0, layer: 0 });
  }
  for (let i = 0, c = n(0.075); i < c; i++) {
    push([(rand() * 2 - 1) * 6.5, (rand() * 2 - 1) * 3.6 - 0.2, -1.4 - rand() * 3.2], KIND.ambient, rand(), 0.6 + rand() * 0.6, { dissolve: 0, layer: 1 });
  }
  for (let i = 0, c = n(0.01); i < c; i++) {
    const side = rand() < 0.5 ? -1 : 1;
    push([side * (0.9 + rand() * 1.4), (rand() * 2 - 1) * 1.2, 1.6 + rand() * 1.0], KIND.ambient, rand(), 4 + rand() * 6, { dissolve: 0, layer: 2 });
  }

  // Data rings: target holds (radius, height, tilt); positions are computed in the shader.
  const rings: Vec3[] = [
    [0.86, 0.78, 0.22],
    [1.5, -0.62, -0.12],
    [2.05, -0.15, 0.08],
  ];
  for (let i = 0, c = n(0.04); i < c; i++) {
    const ri = Math.floor(rand() * rings.length);
    const band = rand();
    // Partial arcs: drop points in two gaps per ring.
    const g = (band * 3 + ri * 0.37) % 1;
    if (g > 0.62 && g < 0.8) continue;
    push(rings[ri], KIND.ring, band, ri === 0 ? 1.1 : 0.95, { dissolve: 0, phase: ri / rings.length });
  }

  // ---- Effects: orbit tracers (thinking), outbound streams (executing) ---------------

  for (let i = 0, c = n(0.05); i < c; i++) push([0, 0, 0], KIND.orbit, rand(), 1.3, { dissolve: 0 });
  for (let i = 0, c = n(0.06); i < c; i++) push([0, 0, 0], KIND.stream, rand(), 1.4, { dissolve: 0 });

  // Shuffle so any prefix is a representative sample (adaptive quality draws a prefix).
  for (let i = pts.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pts[i], pts[j]] = [pts[j], pts[i]];
  }

  // Soft glow sprites go first so they survive quality reduction.
  const glows: Pt[] = [
    { p: FACE_CENTER, kind: KIND.glow, band: 0, size: 150, dissolve: 0, layer: 0, phase: 0 },
    { p: CORE_POINT, kind: KIND.glow, band: 1, size: 120, dissolve: 0, layer: 0, phase: 0 },
    { p: [0, 0.35, -0.2], kind: KIND.glow, band: 0.5, size: 520, dissolve: 0, layer: 0, phase: 0 },
  ];
  const all = [...glows, ...pts];

  const count = all.length;
  const target = new Float32Array(count * 3);
  const scatter = new Float32Array(count * 3);
  const info = new Float32Array(count * 4);
  const extra = new Float32Array(count * 4);

  all.forEach((pt, i) => {
    const [x, y, z] = pt.p;
    target.set([x, y, z], i * 3);

    let s: Vec3;
    if (pt.kind === KIND.ambient || pt.kind === KIND.glow || pt.kind === KIND.ring) {
      s = [x, y, z];
    } else if (pt.kind === KIND.stream || pt.kind === KIND.orbit) {
      const d = unit(rand);
      const r = 1.2 + rand() * 2.2;
      s = [d[0] * r, d[1] * r * 0.8 - 0.2, d[2] * r * 0.7];
    } else {
      // Dissolve outward from the formed position; the dissolving side drifts further left and down.
      const d = unit(rand);
      const r = 0.35 + Math.pow(rand(), 0.6) * (1.2 + pt.dissolve * 0.9);
      const pull = pt.dissolve * 0.5;
      s = [x * 1.15 + d[0] * r - pull * (x < 0 ? 0.6 : 0.1), y + d[1] * r * 0.7 - pull * 0.35, z + d[2] * r * 0.7];
    }
    scatter.set(s, i * 3);
    info.set([rand(), pt.kind, pt.band, pt.size], i * 4);
    extra.set([pt.dissolve, pt.layer, pt.phase, 0], i * 4);
  });

  return { count, target, scatter, info, extra };
}

function gauss(rand: () => number): number {
  const u = Math.max(1e-6, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

function unit(rand: () => number): Vec3 {
  const z = rand() * 2 - 1;
  const a = rand() * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  return [r * Math.cos(a), r * Math.sin(a), z];
}
