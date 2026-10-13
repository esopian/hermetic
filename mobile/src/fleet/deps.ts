/**
 * The app's `FleetDeps`: the real platform (keychain, document files, the
 * global `fetch` and `WebSocket`, expo-notifications, background refresh,
 * React Native's `AppState`), or — only when the build was made with
 * `EXPO_PUBLIC_HERMETIC_FIXTURE=1` — the fixture kit's doubles in their place.
 *
 * Any other value builds none of the fixture: the chat adapter is the live
 * one, `fetch` is the network's, and the pairing lives under the real keys.
 * And a release build does not even carry it: the fixture module is required
 * only behind the inlined flag, which Metro folds to `false` before it collects
 * dependencies, so neither `src/fixture/` nor core's canned chat client is in
 * the bundle.
 */
import Constants from "expo-constants";
import { AppState, Platform } from "react-native";
import { createSocketOpener, type WebSocketCtor } from "../gateway/socket.ts";
import { registerBackgroundRefresh, unregisterBackgroundRefresh } from "./background.ts";
import type { AppStateLike, FleetDeps } from "./FleetProvider.tsx";
import { expoNotifier } from "./notifications.ts";
import { documentFile, FLEET_VIEW_FILE, INBOX_FILE, secureKv } from "./persist.ts";
import { hermeticdRegistrar } from "./push.ts";
import { prefixedKv } from "./store.ts";

const appState: AppStateLike = {
  current: () => AppState.currentState,
  subscribe: (listener) => {
    const sub = AppState.addEventListener("change", listener);
    return () => sub.remove();
  },
};

type FixtureModule = typeof import("../fixture/index.ts");

/** The fixture module, loaded only in a fixture build (see above). */
const fixtureModule: FixtureModule | null =
  process.env.EXPO_PUBLIC_HERMETIC_FIXTURE === "1"
    ? (require("../fixture/index.ts") as FixtureModule)
    : null;

/**
 * Build the app's deps. `flag` is `process.env.EXPO_PUBLIC_HERMETIC_FIXTURE`
 * (Expo inlines it at build time); anything but `"1"` is the real platform.
 * `load` is a test seam: the fixture module, when the build carries it.
 */
export function appFleetDeps(
  flag: string | undefined = process.env.EXPO_PUBLIC_HERMETIC_FIXTURE,
  load: () => FixtureModule | null = () => fixtureModule,
): FleetDeps {
  const kit = flag === "1" ? (load()?.fixtureKit(flag) ?? null) : null;
  const appVersion = Constants.expoConfig?.version ?? "0.0.0";
  const platform = Platform.OS === "android" ? "android" : "ios";
  const operatorTailnet = process.env.EXPO_PUBLIC_HERMETIC_TAILNET || null;
  const openSocket = createSocketOpener(WebSocket as unknown as WebSocketCtor);
  if (kit) {
    return {
      secure: prefixedKv(secureKv, kit.storagePrefix),
      viewCache: documentFile(`${kit.storagePrefix}${FLEET_VIEW_FILE}`),
      inboxFile: documentFile(`${kit.storagePrefix}${INBOX_FILE}`),
      fetch: kit.fetch,
      openSocket,
      chat: kit.chat,
      // A canned token, so the push switch registers with the memory registry.
      notifier: { ...expoNotifier, pushToken: async () => ({ ok: true, token: kit.pushToken }) },
      registrar: hermeticdRegistrar(kit.fetch),
      background: null,
      appState,
      platform,
      appVersion,
      operatorTailnet,
      fixture: { link: kit.link, tailscale: kit.tailscale },
    };
  }
  const fetchFn = (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init);
  return {
    secure: secureKv,
    viewCache: documentFile(FLEET_VIEW_FILE),
    inboxFile: documentFile(INBOX_FILE),
    fetch: fetchFn,
    openSocket,
    notifier: expoNotifier,
    registrar: hermeticdRegistrar(fetchFn),
    background: { register: registerBackgroundRefresh, unregister: unregisterBackgroundRefresh },
    appState,
    platform,
    appVersion,
    operatorTailnet,
    fixture: null,
  };
}
