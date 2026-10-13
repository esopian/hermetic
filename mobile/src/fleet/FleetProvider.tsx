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
import type { FetchLike } from "../gateway/hermeticd.ts";
import type { OpenSocket } from "../gateway/socket.ts";
import type { TailscaleProbe, TailscaleStatus } from "../gateway/tailscale.ts";
import { InboxStore } from "../inbox/store.ts";
import { usePrefs } from "../prefs/prefs.tsx";
import { foregroundDecision, ingestPush, type Notifier, pushDataOf, routeFor } from "./alerts.ts";
import type { PairedLink } from "./pairing.ts";
import {
  allBoxes,
  deviceId,
  listenedBoxes,
  type PushRegistrar,
  type PushStatus,
  PushSync,
} from "./push.ts";
import { FleetStore, type KvStorage, rosterPrefsStorage, type TextFile } from "./store.ts";

/** How long sockets keep being treated as live after the app is backgrounded (iOS allows ~30 s). */
export const BACKGROUND_LINGER_MS = 25_000;

export type FleetStatus = "loading" | "unpaired" | "paired";

/** The slice of React Native's `AppState` the provider uses. */
export interface AppStateLike {
  current(): string;
  subscribe(listener: (state: string) => void): () => void;
}

/** Fixture builds only: the canned pairing link and the switchable Tailscale status. */
export interface FixtureControls {
  link: string;
  tailscale: {
    get(): Exclude<TailscaleStatus, "unknown">;
    set(s: Exclude<TailscaleStatus, "unknown">): void;
  };
}

export interface FleetDeps {
  /** The keychain (pairing, device id, the phone's own switches). */
  secure: KvStorage;
  viewCache: TextFile;
  inboxFile: TextFile;
  fetch: FetchLike;
  openSocket: OpenSocket;
  /** The adapter to use instead of a live one (fixture mode). */
  chat?: HermesChatClient;
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
  /** The paired fleet's store (present before pairing too: `getState().link` is `null`). */
  fleet: FleetStore;
  /** The last Tailscale probe, or `null` before the first. */
  tailscale: TailscaleProbe | null;
  probing: boolean;
  probeTailscale(): Promise<void>;
  /** The in-app banner currently showing (foreground alerts). */
  banner: Alert | null;
  dismissBanner(): void;
  /** Keep a confirmed pairing (replacing any before it) and connect. */
  pair(link: PairedLink): Promise<void>;
  /** Unregister push on the listened boxes (best effort), then forget the pairing. */
  signOut(): Promise<void>;
  /** Fleet view, Tailscale and the Bots list, again. */
  refresh(): Promise<void>;
  push: PushStatus;
  /** The operator wants push (persisted); `push` says whether it took. */
  pushWanted: boolean;
  setPushEnabled(on: boolean): Promise<PushStatus>;
  previews: boolean;
  setPreviews(on: boolean): Promise<void>;
  operatorTailnet: string | null;
  /** Fixture builds only; `null` in every real build. */
  fixture: (FixtureControls & { setTailscale(s: Exclude<TailscaleStatus, "unknown">): void }) | null;
}

export const FleetContext = createContext<FleetContextValue | null>(null);

export const PREVIEWS_KEY = "hermetic.previews";
export const PUSH_KEY = "hermetic.push";

export function FleetProvider({
  deps,
  onOpen,
  children,
}: {
  deps: FleetDeps;
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
  const [previews, setPreviewsState] = useState(true);
  const { mayAlert } = usePrefs();
  const mayAlertRef = useRef(mayAlert);
  mayAlertRef.current = mayAlert;
  const previewsRef = useRef(true);
  const pushWantedRef = useRef(false);
  const clientRef = useRef<HermeticClient | null>(null);
  const linger = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRoute = useRef<string | null>(null);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  const { fleet, inbox, pushSync } = useMemo(() => {
    const fleet = new FleetStore({
      secure: deps.secure,
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
    });
    return { fleet, inbox, pushSync };
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
      previews: () => previewsRef.current,
      onAlert: (alert) => {
        // Local delivery off, or inside quiet hours: the inbox still has the entry.
        if (!mayAlertRef.current()) return;
        if (alert.decision === "local") void deps.notifier.presentLocal(alert);
        else setBanner(alert);
      },
    });
    clientRef.current = next;
    setClient(next);
    setStatus("paired");
    next.setPhase(deps.appState.current() === "active" ? "active" : "background");
    const before = fleet.listened().join("\n");
    void next.roster.refresh();
    void fleet.refresh().then((ok) => {
      // The first view may narrow the listening default: read the roster again.
      if (ok && clientRef.current === next && fleet.listened().join("\n") !== before)
        void next.roster.refresh();
    });
    void probe();
    void deps.background?.register();
    if (pushWantedRef.current) void pushSync.enable().then(setPush);
    const route = pendingRoute.current;
    if (route && onOpenRef.current) {
      pendingRoute.current = null;
      onOpenRef.current(route);
    }
    return next;
  }, [deps, fleet, inbox, pushSync, probe]);

  // Boot: the notification handlers, the inbox, any stored pairing.
  useEffect(() => {
    let live = true;
    void deps.notifier.registerCategories();
    deps.notifier.setForegroundHandler((content, local) =>
      foregroundDecision(inbox, content, local, nowRef.current()),
    );
    const offTap = deps.notifier.onTap((content) => {
      ingestPush(inbox, content, nowRef.current());
      open(routeFor(pushDataOf(content)));
    });
    void (async () => {
      const [pref, pushPref] = await Promise.all([
        deps.secure.get(PREVIEWS_KEY).catch(() => null),
        deps.secure.get(PUSH_KEY).catch(() => null),
      ]);
      await inbox.load();
      for (const content of await deps.notifier.presented().catch(() => []))
        ingestPush(inbox, content, nowRef.current());
      const paired = await fleet.load();
      if (!live) return;
      previewsRef.current = pref !== "false";
      setPreviewsState(pref !== "false");
      pushWantedRef.current = pushPref === "on";
      setPushWanted(pushPref === "on");
      if (paired) start();
      else setStatus("unpaired");
    })();
    return () => {
      live = false;
      offTap();
      clientRef.current?.dispose();
      clientRef.current = null;
    };
  }, [deps, fleet, inbox, start, open]);

  // The app badge follows the inbox.
  useEffect(() => {
    let last = -1;
    const sync = () => {
      const count = inbox.badgeCount();
      if (count === last) return;
      last = count;
      void deps.notifier.setBadge(count);
    };
    return inbox.subscribe(sync);
  }, [deps, inbox]);

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

  // A Bots read that failed: say whether Tailscale is the reason.
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
        // Marks the focused thread read, too.
        c.setPhase("active");
        void (async () => {
          for (const content of await deps.notifier.presented().catch(() => []))
            ingestPush(inbox, content, nowRef.current());
        })();
        void fleet.refresh();
        void c.roster.refresh();
        void probe();
        if (pushSync.enabled()) void pushSync.sync().then(setPush);
      } else if (next === "background") {
        // Alerts go to the OS from here on; the sockets linger, then the phase says so.
        c.setPhase("inactive");
        if (!linger.current)
          linger.current = setTimeout(() => {
            linger.current = null;
            clientRef.current?.setPhase("background");
          }, lingerMs);
      } else c.setPhase("inactive");
    });
    return () => {
      off();
      clear();
    };
  }, [deps, fleet, inbox, pushSync, probe]);

  const pair = useCallback(
    async (link: PairedLink) => {
      const current = fleet.getState().link?.payload.fleet_id ?? null;
      if (current && current !== link.payload.fleet_id) {
        // Another fleet: its boxes forget this phone, and its inbox goes with it.
        setPush(await pushSync.disable(allBoxes(fleet)));
        await inbox.clear();
      }
      await fleet.pair(link);
      setTailscale(null);
      start();
    },
    [fleet, inbox, pushSync, start],
  );

  const signOut = useCallback(async () => {
    setPush(await pushSync.disable(listenedBoxes(fleet)));
    clientRef.current?.dispose();
    clientRef.current = null;
    setClient(null);
    setBanner(null);
    setTailscale(null);
    await fleet.signOut();
    await inbox.clear();
    await deps.background?.unregister();
    await deps.notifier.setBadge(0);
    setStatus("unpaired");
  }, [deps, fleet, inbox, pushSync]);

  const refresh = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    await Promise.all([fleet.refresh(), c.roster.refresh(), probe()]);
  }, [fleet, probe]);

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
    },
    [deps],
  );

  const fixture = useMemo(() => {
    const controls = deps.fixture;
    if (!controls) return null;
    return {
      ...controls,
      setTailscale: (s: Exclude<TailscaleStatus, "unknown">) => {
        controls.tailscale.set(s);
        void probe();
      },
    };
  }, [deps, probe]);

  const value = useMemo<FleetContextValue>(
    () => ({
      status,
      client,
      fleet,
      tailscale,
      probing,
      probeTailscale: probe,
      banner,
      dismissBanner: () => setBanner(null),
      pair,
      signOut,
      refresh,
      push,
      pushWanted,
      setPushEnabled,
      previews,
      setPreviews,
      operatorTailnet: deps.operatorTailnet,
      fixture,
    }),
    [
      status,
      client,
      fleet,
      tailscale,
      probing,
      probe,
      banner,
      pair,
      signOut,
      refresh,
      push,
      pushWanted,
      setPushEnabled,
      previews,
      setPreviews,
      deps,
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
