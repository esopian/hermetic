/**
 * Expo's public push API, as plain values and functions: the payload shapes,
 * batching, and the parse of a ticket or receipt.
 *
 * In `shared` because the box sends (hermeticd's gateway watcher,
 * `packages/agentd/src/push/`) and a phone or a test may need to read the same
 * shapes; nothing here opens a socket of its own. The caller hands in `fetch`,
 * so every test drives these with a double and none reaches exp.host.
 *
 * Two halves to a push. A send answers with one *ticket* per message; a ticket
 * that says `ok` only means Expo accepted the message. Whether APNs or FCM took
 * it is reported later, by ticket id, from `getReceipts` — Expo asks for about
 * fifteen minutes between the two. The one outcome a sender acts on is
 * `DeviceNotRegistered` (the app was uninstalled or its token rotated), which
 * means the token should not be pushed to again.
 *
 * No access token: the public push API takes none, and a push token is not a
 * secret in the credential sense, but it is still never logged by a caller.
 *
 * Pure values only — no Zod, no `node:*`, no environment reads
 * (`packages/core/test/shared-browser-safe.test.ts`).
 */

export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
export const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
/** Expo's cap on messages per send request. */
export const EXPO_PUSH_BATCH = 100;
/** Expo's cap on ids per `getReceipts` request. */
export const EXPO_RECEIPTS_BATCH = 1_000;
/** One request's whole round trip, body read included. */
export const EXPO_PUSH_TIMEOUT_MS = 10_000;
/** The receipt error that retires a token. */
export const EXPO_DEVICE_NOT_REGISTERED = "DeviceNotRegistered";

/** `fetch`, structurally — `typeof fetch` carries extras no double has. */
export type ExpoFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** One message as Expo's send endpoint takes it. */
export interface ExpoPushMessage {
  /** `ExponentPushToken[…]`. Never logged. */
  to: string;
  title: string;
  body?: string;
  data: Record<string, unknown>;
  sound?: "default";
  categoryId?: string;
  priority?: "default" | "normal" | "high";
}

/** What a send answers per message, and what `getReceipts` answers per id: the same shape. */
export type ExpoPushTicket =
  | { status: "ok"; id?: string }
  | { status: "error"; message: string; details?: { error?: string } };

export type ExpoPushReceipt = ExpoPushTicket;

/** Sends every message, batched; one ticket per message, in order. Never throws. */
export type ExpoPushSender = (messages: readonly ExpoPushMessage[]) => Promise<ExpoPushTicket[]>;

/**
 * Receipts by ticket id; an id Expo does not know yet is absent from the map.
 * Throws on a failed request, so the caller can count it.
 */
export type ExpoReceiptFetcher = (
  ids: readonly string[],
  signal?: AbortSignal,
) => Promise<Map<string, ExpoPushReceipt>>;

/** `items` in runs of at most `size`, in order. `size` below 1 is treated as 1. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const step = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step));
  return out;
}

/** One ticket or receipt off the wire. Anything unrecognisable is an error ticket. */
export function receiptOf(value: unknown): ExpoPushTicket {
  if (typeof value !== "object" || value === null) {
    return { status: "error", message: "malformed receipt" };
  }
  const v = value as Record<string, unknown>;
  if (v["status"] === "ok") {
    return typeof v["id"] === "string" ? { status: "ok", id: v["id"] } : { status: "ok" };
  }
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

/** Whether a ticket or receipt says the token is dead. */
export function isDeviceNotRegistered(ticket: ExpoPushTicket | undefined): boolean {
  return ticket?.status === "error" && ticket.details?.error === EXPO_DEVICE_NOT_REGISTERED;
}

const JSON_HEADERS = {
  accept: "application/json",
  "accept-encoding": "gzip, deflate",
  "content-type": "application/json",
} as const;

function failedBatch(n: number, message: string): ExpoPushTicket[] {
  return Array.from({ length: n }, () => ({ status: "error" as const, message }));
}

/**
 * Expo's send endpoint, `EXPO_PUSH_BATCH` messages per request, each request
 * bounded by `timeoutMs`. Never throws: a failed request becomes one error
 * ticket per message in it, so the caller's index arithmetic always holds.
 */
export function expoPushSender(
  fetch: ExpoFetch,
  opts: { url?: string; timeoutMs?: number } = {},
): ExpoPushSender {
  const url = opts.url ?? EXPO_PUSH_URL;
  const timeoutMs = opts.timeoutMs ?? EXPO_PUSH_TIMEOUT_MS;
  return async (messages) => {
    const tickets: ExpoPushTicket[] = [];
    for (const batch of chunk(messages, EXPO_PUSH_BATCH)) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify(batch),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) {
          tickets.push(...failedBatch(batch.length, `push service answered ${response.status}`));
          continue;
        }
        const json = (await response.json()) as { data?: unknown };
        const data = Array.isArray(json?.data) ? (json.data as unknown[]) : [];
        for (let j = 0; j < batch.length; j++) tickets.push(receiptOf(data[j]));
      } catch {
        tickets.push(...failedBatch(batch.length, "push service unreachable"));
      }
    }
    return tickets;
  };
}

/**
 * Expo's `getReceipts`, `EXPO_RECEIPTS_BATCH` ids per request, each bounded by
 * `timeoutMs`. A failed request throws a plain `Error` naming the status,
 * never an id or a token.
 */
export function expoReceiptFetcher(
  fetch: ExpoFetch,
  opts: { url?: string; timeoutMs?: number } = {},
): ExpoReceiptFetcher {
  const url = opts.url ?? EXPO_RECEIPTS_URL;
  const timeoutMs = opts.timeoutMs ?? EXPO_PUSH_TIMEOUT_MS;
  return async (ids, outer) => {
    const out = new Map<string, ExpoPushReceipt>();
    for (const batch of chunk(ids, EXPO_RECEIPTS_BATCH)) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const response = await fetch(url, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ ids: batch }),
        signal: outer === undefined ? timeout : AbortSignal.any([timeout, outer]),
      });
      if (!response.ok) throw new Error(`receipts service answered ${response.status}`);
      const json = (await response.json()) as { data?: unknown };
      const data =
        typeof json?.data === "object" && json.data !== null
          ? (json.data as Record<string, unknown>)
          : {};
      for (const id of batch) if (Object.hasOwn(data, id)) out.set(id, receiptOf(data[id]));
    }
    return out;
  };
}
