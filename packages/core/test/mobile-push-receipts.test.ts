/**
 * Expo push receipts (`mobile/push-receipts.ts`, wired by `createPushNotifier`):
 * a `DeviceNotRegistered` receipt clears the token, other errors keep it, a
 * ticket that is itself that error clears it at once, ids go out in chunks of
 * 1000, `close` cancels a pending poll, and a failed poll is swallowed.
 * No network: every fetch here is a stub.
 */
import { describe, expect, test } from "bun:test";
import type { Notification } from "../src/schema/index.ts";
import { MemoryMobileStore, type MobileDeviceRow } from "../src/mobile/device-store.ts";
import { createPushNotifier, memoryPushSender } from "../src/mobile/push.ts";
import {
  EXPO_RECEIPTS_URL,
  createReceiptTracker,
  expoReceiptFetcher,
  type PushReceipt,
  type ReceiptFetcher,
} from "../src/mobile/push-receipts.ts";

const GONE: PushReceipt = {
  status: "error",
  message: "gone",
  details: { error: "DeviceNotRegistered" },
};

function device(id: string, over: Partial<MobileDeviceRow> = {}): MobileDeviceRow {
  return {
    device_id: id,
    name: `FIXTURE ${id}`,
    platform: "ios",
    token_sha256: id.padEnd(64, "0"),
    created_at: "2026-10-13T11:00:00.000Z",
    last_seen_at: null,
    expo_push_token: `ExponentPushToken[FIXTURE-${id}]`,
    previews: true,
    enabled: true,
    revoked_at: null,
    fleet_id: "fxtr0001",
    ...over,
  };
}

function row(id: string): Notification {
  return {
    id,
    at: "2026-10-13T12:00:00.000Z",
    source: "chat",
    kind: "chat.error",
    class: "bad",
    title: "default on atlas could not answer",
    detail: "CHAT_TURN_FAILED",
    agent: "atlas",
    ref: "atlas/default",
    actions: [{ label: "Open chat", target: "chat", ref: "atlas/default" }],
    muted: false,
  };
}

/** A fetcher answering from `answers` and recording each call's ids. */
function fetcher(answers: Record<string, PushReceipt>): ReceiptFetcher & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = (async (ids: string[]) => {
    calls.push(ids);
    const out = new Map<string, PushReceipt>();
    for (const id of ids) {
      const a = answers[id];
      if (a !== undefined) out.set(id, a);
    }
    return out;
  }) as ReceiptFetcher & { calls: string[][] };
  Object.defineProperty(fn, "calls", { value: calls });
  return fn;
}

async function until(done: () => boolean, ms = 1_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end) await Bun.sleep(2);
}

function twoDevices(): MemoryMobileStore {
  const store = new MemoryMobileStore();
  store.insertDevice(device("a"));
  store.insertDevice(device("b"));
  return store;
}

describe("receipts through the notifier", () => {
  test("DeviceNotRegistered in a receipt clears that device's token, after the delay", async () => {
    const store = twoDevices();
    const sender = memoryPushSender((m) => ({
      status: "ok",
      id: m.to.includes("-a]") ? "tk-a" : "tk-b",
    }));
    const fetchReceipts = fetcher({ "tk-a": GONE, "tk-b": { status: "ok" } });
    const notifier = createPushNotifier({
      store,
      sender,
      isLive: () => false,
      receipts: { fetch: fetchReceipts, delayMs: 20 },
    });
    await notifier.notify({ kind: "notification", row: row("n1") });
    expect(fetchReceipts.calls).toEqual([]);
    expect(store.device("a")?.expo_push_token).not.toBeNull();
    await until(() => store.device("a")?.expo_push_token === null);
    expect(store.device("a")?.expo_push_token).toBeNull();
    expect(store.device("b")?.expo_push_token).toBe("ExponentPushToken[FIXTURE-b]");
    expect(fetchReceipts.calls).toEqual([["tk-a", "tk-b"]]);
    notifier.close();
  });

  test("another receipt error keeps the token", async () => {
    const store = twoDevices();
    const sender = memoryPushSender((m) => ({ status: "ok", id: m.to.includes("-a]") ? "x" : "y" }));
    const fetchReceipts = fetcher({
      x: { status: "error", message: "bad", details: { error: "MessageRateExceeded" } },
      y: { status: "error", message: "no details" },
    });
    const notifier = createPushNotifier({
      store,
      sender,
      isLive: () => false,
      receipts: { fetch: fetchReceipts, delayMs: 0 },
    });
    await notifier.notify({ kind: "notification", row: row("n1") });
    await until(() => fetchReceipts.calls.length > 0);
    await Bun.sleep(10);
    expect(fetchReceipts.calls).toHaveLength(1);
    expect(store.device("a")?.expo_push_token).not.toBeNull();
    expect(store.device("b")?.expo_push_token).not.toBeNull();
    notifier.close();
  });

  test("a ticket that is itself DeviceNotRegistered clears the token at once, with no poll", async () => {
    const store = twoDevices();
    const sender = memoryPushSender((m) =>
      m.to.includes("-a]") ? GONE : { status: "ok", id: "tk-b" },
    );
    const fetchReceipts = fetcher({});
    const notifier = createPushNotifier({
      store,
      sender,
      isLive: () => false,
      receipts: { fetch: fetchReceipts, delayMs: 60_000 },
    });
    await notifier.notify({ kind: "notification", row: row("n1") });
    expect(store.device("a")?.expo_push_token).toBeNull();
    expect(store.device("b")?.expo_push_token).not.toBeNull();
    expect(fetchReceipts.calls).toEqual([]);
    notifier.close();
  });

  test("a token the phone replaced since the send is not cleared", async () => {
    const store = twoDevices();
    const sender = memoryPushSender(() => ({ status: "ok", id: "tk" }));
    const fetchReceipts = fetcher({ tk: GONE });
    const notifier = createPushNotifier({
      store,
      sender,
      isLive: () => false,
      receipts: { fetch: fetchReceipts, delayMs: 20 },
    });
    await notifier.notify({ kind: "notification", row: row("n1") });
    store.setPush("a", { expo_push_token: "ExponentPushToken[FIXTURE-new]" });
    await until(() => fetchReceipts.calls.length > 0);
    await Bun.sleep(10);
    expect(store.device("a")?.expo_push_token).toBe("ExponentPushToken[FIXTURE-new]");
    expect(store.device("b")?.expo_push_token).toBeNull();
    notifier.close();
  });

  test("close cancels the pending poll", async () => {
    const store = twoDevices();
    const sender = memoryPushSender(() => ({ status: "ok", id: "tk" }));
    const fetchReceipts = fetcher({ tk: GONE });
    const notifier = createPushNotifier({
      store,
      sender,
      isLive: () => false,
      receipts: { fetch: fetchReceipts, delayMs: 20 },
    });
    await notifier.notify({ kind: "notification", row: row("n1") });
    notifier.close();
    notifier.close();
    await Bun.sleep(60);
    expect(fetchReceipts.calls).toEqual([]);
    expect(store.device("a")?.expo_push_token).not.toBeNull();
  });
});

describe("the receipt tracker", () => {
  test("asks in chunks of 1000 ids", async () => {
    const fetchReceipts = fetcher({});
    const tracker = createReceiptTracker({
      fetchReceipts,
      onUnregistered: () => {},
      delayMs: 60_000,
      cap: 5_000,
    });
    for (let i = 0; i < 2_500; i++) tracker.track(`tk-${i}`, "a", "tok");
    await tracker.flush();
    expect(fetchReceipts.calls.map((c) => c.length)).toEqual([1_000, 1_000, 500]);
    expect(fetchReceipts.calls[0]?.[0]).toBe("tk-0");
    expect(fetchReceipts.calls[2]?.at(-1)).toBe("tk-2499");
    expect(tracker.pending()).toBe(0);
    tracker.close();
  });

  test("a ticket is not asked for before it is due", async () => {
    let now = 1_000;
    const fetchReceipts = fetcher({});
    const tracker = createReceiptTracker({
      fetchReceipts,
      onUnregistered: () => {},
      delayMs: 100,
      clock: () => now,
    });
    tracker.track("early", "a", "tok");
    now += 60;
    tracker.track("late", "a", "tok");
    now += 50; // early is due (110 old), late is not (50)
    // The timer fires on real time; drive the scan through the same path.
    await until(() => fetchReceipts.calls.length > 0);
    expect(fetchReceipts.calls[0]).toEqual(["early"]);
    expect(tracker.pending()).toBe(1);
    tracker.close();
  });

  test("the pending map is bounded: the oldest ticket is dropped", async () => {
    const fetchReceipts = fetcher({});
    const tracker = createReceiptTracker({
      fetchReceipts,
      onUnregistered: () => {},
      delayMs: 60_000,
      cap: 3,
    });
    for (const id of ["t1", "t2", "t3", "t4", "t5"]) tracker.track(id, "a", "tok");
    expect(tracker.pending()).toBe(3);
    await tracker.flush();
    expect(fetchReceipts.calls).toEqual([["t3", "t4", "t5"]]);
    tracker.close();
  });

  test("a failed poll is swallowed and recorded without a token in it", async () => {
    const reasons: string[] = [];
    const unregistered: string[] = [];
    const tracker = createReceiptTracker({
      fetchReceipts: async () => {
        throw new Error("ExponentPushToken[FIXTURE-secret] unreachable");
      },
      onUnregistered: (id) => unregistered.push(id),
      delayMs: 0,
      onError: (r) => reasons.push(r),
    });
    tracker.track("tk", "a", "ExponentPushToken[FIXTURE-secret]");
    await until(() => reasons.length > 0);
    expect(reasons).toEqual(["receipt poll failed"]);
    expect(unregistered).toEqual([]);
    expect(tracker.pending()).toBe(0);
    await tracker.flush();
    tracker.close();
  });

  test("a throwing handler or recorder does not escape", async () => {
    const tracker = createReceiptTracker({
      fetchReceipts: fetcher({ tk: GONE }),
      onUnregistered: () => {
        throw new Error("store closed");
      },
      onError: () => {
        throw new Error("recorder broke");
      },
      delayMs: 0,
    });
    tracker.track("tk", "a", "tok");
    await tracker.flush();
    tracker.close();
  });

  test("close aborts a request in flight and ignores its answer", async () => {
    let signal: AbortSignal | undefined;
    const unregistered: string[] = [];
    const tracker = createReceiptTracker({
      fetchReceipts: (_ids, s) => {
        signal = s;
        return new Promise((resolve) => setTimeout(() => resolve(new Map([["tk", GONE]])), 20));
      },
      onUnregistered: (id) => unregistered.push(id),
      delayMs: 0,
    });
    tracker.track("tk", "a", "tok");
    const flushed = tracker.flush();
    await Bun.sleep(5);
    tracker.close();
    await flushed;
    expect(signal?.aborted).toBe(true);
    expect(unregistered).toEqual([]);
    tracker.track("after", "a", "tok");
    expect(tracker.pending()).toBe(0);
  });
});

describe("the Expo receipts fetcher", () => {
  test("posts the ids and maps receipts; unknown ids are absent", async () => {
    let sent: unknown;
    const fetchReceipts = expoReceiptFetcher(async (url, init) => {
      expect(url).toBe(EXPO_RECEIPTS_URL);
      expect(init?.method).toBe("POST");
      sent = JSON.parse(String(init?.body));
      return Response.json({
        data: {
          a: { status: "ok" },
          b: { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } },
        },
      });
    });
    const got = await fetchReceipts(["a", "b", "c"]);
    expect(sent).toEqual({ ids: ["a", "b", "c"] });
    expect(got.get("a")).toEqual({ status: "ok" });
    expect(got.get("b")).toEqual(GONE);
    expect(got.has("c")).toBe(false);
  });

  test("a non-2xx answer throws for the tracker to swallow", async () => {
    const fetchReceipts = expoReceiptFetcher(async () => new Response("no", { status: 503 }));
    await expect(fetchReceipts(["a"])).rejects.toThrow("503");
  });
});
