/**
 * Open file requests across the fleet (attachments plan §8.6, scenario D).
 *
 * A request raised from Telegram or a cron session has no chat card anywhere,
 * so the bell, the fleet table's `▣ n` badge and the agent's Files tab read
 * the box's own slot list instead: one shared poller asks each running
 * agent's hermeticd for its open requests (`files.list {requests: true}`).
 *
 * Seeded by request on mount, never by a push it may have missed. Polls at a
 * modest interval and again when the window comes back, never two passes at
 * once, and lets each request go when the provider unmounts. A box that
 * cannot answer (an older hermeticd with no files service, a box mid-reboot)
 * reads as having no open requests, and is asked again only after a growing
 * back-off: a failed request is logged by the head, and a dead box polled
 * every minute would fill that log.
 *
 * Each pass and each read holds the `AbortController` it started under, so a
 * pass the provider has since aborted never reads on its successor's signal
 * or clears its successor's bookkeeping. The counts and back-off belong to one
 * fleet: a switch drops them (`Portal` remounts the provider on a fleet
 * switch too; this covers a fleet id that moves under a mounted provider).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { filesList } from "../api/files.ts";
import type { FileRequestView } from "../api/files.ts";
import { fleetIdOf, isInitialized } from "../api/index.ts";
import { openRequests } from "../components/agent/files-logic.ts";
import { onReturnVisible } from "../lib/visibility.ts";
import { useFleetIfAvailable } from "./state.tsx";

/** How often the fleet's open requests are re-read while the page is up. */
export const FILE_REQUESTS_POLL_MS = 60_000;
/** How many boxes are asked at once: a fan-out over the tailnet, kept small. */
const CONCURRENCY = 4;
/** The longest a box that keeps failing waits before it is asked again. */
const MAX_BACKOFF_MS = 30 * 60_000;

/** One open request, with the agent it belongs to. */
export interface OpenFileRequest {
  agent: string;
  request: FileRequestView;
}

export interface FileRequests {
  /** Open requests per agent; an agent with none (or that could not answer) is absent. */
  byAgent: ReadonlyMap<string, readonly FileRequestView[]>;
  /** Every open request, oldest first. */
  all: readonly OpenFileRequest[];
  /** Re-read one agent now (after a deliver, a decline), or every running agent. */
  refresh: (agent?: string) => void;
}

const FileRequestsContext = createContext<FileRequests | null>(null);

/** Statuses whose box answers its files service: the poller's gate, and the Files tab's. */
export function filesServiceUp(status: string): boolean {
  return status === "ready" || status === "degraded";
}

/** Same ids in the same states: a re-read that changed nothing renders nothing. */
function sameRequests(
  a: readonly FileRequestView[] | undefined,
  b: readonly FileRequestView[],
): boolean {
  if (a === undefined) return b.length === 0;
  if (a.length !== b.length) return false;
  return a.every((r, i) => r.request_id === b[i]?.request_id && r.state === b[i]?.state);
}

export function FileRequestsProvider({ children }: { children: ReactNode }) {
  const fleet = useFleetIfAvailable();
  const enabled = fleet !== null && isInitialized(fleet.meta);
  const fleetId = fleetIdOf(fleet?.meta);
  const names = useMemo(
    () =>
      (fleet?.agents ?? [])
        .filter((a) => filesServiceUp(a.display_status))
        .map((a) => a.name)
        .sort(),
    [fleet?.agents],
  );
  const namesKey = names.join("\u0000");
  const namesRef = useRef(names);
  namesRef.current = names;

  const [byAgent, setByAgent] = useState<ReadonlyMap<string, readonly FileRequestView[]>>(
    () => new Map(),
  );
  const abort = useRef<AbortController | null>(null);
  /** The fleet the counts and back-off below were read for. */
  const readFor = useRef<string | null>(null);
  const inFlight = useRef(new Set<string>());
  /** Boxes asked for again while a read was in flight: read once more when it lands. */
  const again = useRef(new Set<string>());
  /** A whole pass is running; another asked for meanwhile runs once it ends. */
  const passing = useRef(false);
  const passAgain = useRef(false);
  const backoff = useRef(new Map<string, { failures: number; until: number }>());
  const lastReadAt = useRef(0);

  const store = useCallback((agent: string, open: readonly FileRequestView[]) => {
    setByAgent((prev) => {
      if (sameRequests(prev.get(agent), open)) return prev;
      const next = new Map(prev);
      if (open.length === 0) next.delete(agent);
      else next.set(agent, open);
      return next;
    });
  }, []);

  /**
   * Ask one box, under the controller the caller started with. Resolves either
   * way; a failure reads as no open requests.
   */
  const readOne = useCallback(
    async (agent: string, force: boolean, controller: AbortController): Promise<void> => {
      const signal = controller.signal;
      if (signal.aborted || abort.current !== controller) return;
      if (inFlight.current.has(agent)) {
        // The read in flight may predate whatever the caller just did.
        if (force) again.current.add(agent);
        return;
      }
      const held = backoff.current.get(agent);
      if (!force && held !== undefined && Date.now() < held.until) return;
      inFlight.current.add(agent);
      try {
        do {
          again.current.delete(agent);
          try {
            const list = await filesList(agent, { requests: true, signal });
            if (signal.aborted) return;
            backoff.current.delete(agent);
            store(agent, openRequests(list.requests));
          } catch {
            if (signal.aborted) return;
            const failures = (backoff.current.get(agent)?.failures ?? 0) + 1;
            const wait = Math.min(MAX_BACKOFF_MS, FILE_REQUESTS_POLL_MS * 2 ** (failures - 1));
            backoff.current.set(agent, { failures, until: Date.now() + wait });
            store(agent, []);
          }
        } while (again.current.has(agent) && !signal.aborted);
      } finally {
        // An aborted read's bookkeeping was already cleared, and may now be the live pass's.
        if (abort.current === controller) inFlight.current.delete(agent);
      }
    },
    [store],
  );

  /** Every running agent, a few at a time; never two passes at once. */
  const pass = useCallback(async (): Promise<void> => {
    const controller = abort.current;
    if (controller === null || controller.signal.aborted) return;
    if (passing.current) {
      passAgain.current = true;
      return;
    }
    passing.current = true;
    try {
      do {
        passAgain.current = false;
        lastReadAt.current = Date.now();
        const queue = [...namesRef.current];
        const worker = async (): Promise<void> => {
          for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
            await readOne(next, false, controller);
          }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
      } while (passAgain.current && !controller.signal.aborted && abort.current === controller);
    } finally {
      // Only the live pass clears the flag; an aborted one leaves its successor's alone.
      if (abort.current === controller) passing.current = false;
    }
  }, [readOne]);

  // The poller's life: seeded by request on mount, then on a timer and on return.
  useEffect(() => {
    if (!enabled) return;
    if (readFor.current !== fleetId) {
      // Another fleet: its boxes' counts and back-off are not this one's.
      readFor.current = fleetId;
      backoff.current.clear();
      setByAgent((prev) => (prev.size === 0 ? prev : new Map()));
    }
    const controller = new AbortController();
    abort.current = controller;
    const timer = setInterval(() => void pass(), FILE_REQUESTS_POLL_MS);
    const stopReturn = onReturnVisible(() => void pass(), { lastReadAt });
    return () => {
      controller.abort();
      if (abort.current === controller) abort.current = null;
      clearInterval(timer);
      stopReturn();
      inFlight.current.clear();
      again.current.clear();
      passing.current = false;
      passAgain.current = false;
    };
  }, [enabled, pass, fleetId]);

  // The running set moved: read the agents that arrived, forget the ones that left.
  useEffect(() => {
    if (!enabled) return;
    const live = new Set(namesRef.current);
    setByAgent((prev) => {
      const gone = [...prev.keys()].filter((name) => !live.has(name));
      if (gone.length === 0) return prev;
      const next = new Map(prev);
      for (const name of gone) next.delete(name);
      return next;
    });
    void pass();
    // `fleetId` too: another fleet's boxes are read afresh even under the same names.
  }, [enabled, namesKey, fleetId, pass]);

  const refresh = useCallback(
    (agent?: string) => {
      if (agent === undefined) {
        void pass();
        return;
      }
      const controller = abort.current;
      if (controller !== null) void readOne(agent, true, controller);
    },
    [pass, readOne],
  );

  const value = useMemo<FileRequests>(() => {
    const all: OpenFileRequest[] = [];
    for (const [agent, requests] of byAgent) {
      for (const request of requests) all.push({ agent, request });
    }
    all.sort((a, b) => Date.parse(a.request.created_at) - Date.parse(b.request.created_at));
    return { byAgent, all, refresh };
  }, [byAgent, refresh]);

  return <FileRequestsContext.Provider value={value}>{children}</FileRequestsContext.Provider>;
}

/** The fleet's open requests, or `null` in a tree with no provider (a test about something else). */
export function useFileRequestsIfAvailable(): FileRequests | null {
  return useContext(FileRequestsContext);
}

/** How many open requests `agent` has; zero without a provider. */
export function useOpenRequestCount(agent: string): number {
  return useContext(FileRequestsContext)?.byAgent.get(agent)?.length ?? 0;
}
