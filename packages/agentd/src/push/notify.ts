/**
 * The push half of the gateway watcher (§9.4): one watcher event in, one Expo
 * message per listening phone out, and the receipts followed up.
 *
 * What a push may say is decided here. The body has already been through
 * agentd's `redact.ts` (`previewText`) and is at most `PUSH_BODY_MAX_CHARS`;
 * the `data` is a `MobilePushData`, whose `dedupe` lets the phone drop a push
 * for an event its own live socket already showed. A dedupe key is sent at
 * most once per process, so a session that flaps `waiting` at the same message
 * count raises one push, not one per flap.
 *
 * Bounded everywhere a phone could be flooded or the box could grow: at most
 * `PUSHES_PER_DEVICE_PER_MINUTE` per phone (the rest dropped and counted), at
 * most `RECEIPT_PENDING_CAP` tickets awaiting a receipt, and a dedupe memory of
 * `DEDUPE_MEMORY` keys.
 *
 * Never throws, and never logs a push token: a line names the device id.
 */
import type { MobilePushData, MobilePushKind } from "@hermetic/core/schema";
import {
  isDeviceNotRegistered,
  type ExpoPushMessage,
  type ExpoPushSender,
  type ExpoReceiptFetcher,
} from "@hermetic/core/shared";
import { listensTo, type PushDeviceStore } from "./devices.ts";

/** Expo asks for about fifteen minutes between a send and its receipt. */
export const RECEIPT_DELAY_MS = 15 * 60_000;
/** Tickets remembered at once; past it the oldest are forgotten. */
export const RECEIPT_PENDING_CAP = 10_000;
/** Pushes one phone may receive from this box per minute. */
export const PUSHES_PER_DEVICE_PER_MINUTE = 30;
/** The longest push body, in characters. */
export const PUSH_BODY_MAX_CHARS = 140;
/** The category the phone registers for a needs-action push (no inline actions). */
export const NEEDS_ACTION_CATEGORY = "hermetic.needs_action";
/** Dedupe keys remembered at once. */
export const DEDUPE_MEMORY = 4_096;
const MINUTE_MS = 60_000;

/** One thing worth telling a phone about, as the watcher saw it. */
export interface PushEvent {
  readonly kind: MobilePushKind;
  readonly bot: string;
  /** The stored session id (upstream's `session_key`), what the phone opens. */
  readonly session: string;
  readonly message_count: number;
  /** Already redacted and cut (`previewText`). */
  readonly body: string;
}

export interface NotifierDeps {
  readonly devices: PushDeviceStore;
  readonly send: ExpoPushSender;
  readonly fetchReceipts: ExpoReceiptFetcher;
  /** Milliseconds. */
  readonly now: () => number;
  readonly log: (message: string) => void;
  readonly instance: string;
  readonly fleet_id: string;
  readonly receiptDelayMs?: number;
  readonly perDeviceLimit?: number;
}

export interface NotifyResult {
  /** Messages handed to Expo. */
  readonly sent: number;
  /** Phones skipped by the per-device cap. */
  readonly dropped: number;
}

export interface Notifier {
  notify(event: PushEvent): Promise<NotifyResult>;
  /** Ask Expo for every receipt now due; prune `DeviceNotRegistered` phones. */
  pollReceipts(): Promise<void>;
  /** Tickets waiting for a receipt. */
  pendingReceipts(): number;
  /** Pushes dropped by the per-device cap since start. */
  droppedTotal(): number;
}

/** `<instance>:<session>:<message_count>:<kind>` — the phone computes the same. */
export function dedupeKey(
  instance: string,
  session: string,
  count: number,
  kind: MobilePushKind,
): string {
  return `${instance}:${session}:${count}:${kind}`;
}

/** Redacted, whitespace-collapsed, and at most `max` characters. */
export function previewText(
  text: string,
  redact: (value: string) => string,
  max: number = PUSH_BODY_MAX_CHARS,
): string {
  const flat = redact(text).replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** The bot's name, and the box's too when the two differ. */
export function pushTitle(bot: string, instance: string): string {
  return bot === instance ? bot : `${bot} · ${instance}`;
}

interface PendingReceipt {
  readonly deviceId: string;
  readonly token: string;
  readonly dueAt: number;
}

export function createNotifier(deps: NotifierDeps): Notifier {
  const delayMs = Math.max(0, deps.receiptDelayMs ?? RECEIPT_DELAY_MS);
  const limit = Math.max(1, deps.perDeviceLimit ?? PUSHES_PER_DEVICE_PER_MINUTE);
  const sentKeys = new Set<string>();
  const recent = new Map<string, number[]>();
  /** device → when its cap was last reported, so a flood is one line a minute. */
  const capLogged = new Map<string, number>();
  const pending = new Map<string, PendingReceipt>();
  let dropped = 0;

  function remember(key: string): boolean {
    if (sentKeys.has(key)) return false;
    sentKeys.add(key);
    if (sentKeys.size > DEDUPE_MEMORY) {
      const oldest = sentKeys.values().next().value;
      if (oldest !== undefined) sentKeys.delete(oldest);
    }
    return true;
  }

  /** True when the phone still has budget this minute; counts the push if so. */
  function admit(deviceId: string, now: number): boolean {
    const times = (recent.get(deviceId) ?? []).filter((t) => now - t < MINUTE_MS);
    if (times.length >= limit) {
      recent.set(deviceId, times);
      dropped += 1;
      const last = capLogged.get(deviceId);
      if (last === undefined || now - last >= MINUTE_MS) {
        capLogged.set(deviceId, now);
        deps.log(`push: ${deviceId} reached ${limit} pushes a minute; dropping until it drains`);
      }
      return false;
    }
    times.push(now);
    recent.set(deviceId, times);
    return true;
  }

  async function forget(deviceId: string, token: string, why: string): Promise<void> {
    const removed = await deps.devices.remove(deviceId, token).catch(() => false);
    if (removed) deps.log(`push device ${deviceId} removed: ${why}`);
  }

  return {
    async notify(event) {
      try {
        const dedupe = dedupeKey(deps.instance, event.session, event.message_count, event.kind);
        if (!remember(dedupe)) return { sent: 0, dropped: 0 };
        const data: MobilePushData = {
          fleet_id: deps.fleet_id,
          instance: deps.instance,
          bot: event.bot,
          session: event.session,
          kind: event.kind,
          dedupe,
        };
        const now = deps.now();
        const targets: Array<{ deviceId: string; message: ExpoPushMessage }> = [];
        let skipped = 0;
        for (const device of await deps.devices.list()) {
          if (!listensTo(device, event.bot)) continue;
          if (!admit(device.device_id, now)) {
            skipped += 1;
            continue;
          }
          targets.push({
            deviceId: device.device_id,
            message: {
              to: device.token,
              title: pushTitle(event.bot, deps.instance),
              ...(event.body === "" ? {} : { body: event.body }),
              data: { ...data },
              sound: "default",
              ...(event.kind === "needs_action"
                ? { priority: "high" as const, categoryId: NEEDS_ACTION_CATEGORY }
                : {}),
            },
          });
        }
        if (targets.length === 0) return { sent: 0, dropped: skipped };
        const tickets = await deps.send(targets.map((t) => t.message));
        for (let i = 0; i < targets.length; i++) {
          const target = targets[i];
          const ticket = tickets[i];
          if (target === undefined || ticket === undefined) continue;
          if (isDeviceNotRegistered(ticket)) {
            await forget(target.deviceId, target.message.to, "DeviceNotRegistered");
          } else if (ticket.status === "ok" && ticket.id !== undefined) {
            pending.delete(ticket.id);
            pending.set(ticket.id, {
              deviceId: target.deviceId,
              token: target.message.to,
              dueAt: now + delayMs,
            });
            while (pending.size > RECEIPT_PENDING_CAP) {
              const oldest = pending.keys().next().value;
              if (oldest === undefined) break;
              pending.delete(oldest);
            }
          }
        }
        return { sent: targets.length, dropped: skipped };
      } catch (e) {
        deps.log(`push: could not notify (${e instanceof Error ? e.message : String(e)})`);
        return { sent: 0, dropped: 0 };
      }
    },

    async pollReceipts() {
      const now = deps.now();
      const due: Array<[string, PendingReceipt]> = [];
      // Insertion order is due order: the first ticket not yet due ends the scan.
      for (const entry of pending) {
        if (entry[1].dueAt > now) break;
        due.push(entry);
      }
      if (due.length === 0) return;
      // Asked once: a request that fails is forgotten rather than retried forever.
      for (const [id] of due) pending.delete(id);
      try {
        const receipts = await deps.fetchReceipts(due.map(([id]) => id));
        for (const [id, entry] of due) {
          if (isDeviceNotRegistered(receipts.get(id))) {
            await forget(entry.deviceId, entry.token, "DeviceNotRegistered receipt");
          }
        }
      } catch (e) {
        deps.log(`push: receipt poll failed (${e instanceof Error ? e.message : String(e)})`);
      }
    },

    pendingReceipts: () => pending.size,
    droppedTotal: () => dropped,
  };
}
