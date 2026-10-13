/**
 * The rules for notifications, apart from the native module that draws them
 * (`notifications.ts`): what a notification's `data` must look like to be
 * ours, where a tap goes, and whether a push that arrives in the foreground is
 * shown. Pure, so the provider's tests drive them with a fake `Notifier`.
 */
import { MobilePushData } from "@hermetic/core/schema";
import type { Alert } from "../client/client.ts";
import { arrivalFromPush, type InboxStore } from "../inbox/store.ts";
import type { PushTokenResult } from "./push.ts";

/** A notification's visible text and `data`, as the OS hands it over. */
export interface NoteContent {
  title?: string | null;
  body?: string | null;
  data?: unknown;
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

/** Where a tapped notification goes: its conversation (and session), else the inbox. */
export function routeFor(data: Pick<MobilePushData, "instance" | "bot" | "session"> | null): string {
  if (!data) return "/inbox";
  const session = data.session ? `?session=${encodeURIComponent(data.session)}` : "";
  return `/chat/${encodeURIComponent(data.instance)}/${encodeURIComponent(data.bot)}${session}`;
}

/**
 * File a push in the inbox. `true` when it is new (so worth showing); a push
 * for an event this phone's socket already showed (same `dedupe`, or the same
 * conversation and kind moments apart) is not.
 */
export function ingestPush(inbox: InboxStore, content: NoteContent, at: string): boolean {
  const data = pushDataOf(content);
  if (!data) return false;
  return inbox.ingest(arrivalFromPush(data, content, at));
}

/**
 * The foreground handler's answer: show a local notification we scheduled
 * ourselves (it was decided already); show a push only when the inbox did not
 * already hold it.
 */
export function foregroundDecision(
  inbox: InboxStore | null,
  content: NoteContent,
  local: boolean,
  at: string,
): boolean {
  if (local) return true;
  if (!inbox) return true;
  if (!pushDataOf(content)) return true;
  return ingestPush(inbox, content, at);
}
