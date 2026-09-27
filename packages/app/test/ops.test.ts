/**
 * The three limits that keep a long-lived portal from growing without bound.
 * Each is a number nothing exercised: an op that emitted more than
 * `MAX_BUFFERED_EVENTS`, a registry holding more than `MAX_FINISHED_OPS`, and a
 * settled op older than `FINISHED_OP_TTL_MS` are all states a laptop reaches
 * after a week of use and no test reached at all.
 *
 * The clock is injected (`now`) rather than waited on — a TTL measured in a day
 * is not a thing to sleep through, and two ops started in the same millisecond
 * are exactly the case eviction has to order correctly.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OpEvent, RecordRunInput, RunRecorder, RunTarget } from "@hermetic/core";
import {
  FINISHED_OP_TTL_MS,
  MAX_BUFFERED_EVENTS,
  MAX_FINISHED_OPS,
  OpRegistry,
  type OpMessage,
} from "../src/ops.ts";
import { openState } from "../src/state.ts";
import { testHome } from "./home.ts";

function event(n: number): OpEvent {
  return { phase: "work", progress: 0, message: `event ${n}`, at: new Date(0).toISOString() };
}

/** An op that emits `count` events and ends. */
function emitting(count: number) {
  return async function* (): AsyncGenerator<OpEvent> {
    for (let i = 0; i < count; i += 1) yield event(i);
  };
}

/** A clock the test moves by hand. */
function clock(start = Date.parse("2026-09-06T00:00:00.000Z")) {
  let at = start;
  return {
    now: () => at,
    advance(ms: number) {
      at += ms;
      return at;
    },
  };
}

describe("MAX_BUFFERED_EVENTS", () => {
  const overflow = 12;

  test("the buffer is a ring: the oldest events go, and the drop is counted", async () => {
    const ops = new OpRegistry();
    const started = ops.start("agents.create", "atlas", emitting(MAX_BUFFERED_EVENTS + overflow));
    const done = await ops.wait(started.id);

    // Every event still counted, only the buffered ones dropped.
    expect(done?.event_count).toBe(MAX_BUFFERED_EVENTS + overflow);
    expect(done?.dropped).toBe(overflow);
    expect(done?.status).toBe("ok");
  });

  test("a replay yields the surviving window, still under its absolute seq", async () => {
    const ops = new OpRegistry();
    const started = ops.start("agents.create", "atlas", emitting(MAX_BUFFERED_EVENTS + overflow));
    await ops.wait(started.id);

    const messages: OpMessage[] = [];
    for await (const m of ops.follow(started.id)) messages.push(m);

    const events = messages.filter(
      (m): m is Extract<OpMessage, { type: "event" }> => m.type === "event",
    );
    expect(events.length).toBe(MAX_BUFFERED_EVENTS);
    // Sequence numbers are absolute, so a client that saw the dropped events
    // can still tell where the window it is being handed begins.
    expect(events[0]?.seq).toBe(overflow);
    expect(events[0]?.event.message).toBe(`event ${overflow}`);
    expect(events[events.length - 1]?.seq).toBe(MAX_BUFFERED_EVENTS + overflow - 1);
    // Exactly one `done`, whatever the buffer did (the `follow` contract).
    expect(messages.filter((m) => m.type === "done").length).toBe(1);
  });

  test("an op under the cap drops nothing", async () => {
    const ops = new OpRegistry();
    const started = ops.start("agents.create", "atlas", emitting(3));
    expect((await ops.wait(started.id))?.dropped).toBe(0);
  });
});

describe("MAX_FINISHED_OPS", () => {
  test("the oldest settled ops are evicted; the newest survive", async () => {
    const time = clock();
    const ops = new OpRegistry({ now: time.now });
    const overflow = 5;
    const ids: string[] = [];
    for (let i = 0; i < MAX_FINISHED_OPS + overflow; i += 1) {
      // One millisecond apart, so "oldest" is a fact rather than a tie.
      time.advance(1);
      const started = ops.start("agents.stop", `agent-${i}`, emitting(1));
      ids.push(started.id);
      await ops.wait(started.id);
    }

    expect(ops.list({ limit: 500 }).ops.length).toBe(MAX_FINISHED_OPS);
    for (const id of ids.slice(0, overflow)) expect(ops.get(id)).toBeUndefined();
    for (const id of ids.slice(overflow)) expect(ops.get(id)).toBeDefined();
  });

  test("a running op is never evicted, however many settled ones arrive", async () => {
    const time = clock();
    const ops = new OpRegistry({ now: time.now });
    let release = (): void => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = ops.start("foundation.update", "_fleet", async function* () {
      await blocked;
      yield event(0);
    });

    for (let i = 0; i < MAX_FINISHED_OPS + 10; i += 1) {
      time.advance(1);
      await ops.wait(ops.start("agents.stop", `agent-${i}`, emitting(1)).id);
    }

    expect(ops.get(running.id)?.status).toBe("running");
    release();
    await ops.wait(running.id);
  });
});

describe("FINISHED_OP_TTL_MS", () => {
  test("a settled op older than the TTL is dropped at the next eviction", async () => {
    const time = clock();
    const ops = new OpRegistry({ now: time.now });
    const old = ops.start("agents.stop", "atlas", emitting(1));
    await ops.wait(old.id);
    expect(ops.get(old.id)).toBeDefined();

    // A day and a millisecond later, the next op to settle sweeps it.
    time.advance(FINISHED_OP_TTL_MS + 1);
    const fresh = ops.start("agents.stop", "bravo", emitting(1));
    await ops.wait(fresh.id);

    expect(ops.get(old.id)).toBeUndefined();
    expect(ops.get(fresh.id)).toBeDefined();
  });

  test("an op inside the TTL stays", async () => {
    const time = clock();
    const ops = new OpRegistry({ now: time.now });
    const old = ops.start("agents.stop", "atlas", emitting(1));
    await ops.wait(old.id);

    time.advance(FINISHED_OP_TTL_MS - 1000);
    await ops.wait(ops.start("agents.stop", "bravo", emitting(1)).id);

    expect(ops.get(old.id)).toBeDefined();
  });
});

/**
 * §4.6: every op the portal starts opens a row in the same local run log the
 * CLI writes, and that row says what the op was against.
 *
 * The portal resolved its fleet before it served a request, so unlike the CLI
 * it can write the whole target as the row is opened. What it must not do is
 * record the fleet id alone and leave the reader to assume the rest, or bind
 * the target once at construction: the registry is a `--hot` singleton that
 * outlives a fleet switch.
 */
describe("the target a run is recorded against", () => {
  const MAIN: RunTarget = {
    account_id: "123456789012",
    region: "us-west-2",
    fleet_id: "fxtr0001",
    fleet_name: "main",
  };
  const STAGING: RunTarget = { ...MAIN, fleet_id: "sg7k2m4p", fleet_name: "staging" };

  /** A recorder that keeps what it was told, and nothing else. */
  function recorder(): { rows: RecordRunInput[]; runs: RunRecorder } {
    const rows: RecordRunInput[] = [];
    return {
      rows,
      runs: {
        start: (input) => {
          rows.push(input);
          return {
            id: input.id ?? "row",
            command: input.command,
            args: input.args ?? [],
            agent: input.agent ?? null,
            started_at: input.started_at ?? new Date(0).toISOString(),
            finished_at: null,
            exit_code: null,
            log: "",
            fleet: input.fleet ?? null,
            account_id: input.account_id ?? null,
            region: input.region ?? null,
            fleet_name: input.fleet_name ?? null,
          };
        },
        annotate: () => {},
        finish: () => {},
        list: async () => [],
        close: () => {},
      },
    };
  }

  test("the whole target lands on the row, not just the fleet id", async () => {
    const { rows, runs } = recorder();
    const ops = new OpRegistry({ runs });
    ops.bindTarget(() => MAIN);
    await ops.wait(ops.start("agents.stop", "atlas", emitting(1)).id);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      command: "agents.stop",
      agent: "atlas",
      fleet: "fxtr0001",
      account_id: "123456789012",
      region: "us-west-2",
      fleet_name: "main",
    });
  });

  test("a fleet switch moves the target on the next op, not on this one", async () => {
    const { rows, runs } = recorder();
    let current: RunTarget = MAIN;
    const ops = new OpRegistry({ runs });
    ops.bindTarget(() => current);
    await ops.wait(ops.start("agents.stop", "atlas", emitting(1)).id);
    current = STAGING;
    await ops.wait(ops.start("agents.stop", "corvid", emitting(1)).id);

    expect(rows.map((r) => r.fleet)).toEqual(["fxtr0001", "sg7k2m4p"]);
    expect(rows.map((r) => r.fleet_name)).toEqual(["main", "staging"]);
  });

  test("an unbound registry records no identity rather than a guessed one", async () => {
    const { rows, runs } = recorder();
    const ops = new OpRegistry({ runs });
    await ops.wait(ops.start("init", null, emitting(1)).id);

    expect(rows[0]).toMatchObject({ fleet: null, account_id: null, region: null, fleet_name: null });
  });

  /**
   * B9: the desktop entrypoint once built its registry with no target at all,
   * so every app-started op landed in the run log with a NULL fleet and the
   * Runs view, filtering by fleet, never showed one of them.
   */
  test("the app state's run target is the open fleet's whole identity", async () => {
    const { rows, runs } = recorder();
    const state = await openState({ fixture: true, home: testHome("hermetic-runtarget-") });
    const ops = new OpRegistry({ runs, target: () => state.runTarget });
    await ops.wait(ops.start("agents.stop", "atlas", emitting(1)).id);

    expect(state.runTarget).toEqual(state.hermetic.target);
    expect(rows[0]).toMatchObject({ fleet: "fxtr0001", fleet_name: "main" });
    expect(rows[0]?.account_id).toEqual(expect.any(String));
    expect(rows[0]?.region).toEqual(expect.any(String));
  });

  test("the desktop entrypoint binds the registry to the app state's run target", () => {
    // `main/index.ts` imports the devkit and cannot be loaded outside a built
    // app, so the wiring is read as text (as `main/navigation.test.ts` does).
    const source = readFileSync(join(import.meta.dir, "..", "src", "main", "index.ts"), "utf8");
    const construction = /new OpRegistry\(\{[\s\S]*?\}\);/.exec(source)?.[0] ?? "";
    expect(construction).toContain("target: () => state.runTarget");
  });
});

/**
 * The op stream across a restart (§4.6).
 *
 * A resumed op keeps its id — that is what lets a reader reattach to the run it
 * was watching — but it is a new attempt, and its events are numbered from zero
 * again. The cursor the reader kept from before the restart is therefore ahead
 * of everything the new attempt will ever send, `done` included. Left alone,
 * that is a window watching keepalives for ever over a backend that finished
 * minutes ago, and it is why frames carry the attempt they belong to.
 *
 * Both cases are `follow` and nothing else: the cursor is the registry's
 * decision, and every transport that has ever carried one has asked this
 * function to make it.
 */
describe("a resumed op's stream", () => {
  /** What the pre-crash attempt left the reader holding: a cursor well ahead. */
  const STALE_SEQ = 9;

  test("a stale cursor from a previous attempt still delivers done", async () => {
    const ops = new OpRegistry();
    // The attempt after the restart: same id, second generation, counting its
    // own events from zero.
    const resumed = ops.start("agents.create", "atlas", emitting(2), {
      resumedId: "op-resumed",
      generation: 1,
    });
    await ops.wait(resumed.id);

    const messages: OpMessage[] = [];
    for await (const m of ops.follow(resumed.id, undefined, {
      after: STALE_SEQ,
      generation: 0,
    })) {
      messages.push(m);
    }

    // The cursor belonged to an attempt that no longer exists, so this attempt
    // is replayed whole rather than skipped past.
    expect(messages.map((m) => m.type)).toEqual(["event", "event", "done"]);
    expect(messages.filter((m) => m.type === "done")).toHaveLength(1);
  });

  test("a cursor from this attempt still never suppresses the end of the stream", async () => {
    const ops = new OpRegistry({ keepaliveMs: 50 });
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = ops.start(
      "agents.create",
      "atlas",
      async function* (): AsyncGenerator<OpEvent> {
        yield event(0);
        await blocked;
      },
      { resumedId: "op-running", generation: 1 },
    );

    const messages: OpMessage[] = [];
    const reading = (async () => {
      for await (const m of ops.follow(running.id, undefined, {
        after: STALE_SEQ,
        generation: 1,
      })) {
        messages.push(m);
        if (m.type === "done") return;
      }
    })();
    release();
    await reading;

    // Nothing else got through the cursor, and that is fine — what must not
    // happen is the op ending without the reader being told.
    expect(messages.filter((m) => m.type === "done")).toHaveLength(1);
  });
});
