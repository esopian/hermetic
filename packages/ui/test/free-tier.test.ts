import { describe, expect, test } from "bun:test";
import { FREE_TIER_PRESET_ID, presetsView } from "@hermetic/core/shared";
import { freeTierPresetsPlan, freeTierStateText } from "../src/logic/free-tier.ts";

function view(loadout: (string | null)[], def: string | null) {
  return presetsView({ loadout, default: def, custom: [] });
}

describe("freeTierPresetsPlan", () => {
  test("takes the default's slot on a full loadout, and names what it replaces", () => {
    const plan = freeTierPresetsPlan(view(["light", "standard", "heavy", "gpu"], "standard"));
    expect(plan).toEqual({
      loadout: ["light", FREE_TIER_PRESET_ID, "heavy", "gpu"],
      default: FREE_TIER_PRESET_ID,
      replaces: "standard",
      slot: 2,
    });
  });

  test("prefers an empty slot over replacing anything", () => {
    const plan = freeTierPresetsPlan(view(["light", null, "heavy", "gpu"], "heavy"));
    expect(plan.loadout).toEqual(["light", FREE_TIER_PRESET_ID, "heavy", "gpu"]);
    expect(plan.replaces).toBeNull();
  });

  test("already in the loadout: only the default moves", () => {
    const plan = freeTierPresetsPlan(view(["light", "heavy", FREE_TIER_PRESET_ID, "gpu"], "light"));
    expect(plan.loadout).toEqual(["light", "heavy", FREE_TIER_PRESET_ID, "gpu"]);
    expect(plan.slot).toBe(3);
    expect(plan.replaces).toBeNull();
  });
});

test("freeTierStateText names each half", () => {
  expect(freeTierStateText({ fleet: true, laptop: true })).toBe("applied");
  expect(freeTierStateText({ fleet: true, laptop: false })).toBe("fleet only");
  expect(freeTierStateText({ fleet: false, laptop: true })).toBe("this laptop only");
  expect(freeTierStateText({ fleet: false, laptop: null })).toBe("not applied");
});
