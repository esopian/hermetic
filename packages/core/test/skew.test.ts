/**
 * §6.6 version skew: the comparison, its severities, and the counts each one
 * reports. Pure — no backend, no clock, no fixtures.
 */
import { describe, expect, test } from "bun:test";
import { computeSkew, configVerdict, counts } from "../src/fleet/skew.ts";
import type { SkewAgent } from "../src/fleet/skew.ts";
import { SKEW_FIX, SKEW_MESSAGE } from "../src/schema/skew.ts";

const agent = (over: Partial<SkewAgent> = {}): SkewAgent => ({
  status: "ready",
  current: true,
  config: "current",
  ...over,
});

describe("configVerdict", () => {
  test("agreement is current, disagreement is drift", () => {
    expect(configVerdict({ config_hash: "a", applied_config_hash: "a" })).toBe("current");
    expect(configVerdict({ status: "ready", config_hash: "a", applied_config_hash: "a" })).toBe(
      "current",
    );
    expect(configVerdict({ config_hash: "b", applied_config_hash: "a" })).toBe("drifted");
  });

  test("a missing half is unknown, never a guess in either direction", () => {
    // The row predates the field, or the box has not reported since it was
    // created. Both would be reported as agreement by a naive comparison, which
    // is the one way this could actively mislead.
    expect(configVerdict({ config_hash: "a" })).toBe("unknown");
    expect(configVerdict({ applied_config_hash: "a" })).toBe("unknown");
    expect(configVerdict({ config_hash: null, applied_config_hash: null })).toBe("unknown");
    expect(configVerdict({})).toBe("unknown");
  });
});

describe("counts", () => {
  test("tombstones and boxes that do not exist yet take no part", () => {
    expect(counts("destroyed")).toBe(false);
    expect(counts("creating")).toBe(false);
    /**
     * `recreate` sets the row's `hermeticd_version` and `config_hash` to what it
     * just pinned and clears `last_heartbeat`, then parks the row here while the
     * replacement boots. Every version fact on that row is the laptop's
     * intention, not the box's report — so counting it either way is answering
     * for a machine that has not spoken.
     */
    expect(counts("bootstrapping")).toBe(false);
    expect(counts("ready")).toBe(true);
    expect(counts("stopped")).toBe(true);
    expect(counts("error")).toBe(true);
  });
});

describe("computeSkew", () => {
  test("a fleet this build agrees with says nothing at all", () => {
    const skew = computeSkew({
      fleetVersion: 2,
      expectedVersion: 2,
      toolOutdated: false,
      updateAvailable: false,
      agents: [agent(), agent()],
    });
    expect(skew.severity).toBe("none");
    expect(skew.message).toBe("");
    expect(skew.agents_affected).toBe(0);
    expect(skew.fix).toBeNull();
  });

  test("a fleet behind this build is degraded, and every live agent is affected", () => {
    const skew = computeSkew({
      fleetVersion: 1,
      expectedVersion: 2,
      toolOutdated: false,
      updateAvailable: true,
      agents: [agent(), agent({ status: "stopped" }), agent({ status: "destroyed" })],
    });
    expect(skew.severity).toBe("degraded");
    expect(skew.message).toBe(SKEW_MESSAGE.degraded);
    expect(skew.headline).toBe("fleet foundation v1 · this build expects v2");
    // The foundation is a property of the fleet, so an agent whose own versions
    // have not moved is affected by it too. The tombstone is not.
    expect(skew.agents_affected).toBe(2);
    expect(skew.fix).toBe(SKEW_FIX);
  });

  test("a fleet ahead of this build is blocked, and offers no command", () => {
    const skew = computeSkew({
      fleetVersion: 3,
      expectedVersion: 2,
      toolOutdated: true,
      updateAvailable: false,
      agents: [agent()],
    });
    expect(skew.severity).toBe("blocked");
    // `foundation.update` is exactly the command that refuses here, so pointing
    // at it would point at a button that cannot work.
    expect(skew.fix).toBeNull();
    expect(skew.headline).toContain("only knows v2");
  });

  test("blocked wins over an available update", () => {
    const skew = computeSkew({
      fleetVersion: 3,
      expectedVersion: 2,
      toolOutdated: true,
      updateAvailable: true,
      agents: [agent({ current: false })],
    });
    expect(skew.severity).toBe("blocked");
  });

  test("a current fleet with agents still catching up is pending, not degraded", () => {
    const skew = computeSkew({
      fleetVersion: 2,
      expectedVersion: 2,
      toolOutdated: false,
      updateAvailable: false,
      agents: [agent(), agent({ current: false }), agent({ config: "drifted" })],
    });
    expect(skew.severity).toBe("pending");
    expect(skew.message).toBe(SKEW_MESSAGE.pending);
    expect(skew.agents_behind).toBe(1);
    expect(skew.agents_drifted).toBe(1);
    expect(skew.agents_affected).toBe(2);
    // Nothing for the operator to run: the runners take the release themselves.
    expect(skew.fix).toBeNull();
  });

  test("an agent that is both behind and drifted is one agent, not two", () => {
    const skew = computeSkew({
      fleetVersion: 2,
      expectedVersion: 2,
      toolOutdated: false,
      updateAvailable: false,
      agents: [agent({ current: false, config: "drifted" })],
    });
    expect(skew.agents_behind).toBe(1);
    expect(skew.agents_drifted).toBe(1);
    expect(skew.agents_affected).toBe(1);
    expect(skew.headline).toContain("1 agent has");
  });

  test("an unknown config is never counted as drift", () => {
    const skew = computeSkew({
      fleetVersion: 2,
      expectedVersion: 2,
      toolOutdated: false,
      updateAvailable: false,
      agents: [agent({ config: "unknown" }), agent({ config: "unknown" })],
    });
    expect(skew.severity).toBe("none");
    expect(skew.agents_drifted).toBe(0);
  });

  test("a fleet with no agents can still be degraded", () => {
    // The foundation is the fleet's, not the agents'. An empty fleet on an old
    // contract still creates agents from built-in defaults.
    const skew = computeSkew({
      fleetVersion: 0,
      expectedVersion: 2,
      toolOutdated: false,
      updateAvailable: true,
      agents: [],
    });
    expect(skew.severity).toBe("degraded");
    expect(skew.agents_affected).toBe(0);
  });
});

describe("current is tri-state", () => {
  /**
   * The regression that made this field tri-state. `stop` clears
   * `last_heartbeat` (`lifecycle.ts`) and `stopped` is a *counted* status —
   * deliberately, because a fleet-wide foundation skew affects a powered-off
   * agent as much as a running one. So once `foundation.status` stopped
   * answering `current` from a row nobody had reported on, a boolean forced
   * that answer to be `false`, and every stopped box was counted as a
   * straggler on the "agents have not caught up" line.
   */
  test("an agent that has reported nothing is not counted as behind", () => {
    const skew = computeSkew({
      fleetVersion: 2,
      expectedVersion: 2,
      toolOutdated: false,
      updateAvailable: false,
      agents: [
        agent({ current: true }),
        agent({ status: "stopped", current: null }),
        agent({ status: "bootstrapping", current: null }),
      ],
    });
    expect(skew.agents_behind).toBe(0);
    expect(skew.severity).toBe("none");
  });

  test("but an agent that reported an older release still is", () => {
    const skew = computeSkew({
      fleetVersion: 2,
      expectedVersion: 2,
      toolOutdated: false,
      updateAvailable: false,
      agents: [agent({ current: false }), agent({ status: "stopped", current: null })],
    });
    expect(skew.agents_behind).toBe(1);
    expect(skew.severity).toBe("pending");
  });

  /**
   * And the half that must not change: `counts()` still admits `stopped`, so a
   * fleet-wide foundation skew is reported as affecting it. Being off is not a
   * reason to be told your fleet's foundation is out of date any less.
   */
  test("a stopped agent is still affected by a fleet-wide foundation skew", () => {
    const skew = computeSkew({
      fleetVersion: 1,
      expectedVersion: 2,
      toolOutdated: false,
      updateAvailable: true,
      agents: [agent({ current: true }), agent({ status: "stopped", current: null })],
    });
    expect(skew.severity).toBe("degraded");
    expect(skew.agents_affected).toBe(2);
    expect(skew.agents_behind).toBe(0);
  });
});

describe("configVerdict declines to answer for a box that is not reporting", () => {
  /**
   * The case this closed. A bootstrap stage writes
   * `/etc/hermetic/manifest.json` before `04-apply` runs — the ordering §6.5's
   * converge no longer uses, kept on the stage path because there the truth is
   * carried by the status. So a box whose apply failed sits in `error` holding
   * a manifest naming the config it was installing, its heartbeat reports that
   * hash, and the two agree: a green `current` beside a box broken in exactly
   * the way this field exists to reveal.
   */
  test("an error box does not report its config as current", () => {
    expect(configVerdict({ status: "error", config_hash: "a", applied_config_hash: "a" })).toBe(
      "unknown",
    );
    // Not "drifted" either — that would be a claim too, and about a box whose
    // own account of itself is what is in doubt.
    expect(configVerdict({ status: "error", config_hash: "b", applied_config_hash: "a" })).toBe(
      "unknown",
    );
  });

  test("nor does a box that does not exist yet, or no longer does", () => {
    for (const status of ["creating", "bootstrapping", "destroyed"] as const) {
      expect(configVerdict({ status, config_hash: "a", applied_config_hash: "a" })).toBe("unknown");
    }
  });

  /**
   * A winding-down box is still up and still heartbeating, and what it reports
   * stays true until it stops. Declining here would throw away a real answer.
   */
  test("but a box on its way down is still answering", () => {
    for (const status of ["stopping", "destroying", "degraded"] as const) {
      expect(configVerdict({ status, config_hash: "a", applied_config_hash: "a" })).toBe("current");
    }
  });

  /**
   * A caller with no status still gets the hash comparison — `configVerdict` is
   * used on shapes that carry only the two hashes, and demanding a status would
   * make those callers invent one.
   */
  test("a caller that names no status gets the comparison it asked for", () => {
    expect(configVerdict({ config_hash: "b", applied_config_hash: "a" })).toBe("drifted");
  });
});
