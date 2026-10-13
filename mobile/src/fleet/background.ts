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
 * 4. sets the app badge from the phone's own inbox.
 *
 * It reads no conversation (`session.active_list` or otherwise): the boxes'
 * pushes cover what happened while the app was away. Nothing here talks to a
 * laptop.
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
import { documentFile, FLEET_VIEW_FILE, INBOX_FILE, secureKv } from "./persist.ts";
import {
  hermeticdRegistrar,
  type PushRegistrar,
  type PushStatus,
  type PushTokenResult,
  renewIfDue,
} from "./push.ts";
import { FleetStore, type KvStorage, type TextFile } from "./store.ts";

export const BACKGROUND_REFRESH_TASK = "hermetic.background-refresh";

export interface BackgroundDeps {
  secure: KvStorage;
  viewCache: TextFile;
  inboxFile: TextFile;
  fetch: FetchLike;
  setBadge(count: number): Promise<void>;
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
  const fleet = new FleetStore({
    secure: deps.secure,
    viewCache: deps.viewCache,
    fetch: deps.fetch,
    now,
  });
  const inbox = new InboxStore(deps.inboxFile, now);
  await inbox.load();
  const badge = inbox.badgeCount();
  if (!(await fleet.load())) {
    await deps.setBadge(badge);
    return { paired: false, refreshed: false, tailscale: null, push: null, badge };
  }
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
        viewCache: documentFile(FLEET_VIEW_FILE),
        inboxFile: documentFile(INBOX_FILE),
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
