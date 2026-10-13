/**
 * The push half of the gateway watcher (§9.4): one watcher event in, one Expo
 * message per listening phone out, and the receipts followed up.
 *
 * What a push may say is decided here. By default it says nothing of the
 * conversation: the body is `contentFreeBody` ("<bot> replied"), the same for
 * every phone. Only a device registered with `previews: true` gets the
 * excerpt, which has already been through agentd's `redact.ts`
 * (`previewText`) and is at most `PUSH_BODY_MAX_CHARS`. The `data` is a
 * `MobilePushData` either way — its `session` is what the phone opens, so it
 * is not a preview — and its `dedupe` names the watcher's event, so a key is
 * sent at most once per process.
 *
 * Bounded everywhere a phone could be flooded or the box could grow: at most
 * `PUSHES_PER_DEVICE_PER_MINUTE` per phone (the rest dropped and counted), at
 * most `RECEIPT_PENDING_CAP` tickets awaiting a receipt, and a dedupe memory of
 * `DEDUPE_MEMORY` keys.
 *
 * Never throws, and never logs a push token: a line names the device by
 * `deviceTag`, never by its raw id.
 */
import type { MobilePushData, MobilePushKind } from "@hermetic/core/schema";
import {
  isDeviceNotRegistered,
  type ExpoPushMessage,
  type ExpoPushSender,
  type ExpoReceiptFetcher,
} from "@hermetic/core/shared";
import { deviceTag, listensTo, type PushDeviceKey, type PushDeviceStore } from "./devices.ts";

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
  /** The watcher's event counter for this session: the `<n>` of the dedupe key. */
  readonly seq: number;
  /**
   * The excerpt a `previews: true` device gets, already redacted and cut
   * (`previewText`); `""` when there is none, and that device gets the
   * content-free body too.
   */
  readonly preview: string;
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

/** `<instance>:<session>:<n>:<kind>`, `n` the watcher's event counter (`MobilePushData`). */
export function dedupeKey(
  instance: string,
  session: string,
  seq: number,
  kind: MobilePushKind,
): string {
  return `${instance}:${session}:${seq}:${kind}`;
}

/** The body every device gets unless it opted into previews: nothing of the conversation. */
export function contentFreeBody(kind: MobilePushKind, bot: string): string {
  switch (kind) {
    case "turn.done":
      return `${bot} replied`;
    case "turn.error":
      return `${bot} hit an error`;
    case "needs_action":
      return `${bot} is waiting on you`;
    case "message":
      return `New message from ${bot}`;
  }
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
  readonly device: PushDeviceKey;
  readonly token: string;
  readonly dueAt: number;
}

/** The limiter's key for one record: owner and id, since two owners may share an id. */
function recordKey(d: PushDeviceKey): string {
  return `${d.owner}\u0000${d.device_id}`;
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
  function admit(device: PushDeviceKey, now: number): boolean {
    const key = recordKey(device);
    const times = (recent.get(key) ?? []).filter((t) => now - t < MINUTE_MS);
    if (times.length >= limit) {
      recent.set(key, times);
      dropped += 1;
      const last = capLogged.get(key);
      if (last === undefined || now - last >= MINUTE_MS) {
        capLogged.set(key, now);
        deps.log(
          `push: ${deviceTag(device.device_id)} reached ${limit} pushes a minute; dropping until it drains`,
        );
      }
      return false;
    }
    times.push(now);
    recent.set(key, times);
    return true;
  }

  async function forget(device: PushDeviceKey, token: string, why: string): Promise<void> {
    const removed = await deps.devices.remove(device, token).catch(() => false);
    if (removed) deps.log(`push device ${deviceTag(device.device_id)} removed: ${why}`);
  }

  return {
    async notify(event) {
      try {
        const dedupe = dedupeKey(deps.instance, event.session, event.seq, event.kind);
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
        const generic = contentFreeBody(event.kind, event.bot);
        const targets: Array<{ device: PushDeviceKey; message: ExpoPushMessage }> = [];
        let skipped = 0;
        for (const device of await deps.devices.list()) {
          if (!listensTo(device, event.bot)) continue;
          if (!admit(device, now)) {
            skipped += 1;
            continue;
          }
          targets.push({
            device: { owner: device.owner, device_id: device.device_id },
            message: {
              to: device.token,
              title: pushTitle(event.bot, deps.instance),
              body: device.previews && event.preview !== "" ? event.preview : generic,
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
            await forget(target.device, target.message.to, "DeviceNotRegistered");
          } else if (ticket.status === "ok" && ticket.id !== undefined) {
            pending.delete(ticket.id);
            pending.set(ticket.id, {
              device: target.device,
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
            await forget(entry.device, entry.token, "DeviceNotRegistered receipt");
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
