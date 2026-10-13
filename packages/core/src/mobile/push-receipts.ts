/**
 * Expo push receipts: the second half of a push.
 *
 * A send answers with a *ticket* per message. A ticket that says `ok` only
 * means Expo accepted the message; whether APNs or FCM took it is reported
 * later, by id, from `/push/getReceipts`. The one outcome acted on here is
 * `DeviceNotRegistered` (the app was uninstalled or its token rotated), which
 * clears that phone's push token so it is not pushed to again.
 *
 * `createReceiptTracker` remembers `(ticket id → device, token)` in memory,
 * waits `delayMs` (Expo asks for about fifteen minutes before the receipts
 * exist), then asks in chunks of 1000. It is a courtesy like the send path:
 * a failed poll is swallowed, its timer is unref'd so it never keeps the
 * process alive, `close()` cancels it, and a push token is never logged.
 */
import type { FetchLike } from "../aws/tailscale.ts";

export const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
/** Expo's cap on ids per `getReceipts` request. */
export const EXPO_RECEIPTS_BATCH = 1_000;
/** One chunk's whole round trip, body read included. */
export const EXPO_RECEIPTS_TIMEOUT_MS = 10_000;
/** Expo asks for ~15 minutes between a send and asking for its receipt. */
export const RECEIPT_DELAY_MS = 15 * 60_000;
/** Tickets remembered at once; past it the oldest are forgotten. */
export const RECEIPT_PENDING_CAP = 10_000;

export type PushReceipt =
  | { status: "ok"; id?: string }
  | { status: "error"; message: string; details?: { error?: string } };

export function receiptOf(value: unknown): PushReceipt {
  if (typeof value !== "object" || value === null) {
    return { status: "error", message: "malformed receipt" };
  }
  const v = value as Record<string, unknown>;
  if (v["status"] === "ok")
    return typeof v["id"] === "string" ? { status: "ok", id: v["id"] } : { status: "ok" };
  const details = v["details"];
  const error =
    typeof details === "object" && details !== null
      ? (details as Record<string, unknown>)["error"]
      : undefined;
  return {
    status: "error",
    message: typeof v["message"] === "string" ? v["message"] : "push refused",
    ...(typeof error === "string" ? { details: { error } } : {}),
  };
}

/**
 * Receipts by ticket id; a ticket Expo does not know yet is absent. Throws on
 * a failed request, and `signal` aborts when the tracker closes.
 */
export type ReceiptFetcher = (ids: string[], signal?: AbortSignal) => Promise<Map<string, PushReceipt>>;

/**
 * Expo's `getReceipts`, one request for up to `EXPO_RECEIPTS_BATCH` ids,
 * bounded by `timeoutMs`. A failure (network, status, body) throws, so the
 * tracker can record it; the tracker is what swallows.
 */
export function expoReceiptFetcher(
  fetch: FetchLike,
  opts: { url?: string; timeoutMs?: number } = {},
): ReceiptFetcher {
  const url = opts.url ?? EXPO_RECEIPTS_URL;
  const timeoutMs = opts.timeoutMs ?? EXPO_RECEIPTS_TIMEOUT_MS;
  return async (ids, outer) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "accept-encoding": "gzip, deflate",
        "content-type": "application/json",
      },
      body: JSON.stringify({ ids }),
      signal: outer === undefined ? timeout : AbortSignal.any([timeout, outer]),
    });
    if (!response.ok) throw new Error(`receipts service answered ${response.status}`);
    const json = (await response.json()) as { data?: unknown };
    const data =
      typeof json.data === "object" && json.data !== null ? (json.data as Record<string, unknown>) : {};
    const out = new Map<string, PushReceipt>();
    for (const id of ids) if (Object.hasOwn(data, id)) out.set(id, receiptOf(data[id]));
    return out;
  };
}

export interface ReceiptTrackerDeps {
  fetchReceipts: ReceiptFetcher;
  /** A ticket's device and the token it was sent to came back `DeviceNotRegistered`. */
  onUnregistered: (deviceId: string, token: string) => void;
  /** Wait before asking for a ticket's receipt. Default `RECEIPT_DELAY_MS`. */
  delayMs?: number;
  /** Tickets remembered at once. Default `RECEIPT_PENDING_CAP`. */
  cap?: number;
  clock?: () => number;
  /** A fixed reason, never a token; for a head that wants to record a swallowed failure. */
  onError?: (reason: string) => void;
}

export interface ReceiptTracker {
  /** Remember one ticket until its receipt is due. A no-op once closed. */
  track(ticketId: string, deviceId: string, token: string): void;
  /** Ask for every pending receipt now, due or not. Resolves once answered; never throws. */
  flush(): Promise<void>;
  /** Tickets waiting for a receipt. */
  pending(): number;
  /** Cancel the timer and any request in flight, and forget every ticket. */
  close(): void;
}

interface Pending {
  deviceId: string;
  token: string;
  dueAt: number;
}

export function createReceiptTracker(deps: ReceiptTrackerDeps): ReceiptTracker {
  const delayMs = Math.max(0, deps.delayMs ?? RECEIPT_DELAY_MS);
  const cap = Math.max(1, deps.cap ?? RECEIPT_PENDING_CAP);
  const clock = deps.clock ?? (() => Date.now());
  const closing = new AbortController();
  const pending = new Map<string, Pending>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let polling: Promise<void> | null = null;
  let closed = false;

  const fail = (reason: string): void => {
    try {
      deps.onError?.(reason);
    } catch {
      // A recorder's failure is its own.
    }
  };

  function schedule(): void {
    if (closed || timer !== null || polling !== null) return;
    const first = pending.values().next().value;
    if (first === undefined) return;
    timer = setTimeout(
      () => {
        timer = null;
        void run(false);
      },
      Math.max(0, first.dueAt - clock()),
    );
    // A pending receipt must never keep the process alive.
    (timer as { unref?: () => void }).unref?.();
  }

  async function poll(all: boolean): Promise<void> {
    const now = clock();
    const ids: string[] = [];
    for (const [id, entry] of pending) {
      // Insertion order is due order: the first not-yet-due ticket ends the scan.
      if (!all && entry.dueAt > now) break;
      ids.push(id);
    }
    for (let i = 0; i < ids.length && !closed; i += EXPO_RECEIPTS_BATCH) {
      const chunk = ids.slice(i, i + EXPO_RECEIPTS_BATCH);
      // Asked once: a chunk that fails is forgotten rather than retried forever.
      const entries = chunk.map((id) => ({ id, entry: pending.get(id) }));
      for (const id of chunk) pending.delete(id);
      try {
        const receipts = await deps.fetchReceipts(chunk, closing.signal);
        if (closed) return;
        for (const { id, entry } of entries) {
          const receipt = receipts.get(id);
          if (entry === undefined || receipt === undefined) continue;
          if (receipt.status === "error" && receipt.details?.error === "DeviceNotRegistered") {
            try {
              deps.onUnregistered(entry.deviceId, entry.token);
            } catch {
              fail("receipt handler failed");
            }
          }
        }
      } catch {
        fail("receipt poll failed");
      }
    }
  }

  function run(all: boolean): Promise<void> {
    // One poll at a time; a flush that arrives mid-poll waits for it, then polls what is left.
    const previous = polling;
    const next = (async () => {
      if (previous !== null) await previous;
      if (closed) return;
      await poll(all);
    })().finally(() => {
      if (polling === next) polling = null;
      schedule();
    });
    polling = next;
    return next;
  }

  return {
    track(ticketId, deviceId, token) {
      if (closed) return;
      pending.delete(ticketId);
      pending.set(ticketId, { deviceId, token, dueAt: clock() + delayMs });
      while (pending.size > cap) {
        const oldest = pending.keys().next().value;
        if (oldest === undefined) break;
        pending.delete(oldest);
      }
      schedule();
    },
    flush: () => run(true),
    pending: () => pending.size,
    close() {
      if (closed) return;
      closed = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending.clear();
      closing.abort();
    },
  };
}
