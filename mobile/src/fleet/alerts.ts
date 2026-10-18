/**
 * The rules for notifications, apart from the native module that draws them
 * (`notifications.ts`): what a notification's `data` must look like to be
 * ours, whether it belongs to the paired fleet, where a tap goes, whether a
 * push that arrives in the foreground is shown, and whether this phone draws
 * its own local alert at all. Pure, so the provider's tests drive them with a
 * fake `Notifier`.
 */
import { MobilePushData } from "@hermetic/core/schema";
import type { Alert } from "../client/client.ts";
import { arrivalFromPush, type InboxStore, pushBelongs } from "../inbox/store.ts";
import type { PushTokenResult } from "./push.ts";

/** The paired fleet, as a push is checked against it: its id and its agents' names. */
export interface PushFleet {
  fleet_id: string;
  agents: readonly string[];
}

/** A notification's visible text and `data`, as the OS hands it over. */
export interface NoteContent {
  title?: string | null;
  body?: string | null;
  data?: unknown;
  /**
   * When the OS delivered it (epoch ms). A notification read from the
   * notification centre on foreground is filed at this moment, not at the
   * moment it was read, so it still folds with the entry the phone's own socket
   * raised for the same event (`SAME_EVENT_MS`).
   */
  date?: number | null;
}

/** When `content` was delivered (ISO), else `fallback`. */
export function noteTime(content: NoteContent, fallback: string): string {
  const date = content.date;
  return typeof date === "number" && Number.isFinite(date) && date > 0
    ? new Date(date).toISOString()
    : fallback;
}

/**
 * What the provider needs from the OS's notification centre. `notifications.ts`
 * is the one implementation over expo-notifications; tests hand in a double.
 */
export interface Notifier {
  /** The one category, `hermetic.needs_action`, with no inline actions. */
  registerCategories(): Promise<void>;
  /**
   * Decide each notification that arrives while the app is in front:
   * `local` is one this app scheduled itself.
   */
  setForegroundHandler(decide: (content: NoteContent, local: boolean) => boolean): void;
  /** A tap on a notification (cold start included). */
  onTap(listener: (content: NoteContent) => void): () => void;
  /** Notifications still in the notification centre (delivered while the app was away). */
  presented(): Promise<NoteContent[]>;
  presentLocal(alert: Alert): Promise<void>;
  setBadge(count: number): Promise<void>;
  /** Permission, then an Expo push token. */
  pushToken(): Promise<PushTokenResult>;
}

/** A box's push `data` (or a local alert's, which is shaped the same), or `null` if not ours. */
export function pushDataOf(content: NoteContent | null | undefined): MobilePushData | null {
  const parsed = MobilePushData.safeParse(content?.data);
  return parsed.success ? parsed.data : null;
}

export const HOME_ROUTE = "/home";

/** Where a tapped notification goes: its conversation (and session), else home. */
export function routeFor(data: Pick<MobilePushData, "instance" | "bot" | "session"> | null): string {
  if (!data) return HOME_ROUTE;
  const session = data.session ? `?session=${encodeURIComponent(data.session)}` : "";
  return `/chat/${encodeURIComponent(data.instance)}/${encodeURIComponent(data.bot)}${session}`;
}

/** The two router moves `openRoute` chooses between (expo-router's `router`, structurally). */
export interface RouteNavigator {
  push(href: string): void;
  dismissTo(href: string): void;
}

/**
 * Go where a notification (or the in-app banner) points. A conversation is
 * pushed over whatever is on screen; home is never pushed, since the stack's
 * root already is home and a push would stack a second one: `dismissTo` pops
 * back to it (or, with no home in the stack, replaces the screen with it).
 */
export function openRoute(href: string, nav: RouteNavigator): void {
  if (href === HOME_ROUTE) nav.dismissTo(href);
  else nav.push(href);
}

/**
 * A notification's push `data`, only when it is for the paired fleet and one of
 * its agents (`pushBelongs`). With no pairing nothing belongs.
 */
export function belongingData(
  content: NoteContent | null | undefined,
  fleet: PushFleet | null,
): MobilePushData | null {
  const data = pushDataOf(content);
  if (!data || !fleet) return null;
  return pushBelongs(data, fleet) ? data : null;
}

/**
 * File a push in the inbox, at the notification's own delivery time when the OS
 * gave one (`noteTime`), else at `at`. `true` when it is new (so worth showing); a push
 * for an event this phone's socket already showed (same `dedupe`, or the same
 * conversation and kind moments apart) is not, and neither is one for another
 * fleet or an agent the pairing does not name: that one is dropped unfiled.
 */
export function ingestPush(
  inbox: InboxStore,
  content: NoteContent,
  at: string,
  fleet: PushFleet | null,
): boolean {
  const data = belongingData(content, fleet);
  if (!data) return false;
  return inbox.ingest(arrivalFromPush(data, content, noteTime(content, at)));
}

/**
 * The foreground handler's answer: show a local notification we scheduled
 * ourselves (it was decided already); show a push only when it belongs to the
 * paired fleet and the inbox did not already hold it. A notification that is
 * not ours at all (no push `data`) is left to show.
 */
export function foregroundDecision(
  inbox: InboxStore | null,
  content: NoteContent,
  local: boolean,
  at: string,
  fleet: PushFleet | null,
): boolean {
  if (local) return true;
  if (!pushDataOf(content)) return true;
  if (!belongingData(content, fleet)) return false;
  if (!inbox) return true;
  return ingestPush(inbox, content, at, fleet);
}

/**
 * Whether this phone draws its own notification for an alert its sockets
 * raised. In the foreground (a banner) always. Outside it, only when no box
 * push will arrive for the same event: push is off, or the alert's box does not
 * hold this phone's registration (`covers`). Otherwise the box's push is the
 * one notification, and a local one beside it would be a duplicate.
 */
export function presentsLocally(alert: Alert, covers: (instance: string) => boolean): boolean {
  if (alert.decision !== "local") return true;
  return !covers(alert.data.instance);
}
