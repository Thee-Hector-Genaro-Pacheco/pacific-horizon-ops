import { lazy, Suspense, useCallback, useState, useSyncExternalStore } from 'react';
import { cn } from '../lib/cn';
import type { ToneClass } from '../lib/status';
import { STATE_STATUS, type PacificOpsState } from './states';

const PresenceCanvas = lazy(() => import('./PresenceCanvas'));

export interface PresenceTelemetry {
  label: string;
  tone?: ToneClass;
  live?: boolean;
}

export interface PresenceServiceItem {
  name: string;
  tone?: ToneClass;
  statusText?: string;
  to?: string;
}

export interface PacificOpsPresenceProps {
  state: PacificOpsState;
  /** 0..1 live voice level; when omitted, speaking uses a synthetic envelope. */
  audioLevel?: number;
  systemHealth?: 'healthy' | 'degraded' | 'down';
  headline?: string;
  /** Left-side HUD labels (system links). */
  telemetry?: PresenceTelemetry[];
  /** Right-side HUD labels (operational counters). */
  annotations?: PresenceTelemetry[];
  /** Centered service indicators beneath headline (e.g. GMAIL ●, TWILIO ●, VOICE ●). */
  services?: PresenceServiceItem[];
  framing?: 'hero' | 'compact';
  /** Omit the top floating pill when an outer header displays the state. */
  hideStatusPill?: boolean;
  className?: string;
}

const reducedMotionQuery = '(prefers-reduced-motion: reduce)';

function subscribeReducedMotion(cb: () => void) {
  const mq = window.matchMedia(reducedMotionQuery);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(reducedMotionQuery).matches,
    () => false
  );
}

let webglSupport: boolean | null = null;
function supportsWebGL(): boolean {
  if (webglSupport === null) {
    try {
      const c = document.createElement('canvas');
      webglSupport = !!(c.getContext('webgl') ?? c.getContext('experimental-webgl'));
    } catch {
      webglSupport = false;
    }
  }
  return webglSupport;
}

const STATE_TONE: Record<PacificOpsState, ToneClass> = {
  idle: 'tone-ok',
  listening: 'tone-info',
  thinking: 'tone-info',
  speaking: 'tone-info',
  awaiting_approval: 'tone-warn',
  executing: 'tone-info',
  success: 'tone-ok',
  error: 'tone-fail',
};

/**
 * Pacific Ops visual presence: a particle-formed synthetic figure whose structure,
 * light and motion are driven entirely by `state`. One reusable component; callers
 * never animate it directly.
 */
export function PacificOpsPresence({
  state,
  audioLevel,
  systemHealth = 'healthy',
  headline,
  telemetry = [],
  annotations = [],
  services = [],
  framing = 'hero',
  hideStatusPill = false,
  className,
}: PacificOpsPresenceProps) {
  const reducedMotion = usePrefersReducedMotion();
  const [fellBack, setFellBack] = useState(false);
  const onFallback = useCallback(() => setFellBack(true), []);
  const tone = STATE_TONE[state];
  const status = state === 'idle' && systemHealth !== 'healthy' ? `PACIFIC OPS • ${systemHealth === 'down' ? 'OFFLINE' : 'DEGRADED'}` : STATE_STATUS[state];
  const webgl = typeof document !== 'undefined' && supportsWebGL();

  return (
    <div className={cn('presence', `presence--${framing}`, `presence--${state.replace('_', '-')}`, className)} data-state={state}>
      <div className="presence-stage" aria-hidden>
        <div className="presence-halo" />
        <Suspense fallback={<div className="presence-placeholder" />}>
          {webgl ? (
            <PresenceCanvas state={state} audioLevel={audioLevel ?? null} reducedMotion={reducedMotion} framing={framing} onFallback={onFallback} />
          ) : (
            <StaticPresence state={state} framing={framing} />
          )}
        </Suspense>
        <span className="presence-corner tl" />
        <span className="presence-corner tr" />
        <span className="presence-corner bl" />
        <span className="presence-corner br" />
      </div>

      <div className="presence-hud">
        {!hideStatusPill && (
          <div className={cn('presence-status', tone)} role="status" aria-live="polite">
            <i className={cn('dot', tone, state !== 'error' && 'dot--live')} aria-hidden />
            <span>{status}</span>
          </div>
        )}

        {telemetry.length > 0 && (
          <ul className="presence-tel presence-tel--left" aria-label="System links">
            {telemetry.map((t) => (
              <li key={t.label} className={t.tone ?? 'tone-idle'}>
                <span>{t.label}</span>
                <i className="presence-leader" aria-hidden />
              </li>
            ))}
          </ul>
        )}
        {annotations.length > 0 && (
          <ul className="presence-tel presence-tel--right" aria-label="Operational signals">
            {annotations.map((t) => (
              <li key={t.label} className={t.tone ?? 'tone-idle'}>
                <i className="presence-leader" aria-hidden />
                <span>{t.label}</span>
              </li>
            ))}
          </ul>
        )}

        {headline && <p className="presence-headline">“{headline}”</p>}

        {services.length > 0 && (
          <div className="presence-services" role="status" aria-label="Connected services">
            {services.map((s) => (
              <span key={s.name} className={cn('presence-service-item', s.tone ?? 'tone-idle')} title={s.statusText}>
                <span className="presence-service-name">{s.name}</span>
                <i className={cn('dot', s.tone ?? 'tone-idle', 'dot--live')} aria-hidden />
              </span>
            ))}
          </div>
        )}

        {fellBack && <span className="presence-note">Static view</span>}
      </div>
    </div>
  );
}

function StaticPresence({ state, framing }: { state: PacificOpsState; framing: 'hero' | 'compact' }) {
  const draw = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      if (!canvas) return;
      import('./fallback').then(({ drawStaticPresence }) => drawStaticPresence(canvas, state, framing));
    },
    [state, framing]
  );
  return <canvas ref={draw} className="presence-canvas" aria-hidden />;
}
