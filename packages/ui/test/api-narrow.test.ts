import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { FakeStream, fakeServer } from "./fake-transport.ts";
import {
  ApiError,
  abortTurn,
  apiErrorOf,
  fleetTarget,
  isError,
  sameFleetTarget,
  sendTurn,
  setFleetTarget,
  targetOf,
} from "../src/api/index.ts";
import type { FleetTarget, Meta } from "../src/api/index.ts";

/**
 * The fleet target, borrowed and given back.
 *
 * This file is the one that tests what a window does when it does *not* know
 * its fleet, so it is the one that sets the target to null — and the target is
 * module state in `src/api/client.ts`, which `bun test` shares with every
 * other file of the run. Left null, it was null for whatever file happened to
 * be evaluated after this one, which is filesystem readdir order: twenty-eight
 * chat tests refused their reads with "this window does not know which fleet
 * it is showing" on Linux and none of them on macOS. Captured and restored per
 * test rather than at the two call sites, so no case added later can leak one
 * by forgetting.
 */
let priorTarget: FleetTarget | null = null;
beforeEach(() => {
  priorTarget = fleetTarget();
});
afterEach(() => {
  setFleetTarget(priorTarget);
});

/**
 * The unwrap every caller sees, as one function.
 *
 * The transport decides *that* a body is a refusal and throws the `ApiError`
 * (`fake-transport.ts` does the same, which is what makes a faked refusal the
 * real one). What is under test here is the pair that decides it — the shape
 * test and the translation — so they are driven directly rather than through a
 * transport that would only be in the way.
 */
function unwrap(body: unknown): unknown {
  if (isError(body)) throw apiErrorOf(body);
  return body;
}

describe("isError", () => {
  test("true for a { error } body", () => {
    expect(isError({ error: { code: "NOT_FOUND", message: "no such agent" } })).toBe(true);
  });

  test("true for a zod-validator failure shape (also just an object with an error key)", () => {
    expect(isError({ error: { code: "VALIDATION", message: "invalid body", issues: [] } })).toBe(true);
  });

  test("false for a plain success body, arrays, primitives, and null", () => {
    expect(isError({ name: "atlas" })).toBe(false);
    expect(isError([1, 2, 3])).toBe(false);
    expect(isError("ok")).toBe(false);
    expect(isError(null)).toBe(false);
    expect(isError(undefined)).toBe(false);
  });
});

describe("unwrap", () => {
  test("answers with the body when it is not error-shaped", () => {
    expect(unwrap({ name: "atlas", display_status: "ready" })).toEqual({
      name: "atlas",
      display_status: "ready",
    });
  });

  test("answers with array bodies unchanged", () => {
    expect(unwrap([{ name: "atlas" }])).toEqual([{ name: "atlas" }]);
  });

  test("throws ApiError carrying code and message for an { error } body", () => {
    try {
      unwrap({ error: { code: "NOT_FOUND", message: "no such agent" } });
      throw new Error("expected unwrap() to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).code).toBe("NOT_FOUND");
      expect((e as ApiError).message).toBe("no such agent");
    }
  });

  test("throws ApiError for a schema failure shape too, not just hand-thrown errors", () => {
    expect(() =>
      unwrap({
        error: { code: "VALIDATION", message: "invalid body", issues: [{ path: ["name"] }] },
      }),
    ).toThrowError(expect.objectContaining({ code: "VALIDATION", message: "invalid body" }));
  });
});

/**
 * §fix-first 7: `init` refuses with the running op's id *beside* the error
 * object (`init-op.ts`'s `InitInFlightError`), and the unwrap used to drop it —
 * so a reloaded wizard was told "Init failed" about an op that was still
 * building the foundation, and the obvious next move was to start a second one.
 */
describe("ApiError: what the error body carried alongside the code", () => {
  test("a refusal that names the running op keeps its id", () => {
    try {
      unwrap({
        error: { code: "CONFLICT", message: "an init op is already running (op-7)" },
        op_id: "op-7",
      });
      throw new Error("expected unwrap() to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).code).toBe("CONFLICT");
      expect((e as ApiError).opId).toBe("op-7");
    }
  });

  /**
   * The server sends `op_id: null` when the slot is claimed but no op has an id
   * yet ("an init op is starting; try again shortly"). There is nothing to
   * follow, so this must stay a plain failure.
   */
  test("a conflict with no op to follow reports no op", () => {
    for (const body of [
      { error: { code: "CONFLICT", message: "starting" }, op_id: null },
      { error: { code: "CONFLICT", message: "starting" } },
    ]) {
      try {
        unwrap(body);
        throw new Error("expected unwrap() to throw");
      } catch (e) {
        expect((e as ApiError).opId).toBeNull();
      }
    }
  });

  test("validator details ride along instead of being thrown away", () => {
    try {
      unwrap({
        error: {
          code: "VALIDATION",
          message: "invalid body",
          details: { issues: [{ path: ["name"] }] },
        },
      });
      throw new Error("expected unwrap() to throw");
    } catch (e) {
      expect((e as ApiError).details).toEqual({ issues: [{ path: ["name"] }] });
    }
  });

  test("an ordinary error has neither, and says so with null rather than undefined", () => {
    try {
      unwrap({ error: { code: "NOT_FOUND", message: "no such agent" } });
      throw new Error("expected unwrap() to throw");
    } catch (e) {
      expect((e as ApiError).opId).toBeNull();
      expect((e as ApiError).details).toBeNull();
    }
  });
});

test("abortTurn names the optional durable session, and only when there is one", async () => {
  const server = fakeServer({
    "chat.abort": { instance: "atlas", bot: "research", aborted: false },
  });
  // §4.7: an abort is a mutation, so it names the fleet it is for — which this
  // window only has once `setFleetTarget` has been told one.
  const TARGET = { account_id: "123456789012", region: "us-west-2", fleet_id: "m4in0abc" };
  setFleetTarget(TARGET);
  try {
    expect(await abortTurn("atlas", "research", "durable/id")).toMatchObject({ aborted: false });
    // The conversation is named by the parameters, and the optional durable
    // session is present only when the caller gave one.
    expect(server.calls[0]?.params).toEqual({
      instance: "atlas",
      bot: "research",
      session: "durable/id",
      target: TARGET,
    });
    await abortTurn("atlas", "research");
    expect(server.calls[1]?.params).toEqual({
      instance: "atlas",
      bot: "research",
      target: TARGET,
    });
  } finally {
    setFleetTarget(null);
    server.restore();
  }
});

/**
 * §4.7: the triple a mutation names, read off the one document that asserts it.
 *
 * `targetOf` used to take the account and the region from `meta.config` and the
 * `fleet_id` from `meta.fleet`, which is a triple no `meta.get` ever stated: if
 * the two halves disagreed the result named a fleet id in another fleet's
 * account, and every request this window sent would have claimed it. The two
 * agree by construction in the head, which is why a contradiction is worth
 * refusing rather than splicing.
 */
describe("targetOf", () => {
  function meta(over: Partial<Meta> = {}): Meta {
    return {
      header: "▸ main",
      config: {
        name: "main",
        fleet_id: "m4in0abc",
        account_id: "123456789012",
        region: "us-west-2",
      },
      fleet: { id: "m4in0abc", alias: "main", default: null, directory_region: null },
      fixture: true,
      hermes_version: null,
      hermeticd_version: null,
      tailnet: null,
      last_teardown: null,
      ...over,
    } as Meta;
  }

  test("all three fields come from the config the head answered with", () => {
    expect(targetOf(meta())).toEqual({
      account_id: "123456789012",
      region: "us-west-2",
      fleet_id: "m4in0abc",
    });
  });

  test("null before init, when there is no config and nothing to name", () => {
    expect(targetOf(meta({ config: null }))).toBeNull();
  });

  test("a body missing the multi-fleet key still names the fleet its config does", () => {
    const { fleet: _fleet, ...older } = meta();
    expect(targetOf(older as Meta)?.fleet_id).toBe("m4in0abc");
  });

  test("a body that contradicts itself names no fleet at all", () => {
    const split = meta({
      fleet: { id: "sg7k2m4p", alias: "staging", default: null, directory_region: null },
    });
    // Not `{123456789012, us-west-2, sg7k2m4p}` — a triple neither half said.
    expect(targetOf(split)).toBeNull();
  });
});

describe("sameFleetTarget", () => {
  const target = { account_id: "123456789012", region: "us-west-2", fleet_id: "m4in0abc" };

  test("all three fields, not the fleet id alone", () => {
    expect(sameFleetTarget(target, { ...target })).toBe(true);
    // The same eight characters can be minted in two accounts.
    expect(sameFleetTarget(target, { ...target, account_id: "999999999999" })).toBe(false);
    expect(sameFleetTarget(target, { ...target, region: "eu-west-1" })).toBe(false);
    expect(sameFleetTarget(target, { ...target, fleet_id: "sg7k2m4p" })).toBe(false);
  });

  test("a null on either side is never a match, not even two of them", () => {
    // Core answers the same: two targets that name nothing have not been shown
    // to name the same thing (`tests/fleet-target-mirror.test.ts`).
    expect(sameFleetTarget(null, null)).toBe(false);
    expect(sameFleetTarget(target, null)).toBe(false);
    expect(sameFleetTarget(null, target)).toBe(false);
  });
});

/**
 * A turn, read above the transport.
 *
 * `transport-rpc.test.ts` holds the carriage — the open request, the pushes it
 * routes, the close — because that is the transport's. What is asserted here is
 * the protocol on top of it: which frames reach the consumer, in what order,
 * and that the turn ends once.
 */
describe("sendTurn", () => {
  test("frames reach the consumer in order and the turn ends once", () => {
    const server = fakeServer();
    const frames: string[] = [];
    const ends: boolean[] = [];
    try {
      sendTurn("atlas", "main", "hello", {
        onFrame: (frame) => frames.push(frame.type),
        onEnd: (ok) => ends.push(ok),
      });
      const turn = FakeStream.last("chat.turn");
      expect(turn.params).toMatchObject({ instance: "atlas", bot: "main", message: "hello" });
      turn.emit("block", { type: "block" });
      turn.emit("delta", { type: "delta" });
      // A frame the transport could not decode is skipped rather than
      // dispatched as nothing: `data` is `undefined` and only `undefined` there.
      turn.emit("delta", undefined);
      // An event this client does not know is not a frame either.
      turn.emit("heartbeat", { type: "heartbeat" });
      turn.emit("done", { type: "done" });
      turn.end(true, null);
      expect(frames).toEqual(["block", "delta", "done"]);
      expect(ends).toEqual([true]);
    } finally {
      server.restore();
    }
  });

  test("a window that does not know its fleet refuses the turn instead of sending it", async () => {
    const server = fakeServer();
    setFleetTarget(null);
    const ends: { code: string }[] = [];
    try {
      sendTurn("atlas", "main", "hello", {
        onFrame: () => {},
        onEnd: (_ok, error) => {
          if (error) ends.push(error);
        },
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(ends.map((e) => e.code)).toEqual(["NO_TARGET"]);
      // Nothing was opened: the refusal happens before the transport is asked.
      expect(FakeStream.all("chat.turn")).toEqual([]);
    } finally {
      server.restore();
    }
  });
});
