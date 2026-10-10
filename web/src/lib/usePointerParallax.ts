import { useEffect, type RefObject } from 'react';

/**
 * Restrained pointer parallax for the Command Center hero.
 *
 * Writes --px / --py (each -1..1) on the element; CSS decides how far each layer moves
 * (a few pixels at most). Desktop only: skipped for coarse pointers and for users who
 * prefer reduced motion. Pointer events are coalesced to one style write per frame.
 */
export function usePointerParallax(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof window === 'undefined' || !window.matchMedia) return;
    const fine = window.matchMedia('(pointer: fine)');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (!fine.matches || reduced.matches) return;

    let frame = 0;
    let nx = 0;
    let ny = 0;
    const write = () => {
      frame = 0;
      el.style.setProperty('--px', nx.toFixed(3));
      el.style.setProperty('--py', ny.toFixed(3));
    };
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      nx = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
      ny = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1));
      if (!frame) frame = requestAnimationFrame(write);
    };
    const onLeave = () => {
      nx = 0;
      ny = 0;
      if (!frame) frame = requestAnimationFrame(write);
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerleave', onLeave);
    return () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      if (frame) cancelAnimationFrame(frame);
      el.style.removeProperty('--px');
      el.style.removeProperty('--py');
    };
  }, [ref]);
}
