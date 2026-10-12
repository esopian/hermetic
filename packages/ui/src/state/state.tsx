/**
 * One live fleet in one hook. The SSE stream is the source of truth (§11.2:
 * there is no incremental sync, so a poll-diff stream is the whole story); the
 * one-shot `listAgents()` is only a fallback for when the stream cannot open.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  fleetStream,
  fleetTarget,
  followOp,
  getMeta,
  isInitialized,
  listAgents,
  listFleets,
  listOps,
  listProfiles,
  listVolumes,
  onAgentWritten,
  sameFleetTarget,
  setFleetTarget,
  switchFleet,
  targetOf,
} from "../api/index.ts";
import type {
  AgentView,
  FleetListEntry,
  FleetTarget,
  Meta,
  NotificationView,
  ProfileView,
  VolumeList,
  VolumeView,
} from "../api/index.ts";
import { FETCH_KEYS, invalidateFetchCache } from "../lib/fetch-cache.ts";
import { DEFAULT_TAILNET, latestHermes } from "../logic/format.ts";

export type Layout = "board" | "table" | "triage";

export interface Fleet {
  agents: AgentView[];
  byName: Map<string, AgentView>;
  meta: Meta | null;
  metaError: string | null;
  metaLoading: boolean;
  connected: boolean;
  /** The stream has been open at least once, so a drop is a reconnect. */
  everConnected: boolean;
  /**
   * The server has read the fleet at least once. Until it has, an empty agent
   * list means "nobody has looked yet", and the board owes the operator a
   * skeleton rather than "no agents here".
   */
  scanned: boolean;
  /** The last scan the server reported failing, cleared by the next good one. */
  scanError: string | null;
  /** Epoch ms of the next reconnect attempt, so the footer can count down. */
  retryAt: number | null;
  lastPollAt: string | null;
  /** Agents created in this session, so the table can tag them `NEW`. */
  fresh: Set<string>;
  /** Running op per agent name, so reopening a drawer re-attaches to it. */
  opsByAgent: Record<string, string>;
  latest: string | null;
  /** `meta.tailnet` when core knows it, else the built-in default. */
  tailnet: string;
  /**
   * §4.8: every fleet this account has, as `fleets.list` reports them. `null`
   * until the first read comes back, which is what lets the switcher draw a
   * skeleton instead of claiming this laptop knows about exactly one fleet.
   */
  fleets: FleetListEntry[] | null;
  /** The last `fleets.list` *request* failure, cleared by the next good read. */
  fleetsError: string | null;
  /**
   * What core reported about the account-global directory on the last good
   * read: `null` when it answered, otherwise why it could not be reached. A
   * different fact from `fleetsError` — the list still came back, it is just
   * the local half of it.
   */
  directoryError: string | null;
  /** Re-reads `/api/fleets`; called after a switch and after a default change. */
  refreshFleets: () => Promise<void>;
  /**
   * Repoints the server at another fleet and this page with it. Rejects with the
   * `ApiError` the route answered — `CONFLICT` while an op is in flight,
   * `NOT_FOUND` for a fleet that is not frozen here — so the caller that
   * offered the switch is the one that reports it, inline and in place.
   */
  /** Repoint this portal at another frozen fleet, by `fleet_id` or display alias. */
  switchTo: (fleet: string) => Promise<void>;
  /** Re-reads `/api/meta`; the init wizard polls it until the home is bound. */
  refreshMeta: () => Promise<Meta | null>;
  /** Reopens the fleet stream and reseeds the table (used after `init`). */
  resync: () => void;
  setOp: (name: string, opId: string | null) => void;
  markFresh: (name: string) => void;
  /** Clears one agent's `NEW` tag (called on ready/error/destroyed, or after 10 minutes). */
  clearFresh: (name: string) => void;
  /**
   * §4.9: listen for the `notification` and `notifications` frames the
   * fleet stream carries. The inbox rides this socket rather than opening one
   * of its own — one subscription per window — so `NotifyProvider`
   * registers here instead of calling `fleetStream` a second time. Returns the
   * unsubscribe.
   */
  subscribeNotifications: (handlers: NotificationStreamHandlers) => () => void;
}

/** What `subscribeNotifications` forwards, straight off the two SSE frames. */
export interface NotificationStreamHandlers {
  onNotification: (notification: NotificationView) => void;
  onCounts: (counts: { unread: number; needs_action: number }) => void;
}

const FleetContext = createContext<Fleet | null>(null);

/** A `NEW` tag never outlives its agent's first 10 minutes, even if it never reports ready. */
const FRESH_TTL_MS = 10 * 60 * 1000;

/** `display_status` values past which a `NEW` tag stops meaning anything. */
const FRESH_TERMINAL = new Set(["ready", "error", "destroyed"]);

export function FleetProvider({ children }: { children: ReactNode }) {
  const [byName, setByName] = useState<Map<string, AgentView>>(() => new Map());
  const [meta, setMeta] = useState<Meta | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [metaLoading, setMetaLoading] = useState(true);
  const metaRequest = useRef(0);
  const [connected, setConnected] = useState(false);
  const [everConnected, setEverConnected] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [lastPollAt, setLastPollAt] = useState<string | null>(null);
  const [opsByAgent, setOpsByAgent] = useState<Record<string, string>>({});
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const [epoch, setEpoch] = useState(0);
  const [fleets, setFleets] = useState<FleetListEntry[] | null>(null);
  const [fleetsError, setFleetsError] = useState<string | null>(null);
  const [directoryError, setDirectoryError] = useState<string | null>(null);
  const gotSnapshot = useRef(false);
  /**
   * The notification listeners, in a ref rather than in state: the stream
   * effect below is keyed on `epoch`/`live` and must not tear down and
   * reconnect the socket because a consumer mounted.
   */
  const notifyListeners = useRef<Set<NotificationStreamHandlers>>(new Set());
  const subscribeNotifications = useCallback((handlers: NotificationStreamHandlers) => {
    const set = notifyListeners.current;
    set.add(handlers);
    return () => {
      set.delete(handlers);
    };
  }, []);
  const freshTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  /**
   * §4.7: the fleet this page has adopted — the same triple `api.ts` sends on
   * every mutation, kept here as well so the provider can tell "the server is
   * still serving the fleet I am rendering" from "the server has moved".
   *
   * A ref rather than state: it is read inside the callback that decides, and
   * what that callback needs is the value as of the decision, not the value the
   * last render closed over.
   */
  const adopted = useRef<FleetTarget | null>(null);
  /**
   * Bumped whenever the fleet under this page is dropped, so a `listAgents()`
   * that was in flight across the change can tell its answer describes the
   * fleet the page has left.
   */
  const agentsRead = useRef(0);
  /**
   * Ops this page started or adopted through `setOp`, and the watcher following
   * each to its end. See the op-watcher effect below for why the registry's own
   * list is not watched.
   */
  const watchable = useRef<Set<string>>(new Set());
  const opWatchers = useRef<Map<string, () => void>>(new Map());

  // Timers are per-hook-instance state, not React state; clear them all on unmount
  // so a dismissed FleetProvider does not keep firing setFresh into the void.
  useEffect(() => {
    const timers = freshTimers.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  const resync = useCallback(() => {
    agentsRead.current++;
    gotSnapshot.current = false;
    setScanned(false);
    setScanError(null);
    // The footer's fleet square is judged by the last poll's age, and an age
    // carried across a resync would be the previous fleet's wearing this one's.
    setLastPollAt(null);
    setEpoch((n) => n + 1);
  }, []);

  const refreshFleets = useCallback(async (): Promise<void> => {
    try {
      const list = await listFleets();
      setFleets(list.fleets);
      setFleetsError(null);
      setDirectoryError(list.directory_error);
    } catch (e) {
      // The last good list stays on screen: a failed read is a fact about this
      // request, not evidence that a fleet stopped existing. The directory
      // note goes, though — it described a read that did come back, and this
      // one did not, so keeping it would attribute a stale diagnosis to it.
      setFleetsError(e instanceof Error ? e.message : String(e));
      setDirectoryError(null);
    }
  }, []);

  /**
   * Everything this page has to forget when the fleet under it changes.
   *
   * Running op ids and `NEW` tags name agents that are not in the new fleet,
   * and the table is the old fleet's rows; the stream has to be reopened
   * against the new one. One function because two callers need it and they must
   * not come to disagree about what a fleet change costs: `switchTo`, where the
   * move is this page's own doing, and `refreshMeta`, where it happened behind
   * this page's back.
   */
  const dropFleetState = useCallback((): void => {
    setOpsByAgent({});
    setFresh(new Set());
    setByName(new Map());
    // The timers behind those `NEW` tags too, not only the tags: a pending one
    // fires `clearFresh(name)` by *name*, and the new fleet may well have an
    // agent by the same name — which would then lose its own badge early,
    // on the old fleet's clock.
    for (const t of freshTimers.current.values()) clearTimeout(t);
    freshTimers.current.clear();
    // The op watchers too: their ops belong to the old fleet, and a refresh
    // they fired on finishing would be read against the new one.
    for (const stop of opWatchers.current.values()) stop();
    opWatchers.current.clear();
    watchable.current.clear();
    resync();
  }, [resync]);

  /**
   * The whole switch, in the order the page has to see it: the server moves
   * first, then this page adopts the `/api/meta` the same reply carried (no
   * second read, which could answer from either side of the move), then every
   * per-agent memory of the *old* fleet is dropped, and only then is the stream
   * reopened against the new one.
   */
  const switchTo = useCallback(
    async (fleet: string): Promise<void> => {
      const result = await switchFleet(fleet);
      metaRequest.current++;
      setMeta(result.meta);
      // Before anything else this page does: from here every mutation names
      // the fleet the server just moved to, and nothing composed against the
      // previous one can still be sent (§4.7).
      const target = targetOf(result.meta);
      adopted.current = target;
      setFleetTarget(target);
      setMetaError(null);
      setMetaLoading(false);
      dropFleetState();
      await refreshFleets();
    },
    [dropFleetState, refreshFleets],
  );

  const refreshMeta = useCallback(async (): Promise<Meta | null> => {
    const request = ++metaRequest.current;
    setMetaLoading(true);
    setMetaError(null);
    try {
      const next = await getMeta();
      if (request !== metaRequest.current) return null;
      setMeta(next);
      /**
       * §4.7: adopting a meta is what moves the fleet this tab's mutations
       * name. It happens here and not in `getMeta` because a reply that lost
       * the race above is discarded, and a request must never claim a fleet
       * the page decided not to show.
       *
       * And a `/api/meta` that names a *different* fleet is a switch this page
       * did not make — another tab's, or a `hermetic fleet use` on the CLI, and
       * fleet selection is a property of the whole server (§4.8). Repointing
       * the target and leaving the rest alone was the worst of both: the table
       * went on showing the old fleet's agents while every mutation composed
       * from those rows named the new one, which is the exact confusion the
       * target exists to prevent. So this page pays the same price `switchTo`
       * does, and the screen and the requests move together.
       */
      const target = targetOf(next);
      const moved = adopted.current !== null && !sameFleetTarget(adopted.current, target);
      adopted.current = target;
      setFleetTarget(target);
      if (moved) {
        dropFleetState();
        void refreshFleets();
      }
      return next;
    } catch (e) {
      if (request === metaRequest.current) setMetaError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      if (request === metaRequest.current) setMetaLoading(false);
    }
  }, [dropFleetState, refreshFleets]);

  useEffect(() => {
    void refreshMeta();
    return () => {
      metaRequest.current++;
    };
  }, [refreshMeta]);

  // Before `init` there is no fleet and no poller: `/api/fleet/stream` answers
  // 501 and `agents.list` answers NOT_INITIALIZED, so nothing subscribes until
  // meta says this home is bound.
  const live = meta !== null && isInitialized(meta);
  const wasLive = useRef(live);

  /**
   * One read when the home turns out to be bound, and one more after every
   * switch or default change (both call `refreshFleets` themselves). There is
   * no poll: fleets are created by `init` and removed by `teardown`, neither of
   * which happens behind this page's back within a session.
   *
   * Also read when the server reports `fleet_error` — several fleets are frozen
   * here and none was selected, or the one named is not. The home is not
   * "uninitialized" in that state, it is *unchosen*, and the list is the whole
   * content of the choice the App is about to offer.
   */
  const needFleets = live || (meta?.fleet_error ?? null) !== null;
  useEffect(() => {
    if (!needFleets) return;
    void refreshFleets();
  }, [needFleets, refreshFleets]);

  // A foundation teardown (or any other initialized → uninitialized flip)
  // leaves stale op ids behind — the agents they pointed at are gone along
  // with the fleet, so nothing should ever try to re-attach to them.
  useEffect(() => {
    if (wasLive.current && !live) {
      setOpsByAgent({});
    }
    wasLive.current = live;
  }, [live]);

  const clearFresh = useCallback((name: string) => {
    setFresh((prev) => {
      if (!prev.has(name)) return prev;
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
    const t = freshTimers.current.get(name);
    if (t !== undefined) {
      clearTimeout(t);
      freshTimers.current.delete(name);
    }
  }, []);

  const markFresh = useCallback(
    (name: string) => {
      setFresh((prev) => new Set(prev).add(name));
      const existing = freshTimers.current.get(name);
      if (existing !== undefined) clearTimeout(existing);
      freshTimers.current.set(
        name,
        setTimeout(() => clearFresh(name), FRESH_TTL_MS),
      );
    },
    [clearFresh],
  );

  useEffect(() => {
    if (!live) return;
    const stop = fleetStream({
      onSnapshot: (agents, at, wasScanned) => {
        gotSnapshot.current = true;
        setByName(new Map(agents.map((a) => [a.name, a])));
        // A snapshot from a poller that has not scanned yet carries an empty
        // list and an epoch-zero `at`; recording either as a real read is what
        // used to make a cold start claim the fleet was empty.
        if (!wasScanned) return;
        setScanned(true);
        setScanError(null);
        setLastPollAt(at);
      },
      onAgent: (agent) => {
        setByName((prev) => {
          const next = new Map(prev);
          next.set(agent.name, agent);
          return next;
        });
        if (FRESH_TERMINAL.has(agent.display_status)) clearFresh(agent.name);
      },
      onRemoved: (name) => {
        setByName((prev) => {
          if (!prev.has(name)) return prev;
          const next = new Map(prev);
          next.delete(name);
          return next;
        });
        /**
         * §6.7: a finished destroy deletes the row, and the name is free for a
         * new agent. The drawer that followed the destroy closes with the row
         * (`shouldDeselect`), so nothing is left to clear its op id or its
         * `NEW` tag — and a successor under the same name must not open onto
         * the old agent's finished destroy. The op's own watcher is not
         * stopped here; it ends itself on `done` and re-reads the fleet.
         */
        clearFresh(name);
        setOpsByAgent((prev) => {
          if (!(name in prev)) return prev;
          const next = { ...prev };
          delete next[name];
          return next;
        });
      },
      onPoll: (at) => {
        setLastPollAt(at);
        setScanned(true);
        setScanError(null);
      },
      onConnected: (isConnected) => {
        setConnected(isConnected);
        if (isConnected) {
          setEverConnected(true);
          setRetryAt(null);
        }
      },
      // A scan that threw is the server failing to read AWS, not the socket
      // failing: the stream stays up, the last good fleet stays on screen, and
      // this is what the footer and the first-paint skeleton report.
      onScanError: setScanError,
      onRetryIn: (delayMs) => setRetryAt(Date.now() + delayMs),
      onNotification: (notification) => {
        for (const l of notifyListeners.current) l.onNotification(notification);
      },
      onNotifications: (counts) => {
        for (const l of notifyListeners.current) l.onCounts(counts);
      },
    });
    // Fallback: if no snapshot lands, fetch the list once so the page is not empty.
    const t = setTimeout(() => {
      if (gotSnapshot.current) return;
      listAgents()
        .then((agents) => {
          setByName(new Map(agents.map((a) => [a.name, a])));
          // The fallback answered, so the board has a real read to draw and
          // stops being a skeleton even though the stream never opened.
          setScanned(true);
          setScanError(null);
        })
        .catch((e: unknown) => {
          // Nothing to render and no stream: the skeleton becomes the failed
          // panel, which is the one loading state with a button on it.
          setScanError(e instanceof Error ? e.message : String(e));
        });
    }, 2500);
    return () => {
      clearTimeout(t);
      stop();
    };
  }, [epoch, live, clearFresh]);

  /**
   * A reload loses the in-memory op map, so ask the registry which ops are
   * still running and re-attach to them by target.
   *
   * Keyed on `connected` as well as `live`: a portal that restarts resumes the
   * ops it was running (server `resume.ts`), and those are ops this page has
   * never seen. Re-asking when the fleet stream comes back is what puts them
   * on the board without the operator reloading or opening a drawer.
   */
  useEffect(() => {
    if (!live || !connected) return;
    let alive = true;
    listOps({ status: "running" })
      .then((ops) => {
        if (!alive) return;
        const next: Record<string, string> = {};
        for (const op of ops) if (op.target) next[op.target] ??= op.id;
        // The registry wins where it has an answer: after a portal restart the
        // page may still be holding the id of an op that died with the old
        // process, and the resumed op has a different one only if it is a
        // different op. Agents the registry says nothing about keep whatever
        // this page just started for them.
        setOpsByAgent((prev) => ({ ...prev, ...next }));
      })
      .catch(() => {
        /* no op registry answer just means no progress bars */
      });
    return () => {
      alive = false;
    };
  }, [live, connected]);

  /**
   * One full re-read of the fleet. The stream is still the source of truth;
   * this is for the moment the page *knows* the fleet changed and the next poll
   * is up to a minute away (`POLL_INTERVAL_MS`). A name the answer lacks is
   * dropped, so a finished `destroy` loses its row too; a name it has is taken
   * from it unless the row already held is at a higher `version` — a write's
   * answer or a stream frame that landed while this read was in the air — so
   * the re-read cannot hand a drawer back a version core has moved past.
   */
  const refreshAgents = useCallback(async (): Promise<void> => {
    const read = agentsRead.current;
    try {
      const agents = await listAgents();
      if (read !== agentsRead.current) return;
      setByName((prev) => {
        const next = new Map<string, AgentView>();
        for (const a of agents) {
          const held = prev.get(a.name);
          next.set(a.name, held !== undefined && held.version > a.version ? held : a);
        }
        return next;
      });
    } catch {
      /* the next poll carries the change anyway; this was only a head start */
    }
  }, []);

  /**
   * A finished op is when the fleet is known to have moved — a create that
   * just finished has an agent the board has never seen — so each op this page
   * started is followed to its end and the table re-read then.
   *
   * Only ops that came through `setOp`, not the ones the registry answer above
   * merges in after a reload. The watcher does not resume the op
   * (`resumes: false`): the transport keeps one replay cursor per op, and a
   * watcher still reading after its drawer closed would otherwise move it, so a
   * drawer reopened mid-op would resume past the phases it has to draw.
   *
   * A watcher is not stopped when its id leaves `opsByAgent`: the drawer clears
   * the id on the same `done` frame, and stopping here could beat the frame to
   * the watcher. It stops itself on `done`, on a fleet change and on unmount.
   */
  useEffect(() => {
    const watching = opWatchers.current;
    for (const opId of Object.values(opsByAgent)) {
      if (!watchable.current.has(opId) || watching.has(opId)) continue;
      let ended = false;
      const stop = followOp(
        opId,
        () => {},
        () => {
          ended = true;
          watching.delete(opId);
          watchable.current.delete(opId);
          void refreshAgents();
        },
        { resumes: false },
      );
      if (!ended) watching.set(opId, stop);
    }
  }, [opsByAgent, refreshAgents]);

  useEffect(() => {
    const watching = opWatchers.current;
    return () => {
      for (const stop of watching.values()) stop();
      watching.clear();
    };
  }, []);

  /**
   * A row a write answered with is the newest the page can have: core wrote it
   * a moment ago, and the stream will not carry it until the next scan. Adopted
   * so a drawer's next version-guarded write sends the version core holds, and
   * dropped when it is about another fleet than the one on screen, about an
   * agent the board does not hold (the stream introduces rows; a write only
   * moves one on), or older than the row already here (two unguarded writes
   * whose answers crossed).
   */
  useEffect(
    () =>
      onAgentWritten((written, row) => {
        if (!sameFleetTarget(fleetTarget(), written)) return;
        setByName((prev) => {
          const held = prev.get(row.name);
          if (held === undefined || typeof row.version !== "number") return prev;
          if (held.version > row.version) return prev;
          const next = new Map(prev);
          next.set(row.name, row);
          return next;
        });
      }),
    [],
  );

  const setOp = useCallback((name: string, opId: string | null) => {
    if (opId !== null) watchable.current.add(opId);
    setOpsByAgent((prev) => {
      // An id cleared or replaced before the watcher effect ran never gets a
      // watcher, so it must not wait in `watchable` for one for ever.
      const was = prev[name];
      if (was !== undefined && was !== opId && !opWatchers.current.has(was)) {
        watchable.current.delete(was);
      }
      if (opId === null) {
        if (!(name in prev)) return prev;
        const next = { ...prev };
        delete next[name];
        return next;
      }
      return { ...prev, [name]: opId };
    });
  }, []);

  const value = useMemo<Fleet>(() => {
    const agents = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    return {
      agents,
      byName,
      meta,
      metaError,
      metaLoading,
      connected,
      everConnected,
      scanned,
      scanError,
      retryAt,
      lastPollAt,
      fresh,
      opsByAgent,
      latest: latestHermes(agents, meta?.hermes_version ?? null),
      tailnet: meta?.tailnet ?? DEFAULT_TAILNET,
      fleets,
      fleetsError,
      directoryError,
      refreshFleets,
      switchTo,
      refreshMeta,
      resync,
      setOp,
      markFresh,
      clearFresh,
      subscribeNotifications,
    };
  }, [
    byName,
    meta,
    metaError,
    metaLoading,
    connected,
    everConnected,
    scanned,
    scanError,
    retryAt,
    lastPollAt,
    fresh,
    opsByAgent,
    setOp,
    markFresh,
    clearFresh,
    subscribeNotifications,
    fleets,
    fleetsError,
    directoryError,
    refreshFleets,
    switchTo,
    refreshMeta,
    resync,
  ]);

  return <FleetContext.Provider value={value}>{children}</FleetContext.Provider>;
}

export function useFleet(): Fleet {
  const ctx = useContext(FleetContext);
  if (!ctx) throw new Error("useFleet must be used inside <FleetProvider>");
  return ctx;
}

/**
 * The live fleet when this tree has a provider, `null` when it does not.
 *
 * For the parts of a screen that are *additions* to something that already
 * renders without one — the Settings sections' §4.8 fleet lines, which sit
 * inside `SettingsShell` and are also rendered on their own to check the
 * shell's chrome. A missing provider there is not a bug worth throwing over: it
 * means there is no fleet list to draw, and the section drops the line rather
 * than taking the page down with it. Anything that *is* the fleet — the board,
 * the drawers, the switcher — still uses `useFleet` and still throws.
 */
export function useFleetIfAvailable(): Fleet | null {
  return useContext(FleetContext);
}

/* ── derived selectors ───────────────────────────────────────────────────── */

// Moved to selectors.ts (pure, DOM-free) for unit testing; re-exported here
// so existing imports from "./state.tsx" keep working.
export type { Counts, Sort, SortDir, SortKey, TriageGroup } from "../logic/selectors.ts";
export {
  ariaSort,
  countsOf,
  emptyHint,
  filterAgents,
  nextSort,
  shouldDeselect,
  sortAgents,
  sortLabel,
  triageGroups,
  withoutDestroyed,
} from "../logic/selectors.ts";

/* ── theme ───────────────────────────────────────────────────────────────── */

const THEME_KEY = "hermetic.theme";

export function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState<string>(() => {
    try {
      return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
    } catch {
      return "dark";
    }
  });
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    document.body.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* private mode: the choice just does not persist */
    }
  }, [theme]);
  const toggle = useCallback(() => setTheme((t) => (t === "dark" ? "light" : "dark")), []);
  return [theme, toggle];
}

/* ── layout ──────────────────────────────────────────────────────────────── */

const LAYOUT_KEY = "hermetic.layout";
const LAYOUTS: Layout[] = ["board", "table", "triage"];

export function useLayout(): [Layout, (l: Layout) => void] {
  const [layout, setLayoutState] = useState<Layout>(() => {
    try {
      const stored = localStorage.getItem(LAYOUT_KEY);
      return (LAYOUTS as string[]).includes(stored ?? "") ? (stored as Layout) : "board";
    } catch {
      return "board";
    }
  });
  const setLayout = useCallback((l: Layout) => {
    setLayoutState(l);
    try {
      localStorage.setItem(LAYOUT_KEY, l);
    } catch {
      /* private mode: the choice just does not persist */
    }
  }, []);
  return [layout, setLayout];
}

/* ── volumes (§9) ────────────────────────────────────────────────────────── */

/**
 * How often the volume inventory is re-read: once a minute, the same cadence
 * as the fleet's own tick but a separate read — the fleet stream is a DynamoDB
 * scan the main process is already doing, and this is two `DescribeVolumes`
 * plus a `DescribeSnapshots` against EC2. Volumes also change on the timescale of a create or a destroy, not a
 * heartbeat — and both of those call `refresh()` directly, so the interval is
 * the backstop rather than the mechanism.
 */
export const VOLUME_POLL_MS = 60_000;

export interface Volumes {
  volumes: VolumeView[];
  summary: VolumeList["summary"] | null;
  /** Null until the first read lands; an error here never blocks the fleet. */
  error: string | null;
  loading: boolean;
  /**
   * A read has come back at least once this session. Distinguishes an inventory
   * that is genuinely empty from one nobody has read yet — the same distinction
   * the fleet's `scanned` makes, and for the same reason.
   */
  hasRead: boolean;
  /** When the inventory was last read, for the footer's second age. */
  readAt: string | null;
  refresh: () => void;
  /**
   * Forgets the inventory entirely and re-reads it (§4.8). A `refresh()` keeps
   * the last good list on screen while the next read runs, which is right for a
   * poll and wrong for a fleet switch: the volumes on screen belong to the
   * fleet that just stopped being the one this portal is pointed at, and every
   * count drawn from them — the toolbar's loose-volume legend, the board's
   * tombstones — would be a number about somewhere else. This drops them and
   * puts the skeleton back, because nobody has read *this* fleet's volumes yet.
   */
  reset: () => void;
}

export function useVolumes(enabled: boolean): Volumes {
  const [state, setState] = useState<{ list: VolumeList | null; error: string | null }>({
    list: null,
    error: null,
  });
  const [loading, setLoading] = useState(false);
  const [hasRead, setHasRead] = useState(false);
  const [epoch, setEpoch] = useState(0);
  /**
   * An explicit refresh is a request for a *new* read, so it drops the shared
   * fetch cache first: the cache is there to stop a view switch re-reading an
   * answer nobody asked for again, not to answer a reload button with the old one.
   */
  const refresh = useCallback(() => {
    invalidateFetchCache(FETCH_KEYS.volumes);
    setEpoch((n) => n + 1);
  }, []);
  const reset = useCallback(() => {
    invalidateFetchCache(FETCH_KEYS.volumes);
    setState({ list: null, error: null });
    setHasRead(false);
    setEpoch((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const read = async () => {
      setLoading(true);
      try {
        const list = await listVolumes();
        if (live) {
          setState({ list, error: null });
          setHasRead(true);
        }
      } catch (e) {
        // A volume read that fails leaves the last good inventory on screen and
        // says so; it is never allowed to take the fleet down with it.
        if (live) {
          setState((prev) => ({ list: prev.list, error: (e as Error).message }));
          setHasRead(true);
        }
      } finally {
        if (live) setLoading(false);
      }
    };
    void read();
    const timer = setInterval(read, VOLUME_POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [enabled, epoch]);

  return useMemo(
    () => ({
      volumes: state.list?.volumes ?? [],
      summary: state.list?.summary ?? null,
      error: state.error,
      loading,
      hasRead,
      readAt: state.list?.summary.read_at ?? null,
      refresh,
      reset,
    }),
    [state, loading, hasRead, refresh, reset],
  );
}

/* ── provider profiles (§8.3) ────────────────────────────────────────────── */

export interface ProfilesState {
  /**
   * `null` until the first read comes back. The distinction the fleet's
   * `scanned` makes, for the same reason: "this fleet has no profiles" is a
   * claim, and the create drawer's "Set up a provider" must not be drawn on
   * the strength of a read nobody has done yet.
   */
  list: ProfileView[] | null;
  /** The profile a create with no `--provider-profile` resolves to, if any. */
  defaultProfile: string | null;
  /** The Bedrock model ids this fleet's instance role may invoke. */
  bedrockModelIds: string[];
  error: string | null;
  loading: boolean;
  /** Re-read; called after every profile write and after an agent's apply. */
  refresh: () => void;
}

/**
 * The fleet's provider profiles, read once and shared.
 *
 * Not polled. Profiles change when somebody changes them — from this page, or
 * from a CLI in another terminal — and every writer here calls `refresh()`, so
 * a timer would only add requests. Keyed on the fleet's identity, because a
 * profile belongs to one fleet and showing another fleet's credentials under a
 * switched portal would be showing the wrong account's setup.
 */
export function useProfiles(enabled: boolean, fleetIdentity: string): ProfilesState {
  const [state, setState] = useState<{
    list: ProfileView[] | null;
    defaultProfile: string | null;
    bedrockModelIds: string[];
    error: string | null;
  }>({ list: null, defaultProfile: null, bedrockModelIds: [], error: null });
  const [loading, setLoading] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const refresh = useCallback(() => setEpoch((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setLoading(true);
    listProfiles()
      .then((out) => {
        if (!live) return;
        setState({
          list: out.profiles,
          defaultProfile: out.default_profile,
          bedrockModelIds: out.bedrock_model_ids,
          error: null,
        });
      })
      .catch((e: unknown) => {
        // A profile read that fails must never take the fleet down with it: the
        // dashboard is still a dashboard without it, and the sections that need
        // profiles say so themselves.
        if (live) setState((prev) => ({ ...prev, error: (e as Error).message }));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [enabled, epoch, fleetIdentity]);

  // Forgotten entirely on a fleet switch, rather than left on screen while the
  // next read runs: the profiles on screen belong to the fleet this portal has
  // stopped being pointed at.
  const identity = useRef(fleetIdentity);
  if (identity.current !== fleetIdentity) {
    identity.current = fleetIdentity;
    if (state.list !== null) {
      setState({ list: null, defaultProfile: null, bedrockModelIds: [], error: null });
    }
  }

  return useMemo(
    () => ({
      list: state.list,
      defaultProfile: state.defaultProfile,
      bedrockModelIds: state.bedrockModelIds,
      error: state.error,
      loading,
      refresh,
    }),
    [state, loading, refresh],
  );
}
