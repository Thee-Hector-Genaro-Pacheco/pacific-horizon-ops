import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

const NowContext = createContext<number>(0);

/** One shared clock so every relative timestamp re-renders together, cheaply. */
export function NowProvider({ children, intervalMs = 15_000 }: { children: ReactNode; intervalMs?: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    const onVisible = () => document.visibilityState === 'visible' && setNow(Date.now());
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs]);
  return <NowContext.Provider value={now}>{children}</NowContext.Provider>;
}

export function useNow(): number {
  return useContext(NowContext);
}
