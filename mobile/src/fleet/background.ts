/**
 * Background refresh: while the app is suspended, iOS wakes it now and then
 * (BGTaskScheduler through expo-background-task, at most every 15 minutes).
 * Each wake, in order:
 *
 * 1. probes Tailscale (`https://<host>/api/health`), which is also what opens
 *    the off-tunnel gate for those hosts' 7434 calls;
 * 2. refreshes the fleet view from a listened box (`GET /fleet`, behind that
 *    gate, which also renews the cached snapshot);
 * 3. renews the push registration when push is on and the last renewal is
 *    `PUSH_RENEW_AFTER_MS` old (`renewIfDue`; the box keeps it 72 h);
 * 4. sets the app badge from the phone's own inbox, counting only the agents
 *    it listens to (`listenedEntry`).
 *
 * It reads no conversation (`session.active_list` or otherwise): the boxes'
 * pushes cover what happened while the app was away. Nothing here talks to a
 * laptop.
 *
 * Only the active fleet is refreshed (`fleets.ts`); a keychain the locked
 * phone keeps shut leaves everything, the badge included, as it was.
 *
 * The task must be defined at module load, before the app renders: the root
 * layout imports this file for that side effect. Fixture builds never
 * register it (`FleetProvider`), so it only ever reads the real pairing.
 */
import type { MobilePushPlatform } from "@hermetic/core/schema";
import * as BackgroundTask from "expo-background-task";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";
import type { FetchLike } from "../gateway/hermeticd.ts";
import { probeTailscale, type TailscaleProbe } from "../gateway/tailscale.ts";
import { InboxStore } from "../inbox/store.ts";
import { expoNotifier } from "./notifications.ts";
import { loadFleets } from "./fleets.ts";
import { fleetFiles, secureKv } from "./persist.ts";
import {
  hermeticdRegistrar,
  type PushRegistrar,
  type PushStatus,
  type PushTokenResult,
  renewIfDue,
} from "./push.ts";
import { FleetStore, fleetRecordKey, type KvStorage, listenedEntry, type TextFile } from "./store.ts";

export const BACKGROUND_REFRESH_TASK = "hermetic.background-refresh";

export interface BackgroundDeps {
  secure: KvStorage;
  /** One fleet's view cache and inbox (`fleetFiles`); a wake reads the active fleet's. */
  fleetFiles(fleetId: string | null): { viewCache: TextFile; inboxFile: TextFile };
  fetch: FetchLike;
  setBadge(count: number): Promise<void>;
  /** A tailnet besides `*.ts.net` this build trusts, as the foreground reads links. */
  operatorTailnet?: string | null;
  /** Push renewal; absent means the wake does not touch the registration. */
  push?: {
    registrar: PushRegistrar;
    token: () => Promise<PushTokenResult>;
    platform: MobilePushPlatform;
    appVersion: string;
  };
  now?: () => string;
}

export interface BackgroundOutcome {
  paired: boolean;
  refreshed: boolean;
  tailscale: TailscaleProbe | null;
  /** The renewal this wake made, or `null` when none was due (or push is off). */
  push: PushStatus | null;
  badge: number;
}

/** One background wake. Exported for tests: every effect is in `deps`. */
export async function backgroundRefresh(deps: BackgroundDeps): Promise<BackgroundOutcome> {
  const now = deps.now ?? (() => new Date().toISOString());
  // A keychain the locked phone keeps shut reads as unpaired here, and changes nothing.
  const active = await loadFleets(deps.secure, { operatorTailnet: deps.operatorTailnet ?? null }).then(
    (index) => index.active,
    () => undefined,
  );
  if (active === undefined)
    return { paired: false, refreshed: false, tailscale: null, push: null, badge: 0 };
  const files = deps.fleetFiles(active);
  const fleet = new FleetStore({
    secure: deps.secure,
    recordKey: active ? fleetRecordKey(active) : null,
    viewCache: files.viewCache,
    fetch: deps.fetch,
    now,
  });
  const inbox = new InboxStore(files.inboxFile, now);
  await inbox.load();
  const paired = await fleet.load().catch(() => null);
  if (paired === null)
    return { paired: false, refreshed: false, tailscale: null, push: null, badge: 0 };
  if (!paired) {
    const badge = inbox.badgeCount();
    await deps.setBadge(badge);
    return { paired: false, refreshed: false, tailscale: null, push: null, badge };
  }
  const badge = inbox.badgeCount(listenedEntry(fleet));
  // The probe first: a host's 7434 calls wait on its HTTPS answer (the gate).
  const hosts = fleet
    .listened()
    .map((name) => fleet.hostOf(name))
    .filter((h): h is string => h !== null);
  const tailscale = await probeTailscale({ hosts, fetch: deps.fetch }).catch(() => null);
  const refreshed = await fleet.refresh();
  const push = deps.push
    ? await renewIfDue({ fleet, secure: deps.secure, now, ...deps.push }).catch(() => null)
    : null;
  await deps.setBadge(badge);
  return { paired: true, refreshed, tailscale, push, badge };
}

if (!TaskManager.isTaskDefined(BACKGROUND_REFRESH_TASK)) {
  TaskManager.defineTask(BACKGROUND_REFRESH_TASK, async () => {
    try {
      const fetchFn: FetchLike = (input, init) => fetch(input, init);
      await backgroundRefresh({
        secure: secureKv,
        fleetFiles: fleetFiles(),
        operatorTailnet: process.env.EXPO_PUBLIC_HERMETIC_TAILNET || null,
        fetch: fetchFn,
        setBadge: async (count) => {
          await Notifications.setBadgeCountAsync(Math.max(0, count)).catch(() => false);
        },
        push: {
          registrar: hermeticdRegistrar(fetchFn),
          token: () => expoNotifier.pushToken(),
          platform: Platform.OS === "android" ? "android" : "ios",
          appVersion: Constants.expoConfig?.version ?? "0.0.0",
        },
      });
      return BackgroundTask.BackgroundTaskResult.Success;
    } catch {
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
}

export async function registerBackgroundRefresh(): Promise<void> {
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status !== BackgroundTask.BackgroundTaskStatus.Available) return;
    await BackgroundTask.registerTaskAsync(BACKGROUND_REFRESH_TASK, { minimumInterval: 15 });
  } catch {
    // Not available (simulator, Expo Go): the foreground path still works.
  }
}

export async function unregisterBackgroundRefresh(): Promise<void> {
  await BackgroundTask.unregisterTaskAsync(BACKGROUND_REFRESH_TASK).catch(() => {});
}
