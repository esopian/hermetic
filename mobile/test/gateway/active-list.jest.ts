import { HermeticError, type HermesChatClient } from "@hermetic/core/chat-client";
import { isRunning, liveRowOf, liveStatusOf } from "../../src/gateway/active-list.ts";
import { createGatewayTransport } from "../../src/gateway/transport.ts";

const NOW = "2026-10-13T10:00:00.000Z";

describe("liveStatusOf", () => {
  const answer = {
    sessions: [
      { id: "live-1", session_key: "s-1", status: "working", message_count: 3 },
      { id: "s-2", status: "waiting", message_count: 1 },
      { id: "live-3", session_key: "s-3", status: "compacting", message_count: 1 },
      null,
      "junk",
    ],
  };

  test("matches a row on session_key or on its live id", () => {
    expect(liveStatusOf(answer, "s-1")).toBe("working");
    expect(liveStatusOf(answer, "live-1")).toBe("working");
    expect(liveStatusOf(answer, "s-2")).toBe("waiting");
  });

  test("a known live id wins over a stored key a compaction rotated, and the row names it", () => {
    const rotated = { sessions: [{ id: "live-1", session_key: "s-1b", status: "working" }] };
    expect(liveStatusOf(rotated, "s-1")).toBeNull();
    expect(liveStatusOf(rotated, "s-1", "live-1")).toBe("working");
    expect(liveRowOf(answer, "s-1")).toEqual({ status: "working", id: "live-1", session_key: "s-1" });
    // Matched on the live id, the row names the rotated key the gateway resolves now.
    expect(liveRowOf(rotated, "s-1", "live-1")).toEqual({
      status: "working",
      id: "live-1",
      session_key: "s-1b",
    });
    // A live id that is not listed falls back to the stored key.
    expect(liveRowOf(answer, "s-2", "gone")).toEqual({
      status: "waiting",
      id: "s-2",
      session_key: null,
    });
  });

  test("a session not listed is null; an unknown status is not running", () => {
    expect(liveStatusOf(answer, "s-9")).toBeNull();
    expect(liveStatusOf(answer, "s-3")).toBe("idle");
    expect(isRunning(liveStatusOf(answer, "s-3") ?? null)).toBe(false);
  });

  test("an answer that is not a session list is undefined", () => {
    expect(liveStatusOf(null, "s-1")).toBeUndefined();
    expect(liveStatusOf({ sessions: "x" }, "s-1")).toBeUndefined();
  });

  test("only waiting, starting and working are running", () => {
    expect(["waiting", "starting", "working"].every((s) => isRunning(s as never))).toBe(true);
    expect(isRunning("idle")).toBe(false);
    expect(isRunning(null)).toBe(false);
  });
});

describe("transport.liveStatus", () => {
  function transport(client: Partial<HermesChatClient>) {
    return createGatewayTransport({
      client: { token: async () => "FIXTURE", ...client } as HermesChatClient,
      address: (instance) => ({
        instance,
        baseUrl: `https://fxtr0001-${instance}.hermetic.ts.net/`,
        fleet_id: "fxtr0001",
      }),
      listening: () => ["atlas"],
      setListening: () => ["atlas"],
      turns: () => ({ frame: () => {}, end: () => {}, gone: () => {} }),
      now: () => NOW,
    });
  }

  test("asks the box's session.active_list with the caller's signal", async () => {
    const calls: { url: string; method: string; signal: AbortSignal | undefined }[] = [];
    const t = transport({
      botModeRpc: async (box, method, _params, opts) => {
        calls.push({ url: box.baseUrl, method, signal: opts?.signal });
        return { sessions: [{ id: "x", session_key: "s-1", status: "starting", message_count: 0 }] };
      },
    });
    const signal = new AbortController().signal;
    expect(await t.liveStatus({ instance: "atlas", session: "s-1", signal })).toEqual({
      status: "starting",
      id: "x",
      session_key: "s-1",
    });
    expect(await t.liveStatus({ instance: "atlas", session: "s-9", runtime: "x" })).toEqual({
      status: "starting",
      id: "x",
      session_key: "s-1",
    });
    expect(await t.liveStatus({ instance: "atlas", session: "s-2" })).toBeNull();
    expect(calls[0]).toEqual({
      url: "https://fxtr0001-atlas.hermetic.ts.net/",
      method: "session.active_list",
      signal,
    });
  });

  test("no Bot Mode RPC, or no session list, is an error, never a guess", async () => {
    await expect(transport({}).liveStatus({ instance: "atlas", session: "s-1" })).rejects.toThrow(
      HermeticError,
    );
    await expect(
      transport({ botModeRpc: async () => ({ ok: true }) }).liveStatus({
        instance: "atlas",
        session: "s-1",
      }),
    ).rejects.toThrow("without a session list");
  });
});
