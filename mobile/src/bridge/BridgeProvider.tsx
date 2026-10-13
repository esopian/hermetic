/**
 * The React side of the client layer: owns the paired `HermeticClient`, the
 * SecureStore-backed credentials, AppState (foreground ↔ background), the
 * alert plumbing and push registration. Screens read it through the hooks in
 * `hooks.ts` and never construct a client themselves.
 */
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
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
import { AppState, type AppStateStatus, Platform } from "react-native";
import {
  type Alert,
  type Credentials,
  createHermeticClient,
  type HermeticClient,
  pairDevice,
} from "../client/client.ts";
import type { SocketState, WebSocketLike } from "../client/socket.ts";
import type { MobilePlatform } from "../protocol/types.ts";
import { registerBackgroundRefresh, unregisterBackgroundRefresh } from "./background.ts";
import {
  handleAction,
  installForegroundHandler,
  type PushRegistration,
  presentLocal,
  pushDataOf,
  registerCategories,
  registerForPush,
  routeFor,
  setBadge,
} from "./notifications.ts";
import {
  clearCredentials,
  loadCredentials,
  type PrefStorage,
  rosterPrefsStorage,
  saveCredentials,
  secureStorage,
} from "./storage.ts";

/** How long the socket stays open after the app is backgrounded (iOS allows ~30 s). */
export const BACKGROUND_LINGER_MS = 25_000;

export type BridgeStatus = "loading" | "unpaired" | "paired";

export interface BridgeContextValue {
  status: BridgeStatus;
  credentials: Credentials | null;
  client: HermeticClient | null;
  socketState: SocketState;
  /** The in-app banner currently showing (foreground alerts). */
  banner: Alert | null;
  dismissBanner(): void;
  pair(input: { baseUrl: string; code: string; deviceName?: string }): Promise<void>;
  signOut(): Promise<void>;
  previews: boolean;
  setPreviews(previews: boolean): Promise<void>;
  push: PushRegistration | null;
  enablePush(): Promise<PushRegistration | null>;
}

const BridgeContext = createContext<BridgeContextValue | null>(null);

const PREVIEWS_KEY = "hermetic.previews";

const createSocket = (url: string): WebSocketLike => new WebSocket(url) as unknown as WebSocketLike;

const platform = (): MobilePlatform =>
  Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "other";

export function BridgeProvider({
  children,
  storage = secureStorage,
}: {
  children: ReactNode;
  storage?: PrefStorage;
}) {
  const [status, setStatus] = useState<BridgeStatus>("loading");
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const [client, setClient] = useState<HermeticClient | null>(null);
  const [socketState, setSocketState] = useState<SocketState>("idle");
  const [banner, setBanner] = useState<Alert | null>(null);
  const [previews, setPreviewsState] = useState(true);
  const [push, setPush] = useState<PushRegistration | null>(null);
  const clientRef = useRef<HermeticClient | null>(null);
  const previewsRef = useRef(true);
  const linger = useRef<ReturnType<typeof setTimeout> | null>(null);

  const start = useCallback(
    (creds: Credentials) => {
      clientRef.current?.dispose();
      const next = createHermeticClient({
        credentials: creds,
        createSocket,
        rosterPrefs: rosterPrefsStorage(storage),
        previews: () => previewsRef.current,
        onAlert: (alert) => {
          if (alert.decision === "local") void presentLocal(alert);
          else setBanner(alert);
        },
      });
      clientRef.current = next;
      setClient(next);
      setCredentials(creds);
      setStatus("paired");
      next.setPhase(AppState.currentState === "active" ? "active" : "background");
      next.connect();
      void next.roster.refresh();
      void registerBackgroundRefresh();
      return next;
    },
    [storage],
  );

  // Boot: categories, the foreground handler, and any stored pairing.
  useEffect(() => {
    void registerCategories();
    installForegroundHandler(() => clientRef.current?.inbox.dedupe ?? null);
    let live = true;
    void (async () => {
      const stored = await loadCredentials(storage);
      const pref = await storage.get(PREVIEWS_KEY).catch(() => null);
      if (!live) return;
      if (pref === "false") {
        previewsRef.current = false;
        setPreviewsState(false);
      }
      if (stored) start(stored);
      else setStatus("unpaired");
    })();
    return () => {
      live = false;
      clientRef.current?.dispose();
      clientRef.current = null;
    };
  }, [start, storage]);

  // Socket state, badge sync, and a revoked device signing itself out.
  useEffect(() => {
    if (!client) return;
    setSocketState(client.socket.state);
    const offState = client.socket.on("state", setSocketState);
    const offBadge = client.inbox.subscribe(() => void setBadge(client.inbox.badgeCount()));
    return () => {
      offState();
      offBadge();
    };
  }, [client]);

  // Foreground ↔ background.
  useEffect(() => {
    const onChange = (next: AppStateStatus) => {
      const c = clientRef.current;
      if (!c) return;
      c.setPhase(next === "active" ? "active" : next === "background" ? "background" : "inactive");
      if (next === "active") {
        if (linger.current) clearTimeout(linger.current);
        linger.current = null;
        c.connect();
        void c.roster.refresh();
        void c.inbox.refresh();
      } else if (next === "background" && !linger.current) {
        linger.current = setTimeout(() => {
          linger.current = null;
          clientRef.current?.disconnect();
        }, BACKGROUND_LINGER_MS);
      }
    };
    const sub = AppState.addEventListener("change", onChange);
    return () => {
      sub.remove();
      if (linger.current) clearTimeout(linger.current);
    };
  }, []);

  // A tapped notification (or an action button on one).
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      void (async () => {
        const handled = await handleAction(response, clientRef.current).catch(() => false);
        if (handled) return;
        const data = pushDataOf(response.notification.request.content);
        if (data) router.push(routeFor(data) as never);
      })();
    });
    return () => sub.remove();
  }, []);

  const pair = useCallback(
    async (input: { baseUrl: string; code: string; deviceName?: string }) => {
      const { credentials: creds } = await pairDevice({
        baseUrl: input.baseUrl,
        code: input.code,
        device_name: input.deviceName ?? "iPhone",
        platform: platform(),
      });
      await saveCredentials(creds, storage);
      start(creds);
    },
    [start, storage],
  );

  const signOut = useCallback(async () => {
    clientRef.current?.dispose();
    clientRef.current = null;
    setClient(null);
    setCredentials(null);
    setPush(null);
    await clearCredentials(storage);
    await unregisterBackgroundRefresh();
    await setBadge(0);
    setStatus("unpaired");
  }, [storage]);

  const setPreviews = useCallback(
    async (value: boolean) => {
      previewsRef.current = value;
      setPreviewsState(value);
      await storage.set(PREVIEWS_KEY, String(value)).catch(() => {});
      await clientRef.current?.http.pushSettings({ previews: value }).catch(() => null);
    },
    [storage],
  );

  const enablePush = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return null;
    const result = await registerForPush(c, previewsRef.current);
    setPush(result);
    return result;
  }, []);

  const value = useMemo<BridgeContextValue>(
    () => ({
      status,
      credentials,
      client,
      socketState,
      banner,
      dismissBanner: () => setBanner(null),
      pair,
      signOut,
      previews,
      setPreviews,
      push,
      enablePush,
    }),
    [
      status,
      credentials,
      client,
      socketState,
      banner,
      pair,
      signOut,
      previews,
      setPreviews,
      push,
      enablePush,
    ],
  );

  return <BridgeContext.Provider value={value}>{children}</BridgeContext.Provider>;
}

export function useBridge(): BridgeContextValue {
  const value = useContext(BridgeContext);
  if (!value) throw new Error("useBridge outside BridgeProvider");
  return value;
}
