/**
 * The client half of the op stream across a restart.
 *
 * `followOp` drops frames it has already seen, which is right for a reconnect
 * replay and wrong for a *resume*: the server picks the op up again under the
 * same id and numbers the new attempt's events from zero, so a cursor kept from
 * before the restart is ahead of every frame of it. Frames say which attempt
 * they belong to, and a later attempt starts the count again.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeFrameFilter } from "../src/api/index.ts";
import { FakeStream } from "./fake-stream.ts";
import { type FakeServer, fakeServer } from "./fake-transport.ts";

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
  at: "2026-09-16T12:00:00.000Z",
});

describe("the frame filter", () => {
  test("a later generation restarts the sequence rather than filtering it out", () => {
    const fresh = makeFrameFilter();
    expect(fresh("0:0")).toBe(true);
    expect(fresh("0:1")).toBe(true);
    // The replay a reconnect brings with it: still dropped.
    expect(fresh("0:1")).toBe(false);
    // The resumed attempt, counting from zero again.
    expect(fresh("1:0")).toBe(true);
    expect(fresh("1:1")).toBe(true);
    // And a straggler from the attempt before it is not mistaken for new.
    expect(fresh("0:9")).toBe(false);
  });

  test("a frame with no id at all flows (an older server)", () => {
    const fresh = makeFrameFilter();
    expect(fresh("")).toBe(true);
    expect(fresh("")).toBe(true);
  });
});

describe("followOp", () => {
  test("a resumed stream with a stale cursor still delivers done", async () => {
    const { followOp } = await import("../src/api/index.ts");
    const seen: string[] = [];
    const result: { done: [boolean, unknown] | null } = { done: null };
    followOp(
      "op-1",
      (e) => seen.push(e.phase),
      (ok, error) => {
        result.done = [ok, error];
      },
    );
    const es = FakeStream.last("ops.subscribe");
    expect(es.params).toMatchObject({ op_id: "op-1" });

    // What the tab saw before the portal restarted.
    es.emit("event", frame("identity"), "0:0");
    es.emit("event", frame("preflight"), "0:1");
    // …and what the resumed attempt sends, under the same op id, from zero.
    es.emit("event", frame("instance"), "1:0");
    es.emit("event", frame("attach"), "1:1");
    expect(seen).toEqual(["identity", "preflight", "instance", "attach"]);

    // The frame the whole stream exists to deliver, at a sequence number the
    // pre-restart cursor is ahead of.
    es.emit("done", { ok: true, error: null }, "1:2");
    expect(result.done).toEqual([true, null]);
    expect(es.closed).toBe(true);
  });
});
