import { useEffect, useState } from 'react';
import type { RuntimeStateDTO } from './contract';
import { useData } from './DataProvider';
import { presentRuntime, type RuntimePresentation } from './runtime';
import type { PacificServices, RuntimeLink } from './services';

export interface PacificOpsRuntime {
  runtime: RuntimeStateDTO | null;
  link: RuntimeLink;
  view: RuntimePresentation;
}

interface Owned<T> {
  source: PacificServices;
  value: T;
}

/** Subscribes to the live Pacific Ops runtime for the current data source. */
export function usePacificOpsRuntime(): PacificOpsRuntime {
  const { services } = useData();
  const [state, setState] = useState<Owned<RuntimeStateDTO> | null>(null);
  const [linkState, setLinkState] = useState<Owned<RuntimeLink> | null>(null);

  useEffect(
    () =>
      services.runtime.subscribe({
        onState: (value) => setState({ source: services, value }),
        onLink: (value) => setLinkState({ source: services, value }),
      }),
    [services]
  );

  // Values from a previous data source (live <-> demo switch) are ignored, never shown.
  const runtime = state?.source === services ? state.value : null;
  const link = linkState?.source === services ? linkState.value : 'connecting';
  return { runtime, link, view: presentRuntime(runtime, link) };
}
