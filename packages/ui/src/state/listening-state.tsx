/** Instance listening belongs to the local server, shared by tabs and its background poller. */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { fetchListening, setInstanceListening } from "../api/index.ts";
import { onReturnVisible, RETURN_READ_MIN_AGE_MS } from "../lib/visibility.ts";

export interface Listening {
  instances: string[];
  loading: boolean;
  error: string | null;
  pending: string[];
  setListening: (instance: string, listening: boolean) => Promise<boolean>;
  refresh: () => Promise<void>;
}
export interface ListeningApi {
  fetchListening: typeof fetchListening;
  setInstanceListening: typeof setInstanceListening;
}
const LIVE_API: ListeningApi = { fetchListening, setInstanceListening };
const ListeningContext = createContext<Listening | null>(null);

export function ListeningProvider({
  children,
  api = LIVE_API,
  enabled = true,
  pollMs = 15_000,
  returnReadMinAgeMs = RETURN_READ_MIN_AGE_MS,
}: {
  children: ReactNode;
  api?: ListeningApi;
  enabled?: boolean;
  /** Timing seams keep integration tests real-time without waiting production intervals. */
  pollMs?: number;
  returnReadMinAgeMs?: number;
}) {
  const [instances, setInstances] = useState<string[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string[]>([]);
  const changes = useRef(new Map<string, boolean>());
  const alive = useRef(true);
  const generation = useRef(0);
  const queue = useRef(Promise.resolve());
  /** When the last listening read completed; shared with `onReturnVisible`. */
  const lastReadAt = useRef(0);
  const refresh = useCallback(async () => {
    if (!enabled || changes.current.size > 0) return;
    const gen = ++generation.current;
    try {
      const result = await api.fetchListening();
      if (!alive.current || generation.current !== gen) return;
      setInstances((previous) =>
        JSON.stringify(previous) === JSON.stringify(result.instances) ? previous : result.instances,
      );
      setError(null);
    } catch (cause) {
      if (alive.current && generation.current === gen)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (alive.current && generation.current === gen) setLoading(false);
      lastReadAt.current = Date.now();
    }
  }, [api, enabled]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, pollMs);
    const unsubscribe = onReturnVisible(() => void refresh(), {
      minAgeMs: returnReadMinAgeMs,
      lastReadAt,
    });
    return () => {
      alive.current = false;
      generation.current += 1;
      clearInterval(timer);
      unsubscribe();
    };
  }, [refresh, pollMs, returnReadMinAgeMs]);

  const setListening = useCallback(
    async (instance: string, listening: boolean) => {
      if (!enabled || changes.current.has(instance)) return false;
      generation.current += 1;
      changes.current.set(instance, listening);
      setPending([...changes.current.keys()]);
      setError(null);
      // Serialize writes: each response contains the whole set, so out-of-order
      // responses must never restore an instance that a newer write removed.
      const task = queue.current.then(async () => {
        if (!alive.current) return false;
        try {
          const result = await api.setInstanceListening(instance, listening);
          if (alive.current) setInstances(result.instances);
          return true;
        } catch (cause) {
          if (alive.current) setError(cause instanceof Error ? cause.message : String(cause));
          return false;
        } finally {
          changes.current.delete(instance);
          if (alive.current) {
            setPending([...changes.current.keys()]);
            setLoading(false);
          }
        }
      });
      queue.current = task.then(() => {});
      return await task;
    },
    [api, enabled],
  );

  const value = useMemo<Listening>(
    () => ({
      // Disconnect immediately when Unlisten is clicked, including while its
      // local write is pending. A failed write restores the last confirmed set.
      instances: instances.filter((instance) => changes.current.get(instance) !== false),
      loading,
      error,
      pending,
      setListening,
      refresh,
    }),
    [instances, loading, error, pending, setListening, refresh],
  );
  return <ListeningContext.Provider value={value}>{children}</ListeningContext.Provider>;
}

export function useListeningIfAvailable(): Listening | null {
  return useContext(ListeningContext);
}
