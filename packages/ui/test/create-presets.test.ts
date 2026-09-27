/**
 * The create drawer's machine presets (`create-presets.ts`): the strip is this
 * laptop's loadout, every preset — Standard included — states its three
 * fields, how far a form has moved off its preset, and what it costs.
 */
import { describe, expect, test } from "bun:test";
import { BUILTIN_PRESETS, presetsView } from "@hermetic/core/shared";
import type { PresetView } from "@hermetic/core/shared";
import type { CreateField } from "../src/logic/create-form.ts";
import {
  applyPreset,
  bundleOf,
  fromPreset,
  initialPreset,
  knownMonthlyUsd,
  machineMonthlyUsd,
  presetChanges,
  presetMonthlyUsd,
  stripPresets,
} from "../src/logic/create-presets.ts";
import type { MachineState } from "../src/logic/create-presets.ts";
import { SIZES, sizeSpec, volumeMonthlyUsd } from "../src/logic/format.ts";

const BUILTIN = presetsView(null);
const byId = (id: string): PresetView => BUILTIN.presets.find((p) => p.id === id)!;

function state(over: Partial<MachineState> = {}, touched: CreateField[] = []): MachineState {
  return { size: "micro", volume_gib: 50, root_gib: 30, touched: new Set(touched), ...over };
}

describe("the built-in loadout", () => {
  test("is Light · Standard · Heavy · GPU, opening on Standard", () => {
    expect(stripPresets(BUILTIN).map((p) => p.name)).toEqual(["Light", "Standard", "Heavy", "GPU"]);
    expect(BUILTIN.default).toBe("standard");
  });

  test("keeps the bundles the strip has always offered, and Standard is a real one", () => {
    expect(bundleOf(byId("light"))).toEqual({ size: "small", volume_gib: 50, root_gib: 20 });
    expect(bundleOf(byId("standard"))).toEqual({ size: "medium", volume_gib: 100, root_gib: 40 });
    expect(bundleOf(byId("heavy"))).toEqual({ size: "large", volume_gib: 200, root_gib: 40 });
    expect(bundleOf(byId("gpu"))).toEqual({ size: "gpu-xsmall", volume_gib: 100, root_gib: 40 });
  });

  test("every built-in names a size this UI can draw, and GPU is the cheapest GPU size", () => {
    const ids = new Set(SIZES.map((s) => s.id));
    for (const p of BUILTIN_PRESETS) expect(ids.has(p.size)).toBe(true);
    const cheapest = SIZES.filter((s) => s.family === "gpu").sort(
      (a, b) => a.monthlyUsd - b.monthlyUsd,
    )[0];
    expect(byId("gpu").size).toBe(cheapest!.id);
  });

  test("the strip skips empty slots and keeps the loadout's order", () => {
    const view = presetsView({ loadout: ["heavy", null, "micro", null], default: "micro", custom: [] });
    expect(stripPresets(view).map((p) => p.id)).toEqual(["heavy", "micro"]);
  });
});

describe("applyPreset", () => {
  test("sets and states exactly its three fields", () => {
    const next = applyPreset(byId("heavy"), state({}, ["secrets"]), false);
    expect(next).toMatchObject({ size: "large", volume_gib: 200, root_gib: 40 });
    expect([...next.touched].sort()).toEqual(["root_gib", "secrets", "size", "volume_gib"]);
  });

  test("Standard states its fields too — it no longer means `the fleet's defaults`", () => {
    const next = applyPreset(byId("standard"), state(), false);
    expect(next).toMatchObject({ size: "medium", volume_gib: 100, root_gib: 40 });
    expect(next.touched.has("size")).toBe(true);
  });

  test("on an existing volume it never touches the data volume", () => {
    const next = applyPreset(byId("heavy"), state({ volume_gib: 77 }), true);
    expect(next.volume_gib).toBe(77);
    expect(next.touched.has("volume_gib")).toBe(false);
  });

  test("a preset naming a size this build does not know changes nothing", () => {
    const odd: PresetView = {
      ...byId("heavy"),
      id: "odd",
      size: "quantum",
      builtin: false,
      lane: "custom",
      usable: false,
    };
    const before = state();
    expect(applyPreset(odd, before, false)).toBe(before);
    expect(bundleOf(odd)).toBeNull();
  });
});

describe("presetChanges and fromPreset", () => {
  test("zero straight after choosing a preset", () => {
    const s = applyPreset(byId("light"), state(), false);
    expect(presetChanges(byId("light"), s, false)).toBe(0);
    expect(fromPreset(byId("light"), "size", s)).toBe(true);
  });

  test("a field moved off the preset's value counts, and reads as changed", () => {
    const s = { ...applyPreset(byId("light"), state(), false), root_gib: 60 };
    expect(presetChanges(byId("light"), s, false)).toBe(1);
    expect(fromPreset(byId("light"), "root_gib", s)).toBe(false);
  });

  test("a field that went back to inheriting has left the preset even at the same number", () => {
    const s = applyPreset(byId("light"), state(), false);
    const inherited = { ...s, touched: new Set<CreateField>(["volume_gib", "root_gib"]) };
    expect(presetChanges(byId("light"), inherited, false)).toBe(1);
  });

  test("the reclaim path does not count the volume", () => {
    const s = { ...applyPreset(byId("heavy"), state(), true), volume_gib: 9 };
    expect(presetChanges(byId("heavy"), s, true)).toBe(0);
  });
});

describe("initialPreset", () => {
  test("a fresh drawer opens on the loadout's default", () => {
    expect(initialPreset(BUILTIN, null, false)).toBe("standard");
    const view = presetsView({ loadout: ["heavy", "gpu", null, null], default: "gpu", custom: [] });
    expect(initialPreset(view, null, false)).toBe("gpu");
  });

  test("a draft keeps the preset it remembers while the strip still offers it", () => {
    const s = { ...applyPreset(byId("heavy"), state(), false), root_gib: 99 };
    expect(initialPreset(BUILTIN, s, false, "heavy")).toBe("heavy");
  });

  test("a draft without one recovers it from an exact match, else the default", () => {
    expect(initialPreset(BUILTIN, applyPreset(byId("gpu"), state(), false), false)).toBe("gpu");
    expect(initialPreset(BUILTIN, state({}, ["size"]), false, "gone")).toBe("standard");
  });

  test("an empty loadout offers no preset at all", () => {
    const view = presetsView({ loadout: [null, null, null, null], default: null, custom: [] });
    expect(initialPreset(view, null, false)).toBeNull();
  });
});

describe("prices", () => {
  test("a machine is its instance plus both disks", () => {
    const m = { size: "large" as const, volume_gib: 200, root_gib: 40 };
    expect(machineMonthlyUsd(m)).toBeCloseTo(
      sizeSpec("large").monthlyUsd + volumeMonthlyUsd(200) + volumeMonthlyUsd(40),
    );
    expect(presetMonthlyUsd(byId("heavy"))).toBeCloseTo(machineMonthlyUsd(m));
  });

  test("an inherited part the portal could not read prices nothing", () => {
    const m = { size: "large" as const, volume_gib: 200, root_gib: 40 };
    expect(knownMonthlyUsd(m, (f) => f === "size")).toBeNull();
    expect(knownMonthlyUsd(m, () => false)).toBeCloseTo(machineMonthlyUsd(m));
  });
});
