/**
 * §6.6 version skew, the portal's half: which band is drawn, what may be
 * dismissed, and what the marks beside individual versions say.
 */
import { describe, expect, test } from "bun:test";
import {
  agentBand,
  configHashView,
  hermesRunningNote,
  configLabel,
  configOf,
  dismissKey,
  fleetBand,
  foundationMark,
  hermeticdMark,
} from "../src/logic/skew-logic.ts";
import type { SkewStatusView, SkewSeverity } from "../src/logic/skew-logic.ts";

const status = (
  severity: SkewSeverity,
  over: Partial<SkewStatusView> = {},
  skewOver: Record<string, unknown> = {},
): SkewStatusView => ({
  skew: {
    severity,
    headline: "fleet foundation v1 · this build expects v2",
    message: "some things will not behave as expected until the fleet is updated",
    fleet_version: 1,
    expected_version: 2,
    agents_behind: 0,
    agents_drifted: 0,
    agents_affected: 2,
    fix: severity === "degraded" ? "hermetic foundation update" : null,
    ...skewOver,
  } as SkewStatusView["skew"],
  agents: [
    { name: "pink-otter", current: true, config: "drifted", hermeticd_version: "0.5.0" },
    { name: "amber-hawk", current: false, config: "current", hermeticd_version: "0.4.1" },
    { name: "lime-panther", current: true, config: "current", hermeticd_version: "0.5.0" },
  ],
  available: { hermeticd_version: "0.5.0" },
  ...over,
});

describe("fleetBand", () => {
  test("nothing to say when the fleet and this build agree", () => {
    expect(fleetBand(status("none"))).toBeNull();
  });

  test("nothing to say when the server reported no skew at all", () => {
    // An older server, or a `/api/meta` whose `_fleet` read failed. Guessing in
    // that gap would either invent a warning or suppress a real one.
    expect(fleetBand({ agents: [] })).toBeNull();
    expect(fleetBand(null)).toBeNull();
    expect(fleetBand(undefined)).toBeNull();
  });

  test("degraded is amber, dismissible, and carries the fix", () => {
    const band = fleetBand(status("degraded"));
    expect(band?.tone).toBe("warn");
    expect(band?.dismissible).toBe(true);
    expect(band?.fix).toBe("hermetic foundation update");
    expect(band?.headline).toBe("This fleet is behind your hermetic build · 2 agents affected");
  });

  test("blocked is red and may never be put away", () => {
    const band = fleetBand(status("blocked"));
    expect(band?.tone).toBe("bad");
    expect(band?.dismissible).toBe(false);
    expect(band?.headline).toContain("ahead of your hermetic build");
  });

  test("pending is quiet: it resolves itself", () => {
    expect(fleetBand(status("pending"))?.tone).toBe("muted");
  });

  test("the message is core's, verbatim — the band never writes its own", () => {
    const band = fleetBand(status("degraded"));
    expect(band?.message).toBe("some things will not behave as expected until the fleet is updated");
  });

  test("one affected agent is not pluralised", () => {
    expect(fleetBand(status("degraded", {}, { agents_affected: 1 }))?.headline).toContain(
      "1 agent affected",
    );
  });
});

describe("agentBand", () => {
  test("a skewed fleet puts a band on every agent, never dismissible", () => {
    const band = agentBand(status("degraded"), "lime-panther");
    expect(band?.dismissible).toBe(false);
    expect(band?.headline).toContain("built by an older hermetic");
  });

  test("names this agent's own lag on top of the fleet's, and nothing it does not have", () => {
    // pink-otter is drifted; amber-hawk is behind; lime-panther is neither.
    expect(agentBand(status("degraded"), "pink-otter")?.stale).toEqual(["its config"]);
    expect(agentBand(status("degraded"), "amber-hawk")?.stale).toEqual(["its hermeticd release"]);
    expect(agentBand(status("degraded"), "lime-panther")?.stale).toEqual([]);
  });

  test("a pending fleet is not called an old one", () => {
    // `pending` means the fleet is current and its agents have not finished
    // taking the release. Reading tone alone put "built by an older hermetic"
    // on a fleet that was nothing of the kind.
    expect(agentBand(status("pending"), "amber-hawk")?.headline).toBe(
      "Agents are still taking the new release · this agent is behind on its hermeticd release",
    );
    expect(agentBand(status("pending"), "lime-panther")?.headline).toBe(
      "Agents are still taking the new release",
    );
  });

  test("a blocked fleet says only that: upgrading hermetic is the whole fix", () => {
    expect(agentBand(status("blocked"), "pink-otter")?.headline).toBe(
      "This fleet is ahead of your hermetic build",
    );
  });

  test("the headline names what is behind rather than counting it", () => {
    expect(agentBand(status("degraded"), "pink-otter")?.headline).toBe(
      "This fleet was built by an older hermetic · this agent is behind on its config",
    );
    // A fleet-only skew says only that: there is nothing per-agent to add.
    expect(agentBand(status("degraded"), "lime-panther")?.headline).toBe(
      "This fleet was built by an older hermetic",
    );
  });

  test("a current fleet with one lagging agent says so quietly, and only there", () => {
    const s = status("none");
    expect(agentBand(s, "amber-hawk")?.tone).toBe("muted");
    expect(agentBand(s, "pink-otter")?.tone).toBe("muted");
    expect(agentBand(s, "lime-panther")).toBeNull();
  });
});

describe("marks", () => {
  test("the foundation mark names the version this build wanted", () => {
    expect(foundationMark(status("degraded"))).toBe("⚠ this build expects v2");
    expect(foundationMark(status("blocked"))).toBe("⚠ this build only knows v2");
    expect(foundationMark(status("none"))).toBeNull();
  });

  test("no foundation mark when the versions match, whatever else is skewed", () => {
    expect(foundationMark(status("pending", {}, { fleet_version: 2 }))).toBeNull();
  });

  test("the hermeticd mark is per agent and names the release the fleet points at", () => {
    expect(hermeticdMark(status("degraded"), "amber-hawk")).toBe("⚠ fleet points at 0.5.0");
    expect(hermeticdMark(status("degraded"), "pink-otter")).toBeNull();
    expect(hermeticdMark(status("degraded"), "no-such-agent")).toBeNull();
  });

  test("config: unknown is a third answer, and not a warning", () => {
    expect(configLabel("drifted")).toEqual({ label: "drifted", warn: true });
    expect(configLabel("current")).toEqual({ label: "current", warn: false });
    expect(configLabel("unknown")).toEqual({ label: "unknown", warn: false });
    expect(configLabel(null)).toEqual({ label: "unknown", warn: false });
  });

  test("configOf reads the row, and is null for an agent the status did not carry", () => {
    expect(configOf(status("degraded"), "pink-otter")).toBe("drifted");
    expect(configOf(status("degraded"), "nobody")).toBeNull();
  });
});

describe("dismissKey", () => {
  test("keyed by fleet and severity, so neither hides the other", () => {
    expect(dismissKey("main", "degraded")).not.toBe(dismissKey("staging", "degraded"));
    expect(dismissKey("main", "degraded")).not.toBe(dismissKey("main", "blocked"));
    expect(dismissKey(null, "degraded")).toBe("hermetic.skew.-.degraded");
  });
});

describe("configHashView", () => {
  /**
   * The regression: the drawer rendered `applied_config_hash ?? config_hash`,
   * so a box that had reported nothing was shown the hash the *fleet* rendered,
   * with "unknown" as dim text beside it. `configVerdict` refuses to guess in
   * exactly this case; the display must not guess on its behalf.
   */
  test("a box that has reported nothing is shown no hash", () => {
    const view = configHashView({ config_hash: "a".repeat(64) }, "unknown");
    expect(view.value).toBe("—");
    expect(view.warn).toBe(false);
    expect(view.note).toContain("not reported");
    // The rendered hash is still named — as what this build would apply.
    expect(view.note).toContain("a".repeat(64));
    expect(view.note).toContain("this build renders");
  });

  test("with neither hash there is nothing to name", () => {
    const view = configHashView({}, undefined);
    expect(view.value).toBe("—");
    expect(view.note).toBe("· not reported");
  });

  test("a reported hash is shown, labelled by the verdict", () => {
    const view = configHashView(
      { config_hash: "a".repeat(64), applied_config_hash: "a".repeat(64) },
      "current",
    );
    expect(view.value).toBe("a".repeat(64));
    expect(view.note).toBe("· current");
    expect(view.warn).toBe(false);
  });

  test("drift shows what the box has and warns with what this build renders", () => {
    const view = configHashView(
      { config_hash: "b".repeat(64), applied_config_hash: "a".repeat(64) },
      "drifted",
    );
    // The box's own hash, not the fleet's — the value is what is true of the box.
    expect(view.value).toBe("a".repeat(64));
    expect(view.warn).toBe(true);
    expect(view.note).toContain("b".repeat(64));
  });
});

describe("hermesRunningNote", () => {
  /**
   * The window this exists for: `upgrade --hermes` moves the pin and says so
   * itself — "takes effect on the next recreate" — so until that recreate the
   * row names a version no box is running.
   */
  test("names what the box runs when it differs from the pin", () => {
    expect(hermesRunningNote({ hermes_version: "0.22.0", running_hermes_version: "0.21.0" })).toBe(
      "· running 0.21.0",
    );
  });

  test("says nothing when they agree", () => {
    expect(
      hermesRunningNote({ hermes_version: "0.21.0", running_hermes_version: "0.21.0" }),
    ).toBeNull();
  });

  /**
   * Absence is unknown, and unknown is not a discrepancy — a box on a hermeticd
   * too old to report it, or one whose dashboard was down this tick.
   */
  test("says nothing when the box has not reported", () => {
    expect(hermesRunningNote({ hermes_version: "0.21.0" })).toBeNull();
    expect(hermesRunningNote({})).toBeNull();
  });
});
