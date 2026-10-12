import { describe, expect, test } from "bun:test";
import type { AgentView } from "../src/api/index.ts";
import {
  ariaSort,
  compareAgents,
  countsOf,
  emptyHint,
  filterAgents,
  nextSort,
  shouldDeselect,
  sortAgents,
  sortLabel,
  triageGroups,
  withoutDestroyed,
} from "../src/logic/selectors.ts";

function agent(overrides: Partial<AgentView> = {}): AgentView {
  return {
    name: "atlas",
    status: "ready",
    version: 1,
    lock: null,
    size: "medium",
    instance_type: "t4g.2xlarge",
    region: "us-west-2",
    instance_id: "i-1",
    volume_id: "vol-1",
    volume_gib: 100,
    hermes_version: "1.2.0",
    hermeticd_version: "1.2.0",
    config_hash: null,
    provider: "bedrock",
    secrets_mode: "none",
    browser: true,
    tailscale_ip: "100.64.0.1",
    resources: { ssm_paths: [] },
    last_heartbeat: "2026-09-01T12:00:00.000Z",
    health: { hermes: true, tailscale: true, disk: true },
    metrics: { cpu_pct: 10, mem_pct: 20, disk_pct: 30 },
    created_by: "evan",
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T12:00:00.000Z",
    display_status: "ready",
    heartbeat_age_ms: 5_000,
    ...overrides,
  } as AgentView;
}

describe("countsOf", () => {
  test("buckets by display_status, busy-ness, and off-ness", () => {
    const agents = [
      agent({ name: "a", display_status: "ready" }),
      agent({ name: "b", display_status: "degraded" }),
      agent({ name: "c", display_status: "unreachable" }),
      agent({ name: "d", display_status: "stopped" }),
      agent({ name: "e", display_status: "destroyed" }),
      agent({ name: "f", display_status: "creating" }),
      agent({ name: "g", display_status: "bootstrapping" }),
    ];
    // `total` is the fleet you are running: six live rows. A legacy destroyed
    // row is a record, counted nowhere (§6.7).
    expect(countsOf(agents)).toEqual({
      total: 6,
      ready: 1,
      degraded: 1,
      unreachable: 1,
      stopped: 1,
      busy: 2,
    });
  });

  test("a legacy destroyed row is never stopped and is out of total", () => {
    const c = countsOf([
      agent({ name: "a", display_status: "stopped" }),
      agent({ name: "b", display_status: "destroyed" }),
      agent({ name: "c", display_status: "destroyed" }),
    ]);
    expect(c.stopped).toBe(1);
    expect(c.total).toBe(1);
  });

  test("a fleet of nothing but legacy destroyed rows has a total of zero", () => {
    expect(countsOf([agent({ display_status: "destroyed" })]).total).toBe(0);
  });

  test("empty fleet", () => {
    expect(countsOf([])).toEqual({
      total: 0,
      ready: 0,
      degraded: 0,
      busy: 0,
      stopped: 0,
      unreachable: 0,
    });
  });
});

describe("withoutDestroyed", () => {
  const agents = [
    agent({ name: "alive", display_status: "ready" }),
    agent({ name: "gone", display_status: "destroyed" }),
    agent({ name: "off", display_status: "stopped" }),
    agent({ name: "also-gone", display_status: "destroyed" }),
  ];

  test("drops destroyed agents and nothing else", () => {
    expect(withoutDestroyed(agents).map((a) => a.name)).toEqual(["alive", "off"]);
  });

  test("a fleet with no destroyed agents comes back whole", () => {
    const live = [agent({ name: "alive" }), agent({ name: "off", display_status: "stopped" })];
    expect(withoutDestroyed(live).map((a) => a.name)).toEqual(["alive", "off"]);
  });

  test("the text filter and the destroyed filter compose in either order", () => {
    const byQuery = filterAgents(withoutDestroyed(agents), "o");
    const byDestroyed = withoutDestroyed(filterAgents(agents, "o"));
    expect(byQuery.map((a) => a.name)).toEqual(["off"]);
    expect(byDestroyed.map((a) => a.name)).toEqual(["off"]);
  });

  test("a query for a legacy destroyed row finds nothing on the grid", () => {
    expect(filterAgents(withoutDestroyed(agents), "gone")).toEqual([]);
  });
});

describe("emptyHint", () => {
  test("an empty fleet points at the create shortcut", () => {
    expect(emptyHint({ total: 0, query: "" })).toContain("no agents in this fleet");
    expect(emptyHint({ total: 0, query: "zzz" })).toContain("no agents in this fleet");
  });

  test("a query nothing matches says so", () => {
    expect(emptyHint({ total: 5, query: "zzz" })).toBe("nothing matches “zzz”");
  });
});

describe("shouldDeselect", () => {
  const byName = new Map([
    ["atlas", agent({ name: "atlas" })],
    ["old", agent({ name: "old", display_status: "destroyed" })],
  ]);

  test("a selected agent the fleet no longer holds deselects: a destroy released the row (§6.7)", () => {
    expect(shouldDeselect(true, "granite", byName)).toBe(true);
  });

  test("a selected agent still in the fleet stays selected, mid-destroy included", () => {
    expect(shouldDeselect(true, "atlas", byName)).toBe(false);
    const destroying = new Map([["atlas", agent({ name: "atlas", display_status: "destroying" })]]);
    expect(shouldDeselect(true, "atlas", destroying)).toBe(false);
  });

  test("a legacy destroyed row a hash names keeps its read-only drawer", () => {
    expect(shouldDeselect(true, "old", byName)).toBe(false);
  });

  test("before the first scan, absence means unread, not gone", () => {
    expect(shouldDeselect(false, "granite", new Map())).toBe(false);
  });

  test("nothing selected, nothing to do", () => {
    expect(shouldDeselect(true, null, byName)).toBe(false);
  });
});

describe("filterAgents", () => {
  const agents = [
    agent({ name: "atlas", hermes_version: "1.0.0", size: "small", instance_type: "r8g.large" }),
    agent({ name: "bramble", hermes_version: "2.0.0", size: "large", instance_type: "r8g.2xlarge" }),
  ];

  test("empty query returns every agent, unfiltered", () => {
    expect(filterAgents(agents, "")).toBe(agents);
    expect(filterAgents(agents, "   ")).toBe(agents);
  });

  test("matches by name", () => {
    expect(filterAgents(agents, "atl").map((a) => a.name)).toEqual(["atlas"]);
  });

  test("matches by hostname (tailnet-aware)", () => {
    expect(filterAgents(agents, "atlas.example.ts.net", "example.ts.net").map((a) => a.name)).toEqual([
      "atlas",
    ]);
  });

  /**
   * Both spellings. After a recreate the node holds `<name>-2`, and search has
   * to work whether the operator types the name they gave the agent or the one
   * they just read off the Tailscale console.
   */
  test("matches by either spelling of the hostname", () => {
    const recreated = [
      agent({ name: "atlas", tailscale_dns_name: "atlas-2.example.ts.net" }),
      agent({ name: "bramble" }),
    ];
    expect(
      filterAgents(recreated, "atlas-2.example.ts.net", "example.ts.net").map((a) => a.name),
    ).toEqual(["atlas"]);
    expect(
      filterAgents(recreated, "atlas.example.ts.net", "example.ts.net").map((a) => a.name),
    ).toEqual(["atlas"]);
  });

  test("matches by version, size, and instance type", () => {
    expect(filterAgents(agents, "2.0.0").map((a) => a.name)).toEqual(["bramble"]);
    expect(
      filterAgents(agents, "large")
        .map((a) => a.name)
        .sort(),
    ).toEqual(["atlas", "bramble"]);
    expect(filterAgents(agents, "r8g.2xlarge").map((a) => a.name)).toEqual(["bramble"]);
  });

  test("matches by display_status", () => {
    const mixed = [
      agent({ name: "up", display_status: "ready" }),
      agent({ name: "down", display_status: "stopped" }),
    ];
    expect(filterAgents(mixed, "stopped").map((a) => a.name)).toEqual(["down"]);
  });

  test("is case-insensitive and matches no one when nothing fits", () => {
    expect(filterAgents(agents, "ATLAS").map((a) => a.name)).toEqual(["atlas"]);
    expect(filterAgents(agents, "zzz-nope")).toEqual([]);
  });
});

describe("triageGroups", () => {
  test("groups: attention (degraded/unreachable/error/behind), in progress, healthy, stopped", () => {
    const behind = agent({ name: "behind", display_status: "ready", hermes_version: "1.0.0" });
    const current = agent({ name: "current", display_status: "ready", hermes_version: "2.0.0" });
    const degraded = agent({ name: "degraded", display_status: "degraded" });
    const busy = agent({ name: "busy", display_status: "creating" });
    const stopped = agent({ name: "stopped", display_status: "stopped" });
    const groups = triageGroups([behind, current, degraded, busy, stopped], "2.0.0");

    const byKey = Object.fromEntries(groups.map((g) => [g.key, g.items.map((a) => a.name)]));
    expect(byKey.attention).toEqual(["behind", "degraded"]);
    expect(byKey.progress).toEqual(["busy"]);
    expect(byKey.healthy).toEqual(["current"]);
    expect(byKey.stopped).toEqual(["stopped"]);
  });

  test("a legacy destroyed row lands in no group, stopped included (§6.7)", () => {
    const stopped = agent({ name: "stopped", display_status: "stopped" });
    const gone = agent({ name: "gone", display_status: "destroyed" });
    const groups = triageGroups([stopped, gone], null);

    expect(groups.map((g) => g.key)).toEqual(["attention", "progress", "healthy", "stopped"]);
    const byKey = Object.fromEntries(groups.map((g) => [g.key, g.items.map((a) => a.name)]));
    expect(byKey.stopped).toEqual(["stopped"]);
    expect(groups.flatMap((g) => g.items.map((a) => a.name))).not.toContain("gone");
  });

  test("a busy-but-behind agent counts as in-progress, not attention", () => {
    const creatingBehind = agent({ display_status: "creating", hermes_version: "1.0.0" });
    const groups = triageGroups([creatingBehind], "2.0.0");
    const byKey = Object.fromEntries(groups.map((g) => [g.key, g.items.length]));
    expect(byKey.progress).toBe(1);
    expect(byKey.attention).toBe(0);
  });

  test("hint text adapts to whether a latest version is known", () => {
    const withLatest = triageGroups([], "2.0.0").find((g) => g.key === "attention")!;
    expect(withLatest.hint).toContain("2.0.0");
    const withoutLatest = triageGroups([], null).find((g) => g.key === "attention")!;
    expect(withoutLatest.hint).not.toContain("null");
  });

  test("always returns the four groups, even for an empty fleet", () => {
    const groups = triageGroups([], null);
    expect(groups.map((g) => g.key)).toEqual(["attention", "progress", "healthy", "stopped"]);
    for (const g of groups) expect(g.items).toEqual([]);
  });

  test("there is no destroyed group: destroyed agents are the Destroyed lens's", () => {
    const groups = triageGroups([agent({ display_status: "ready" })], null);
    expect(groups.find((g) => g.key === "destroyed")).toBeUndefined();
  });
});

/* ── sorting (the table's clickable column headers) ──────────────────────── */

const NOW = Date.parse("2026-09-06T12:00:00.000Z");

/** A running agent, so `uptime` and the metric columns have something to read. */
function live(name: string, over: Partial<AgentView> = {}): AgentView {
  return agent({ name, ...over });
}

describe("sortAgents", () => {
  test("no sort is the server's own order, and the same array", () => {
    // The board, the table and triage all render this list; an unclicked header
    // must not reorder anything, and must not churn the reference either.
    const rows = [live("zeta"), live("alpha")];
    expect(sortAgents(rows, null, NOW)).toBe(rows);
  });

  test("sorting does not mutate the fleet it was handed", () => {
    const rows = [live("zeta"), live("alpha")];
    sortAgents(rows, { key: "name", dir: "asc" }, NOW);
    expect(rows.map((a) => a.name)).toEqual(["zeta", "alpha"]);
  });

  test("by name, both ways", () => {
    const rows = [live("zeta"), live("alpha"), live("mid")];
    expect(sortAgents(rows, { key: "name", dir: "asc" }, NOW).map((a) => a.name)).toEqual([
      "alpha",
      "mid",
      "zeta",
    ]);
    expect(sortAgents(rows, { key: "name", dir: "desc" }, NOW).map((a) => a.name)).toEqual([
      "zeta",
      "mid",
      "alpha",
    ]);
  });

  /**
   * The point of sorting by status is to bring the broken to the top.
   * Alphabetical would put `bootstrapping` above `error`, which is exactly
   * backwards.
   */
  test("by status, worst first — not alphabetically", () => {
    const rows = [
      live("ready-one", { display_status: "ready" }),
      live("broken", { display_status: "error" }),
      live("busy", { display_status: "bootstrapping" }),
      live("gone", { display_status: "destroyed" }),
      live("sick", { display_status: "degraded" }),
    ];
    expect(sortAgents(rows, { key: "status", dir: "asc" }, NOW).map((a) => a.name)).toEqual([
      "broken",
      "sick",
      "busy",
      "ready-one",
      "gone",
    ]);
  });

  test("by version, semver-ish rather than string order", () => {
    // "1.10.0" < "1.9.0" as strings, and the whole column exists to show which
    // agents are behind.
    const rows = [live("new", { hermes_version: "1.10.0" }), live("old", { hermes_version: "1.9.0" })];
    expect(sortAgents(rows, { key: "version", dir: "asc" }, NOW).map((a) => a.name)).toEqual([
      "old",
      "new",
    ]);
  });

  /**
   * An unmeasured agent has not been measured at 0%. Sorting it as a zero would
   * bury the running agents under the stopped ones — on the column an operator
   * clicked precisely to find the busy box.
   */
  test("unmeasured rows sink to the bottom in both directions", () => {
    const rows = [
      live("idle", { metrics: { cpu_pct: 3, mem_pct: 3, disk_pct: 3 } }),
      live("stopped-one", {
        display_status: "stopped",
        metrics: { cpu_pct: 90, mem_pct: 90, disk_pct: 9 },
      }),
      live("hot", { metrics: { cpu_pct: 91, mem_pct: 50, disk_pct: 5 } }),
    ];
    expect(sortAgents(rows, { key: "cpu", dir: "asc" }, NOW).map((a) => a.name)).toEqual([
      "idle",
      "hot",
      "stopped-one",
    ]);
    expect(sortAgents(rows, { key: "cpu", dir: "desc" }, NOW).map((a) => a.name)).toEqual([
      "hot",
      "idle",
      "stopped-one",
    ]);
  });

  test("by uptime, oldest agent last when ascending", () => {
    const rows = [
      live("elder", { created_at: "2026-08-01T00:00:00.000Z" }),
      live("fresh", { created_at: "2026-09-06T11:00:00.000Z" }),
    ];
    expect(sortAgents(rows, { key: "uptime", dir: "asc" }, NOW).map((a) => a.name)).toEqual([
      "fresh",
      "elder",
    ]);
  });

  /**
   * The fleet stream re-emits every row every three seconds. A comparator that
   * ties has to break the tie the same way each time or the table reshuffles
   * itself under the operator's cursor.
   */
  test("ties break on the name, so a uniform fleet holds still", () => {
    const rows = [live("charlie"), live("alpha"), live("bravo")];
    for (const dir of ["asc", "desc"] as const) {
      expect(sortAgents(rows, { key: "version", dir }, NOW).map((a) => a.name)).toEqual([
        "alpha",
        "bravo",
        "charlie",
      ]);
    }
  });
});

describe("compareAgents", () => {
  test("is a comparator: opposite arguments give the opposite sign", () => {
    const a = live("alpha", { metrics: { cpu_pct: 10, mem_pct: 1, disk_pct: 1 } });
    const b = live("bravo", { metrics: { cpu_pct: 80, mem_pct: 1, disk_pct: 1 } });
    expect(compareAgents(a, b, "cpu", NOW)).toBeLessThan(0);
    expect(compareAgents(b, a, "cpu", NOW)).toBeGreaterThan(0);
    expect(compareAgents(a, a, "cpu", NOW)).toBe(0);
  });
});

describe("nextSort", () => {
  test("a new column starts ascending", () => {
    expect(nextSort(null, "cpu")).toEqual({ key: "cpu", dir: "asc" });
    expect(nextSort({ key: "name", dir: "desc" }, "cpu")).toEqual({ key: "cpu", dir: "asc" });
  });

  test("the same column flips, then lets go", () => {
    // Three states, not two: an operator who sorted by mistake must be able to
    // get the server's order back without reloading.
    expect(nextSort({ key: "cpu", dir: "asc" }, "cpu")).toEqual({ key: "cpu", dir: "desc" });
    expect(nextSort({ key: "cpu", dir: "desc" }, "cpu")).toBeNull();
  });
});

describe("ariaSort", () => {
  test("only the column in force claims a direction", () => {
    expect(ariaSort({ key: "cpu", dir: "asc" }, "cpu")).toBe("ascending");
    expect(ariaSort({ key: "cpu", dir: "desc" }, "cpu")).toBe("descending");
    expect(ariaSort({ key: "cpu", dir: "asc" }, "name")).toBe("none");
    expect(ariaSort(null, "name")).toBe("none");
  });
});

describe("sortLabel", () => {
  /**
   * The order is chosen on the table's column headers but applied to all three
   * layouts, so on the board and in triage it was invisible *and* unresettable:
   * a deliberately reordered fleet with nothing on screen saying so.
   */
  test("names the column and the direction", () => {
    expect(sortLabel({ key: "cpu", dir: "desc" })).toBe("CPU ↓");
    expect(sortLabel({ key: "mem", dir: "asc" })).toBe("memory ↑");
    expect(sortLabel({ key: "name", dir: "asc" })).toBe("name ↑");
  });

  test("the engine's own order has nothing to say", () => {
    expect(sortLabel(null)).toBeNull();
  });

  test("every sortable column has a label, and the jargon ones are expanded", () => {
    for (const key of ["name", "status", "cpu", "mem", "version", "uptime"] as const) {
      expect(sortLabel({ key, dir: "asc" })).not.toBeNull();
    }
    // The two column keys that are not words: the chip reads to an operator,
    // not to whoever named the field.
    expect(sortLabel({ key: "mem", dir: "asc" })).toBe("memory ↑");
    expect(sortLabel({ key: "cpu", dir: "asc" })).toBe("CPU ↑");
  });
});
