/**
 * The AWS Free Tier baseline (`packages/core/src/shared/free-tier.ts`) and its
 * contributor check (`scripts/free-tier.ts`). The date checks are given a
 * fixed `today`, so the suite never starts failing on its own — the script is
 * what tells a contributor the trial has lapsed.
 */
import { describe, expect, test } from "bun:test";
import { BUILTIN_PRESETS } from "../packages/core/src/shared/presets.ts";
import {
  AWS_FREE_TIER,
  FREE_TIER_PRESET_ID,
  isFreeTierMachine,
} from "../packages/core/src/shared/free-tier.ts";
import type { FreeTierBaseline } from "../packages/core/src/shared/free-tier.ts";
import { checkBaseline, checkEligibility } from "../scripts/free-tier.ts";

const ON_REVIEW = AWS_FREE_TIER.reviewed_on;

function errors(b: FreeTierBaseline, today = ON_REVIEW): string[] {
  return checkBaseline(b, today)
    .filter((f) => f.level === "error")
    .map((f) => f.message);
}

describe("the baseline as committed", () => {
  test("fits every allowance it states on the day it was reviewed", () => {
    expect(checkBaseline(AWS_FREE_TIER, ON_REVIEW)).toEqual([]);
  });

  test("the free-tier built-in preset is the baseline's machine", () => {
    const p = BUILTIN_PRESETS.find((x) => x.id === FREE_TIER_PRESET_ID);
    expect(p).toBeDefined();
    expect({ size: p?.size, volume_gib: p?.volume_gib, root_gib: p?.root_gib }).toEqual(
      AWS_FREE_TIER.machine,
    );
  });

  test("every resource id is unique and every treatment is named", () => {
    const ids = AWS_FREE_TIER.resources.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of AWS_FREE_TIER.resources) {
      expect(["set", "within", "not_covered"]).toContain(r.treatment);
    }
  });
});

describe("checkBaseline", () => {
  test("a lapsed Arm trial is an error", () => {
    expect(errors(AWS_FREE_TIER, "2027-01-01").join("\n")).toContain("trial ended on 2026-12-31");
  });

  test("the last day of the trial is still inside it", () => {
    expect(errors(AWS_FREE_TIER, "2026-12-31")).toEqual([]);
  });

  test("disks over the EBS allowance are an error", () => {
    const b = { ...AWS_FREE_TIER, machine: { ...AWS_FREE_TIER.machine, volume_gib: 11 } };
    expect(errors(b).join("\n")).toContain("over the 30 GB-month EBS allowance");
  });

  test("a size that is on no list and no trial is an error", () => {
    const b = { ...AWS_FREE_TIER, machine: { ...AWS_FREE_TIER.machine, size: "medium" as const } };
    expect(errors(b).join("\n")).toContain("t4g.2xlarge");
  });

  test("a review older than review_after_days warns without failing", () => {
    const findings = checkBaseline({ ...AWS_FREE_TIER, review_after_days: 30 }, "2026-12-30");
    expect(findings.filter((f) => f.level === "error")).toEqual([]);
    expect(findings.map((f) => f.message).join("\n")).toContain("last reviewed 77 days ago");
  });
});

describe("checkEligibility", () => {
  test("EC2 dropping the baseline's type is an error; a new type only warns", () => {
    const f = checkEligibility(AWS_FREE_TIER, ["t4g.micro", "t4g.medium"]);
    expect(
      f
        .filter((x) => x.level === "error")
        .map((x) => x.message)
        .join("\n"),
    ).toContain("t4g.small");
    expect(f.filter((x) => x.level === "warn").map((x) => x.message)).toEqual([
      "EC2 lists t4g.medium as eligible; free-tier.ts does not",
    ]);
  });

  test("EC2 agreeing with the baseline finds nothing", () => {
    expect(checkEligibility(AWS_FREE_TIER, ["t4g.micro", "t4g.small"])).toEqual([]);
  });
});

describe("isFreeTierMachine", () => {
  test("an absent root_gib reads as the 20 GiB default", () => {
    expect(isFreeTierMachine({ size: "xxsmall", volume_gib: 10 })).toBe(true);
    expect(isFreeTierMachine({ size: "xxsmall", volume_gib: 10, root_gib: 8 })).toBe(false);
    expect(isFreeTierMachine({ size: "medium", volume_gib: 10, root_gib: 20 })).toBe(false);
  });
});
