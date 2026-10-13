/**
 * expo-notifications glue: categories, the foreground handler, local alerts,
 * the app badge, push registration, and routing a tapped notification.
 *
 * The decision of *whether* to alert is the client layer's (`alertFor`, with
 * the shared dedupe set); this file only carries it out.
 */
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import type { Alert, HermeticClient } from "../client/client.ts";
import type { DedupeSet } from "../client/notifications-store.ts";
import { MOBILE_PUSH_CATEGORIES } from "../protocol/constants.ts";
import type { PushData } from "../protocol/types.ts";

/** Register the actionable categories the bridge's pushes name (`MOBILE_PUSH_CATEGORIES`). */
export async function registerCategories(): Promise<void> {
  await Notifications.setNotificationCategoryAsync(MOBILE_PUSH_CATEGORIES.approval, [
    {
      identifier: "approve_once",
      buttonTitle: "Approve once",
      // Approving runs a command on a box: the phone must be unlocked.
      options: { opensAppToForeground: false, isAuthenticationRequired: true },
    },
    {
      identifier: "deny",
      buttonTitle: "Deny",
      options: { opensAppToForeground: false, isDestructive: true, isAuthenticationRequired: true },
    },
  ]).catch(() => null);
  await Notifications.setNotificationCategoryAsync(MOBILE_PUSH_CATEGORIES.question, [
    { identifier: "open", buttonTitle: "Answer", options: { opensAppToForeground: true } },
  ]).catch(() => null);
}

/** Read `data` off a notification, if it is one of ours. */
export function pushDataOf(content: { data?: unknown } | null | undefined): PushData | null {
  const data = content?.data as Partial<PushData> | undefined;
  if (
    !data ||
    typeof data !== "object" ||
    typeof data.kind !== "string" ||
    typeof data.dedupe !== "string"
  )
    return null;
  return data as PushData;
}

/**
 * The foreground handler. A push for an event the live socket already
 * delivered (same `dedupe`) is swallowed; anything else shows as a banner.
 */
export function installForegroundHandler(dedupe: () => DedupeSet | null): void {
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const data = pushDataOf(notification.request.content);
      const set = dedupe();
      // Local notifications we scheduled ourselves are already claimed: show them.
      const local = notification.request.trigger == null;
      const fresh = local || !data || !set ? true : set.claim(data.dedupe);
      return {
        shouldShowBanner: fresh,
        shouldShowList: fresh,
        shouldPlaySound: fresh,
        shouldSetBadge: true,
      };
    },
  });
}

/** Carry out a client-layer alert decision. Banners are drawn in-app by the shell; locals go to the OS. */
export async function presentLocal(alert: Alert): Promise<void> {
  if (alert.decision !== "local") return;
  await Notifications.scheduleNotificationAsync({
    content: {
      title: alert.title,
      body: alert.body,
      data: alert.data as unknown as Record<string, unknown>,
      ...(alert.category ? { categoryIdentifier: alert.category } : {}),
    },
    trigger: null,
  }).catch(() => null);
}

export async function setBadge(count: number): Promise<void> {
  await Notifications.setBadgeCountAsync(Math.max(0, count)).catch(() => false);
}

/** The EAS project id from app config (`EXPO_PUBLIC_PROJECT_ID` / `EAS_PROJECT_ID`), if any. */
export function easProjectId(): string | null {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? null;
}

export type PushRegistration =
  | { ok: true; token: string }
  | { ok: false; reason: "simulator" | "denied" | "no-project-id" | "failed"; message?: string };

/**
 * Ask for permission, get an Expo push token, and register it with the bridge.
 * Without an EAS project id there is no token to get: the phone still alerts
 * locally while its socket is live, and says so in Settings.
 */
export async function registerForPush(
  client: HermeticClient,
  previews: boolean,
): Promise<PushRegistration> {
  if (!Device.isDevice) return { ok: false, reason: "simulator" };
  const projectId = easProjectId();
  if (!projectId) return { ok: false, reason: "no-project-id" };
  const existing = await Notifications.getPermissionsAsync();
  let granted = existing.granted;
  if (!granted && existing.canAskAgain)
    granted = (await Notifications.requestPermissionsAsync()).granted;
  if (!granted) return { ok: false, reason: "denied" };
  try {
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    await client.http.pushRegister({ expo_push_token: token, previews });
    return { ok: true, token };
  } catch (error) {
    return {
      ok: false,
      reason: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Where a tapped notification goes. */
export function routeFor(data: PushData): string {
  if (data.kind === "notification") {
    const ref = data.ref ?? "";
    const cut = ref.indexOf("/");
    if (cut > 0 && cut < ref.length - 1)
      return `/chat/${encodeURIComponent(ref.slice(0, cut))}/${encodeURIComponent(ref.slice(cut + 1))}`;
    return "/inbox";
  }
  const session = data.session ? `?session=${encodeURIComponent(data.session)}` : "";
  return `/chat/${encodeURIComponent(data.instance)}/${encodeURIComponent(data.bot)}${session}`;
}

/**
 * An action button pressed on an approval notification answers it without
 * opening the app (`chat.respond` over HTTP — the socket may be closed).
 * Returns `true` when it was handled here.
 */
export async function handleAction(
  response: Notifications.NotificationResponse,
  client: HermeticClient | null,
): Promise<boolean> {
  const data = pushDataOf(response.notification.request.content);
  const action = response.actionIdentifier;
  if (!client || !data || data.kind !== "needs_action" || data.request_kind !== "approval")
    return false;
  if (action !== "approve_once" && action !== "deny") return false;
  if (!data.session) return false;
  await client.http.rpc("chat.respond", {
    instance: data.instance,
    bot: data.bot,
    session: data.session,
    request_id: data.request_id,
    kind: "approval",
    choice: action === "approve_once" ? "once" : "deny",
  });
  return true;
}
