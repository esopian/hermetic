/**
 * §6.6's fleet band, rendered: which fix it offers, and what a dismissal hides.
 *
 * `skew-logic.test.ts` covers what the band *says*; this covers the two things
 * only the component decides. The "Update foundation…" button is `degraded`'s
 * alone — a `drifted` fleet's fix is `hermetic plan rollout`, which no button
 * here performs, so the band names the command instead. And a dismissal is
 * remembered per severity: putting away "Agents are catching up" must not hide
 * the "Config not applied" it may turn into, which a key hard-coded to
 * `degraded` did.
 */
import { cleanup, render, screen } from "./dom.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { SkewBand } from "../src/components/SkewBand.tsx";
import type { SkewSeverity, SkewStatusView } from "../src/logic/skew-logic.ts";

afterEach(cleanup);
beforeEach(() => sessionStorage.clear());

function status(severity: SkewSeverity, fix: string | null): SkewStatusView {
  return {
    skew: {
      severity,
      headline: "foundation v2 is current · 1 agent has not applied its config",
      message: "the sentence core sends",
      fleet_version: 2,
      expected_version: 2,
      agents_behind: 0,
      agents_drifted: 1,
      agents_affected: 1,
      fix,
    },
    agents: [],
  };
}

describe("SkewBand", () => {
  test("drifted names its command and offers no foundation update", () => {
    render(<SkewBand status={status("drifted", "hermetic plan rollout")} onFix={() => {}} />);
    expect(screen.getByText("Config not applied · 1 agent affected")).toBeTruthy();
    expect(screen.getByText("hermetic plan rollout")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Update foundation…" })).toBeNull();
    expect(screen.getByRole("button", { name: "Dismiss for this session" })).toBeTruthy();
  });

  test("degraded keeps its button, and does not spell the command in the band", () => {
    render(<SkewBand status={status("degraded", "hermetic foundation update")} onFix={() => {}} />);
    expect(screen.getByRole("button", { name: "Update foundation…" })).toBeTruthy();
    expect(screen.queryByText("hermetic foundation update")).toBeNull();
  });

  test("a dismissal is remembered under the severity that was dismissed", () => {
    sessionStorage.setItem("hermetic.skew.fx.pending", "1");
    render(<SkewBand status={status("drifted", "hermetic plan rollout")} fleetId="fx" />);
    // Not collapsed to the strip: "catching up" was put away, not this.
    expect(screen.getByRole("status")).toBeTruthy();
    cleanup();
    sessionStorage.setItem("hermetic.skew.fx.drifted", "1");
    render(<SkewBand status={status("drifted", "hermetic plan rollout")} fleetId="fx" />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "show detail" })).toBeTruthy();
  });
});
