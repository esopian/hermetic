/**
 * The audit log's narrowing rules. The one that earns most of these tests is
 * the null-fleet rule: a row that names no fleet stays *unknown*. It used to be
 * read as the fleet the operator had open, which meant the same row was part of
 * `main`'s history on one screen and `staging`'s on the next — and, because the
 * CLI could not name a fleet it had not resolved yet, that was most rows.
 */
import { describe, expect, test } from "bun:test";
import {
  ALL_FLEETS,
  RUN_OUTCOMES,
  RUN_RANGES,
  type RunLike,
  type RunsFilter,
  UNKNOWN_FLEET,
  defaultRunsFilter,
  describeRunsFilter,
  filterRuns,
  fleetOptions,
  hasActiveRunsFilter,
  matchesRunsFilter,
  runFleet,
  runFleetLabel,
  runLabel,
  runOutcome,
} from "../src/logic/runs-filter.ts";

const NOW = Date.parse("2026-09-07T12:00:00.000Z");

/**
 * A row against `main`, so a test about *anything else* — an outcome, a time
 * window, a search — is not silently also a test of the fleet scope. The rows
 * that name no fleet say so.
 */
function run(over: Partial<RunLike> = {}): RunLike {
  return {
    command: "agent create",
    args: ["alpha"],
    agent: "alpha",
    started_at: "2026-09-07T11:00:00.000Z",
    finished_at: "2026-09-07T11:02:00.000Z",
    exit_code: 0,
    fleet: "main",
    ...over,
  };
}

describe("runOutcome", () => {
  test("reads the exit code, and calls a null one unfinished rather than running", () => {
    expect(runOutcome(run({ exit_code: 0 }))).toBe("ok");
    expect(runOutcome(run({ exit_code: 1 }))).toBe("failed");
    expect(runOutcome(run({ exit_code: 130 }))).toBe("failed");
    // Killed mid-op: finished_at was never written either, and the row cannot
    // tell "still going" from "died". It must not be reported as either.
    expect(runOutcome(run({ exit_code: null, finished_at: null }))).toBe("unfinished");
  });

  test("every outcome the filter offers is one runOutcome can return", () => {
    const offered = RUN_OUTCOMES.map((o) => o.id).filter((id) => id !== "all");
    expect(offered.sort()).toEqual(["failed", "ok", "unfinished"]);
  });
});

describe("runLabel", () => {
  test("is the command line as typed", () => {
    expect(runLabel(run({ command: "agent create", args: ["alpha", "--size", "m"] }))).toBe(
      "agent create alpha --size m",
    );
  });

  test("omits the space when a command took no arguments", () => {
    expect(runLabel(run({ command: "runs", args: [] }))).toBe("runs");
  });
});

describe("runFleet", () => {
  test("is the row's own fleet_id and nothing else", () => {
    expect(runFleet(run({ fleet: "sg7k2m4p" }))).toBe("sg7k2m4p");
  });

  test("a row that named no fleet stays unknown, never the fleet now open", () => {
    // The whole finding: a run the head could not attribute must not be handed
    // to whichever fleet the operator happens to be looking at.
    expect(runFleet(run({ fleet: null }))).toBeNull();
    // And a row from a server too old to send the column at all.
    expect(runFleet(run({ fleet: undefined }))).toBeNull();
  });

  test("attribution ignores the alias, which may since have moved", () => {
    // `staging` now labels another fleet; the row is still about `sg7k2m4p`.
    expect(runFleet(run({ fleet: "sg7k2m4p", fleet_name: "staging" }))).toBe("sg7k2m4p");
  });
});

describe("runFleetLabel", () => {
  test("shows the alias the run carried, falling back to the id", () => {
    expect(runFleetLabel(run({ fleet: "fxtr0001", fleet_name: "main" }))).toBe("main");
    expect(runFleetLabel(run({ fleet: "fxtr0001", fleet_name: null }))).toBe("fxtr0001");
  });

  test("says unknown for a row that names neither", () => {
    expect(runFleetLabel(run({ fleet: null }))).toBe("unknown");
  });
});

describe("defaultRunsFilter", () => {
  test("opens scoped to this fleet with everything else wide", () => {
    expect(defaultRunsFilter("main")).toEqual({
      fleet: "main",
      outcome: "all",
      query: "",
      range: "all",
    });
  });

  test("falls back to all fleets when no fleet is open", () => {
    // Scoping to a fleet nobody named would hide every row behind a filter the
    // operator has no way to satisfy.
    expect(defaultRunsFilter(null).fleet).toBe(ALL_FLEETS);
  });
});

describe("fleetOptions", () => {
  const ids = (runs: RunLike[], current: string | null, label?: string | null): string[] =>
    fleetOptions(runs, current, label).map((f) => f.id);

  test("puts the current fleet first, then the rest by id", () => {
    const runs = [run({ fleet: "sg7k2m4p" }), run({ fleet: "aux00001" }), run({ fleet: "fxtr0001" })];
    expect(ids(runs, "fxtr0001")).toEqual(["fxtr0001", "aux00001", "sg7k2m4p"]);
  });

  test("includes the current fleet even when it has no runs yet", () => {
    expect(ids([run({ fleet: "sg7k2m4p" })], "fxtr0001")).toEqual(["fxtr0001", "sg7k2m4p"]);
  });

  test("labels each option with the alias its rows carried, else the id", () => {
    const runs = [run({ fleet: "sg7k2m4p", fleet_name: "staging" }), run({ fleet: "aux00001" })];
    expect(fleetOptions(runs, "fxtr0001", "main")).toEqual([
      { id: "fxtr0001", label: "main" },
      { id: "aux00001", label: "aux00001" },
      { id: "sg7k2m4p", label: "staging" },
    ]);
  });

  test("offers the unknown bucket only when some row is unattributed", () => {
    expect(ids([run({ fleet: "fxtr0001" })], "fxtr0001")).toEqual(["fxtr0001"]);
    expect(ids([run({ fleet: "fxtr0001" }), run({ fleet: null })], "fxtr0001")).toEqual([
      "fxtr0001",
      UNKNOWN_FLEET,
    ]);
  });

  test("does not invent a fleet for null rows when none is open", () => {
    expect(ids([run({ fleet: null })], null)).toEqual([UNKNOWN_FLEET]);
  });

  test("de-duplicates", () => {
    const runs = [run({ fleet: "fxtr0001" }), run({ fleet: "fxtr0001" })];
    expect(ids(runs, "fxtr0001")).toEqual(["fxtr0001"]);
  });
});

describe("matchesRunsFilter", () => {
  const base = defaultRunsFilter("main");

  test("the default filter keeps this fleet's rows and drops the unattributed ones", () => {
    expect(matchesRunsFilter(run({ fleet: "main" }), base, NOW)).toBe(true);
    // Not this fleet's history: nobody knows whose it is, and the scope says
    // "fleet main". The unknown bucket is where it can be found.
    expect(matchesRunsFilter(run({ fleet: null }), base, NOW)).toBe(false);
  });

  test("the default filter drops another fleet's rows", () => {
    expect(matchesRunsFilter(run({ fleet: "staging" }), base, NOW)).toBe(false);
  });

  test("a fleet scope compares fleet_id, never the alias the row carried", () => {
    // The alias `staging` has since been moved onto this fleet; the row is
    // still `sg7k2m4p`'s, and scoping to `sg7k2m4p` is what finds it.
    const row = run({ fleet: "sg7k2m4p", fleet_name: "staging" });
    expect(matchesRunsFilter(row, { ...base, fleet: "sg7k2m4p" }, NOW)).toBe(true);
    expect(matchesRunsFilter(row, { ...base, fleet: "staging" }, NOW)).toBe(false);
  });

  test("the unknown bucket is exactly the rows that name no fleet", () => {
    const unknown: RunsFilter = { ...base, fleet: UNKNOWN_FLEET };
    expect(matchesRunsFilter(run({ fleet: null }), unknown, NOW)).toBe(true);
    expect(matchesRunsFilter(run({ fleet: "main" }), unknown, NOW)).toBe(false);
  });

  test("ALL_FLEETS keeps everything", () => {
    const all: RunsFilter = { ...base, fleet: ALL_FLEETS };
    expect(matchesRunsFilter(run({ fleet: "staging" }), all, NOW)).toBe(true);
    expect(matchesRunsFilter(run({ fleet: null }), all, NOW)).toBe(true);
  });

  test("outcome narrows to one kind of ending", () => {
    const failed: RunsFilter = { ...base, outcome: "failed" };
    expect(matchesRunsFilter(run({ exit_code: 1 }), failed, NOW)).toBe(true);
    expect(matchesRunsFilter(run({ exit_code: 0 }), failed, NOW)).toBe(false);
    expect(matchesRunsFilter(run({ exit_code: null }), failed, NOW)).toBe(false);
  });

  test("search reads the command line, case-insensitively", () => {
    const q: RunsFilter = { ...base, query: "CREATE alpha" };
    expect(matchesRunsFilter(run({ command: "agent create", args: ["alpha"] }), q, NOW)).toBe(true);
    expect(matchesRunsFilter(run({ command: "agent destroy", args: ["alpha"] }), q, NOW)).toBe(false);
  });

  test("search also reads the agent and both spellings of the fleet", () => {
    const all = { ...base, fleet: ALL_FLEETS };
    expect(matchesRunsFilter(run({ agent: "quill" }), { ...all, query: "quill" }, NOW)).toBe(true);
    const row = run({ fleet: "sg7k2m4p", fleet_name: "staging" });
    // The id it is keyed on, and the alias the operator remembers typing.
    expect(matchesRunsFilter(row, { ...all, query: "sg7k2m4p" }, NOW)).toBe(true);
    expect(matchesRunsFilter(row, { ...all, query: "staging" }, NOW)).toBe(true);
  });

  test("whitespace-only search narrows nothing", () => {
    expect(matchesRunsFilter(run(), { ...base, query: "   " }, NOW)).toBe(true);
  });

  test("range is measured from started_at", () => {
    const hour: RunsFilter = { ...base, range: "1h" };
    // 11:00 against a 12:00 now is exactly on the boundary, and inclusive.
    expect(matchesRunsFilter(run({ started_at: "2026-09-07T11:00:00.000Z" }), hour, NOW)).toBe(true);
    expect(matchesRunsFilter(run({ started_at: "2026-09-07T10:59:59.000Z" }), hour, NOW)).toBe(false);
    expect(matchesRunsFilter(run({ started_at: "2026-09-01T11:00:00.000Z" }), hour, NOW)).toBe(false);
  });

  test("a row whose timestamp will not parse is kept, not hidden", () => {
    const hour: RunsFilter = { ...base, range: "1h" };
    expect(matchesRunsFilter(run({ started_at: "not a date" }), hour, NOW)).toBe(true);
  });

  test("every declared range is one the matcher understands", () => {
    for (const range of RUN_RANGES) {
      const filter: RunsFilter = { ...base, fleet: ALL_FLEETS, range: range.id };
      // "all time" keeps an ancient row; every bounded window drops it.
      const ancient = run({ started_at: "2020-01-01T00:00:00.000Z" });
      expect(matchesRunsFilter(ancient, filter, NOW)).toBe(range.ms === null);
    }
  });
});

describe("filterRuns", () => {
  test("preserves the order it was given", () => {
    const runs = [
      run({ command: "a", fleet: "main" }),
      run({ command: "b", fleet: "staging" }),
      run({ command: "c", fleet: "main" }),
    ];
    expect(filterRuns(runs, defaultRunsFilter("main"), NOW).map((r) => r.command)).toEqual(["a", "c"]);
  });

  test("a fleet's history is the same list whoever is reading it", () => {
    // What the collapse rule broke: the unattributed row moved between fleets
    // depending on who was looking, so no two readings of the log agreed. The
    // matcher can no longer see which fleet is open — it takes no such argument.
    const runs = [run({ command: "a", fleet: "fxtr0001" }), run({ command: "b", fleet: null })];
    const scoped = { ...defaultRunsFilter("fxtr0001"), fleet: "fxtr0001" };
    expect(filterRuns(runs, scoped, NOW).map((r) => r.command)).toEqual(["a"]);
    const unknown = { ...scoped, fleet: UNKNOWN_FLEET };
    expect(filterRuns(runs, unknown, NOW).map((r) => r.command)).toEqual(["b"]);
  });
});

describe("hasActiveRunsFilter", () => {
  test("the state the section opens in is not an active filter", () => {
    expect(hasActiveRunsFilter(defaultRunsFilter("main"), "main")).toBe(false);
    expect(hasActiveRunsFilter(defaultRunsFilter(null), null)).toBe(false);
  });

  test("widening past the opening scope counts, so Clear has something to do", () => {
    expect(hasActiveRunsFilter({ ...defaultRunsFilter("main"), fleet: ALL_FLEETS }, "main")).toBe(true);
  });

  test("every other control counts", () => {
    const base = defaultRunsFilter("main");
    expect(hasActiveRunsFilter({ ...base, outcome: "failed" }, "main")).toBe(true);
    expect(hasActiveRunsFilter({ ...base, range: "24h" }, "main")).toBe(true);
    expect(hasActiveRunsFilter({ ...base, query: "create" }, "main")).toBe(true);
    expect(hasActiveRunsFilter({ ...base, query: "  " }, "main")).toBe(false);
  });
});

describe("describeRunsFilter", () => {
  test("names the fleet whenever the list is scoped", () => {
    expect(describeRunsFilter(3, 3, defaultRunsFilter("main"), "main")).toBe("3 runs · fleet main");
  });

  test("says so when rows are being hidden", () => {
    expect(describeRunsFilter(2, 9, defaultRunsFilter("main"), "main")).toBe(
      "2 of 9 runs · fleet main",
    );
  });

  test("says all fleets when nothing is scoping", () => {
    const filter = { ...defaultRunsFilter("main"), fleet: ALL_FLEETS };
    expect(describeRunsFilter(9, 9, filter, "main")).toBe("9 runs · all fleets");
  });

  test("singular for one", () => {
    expect(describeRunsFilter(1, 1, defaultRunsFilter("main"), "main")).toBe("1 run · fleet main");
  });

  test("an empty log says so rather than counting to zero", () => {
    expect(describeRunsFilter(0, 0, defaultRunsFilter("main"), "main")).toBe(
      "no runs recorded · fleet main",
    );
  });

  test("names the unknown bucket as what it is rather than as a fleet", () => {
    const filter = { ...defaultRunsFilter("main"), fleet: UNKNOWN_FLEET };
    expect(describeRunsFilter(2, 9, filter, "main")).toBe("2 of 9 runs · no fleet recorded");
  });

  test("says outright when the scope is a fleet other than the one open", () => {
    const filter = { ...defaultRunsFilter("main"), fleet: "staging" };
    expect(describeRunsFilter(4, 9, filter, "main")).toBe(
      "4 of 9 runs · fleet staging · not the fleet you are on",
    );
  });

  test("does not claim a mismatch when no fleet is open", () => {
    const filter = { ...defaultRunsFilter(null), fleet: "staging" };
    expect(describeRunsFilter(1, 1, filter, null)).toBe("1 run · fleet staging");
  });

  test("names the scope as the operator sees it, while scoping by id", () => {
    const filter = { ...defaultRunsFilter("fxtr0001"), fleet: "sg7k2m4p" };
    expect(describeRunsFilter(4, 9, filter, "fxtr0001", "staging")).toBe(
      "4 of 9 runs · fleet staging · not the fleet you are on",
    );
    // No alias to show: the id is what that fleet is called (§4.6).
    expect(describeRunsFilter(4, 9, filter, "fxtr0001", null)).toBe(
      "4 of 9 runs · fleet sg7k2m4p · not the fleet you are on",
    );
  });
});
