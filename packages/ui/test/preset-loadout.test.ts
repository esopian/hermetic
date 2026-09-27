/**
 * Settings › Create presets' gestures as pure functions (`preset-loadout.ts`):
 * the loadout is always four slots, a full one refuses a fifth, a drop on a
 * card replaces it, and the default always names a filled slot.
 */
import { describe, expect, test } from "bun:test";
import { presetsView } from "@hermetic/core/shared";
import {
  LOADOUT_FULL_HINT,
  deleteCustom,
  docOf,
  loadoutFull,
  mintPresetId,
  moveSlot,
  patchOf,
  placeInSlot,
  presetGlyph,
  removeSlot,
  setDefault,
  toggleInLoadout,
  upsertCustom,
} from "../src/logic/preset-loadout.ts";
import type { LoadoutDoc } from "../src/logic/preset-loadout.ts";

const BUILTIN = docOf(presetsView(null));
const RESEARCH = { id: "research", name: "research", size: "large", volume_gib: 300, root_gib: 60 };

describe("the tick", () => {
  test("takes a preset out, leaving its slot empty", () => {
    const r = toggleInLoadout(BUILTIN, "heavy");
    expect(r.ok && r.doc.loadout).toEqual(["light", "standard", null, "gpu"]);
  });

  test("puts a preset in the first empty slot", () => {
    const gap = removeSlot(BUILTIN, 1);
    const r = toggleInLoadout(gap, "micro");
    expect(r.ok && r.doc.loadout).toEqual(["light", "micro", "heavy", "gpu"]);
  });

  test("on a full loadout refuses rather than adding a fifth", () => {
    expect(loadoutFull(BUILTIN)).toBe(true);
    expect(toggleInLoadout(BUILTIN, "micro")).toEqual({ ok: false, reason: "full" });
    expect(LOADOUT_FULL_HINT).toBe("Loadout full: drop it on a card to replace.");
  });
});

describe("dropping and moving", () => {
  test("a library row dropped on a card replaces it", () => {
    expect(placeInSlot(BUILTIN, "micro", 2).loadout).toEqual(["light", "standard", "micro", "gpu"]);
  });

  test("replacing the default card makes the newcomer the default", () => {
    const next = placeInSlot(BUILTIN, "xxl", 1);
    expect(next.loadout[1]).toBe("xxl");
    expect(next.default).toBe("xxl");
  });

  test("dropping a preset already in the loadout swaps rather than duplicating", () => {
    const next = placeInSlot(BUILTIN, "gpu", 0);
    expect(next.loadout).toEqual(["gpu", "standard", "heavy", "light"]);
    expect(next.default).toBe("standard");
  });

  test("a card moved onto another slot swaps with it; out of range is a no-op", () => {
    expect(moveSlot(BUILTIN, 0, 1).loadout).toEqual(["standard", "light", "heavy", "gpu"]);
    expect(moveSlot(BUILTIN, 3, 4)).toBe(BUILTIN);
    expect(moveSlot(BUILTIN, -1, 0)).toBe(BUILTIN);
  });
});

describe("the default", () => {
  test("set as default names a card in the loadout, and nothing else", () => {
    expect(setDefault(BUILTIN, "heavy").default).toBe("heavy");
    expect(setDefault(BUILTIN, "micro")).toBe(BUILTIN);
  });

  test("removing the default card moves the default to the first filled slot", () => {
    const next = removeSlot(BUILTIN, 1);
    expect(next.loadout).toEqual(["light", null, "heavy", "gpu"]);
    expect(next.default).toBe("light");
  });

  test("an empty loadout has no default", () => {
    let doc: LoadoutDoc = BUILTIN;
    for (const i of [0, 1, 2, 3]) doc = removeSlot(doc, i);
    expect(doc.default).toBeNull();
  });
});

describe("custom presets", () => {
  test("save adds it, and into the loadout only when asked and there is room", () => {
    const off = upsertCustom(BUILTIN, RESEARCH, false);
    expect(off.ok && off.doc.custom).toEqual([RESEARCH]);
    expect(off.ok && off.doc.loadout).toEqual(BUILTIN.loadout);
    expect(upsertCustom(BUILTIN, RESEARCH, true)).toEqual({ ok: false, reason: "full" });
    const room = upsertCustom(removeSlot(BUILTIN, 3), RESEARCH, true);
    expect(room.ok && room.doc.loadout[3]).toBe("research");
  });

  test("an edit replaces the preset in place and can take it out of the loadout", () => {
    const withIt = upsertCustom(removeSlot(BUILTIN, 3), RESEARCH, true);
    if (!withIt.ok) throw new Error("expected room");
    const edited = upsertCustom(withIt.doc, { ...RESEARCH, root_gib: 80 }, false);
    expect(edited.ok && edited.doc.custom).toEqual([{ ...RESEARCH, root_gib: 80 }]);
    expect(edited.ok && edited.doc.loadout.includes("research")).toBe(false);
  });

  test("delete removes it from the library and from its slot", () => {
    const withIt = upsertCustom(removeSlot(BUILTIN, 1), RESEARCH, true);
    if (!withIt.ok) throw new Error("expected room");
    const set = setDefault(withIt.doc, "research");
    const gone = deleteCustom(set, "research");
    expect(gone.custom).toEqual([]);
    expect(gone.loadout).toEqual(["light", null, "heavy", "gpu"]);
    expect(gone.default).toBe("light");
  });

  test("a minted id is a slug of the name, unique against built-ins and custom ones", () => {
    expect(mintPresetId("Cheap vision!", BUILTIN)).toBe("cheap-vision");
    expect(mintPresetId("Heavy", BUILTIN)).toBe("heavy-2");
    expect(mintPresetId("research", { ...BUILTIN, custom: [RESEARCH] })).toBe("research-2");
    expect(mintPresetId("!!!", BUILTIN)).toBe("preset");
  });
});

test("the request body carries every field, since each replaces its own whole", () => {
  expect(patchOf(BUILTIN)).toEqual({
    loadout: ["light", "standard", "heavy", "gpu"],
    default: "standard",
    custom: [],
  });
});

test("a GPU preset's glyph is G; a CPU one uses its size's glyph", () => {
  expect(presetGlyph({ size: "gpu-large", usable: true })).toBe("G");
  expect(presetGlyph({ size: "large", usable: true })).toBe("L");
  expect(presetGlyph({ size: "quantum", usable: false })).toBe("?");
});
