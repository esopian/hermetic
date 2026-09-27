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
import { openHermetic } from "@hermetic/core";
import type { AgentView, Hermetic } from "@hermetic/core";
import {
  ADVISORY_INTERVAL_MS,
  CHAT_INTERVAL_MS,
  FleetPoller,
  getPoller,
  POLL_INTERVAL_MS,
  type FleetEvent,
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
  test("a profile rotation reaches the agents pinned behind it", async () => {
    const { hermetic, poller, seen } = await harness();
    // The fixture already pins one agent behind its Bedrock profile, so the
    // set that moves is the *delta*, not the whole annotated list.
    const stale = async () =>
      (await hermetic.agents.list()).filter((a) => a.update_available === true).map((a) => a.name);
    const before = new Set(await stale());

    await hermetic.providers.update({ profile: "anthropic-main", api_key: "sk-ant-FIXTURE-ROTATED" });
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
