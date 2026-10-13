'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';

export interface ResourceState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
}

export interface Resource<T> {
  use(): ResourceState<T> & { refresh: () => void };
  refresh(): Promise<void>;
}

const FRESH_MS = 2_000;

export function createResource<T>(url: string, parse: (json: unknown) => T): Resource<T> {
  let state: ResourceState<T> = { data: null, error: null, loading: true };
  let fetchedAt = 0;
  let inFlight: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const serverState: ResourceState<T> = { data: null, error: null, loading: true };

  const set = (next: Partial<ResourceState<T>>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };

  const load = (): Promise<void> => {
    if (inFlight) return inFlight;
    if (state.data === null) set({ loading: true });
    inFlight = fetch(url)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Server returned ${response.status}`);
        const json: unknown = await response.json();
        fetchedAt = Date.now();
        set({ data: parse(json), error: null, loading: false });
      })
      .catch((error: unknown) => {
        set({ error: error instanceof Error ? error : new Error('Request failed'), loading: false });
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  return {
    refresh: load,
    use() {
      const current = useSyncExternalStore(subscribe, () => state, () => serverState);
      useEffect(() => {
        if (Date.now() - fetchedAt > FRESH_MS) void load();
      }, []);
      const refresh = useCallback(() => void load(), []);
      return { ...current, refresh };
    },
  };
}
