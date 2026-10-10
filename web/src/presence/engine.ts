import { buildGeometry, CORE_POINT, FACE_CENTER, HEAD_CENTER, type PresenceGeometry } from './geometry';
import { paramsFor, type PacificOpsState, type PresenceParams } from './states';

/**
 * WebGL point-cloud renderer for the Pacific Ops presence.
 *
 * One draw call, one static vertex buffer; all motion happens in the vertex shader
 * driven by a handful of eased uniforms. Additive blending, no textures, no
 * post-processing. Quality adapts by drawing a prefix of a pre-shuffled buffer.
 */

const VERT = /* glsl */ `
precision highp float;
attribute vec3 aTarget;
attribute vec3 aScatter;
attribute vec4 aInfo; // seed, kind, band, size

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
varying float vGlow;

float hash(float n) { return fract(sin(n) * 43758.5453123); }

vec3 drift(vec3 p, float s, float t) {
  return vec3(
    sin(t * 0.31 + s * 12.7 + p.y * 1.7),
    sin(t * 0.27 + s * 7.3 + p.z * 1.3),
    cos(t * 0.23 + s * 5.1 + p.x * 1.5)
  );
}

void main() {
  float seed = aInfo.x;
  float kind = aInfo.y;
  float band = aInfo.z;
  float size = aInfo.w;
  float t = uTime;

  bool isSurface = kind < 0.5;
  bool isContour = kind > 0.5 && kind < 1.5;
  bool isTorso = kind > 1.5 && kind < 2.5;
  bool isCore = kind > 2.5 && kind < 3.5;
  bool isAmbient = kind > 3.5 && kind < 4.5;
  bool isOrbit = kind > 4.5 && kind < 5.5;
  bool isStream = kind > 5.5 && kind < 6.5;
  bool isGlow = kind > 6.5;

  // Assembly: each particle has its own threshold; the head resolves before the torso.
  float order = 0.08 + seed * 0.62 + (isTorso ? 0.18 : 0.0) + (isContour ? -0.06 : 0.0);
  float f = smoothstep(order - 0.22, order + 0.06, uForm * 1.12);

  // The lower torso and back of the head always partially dissolve into space.
  float lowFade = smoothstep(-1.35, -2.0, aTarget.y);
  float backFade = smoothstep(-0.05, -0.45, aTarget.z) * 0.6;
  f *= 1.0 - max(lowFade * (0.35 + 0.65 * seed), backFade * seed);
  if (isCore) f = max(f, 0.55 + 0.45 * uForm);
  if (isAmbient || isGlow) f = 1.0;

  vec3 scatter = aScatter + drift(aScatter, seed, uDrift) * 0.22;
  vec3 target = aTarget + drift(aTarget, seed, t * 1.7) * 0.004;

  // Fault: stepped, subtle destabilisation on a subset of particles.
  float glitchSel = step(0.62, hash(seed * 91.7));
  vec3 glitch = vec3(hash(seed * 13.1 + floor(t * 9.0)), hash(seed * 7.7 + floor(t * 9.0)), hash(seed * 3.3 + floor(t * 9.0))) - 0.5;
  target += glitch * uJitter * (0.012 + glitchSel * 0.05);

  // Voice: contour pulses travelling across the face, scaled by audio level.
  vec3 radial = normalize(aTarget - uHead + vec3(1e-4));
  float voiceBand = sin(band * 26.0 - t * 7.0) * 0.5 + 0.5;
  if (isContour || isSurface) target += radial * uAudio * voiceBand * 0.045 * step(-0.2, aTarget.y);

  vec3 p = mix(scatter, target, f);

  if (isOrbit) {
    float a = seed * 6.2831 + t * (0.55 + seed * 0.5);
    float r = 0.72 + band * 0.22;
    float tilt = (band - 0.5) * 0.9;
    vec3 o = vec3(cos(a) * r, uHead.y + sin(a) * r * 0.18 * tilt + (band - 0.5) * 0.35, sin(a) * r);
    p = mix(scatter, o, uOrbit);
  }

  float streamFade = 0.0;
  if (isStream) {
    float ph = fract(t * (0.18 + seed * 0.22) + seed);
    vec3 dir = normalize(aScatter + vec3(0.0, 0.25, 0.0));
    vec3 s = uCorePt + dir * (0.05 + ph * 2.4);
    p = mix(scatter, s, uStream);
    streamFade = (1.0 - ph) * smoothstep(0.0, 0.08, ph) * uStream;
  }

  // Orientation.
  float cy = cos(uYaw), sy = sin(uYaw);
  p = vec3(cy * p.x + sy * p.z, p.y, -sy * p.x + cy * p.z);
  float cp = cos(uPitch), sp = sin(uPitch);
  vec3 q = p - uHead;
  q = vec3(q.x, cp * q.y - sp * q.z, sp * q.y + cp * q.z);
  p = q + uHead;

  float camZ = 4.4;
  float depth = max(0.5, camZ - p.z);
  float persp = 2.35 * uZoom / depth;
  gl_Position = vec4(p.x * persp / uAspect, (p.y - uCenterY) * persp, 0.0, 1.0);

  // Colour.
  vec3 cyan = vec3(0.27, 0.85, 0.92);
  vec3 ice = vec3(0.70, 0.94, 1.0);
  vec3 white = vec3(0.93, 0.98, 1.0);
  vec3 amber = vec3(1.0, 0.62, 0.24);
  vec3 col = mix(cyan, ice, (isContour ? 0.45 : 0.15) + seed * 0.2);

  float faceW = exp(-pow(length((aTarget - uFace) * vec3(1.6, 1.1, 1.3)) / 0.3, 2.0)) * f;
  float coreW = exp(-pow(length(aTarget - uCorePt) / 0.16, 2.0));
  col = mix(col, amber, clamp(faceW * uAmber * 1.4, 0.0, 0.92));
  col = mix(col, white, coreW * uCore * 0.85);
  col = mix(col, vec3(1.0, 0.36, 0.38), uRed * glitchSel * 0.75);

  float alpha = 0.0;
  if (isAmbient) alpha = 0.16 + 0.1 * sin(t * 0.7 + seed * 40.0);
  else if (isContour) alpha = 0.18 + 0.62 * f;
  else if (isSurface) alpha = 0.12 + 0.32 * f;
  else if (isTorso) alpha = 0.14 + 0.4 * f;
  else if (isCore) alpha = (0.35 + 0.65 * uCore) * (0.85 + 0.15 * sin(t * 2.2 + seed * 9.0));
  else if (isOrbit) alpha = 0.55 * uOrbit;
  else if (isStream) { alpha = 0.8 * streamFade; col = mix(ice, white, 0.5); }

  // Listening: concentric rings expanding from the face.
  float dFace = length(aTarget.xy - uFace.xy);
  alpha *= 1.0 + uWave * 0.9 * pow(sin(dFace * 16.0 - t * 3.2) * 0.5 + 0.5, 6.0) * step(kind, 2.5);

  // Scan sweep.
  float scanY = mix(-1.6, 1.35, fract(t * 0.11));
  alpha *= 1.0 + uScan * 1.1 * exp(-pow((aTarget.y - scanY) * 9.0, 2.0)) * step(kind, 2.5);

  // Success pulse ring travelling outward from the core.
  float ring = exp(-pow((length(aTarget - uCorePt) - uPulseR) * 7.0, 2.0)) * uPulse;
  alpha *= 1.0 + ring * 2.2;
  col = mix(col, vec3(0.45, 0.95, 0.68), clamp(ring * uGreen * 1.6 + uGreen * 0.12, 0.0, 0.7));

  // Speaking: light emanating from face and core regions.
  alpha *= 1.0 + uAudio * (faceW * 1.4 + coreW * 1.2);

  alpha *= uEnergy;

  if (isGlow) {
    float glowA = band < 0.25 ? uAmber * (0.16 + uAudio * 0.12) : band > 0.75 ? uCore * 0.22 : 0.05 * uEnergy;
    col = band < 0.25 ? amber : band > 0.75 ? mix(cyan, white, 0.5) : cyan;
    alpha = glowA;
  }

  vColor = col;
  vAlpha = alpha;
  vGlow = isGlow ? 1.0 : 0.0;
  float pointSize = size * uPointScale / depth;
  if (!isGlow) pointSize *= 0.75 + 0.25 * f + (isCore ? 0.4 * uCore : 0.0);
  gl_PointSize = clamp(pointSize, 0.5, 512.0);
}
`;

const FRAG = /* glsl */ `
precision mediump float;
varying vec3 vColor;
varying float vAlpha;
varying float vGlow;

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  if (d > 0.5) discard;
  float a;
  if (vGlow > 0.5) {
    a = exp(-d * d * 14.0);
  } else {
    a = 1.0 - smoothstep(0.0, 0.5, d);
    a = a * a;
  }
  vec3 rgb = vColor * vAlpha * a;
  // Premultiplied output: alpha follows brightness so additive light never darkens the page.
  gl_FragColor = vec4(rgb, max(rgb.r, max(rgb.g, rgb.b)));
}
`;

type UniformName =
  | 'uTime' | 'uForm' | 'uEnergy' | 'uAmber' | 'uCore' | 'uOrbit' | 'uStream' | 'uWave' | 'uScan'
  | 'uJitter' | 'uRed' | 'uGreen' | 'uAudio' | 'uDrift' | 'uPulse' | 'uPulseR' | 'uYaw' | 'uPitch'
  | 'uAspect' | 'uZoom' | 'uCenterY' | 'uPointScale' | 'uHead' | 'uFace' | 'uCorePt';

export interface EngineOptions {
  particleCount: number;
  maxDpr: number;
  reducedMotion: boolean;
  framing: 'hero' | 'compact';
  onContextLost?: () => void;
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

  constructor(
    private canvas: HTMLCanvasElement,
    private options: EngineOptions
  ) {
    const gl = canvas.getContext('webgl', { antialias: false, alpha: true, premultipliedAlpha: true, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL unavailable');
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
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(this.program, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    };
    bind('aTarget', this.geometry.target, 3);
    bind('aScatter', this.geometry.scatter, 3);
    bind('aInfo', this.geometry.info, 4);

    const names: UniformName[] = [
      'uTime', 'uForm', 'uEnergy', 'uAmber', 'uCore', 'uOrbit', 'uStream', 'uWave', 'uScan', 'uJitter', 'uRed', 'uGreen',
      'uAudio', 'uDrift', 'uPulse', 'uPulseR', 'uYaw', 'uPitch', 'uAspect', 'uZoom', 'uCenterY', 'uPointScale', 'uHead', 'uFace', 'uCorePt',
    ];
    for (const n of names) this.uniforms.set(n, gl.getUniformLocation(this.program, n));
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
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  /** Reduced motion / paused: a single settled frame at a fixed time. */
  private renderStill() {
    if (this.disposed) return;
    if (this.time === 0) this.time = 14;
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
    const compact = this.options.framing === 'compact';
    const aspect = this.width / this.height;
    const fitWidth = Math.min(1, aspect / (compact ? 0.6 : 0.82));

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
    gl.uniform1f(u('uPulse'), pulseAge >= 0 && pulseAge < 2.4 ? Math.pow(1 - pulseAge / 2.4, 1.5) : 0);
    gl.uniform1f(u('uPulseR'), Math.max(0, pulseAge) * 1.25);
    gl.uniform1f(u('uYaw'), Math.sin(t * 0.13) * 0.32 + Math.sin(t * 0.041) * 0.12);
    gl.uniform1f(u('uPitch'), Math.sin(t * 0.09) * 0.04 + this.smoothedAudio * 0.025 * Math.sin(t * 3.1));
    gl.uniform1f(u('uAspect'), aspect);
    gl.uniform1f(u('uZoom'), (compact ? 1.3 : 0.94) * fitWidth);
    gl.uniform1f(u('uCenterY'), compact ? -0.08 : -0.24);
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
  if (coarse && shortSide < 500) return { tier: 'phone', particleCount: 4500, maxDpr: 1.5 };
  if (coarse) return { tier: 'tablet', particleCount: 8000, maxDpr: 1.75 };
  if (cores >= 8 && memory >= 8) return { tier: 'desktop-high', particleCount: 16000, maxDpr: 2 };
  return { tier: 'desktop', particleCount: 11000, maxDpr: 2 };
}
