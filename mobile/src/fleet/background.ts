/**
 * Background refresh: while the app is suspended, iOS wakes it now and then
 * (BGTaskScheduler through expo-background-task, at most every 15 minutes).
 * Each wake refreshes the fleet view from a listened box (`GET /fleet`, which
 * also renews the cached snapshot), re-probes Tailscale, and sets the app
 * badge from the phone's own inbox. Nothing here talks to a laptop.
 *
 * The task must be defined at module load, before the app renders: the root
 * layout imports this file for that side effect. Fixture builds never
 * register it (`FleetProvider`), so it only ever reads the real pairing.
 */
import * as BackgroundTask from "expo-background-task";
import * as Notifications from "expo-notifications";
import * as TaskManager from "expo-task-manager";
import type { FetchLike } from "../gateway/hermeticd.ts";
import { probeTailscale, type TailscaleProbe } from "../gateway/tailscale.ts";
import { InboxStore } from "../inbox/store.ts";
import { documentFile, FLEET_VIEW_FILE, INBOX_FILE, secureKv } from "./persist.ts";
import { FleetStore, type KvStorage, type TextFile } from "./store.ts";

export const BACKGROUND_REFRESH_TASK = "hermetic.background-refresh";

export interface BackgroundDeps {
  secure: KvStorage;
  viewCache: TextFile;
  inboxFile: TextFile;
  fetch: FetchLike;
  setBadge(count: number): Promise<void>;
  now?: () => string;
}

export interface BackgroundOutcome {
  paired: boolean;
  refreshed: boolean;
  tailscale: TailscaleProbe | null;
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
    return { paired: false, refreshed: false, tailscale: null, badge };
  }
  const refreshed = await fleet.refresh();
  const hosts = fleet
    .listened()
    .map((name) => fleet.hostOf(name))
    .filter((h): h is string => h !== null);
  const tailscale = await probeTailscale({ hosts, fetch: deps.fetch }).catch(() => null);
  await deps.setBadge(badge);
  return { paired: true, refreshed, tailscale, badge };
}

if (!TaskManager.isTaskDefined(BACKGROUND_REFRESH_TASK)) {
  TaskManager.defineTask(BACKGROUND_REFRESH_TASK, async () => {
    try {
      await backgroundRefresh({
        secure: secureKv,
        viewCache: documentFile(FLEET_VIEW_FILE),
        inboxFile: documentFile(INBOX_FILE),
        fetch: (input, init) => fetch(input, init),
        setBadge: async (count) => {
          await Notifications.setBadgeCountAsync(Math.max(0, count)).catch(() => false);
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
