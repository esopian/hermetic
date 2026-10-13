/**
 * Background refresh: while the app is suspended, iOS wakes it now and then
 * (BGTaskScheduler via expo-background-task, at most every 15 minutes). Each
 * wake reads the inbox counts over HTTP and updates the app badge, so the icon
 * is right even when no push could be sent (no EAS project id).
 *
 * The task must be defined at module load, before the app renders — the root
 * layout imports this file for that side effect.
 */
import * as BackgroundTask from "expo-background-task";
import * as TaskManager from "expo-task-manager";
import { createBridgeHttp } from "../client/http.ts";
import { targetOf } from "../client/client.ts";
import type { NotificationsListResult } from "../protocol/types.ts";
import { setBadge } from "./notifications.ts";
import { loadCredentials } from "./storage.ts";

export const BACKGROUND_REFRESH_TASK = "hermetic.background-refresh";

/** Read the counts and set the badge. Exported for the e2e-free unit path. */
export async function refreshBadge(): Promise<boolean> {
  const credentials = await loadCredentials();
  if (!credentials) return false;
  const http = createBridgeHttp({
    baseUrl: credentials.baseUrl,
    token: () => credentials.token,
    target: () => targetOf(credentials.fleet),
    timeoutMs: 10_000,
  });
  const inbox = await http.rpc<NotificationsListResult>("notifications.list", {
    view: "inbox",
    limit: 1,
  });
  await setBadge(inbox.unread);
  return true;
}

if (!TaskManager.isTaskDefined(BACKGROUND_REFRESH_TASK)) {
  TaskManager.defineTask(BACKGROUND_REFRESH_TASK, async () => {
    try {
      await refreshBadge();
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
