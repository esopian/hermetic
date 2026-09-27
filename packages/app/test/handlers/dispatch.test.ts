/**
 * The handlers, called with no transport at all.
 *
 * Every case here used to be written as a request: build an app, fetch a URL,
 * read a status. That shape tests two things at once and only names one of
 * them — a 428 assertion passes for a handler that confirms and for one that
 * throws the wrong code into a table that happens to map it to 428 — and none
 * of it survived the move off HTTP. So the behaviour is asserted here, against
 * `dispatch`, and the cases that were genuinely about *status codes* went with
 * the head that had them.
 *
 * `dispatch` is the whole surface: a name and a params object in, a result or
 * a thrown `HermeticError` out. That is also exactly what the RPC bridge hands
 * it, so a handler that works here works over the bridge.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  FixtureChatInjectInput,
  HermeticError,
  fleetTargetOf,
  isHermeticError,
  openHermetic,
} from "@hermetic/core";
import type { FleetTarget, Hermetic } from "@hermetic/core";
import { createChatOwner, type ChatOwner } from "../../src/chat-owner.ts";
import { inject as injectHandler } from "../../src/handlers/fixture.ts";
import { RequestValidationError, parseInput } from "../../src/validation.ts";
import type { HandlerContext } from "../../src/handlers/ctx.ts";
import { HANDLERS, dispatch } from "../../src/handlers/dispatch.ts";
import { createStreamRegistry, type StreamFrame } from "../../src/handlers/streams.ts";
import { OpRegistry } from "../../src/ops.ts";
import { AppState, fixedInstance } from "../../src/state.ts";
import { testHome } from "../home.ts";

const owners: ChatOwner[] = [];
afterAll(async () => {
  for (const owner of owners.splice(0)) await owner.stop();
});

/**
 * A context over the fixture backend, built the way the bridge builds it — same
 * `AppState`, same registry, same lazily-read instance — and nothing else.
 */
async function harness(): Promise<HandlerContext & { target: FleetTarget }> {
  const home = testHome("hermetic-handlers-");
  const hermetic = await openHermetic({ fixture: true, home });
  const state = new AppState({
    fixture: true,
    home,
    reopen: fixedInstance(hermetic),
    hermetic,
    target: hermetic.target === null ? null : fleetTargetOf(hermetic.target),
    poller: null,
  });
  const chatOwner = createChatOwner({ hermetic: () => state.hermetic });
  owners.push(chatOwner);
  const ops = new OpRegistry();
  const ctx: HandlerContext = {
    state,
    hermetic: () => state.hermetic,
    ops,
    poller: () => state.poller,
    chatOwner,
    fixture: true,
    opts: { fixture: true },
    streams: createStreamRegistry(),
  };
  const target = state.target;
  if (target === null) throw new Error("the fixture backend has a fleet; this is unreachable");
  return { ...ctx, target };
}

/** Whatever a call threw, as a value. Fails the test if it resolved instead. */
async function rejection(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
  } catch (e) {
    return e;
  }
  throw new Error("expected a refusal; the call resolved");
}

/** The code a `HermeticError` carried, or the whole throw if it was not one. */
async function codeOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (e) {
    if (isHermeticError(e)) return e.code;
    throw e;
  }
  throw new Error("expected a HermeticError; the call resolved");
}

describe("dispatch", () => {
  test("an undeclared name is refused rather than ignored", async () => {
    const ctx = await harness();
    // The mutation this guards: a table lookup that returns `undefined` and a
    // call that reads `undefined(...)`, or — worse — one that resolves with
    // `undefined` and lets a caller believe an unknown request succeeded.
    expect(await codeOf(dispatch(ctx, "agents.explode", {}))).toBe("NOT_FOUND");
    expect(await codeOf(dispatch(ctx, "", {}))).toBe("NOT_FOUND");
    // A name that is a property of `Object.prototype` is not a handler either.
    expect(await codeOf(dispatch(ctx, "constructor", {}))).toBe("NOT_FOUND");
  });

  test("a public read answers the value the route sent as JSON", async () => {
    const ctx = await harness();
    const agents = (await dispatch(ctx, "agents.list", {})) as { name: string }[];
    expect(Array.isArray(agents)).toBe(true);
    expect(agents.length).toBeGreaterThan(0);
  });

  test("machinery is dispatchable under its declared name", async () => {
    const ctx = await harness();
    const meta = (await dispatch(ctx, "meta.get", {})) as { fixture?: boolean };
    expect(meta.fixture).toBe(true);
  });

  test("a bad input is refused by core's own schema", async () => {
    const ctx = await harness();
    // `parseInput` in the handler, not `zValidator` on a route: the handler is
    // callable with raw params and must do its own validating. The refusal is
    // a `RequestValidationError` carrying the code the field's own schema
    // earns — the same object `app.ts` answers as a 400 today.
    const refusal = await rejection(dispatch(ctx, "agents.get", { name: "Not A Name" }));
    expect(refusal).toBeInstanceOf(RequestValidationError);
    expect((refusal as RequestValidationError).code).toBe("NAME_INVALID");
  });
});

describe("dispatch: confirmation", () => {
  test("a destroy without `yes` asks rather than starting an op", async () => {
    const ctx = await harness();
    const before = ctx.ops.list().ops.length;
    expect(await codeOf(dispatch(ctx, "agents.destroy", { name: "atlas", target: ctx.target }))).toBe(
      "CONFIRMATION_REQUIRED",
    );
    // The point of answering now rather than 202-then-fail: nothing started.
    expect(ctx.ops.list().ops.length).toBe(before);
  });

  test("the same destroy with `yes` starts one", async () => {
    const ctx = await harness();
    const result = (await dispatch(ctx, "agents.destroy", {
      name: "atlas",
      yes: true,
      target: ctx.target,
    })) as { op: { id: string } };
    expect(typeof result.op.id).toBe("string");
    ctx.ops.abort(result.op.id);
  });
});

describe("dispatch: the fleet a request is for (§4.7)", () => {
  test("a mutation naming another fleet is refused", async () => {
    const ctx = await harness();
    const elsewhere = { ...ctx.target, fleet_id: "wr0ngfab" };
    expect(
      await codeOf(dispatch(ctx, "agents.destroy", { name: "atlas", yes: true, target: elsewhere })),
    ).toBe("FLEET_MISMATCH");
  });

  test("a mutation naming no fleet at all is refused just as firmly", async () => {
    const ctx = await harness();
    // The hole this closes: `target` is `.optional()` in the schema so that a
    // body-less request has something to parse, and required by the guard.
    expect(await codeOf(dispatch(ctx, "agents.destroy", { name: "atlas", yes: true }))).toBe(
      "FLEET_MISMATCH",
    );
  });

  test("a read is not asked which fleet it is for", async () => {
    const ctx = await harness();
    // Deliberately unguarded: a stale read shows the wrong thing and the next
    // poll corrects it; a stale destroy deletes the wrong thing.
    await expect(dispatch(ctx, "agents.get", { name: "atlas" })).resolves.toBeDefined();
  });
});

describe("dispatch: write guards", () => {
  test("a teardown in flight refuses every mutation with CONFLICT", async () => {
    const ctx = await harness();
    ctx.state.beginTeardown("op-under-test");
    try {
      expect(await codeOf(dispatch(ctx, "agents.stop", { name: "atlas", target: ctx.target }))).toBe(
        "CONFLICT",
      );
      // …and leaves the reads an operator watches it with alone.
      await expect(dispatch(ctx, "agents.list", {})).resolves.toBeDefined();
    } finally {
      ctx.state.endTeardown();
    }
  });
});

/**
 * §4.6: the create presets are this laptop's, so the two requests carry no
 * fleet envelope, and a write is not refused while a teardown runs.
 */
describe("dispatch: create presets", () => {
  test("a write round-trips, with no target, and survives a teardown in flight", async () => {
    const ctx = await harness();
    const before = (await dispatch(ctx, "presets.get", {})) as { source: string; default: string };
    expect(before).toMatchObject({ source: "builtin", default: "standard" });

    ctx.state.beginTeardown("op-under-test");
    try {
      await dispatch(ctx, "presets.set", { default: "heavy" });
    } finally {
      ctx.state.endTeardown();
    }
    expect(await dispatch(ctx, "presets.get", {})).toMatchObject({
      source: "stored",
      default: "heavy",
    });
  });

  test("a bad write is refused by core's own schema", async () => {
    const ctx = await harness();
    // The shape, refused by the handler's `parseInput`…
    const shape = await rejection(dispatch(ctx, "presets.set", { reset: true, default: "gpu" }));
    expect(shape).toBeInstanceOf(RequestValidationError);
    expect((shape as RequestValidationError).code).toBe("VALIDATION");
    // …and a well-shaped write core's own rules refuse.
    expect(await codeOf(dispatch(ctx, "presets.set", { default: "micro" }))).toBe("VALIDATION");
  });
});

describe("dispatch: streams", () => {
  test("an open/close pair pushes frames to the sink and stops on close", async () => {
    const ctx = await harness();
    const op = ctx.ops.start("agents.probe", "atlas", async function* () {
      yield { phase: "probe", progress: 1, message: "done", at: new Date().toISOString() };
    });
    const frames: StreamFrame[] = [];
    const opened = (await dispatch(ctx, "ops.subscribe", { op_id: op.id }, (frame) => {
      frames.push(frame);
    })) as { stream_id: string };
    expect(typeof opened.stream_id).toBe("string");
    expect(ctx.streams.has(opened.stream_id)).toBe(true);

    await ctx.streams.get(opened.stream_id)?.done;
    // The op finished, so the stream ended itself and is no longer a row.
    expect(frames.some((f) => f.event === "done")).toBe(true);
    expect(ctx.streams.has(opened.stream_id)).toBe(false);

    // Closing a stream that has already ended is not an error, just `false`.
    const closed = (await dispatch(ctx, "ops.unsubscribe", {
      stream_id: opened.stream_id,
    })) as { closed: boolean };
    expect(closed.closed).toBe(false);
  });

  test("closing an open stream ends it", async () => {
    const ctx = await harness();
    const op = ctx.ops.start("agents.create", "slow", async function* (signal: AbortSignal) {
      yield { phase: "boot", progress: 0, message: "waiting", at: new Date().toISOString() };
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          resolve();
        });
      });
      throw new HermeticError("ABORTED", "aborted");
    });
    const opened = (await dispatch(ctx, "ops.subscribe", { op_id: op.id }, () => {})) as {
      stream_id: string;
    };
    const handle = ctx.streams.get(opened.stream_id);
    expect(handle).toBeDefined();
    const closed = (await dispatch(ctx, "ops.unsubscribe", {
      stream_id: opened.stream_id,
    })) as { closed: boolean };
    expect(closed.closed).toBe(true);
    // `done` never rejects, however the source ended.
    await expect(handle?.done).resolves.toBeUndefined();
    ctx.ops.abort(op.id);
  });
});

describe("dispatch: the fixture staging surface", () => {
  test("both fixture-only names are dispatchable in fixture mode", async () => {
    const ctx = await harness();
    expect(Object.keys(HANDLERS)).toContain("fixture.chat.inject");
    expect(Object.keys(HANDLERS)).toContain("fixture.chat.hint");
    await ctx.hermetic().chat.listen({ instance: "atlas", listening: true });
    await ctx.chatOwner.sync();
    await expect(
      dispatch(ctx, "fixture.chat.hint", { instance: "atlas", bot: "hermes" }),
    ).resolves.toBeDefined();
  });
});

/**
 * The second of the two guards AGENTS.md names as keeping staging out of real
 * mode. The first is that no `fixture` namespace is built outside fixture mode
 * at all; this is the one that decides what a real-mode caller is *told*.
 *
 * `hermetic.fixture` is `null` in real mode — core builds the control object
 * only on the `deps.fixture === true` branch — so there is no method to call
 * and these requests have to read as *absent*. The refusal is a thrown
 * `NOT_FOUND` from the handler rather than something a binding decided, so it
 * travels with the handler to every transport (`handlers/fixture.ts`).
 */
describe("real mode has no staging surface", () => {
  /** The real-mode shape: a working instance with its control object removed. */
  async function realContext(): Promise<HandlerContext> {
    const ctx = await harness();
    const real: Hermetic = { ...ctx.hermetic(), fixture: null };
    return { ...ctx, hermetic: () => real };
  }

  test.each(["fixture.chat.inject", "fixture.chat.hint"])("%s is absent", async (name) => {
    const ctx = await realContext();
    expect(await codeOf(dispatch(ctx, name, { instance: "atlas", markdown: "hi" }))).toBe("NOT_FOUND");
  });

  /**
   * The ordering is the assertion. `VALIDATION` here would confirm the request
   * exists and is merely unhappy with what it was sent; `NOT_FOUND` says there
   * is no such request, which is what real mode has to look like.
   */
  test("the guard fires before the params are read", async () => {
    const ctx = await realContext();
    for (const name of ["fixture.chat.inject", "fixture.chat.hint"]) {
      expect([name, await codeOf(dispatch(ctx, name, { nonsense: true }))]).toEqual([
        name,
        "NOT_FOUND",
      ]);
    }
  });

  /**
   * The mutation that proves the test above is load-bearing. Same handler over
   * the same real-mode instance, with one change: the params are validated
   * *ahead* of the guard. The request the real head answers `NOT_FOUND` is
   * answered with a schema complaint here — so the ordering the head relies on
   * is a thing a test can break, not a thing that could not have been
   * otherwise.
   */
  test("reading the params ahead of the guard changes what the caller is told", async () => {
    const ctx = await realContext();
    const mutant = async (params: unknown) => {
      parseInput(FixtureChatInjectInput, params);
      return await injectHandler(ctx, params);
    };
    const refused = (await rejection(mutant({ nonsense: true }))) as RequestValidationError;
    expect(refused).toBeInstanceOf(RequestValidationError);
    // Whatever the schema calls it, it is a complaint about the request rather
    // than "there is no such request": the surface has confirmed it is there.
    expect(refused.code).not.toBe("NOT_FOUND");
  });
});
