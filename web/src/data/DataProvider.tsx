import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { DataSourceKind } from './contract';
import { createDemoServices } from './demoAdapter';
import { createHttpServices } from './httpAdapter';
import { ALL_TOPICS, type LinkState, type PacificServices, type Topic } from './services';

const STORAGE_KEY = 'pro.dataSource';
const HEALTH_REFRESH_MS = 20_000;

type Versions = Record<Topic, number>;

interface DataContextValue {
  services: PacificServices;
  mode: DataSourceKind;
  setMode: (mode: DataSourceKind) => void;
  link: LinkState;
  versions: Versions;
  lastChangeAt: number | null;
  refreshAll: () => void;
}

const DataContext = createContext<DataContextValue | null>(null);

function initialMode(): DataSourceKind {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'demo' || stored === 'live') return stored;
  } catch {
    /* storage unavailable */
  }
  return 'live';
}

const zeroVersions = (): Versions => ({ actions: 0, calls: 0, inbox: 0, activity: 0, health: 0 });

export function DataProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<DataSourceKind>(initialMode);
  const [link, setLink] = useState<LinkState>('connecting');
  const [versions, setVersions] = useState<Versions>(zeroVersions);
  const [lastChangeAt, setLastChangeAt] = useState<number | null>(null);

  const services = useMemo(() => (mode === 'demo' ? createDemoServices() : createHttpServices()), [mode]);

  const bump = useCallback((topics: Topic[]) => {
    setVersions((prev) => {
      const next = { ...prev };
      for (const t of topics) next[t] += 1;
      return next;
    });
  }, []);

  useEffect(() => {
    const unsubscribe = services.realtime.subscribe({
      onChange: (event) => {
        bump(event.topics);
        setLastChangeAt(Date.now());
      },
      onLinkState: setLink,
    });
    const healthTimer = window.setInterval(() => bump(['health']), HEALTH_REFRESH_MS);
    return () => {
      unsubscribe();
      window.clearInterval(healthTimer);
    };
  }, [services, bump]);

  const setMode = useCallback((next: DataSourceKind) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
    setModeState(next);
  }, []);

  const refreshAll = useCallback(() => bump(ALL_TOPICS), [bump]);

  const value = useMemo(
    () => ({ services, mode, setMode, link, versions, lastChangeAt, refreshAll }),
    [services, mode, setMode, link, versions, lastChangeAt, refreshAll]
  );

  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData(): DataContextValue {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useData must be used inside <DataProvider>');
  return ctx;
}
