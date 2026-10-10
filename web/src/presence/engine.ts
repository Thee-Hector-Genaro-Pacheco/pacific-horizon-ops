import { buildGeometry, CORE_POINT, FACE_CENTER, HEAD_CENTER, type PresenceGeometry } from './geometry';
import { paramsFor, type PacificOpsState, type PresenceParams } from './states';

/**
 * WebGL point-cloud renderer for the Pacific Ops presence (V2).
 *
 * One draw call, one static set of vertex buffers; all motion happens in the vertex
 * shader driven by a handful of eased uniforms. Additive light on a transparent,
 * premultiplied canvas so the CSS atmosphere behind it stays visible. No textures,
 * no post-processing. Quality adapts by drawing a prefix of a pre-shuffled buffer.
 */

const VERT = /* glsl */ `
precision highp float;
attribute vec3 aTarget;
attribute vec3 aScatter;
attribute vec4 aInfo;  // seed, kind, band, size
attribute vec4 aExtra; // dissolve, layer, phase, spare

uniform float uTime;
uniform float uForm;
uniform float uEnergy;
uniform float uAmber;
uniform float uCore;
uniform float uOrbit;
uniform float uStream;
uniform float uWave;
uniform float uScan;
uniform float uJitter;
uniform float uRed;
uniform float uGreen;
uniform float uAudio;
uniform float uDrift;
uniform float uConverge;
uniform float uNeural;
uniform float uRings;
uniform float uPulse;
uniform float uPulseR;
uniform float uYaw;
uniform float uPitch;
uniform float uAspect;
uniform float uZoom;
uniform float uCenterY;
uniform float uPointScale;
uniform vec3 uHead;
uniform vec3 uFace;
uniform vec3 uCorePt;

varying vec3 vColor;
varying float vAlpha;
varying float vSoft;

float hash(float n) { return fract(sin(n) * 43758.5453123); }

vec3 drift(vec3 p, float s, float t) {
  return vec3(
    sin(t * 0.31 + s * 12.7 + p.y * 1.7),
    sin(t * 0.27 + s * 7.3 + p.z * 1.3),
    cos(t * 0.23 + s * 5.1 + p.x * 1.5)
  );
}

// Travelling pulse along a path parameter: a bright head followed by a short tail.
float pulseAt(float band, float phase, float speed, float t) {
  float d = fract(phase + band - t * speed);
  return smoothstep(0.8, 0.97, d) * (1.0 - smoothstep(0.97, 1.0, d));
}

void main() {
  float seed = aInfo.x;
  int kind = int(aInfo.y + 0.5);
  float band = aInfo.z;
  float size = aInfo.w;
  float dissolve = aExtra.x;
  float layer = aExtra.y;
  float phase = aExtra.z;
  float t = uTime;

  bool isSurface = kind == 0;
  bool isContour = kind == 1;
  bool isTorso = kind == 2;
  bool isCore = kind == 3;
  bool isAmbient = kind == 4;
  bool isOrbit = kind == 5;
  bool isStream = kind == 6;
  bool isGlow = kind == 7;
  bool isCognition = kind == 8;
  bool isNeural = kind == 9;
  bool isRibbon = kind == 10;
  bool isField = kind == 11;
  bool isFragment = kind == 12;
  bool isRing = kind == 13;
  bool isPlane = kind == 14;
  bool isFigure = isSurface || isContour || isTorso || isCore || isCognition || isNeural || isRibbon || isField || isPlane;

  // ---- Assembly. Each particle resolves at its own threshold; head before shoulders.
  float order = 0.06 + seed * 0.6 + ((isTorso || isRibbon || isField) ? 0.12 : 0.0) - ((isContour || isNeural) ? 0.05 : 0.0);
  float f = smoothstep(order - 0.2, order + 0.06, uForm * 1.12);
  // Dissolving regions detach and return slowly: computational, not anatomical, breathing.
  float breathe = 0.5 + 0.5 * sin(uDrift * 0.45 + phase * 6.2831 + seed * 9.0);
  f *= 1.0 - dissolve * (0.35 + 0.5 * breathe) * (0.45 + 0.55 * seed);
  if (isCore || isCognition) f = max(f, 0.6 + 0.4 * uForm);
  if (isAmbient || isGlow || isRing || isFragment) f = 1.0;

  vec3 scatter = aScatter + drift(aScatter, seed, uDrift) * 0.2;
  // Listening: the periphery is drawn in toward the form.
  if (isFigure) scatter = mix(scatter, aTarget + (aScatter - aTarget) * 0.3, uConverge * 0.75);
  vec3 target = aTarget + drift(aTarget, seed, uDrift * 1.7) * 0.004;

  // Fault: stepped decoherence concentrated in the dissolving regions.
  float glitchSel = step(0.7, hash(seed * 91.7));
  vec3 glitch = vec3(hash(seed * 13.1 + floor(t * 9.0)), hash(seed * 7.7 + floor(t * 9.0)), hash(seed * 3.3 + floor(t * 9.0))) - 0.5;
  target += glitch * uJitter * (0.005 + glitchSel * 0.03 * (0.3 + dissolve));

  // Voice: contour waves across the head; dissolving particles radiate outward.
  vec3 radial = normalize(aTarget - uHead + vec3(1e-4));
  float voiceBand = sin(band * 26.0 - t * 7.0) * 0.5 + 0.5;
  if (isContour || isSurface || isPlane) target += radial * uAudio * voiceBand * 0.04 * step(-0.15, aTarget.y);
  if (isSurface || isFragment) target += radial * uAudio * dissolve * 0.06;

  vec3 p = mix(scatter, target, f);

  // Holographic phase shift: a thin horizontal band slips sideways for a moment.
  float cyc = fract(t * 0.11);
  float shiftOn = smoothstep(0.0, 0.015, cyc) * (1.0 - smoothstep(0.03, 0.045, cyc));
  float shiftY = mix(1.3, -1.2, hash(floor(t * 0.11) + 3.0));
  if (isFigure) p.x += shiftOn * exp(-pow((aTarget.y - shiftY) * 14.0, 2.0)) * 0.022;

  float fade = 1.0;
  if (isFragment) {
    // Telemetry fragments drift down and away, then re-form.
    float ph = fract(uDrift * 0.035 + phase);
    p = aTarget + vec3((aTarget.x < 0.0 ? -1.0 : 1.0) * ph * 0.12, -ph * 0.38, 0.0);
    p += radial * uAudio * 0.05;
    fade = sin(ph * 3.14159);
  }

  if (isRing) {
    float dir = phase > 0.5 ? -1.0 : 1.0;
    float a = band * 6.2831 + uDrift * (0.05 + phase * 0.04) * dir;
    p = vec3(cos(a) * aTarget.x, aTarget.y + sin(a) * aTarget.x * aTarget.z, sin(a) * aTarget.x * 0.85);
  }

  float orbitTrail = 0.0;
  if (isOrbit) {
    // Neural traces: comets with trailing tails on three tilted paths around the head.
    float path = floor(band * 3.0);
    float comet = floor(seed * 5.0);
    float lag = fract(seed * 5.0);               // position within the comet's tail
    float speed = 0.55 + path * 0.18;
    float a = t * speed * (path == 1.0 ? -1.0 : 1.0) + comet * 1.2566 + path * 0.9 - lag * 0.9 * (path == 1.0 ? -1.0 : 1.0);
    float r = 0.74 + path * 0.1;
    float tilt = (path - 1.0) * 0.55 + 0.15;
    vec3 o = vec3(cos(a) * r, uHead.y + 0.05 + sin(a) * r * tilt * 0.6, sin(a) * r * 0.85);
    p = mix(scatter, o, uOrbit);
    orbitTrail = pow(1.0 - lag, 1.6);
  }

  float streamFade = 0.0;
  if (isStream) {
    float ph = fract(t * (0.18 + seed * 0.22) + seed);
    vec3 dir = normalize(aScatter + vec3(0.0, 0.25, 0.0));
    vec3 s = uCorePt + dir * (0.05 + ph * 2.4);
    p = mix(scatter, s, uStream);
    streamFade = (1.0 - ph) * smoothstep(0.0, 0.08, ph) * uStream;
  }

  // ---- Orientation. Far layer turns less than the figure (parallax), near layer more.
  float yaw = uYaw * (layer > 1.5 ? 0.6 : layer > 0.5 ? 0.12 : 1.0);
  float cy = cos(yaw), sy = sin(yaw);
  p = vec3(cy * p.x + sy * p.z, p.y, -sy * p.x + cy * p.z);
  if (layer < 0.5) {
    float cp = cos(uPitch), sp = sin(uPitch);
    vec3 q = p - uHead;
    q = vec3(q.x, cp * q.y - sp * q.z, sp * q.y + cp * q.z);
    p = q + uHead;
  }

  float camZ = 4.4;
  float depth = max(0.5, camZ - p.z);
  float persp = 2.35 * uZoom / depth;
  gl_Position = vec4(p.x * persp / uAspect, (p.y - uCenterY) * persp, 0.0, 1.0);

  // ---- Colour. Cyan / ice / teal / cool white, with amber only for cognition.
  vec3 cyan = vec3(0.27, 0.85, 0.92);
  vec3 ice = vec3(0.70, 0.94, 1.0);
  vec3 teal = vec3(0.14, 0.66, 0.70);
  vec3 white = vec3(0.92, 0.98, 1.0);
  vec3 amber = vec3(1.0, 0.62, 0.24);

  vec3 col = mix(teal, cyan, 0.45 + seed * 0.55);
  if (isContour || isNeural) col = mix(cyan, ice, 0.35 + seed * 0.25);
  if (isPlane) col = mix(cyan, ice, 0.6);
  if (isRibbon) col = mix(teal, ice, band * 0.6 + seed * 0.2);
  if (isField) col = mix(teal, ice, band);
  if (isRing) col = mix(teal, cyan, 0.5);
  if (isAmbient && layer > 0.5) col = mix(teal, ice, seed * 0.5);

  float cognW = exp(-pow(length((aTarget - uFace) * vec3(1.3, 1.05, 1.2)) / 0.3, 2.0)) * f;
  float coreW = exp(-pow(length(aTarget - uCorePt) / 0.16, 2.0));
  if (isFigure) col = mix(col, amber, clamp(cognW * uAmber * 1.1, 0.0, 0.85));
  if (isCognition) col = mix(ice, amber, 0.3 + 0.65 * uAmber);
  if (isCore) col = band < 0.1 ? mix(ice, white, 0.3 + 0.4 * uCore) : mix(cyan, ice, 0.55);
  col = mix(col, white, coreW * uCore * 0.6 * (isCore ? 0.0 : 1.0));

  // Diagnostic red stays on a small set of fragments in the dissolving regions.
  float errSel = isFragment ? step(0.55, hash(seed * 17.3)) : step(0.9, hash(seed * 17.3)) * step(0.3, dissolve);
  col = mix(col, vec3(1.0, 0.36, 0.38), uRed * errSel * 0.9);

  // ---- Alpha.
  float alpha = 0.0;
  if (isAmbient) {
    if (layer > 1.5) alpha = 0.05;                                       // near, defocused
    else if (layer > 0.5) alpha = 0.07 + 0.05 * sin(t * 0.5 + seed * 30.0); // far field
    else alpha = 0.12 + 0.08 * sin(t * 0.7 + seed * 40.0);              // mid dust
  }
  else if (isContour) alpha = 0.14 + 0.5 * f;
  else if (isSurface) alpha = 0.09 + 0.28 * f;
  else if (isPlane) alpha = 0.05 + 0.16 * f;
  else if (isTorso) alpha = 0.05 + 0.14 * f;
  else if (isNeural) {
    float speed = 0.22 + 0.35 * uNeural;
    alpha = 0.1 + 0.2 * f + pulseAt(band, phase, speed, t) * (0.25 + 0.9 * uNeural) * f;
    if (aTarget.y < 0.0) alpha += uAudio * 0.35 * f; // neck / chest pathways react to voice
  }
  else if (isCognition) {
    alpha = (0.14 + 0.6 * uAmber) * (0.75 + 0.25 * sin(t * 3.0 + band * 10.0 + phase * 6.0));
    alpha += pulseAt(band, phase, 0.6, t) * 0.5 * uAmber;
  }
  else if (isRibbon) alpha = 0.12 + 0.36 * f + pulseAt(band, phase, 0.18, t) * 0.35 * uNeural * f;
  else if (isField) alpha = 0.06 + 0.22 * f + pulseAt(band, phase, 0.4, t) * (0.3 + 0.5 * uCore) * f;
  else if (isCore) {
    float beat = pow(0.5 + 0.5 * sin(t * 1.7 - phase * 2.4), 4.0);
    if (band < 0.1) alpha = (0.18 + 0.3 * uCore) * (0.85 + 0.15 * sin(t * 2.2 + seed * 9.0));
    else if (band < 0.9) alpha = (0.3 + 0.55 * uCore) * (0.6 + 0.8 * beat);
    else alpha = (0.06 + 0.3 * uCore) * (0.5 + 0.5 * sin(t * 2.0 + seed * 20.0));
  }
  else if (isFragment) alpha = 0.5 * fade * (1.0 + uRed * errSel * 1.2);
  else if (isRing) alpha = (0.07 + 0.12 * uRings) * (0.7 + 0.3 * sin(band * 40.0 + t)) + (aTarget.x < 1.0 ? uOrbit * 0.08 : 0.0);
  else if (isOrbit) { alpha = 1.1 * uOrbit * orbitTrail; col = mix(cyan, amber, 0.35 * uAmber * orbitTrail); }
  else if (isStream) { alpha = 1.3 * streamFade; col = mix(ice, white, 0.5); }

  if (isFigure) {
    // Listening: concentric rings expanding from the head.
    float dHead = length(aTarget - uHead);
    alpha *= 1.0 + uWave * 0.9 * pow(sin(dHead * 14.0 - t * 3.2) * 0.5 + 0.5, 6.0);
    // Occasional horizontal scan band, top to bottom.
    float sc = fract(t * 0.075);
    float scanY = mix(1.55, -1.6, sc / 0.45);
    alpha *= 1.0 + uScan * step(sc, 0.45) * exp(-pow((aTarget.y - scanY) * 10.0, 2.0));
    // Slow vertical scanning wave across the form.
    float scanX = mix(-1.4, 1.4, fract(t * 0.045));
    alpha *= 1.0 + uScan * 0.35 * exp(-pow((aTarget.x - scanX) * 7.0, 2.0));
    // Contour interference and micro flicker.
    if (isContour || isPlane || isSurface) alpha *= 0.86 + 0.14 * sin(aTarget.y * 150.0 + t * 1.5);
    alpha *= 0.93 + 0.07 * hash(seed * 3.1 + floor(t * 14.0));
    // Speaking: light from the cognition and core regions.
    alpha *= 1.0 + uAudio * (cognW * 0.9 + coreW * 0.9);
  }

  // Success: a ring travelling outward from the core, cyan shifting to green.
  float ring = exp(-pow((length(aTarget - uCorePt) - uPulseR) * 7.0, 2.0)) * uPulse;
  if (isFigure) {
    alpha *= 1.0 + ring * 2.0;
    col = mix(col, vec3(0.45, 0.95, 0.68), clamp(ring * uGreen * 1.6 + uGreen * 0.1, 0.0, 0.7));
  }

  // Display gain: the figure must be the brightest element on the page.
  alpha *= uEnergy * (isFigure ? 2.1 : (isAmbient && layer < 1.5) ? 1.5 : 1.3);

  vSoft = 0.0;
  if (isGlow) {
    if (band < 0.25) { col = amber; alpha = uAmber * (0.1 + uAudio * 0.08); }
    else if (band > 0.75) { col = mix(cyan, white, 0.45); alpha = uCore * 0.16; }
    else { col = teal; alpha = 0.03 * uEnergy; }
    vSoft = 1.0;
  }
  if (isAmbient && layer > 1.5) vSoft = 1.0;

  vColor = col;
  vAlpha = min(alpha, 1.8);
  float pointSize = size * uPointScale / depth;
  if (isFigure) pointSize *= 1.25 * (0.7 + 0.3 * f) + (isCore ? 0.35 * uCore : 0.0);
  if (isStream || isOrbit) pointSize *= 1.35;
  if (isFragment) pointSize *= 1.6 + uRed * errSel * 0.8;
  gl_PointSize = clamp(pointSize, 0.5, 512.0);
}
`;

const FRAG = /* glsl */ `
precision mediump float;
varying vec3 vColor;
varying float vAlpha;
varying float vSoft;

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  if (d > 0.5) discard;
  float a = vSoft > 0.5 ? exp(-d * d * 16.0) : pow(1.0 - smoothstep(0.0, 0.5, d), 2.0);
  vec3 rgb = vColor * vAlpha * a;
  // Premultiplied output: alpha follows brightness so light composites over the
  // atmosphere behind the canvas and never darkens it.
  gl_FragColor = vec4(rgb, max(rgb.r, max(rgb.g, rgb.b)));
}
`;

type UniformName =
  | 'uTime' | 'uForm' | 'uEnergy' | 'uAmber' | 'uCore' | 'uOrbit' | 'uStream' | 'uWave' | 'uScan'
  | 'uJitter' | 'uRed' | 'uGreen' | 'uAudio' | 'uDrift' | 'uConverge' | 'uNeural' | 'uRings'
  | 'uPulse' | 'uPulseR' | 'uYaw' | 'uPitch'
  | 'uAspect' | 'uZoom' | 'uCenterY' | 'uPointScale' | 'uHead' | 'uFace' | 'uCorePt';

const UNIFORMS: UniformName[] = [
  'uTime', 'uForm', 'uEnergy', 'uAmber', 'uCore', 'uOrbit', 'uStream', 'uWave', 'uScan', 'uJitter', 'uRed', 'uGreen',
  'uAudio', 'uDrift', 'uConverge', 'uNeural', 'uRings', 'uPulse', 'uPulseR', 'uYaw', 'uPitch', 'uAspect', 'uZoom',
  'uCenterY', 'uPointScale', 'uHead', 'uFace', 'uCorePt',
];

export interface EngineOptions {
  particleCount: number;
  maxDpr: number;
  reducedMotion: boolean;
  framing: 'hero' | 'compact';
  onContextLost?: () => void;
}

/** Camera framing per container shape. Exported for the 2D fallback and tests. */
export function framingFor(framing: 'hero' | 'compact', aspect: number): { zoom: number; centerY: number } {
  if (framing === 'compact') return { zoom: 1.3 * Math.min(1, aspect / 0.6), centerY: 0.35 };
  // Portrait / phone: simplified head and upper-shoulder framing, not a shrunken bust.
  if (aspect < 0.95) return { zoom: 1.1 * Math.min(1, aspect / 0.55), centerY: 0.22 };
  // Desktop / tablet landscape: head + implied torso fill ~65% of the stage height.
  return { zoom: 0.96 * Math.min(1, aspect / 1.15), centerY: -0.02 };
}

const EASE_RATE: Partial<Record<keyof PresenceParams, number>> = { form: 1.3, jitter: 4, red: 3 };

export class PresenceEngine {
  private gl: WebGLRenderingContext;
  private program: WebGLProgram;
  private uniforms = new Map<UniformName, WebGLUniformLocation | null>();
  private geometry: PresenceGeometry;
  private drawCount: number;
  private raf = 0;
  private running = false;
  private lastFrame = 0;
  private time = 0;
  private driftPhase = 0;
  private current: PresenceParams;
  private target: PresenceParams;
  private state: PacificOpsState = 'idle';
  private audioLevel: number | null = null;
  private smoothedAudio = 0;
  private pulseStart = -10;
  private frameTimes: number[] = [];
  private width = 0;
  private height = 0;
  private dpr = 1;
  private disposed = false;
  private buffers: WebGLBuffer[] = [];
  private shaders: WebGLShader[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    private options: EngineOptions
  ) {
    const gl = canvas.getContext('webgl', { antialias: false, alpha: true, premultipliedAlpha: true, depth: false, powerPreference: 'high-performance' });
    // A canvas that already carries a lost context can never render again.
    if (!gl || gl.isContextLost()) throw new Error('WebGL unavailable');
    this.gl = gl;
    this.program = this.createProgram(VERT, FRAG);
    this.geometry = buildGeometry(options.particleCount);
    this.drawCount = this.geometry.count;
    this.current = { ...paramsFor('idle') };
    this.target = { ...paramsFor('idle') };
    this.upload();
    canvas.addEventListener('webglcontextlost', this.handleContextLost);
  }

  private handleContextLost = (e: Event) => {
    e.preventDefault();
    this.stop();
    this.options.onContextLost?.();
  };

  private createProgram(vsSrc: string, fsSrc: string): WebGLProgram {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh);
        gl.deleteShader(sh);
        throw new Error(`Shader compile failed: ${log}`);
      }
      this.shaders.push(sh);
      return sh;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Program link failed: ${gl.getProgramInfoLog(program)}`);
    }
    return program;
  }

  private upload() {
    const gl = this.gl;
    gl.useProgram(this.program);
    const bind = (name: string, data: Float32Array, size: number) => {
      const buf = gl.createBuffer()!;
      this.buffers.push(buf);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(this.program, name);
      if (loc < 0) return;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    };
    bind('aTarget', this.geometry.target, 3);
    bind('aScatter', this.geometry.scatter, 3);
    bind('aInfo', this.geometry.info, 4);
    bind('aExtra', this.geometry.extra, 4);

    for (const n of UNIFORMS) this.uniforms.set(n, gl.getUniformLocation(this.program, n));
    gl.uniform3fv(this.uniforms.get('uHead')!, HEAD_CENTER);
    gl.uniform3fv(this.uniforms.get('uFace')!, FACE_CENTER);
    gl.uniform3fv(this.uniforms.get('uCorePt')!, CORE_POINT);

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.clearColor(0, 0, 0, 0);
  }

  setState(state: PacificOpsState) {
    if (state === this.state && this.time > 0) return;
    if (state === 'success') this.pulseStart = this.time;
    this.state = state;
    this.target = { ...paramsFor(state) };
    if (this.options.reducedMotion) {
      this.current = { ...this.target };
      this.renderStill();
    }
  }

  setAudioLevel(level: number | null) {
    this.audioLevel = level === null ? null : Math.min(1, Math.max(0, level));
    if (this.options.reducedMotion) {
      this.smoothedAudio = this.audioLevel ?? 0;
      this.renderStill();
    }
  }

  resize(width: number, height: number) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.dpr = Math.min(window.devicePixelRatio || 1, this.options.maxDpr);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    if (this.options.reducedMotion || !this.running) this.renderStill();
  }

  start() {
    if (this.running || this.disposed) return;
    if (this.options.reducedMotion) {
      this.renderStill();
      return;
    }
    this.running = true;
    this.lastFrame = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
      this.lastFrame = now;
      this.tick(dt);
      this.draw();
      this.adapt(dt);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  dispose() {
    this.stop();
    this.disposed = true;
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost);
    // Release GPU resources but never force-lose the context. A canvas owns one context
    // for its whole lifetime: losing it leaves the element permanently dead, so a remount
    // on the same element (React StrictMode in dev, HMR, framing change) would inherit a
    // lost context and drop to the static fallback.
    const gl = this.gl;
    if (gl.isContextLost()) return;
    for (const b of this.buffers) gl.deleteBuffer(b);
    for (const sh of this.shaders) gl.deleteShader(sh);
    gl.deleteProgram(this.program);
    this.buffers = [];
    this.shaders = [];
  }

  /** Reduced motion / paused: a single settled frame at a fixed time. */
  private renderStill() {
    if (this.disposed || this.width === 0) return;
    if (this.time === 0) {
      this.time = 14;
      this.driftPhase = 14;
    }
    this.current = { ...this.target };
    this.draw();
  }

  private tick(dt: number) {
    this.time += dt;
    this.driftPhase += dt * this.current.drift;
    for (const key of Object.keys(this.target) as Array<keyof PresenceParams>) {
      const rate = EASE_RATE[key] ?? 2.4;
      this.current[key] += (this.target[key] - this.current[key]) * (1 - Math.exp(-dt * rate));
    }
    // SPEAKING without a real level: a deterministic, state-driven envelope. This is NOT
    // audio amplitude. ConversationRelay plays TTS from Twilio straight to the phone, so
    // the server never sees the audio. If a real level becomes available, pass it as
    // `audioLevel` (0..1) and it replaces this envelope with no other change.
    const synthetic =
      this.current.voice > 0.01
        ? Math.max(0, 0.42 + 0.3 * Math.sin(this.time * 7.1) * Math.sin(this.time * 2.3 + 1.1) + 0.12 * Math.sin(this.time * 17.0)) * this.current.voice
        : 0;
    const level = this.audioLevel ?? synthetic;
    this.smoothedAudio += (level - this.smoothedAudio) * (1 - Math.exp(-dt * 14));
  }

  /** Halve the drawn particle prefix if frames are consistently slow. */
  private adapt(dt: number) {
    if (this.frameTimes.length >= 90 || this.drawCount < 2500) return;
    this.frameTimes.push(dt);
    if (this.frameTimes.length === 90) {
      const sorted = [...this.frameTimes].sort((a, b) => a - b);
      const p75 = sorted[Math.floor(sorted.length * 0.75)];
      if (p75 > 1 / 40) {
        this.drawCount = Math.max(2500, Math.floor(this.drawCount * 0.55));
        this.frameTimes = [];
      }
    }
  }

  private draw() {
    const gl = this.gl;
    const u = (n: UniformName) => this.uniforms.get(n)!;
    const c = this.current;
    const t = this.time;
    const pulseAge = t - this.pulseStart;
    const aspect = this.width / this.height;
    const { zoom, centerY } = framingFor(this.options.framing, aspect);

    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.uniform1f(u('uTime'), t);
    gl.uniform1f(u('uForm'), c.form);
    gl.uniform1f(u('uEnergy'), c.energy);
    gl.uniform1f(u('uAmber'), c.amber);
    gl.uniform1f(u('uCore'), c.core);
    gl.uniform1f(u('uOrbit'), c.orbit);
    gl.uniform1f(u('uStream'), c.stream);
    gl.uniform1f(u('uWave'), c.wave);
    gl.uniform1f(u('uScan'), c.scan);
    gl.uniform1f(u('uJitter'), c.jitter);
    gl.uniform1f(u('uRed'), c.red);
    gl.uniform1f(u('uGreen'), c.green);
    gl.uniform1f(u('uAudio'), this.smoothedAudio);
    gl.uniform1f(u('uDrift'), this.driftPhase || t);
    gl.uniform1f(u('uConverge'), c.converge);
    gl.uniform1f(u('uNeural'), c.neural);
    gl.uniform1f(u('uRings'), c.rings);
    gl.uniform1f(u('uPulse'), pulseAge >= 0 && pulseAge < 2.4 ? Math.pow(1 - pulseAge / 2.4, 1.5) : 0);
    gl.uniform1f(u('uPulseR'), Math.max(0, pulseAge) * 1.25);
    // Slow turn; suspended states (low drift) turn less.
    const sway = 0.4 + 0.6 * Math.min(1, c.drift);
    // A standing three-quarter turn lets the facial profile read; the sway rides on top.
    gl.uniform1f(u('uYaw'), 0.24 + (Math.sin(t * 0.13) * 0.2 + Math.sin(t * 0.041) * 0.08) * sway);
    gl.uniform1f(u('uPitch'), Math.sin(t * 0.09) * 0.04 + this.smoothedAudio * 0.025 * Math.sin(t * 3.1));
    gl.uniform1f(u('uAspect'), aspect);
    gl.uniform1f(u('uZoom'), zoom);
    gl.uniform1f(u('uCenterY'), centerY);
    gl.uniform1f(u('uPointScale'), this.dpr * (this.height / 420) * 3.3);
    gl.drawArrays(gl.POINTS, 0, this.drawCount);
  }
}

export interface DeviceTier {
  tier: 'phone' | 'tablet' | 'desktop' | 'desktop-high';
  particleCount: number;
  maxDpr: number;
}

export function detectTier(): DeviceTier {
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const shortSide = Math.min(window.screen?.width ?? 1200, window.screen?.height ?? 800);
  const cores = navigator.hardwareConcurrency || 4;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  if (coarse && shortSide < 500) return { tier: 'phone', particleCount: 6500, maxDpr: 1.5 };
  if (coarse) return { tier: 'tablet', particleCount: 9000, maxDpr: 1.75 };
  if (cores >= 8 && memory >= 8) return { tier: 'desktop-high', particleCount: 16000, maxDpr: 2 };
  return { tier: 'desktop', particleCount: 11000, maxDpr: 2 };
}
