/**
 * Settings › Create presets (§4.6): what each gesture on the loadout and the
 * library does to the document, as pure functions.
 *
 * The page is instant-save: every gesture computes the next document here and
 * sends it whole (`presets.set` replaces each field it is given). Keeping the
 * rules out of the component is what lets "a full loadout refuses a fifth",
 * "dropping on a card replaces it" and "removing the default moves the
 * default" be tested without a renderer.
 *
 * The document is the three stored fields — `loadout` (always four slots, a
 * slot may be `null`), `default`, and `custom`. The built-ins are not in it:
 * they are fixed in this build (`BUILTIN_PRESETS` in `@hermetic/core/shared`).
 */
import { BUILTIN_PRESETS, LOADOUT_SLOTS, PRESET_ID_RE } from "@hermetic/core/shared";
import type { MachinePreset, PresetView, PresetsView } from "@hermetic/core/shared";
import { sizeSpec } from "./format.ts";

export interface LoadoutDoc {
  loadout: (string | null)[];
  default: string | null;
  custom: MachinePreset[];
}

/** The editable part of what `presets.get` answered. */
export function docOf(view: PresetsView): LoadoutDoc {
  return {
    loadout: [...view.loadout],
    default: view.default,
    custom: view.custom.map((p) => ({ ...p })),
  };
}

/**
 * Keep the default honest after a gesture: it must name a filled slot, and it
 * may be `null` only when every slot is empty. A default that left the loadout
 * moves to the first filled slot — the same rule core heals a stored row by.
 */
function settle(doc: LoadoutDoc): LoadoutDoc {
  const filled = doc.loadout.filter((id): id is string => id !== null);
  const def = doc.default !== null && filled.includes(doc.default) ? doc.default : (filled[0] ?? null);
  return { ...doc, default: def };
}

export function inLoadout(doc: LoadoutDoc, id: string): boolean {
  return doc.loadout.includes(id);
}

export function loadoutFull(doc: LoadoutDoc): boolean {
  return doc.loadout.every((id) => id !== null);
}

/** What the library's tick does, or why it cannot. */
export type ToggleResult = { ok: true; doc: LoadoutDoc } | { ok: false; reason: "full" };

/** The hint a tick on a full loadout shows instead of adding. */
export const LOADOUT_FULL_HINT = "Loadout full: drop it on a card to replace.";

/**
 * The library's tick. In the loadout: take it out, leaving its slot empty. Not
 * in it: put it in the first empty slot — and when there is none, refuse; the
 * way to swap a preset in is to drop it on the card it should replace.
 */
export function toggleInLoadout(doc: LoadoutDoc, id: string): ToggleResult {
  const at = doc.loadout.indexOf(id);
  if (at >= 0) return { ok: true, doc: removeSlot(doc, at) };
  const empty = doc.loadout.indexOf(null);
  if (empty < 0) return { ok: false, reason: "full" };
  const loadout = [...doc.loadout];
  loadout[empty] = id;
  return { ok: true, doc: settle({ ...doc, loadout }) };
}

/**
 * A library row dropped on a card: it takes that slot. If it was already in
 * the loadout somewhere else, the two swap places rather than the preset
 * appearing twice; the card's default status stays with the slot's old
 * preset only if that preset is still in the loadout.
 */
export function placeInSlot(doc: LoadoutDoc, id: string, slot: number): LoadoutDoc {
  if (slot < 0 || slot >= LOADOUT_SLOTS) return doc;
  const loadout = [...doc.loadout];
  const from = loadout.indexOf(id);
  const displaced = loadout[slot] ?? null;
  loadout[slot] = id;
  if (from >= 0 && from !== slot) loadout[from] = displaced;
  const replacedDefault =
    displaced !== null && displaced === doc.default && !loadout.includes(displaced);
  return settle({ ...doc, loadout, default: replacedDefault ? id : doc.default });
}

/** A card dragged onto another slot, or moved one step by the keyboard: the two swap. */
export function moveSlot(doc: LoadoutDoc, from: number, to: number): LoadoutDoc {
  if (from === to || from < 0 || to < 0 || from >= LOADOUT_SLOTS || to >= LOADOUT_SLOTS) {
    return doc;
  }
  const loadout = [...doc.loadout];
  const a = loadout[from] ?? null;
  loadout[from] = loadout[to] ?? null;
  loadout[to] = a;
  return { ...doc, loadout };
}

/** A card's Remove: the slot empties and waits for a drop. */
export function removeSlot(doc: LoadoutDoc, slot: number): LoadoutDoc {
  const loadout = [...doc.loadout];
  loadout[slot] = null;
  return settle({ ...doc, loadout });
}

export function setDefault(doc: LoadoutDoc, id: string): LoadoutDoc {
  return inLoadout(doc, id) ? { ...doc, default: id } : doc;
}

/** The custom editor's Save: the preset written, and put in or taken out of the loadout. */
export function upsertCustom(
  doc: LoadoutDoc,
  preset: MachinePreset,
  wantInLoadout: boolean,
): ToggleResult {
  const at = doc.custom.findIndex((p) => p.id === preset.id);
  const custom = at < 0 ? [...doc.custom, preset] : doc.custom.map((p, i) => (i === at ? preset : p));
  const next = { ...doc, custom };
  if (inLoadout(next, preset.id) === wantInLoadout) return { ok: true, doc: settle(next) };
  return toggleInLoadout(next, preset.id);
}

/** Delete a custom preset: gone from the library and from any slot it held. */
export function deleteCustom(doc: LoadoutDoc, id: string): LoadoutDoc {
  return settle({
    loadout: doc.loadout.map((x) => (x === id ? null : x)),
    default: doc.default,
    custom: doc.custom.filter((p) => p.id !== id),
  });
}

/**
 * A fresh custom preset id: the name as a slug, made unique against every
 * built-in and custom id. The id never changes after that, even if the name
 * does — it is what a loadout slot and `agent create --preset` hold on to.
 */
export function mintPresetId(name: string, doc: LoadoutDoc): string {
  const taken = new Set([...BUILTIN_PRESETS.map((p) => p.id), ...doc.custom.map((p) => p.id)]);
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "preset";
  const root = PRESET_ID_RE.test(base) ? base : `p-${base}`.slice(0, 32);
  if (!taken.has(root)) return root;
  for (let n = 2; ; n++) {
    const id = `${root}-${n}`;
    if (!taken.has(id)) return id;
  }
}

/** The request body for a document: every field, since each replaces its own whole. */
export function patchOf(doc: LoadoutDoc): {
  loadout: (string | null)[];
  default: string | null;
  custom: MachinePreset[];
} {
  return { loadout: [...doc.loadout], default: doc.default, custom: doc.custom };
}

/**
 * The square glyph a card and a row open with: the size's own glyph for a CPU
 * preset, `G` for any GPU one (the size glyphs there are too long for a square).
 */
export function presetGlyph(p: Pick<PresetView, "size" | "usable">): string {
  if (!p.usable) return "?";
  const spec = sizeSpec(p.size);
  return spec.family === "gpu" ? "G" : spec.glyph;
}
