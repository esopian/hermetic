/**
 * `hermes-chat-busy.ts`: the observation's busy probe, read from upstream's
 * `session.active_list`. No network: `rpc` is a closure, and the fixture
 * client's own probe is read from its in-flight turns.
 */
import { describe, expect, test } from "bun:test";
import { BUSY_DEADLINE_MS, createBusyProbe } from "../src/chat/hermes/hermes-chat-busy.ts";
import type { BoxAddress } from "../src/chat/hermes/hermes-chat-types.ts";
import { fixtureChatClient } from "../src/backend/fixture/fixture-chat.ts";

const BOX: BoxAddress = { instance: "atlas", baseUrl: "https://atlas.example.ts.net" };

function listing(rows: unknown) {
  const calls: { method: string; params: Record<string, unknown>; deadlineMs?: number }[] = [];
  const probe = createBusyProbe({
    rpc: (_box, method, params, opts) => {
      calls.push({
        method,
        params,
        ...(opts?.deadlineMs !== undefined ? { deadlineMs: opts.deadlineMs } : {}),
      });
      return Promise.resolve(rows);
    },
  });
  return { calls, busy: probe.busy };
}

const row = (session_key: string, status: string) => ({ id: `rt-${session_key}`, session_key, status });

describe("hermes-chat · busy", () => {
  test("a listed session in a running or waiting status is busy", async () => {
    for (const status of ["working", "waiting", "streaming", "resuming"]) {
      const { busy } = listing({ sessions: [row("other", "idle"), row("durable-1", status)] });
      expect(await busy(BOX, "default", ["durable-1"])).toBe(true);
    }
  });

  test("idle is not busy, and neither is another session's turn", async () => {
    for (const status of ["idle"]) {
      const { busy } = listing({ sessions: [row("durable-1", status), row("other", "working")] });
      expect(await busy(BOX, "default", ["durable-1"])).toBe(false);
    }
  });

  test("any of the sessions counts: the pinned one or the compressed tip", async () => {
    const { busy } = listing({ sessions: [row("tip", "working")] });
    expect(await busy(BOX, "default", ["pinned", "tip"])).toBe(true);
  });

  test("starting cannot be told apart from a build with no turn, so it is null", async () => {
    const { busy } = listing({ sessions: [row("durable-1", "starting")] });
    expect(await busy(BOX, "default", ["durable-1"])).toBeNull();
    // A busy row among them still decides it.
    const both = listing({ sessions: [row("durable-1", "starting"), row("tip", "working")] });
    expect(await both.busy(BOX, "default", ["durable-1", "tip"])).toBe(true);
  });

  test("a session not live on the gateway is not busy there", async () => {
    const { busy } = listing({ sessions: [] });
    expect(await busy(BOX, "default", ["durable-1"])).toBe(false);
  });

  test("one passive request with the short deadline, and no profile", async () => {
    const { busy, calls } = listing({ sessions: [] });
    await busy(BOX, "default", ["durable-1"]);
    expect(calls).toEqual([
      { method: "session.active_list", params: {}, deadlineMs: BUSY_DEADLINE_MS },
    ]);
  });

  test("no session asks nothing and is not busy", async () => {
    const { busy, calls } = listing({ sessions: [row("durable-1", "working")] });
    expect(await busy(BOX, "default", [])).toBe(false);
    expect(calls).toEqual([]);
  });

  test("a failure, a reply without the list, or a hung lookup is null, never a throw", async () => {
    const thrown = createBusyProbe({ rpc: () => Promise.reject(new Error("Method not found")) });
    expect(await thrown.busy(BOX, "default", ["durable-1"])).toBeNull();
    const shapeless = listing({ status: "ok" });
    expect(await shapeless.busy(BOX, "default", ["durable-1"])).toBeNull();
    const hung = createBusyProbe({ rpc: () => new Promise<never>(() => {}) }, { budgetMs: 20 });
    const started = performance.now();
    expect(await hung.busy(BOX, "default", ["durable-1"])).toBeNull();
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("the fixture client is busy while its own turn is in flight there", async () => {
    const client = fixtureChatClient();
    const box: BoxAddress = { instance: "atlas", baseUrl: "fixture://atlas" };
    expect(await client.busy?.(box, "default", ["sx-busy"])).toBe(false);
    const turn = client.send(box, "default", "hello", { session: "sx-busy" })[Symbol.asyncIterator]();
    await turn.next();
    expect(await client.busy?.(box, "default", ["sx-busy"])).toBe(true);
    expect(await client.busy?.(box, "default", ["sx-other"])).toBe(false);
    await turn.return?.();
    expect(await client.busy?.(box, "default", ["sx-busy"])).toBe(false);
  });
});
