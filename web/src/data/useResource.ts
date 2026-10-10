import { useCallback, useEffect, useEffectEvent, useState } from 'react';
import type { DataSourceKind } from './contract';
import { useData } from './DataProvider';
import type { PacificServices, Topic } from './services';

interface ResourceState<T> {
  key: string | null;
  kind: DataSourceKind | null;
  data: T | undefined;
  error: Error | undefined;
}

export interface Resource<T> {
  data: T | undefined;
  error: Error | undefined;
  /** First load, nothing to show yet. */
  loading: boolean;
  /** Re-fetching after a live change while keeping the previous data on screen. */
  refreshing: boolean;
  reload: () => void;
}

/**
 * Loads data through the active service adapter and re-loads when any of the given
 * live topics change (SSE push, polling fallback, or manual refresh). Previous data
 * stays visible during refreshes so live updates never flash a skeleton.
 */
export function useResource<T>(
  load: (services: PacificServices) => Promise<T>,
  deps: readonly unknown[],
  topics: readonly Topic[]
): Resource<T> {
  const { services, versions } = useData();
  const [nonce, setNonce] = useState(0);
  const key = JSON.stringify([services.kind, deps, topics.map((t) => versions[t]), nonce]);
  const [state, setState] = useState<ResourceState<T>>({ key: null, kind: null, data: undefined, error: undefined });

  const run = useEffectEvent((s: PacificServices) => load(s));

  useEffect(() => {
    let cancelled = false;
    run(services).then(
      (data) => {
        if (!cancelled) setState({ key, kind: services.kind, data, error: undefined });
      },
      (error: unknown) => {
        if (cancelled) return;
        setState((prev) => ({
          key,
          kind: services.kind,
          data: prev.kind === services.kind ? prev.data : undefined,
          error: error instanceof Error ? error : new Error(String(error)),
        }));
      }
    );
    return () => {
      cancelled = true;
    };
  }, [key, services]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const settled = state.key === key;
  const data = state.kind === services.kind ? state.data : undefined;

  return {
    data,
    error: settled ? state.error : undefined,
    loading: !settled && data === undefined,
    refreshing: !settled && data !== undefined,
    reload,
  };
}
