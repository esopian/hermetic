/**
 * expo-notifications glue: the `Notifier` the provider uses (`alerts.ts`).
 *
 * One category, `hermetic.needs_action`, with no inline actions: answering an
 * approval or a question needs a turn socket on the session, which a
 * notification action cannot hold open, so a tap opens the conversation
 * instead (§9.4). The decision of *whether* to alert is the client layer's
 * (`alertFor`) and the inbox's (`dedupe`); this file only carries it out.
 */
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { NEEDS_ACTION_CATEGORY } from "../client/client.ts";
import type { NoteContent, Notifier } from "./alerts.ts";
import type { PushTokenResult } from "./push.ts";

/** The categories older builds registered; removed so iOS stops offering their buttons. */
const RETIRED_CATEGORIES = ["hermetic.approval", "hermetic.question"];

/** The EAS project id from app config (`EXPO_PUBLIC_PROJECT_ID` / `EAS_PROJECT_ID`), if any. */
export function easProjectId(): string | null {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? null;
}

const contentOf = (n: Notifications.Notification): NoteContent => ({
  title: n.request.content.title,
  body: n.request.content.body,
  data: n.request.content.data,
  date: n.date,
});

export const expoNotifier: Notifier = {
  async registerCategories() {
    for (const id of RETIRED_CATEGORIES)
      await Notifications.deleteNotificationCategoryAsync(id).catch(() => false);
    await Notifications.setNotificationCategoryAsync(NEEDS_ACTION_CATEGORY, []).catch(() => null);
  },

  setForegroundHandler(decide) {
    Notifications.setNotificationHandler({
      handleNotification: async (notification) => {
        // A notification this app scheduled has no trigger (`trigger: null`).
        const local = notification.request.trigger == null;
        const show = decide(contentOf(notification), local);
        return {
          shouldShowBanner: show,
          shouldShowList: show,
          shouldPlaySound: show,
          shouldSetBadge: true,
        };
      },
    });
  },

  onTap(listener) {
    let live = true;
    // A tap that launched the app arrives before any listener could be added.
    void Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (live && response) listener(contentOf(response.notification));
      })
      .catch(() => {});
    const sub = Notifications.addNotificationResponseReceivedListener((response) =>
      listener(contentOf(response.notification)),
    );
    return () => {
      live = false;
      sub.remove();
    };
  },

  async presented() {
    const list = await Notifications.getPresentedNotificationsAsync().catch(() => []);
    return list.map(contentOf);
  },

  async presentLocal(alert) {
    if (alert.decision !== "local") return;
    await Notifications.scheduleNotificationAsync({
      content: {
        title: alert.title,
        body: alert.body,
        data: { ...alert.data },
        ...(alert.category ? { categoryIdentifier: alert.category } : {}),
      },
      trigger: null,
    }).catch(() => null);
  },

  async setBadge(count) {
    await Notifications.setBadgeCountAsync(Math.max(0, count)).catch(() => false);
  },

  /**
   * Ask for permission and get an Expo push token. Without an EAS project id
   * there is no token to get: the phone still alerts locally while its sockets
   * are live, and Settings says so.
   */
  async pushToken(): Promise<PushTokenResult> {
    if (!Device.isDevice) return { ok: false, reason: "simulator" };
    const projectId = easProjectId();
    if (!projectId) return { ok: false, reason: "no-project-id" };
    const existing = await Notifications.getPermissionsAsync();
    let granted = existing.granted;
    if (!granted && existing.canAskAgain)
      granted = (await Notifications.requestPermissionsAsync()).granted;
    if (!granted) return { ok: false, reason: "denied" };
    try {
      const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
      return { ok: true, token: data };
    } catch (error) {
      return {
        ok: false,
        reason: "failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
