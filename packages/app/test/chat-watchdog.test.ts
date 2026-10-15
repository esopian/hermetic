/**
 * The chat coverage watchdog (`src/chat-watchdog.ts`).
 *
 * The owner is a double here: what is asserted is which of its three levers
 * the watchdog pulls, how often, and when it pulls none — coalescing, backoff,
 * the reachability gate, and a stop that leaves nothing armed. The clock and
 * every timer are fake, so ten minutes of backoff costs nothing; the seam with
 * the real owner and a real poller is in `chat-owner.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import type { AgentView, Swarm } from "@hermetic/core";
import type { ChatConversationRef, ChatObserveTarget, ChatOwnedHealth } from "../src/chat-owner.ts";
import {
  CHAT_RESYNC_DEBOUNCE_MS,
  CHAT_WATCHDOG_BACKOFF_BASE_MS,
  CHAT_WATCHDOG_BACKOFF_MAX_MS,
  CHAT_WATCHDOG_HEALTHY_RESET_MS,
  CHAT_WATCHDOG_INTERVAL_MS,
  CHAT_WATCHDOG_STALE_MS,
  createChatWatchdog,
  type ChatWatchdogOwner,
} from "../src/chat-watchdog.ts";
import { memoryLog } from "../src/log.ts";

/* ── a fake clock that owns every timer ──────────────────────────────────── */

/** One macrotask: every promise chain the last timer started has run. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function fakeClock(start = 1_000_000) {
  let t = start;
  const timers: { at: number; run: () => void; live: boolean }[] = [];
  return {
    now: () => t,
    schedule(run: () => void, ms: number): () => void {
      const timer = { at: t + ms, run, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    armed: (): number => timers.filter((timer) => timer.live).length,
    /** Move the clock, firing each timer that comes due, in order, and letting it settle. */
    async advance(ms: number): Promise<void> {
      const end = t + ms;
      for (;;) {
        const next = timers
          .filter((timer) => timer.live && timer.at <= end)
          .sort((a, b) => a.at - b.at)[0];
        if (next === undefined) break;
        t = next.at;
        next.live = false;
        next.run();
        await flush();
        await flush();
      }
      t = end;
      await flush();
    },
  };
}

/* ── the owner double ─────────────────────────────────────────────────────── */

const ref = (instance: string, bot: string, session: string | null = null): ChatConversationRef => ({
  instance,
  bot,
  session,
});

function fakeOwner() {
  const state = {
    owned: [] as ChatConversationRef[],
    failed: [] as ChatConversationRef[],
    health: [] as ChatOwnedHealth[],
    epoch: 0,
    syncs: 0,
    resumes: [] as ChatObserveTarget[],
    restarts: [] as ChatObserveTarget[],
    /** Holds every sync open until released, to test a sync in flight. */
    gate: null as Promise<void> | null,
  };
  const owner: ChatWatchdogOwner = {
    async sync() {
      state.syncs += 1;
      if (state.gate !== null) await state.gate;
    },
    owned: () => state.owned,
    failed: () => state.failed,
    health: () => state.health,
    epoch: () => state.epoch,
    resume(target) {
      state.resumes.push(target);
      return Promise.resolve({
        instance: target.instance,
        bot: target.bot,
        session: target.session ?? null,
        observing: true,
        restarted: true,
        listening: true,
      });
    },
    restart(target) {
      state.restarts.push(target);
      return Promise.resolve(true);
    },
  };
  return { state, owner };
}

type Status = AgentView["display_status"];

function harness(options: { listening?: string[]; agents?: Record<string, Status> | null } = {}) {
  const clock = fakeClock();
  const { state, owner } = fakeOwner();
  const world = {
    listening: options.listening ?? ["atlas"],
    agents: options.agents === undefined ? { atlas: "ready" as Status } : options.agents,
    /** Holds every listening read open until released. */
    block: null as Promise<void> | null,
  };
  const log = memoryLog();
  const watchdog = createChatWatchdog({
    owner,
    listening: () => (world.block ?? Promise.resolve()).then(() => world.listening),
    agents: () =>
      world.agents === null
        ? null
        : Object.entries(world.agents).map(([name, display_status]) => ({ name, display_status })),
    log,
    now: clock.now,
    schedule: (run, ms) => clock.schedule(run, ms),
  });
  return { clock, state, owner, world, watchdog, log };
}

function swarm(instance: string, bots: string[], reachable = true): Swarm {
  return {
    instance,
    reachable,
    bots: bots.map((name) => ({
      instance,
      name,
      title: name,
      is_default: name === "default",
      avatar_seed: `fixture/${instance}/${name}`,
      unread: 0,
      needs_action: false,
      muted: false,
      warm: false,
    })),
    rooms: [],
    warm_slots: { used: 0, total: 3 },
    sections: [],
  };
}

const healthy = (r: ChatConversationRef): ChatOwnedHealth => ({
  ref: r,
  pinned: true,
  session: `${r.bot}-canonical`,
  health: null,
  healthSince: null,
});

/* ── tests ────────────────────────────────────────────────────────────────── */

describe("re-sync triggers", () => {
  test("a reachable listened box with nothing held gets one sync, after the debounce", async () => {
    const { clock, state, watchdog } = harness();
    await watchdog.tick();
    expect(state.syncs).toBe(0);
    await clock.advance(CHAT_RESYNC_DEBOUNCE_MS);
    expect(state.syncs).toBe(1);
    expect(watchdog.status()).toMatchObject({ ticks: 1, syncs: 1 });
  });

  test("a box that is fully held asks for nothing", async () => {
    const { clock, state, watchdog } = harness();
    state.owned = [ref("atlas", "default")];
    state.health = [healthy(ref("atlas", "default"))];
    await watchdog.roster([swarm("atlas", ["default"])]);
    await watchdog.tick();
    await clock.advance(CHAT_RESYNC_DEBOUNCE_MS * 2);
    expect(state.syncs).toBe(0);
    expect(state.resumes).toEqual([]);
  });

  test("a roster bot neither held nor failed asks for a sync; a failed one does not", async () => {
    const { clock, state, watchdog } = harness();
    state.owned = [ref("atlas", "default")];
    state.failed = [ref("atlas", "scout")];
    await watchdog.roster([swarm("atlas", ["default", "scout"])]);
    await clock.advance(CHAT_RESYNC_DEBOUNCE_MS);
    expect(state.syncs).toBe(0);

    await watchdog.roster([swarm("atlas", ["default", "scout", "wren"])]);
    await clock.advance(CHAT_RESYNC_DEBOUNCE_MS);
    expect(state.syncs).toBe(1);
  });

  test("a roster for a box nobody listens to, or one that did not answer, is ignored", async () => {
    const { clock, state, watchdog } = harness({ listening: ["atlas"] });
    state.owned = [ref("atlas", "default")];
    await watchdog.roster([swarm("birch", ["default"]), swarm("atlas", ["default", "scout"], false)]);
    await clock.advance(CHAT_RESYNC_DEBOUNCE_MS);
    expect(state.syncs).toBe(0);
  });

  test("a burst — eleven boxes up in one scan, the roster, a tick — is one sync", async () => {
    const names = Array.from({ length: 11 }, (_, i) => `box${String(i).padStart(2, "0")}`);
    const agents = Object.fromEntries(names.map((name) => [name, "ready" as Status]));
    const { clock, state, watchdog } = harness({ listening: names, agents });
    await watchdog.reachable(names);
    await watchdog.roster(names.map((name) => swarm(name, ["default"])));
    await watchdog.tick();
    await clock.advance(CHAT_RESYNC_DEBOUNCE_MS);
    expect(state.syncs).toBe(1);
    // The roster and the tick left the pending sync to answer them: no box
    // spent a backoff attempt on a gap that sync was about to close.
    expect(watchdog.status().backoff).toEqual([]);
  });

  test("a roster gap seen while a sync runs, and closed by it, buys no second sync", async () => {
    const { clock, state, watchdog } = harness();
    let release: () => void = () => {};
    state.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await watchdog.reachable(["atlas"]);
    await clock.advance(CHAT_RESYNC_DEBOUNCE_MS);
    expect(state.syncs).toBe(1);

    // The poller's roster lands mid-sync; the sync pins both bots.
    await watchdog.roster([swarm("atlas", ["default", "scout"])]);
    state.owned = [ref("atlas", "default"), ref("atlas", "scout")];
    state.gate = null;
    release();
    await flush();
    await clock.advance(CHAT_RESYNC_DEBOUNCE_MS * 3);
    expect(state.syncs).toBe(1);
    expect(watchdog.status().backoff).toEqual([]);
  });

  test("a roster gap seen while a sync runs, and left open by it, buys exactly one more", async () => {
    const { clock, state, watchdog } = harness();
    let release: () => void = () => {};
    state.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await watchdog.reachable(["atlas"]);
    await clock.advance(CHAT_RESYNC_DEBOUNCE_MS);
    // The sync read the roster before `scout` appeared, and pins only `default`.
    await watchdog.roster([swarm("atlas", ["default", "scout"])]);
    state.owned = [ref("atlas", "default")];
    state.gate = null;
    release();
    await flush();
    await clock.advance(CHAT_RESYNC_DEBOUNCE_MS * 3);
    expect(state.syncs).toBe(2);
    expect(watchdog.status().backoff.map((b) => b.key)).toEqual(["atlas"]);
  });

  test("requests during a sync in flight buy exactly one more sync after it", async () => {
    const { clock, state, watchdog } = harness();
    let release: () => void = () => {};
    state.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await watchdog.reachable(["atlas"]);
    await clock.advance(CHAT_RESYNC_DEBOUNCE_MS);
    expect(state.syncs).toBe(1);

    await watchdog.reachable(["atlas"]);
    await watchdog.reachable(["atlas"]);
    await watchdog.reachable(["atlas"]);
    // No second sync overlaps the first, however long it runs.
    await clock.advance(CHAT_RESYNC_DEBOUNCE_MS * 10);
    expect(state.syncs).toBe(1);
    state.gate = null;
    release();
    await flush();
    await clock.advance(CHAT_RESYNC_DEBOUNCE_MS * 3);
    expect(state.syncs).toBe(2);
  });

  test("a box coming up that nobody listens to asks for nothing", async () => {
    const { clock, state, watchdog } = harness({ listening: ["atlas"] });
    await watchdog.reachable(["birch"]);
    await clock.advance(CHAT_RESYNC_DEBOUNCE_MS);
    expect(state.syncs).toBe(0);
  });
});

describe("the reachability gate", () => {
  test("a stopped or unknown listened box is skipped: no sync, no resume", async () => {
    const { clock, state, watchdog } = harness({
      listening: ["atlas", "birch"],
      agents: { atlas: "stopped" },
    });
    state.failed = [ref("atlas", "default"), ref("birch", "default")];
    await watchdog.tick();
    await clock.advance(CHAT_RESYNC_DEBOUNCE_MS);
    expect(state.syncs).toBe(0);
    expect(state.resumes).toEqual([]);
    expect(watchdog.status().skipped).toBe(2);
  });

  test("no fleet scan yet skips every listened box", async () => {
    const { clock, state, watchdog } = harness({ agents: null });
    state.failed = [ref("atlas", "default")];
    await watchdog.tick();
    await clock.advance(CHAT_RESYNC_DEBOUNCE_MS);
    expect(state.syncs).toBe(0);
    expect(state.resumes).toEqual([]);
    expect(watchdog.status().skipped).toBe(1);
  });

  test("a failed conversation on a box nobody listens to is left alone", async () => {
    const { state, watchdog } = harness({
      listening: ["atlas"],
      agents: { atlas: "ready", birch: "ready" },
    });
    state.owned = [ref("atlas", "default")];
    state.failed = [ref("birch", "default")];
    await watchdog.tick();
    expect(state.resumes).toEqual([]);
  });
});

describe("failed conversations", () => {
  test("are resumed one at a time, with a backoff that doubles and stops at ten minutes", async () => {
    const { clock, state, watchdog } = harness();
    state.owned = [ref("atlas", "default")];
    state.failed = [ref("atlas", "scout")];
    const start = clock.now();
    const at: number[] = [];
    const resume = state.resumes;
    let seen = 0;
    watchdog.start();
    await watchdog.tick();
    for (let minute = 0; minute <= 40; minute += 1) {
      while (seen < resume.length) {
        at.push((clock.now() - start) / 1000);
        seen += 1;
      }
      await clock.advance(CHAT_WATCHDOG_INTERVAL_MS);
    }
    watchdog.stop();
    expect(resume.every((target) => target.bot === "scout")).toBe(true);
    const gaps = at.slice(1).map((time, i) => time - (at[i] ?? 0));
    const base = CHAT_WATCHDOG_BACKOFF_BASE_MS / 1000;
    const max = CHAT_WATCHDOG_BACKOFF_MAX_MS / 1000;
    expect(gaps).toEqual([base, base * 2, base * 4, base * 8, max, max]);
    expect(state.syncs).toBe(0);
  });

  test("a box coming up again resets its backoff: the next tick resumes at once", async () => {
    const { clock, state, watchdog } = harness();
    state.owned = [ref("atlas", "default")];
    state.failed = [ref("atlas", "scout")];
    await watchdog.tick();
    await clock.advance(CHAT_WATCHDOG_INTERVAL_MS);
    await watchdog.tick();
    expect(state.resumes.length).toBe(2);
    await watchdog.tick();
    expect(state.resumes.length).toBe(2);

    await watchdog.reachable(["atlas"]);
    await watchdog.tick();
    expect(state.resumes.length).toBe(3);
    expect(watchdog.status().deferred).toBeGreaterThan(0);
  });

  test("a conversation that stays healthy starts its backoff over", async () => {
    const { clock, state, watchdog } = harness();
    state.owned = [ref("atlas", "default")];
    state.failed = [ref("atlas", "scout")];
    await watchdog.tick();
    await clock.advance(CHAT_WATCHDOG_INTERVAL_MS);
    await watchdog.tick();
    expect(state.resumes.length).toBe(2);

    state.failed = [];
    state.health = [healthy(ref("atlas", "scout"))];
    await watchdog.tick();
    // One good read is not recovery yet.
    expect(watchdog.status().backoff.length).toBe(1);
    await clock.advance(CHAT_WATCHDOG_HEALTHY_RESET_MS);
    await watchdog.tick();
    expect(watchdog.status().backoff).toEqual([]);

    state.failed = [ref("atlas", "scout")];
    state.health = [];
    await watchdog.tick();
    expect(state.resumes.length).toBe(3);
  });

  test("a conversation that flaps between failed and healthy still backs off to the cap", async () => {
    const { clock, state, watchdog } = harness();
    const scout = ref("atlas", "scout");
    state.owned = [ref("atlas", "default")];
    const start = clock.now();
    const at: number[] = [];
    for (let minute = 0; minute < 40; minute += 1) {
      // Failed on even minutes; on odd ones the resume took and the read is good.
      state.failed = minute % 2 === 0 ? [scout] : [];
      state.health = minute % 2 === 0 ? [] : [healthy(scout)];
      const before = state.resumes.length;
      await watchdog.tick();
      if (state.resumes.length > before) at.push((clock.now() - start) / 60_000);
      await clock.advance(CHAT_WATCHDOG_INTERVAL_MS);
    }
    expect(at).toEqual([0, 2, 4, 8, 16, 26, 36]);
  });

  test("an owner reset (a fleet switch) clears every backoff", async () => {
    const { state, watchdog } = harness();
    state.owned = [ref("atlas", "default")];
    state.failed = [ref("atlas", "scout")];
    await watchdog.tick();
    await watchdog.tick();
    expect(state.resumes.length).toBe(1);
    state.epoch += 1;
    await watchdog.tick();
    expect(state.resumes.length).toBe(2);
  });
});

describe("a read stuck reconnecting", () => {
  test("is restarted once the streak passes the stale bound, and not before", async () => {
    const { clock, state, watchdog, log } = harness();
    const stuck = ref("atlas", "default");
    state.owned = [stuck];
    state.health = [
      {
        ref: stuck,
        pinned: true,
        session: null,
        health: "reconnect",
        healthSince: clock.now() - 1_000,
      },
    ];
    await watchdog.tick();
    expect(state.restarts).toEqual([]);

    await clock.advance(CHAT_WATCHDOG_STALE_MS);
    await watchdog.tick();
    expect(state.restarts).toEqual([{ instance: "atlas", bot: "default" }]);
    expect(log.lines.join("\n")).toContain("stale reconnect");

    // Behind the same per-conversation backoff as a resume.
    await watchdog.tick();
    expect(state.restarts.length).toBe(1);
  });

  test("a read that recovers while the tick is resuming another is not restarted", async () => {
    const { clock, owner, state, watchdog } = harness();
    const stuck = ref("atlas", "default");
    state.owned = [stuck];
    state.failed = [ref("atlas", "scout")];
    state.health = [
      {
        ref: stuck,
        pinned: true,
        session: null,
        health: "reconnect",
        healthSince: clock.now() - CHAT_WATCHDOG_STALE_MS - 1,
      },
    ];
    // The tick's health read is taken before it resumes `scout`; by the time
    // the resume answers, `default` has reconnected on its own.
    const resume = owner.resume;
    owner.resume = (target) => {
      state.health = [healthy(stuck)];
      return resume(target);
    };
    await watchdog.tick();
    expect(state.resumes.length).toBe(1);
    expect(state.restarts).toEqual([]);
    expect(watchdog.status().restarts).toBe(0);
    // Nor did it spend `default`'s backoff: only `scout` has an entry.
    expect(watchdog.status().backoff.map((b) => b.key)).toEqual([
      JSON.stringify(["atlas", "scout", null]),
    ]);
  });

  test("a guest is not the watchdog's to restart", async () => {
    const { clock, state, watchdog } = harness();
    const guest = ref("atlas", "default", "thread-7");
    state.owned = [ref("atlas", "default")];
    state.health = [
      {
        ref: guest,
        pinned: false,
        session: null,
        health: "reconnect",
        healthSince: clock.now() - CHAT_WATCHDOG_STALE_MS - 1,
      },
    ];
    await watchdog.tick();
    expect(state.restarts).toEqual([]);
  });
});

describe("stop", () => {
  test("disarms every timer: nothing ticks or syncs afterwards", async () => {
    const { clock, state, watchdog } = harness();
    state.failed = [ref("atlas", "scout")];
    watchdog.start();
    watchdog.start();
    await watchdog.reachable(["atlas"]);
    expect(clock.armed()).toBe(2);
    watchdog.stop();
    watchdog.stop();
    expect(clock.armed()).toBe(0);

    await clock.advance(CHAT_WATCHDOG_INTERVAL_MS * 60);
    await watchdog.tick();
    await watchdog.reachable(["atlas"]);
    await watchdog.roster([swarm("atlas", ["default"])]);
    expect(clock.armed()).toBe(0);
    expect(state.syncs).toBe(0);
    expect(state.resumes).toEqual([]);
    expect(watchdog.status().ticks).toBe(0);
  });

  test("a tick in flight when stopped acts on nothing and re-arms nothing", async () => {
    const { clock, state, world, watchdog } = harness();
    state.failed = [ref("atlas", "scout")];
    let release: () => void = () => {};
    world.block = new Promise<void>((resolve) => {
      release = resolve;
    });
    watchdog.start();
    // The interval fires, and the tick parks on its listening read.
    await clock.advance(CHAT_WATCHDOG_INTERVAL_MS);
    expect(watchdog.status().ticks).toBe(1);
    watchdog.stop();
    release();
    await watchdog.idle();
    await clock.advance(CHAT_WATCHDOG_INTERVAL_MS * 10);
    expect(clock.armed()).toBe(0);
    expect(state.syncs).toBe(0);
    expect(state.resumes).toEqual([]);
  });
});
