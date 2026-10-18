/**
 * `shared/expo-push.ts`: batching, the ticket and receipt parse, and the rule
 * that a send never throws. A recorded `fetch` double stands in for exp.host.
 */
import { describe, expect, test } from "bun:test";
import {
  EXPO_PUSH_BATCH,
  EXPO_PUSH_URL,
  EXPO_RECEIPTS_BATCH,
  EXPO_RECEIPTS_URL,
  chunk,
  expoPushSender,
  expoReceiptFetcher,
  isDeviceNotRegistered,
  receiptOf,
  type ExpoFetch,
  type ExpoPushMessage,
} from "../src/shared/index.ts";

const TOKEN = "ExponentPushToken[FIXTURE-expo-push-1]";

function message(i: number): ExpoPushMessage {
  return { to: TOKEN, title: `bot ${i}`, data: { i } };
}

interface Call {
  url: string;
  body: unknown;
}

function recorder(answer: (call: Call, n: number) => Response | Promise<Response>): {
  fetch: ExpoFetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      const call = { url, body: JSON.parse(String(init?.body)) };
      calls.push(call);
      return answer(call, calls.length);
    },
  };
}

describe("chunk", () => {
  test("splits in order, last run short", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 100)).toEqual([]);
    expect(chunk([1, 2], 0)).toEqual([[1], [2]]);
  });
});

describe("receiptOf", () => {
  test("ok with and without an id", () => {
    expect(receiptOf({ status: "ok", id: "t1" })).toEqual({ status: "ok", id: "t1" });
    expect(receiptOf({ status: "ok" })).toEqual({ status: "ok" });
  });

  test("an error keeps its message and its details.error", () => {
    const r = receiptOf({
      status: "error",
      message: "gone",
      details: { error: "DeviceNotRegistered" },
    });
    expect(r).toEqual({ status: "error", message: "gone", details: { error: "DeviceNotRegistered" } });
    expect(isDeviceNotRegistered(r)).toBe(true);
  });

  test("anything unrecognisable is an error ticket", () => {
    expect(receiptOf(null).status).toBe("error");
    expect(receiptOf("x").status).toBe("error");
    expect(receiptOf({ status: "weird" })).toEqual({ status: "error", message: "push refused" });
    expect(isDeviceNotRegistered(receiptOf({ status: "error", message: "m" }))).toBe(false);
    expect(isDeviceNotRegistered(undefined)).toBe(false);
  });
});

describe("expoPushSender", () => {
  test("posts batches of 100 to the send endpoint, one ticket per message in order", async () => {
    const { fetch, calls } = recorder((call) => {
      const batch = call.body as ExpoPushMessage[];
      return Response.json({
        data: batch.map((m) => ({ status: "ok", id: `id-${String(m.data["i"])}` })),
      });
    });
    const tickets = await expoPushSender(fetch)(Array.from({ length: 250 }, (_, i) => message(i)));
    expect(calls.map((c) => (c.body as unknown[]).length)).toEqual([
      EXPO_PUSH_BATCH,
      EXPO_PUSH_BATCH,
      50,
    ]);
    expect(calls.every((c) => c.url === EXPO_PUSH_URL)).toBe(true);
    expect(tickets).toHaveLength(250);
    expect(tickets[0]).toEqual({ status: "ok", id: "id-0" });
    expect(tickets[249]).toEqual({ status: "ok", id: "id-249" });
  });

  test("never throws: a failed batch is one error ticket per message", async () => {
    const { fetch } = recorder((_call, n) => {
      if (n === 1) throw new Error("network down");
      if (n === 2) return new Response("nope", { status: 502 });
      return Response.json({ data: [{ status: "ok", id: "late" }] });
    });
    const tickets = await expoPushSender(fetch)(Array.from({ length: 201 }, (_, i) => message(i)));
    expect(tickets).toHaveLength(201);
    expect(tickets[0]).toEqual({ status: "error", message: "push service unreachable" });
    expect(tickets[100]).toEqual({ status: "error", message: "push service answered 502" });
    expect(tickets[200]).toEqual({ status: "ok", id: "late" });
  });

  test("a short data array pads with error tickets rather than shifting", async () => {
    const { fetch } = recorder(() => Response.json({ data: [{ status: "ok", id: "a" }] }));
    const tickets = await expoPushSender(fetch)([message(0), message(1)]);
    expect(tickets[0]).toEqual({ status: "ok", id: "a" });
    expect(tickets[1]?.status).toBe("error");
  });
});

describe("expoReceiptFetcher", () => {
  test("asks in chunks of 1000 and returns only the ids Expo knows", async () => {
    const { fetch, calls } = recorder((call) => {
      const ids = (call.body as { ids: string[] }).ids;
      const data: Record<string, unknown> = {};
      for (const id of ids.slice(0, 2)) data[id] = { status: "ok" };
      data[ids[2] ?? "x"] = {
        status: "error",
        message: "m",
        details: { error: "DeviceNotRegistered" },
      };
      return Response.json({ data });
    });
    const ids = Array.from({ length: 1001 }, (_, i) => `t${i}`);
    const out = await expoReceiptFetcher(fetch)(ids);
    expect(calls.map((c) => (c.body as { ids: string[] }).ids.length)).toEqual([
      EXPO_RECEIPTS_BATCH,
      1,
    ]);
    expect(calls.every((c) => c.url === EXPO_RECEIPTS_URL)).toBe(true);
    expect(out.get("t0")).toEqual({ status: "ok" });
    expect(isDeviceNotRegistered(out.get("t2"))).toBe(true);
    expect(out.has("t3")).toBe(false);
  });

  test("a refused batch leaves its ids unresolved rather than throwing", async () => {
    const { fetch } = recorder(() => new Response("", { status: 500 }));
    const receipts = await expoReceiptFetcher(fetch)(["t1"]);
    expect(receipts.size).toBe(0);
  });
});
