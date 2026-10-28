/**
 * The React side of the paired fleet: owns the `FleetStore`, the phone-local
 * inbox and the `HermeticClient` built over them, AppState (foreground ↔
 * background), the alert plumbing, push registration and the Tailscale
 * status. Screens read it through `useFleetContext` and the hooks in
 * `hooks.ts`, and never construct a client themselves.
 *
 * Every effect comes in through `deps` (`appFleetDeps` in `deps.ts` builds the
 * app's, real or fixture), so the provider's tests run on doubles.
 */
import type { HermesChatClient } from "@hermetic/core/chat-client";
import type { MobilePushPlatform } from "@hermetic/core/schema";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type Alert, createHermeticClient, type HermeticClient } from "../client/client.ts";
import { CONNECT_GRACE_MS, CONNECT_RETRY_MS, type ConnectionAttempt } from "../client/connection.ts";
import type { ConversationTarget } from "../client/conversation-store.ts";
import type { PhoneFilesFactory } from "../gateway/files.ts";
import type { FetchLike } from "../gateway/hermeticd.ts";
import type { OpenSocket } from "../gateway/socket.ts";
import type { TailscaleProbe } from "../gateway/tailscale.ts";
import { entryLive, InboxStore } from "../inbox/store.ts";
import { usePrefs } from "../prefs/prefs.tsx";
import {
  belongingData,
  foregroundDecision,
  ingestPush,
  type Notifier,
  type PushFleet,
  presentsLocally,
  routeFor,
} from "./alerts.ts";
import type { FixtureControls, FixtureTailscaleMode } from "./fixture-types.ts";
import type { FleetEntry } from "./fleets.ts";
import type { PairedLink } from "./pairing.ts";
import {
  allBoxes,
  deviceId,
  listenedBoxes,
  PREVIEWS_KEY,
  PUSH_KEY,
  PUSH_RENEWED_KEY,
  type PushRegistrar,
  type PushStatus,
  PushSync,
  previewsFrom,
} from "./push.ts";
import {
  FleetStore,
  type KvStorage,
  listenedEntry,
  rosterCacheStorage,
  rosterPrefsStorage,
  type TextFile,
} from "./store.ts";

/** How long sockets keep being treated as live after the app is backgrounded (iOS allows ~30 s). */
export const BACKGROUND_LINGER_MS = 25_000;

export type FleetStatus = "loading" | "unpaired" | "paired";

/** The slice of React Native's `AppState` the provider uses. */
export interface AppStateLike {
  current(): string;
  subscribe(listener: (state: string) => void): () => void;
}

export type {
  DemoPrompt,
  FixtureControls,
  FixtureDriveActions,
  FixtureDriveParams,
  SchemePreferenceName,
} from "./fixture-types.ts";

export interface FleetDeps {
  /** The keychain (pairing, device id, the phone's own switches). */
  secure: KvStorage;
  /** This fleet's record key (`FleetStoreDeps.recordKey`). */
  recordKey?: string | null;
  viewCache: TextFile;
  inboxFile: TextFile;
  /** The last roster read (`rosterCacheStorage`); absent, nothing is kept between launches. */
  rosterFile?: TextFile;
  fetch: FetchLike;
  openSocket: OpenSocket;
  /** The adapter to use instead of a live one (fixture mode). */
  chat?: HermesChatClient;
  /**
   * The files client for one box (`gateway/files.ts`): stage an attachment and
   * commit it into a turn. The live one over `fetch`, or the fixture kit's.
   */
  files?: PhoneFilesFactory;
  notifier: Notifier;
  registrar: PushRegistrar;
  /** Background refresh registration; `null` where there is none (fixture mode, tests). */
  background: { register(): Promise<void>; unregister(): Promise<void> } | null;
  appState: AppStateLike;
  platform: MobilePushPlatform;
  appVersion: string;
  /** A tailnet besides `*.ts.net` this build trusts. */
  operatorTailnet: string | null;
  fixture: FixtureControls | null;
  now?: () => string;
  lingerMs?: number;
}

export interface FleetContextValue {
  status: FleetStatus;
  client: HermeticClient | null;
  /** The files client for one box (`deps.files`), or `null` in a build without one. */
  files: PhoneFilesFactory | null;
  /** The paired fleet's store (present before pairing too: `getState().link` is `null`). */
  fleet: FleetStore;
  /** The last Tailscale probe, or `null` before the first. */
  tailscale: TailscaleProbe | null;
  probing: boolean;
  probeTailscale(): Promise<void>;
  /**
   * The current connection attempt (a launch, a return to the foreground, a
   * refresh or a retry): home's header measures its grace window from it
   * (`src/client/connection.ts`). `null` before the first.
   */
  connection: ConnectionAttempt | null;
  /** Start a new attempt: probe, read the bots, and keep asking through the grace window. */
  retryConnection(): void;
  /** The in-app banner currently showing (foreground alerts). */
  banner: Alert | null;
  dismissBanner(): void;
  /**
   * Keep a confirmed pairing and connect. Another fleet's link is added beside
   * this one and brought to the front (`"switched"`: the app remounts at its
   * entry route); this fleet's again refreshes it in place (`"kept"`).
   */
  pair(link: PairedLink): Promise<"kept" | "switched">;
  /** Every paired fleet, in pairing order. */
  fleets: readonly FleetEntry[];
  /** Bring another paired fleet to the front (the app remounts at its entry route). */
  switchFleet(fleetId: string): Promise<void>;
  /**
   * The primary instance (`FleetState.primary`): the one home is built around.
   * `null` before the operator picks one, and while unpaired.
   */
  primary: string | null;
  /** Paired with no primary picked yet: show the picker before home. */
  needsPrimary: boolean;
  /** Pick the primary instance, listen to it, and read home's bots again. */
  setPrimary(name: string): Promise<void>;
  /**
   * Unregister push on the listened boxes (best effort), then forget this
   * fleet; the next paired one, if any, comes to the front.
   */
  signOut(): Promise<void>;
  /** Fleet view, Tailscale and home's bots, again. */
  refresh(): Promise<void>;
  push: PushStatus;
  /** The operator wants push (persisted); `push` says whether it took. */
  pushWanted: boolean;
  setPushEnabled(on: boolean): Promise<PushStatus>;
  previews: boolean;
  setPreviews(on: boolean): Promise<void>;
  operatorTailnet: string | null;
  /**
   * The conversation on screen (the chat screen sets it while focused, and
   * clears it on blur): what the provider re-opens when the app comes back from
   * the background.
   */
  focusConversation(target: ConversationTarget | null): void;
  /** Fixture builds only; `null` in every real build. */
  fixture: (FixtureControls & { setTailscale(s: FixtureTailscaleMode): void }) | null;
}

/** The other paired fleets (`FleetSwitch.tsx`): this provider is the active one's. */
export interface FleetSwitcher {
  fleets: readonly FleetEntry[];
  /** Keep `link`'s fleet beside the others and bring it to the front. */
  add(link: PairedLink): Promise<void>;
  switchTo(fleetId: string): Promise<void>;
  /** Forget a fleet in the list; the next one comes to the front. */
  remove(fleetId: string): Promise<void>;
  /** The fleet in front's entry, from a fresh link (same fleet, so nothing remounts). */
  refresh(link: PairedLink): Promise<void>;
}

export const FleetContext = createContext<FleetContextValue | null>(null);

export { PREVIEWS_KEY, PUSH_KEY };

export function FleetProvider({
  deps,
  switcher = null,
  onOpen,
  children,
}: {
  deps: FleetDeps;
  switcher?: FleetSwitcher | null;
  /** Navigate to an app path (a tapped notification). */
  onOpen?: (href: string) => void;
  children: ReactNode;
}) {
  const now = deps.now ?? (() => new Date().toISOString());
  const nowRef = useRef(now);
  nowRef.current = now;
  const [status, setStatus] = useState<FleetStatus>("loading");
  const [client, setClient] = useState<HermeticClient | null>(null);
  const [banner, setBanner] = useState<Alert | null>(null);
  const [tailscale, setTailscale] = useState<TailscaleProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const [push, setPush] = useState<PushStatus>({ state: "off" });
  const [pushWanted, setPushWanted] = useState(false);
  const [previews, setPreviewsState] = useState(false);
  const { mayAlert } = usePrefs();
  const mayAlertRef = useRef(mayAlert);
  mayAlertRef.current = mayAlert;
  const previewsRef = useRef(false);
  const pushWantedRef = useRef(false);
  const clientRef = useRef<HermeticClient | null>(null);
  const linger = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The linger ran out and the client went to `background` (its sockets detached). */
  const detached = useRef(false);
  const focused = useRef<ConversationTarget | null>(null);
  const pendingRoute = useRef<string | null>(null);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const switcherRef = useRef(switcher);
  switcherRef.current = switcher;

  const { fleet, inbox, pushSync, pushFleet } = useMemo(() => {
    const fleet = new FleetStore({
      secure: deps.secure,
      ...(deps.recordKey !== undefined ? { recordKey: deps.recordKey } : {}),
      viewCache: deps.viewCache,
      fetch: deps.fetch,
      now: () => nowRef.current(),
      operatorTailnet: deps.operatorTailnet,
    });
    const inbox = new InboxStore(deps.inboxFile, () => nowRef.current());
    const pushSync = new PushSync({
      fleet,
      registrar: deps.registrar,
      deviceId: () => deviceId(deps.secure),
      token: () => deps.notifier.pushToken(),
      platform: deps.platform,
      appVersion: deps.appVersion,
      previews: () => previewsRef.current,
      onRenewed: () => deps.secure.set(PUSH_RENEWED_KEY, nowRef.current()).catch(() => {}),
    });
    /** What a box's push is checked against: the paired fleet and the agents it names. */
    const pushFleet = (): PushFleet | null => {
      const link = fleet.getState().link;
      return link
        ? { fleet_id: link.payload.fleet_id, agents: fleet.agents().map((a) => a.name) }
        : null;
    };
    return { fleet, inbox, pushSync, pushFleet };
  }, [deps]);

  const probe = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    setProbing(true);
    try {
      const result = await c.tailscale.probe();
      if (clientRef.current === c) setTailscale(result);
    } finally {
      setProbing(false);
    }
  }, []);

  /**
   * A new connection attempt. Inside its grace window the phone asks again
   * every `CONNECT_RETRY_MS` (Tailscale, then the bots) until every listened
   * box has answered a read made during it, so a tunnel that wakes late is
   * noticed seconds after it does, not at the next foreground.
   */
  const [connection, setConnection] = useState<ConnectionAttempt | null>(null);
  const attemptRef = useRef<ConnectionAttempt | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopRetrying = useCallback(() => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = null;
  }, []);
  const beginAttempt = useCallback(() => {
    stopRetrying();
    const attempt: ConnectionAttempt = { startedAt: Date.now() };
    attemptRef.current = attempt;
    setConnection(attempt);
    const tick = () => {
      retryTimer.current = null;
      const c = clientRef.current;
      if (!c || attemptRef.current !== attempt) return;
      if (Date.now() - attempt.startedAt >= CONNECT_GRACE_MS) return;
      const roster = c.roster.getState();
      const answered =
        roster.readAt !== null &&
        roster.readAt >= attempt.startedAt &&
        roster.listening.length > 0 &&
        roster.swarms.filter((s) => roster.listening.includes(s.instance)).every((s) => s.reachable);
      if (answered) return;
      void probe().then(() => c.roster.refresh());
      retryTimer.current = setTimeout(tick, CONNECT_RETRY_MS);
    };
    retryTimer.current = setTimeout(tick, CONNECT_RETRY_MS);
  }, [probe, stopRetrying]);
  useEffect(() => stopRetrying, [stopRetrying]);

  /** Tailscale first (its HTTPS answers open the off-tunnel gate for those hosts), then `/fleet`. */
  const probeThenRefresh = useCallback(async (): Promise<boolean> => {
    await probe();
    return fleet.refresh();
  }, [fleet, probe]);

  const open = useCallback((href: string) => {
    const go = onOpenRef.current;
    if (!go || !clientRef.current) {
      pendingRoute.current = href;
      return;
    }
    pendingRoute.current = null;
    go(href);
  }, []);

  const start = useCallback(() => {
    clientRef.current?.dispose();
    const next = createHermeticClient({
      fleet,
      inbox,
      fetch: deps.fetch,
      openSocket: deps.openSocket,
      ...(deps.chat ? { chat: deps.chat } : {}),
      now: () => nowRef.current(),
      rosterPrefs: rosterPrefsStorage(deps.secure),
      ...(deps.rosterFile ? { rosterCache: rosterCacheStorage(deps.rosterFile) } : {}),
      previews: () => previewsRef.current,
      onAlert: (alert) => {
        // Local delivery off, or inside quiet hours: the inbox still has the entry.
        if (!mayAlertRef.current()) return;
        // Away from the app, a box holding this phone's registration pushes the
        // same event itself: one notification, not two.
        if (!presentsLocally(alert, (instance) => pushSync.covers(instance))) return;
        if (alert.decision === "local") void deps.notifier.presentLocal(alert);
        else setBanner(alert);
      },
    });
    clientRef.current = next;
    setClient(next);
    setStatus("paired");
    next.setPhase(deps.appState.current() === "active" ? "active" : "background");
    beginAttempt();
    void next.roster.refresh();
    void probeThenRefresh();
    void deps.background?.register();
    if (pushWantedRef.current) void pushSync.enable().then(setPush);
    const route = pendingRoute.current;
    if (route && onOpenRef.current) {
      pendingRoute.current = null;
      onOpenRef.current(route);
    }
    return next;
  }, [deps, fleet, inbox, pushSync, probeThenRefresh, beginAttempt]);

  // Boot: the notification handlers, the inbox, any stored pairing.
  useEffect(() => {
    let live = true;
    void deps.notifier.registerCategories();
    deps.notifier.setForegroundHandler((content, local) =>
      foregroundDecision(inbox, content, local, nowRef.current(), pushFleet()),
    );
    const offTap = deps.notifier.onTap((content) => {
      ingestPush(inbox, content, nowRef.current(), pushFleet());
      // A push for another fleet (or an agent this pairing does not name) opens home.
      open(routeFor(belongingData(content, pushFleet())));
    });
    let offRetry: (() => void) | null = null;
    const boot = async () => {
      const [pref, pushPref] = await Promise.all([
        deps.secure.get(PREVIEWS_KEY).catch(() => null),
        deps.secure.get(PUSH_KEY).catch(() => null),
      ]);
      await inbox.load();
      let paired: boolean;
      try {
        paired = await fleet.load();
      } catch {
        // The keychain is shut (a background launch on a locked phone): stay
        // "loading" and read again once the app is in front, never "unpaired".
        if (live && !offRetry)
          offRetry = deps.appState.subscribe((state) => {
            if (state !== "active") return;
            offRetry?.();
            offRetry = null;
            void boot();
          });
        return;
      }
      // Filed after the pairing loads: a push is checked against it.
      for (const content of await deps.notifier.presented().catch(() => []))
        ingestPush(inbox, content, nowRef.current(), pushFleet());
      if (!live) return;
      previewsRef.current = previewsFrom(pref);
      setPreviewsState(previewsFrom(pref));
      pushWantedRef.current = pushPref === "on";
      setPushWanted(pushPref === "on");
      if (paired) start();
      else setStatus("unpaired");
    };
    void boot();
    return () => {
      live = false;
      offRetry?.();
      offTap();
      clientRef.current?.dispose();
      clientRef.current = null;
    };
  }, [deps, fleet, inbox, pushFleet, start, open]);

  // The app badge follows the inbox, counting only the instances listened to:
  // an unlistened one's entries stay unread (listening again brings them back)
  // but do not hold the badge up.
  // Not before the boot has loaded both: an inbox read before the pairing
  // would count against no listened instance and zero the badge on launch.
  useEffect(() => {
    if (status === "loading") return;
    let last = -1;
    const sync = () => {
      const count = inbox.badgeCount(listenedEntry(fleet));
      if (count === last) return;
      last = count;
      void deps.notifier.setBadge(count);
    };
    sync();
    const offInbox = inbox.subscribe(sync);
    const offFleet = fleet.subscribe(sync);
    return () => {
      offInbox();
      offFleet();
    };
  }, [deps, fleet, inbox, status]);

  // Entries about a bot its box no longer lists are marked read once per
  // roster read (not on every roster change), so they cannot pin the badge.
  useEffect(() => {
    if (!client) return;
    let pruned: number | null = null;
    const prune = () => {
      const roster = client.roster.getState();
      if (roster.readAt === null || roster.readAt === pruned) return;
      pruned = roster.readAt;
      inbox.markReadUnless(entryLive(roster, roster.readAt));
    };
    prune();
    return client.roster.subscribe(prune);
  }, [client, inbox]);

  // A listening change re-registers push: new boxes get the token, dropped ones forget it.
  useEffect(() => {
    let key = fleet.listened().join("\n");
    return fleet.subscribe(() => {
      const next = fleet.listened().join("\n");
      if (next === key) return;
      key = next;
      if (pushSync.enabled()) void pushSync.sync().then(setPush);
    });
  }, [fleet, pushSync]);

  // A roster read that failed: say whether Tailscale is the reason.
  useEffect(() => {
    if (!client) return;
    let error: string | null = client.roster.getState().error;
    return client.roster.subscribe(() => {
      const next = client.roster.getState().error;
      if (next && next !== error) void probe();
      error = next;
    });
  }, [client, probe]);

  // Foreground ↔ background.
  useEffect(() => {
    const lingerMs = deps.lingerMs ?? BACKGROUND_LINGER_MS;
    const clear = () => {
      if (linger.current) clearTimeout(linger.current);
      linger.current = null;
    };
    const off = deps.appState.subscribe((next) => {
      const c = clientRef.current;
      if (!c) return;
      if (next === "active") {
        clear();
        const wasAway = detached.current;
        detached.current = false;
        // Marks the focused thread read, and re-attaches what the background phase detached.
        c.setPhase("active");
        // The conversation on screen lost its observation with the sockets: start
        // it afresh, whatever state the last one ended in.
        const target = focused.current;
        if (wasAway && target) c.chat.reopen(target);
        void (async () => {
          for (const content of await deps.notifier.presented().catch(() => []))
            ingestPush(inbox, content, nowRef.current(), pushFleet());
        })();
        beginAttempt();
        void probeThenRefresh();
        void c.roster.refresh();
        if (pushSync.enabled()) void pushSync.sync().then(setPush);
      } else if (next === "background") {
        // Alerts go to the OS from here on; the sockets linger, then the phase detaches them.
        c.setPhase("inactive");
        if (!linger.current)
          linger.current = setTimeout(() => {
            linger.current = null;
            detached.current = true;
            clientRef.current?.setPhase("background");
          }, lingerMs);
      } else c.setPhase("inactive");
    });
    return () => {
      off();
      clear();
    };
  }, [deps, inbox, pushSync, pushFleet, probeThenRefresh, beginAttempt]);

  /**
   * shortcut: push and the badge follow the active fleet only (the fleet left
   * behind unregisters, best effort and unawaited); upgrade when notifications
   * from every paired fleet are wanted.
   */
  const leave = useCallback(() => {
    if (fleet.getState().link) void pushSync.disable(allBoxes(fleet)).catch(() => {});
  }, [fleet, pushSync]);

  const pair = useCallback(
    async (link: PairedLink): Promise<"kept" | "switched"> => {
      const current = fleet.getState().link?.payload.fleet_id ?? null;
      const sw = switcherRef.current;
      if (sw && current !== link.payload.fleet_id) {
        leave();
        await sw.add(link);
        return "switched";
      }
      if (current && current !== link.payload.fleet_id) {
        // No list to keep it in: the other fleet replaces this one, inbox and all.
        setPush(await pushSync.disable(allBoxes(fleet)));
        await inbox.clear();
      }
      await fleet.pair(link);
      await sw?.refresh(link);
      setTailscale(null);
      start();
      return "kept";
    },
    [fleet, inbox, pushSync, start, leave],
  );

  const switchFleet = useCallback(
    async (fleetId: string) => {
      const sw = switcherRef.current;
      if (!sw || fleet.getState().link?.payload.fleet_id === fleetId) return;
      leave();
      await sw.switchTo(fleetId);
    },
    [fleet, leave],
  );

  const signOut = useCallback(async () => {
    setPush(await pushSync.disable(listenedBoxes(fleet)));
    clientRef.current?.dispose();
    clientRef.current = null;
    setClient(null);
    setBanner(null);
    setTailscale(null);
    stopRetrying();
    attemptRef.current = null;
    setConnection(null);
    const leaving = fleet.getState().link?.payload.fleet_id ?? null;
    await fleet.signOut();
    await inbox.clear();
    await deps.rosterFile?.remove().catch(() => {});
    await deps.background?.unregister();
    await deps.notifier.setBadge(0);
    // The next paired fleet, if any, remounts the app in front.
    if (leaving) await switcherRef.current?.remove(leaving);
    setStatus("unpaired");
  }, [deps, fleet, inbox, pushSync, stopRetrying]);

  const [primary, setPrimaryState] = useState<string | null>(() => fleet.getState().primary);
  const [needsPrimary, setNeedsPrimary] = useState(() => fleet.needsPrimary());
  useEffect(() => {
    const sync = () => {
      setPrimaryState(fleet.getState().primary);
      setNeedsPrimary(fleet.needsPrimary());
    };
    sync();
    return fleet.subscribe(sync);
  }, [fleet]);

  // The first box listened: home's bots, and a Tailscale probe that now has a host to ask.
  const setPrimary = useCallback(
    async (name: string) => {
      await fleet.setPrimary(name);
      const c = clientRef.current;
      if (c) await Promise.all([probe(), c.roster.refresh()]);
    },
    [fleet, probe],
  );

  const refresh = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    beginAttempt();
    await Promise.all([probeThenRefresh(), c.roster.refresh()]);
  }, [probeThenRefresh, beginAttempt]);

  const retryConnection = useCallback(() => {
    const c = clientRef.current;
    if (!c) return;
    beginAttempt();
    void probe().then(() => c.roster.refresh());
  }, [probe, beginAttempt]);

  const setPushEnabled = useCallback(
    async (on: boolean) => {
      pushWantedRef.current = on;
      setPushWanted(on);
      await deps.secure.set(PUSH_KEY, on ? "on" : "off").catch(() => {});
      const next = on
        ? clientRef.current
          ? await pushSync.enable()
          : pushSync.getStatus()
        : await pushSync.disable(listenedBoxes(fleet));
      setPush(next);
      return next;
    },
    [deps, fleet, pushSync],
  );

  const setPreviews = useCallback(
    async (on: boolean) => {
      previewsRef.current = on;
      setPreviewsState(on);
      await deps.secure.set(PREVIEWS_KEY, String(on)).catch(() => {});
      // The boxes hold the choice too: tell every listened one.
      if (pushSync.enabled()) setPush(await pushSync.sync());
    },
    [deps, pushSync],
  );

  // One identity for the provider's life: the banner's dwell timer and drag
  // must not restart each time some other part of the context changes.
  const dismissBanner = useCallback(() => setBanner(null), []);

  const focusConversation = useCallback((target: ConversationTarget | null) => {
    focused.current = target;
  }, []);

  const fixture = useMemo(() => {
    const controls = deps.fixture;
    if (!controls) return null;
    return {
      ...controls,
      // A new attempt, so the home header walks the path the picked mode shows.
      setTailscale: (s: FixtureTailscaleMode) => {
        controls.tailscale.set(s);
        retryConnection();
      },
    };
  }, [deps, retryConnection]);

  const value = useMemo<FleetContextValue>(
    () => ({
      status,
      client,
      files: deps.files ?? null,
      fleet,
      tailscale,
      probing,
      probeTailscale: probe,
      connection,
      retryConnection,
      banner,
      dismissBanner,
      pair,
      fleets: switcher?.fleets ?? [],
      switchFleet,
      primary,
      needsPrimary,
      setPrimary,
      signOut,
      refresh,
      push,
      pushWanted,
      setPushEnabled,
      previews,
      setPreviews,
      operatorTailnet: deps.operatorTailnet,
      focusConversation,
      fixture,
    }),
    [
      status,
      client,
      fleet,
      tailscale,
      probing,
      probe,
      connection,
      retryConnection,
      banner,
      dismissBanner,
      pair,
      switcher,
      switchFleet,
      primary,
      needsPrimary,
      setPrimary,
      signOut,
      refresh,
      push,
      pushWanted,
      setPushEnabled,
      previews,
      setPreviews,
      deps,
      focusConversation,
      fixture,
    ],
  );

  return <FleetContext.Provider value={value}>{children}</FleetContext.Provider>;
}

export function useFleetContext(): FleetContextValue {
  const value = useContext(FleetContext);
  if (!value) throw new Error("useFleetContext outside FleetProvider");
  return value;
}
