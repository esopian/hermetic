/**
 * Push notifications for paired phones, through Expo's push service.
 *
 * The sender is injected: `expoPushSender(fetch)` posts to Expo in batches of
 * 100; `memoryPushSender()` records what it was handed, and is what fixture
 * mode and every test use, so neither ever reaches the network.
 *
 * What a push may say is decided here. A reply preview is `redactText`'d and
 * cut to 140 characters, and a device with previews off gets a fixed body
 * instead ("Reply ready", "Needs you"). Inbox rows are already worded by core
 * without message text. Each push carries a dedupe key, and the notifier sends
 * a key to a device at most once; a phone with a socket open in the foreground
 * gets the frame instead of the push. A backgrounded app may be suspended
 * before it can raise an alert from a frame, so it gets both and dedupes.
 */
import type { FetchLike } from "../aws/tailscale.ts";
import { redactText } from "../chat/chat-redact.ts";
import type { ChatBlock, Notification, TurnSummary } from "../schema/index.ts";
import type { MobileDeviceRow, MobileStore } from "./device-store.ts";
import {
  createReceiptTracker,
  receiptOf,
  type PushReceipt,
  type ReceiptFetcher,
  type ReceiptTracker,
} from "./push-receipts.ts";
import { MOBILE_PROTOCOL, MOBILE_PUSH_CATEGORIES, type MobilePushKind } from "./protocol.ts";

export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
export const EXPO_PUSH_BATCH = 100;
/** One batch's whole round trip, body read included. */
export const EXPO_PUSH_TIMEOUT_MS = 10_000;

export type { PushReceipt } from "./push-receipts.ts";

export interface ExpoPushMessage {
  to: string;
  title: string;
  body?: string;
  data: Record<string, unknown>;
  sound?: "default";
  categoryId?: string;
  priority?: "default" | "high";
}

export type PushSender = (messages: ExpoPushMessage[]) => Promise<PushReceipt[]>;

function failedBatch(n: number, message: string): PushReceipt[] {
  return Array.from({ length: n }, () => ({ status: "error" as const, message }));
}

/**
 * Expo's push API, a batch of 100 per request, each bounded by
 * `EXPO_PUSH_TIMEOUT_MS`. Never throws: a failure is a receipt.
 *
 * What is read is Expo's push *tickets*. A ticket can say ok while delivery
 * later fails at APNs or FCM, which only the receipts endpoint reports; the
 * notifier follows the ids of `ok` tickets there (`push-receipts.ts`).
 */
export function expoPushSender(
  fetch: FetchLike,
  opts: { url?: string; timeoutMs?: number } = {},
): PushSender {
  const url = opts.url ?? EXPO_PUSH_URL;
  const timeoutMs = opts.timeoutMs ?? EXPO_PUSH_TIMEOUT_MS;
  return async (messages) => {
    const receipts: PushReceipt[] = [];
    for (let i = 0; i < messages.length; i += EXPO_PUSH_BATCH) {
      const batch = messages.slice(i, i + EXPO_PUSH_BATCH);
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            accept: "application/json",
            "accept-encoding": "gzip, deflate",
            "content-type": "application/json",
          },
          body: JSON.stringify(batch),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          receipts.push(...failedBatch(batch.length, `push service answered ${response.status}`));
          continue;
        }
        const json = (await response.json()) as { data?: unknown };
        const data = Array.isArray(json.data) ? json.data : [];
        for (let j = 0; j < batch.length; j++) receipts.push(receiptOf(data[j]));
      } catch {
        receipts.push(...failedBatch(batch.length, "push service unreachable"));
      }
    }
    return receipts;
  };
}

export interface MemoryPushSender extends PushSender {
  readonly sent: ExpoPushMessage[];
}

/** Records every message; answers `ok`, or what `respond` says. */
export function memoryPushSender(
  respond: (message: ExpoPushMessage) => PushReceipt = () => ({ status: "ok" }),
): MemoryPushSender {
  const sent: ExpoPushMessage[] = [];
  const sender = (async (messages: ExpoPushMessage[]) => {
    sent.push(...messages);
    return messages.map(respond);
  }) as MemoryPushSender;
  Object.defineProperty(sender, "sent", { value: sent });
  return sender;
}

/** Redacted, whitespace-collapsed, and at most `PREVIEW_MAX_CHARS`. */
export function previewText(text: string, max: number = MOBILE_PROTOCOL.PREVIEW_MAX_CHARS): string {
  const flat = redactText(text).replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

type ApprovalBlock = Extract<ChatBlock, { kind: "approval" }>;
type QuestionBlock = Extract<ChatBlock, { kind: "question" }>;

export type MobilePushEvent =
  | { kind: "turn.done"; turn: TurnSummary; reply: string }
  | { kind: "turn.error"; turn: TurnSummary; code: string }
  | {
      kind: "needs_action";
      instance: string;
      bot: string;
      session: string | null;
      block: ApprovalBlock | QuestionBlock;
    }
  | { kind: "notification"; row: Notification };

export interface BuiltPush {
  kind: MobilePushKind;
  dedupe: string;
  message: Omit<ExpoPushMessage, "to">;
}

function titleFor(bot: string, instance: string): string {
  return `${bot} · ${instance}`;
}

/**
 * The push one event becomes for one device, or `null` when it is not worth a
 * push (a `needs_action` block with no request id cannot be answered).
 */
export function buildPush(
  event: MobilePushEvent,
  device: Pick<MobileDeviceRow, "previews">,
): BuiltPush | null {
  switch (event.kind) {
    case "turn.done": {
      const t = event.turn;
      const dedupe = `turn:${t.turn_id}:done`;
      const preview = device.previews ? previewText(event.reply) : "";
      return {
        kind: "turn.done",
        dedupe,
        message: {
          title: titleFor(t.bot, t.instance),
          body: preview === "" ? "Reply ready" : preview,
          sound: "default",
          data: {
            kind: "turn.done",
            instance: t.instance,
            bot: t.bot,
            session: t.session,
            turn_id: t.turn_id,
            dedupe,
          },
        },
      };
    }
    case "turn.error": {
      const t = event.turn;
      const dedupe = `turn:${t.turn_id}:error`;
      return {
        kind: "turn.error",
        dedupe,
        message: {
          title: titleFor(t.bot, t.instance),
          body: event.code,
          sound: "default",
          data: {
            kind: "turn.error",
            instance: t.instance,
            bot: t.bot,
            session: t.session,
            turn_id: t.turn_id,
            code: event.code,
            dedupe,
          },
        },
      };
    }
    case "needs_action": {
      const requestId = event.block.request_id;
      if (requestId === null || requestId === undefined) return null;
      const dedupe = `req:${requestId}`;
      const approval = event.block.kind === "approval";
      const body = !device.previews
        ? "Needs you"
        : event.block.kind === "approval"
          ? previewText(`Approval needed: ${event.block.summary || event.block.tool}`)
          : previewText(event.block.prompt) || "Needs you";
      return {
        kind: "needs_action",
        dedupe,
        message: {
          title: titleFor(event.bot, event.instance),
          body,
          sound: "default",
          priority: "high",
          categoryId: approval ? MOBILE_PUSH_CATEGORIES.approval : MOBILE_PUSH_CATEGORIES.question,
          data: {
            kind: "needs_action",
            request_kind: approval ? "approval" : "question",
            instance: event.instance,
            bot: event.bot,
            session: event.session,
            request_id: requestId,
            dedupe,
          },
        },
      };
    }
    case "notification": {
      const row = event.row;
      const dedupe = `notif:${row.id}`;
      const detail = device.previews && row.detail ? previewText(row.detail) : "";
      return {
        kind: "notification",
        dedupe,
        message: {
          title: row.title,
          ...(detail === "" ? {} : { body: detail }),
          data: {
            kind: "notification",
            id: row.id,
            dedupe,
            ref: row.ref ?? null,
            target: row.actions[0]?.target ?? null,
          },
        },
      };
    }
  }
}

export interface PushNotifier {
  /** Push one event to every device that should get it. Never throws. */
  notify(event: MobilePushEvent): Promise<void>;
}

/** What the bridge owns: the notifier its handlers call, and the end of its receipt timer. */
export interface PushNotifierHandle extends PushNotifier {
  /** Stop following receipts; later `notify` calls still push. Idempotent. */
  close(): void;
}

export interface PushNotifierDeps {
  store: MobileStore;
  sender: PushSender;
  /** A device with a foreground socket gets the frame instead. */
  isLive: (deviceId: string) => boolean;
  /**
   * The fleet the bridge serves now. When given, only phones paired for it
   * are pushed to (and none while it is `null`): a phone paired on another
   * fleet must not read this one's previews.
   */
  fleetId?: () => string | null;
  /** How many `(device, dedupe)` pairs to remember. */
  remember?: number;
  /**
   * Follow the ids of `ok` tickets to their receipts and clear a token whose
   * receipt says `DeviceNotRegistered`. Absent (fixture mode, most tests): the
   * ticket answer is all that is read.
   */
  receipts?: {
    fetch: ReceiptFetcher;
    /** Default `RECEIPT_DELAY_MS`, fifteen minutes. */
    delayMs?: number;
    /** Tickets remembered at once; the oldest go first. */
    cap?: number;
    clock?: () => number;
    onError?: (reason: string) => void;
  };
}

export function createPushNotifier(deps: PushNotifierDeps): PushNotifierHandle {
  const remember = deps.remember ?? 4_096;
  const seen = new Set<string>();
  function mark(key: string): boolean {
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > remember) {
      const oldest = seen.values().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    return true;
  }

  /** Clear the token a ticket named, unless the phone has registered another since. */
  function forget(deviceId: string, token: string): void {
    if (deps.store.device(deviceId)?.expo_push_token !== token) return;
    deps.store.setPush(deviceId, { expo_push_token: null });
  }

  const tracker: ReceiptTracker | null =
    deps.receipts === undefined
      ? null
      : createReceiptTracker({
          fetchReceipts: deps.receipts.fetch,
          onUnregistered: forget,
          ...(deps.receipts.delayMs !== undefined ? { delayMs: deps.receipts.delayMs } : {}),
          ...(deps.receipts.cap !== undefined ? { cap: deps.receipts.cap } : {}),
          ...(deps.receipts.clock !== undefined ? { clock: deps.receipts.clock } : {}),
          ...(deps.receipts.onError !== undefined ? { onError: deps.receipts.onError } : {}),
        });

  return {
    close() {
      tracker?.close();
    },
    async notify(event) {
      try {
        const targets: Array<{ device: MobileDeviceRow; message: ExpoPushMessage }> = [];
        const fleet = deps.fleetId === undefined ? undefined : deps.fleetId();
        for (const device of deps.store.listDevices()) {
          if (!device.enabled || device.expo_push_token === null) continue;
          if (fleet !== undefined && (fleet === null || device.fleet_id !== fleet)) continue;
          if (deps.isLive(device.device_id)) continue;
          const built = buildPush(event, device);
          if (built === null) continue;
          if (!mark(`${device.device_id}|${built.dedupe}`)) continue;
          targets.push({ device, message: { to: device.expo_push_token, ...built.message } });
        }
        if (targets.length === 0) return;
        const receipts = await deps.sender(targets.map((t) => t.message));
        receipts.forEach((receipt, i) => {
          const target = targets[i];
          if (target === undefined) return;
          if (receipt.status === "error" && receipt.details?.error === "DeviceNotRegistered") {
            forget(target.device.device_id, target.message.to);
          } else if (receipt.status === "ok" && receipt.id !== undefined) {
            tracker?.track(receipt.id, target.device.device_id, target.message.to);
          }
        });
      } catch {
        // A push is a courtesy; the inbox and the transcript still have it.
      }
    },
  };
}
