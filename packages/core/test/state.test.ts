import { describe, expect, test } from "bun:test";
import type { Agent, AgentStatus } from "../src/schema/index.ts";
import { AGENT_STATUSES } from "../src/schema/index.ts";
import {
  BOOTSTRAP_STALE_MS,
  HEARTBEAT_INTERVAL_MS,
  TRANSITIONS,
  UNREACHABLE_INTERVALS,
  allStatusPairs,
  assertTransition,
  canTransition,
  deriveDisplayStatus,
  heartbeatAgeMs,
  isReentry,
} from "../src/agents/state.ts";
import { HermeticError } from "../src/errors.ts";

/** The §4.3 diagram, restated independently of `TRANSITIONS` itself. */
const ALLOWED = new Set<string>([
  // creating → bootstrapping → ready, once every stage is ok
  "creating>bootstrapping",
  "bootstrapping>ready",
  "bootstrapping>degraded",
  // ready ⇄ degraded
  "ready>degraded",
  "degraded>ready",
  // ready → stopping → stopped → (start) → bootstrapping
  "ready>stopping",
  "degraded>stopping",
  "stopping>stopped",
  "stopped>bootstrapping",
  // any → destroying → destroyed
  "creating>destroying",
  "bootstrapping>destroying",
  "ready>destroying",
  "degraded>destroying",
  "stopping>destroying",
  "stopped>destroying",
  "destroying>destroyed",
  "error>destroying",
  // any → error
  "creating>error",
  "bootstrapping>error",
  "ready>error",
  "degraded>error",
  "stopping>error",
  "stopped>error",
  "destroying>error",
  // `agent rerun`, or a recreate, out of error
  "error>bootstrapping",
]);

describe("transition table", () => {
  for (const [from, to] of allStatusPairs()) {
    const key = `${from}>${to}`;
    const expected = ALLOWED.has(key);
    test(`${from} → ${to} is ${expected ? "allowed" : "rejected"}`, () => {
      expect(canTransition(from, to)).toBe(expected);
      if (expected) {
        expect(() => assertTransition(from, to)).not.toThrow();
      } else {
        expect(() => assertTransition(from, to)).toThrow(HermeticError);
        try {
          assertTransition(from, to);
        } catch (e) {
          expect((e as HermeticError).code).toBe("INVALID_TRANSITION");
        }
      }
    });
  }

  test("no status transitions to itself", () => {
    for (const s of AGENT_STATUSES) expect(canTransition(s, s)).toBe(false);
  });

  test("destroyed is terminal", () => {
    expect(TRANSITIONS.destroyed).toEqual([]);
  });

  test("every status has an entry", () => {
    for (const s of AGENT_STATUSES) expect(TRANSITIONS[s]).toBeDefined();
  });
});

/**
 * §4.5: being asked to move a row to the status it already holds means our
 * picture of it was stale, not that the request was wrong — so every status
 * re-enters, and the response is to adopt reality and carry on. That is a
 * different thing from a self-edge in the §4.3 diagram, which is why `isReentry`
 * lives next to `canTransition` rather than inside it.
 */
describe("re-entry", () => {
  test("every status re-enters itself", () => {
    for (const s of AGENT_STATUSES) expect(isReentry(s, s)).toBe(true);
  });

  test("destroying re-enters, which is what unwedges a failed destroy", () => {
    // The reported wedge: destroy terminated the instance, then DeleteVolume was
    // refused because the volume had not finished detaching. The row stayed in
    // `destroying`, and every retry died on the transition rather than on the
    // volume.
    expect(canTransition("destroying", "destroying")).toBe(false);
    expect(isReentry("destroying", "destroying")).toBe(true);
    expect(isReentry("destroying", "destroyed")).toBe(false);
  });

  test("destroyed re-enters too, and is still terminal", () => {
    // §6.6: re-entering `destroyed` is a no-op on a row that is already gone,
    // not a resurrection — the table still has no edge out of it.
    expect(isReentry("destroyed", "destroyed")).toBe(true);
    expect(TRANSITIONS.destroyed).toEqual([]);
  });

  test("re-entry never covers a move between two statuses", () => {
    for (const [from, to] of allStatusPairs()) {
      if (from === to) continue;
      expect(isReentry(from, to)).toBe(false);
    }
  });

  test("the §4.3 matrix still has no self-edges", () => {
    // Re-entry is not an edge: nothing moved, so nothing is asserted and no
    // history event is written.
    for (const s of AGENT_STATUSES) expect(canTransition(s, s)).toBe(false);
  });
});

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const THRESHOLD = HEARTBEAT_INTERVAL_MS * UNREACHABLE_INTERVALS;

function row(
  status: AgentStatus,
  heartbeatAgo: number | null,
  updatedAgo = 0,
): Pick<Agent, "status" | "last_heartbeat" | "updated_at"> {
  return {
    status,
    last_heartbeat: heartbeatAgo === null ? null : new Date(NOW - heartbeatAgo).toISOString(),
    updated_at: new Date(NOW - updatedAgo).toISOString(),
  };
}

describe("deriveDisplayStatus", () => {
  test("exactly three intervals is still reachable", () => {
    expect(deriveDisplayStatus(row("ready", THRESHOLD), NOW)).toBe("ready");
  });

  test("three intervals plus one millisecond is unreachable", () => {
    expect(deriveDisplayStatus(row("ready", THRESHOLD + 1), NOW)).toBe("unreachable");
  });

  test("a fresh heartbeat keeps the stored status", () => {
    expect(deriveDisplayStatus(row("degraded", 1_000), NOW)).toBe("degraded");

    expect(deriveDisplayStatus(row("bootstrapping", 1_000), NOW)).toBe("bootstrapping");
  });

  test("a stale heartbeat masks every heartbeat-expecting status", () => {
    for (const s of ["ready", "degraded"] as const) {
      expect(deriveDisplayStatus(row(s, THRESHOLD + 1), NOW)).toBe("unreachable");
    }
    // `bootstrapping` is judged on the bootstrap clock instead — see below.
    expect(deriveDisplayStatus(row("bootstrapping", THRESHOLD + 1), NOW)).toBe("bootstrapping");
  });

  test("statuses that do not heartbeat are never unreachable", () => {
    for (const s of ["creating", "stopping", "stopped", "destroying", "destroyed", "error"] as const) {
      expect(deriveDisplayStatus(row(s, THRESHOLD * 100), NOW)).toBe(s);
      expect(deriveDisplayStatus(row(s, null), NOW)).toBe(s);
    }
  });

  test("a missing heartbeat is graced until updated_at ages past the threshold", () => {
    expect(deriveDisplayStatus(row("degraded", null, 0), NOW)).toBe("degraded");
    expect(deriveDisplayStatus(row("degraded", null, THRESHOLD), NOW)).toBe("degraded");
    expect(deriveDisplayStatus(row("degraded", null, THRESHOLD + 1), NOW)).toBe("unreachable");
  });

  /**
   * A boot is not a heartbeat, and judging it as one is how `agent ps` came to
   * report `unreachable` for a box that was in the middle of building the
   * Hermes SPA. During `bootstrapping` the writer is the stage runner, the
   * signal is `bootstrap.updated_at`, and the bound is ten minutes rather than
   * ninety seconds — a stage is allowed to take a while.
   */
  describe("while bootstrapping", () => {
    const booting = (bootstrapAgo: number | null, updatedAgo = BOOTSTRAP_STALE_MS * 2) => ({
      ...row("bootstrapping", null, updatedAgo),
      bootstrap:
        bootstrapAgo === null
          ? null
          : ({
              hermeticd_version: "0.1.0",
              stages: [],
              current: "04-apply",
              started_at: new Date(NOW - BOOTSTRAP_STALE_MS * 2).toISOString(),
              updated_at: new Date(NOW - bootstrapAgo).toISOString(),
            } satisfies Agent["bootstrap"]),
    });

    test("a fresh bootstrap write keeps it bootstrapping, however old the row is", () => {
      expect(deriveDisplayStatus(booting(1_000), NOW)).toBe("bootstrapping");
      expect(deriveDisplayStatus(booting(BOOTSTRAP_STALE_MS), NOW)).toBe("bootstrapping");
    });

    test("a stage that has said nothing for longer than the bound is unreachable", () => {
      expect(deriveDisplayStatus(booting(BOOTSTRAP_STALE_MS + 1), NOW)).toBe("unreachable");
    });

    test("a long stage outlives the heartbeat threshold without being called dead", () => {
      expect(deriveDisplayStatus(booting(THRESHOLD * 2), NOW)).toBe("bootstrapping");
    });

    test("with no bootstrap state yet it falls back to the row's own updated_at", () => {
      expect(deriveDisplayStatus(booting(null, 1_000), NOW)).toBe("bootstrapping");
      expect(deriveDisplayStatus(booting(null, BOOTSTRAP_STALE_MS + 1), NOW)).toBe("unreachable");
    });

    test("a heartbeat that has started counts as the box speaking", () => {
      const row_ = {
        ...booting(BOOTSTRAP_STALE_MS + 1),
        last_heartbeat: new Date(NOW - 1_000).toISOString(),
      };
      expect(deriveDisplayStatus(row_, NOW)).toBe("bootstrapping");
    });
  });

  test("a custom interval moves the boundary", () => {
    const interval = 5_000;
    expect(deriveDisplayStatus(row("ready", 15_000), NOW, interval)).toBe("ready");
    expect(deriveDisplayStatus(row("ready", 15_001), NOW, interval)).toBe("unreachable");
  });

  test("an unparseable heartbeat is treated as missing", () => {
    expect(
      deriveDisplayStatus(
        { status: "ready", last_heartbeat: "nonsense", updated_at: new Date(NOW).toISOString() },
        NOW,
      ),
    ).toBe("ready");
  });
});

describe("heartbeatAgeMs", () => {
  test("is null when there is no heartbeat", () => {
    expect(heartbeatAgeMs({ last_heartbeat: null }, NOW)).toBeNull();
  });

  test("is the elapsed milliseconds otherwise", () => {
    expect(heartbeatAgeMs({ last_heartbeat: new Date(NOW - 4_000).toISOString() }, NOW)).toBe(4_000);
  });
});
