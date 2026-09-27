/**
 * §5's pure pieces: the phase list the re-network drawer seeds its rail with,
 * and the rules the Foundation section reads a `NetworkReport` by.
 *
 * The rule every case here is really about: a fleet that has never recorded a
 * network mode is not a `public` fleet. Absence and `public` are different
 * answers, and the whole reason the v6 migration exists is that one build read
 * the first as the second.
 */
import { describe, expect, test } from "bun:test";
import {
  applyGate,
  driftedAgents,
  networkFactRows,
  networkModeLine,
  renetworkAvailable,
  renetworkTarget,
} from "../src/logic/network-logic.ts";
import type { NetworkFacts } from "../src/logic/network-logic.ts";
import { networkPhases, phaseLabel } from "../src/lib/useOp.ts";

/**
 * The UI cannot import core (§3.1), so this list is spelled twice: here and in
 * `packages/core/src/network.ts`'s `PHASE`, which is the source of truth. If
 * core reorders or renames a phase, this fails — and the drawer's rail would
 * otherwise have shown steps the op never emits.
 */
const CORE_PHASES = ["preflight", "archive", "stack", "stamp", "drift", "done"];

function report(over: Partial<NetworkFacts> = {}): NetworkFacts {
  return {
    mode: "nat",
    stack_mode: "nat",
    consistent: true,
    egress_ip: "203.0.113.10",
    nat: {
      instance_id: "i-nat0",
      instance_state: "running",
      egress_ip: "203.0.113.10",
      route_state: "active",
    },
    agents: [{ name: "atlas", placement: "matches" }],
    drifted: 0,
    ...over,
  };
}

describe("networkPhases", () => {
  test("is core's list, in core's order", () => {
    expect(networkPhases()).toEqual(CORE_PHASES);
  });

  test("every phase renders as something, even the two nothing else emits", () => {
    for (const p of networkPhases()) expect(phaseLabel(p).length).toBeGreaterThan(0);
  });
});

describe("networkModeLine", () => {
  test("names each mode", () => {
    expect(networkModeLine("public").text).toContain("public");
    expect(networkModeLine("public").unrecorded).toBe(false);
    expect(networkModeLine("nat").text).toContain("nat");
    expect(networkModeLine("nat").unrecorded).toBe(false);
  });

  test("an absent mode is `unrecorded`, never `public`", () => {
    for (const absent of [null, undefined]) {
      const line = networkModeLine(absent);
      expect(line.unrecorded).toBe(true);
      expect(line.text).toContain("unrecorded");
      expect(line.text).toContain("foundation update");
      expect(line.text.startsWith("public")).toBe(false);
    }
  });
});

describe("renetworkTarget", () => {
  test("is the other mode", () => {
    expect(renetworkTarget("public")).toBe("nat");
    expect(renetworkTarget("nat")).toBe("public");
  });

  test("is null when the stack did not say — there is no other mode to move to", () => {
    expect(renetworkTarget(null)).toBe(null);
    expect(renetworkTarget(undefined)).toBe(null);
  });
});

describe("networkFactRows", () => {
  test("a healthy nat fleet reports its egress ip, its appliance and its route, none bad", () => {
    const rows = networkFactRows(report());
    expect(rows.map((r) => r.k)).toEqual([
      "egress ip",
      "nat instance",
      "private route",
      "agent placement",
    ]);
    expect(rows.every((r) => !r.bad)).toBe(true);
    expect(rows[0]?.v).toBe("203.0.113.10");
  });

  test("a public fleet reports no NAT rows at all", () => {
    const rows = networkFactRows(
      report({ mode: "public", stack_mode: "public", egress_ip: null, nat: null }),
    );
    expect(rows.map((r) => r.k)).toEqual(["agent placement"]);
  });

  test("a disagreement with the stack leads, and is marked bad", () => {
    const rows = networkFactRows(report({ mode: "public", consistent: false }));
    expect(rows[0]?.k).toBe("stack says");
    expect(rows[0]?.bad).toBe(true);
    expect(rows[0]?.v).toContain("nat");
  });

  test("a blackholed route and a stopped instance are both bad", () => {
    const rows = networkFactRows(
      report({
        nat: {
          instance_id: "i-nat0",
          instance_state: "stopped",
          egress_ip: "203.0.113.10",
          route_state: "blackhole",
        },
      }),
    );
    expect(rows.find((r) => r.k === "nat instance")?.bad).toBe(true);
    expect(rows.find((r) => r.k === "private route")?.bad).toBe(true);
  });

  test("stranded agents are counted and named", () => {
    const r = report({
      agents: [
        { name: "atlas", placement: "drifted" },
        { name: "borg", placement: "matches" },
        { name: "cinder", placement: "unknown" },
      ],
      drifted: 1,
    });
    expect(networkFactRows(r).find((x) => x.k === "agent placement")?.bad).toBe(true);
    expect(driftedAgents(r)).toEqual(["atlas"]);
  });
});

describe("renetworkAvailable", () => {
  test("offered on a fleet whose stack says which mode it is in", () => {
    const gate = renetworkAvailable({ report: report(), updateInProgress: false });
    expect(gate.allowed).toBe(true);
    expect(gate.reason).toContain("public");
  });

  test("refused while a foundation update holds the _fleet lock", () => {
    const gate = renetworkAvailable({ report: report(), updateInProgress: true });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("lock");
  });

  test("refused while the status read is still out", () => {
    expect(renetworkAvailable({ report: null, updateInProgress: false }).allowed).toBe(false);
  });

  test("refused when the stack carries no Network parameter", () => {
    const gate = renetworkAvailable({
      report: report({ mode: null, stack_mode: null, consistent: false }),
      updateInProgress: false,
    });
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain("foundation update");
  });
});

describe("applyGate", () => {
  test("closed until the plan is read and the consequences acknowledged", () => {
    expect(applyGate({ plan: null, acknowledged: true, starting: false }).allowed).toBe(false);
    const unchecked = applyGate({ plan: { steps: [1, 2] }, acknowledged: false, starting: false });
    expect(unchecked.allowed).toBe(false);
    expect(unchecked.reason).toContain("acknowledge");
  });

  test("open once both hold, and says what it would do", () => {
    const gate = applyGate({ plan: { steps: [1, 2, 3] }, acknowledged: true, starting: false });
    expect(gate.allowed).toBe(true);
    expect(gate.reason).toContain("3 steps");
  });

  test("closed again while the apply is in flight, so it cannot be sent twice", () => {
    expect(applyGate({ plan: { steps: [1] }, acknowledged: true, starting: true }).allowed).toBe(false);
  });
});
