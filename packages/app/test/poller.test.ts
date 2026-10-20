/**
 * The fleet poller's diff (§3.4), and the one thing it has to get right: a
 * change reaches connected browsers only if the fingerprint moved.
 *
 * `version` covers everything that lives on the agent row, which is why the
 * fingerprint is short — and why the fields it does *not* cover have to be named
 * explicitly. `update_available` is computed from the **fleet's** settings
 * (§8.3): rotating a provider profile moves it on every agent pinned behind that
 * profile without writing a single agent row. A fingerprint of `version` alone
 * therefore leaves every open dashboard saying "up to date" until something else
 * happens to touch the row, which may be never.
 */
import { describe, expect, test } from "bun:test";
import { openHermetic, terminalNotices } from "@hermetic/core";
import type { AgentView, Hermetic } from "@hermetic/core";
import {
  ADVISORY_INTERVAL_MS,
  CHAT_INTERVAL_MS,
  FleetPoller,
  getPoller,
  heartbeatPrint,
  POLL_INTERVAL_MS,
  type FleetEvent,
  type PollerHooks,
} from "../src/poller.ts";
import { testHome } from "./home.ts";

/**
 * A poller over the fixture fleet, driven by hand: `start()` would put a three
 * second interval on the clock, and every assertion here is about one scan
 * followed by another.
 */
async function harness() {
  const hermetic = await openHermetic({ fixture: true, home: testHome() });
  const poller = new FleetPoller(hermetic);
  const seen: FleetEvent[] = [];
  poller.subscribe((e) => seen.push(e));
  await poller.poll();
  seen.length = 0;
  return { hermetic, poller, seen };
}

const upserted = (seen: FleetEvent[]): string[] =>
  seen.filter((e): e is FleetEvent & { type: "agent" } => e.type === "agent").map((e) => e.agent.name);

describe("the agent fingerprint", () => {
  test("a settled fleet scanned twice emits no upserts", async () => {
    const { poller, seen } = await harness();
    await poller.poll();
    expect(upserted(seen)).toEqual([]);
  });

  /**
   * The case the fingerprint was missing. `providers update` writes `_fleet`,
   * not the agent rows, so every agent bound to that profile has a *computed*
   * field that moved and a `version` that did not.
   */
  test("a profile edit reaches the agents pinned behind it", async () => {
    const { hermetic, poller, seen } = await harness();
    // The fixture already pins one agent behind its Bedrock profile, so the
    // set that moves is the *delta*, not the whole annotated list.
    const stale = async () =>
      (await hermetic.agents.list()).filter((a) => a.update_available === true).map((a) => a.name);
    const before = new Set(await stale());

    // A model edit: a key rotation is pushed, not staged, and moves no revision.
    await hermetic.providers.update({ profile: "anthropic-main", model: "claude-opus-5" });
    await poller.poll();

    const moved = (await stale()).filter((name) => !before.has(name));
    // The fixture has agents on this profile, or the assertion below proves
    // nothing about the fingerprint.
    expect(moved.length).toBeGreaterThan(0);
    expect(upserted(seen).sort()).toEqual([...moved].sort());
    // …and the view the browser receives carries the annotation, not just the
    // row it was computed from.
    const sent = seen.find((e) => e.type === "agent" && e.agent.name === moved[0]!);
    expect(sent).toMatchObject({ agent: { update_available: true } });
  });

  /**
   * `heartbeat_age_ms` is `now - last_heartbeat`, different on every scan. In
   * the fingerprint raw, it upserted every agent to every page once a minute
   * for nothing; it is fingerprinted at the resolution the page draws it.
   */
  test("a heartbeat age moves the fingerprint only when its rendering would", () => {
    expect(heartbeatPrint(null)).toBe("null");
    expect(heartbeatPrint(0)).toBe(heartbeatPrint(59_999));
    expect(heartbeatPrint(12_000)).toBe(heartbeatPrint(41_000));
    expect(heartbeatPrint(60_000)).not.toBe(heartbeatPrint(59_999));
    expect(heartbeatPrint(60_000)).toBe(heartbeatPrint(119_999));
    expect(heartbeatPrint(120_000)).not.toBe(heartbeatPrint(119_999));
  });

  test("a rotation that reaches nothing emits nothing", async () => {
    const { hermetic, poller, seen } = await harness();
    // No fixture agent is bound to this profile, so nothing about any agent's
    // rendered state moves — a poller that emitted here would wake every
    // browser for a fleet-level edit they cannot see.
    await hermetic.providers.update({ profile: "vercel-gw", name: "vercel-gateway" });
    await poller.poll();
    expect(upserted(seen)).toEqual([]);
  });
});

/**
 * The other half of the same argument, for the view that moves fastest.
 *
 * A stage board is written by the box with `setBootstrap`, which bumps no
 * `version` on purpose (§4.4: an observation must not fail an operator's CAS
 * write). Nothing else about the row moves during a boot either — the status is
 * `bootstrapping` from the first stage to the last, and there is no heartbeat
 * until after it — so the board is the only thing a fingerprint can notice, and
 * a poller that does not notice leaves the drawer showing whatever squares it
 * had when it opened until the operator reloads the page.
 */
describe("the stage board", () => {
  /**
   * One agent, polled twice, with the board this test controls. The list is a
   * stub rather than the fixture fleet because the fixture's boards are fixed
   * seeds — the question here is what happens *between* two scans.
   */
  async function booting(boards: readonly AgentView["bootstrap"][]) {
    const hermetic = await openHermetic({ fixture: true, home: testHome() });
    const [seed] = await hermetic.agents.list();
    let scan = 0;
    const stub = {
      agents: {
        list: async () => {
          const bootstrap = boards[Math.min(scan, boards.length - 1)];
          scan += 1;
          return [{ ...seed!, status: "bootstrapping", display_status: "bootstrapping", bootstrap }];
        },
      },
    } as unknown as Hermetic;
    const poller = new FleetPoller(stub);
    const seen: FleetEvent[] = [];
    poller.subscribe((e) => seen.push(e));
    await poller.poll();
    seen.length = 0;
    return { poller, seen };
  }

  const board = (current: string | null, ...stages: Array<[string, string]>) => ({
    hermeticd_version: "0.5.1",
    stages: stages.map(([id, status]) => ({ id, status, attempt: 1 })),
    current,
    started_at: "2026-09-15T21:48:16.127Z",
    updated_at: "2026-09-15T21:48:24.581Z",
  });

  test("a stage finishing reaches the browser without a version bump", async () => {
    const { poller, seen } = await booting([
      board("01-tailscale", ["00-preflight", "ok"], ["01-tailscale", "running"]),
      board(
        "02-data-volume",
        ["00-preflight", "ok"],
        ["01-tailscale", "ok"],
        ["02-data-volume", "running"],
      ),
    ] as unknown as ReadonlyArray<AgentView["bootstrap"]>);
    await poller.poll();
    expect(upserted(seen).length).toBe(1);
    const sent = seen.find((e): e is FleetEvent & { type: "agent" } => e.type === "agent");
    expect(sent?.agent.bootstrap?.current).toBe("02-data-volume");
  });

  /**
   * The runner writes `updated_at` on every tick it takes, whether or not a
   * square changed. Folding that into the fingerprint would push an event to
   * every connected browser every three seconds for the whole boot, so a board
   * that has not actually moved must emit nothing.
   */
  test("a board that has not moved emits nothing", async () => {
    const same = board("04-apply", ["00-preflight", "ok"], ["04-apply", "running"]);
    const { poller, seen } = await booting([
      same,
      { ...same, updated_at: "2026-09-15T21:51:00.000Z" },
    ] as unknown as ReadonlyArray<AgentView["bootstrap"]>);
    await poller.poll();
    expect(upserted(seen)).toEqual([]);
  });

  /**
   * `rerun` resumes a failed stage in place: same id, and the status returns to
   * what it already was. `attempt` is the only thing that distinguishes the
   * retry, which is why it is in the print.
   */
  test("a rerun of a failed stage moves the board", async () => {
    const { poller, seen } = await booting([
      board(null, ["02-data-volume", "failed"]),
      {
        ...board("02-data-volume", ["02-data-volume", "running"]),
        stages: [{ id: "02-data-volume", status: "running", attempt: 2 }],
      },
    ] as unknown as ReadonlyArray<AgentView["bootstrap"]>);
    await poller.poll();
    expect(upserted(seen).length).toBe(1);
  });
});

/**
 * Three of the four `fleet.advisory` conditions are computed by reads the fleet
 * tick does not make (§4.9): `foundation.status` holds the
 * foundation update and the Bedrock grant, `volumes.list` holds the loose
 * volume. Without a tick of their own, nothing resolves them but an operator
 * opening that view, and the bell goes on reporting a condition already fixed.
 *
 * These are real AWS reads, so the tick is deliberately slow — the property
 * under test is that it is slow, that it still happens *immediately* once, and
 * that it cannot take the fleet view down with it.
 */
describe("the advisory tick", () => {
  function advisory(over: { foundation?: () => Promise<unknown> } = {}) {
    const calls = { agents: 0, foundation: 0, volumes: 0 };
    let clock = 1_000_000;
    const stub = {
      agents: {
        list: async () => {
          calls.agents += 1;
          return [];
        },
      },
      foundation: {
        status: async () => {
          calls.foundation += 1;
          if (over.foundation) return over.foundation();
          return {};
        },
      },
      volumes: {
        list: async () => {
          calls.volumes += 1;
          return { volumes: [] };
        },
      },
      notifications: {
        list: async () => ({ notifications: [], unread: 0, needs_action: 0, mutes: [] }),
      },
    } as unknown as Hermetic;
    const poller = new FleetPoller(stub, () => clock);
    const seen: FleetEvent[] = [];
    poller.subscribe((e) => seen.push(e));
    return { poller, seen, calls, advance: (ms: number) => void (clock += ms) };
  }

  test("runs on the first poll, and then only on its own interval", async () => {
    const { poller, calls, advance } = advisory();
    // Promptly: an operator opening the portal is owed a current inbox, not one
    // that catches up a minute after they looked at it.
    await poller.poll();
    expect(calls).toEqual({ agents: 1, foundation: 1, volumes: 1 });

    // A poll well inside the interval — a resync, a second window — costs a
    // fleet scan and no AWS reads.
    advance(ADVISORY_INTERVAL_MS / 4);
    await poller.poll();
    expect(calls).toEqual({ agents: 2, foundation: 1, volumes: 1 });

    advance(ADVISORY_INTERVAL_MS);
    await poller.poll();
    expect(calls).toEqual({ agents: 3, foundation: 2, volumes: 2 });
  });

  test("a fleet tick that lands a little early still carries it", async () => {
    // `now` is read after the scan resolves, so two ticks one interval apart
    // can stamp a few hundred milliseconds short of it. A strict comparison
    // would skip every other advisory on that jitter alone.
    const { poller, calls, advance } = advisory();
    await poller.poll();
    advance(POLL_INTERVAL_MS - 250);
    await poller.poll();
    expect(calls).toEqual({ agents: 2, foundation: 2, volumes: 2 });
  });

  test("a foundation read that throws costs the advisory and nothing else", async () => {
    const { poller, seen, calls } = advisory({
      foundation: () => Promise.reject(new Error("the account is unreachable")),
    });
    await poller.poll();
    // The volume half still ran — the two reads are wrapped separately…
    expect(calls).toEqual({ agents: 1, foundation: 1, volumes: 1 });
    // …and the fleet poll settled normally: no `scan_error`, and the `poll`
    // frame every connected browser waits on still went out.
    expect(seen.filter((e) => e.type === "scan_error")).toEqual([]);
    expect(seen.filter((e) => e.type === "poll")).toHaveLength(1);
  });

  /**
   * The guard that answers "is there a fleet to scan". A poller only exists
   * once a fleet is installed, and one whose scan is failing — the account
   * gone, a teardown in flight — must not go on spending AWS reads on an inbox.
   */
  test("a fleet that cannot be scanned is not scanned for advisories either", async () => {
    const calls = { foundation: 0, volumes: 0 };
    const stub = {
      agents: { list: async () => Promise.reject(new Error("no such fleet")) },
      foundation: {
        status: async () => {
          calls.foundation += 1;
          return {};
        },
      },
      volumes: {
        list: async () => {
          calls.volumes += 1;
          return { volumes: [] };
        },
      },
      notifications: {
        list: async () => ({ notifications: [], unread: 0, needs_action: 0, mutes: [] }),
      },
    } as unknown as Hermetic;
    const poller = new FleetPoller(stub);
    await poller.poll();
    expect(calls).toEqual({ foundation: 0, volumes: 0 });
  });
});

/**
 * The chat tick (§4.9).
 *
 * `chat.message` is raised by core from the *roster read*, because a reply that
 * arrives without this portal having driven the turn is only visible as a
 * transcript that has moved on. Something has to make that read happen on a
 * schedule or the source never fires, and this is it — the same argument as the
 * advisory tick above, with one addition that is specific to it: this read fans
 * out over the tailnet rather than calling AWS, and a box that is stopped does
 * not refuse, it *times out*. A fleet that is switched off must therefore cost
 * nothing at all.
 */
describe("the chat tick", () => {
  function chatHarness(agents: { name: string; display_status: string }[]) {
    const calls = { agents: 0, swarms: 0 };
    let clock = 2_000_000;
    const stub = {
      agents: {
        list: async () => {
          calls.agents += 1;
          return agents as unknown as AgentView[];
        },
      },
      foundation: { status: async () => ({}) },
      volumes: { list: async () => ({ volumes: [] }) },
      chat: {
        swarms: async () => {
          calls.swarms += 1;
          return { swarms: [] };
        },
      },
      notifications: {
        list: async () => ({ notifications: [], unread: 0, needs_action: 0, mutes: [] }),
      },
    } as unknown as Hermetic;
    const poller = new FleetPoller(stub, () => clock);
    return { poller, calls, advance: (ms: number) => void (clock += ms) };
  }

  test("runs on the first poll, and then only on its own interval", async () => {
    const { poller, calls, advance } = chatHarness([{ name: "atlas", display_status: "ready" }]);
    await poller.poll();
    expect(calls.swarms).toBe(1);

    // One fleet tick in: the roster is on a slower clock than the scan.
    advance(POLL_INTERVAL_MS);
    await poller.poll();
    expect(calls.swarms).toBe(1);

    advance(CHAT_INTERVAL_MS);
    await poller.poll();
    expect(calls.swarms).toBe(2);
  });

  test("a fleet with nothing that could answer is never asked", async () => {
    // Otherwise a switched-off fleet spends a full tailnet timeout sweep every
    // two minutes for an answer that is known in advance.
    const { poller, calls, advance } = chatHarness([
      { name: "atlas", display_status: "stopped" },
      { name: "corvid", display_status: "destroyed" },
    ]);
    await poller.poll();
    advance(CHAT_INTERVAL_MS);
    await poller.poll();
    expect(calls.swarms).toBe(0);
    // The fleet scan itself kept running, which is what says the gate is about
    // the roster read and not about the poller giving up.
    expect(calls.agents).toBe(2);
  });

  test("a degraded box is still worth asking", async () => {
    // Degraded is a box that is answering badly, not one that is not answering.
    const { poller, calls } = chatHarness([{ name: "ember", display_status: "degraded" }]);
    await poller.poll();
    expect(calls.swarms).toBe(1);
  });

  test("a roster the tailnet would not answer costs the notification, not the poll", async () => {
    const calls = { swarms: 0, polls: 0 };
    const clock = 3_000_000;
    const stub = {
      agents: {
        list: async () => [{ name: "atlas", display_status: "ready" }] as unknown as AgentView[],
      },
      foundation: { status: async () => ({}) },
      volumes: { list: async () => ({ volumes: [] }) },
      chat: {
        swarms: async () => {
          calls.swarms += 1;
          throw new Error("no route to host");
        },
      },
      notifications: {
        list: async () => ({ notifications: [], unread: 0, needs_action: 0, mutes: [] }),
      },
    } as unknown as Hermetic;
    const poller = new FleetPoller(stub, () => clock);
    const seen: FleetEvent[] = [];
    poller.subscribe((e) => seen.push(e));
    await poller.poll();
    expect(calls.swarms).toBe(1);
    // The tick still emitted its poll frame: a dead tailnet degrades the inbox
    // and never the fleet view, which goes through AWS.
    expect(seen.some((e) => e.type === "poll")).toBe(true);
  });
});

/**
 * A tick is three seconds and its slowest half is a tailnet fan-out, so the
 * two things a `setInterval` of an `async` function gets wrong both bite here:
 * ticks overlapping when one runs long, and a tick still running — still
 * emitting, still moving the delivered-through watermark — after the portal
 * was told to stop.
 */
describe("a tick that outlives its interval", () => {
  /** A poller whose `agents.list` is held open by the test. */
  function slow() {
    const calls = { agents: 0 };
    let open = (): void => {};
    const held = new Promise<void>((resolve) => {
      open = () => resolve();
    });
    const stub = {
      agents: {
        list: async () => {
          calls.agents += 1;
          await held;
          return [] as unknown as AgentView[];
        },
      },
      foundation: { status: async () => ({}) },
      volumes: { list: async () => ({ volumes: [] }) },
      chat: { swarms: async () => ({ swarms: [] }) },
      notifications: {
        list: async () => ({
          notifications: [{ at: "2026-09-18T12:00:00.000Z", muted: false }],
          unread: 1,
          needs_action: 0,
          mutes: [],
        }),
      },
    } as unknown as Hermetic;
    const poller = new FleetPoller(stub);
    const seen: FleetEvent[] = [];
    poller.subscribe((e) => seen.push(e));
    return { poller, seen, calls, open: (): void => open() };
  }

  test("a tick arriving while one is in flight runs no second scan", async () => {
    const { poller, calls, open } = slow();
    const first = poller.poll();
    const second = poller.poll();
    // Two reads of one fleet racing to write one `agents` map is the bug; the
    // second caller is handed the scan already running instead.
    expect(calls.agents).toBe(1);
    open();
    await Promise.all([first, second]);
    expect(calls.agents).toBe(1);
    // And the poller is free again once that one finished.
    await poller.poll();
    expect(calls.agents).toBe(2);
    poller.stop();
  });

  test("a tick in flight when the poller stops emits nothing", async () => {
    const { poller, seen, open } = slow();
    const running = poller.poll();
    poller.stop();
    open();
    await running;
    expect(seen).toEqual([]);
  });
});

/**
 * `stop()` is terminal. It aborts the signal every read in a tick carries and
 * silences `emit`, and neither is rebuilt — so a `start()` after one would arm
 * a three second interval on a poller that scans and tells nobody, forever.
 * A fleet switch replaces the poller rather than restarting one (`getPoller`).
 */
describe("a poller that has been stopped", () => {
  test("refuses to arm itself again", async () => {
    const calls = { agents: 0 };
    const stub = {
      agents: {
        list: async () => {
          calls.agents += 1;
          return [] as unknown as AgentView[];
        },
      },
      foundation: { status: async () => ({}) },
      volumes: { list: async () => ({ volumes: [] }) },
      chat: { swarms: async () => ({ swarms: [] }) },
      notifications: {
        list: async () => ({ notifications: [], unread: 0, needs_action: 0, mutes: [] }),
      },
    } as unknown as Hermetic;
    const poller = new FleetPoller(stub);
    const seen: FleetEvent[] = [];
    poller.subscribe((e) => seen.push(e));

    poller.stop();
    // The thing to observe is the clock, not the scan: a re-armed poller is
    // one that ticks for the life of the process and says nothing.
    const real = globalThis.setInterval;
    let armed = 0;
    globalThis.setInterval = ((fn: () => void, ms: number) => {
      armed += 1;
      return real(fn, ms);
    }) as unknown as typeof globalThis.setInterval;
    try {
      poller.start();
    } finally {
      globalThis.setInterval = real;
    }
    await poller.poll();

    expect(armed).toBe(0);
    expect(calls.agents).toBe(0);
    expect(seen).toEqual([]);
    // And nothing is left on the clock for the suite to trip over.
    poller.stop();
  });
});

/**
 * The singleton is keyed on the fleet *and* the instance reading it. The same
 * fleet reopened — a re-adopt after a teardown, an attach to the fleet already
 * served — is a new `Hermetic`, and a poller handed back from the old one
 * reports that instance's world to a page looking at the new one. Seen as a
 * flow test that failed only when an earlier suite had left a same-keyed poller
 * behind in the process.
 */
describe("getPoller", () => {
  function stub(): Hermetic {
    return {
      agents: { list: async () => [] as unknown as AgentView[] },
      foundation: { status: async () => ({}) },
      volumes: { list: async () => ({ volumes: [] }) },
      chat: { swarms: async () => ({ swarms: [] }) },
      notifications: {
        list: async () => ({ notifications: [], unread: 0, needs_action: 0, mutes: [] }),
      },
    } as unknown as Hermetic;
  }

  test("hands back the running poller for the same fleet and instance", () => {
    const hermetic = stub();
    const first = getPoller(hermetic, "fixture:getpoller-same");
    try {
      expect(getPoller(hermetic, "fixture:getpoller-same")).toBe(first);
    } finally {
      first.stop();
    }
  });

  test("replaces, and stops, a same-keyed poller built around another instance", async () => {
    const old = getPoller(stub(), "fixture:getpoller-reopened");
    const fresh = getPoller(stub(), "fixture:getpoller-reopened");
    try {
      expect(fresh).not.toBe(old);
      // The one it replaced is stopped, so it neither scans nor leaks an interval.
      const seen: FleetEvent[] = [];
      old.subscribe((e) => seen.push(e));
      await old.poll();
      expect(seen).toEqual([]);
    } finally {
      fresh.stop();
    }
  });
});

describe("flushNotifications", () => {
  /**
   * A row a head raised itself (the terminal's attention, issue #18) goes out
   * now rather than on the next one-minute tick, exactly once even when a
   * tick and a flush read the inbox at the same moment.
   */
  test("delivers a new row now, once, and nothing after stop", async () => {
    const { hermetic, poller, seen } = await harness();
    const target = hermetic.target;
    if (target === null) throw new Error("the fixture has a fleet");
    // The poller's watermark is the millisecond it was built and `since` is
    // exclusive, so a row stamped in that same millisecond is never read. Step
    // past it, or the test fails whenever the harness is fast enough.
    await Bun.sleep(2);
    terminalNotices(hermetic).raise({
      fleet_id: target.fleet_id,
      agent: "atlas",
      session_id: "flush1",
      session_index: 1,
      event: "bell",
    });
    await Promise.all([poller.flushNotifications(), poller.poll(), poller.flushNotifications()]);
    const delivered = seen.filter(
      (e): e is FleetEvent & { type: "notification" } =>
        e.type === "notification" && e.notification.ref === "flush1",
    );
    expect(delivered.map((e) => e.notification.kind)).toEqual(["terminal.bell"]);

    poller.stop();
    seen.length = 0;
    terminalNotices(hermetic).raise({
      fleet_id: target.fleet_id,
      agent: "atlas",
      session_id: "flush2",
      session_index: 1,
      event: "bell",
    });
    await poller.flushNotifications();
    expect(seen).toEqual([]);
  });
});

/**
 * The two facts a tick lends the chat owner's coverage keeper (`PollerHooks`),
 * so it never pays for a scan or a tailnet sweep of its own. `onReachable` is
 * an *edge*, not a level: a box steady in `ready` is already covered, and the
 * first scan is the baseline the launch sync covers, so both must stay quiet.
 */
describe("the poller hooks", () => {
  type Row = { name: string; display_status: string };

  /**
   * A fleet whose rows the test rewrites between scans, with a clock that
   * starts the roster read due and a `chat.swarms` the test can make throw.
   */
  function hooked(initial: Row[], over: { swarms?: () => Promise<unknown> } = {}) {
    let rows = initial;
    let clock = 4_000_000;
    const calls = { swarms: 0 };
    const reachable: string[][] = [];
    const rosters: unknown[][] = [];
    const roster = [{ instance: "atlas", bots: [] }];
    const stub = {
      agents: { list: async () => rows as unknown as AgentView[] },
      foundation: { status: async () => ({}) },
      volumes: { list: async () => ({ volumes: [] }) },
      chat: {
        swarms: async () => {
          calls.swarms += 1;
          if (over.swarms) return over.swarms();
          return { swarms: roster };
        },
      },
      notifications: {
        list: async () => ({ notifications: [], unread: 0, needs_action: 0, mutes: [] }),
      },
    } as unknown as Hermetic;
    const hooks: PollerHooks = {
      onReachable: (names) => void reachable.push(names),
      onRoster: (swarms) => void rosters.push(swarms),
    };
    const poller = new FleetPoller(stub, () => clock, hooks);
    return {
      poller,
      calls,
      reachable,
      rosters,
      roster,
      set: (next: Row[]) => void (rows = next),
      advance: (ms: number) => void (clock += ms),
    };
  }

  test("the first scan is the baseline and reports nothing", async () => {
    const { poller, reachable } = hooked([
      { name: "atlas", display_status: "ready" },
      { name: "ember", display_status: "degraded" },
    ]);
    await poller.poll();
    expect(reachable).toEqual([]);
  });

  test("a failed first scan does not make the next one a transition", async () => {
    // `scanned` flips on an error too; judging the next scan against the empty
    // map it left would report the whole fleet as having just come up.
    let fail = true;
    const seen: string[][] = [];
    const stub = {
      agents: {
        list: async () => {
          if (fail) throw new Error("no such fleet");
          return [{ name: "atlas", display_status: "ready" }] as unknown as AgentView[];
        },
      },
      foundation: { status: async () => ({}) },
      volumes: { list: async () => ({ volumes: [] }) },
      chat: { swarms: async () => ({ swarms: [] }) },
      notifications: {
        list: async () => ({ notifications: [], unread: 0, needs_action: 0, mutes: [] }),
      },
    } as unknown as Hermetic;
    const poller = new FleetPoller(stub, Date.now, { onReachable: (n) => void seen.push(n) });
    await poller.poll();
    // Scanned, but nothing read: the chat watchdog must not take this as an empty fleet.
    expect(poller.snapshot().scanned).toBe(true);
    expect(poller.hasBaseline()).toBe(false);
    fail = false;
    await poller.poll();
    expect(seen).toEqual([]);
    expect(poller.hasBaseline()).toBe(true);
    // A later failure leaves the last fleet read standing.
    fail = true;
    await poller.poll();
    expect(poller.hasBaseline()).toBe(true);
    expect(poller.snapshot().agents.map((a) => a.name)).toEqual(["atlas"]);
  });

  test("stopped to ready fires once, with the name", async () => {
    const { poller, reachable, set } = hooked([{ name: "atlas", display_status: "stopped" }]);
    await poller.poll();
    set([{ name: "atlas", display_status: "ready" }]);
    await poller.poll();
    expect(reachable).toEqual([["atlas"]]);
    // Steady afterwards: the edge is reported once, not on every tick.
    await poller.poll();
    expect(reachable).toEqual([["atlas"]]);
  });

  test("a recreate through stopped and bootstrapping fires on the way back", async () => {
    const { poller, reachable, set } = hooked([{ name: "atlas", display_status: "ready" }]);
    await poller.poll();
    set([{ name: "atlas", display_status: "stopped" }]);
    await poller.poll();
    set([{ name: "atlas", display_status: "bootstrapping" }]);
    await poller.poll();
    expect(reachable).toEqual([]);
    set([{ name: "atlas", display_status: "ready" }]);
    await poller.poll();
    expect(reachable).toEqual([["atlas"]]);
  });

  test("bootstrapping to degraded fires", async () => {
    const { poller, reachable, set } = hooked([{ name: "ember", display_status: "bootstrapping" }]);
    await poller.poll();
    set([{ name: "ember", display_status: "degraded" }]);
    await poller.poll();
    expect(reachable).toEqual([["ember"]]);
  });

  test("a box steady in ready, or moving within the reachable pair, does not fire", async () => {
    const { poller, reachable, set } = hooked([
      { name: "atlas", display_status: "ready" },
      { name: "ember", display_status: "degraded" },
    ]);
    await poller.poll();
    await poller.poll();
    // ready→degraded and degraded→ready: talkable throughout.
    set([
      { name: "atlas", display_status: "degraded" },
      { name: "ember", display_status: "ready" },
    ]);
    await poller.poll();
    expect(reachable).toEqual([]);
  });

  test("an agent appearing after the baseline already ready fires", async () => {
    const { poller, reachable, set } = hooked([{ name: "atlas", display_status: "ready" }]);
    await poller.poll();
    set([
      { name: "atlas", display_status: "ready" },
      { name: "corvid", display_status: "ready" },
    ]);
    await poller.poll();
    expect(reachable).toEqual([["corvid"]]);
  });

  test("several agents coming up in one scan are one call, names sorted", async () => {
    const { poller, reachable, set } = hooked([
      { name: "zephyr", display_status: "stopped" },
      { name: "atlas", display_status: "bootstrapping" },
      { name: "ember", display_status: "error" },
    ]);
    await poller.poll();
    set([
      { name: "zephyr", display_status: "ready" },
      { name: "atlas", display_status: "degraded" },
      { name: "ember", display_status: "ready" },
      { name: "corvid", display_status: "stopped" },
    ]);
    await poller.poll();
    expect(reachable).toEqual([["atlas", "ember", "zephyr"]]);
  });

  test("a hook that throws costs itself, not the poll", async () => {
    let rows: Row[] = [{ name: "atlas", display_status: "stopped" }];
    let clock = 5_000_000;
    const stub = {
      agents: { list: async () => rows as unknown as AgentView[] },
      foundation: { status: async () => ({}) },
      volumes: { list: async () => ({ volumes: [] }) },
      chat: { swarms: async () => ({ swarms: [] }) },
      notifications: {
        list: async () => ({ notifications: [], unread: 0, needs_action: 0, mutes: [] }),
      },
    } as unknown as Hermetic;
    const thrown = { reachable: 0, roster: 0 };
    const poller = new FleetPoller(stub, () => clock, {
      onReachable: () => {
        thrown.reachable += 1;
        throw new Error("the watchdog fell over");
      },
      onRoster: () => {
        thrown.roster += 1;
        throw new Error("so did the roster half");
      },
    });
    const seen: FleetEvent[] = [];
    poller.subscribe((e) => seen.push(e));
    await poller.poll();
    rows = [{ name: "atlas", display_status: "ready" }];
    clock += CHAT_INTERVAL_MS;
    seen.length = 0;
    await poller.poll();
    expect(thrown).toEqual({ reachable: 1, roster: 1 });
    // The upsert and the `poll` frame still went out after both hooks threw.
    expect(upserted(seen)).toEqual(["atlas"]);
    expect(seen.filter((e) => e.type === "poll")).toHaveLength(1);
  });

  test("a stopped poller calls neither hook", async () => {
    const { poller, reachable, rosters, set, advance } = hooked([
      { name: "atlas", display_status: "stopped" },
    ]);
    await poller.poll();
    poller.stop();
    set([{ name: "atlas", display_status: "ready" }]);
    advance(CHAT_INTERVAL_MS);
    await poller.poll();
    expect(reachable).toEqual([]);
    expect(rosters).toEqual([]);
  });

  test("a stop while the roster is in the air calls no hook", async () => {
    let open = (): void => {};
    const held = new Promise<void>((resolve) => {
      open = () => resolve();
    });
    const rosters: unknown[] = [];
    let asked = 0;
    const stub = {
      agents: {
        list: async () => [{ name: "atlas", display_status: "ready" }] as unknown as AgentView[],
      },
      foundation: { status: async () => ({}) },
      volumes: { list: async () => ({ volumes: [] }) },
      chat: {
        // Ignores the signal on purpose: the guard under test is the poller's
        // own, not whether core honoured the abort.
        swarms: async () => {
          asked += 1;
          await held;
          return { swarms: [] };
        },
      },
      notifications: {
        list: async () => ({ notifications: [], unread: 0, needs_action: 0, mutes: [] }),
      },
    } as unknown as Hermetic;
    const poller = new FleetPoller(stub, Date.now, { onRoster: (s) => void rosters.push(s) });
    const running = poller.poll();
    // Let the scan reach the roster read before stopping.
    await Bun.sleep(1);
    poller.stop();
    open();
    await running;
    // The read was really in the air, or this proves nothing about the guard.
    expect(asked).toBe(1);
    expect(rosters).toEqual([]);
  });

  test("onRoster gets the swarms a successful read returned", async () => {
    const { poller, rosters, roster } = hooked([{ name: "atlas", display_status: "ready" }]);
    await poller.poll();
    expect(rosters).toHaveLength(1);
    expect(rosters[0]).toBe(roster);
  });

  test("onRoster is quiet when the read throws", async () => {
    const { poller, calls, rosters } = hooked([{ name: "atlas", display_status: "ready" }], {
      swarms: () => Promise.reject(new Error("no route to host")),
    });
    await poller.poll();
    expect(calls.swarms).toBe(1);
    expect(rosters).toEqual([]);
  });

  test("onRoster is quiet when the read is skipped", async () => {
    // Nothing reachable: the gate skips the read entirely.
    const off = hooked([{ name: "atlas", display_status: "stopped" }]);
    await off.poller.poll();
    expect(off.calls.swarms).toBe(0);
    expect(off.rosters).toEqual([]);

    // Not due: the second tick inside the interval reads nothing new.
    const on = hooked([{ name: "atlas", display_status: "ready" }]);
    await on.poller.poll();
    on.advance(POLL_INTERVAL_MS);
    await on.poller.poll();
    expect(on.calls.swarms).toBe(1);
    expect(on.rosters).toHaveLength(1);
  });
});

describe("getPoller and hooks", () => {
  function stub(rows: () => unknown[]): Hermetic {
    return {
      agents: { list: async () => rows() as AgentView[] },
      foundation: { status: async () => ({}) },
      volumes: { list: async () => ({ volumes: [] }) },
      chat: { swarms: async () => ({ swarms: [] }) },
      notifications: {
        list: async () => ({ notifications: [], unread: 0, needs_action: 0, mutes: [] }),
      },
    } as unknown as Hermetic;
  }

  test("a replacement poller reports to the hooks of the call that built it", async () => {
    let status = "stopped";
    const rows = () => [{ name: "atlas", display_status: status }];
    const oldSeen: string[][] = [];
    const newSeen: string[][] = [];
    const old = getPoller(stub(rows), "fixture:getpoller-hooks", {
      onReachable: (n) => void oldSeen.push(n),
    });
    const fresh = getPoller(stub(rows), "fixture:getpoller-hooks", {
      onReachable: (n) => void newSeen.push(n),
    });
    try {
      expect(fresh).not.toBe(old);
      // `start()` ran the baseline scan already; wait it out, then flip.
      await fresh.poll();
      status = "ready";
      await fresh.poll();
      expect(newSeen).toEqual([["atlas"]]);
      expect(oldSeen).toEqual([]);
    } finally {
      fresh.stop();
    }
  });
});
