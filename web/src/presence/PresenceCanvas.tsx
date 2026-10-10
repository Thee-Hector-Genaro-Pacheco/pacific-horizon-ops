import { useEffect, useRef, useState } from 'react';
import { detectTier, PresenceEngine } from './engine';
import { drawStaticPresence } from './fallback';
import type { PacificOpsState } from './states';

/**
 * Hosts the WebGL engine. Lazy-loaded so the graphics code never blocks first paint.
 * Pauses when off-screen or when the tab is hidden; falls back to a static frame
 * on a dedicated 2D canvas if WebGL is missing or the context is lost.
 */
export default function PresenceCanvas({
  state,
  audioLevel,
  reducedMotion,
  framing,
  onFallback,
}: {
  state: PacificOpsState;
  audioLevel: number | null;
  reducedMotion: boolean;
  framing: 'hero' | 'compact';
  onFallback?: () => void;
}) {
  const [fellBack, setFellBack] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fallbackCanvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<PresenceEngine | null>(null);
  const stateRef = useRef(state);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (fellBack) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const tier = detectTier();
    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;

    const triggerFallback = () => {
      engineRef.current?.dispose();
      engineRef.current = null;
      setFellBack(true);
      onFallback?.();
    };

    if (saveData) {
      triggerFallback();
      return;
    }

    let engine: PresenceEngine;
    try {
      engine = new PresenceEngine(canvas, {
        particleCount: tier.particleCount,
        maxDpr: tier.maxDpr,
        reducedMotion,
        framing,
        onContextLost: triggerFallback,
      });
    } catch {
      triggerFallback();
      return;
    }
    engineRef.current = engine;
    engine.setState(stateRef.current);

    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      engine.resize(width, height);
    });
    ro.observe(canvas);

    let visible = true;
    const sync = () => {
      if (visible && document.visibilityState === 'visible') engine.start();
      else engine.stop();
    };
    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      sync();
    });
    io.observe(canvas);
    document.addEventListener('visibilitychange', sync);
    sync();

    return () => {
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', sync);
      engine.dispose();
      engineRef.current = null;
    };
  }, [fellBack, reducedMotion, framing, onFallback]);

  useEffect(() => {
    if (engineRef.current) {
      engineRef.current.setState(state);
    } else if (fellBack && fallbackCanvasRef.current) {
      drawStaticPresence(fallbackCanvasRef.current, state, framing);
    }
  }, [state, framing, fellBack]);

  useEffect(() => {
    engineRef.current?.setAudioLevel(audioLevel);
  }, [audioLevel]);

  if (fellBack) {
    return (
      <canvas
        ref={(el) => {
          fallbackCanvasRef.current = el;
          if (el) drawStaticPresence(el, state, framing);
        }}
        key="fallback-canvas"
        className="presence-canvas"
        aria-hidden
      />
    );
  }

  return <canvas ref={canvasRef} key="webgl-canvas" className="presence-canvas" aria-hidden />;
}
