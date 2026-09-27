import { describe, expect, test } from "bun:test";
import { hasReported, watchHandoff, type HandoffDeps } from "../src/agents/handoff.ts";
import type { Agent, OpEvent } from "../src/schema/index.ts";

/** A row shaped like the ones `create` leaves behind, with nothing reported. */
function row(): Agent {
  return {
    name: "atlas",
    status: "creating",
    bootstrap: null,
  } as unknown as Agent;
}

function reported(): Agent {
  return { ...row(), bootstrap: { stages: [] } } as unknown as Agent;
}

/**
 * A clock the test drives: `sleep` advances it instead of waiting, so a
 * five-minute budget costs no wall-clock time and the loop's arithmetic is
 * exercised at its real values.
 */
function harness(rows: Array<Agent | null>, budgetMs = 60_000) {
  let nowMs = 1_000_000;
  const reads: string[] = [];
  const deps: HandoffDeps = {
    getAgent: async (name) => {
      reads.push(name);
      return rows.shift() ?? null;
    },
    now: () => nowMs,
    budgetMs,
    pollMs: 10_000,
    sleep: async (ms) => {
      nowMs += ms;
    },
  };
  return { deps, reads, elapsed: () => nowMs - 1_000_000 };
}

async function drain(it: AsyncIterable<OpEvent>): Promise<OpEvent[]> {
  const out: OpEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("hasReported", () => {
  test("a bootstrap key is first contact, whatever is in it", () => {
    expect(hasReported(reported())).toBe(true);
  });

  test("a row that has left `creating` counts too — a fast box beat the poll", () => {
    expect(hasReported({ ...row(), status: "bootstrapping" } as Agent)).toBe(true);
    expect(hasReported({ ...row(), status: "ready" } as Agent)).toBe(true);
  });

  test("a silent `creating` row, and a row that is gone, are not", () => {
    expect(hasReported(row())).toBe(false);
    expect(hasReported(null)).toBe(false);
  });
});

describe("the post-handoff watch", () => {
  test("a zero budget yields nothing at all — the watch is off", async () => {
    const { deps, reads } = harness([reported()], 0);
    expect(await drain(watchHandoff(deps, "atlas"))).toEqual([]);
    expect(reads).toEqual([]);
  });

  test("reads before it sleeps, so a box that already reported costs no poll", async () => {
    const { deps, elapsed } = harness([reported()]);
    const events = await drain(watchHandoff(deps, "atlas"));
    expect(events.map((e) => e.phase)).toEqual(["handoff", "handoff"]);
    expect(events.at(-1)?.kind).toBe("done");
    expect(events.at(-1)?.level).toBeUndefined();
    expect(elapsed()).toBe(0);
  });

  test("polls until the box speaks", async () => {
    const { deps, reads } = harness([row(), row(), reported()]);
    const events = await drain(watchHandoff(deps, "atlas"));
    expect(reads).toHaveLength(3);
    expect(events.at(-1)?.message).toContain("hermeticd reported after");
  });

  /**
   * The case this whole module exists for: an IAM policy that denies every row
   * write leaves a box that boots, bills, and never says a word. The op must
   * still finish — the resources exist — but it may not finish silently.
   */
  test("a budget that runs out warns, names the console, and does not fail", async () => {
    const { deps } = harness([], 30_000);
    const events = await drain(watchHandoff(deps, "atlas"));
    const last = events.at(-1)!;
    expect(last.level).toBe("warn");
    expect(last.progress).toBe(0.99);
    expect(last.message).toContain("no report from the box");
    expect(last.message).toContain("hermetic logs atlas --console");
  });

  test("an abort ends the watch without a verdict either way", async () => {
    const { deps } = harness([row(), row(), row()], 60_000);
    const controller = new AbortController();
    const events: OpEvent[] = [];
    for await (const e of watchHandoff(deps, "atlas", { signal: controller.signal })) {
      events.push(e);
      controller.abort();
    }
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("start");
  });

  test("a row read that throws is silence, not a failed create", async () => {
    let nowMs = 0;
    const deps: HandoffDeps = {
      getAgent: () => Promise.reject(new Error("dynamodb is having a day")),
      now: () => nowMs,
      budgetMs: 20_000,
      pollMs: 10_000,
      sleep: async (ms) => {
        nowMs += ms;
      },
    };
    const events = await drain(watchHandoff(deps, "atlas"));
    expect(events.at(-1)?.level).toBe("warn");
  });
});

/**
 * The naming check the watch does on its way past first contact (§6.1). It is
 * not a failure — the box is up, reachable and doing its job — but a node that
 * came up as `atlas` when the create asked for `k7m2x9qa-atlas` is a fleet whose
 * *published release* is older than the naming rule this hermetic renders for,
 * and every screen from here on shows a name nobody chose.
 */
describe("the name the box came up with", () => {
  const expectHostname = "k7m2x9qa-atlas.tail0.ts.net";
  const named = (dns: string | null): Agent =>
    ({ ...reported(), tailscale_dns_name: dns }) as unknown as Agent;

  test("a node wearing the name that was asked for says nothing", async () => {
    const { deps } = harness([named(expectHostname)]);
    const events = await drain(watchHandoff(deps, "atlas", { expectHostname }));
    expect(events.filter((e) => e.level === "warn")).toEqual([]);
  });

  test("a node wearing an older spelling is named, with the remedy", async () => {
    const { deps } = harness([named("atlas.tail0.ts.net")]);
    const events = await drain(watchHandoff(deps, "atlas", { expectHostname }));
    const warn = events.find((e) => e.level === "warn");
    expect(warn?.message).toContain("came up as atlas.tail0.ts.net");
    expect(warn?.message).toContain(expectHostname);
    expect(warn?.message).toContain("hermetic artifacts push");
    expect(warn?.message).toContain("hermetic agent recreate atlas");
    // The op still succeeds: the box exists and reported.
    expect(events.at(-1)?.message).toContain("hermeticd reported");
  });

  /**
   * Tailscale reports `DNSName` with the root dot. It is not a difference of
   * names, and reporting it as one would warn on every healthy create.
   */
  test("the DNS root dot is not a mismatch", async () => {
    const { deps } = harness([named(`${expectHostname}.`)]);
    const events = await drain(watchHandoff(deps, "atlas", { expectHostname }));
    expect(events.filter((e) => e.level === "warn")).toEqual([]);
  });

  /**
   * The common case at first contact: hermeticd writes `bootstrap` before stage
   * 01 runs, so the row usually has no tailnet name yet. Silence is the only
   * honest answer — `doctor` and the drawer ask again later.
   */
  test("a row with no reported name is not accused", async () => {
    const { deps } = harness([named(null)]);
    const events = await drain(watchHandoff(deps, "atlas", { expectHostname }));
    expect(events.filter((e) => e.level === "warn")).toEqual([]);
  });

  test("a caller that does not know the tailnet compares nothing", async () => {
    const { deps } = harness([named("atlas.tail0.ts.net")]);
    const events = await drain(watchHandoff(deps, "atlas", {}));
    expect(events.filter((e) => e.level === "warn")).toEqual([]);
  });
});
