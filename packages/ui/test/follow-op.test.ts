/**
 * `followOp` against a fake stream: frames carry ids, a reconnect replay of an
 * already-seen id is dropped, and `done` closes the stream once.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type FakeServer, fakeServer } from "./fake-transport.ts";
import { FakeStream } from "./fake-stream.ts";

let server: FakeServer;
beforeEach(() => {
  server = fakeServer();
});
afterEach(() => {
  server.restore();
});

const frame = (phase: string) => ({
  phase,
  progress: 0.1,
  message: phase,
  at: "2026-09-02T22:17:53.000Z",
});

describe("followOp", () => {
  test("drops a replayed frame whose id it has already seen", async () => {
    const { followOp } = await import("../src/api/index.ts");
    const seen: string[] = [];
    const result: { done: [boolean, unknown] | null } = { done: null };
    followOp(
      "op-1",
      (e) => seen.push(e.phase),
      (ok, err) => {
        result.done = [ok, err];
      },
    );
    const es = FakeStream.last("ops.subscribe");
    expect(es.params).toMatchObject({ op_id: "op-1" });

    es.emit("event", frame("identity"), "0");
    es.emit("event", frame("preflight"), "1");
    // The reconnect replay the server used to send from seq 0:
    es.emit("event", frame("identity"), "0");
    es.emit("event", frame("preflight"), "1");
    es.emit("event", frame("foundation"), "2");
    expect(seen).toEqual(["identity", "preflight", "foundation"]);

    es.emit("done", { ok: true, error: null }, "3");
    expect(result.done).toEqual([true, null]);
    expect(es.closed).toBe(true);
  });

  test("frames without ids still flow (older servers)", async () => {
    const { followOp } = await import("../src/api/index.ts");
    const seen: string[] = [];
    followOp(
      "op-2",
      (e) => seen.push(e.phase),
      () => {},
    );
    const es = FakeStream.last("ops.subscribe");
    expect(es.params).toMatchObject({ op_id: "op-2" });
    es.emit("event", frame("a"));
    es.emit("event", frame("a"));
    expect(seen).toEqual(["a", "a"]);
  });
});
