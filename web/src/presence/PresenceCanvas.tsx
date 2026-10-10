import { useEffect, useRef } from 'react';
import { detectTier, PresenceEngine } from './engine';
import { drawStaticPresence } from './fallback';
import type { PacificOpsState } from './states';

/**
 * Hosts the WebGL engine. Lazy-loaded so the graphics code never blocks first paint.
 * Pauses when off-screen or when the tab is hidden; falls back to a static frame
 * if WebGL is missing or the context is lost.
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
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<PresenceEngine | null>(null);
  const stateRef = useRef(state);
  const fallbackRef = useRef(false);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const tier = detectTier();
    const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;

    const fallBack = () => {
      fallbackRef.current = true;
      engineRef.current?.dispose();
      engineRef.current = null;
      drawStaticPresence(canvas, stateRef.current, framing);
      onFallback?.();
    };

    if (saveData) {
      fallBack();
      return;
    }

    let engine: PresenceEngine;
    try {
      engine = new PresenceEngine(canvas, {
        particleCount: tier.particleCount,
        maxDpr: tier.maxDpr,
        reducedMotion,
        framing,
        onContextLost: fallBack,
      });
    } catch {
      fallBack();
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
  }, [reducedMotion, framing, onFallback]);

  useEffect(() => {
    if (engineRef.current) engineRef.current.setState(state);
    else if (fallbackRef.current && canvasRef.current) drawStaticPresence(canvasRef.current, state, framing);
  }, [state, framing]);

  useEffect(() => {
    engineRef.current?.setAudioLevel(audioLevel);
  }, [audioLevel]);

  return <canvas ref={canvasRef} className="presence-canvas" aria-hidden />;
}
