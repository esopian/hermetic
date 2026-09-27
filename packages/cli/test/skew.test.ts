/**
 * §6.6 version skew, the CLI's half: which form is printed for which command,
 * and what may be quieted.
 */
import { describe, expect, test } from "bun:test";
import type { Skew } from "@hermetic/core/schema";
import { SKEW_QUIET_ENV, skewIsLoud, skewReport } from "../src/skew.ts";

const skew = (over: Partial<Skew> = {}): Skew => ({
  severity: "degraded",
  headline: "fleet foundation v1 · this build expects v2",
  message: "some things will not behave as expected until the fleet is updated",
  fleet_version: 1,
  expected_version: 2,
  agents_behind: 0,
  agents_drifted: 2,
  agents_affected: 3,
  fix: "hermetic foundation update",
  ...over,
});

describe("skewIsLoud", () => {
  test("commands whose behaviour the skew changes get the block", () => {
    expect(skewIsLoud("agent create")).toBe(true);
    expect(skewIsLoud("settings set")).toBe(true);
    expect(skewIsLoud("secrets push")).toBe(true);
  });

  test("reads do not: their output is accurate, it is the numbers that need context", () => {
    expect(skewIsLoud("agent ps")).toBe(false);
    expect(skewIsLoud("agent status")).toBe(false);
    expect(skewIsLoud("doctor")).toBe(false);
  });
});

describe("skewReport", () => {
  test("a fleet in agreement prints nothing", () => {
    expect(skewReport(skew({ severity: "none" }), { loud: true })).toEqual([]);
  });

  test("a read gets one line, carrying the same sentence as the block", () => {
    const lines = skewReport(skew(), { loud: false });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("fleet foundation v1 · this build expects v2");
    expect(lines[0]).toContain("some things will not behave as expected");
  });

  test("a write gets the block, with the fix and the way to quiet it", () => {
    const lines = skewReport(skew(), { loud: true });
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.join("\n")).toContain("hermetic foundation update");
    expect(lines.join("\n")).toContain(SKEW_QUIET_ENV);
    // Every line of a box is the same width, or it is not a box.
    const widths = new Set(lines.map((l) => [...l].length));
    expect(widths.size).toBe(1);
  });

  test("the fleet name is named when the caller knows it", () => {
    expect(skewReport(skew(), { loud: false, fleet: "staging" })[0]).toContain("fleet staging");
  });

  test("pending never interrupts, however the command was classified", () => {
    const lines = skewReport(skew({ severity: "pending", fix: null }), { loud: true });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith("◦")).toBe(true);
  });

  test("quiet silences degraded and pending", () => {
    expect(skewReport(skew(), { loud: true, quiet: true })).toEqual([]);
    expect(skewReport(skew({ severity: "pending" }), { loud: false, quiet: true })).toEqual([]);
  });

  test("quiet does not silence blocked: writes are about to be refused", () => {
    const lines = skewReport(skew({ severity: "blocked", fix: null }), {
      loud: false,
      quiet: true,
    });
    expect(lines.length).toBeGreaterThan(3);
    const text = lines.join("\n");
    expect(text).toContain("BLOCKED");
    // No `fix:` line, because the fix is not a command hermetic runs — and no
    // `hide:` line, because this one cannot be hidden.
    expect(text).toContain("upgrade hermetic on this laptop");
    expect(text).not.toContain(SKEW_QUIET_ENV);
  });
});
