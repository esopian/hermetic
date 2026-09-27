/**
 * The create drawer's machine presets: the strip is this laptop's loadout
 * (Settings › Create presets, §4.6), and each card is a whole machine.
 *
 * A preset is a *bundle* of the three fields that decide what the box costs —
 * size, data volume and system disk — so the strip can price a whole machine
 * rather than an instance type on its own. Every preset is a real bundle,
 * Standard included: choosing one *states* its three fields on the request
 * (touches them), exactly as clicking them one at a time in Customize would.
 * Core never learns a preset was involved (`create-form.ts` decides what
 * reaches the wire), which is also how `hermetic agent create` resolves one.
 *
 * The one exception is the reclaim path (§6.2 step 6): the data volume
 * already exists and has a size, so no preset touches it there.
 *
 * With no preset at all — every loadout slot emptied — the machine fields go
 * back to following the fleet's `defaults`, untouched, as they always did.
 *
 * Pure on purpose, like `create-form.ts`: the drawer is markup, and the
 * mapping, the change count and the price are all unit-tested here.
 */
import { isSizeId } from "@hermetic/core/shared";
import type { PresetView, PresetsView } from "@hermetic/core/shared";
import { sizeSpec, volumeMonthlyUsd } from "./format.ts";
import type { SizeSpec } from "./format.ts";
import type { CreateField } from "./create-form.ts";

/** The fields a preset governs, in the order the strip describes them. */
export const MACHINE_FIELDS = [
  "size",
  "volume_gib",
  "root_gib",
] as const satisfies readonly CreateField[];
export type MachineField = (typeof MACHINE_FIELDS)[number];

export interface MachineBundle {
  size: SizeSpec["id"];
  volume_gib: number;
  root_gib: number;
}

export interface MachineState extends MachineBundle {
  touched: ReadonlySet<CreateField>;
}

/**
 * What the strip offers, left to right: the loadout's filled slots. An empty
 * slot is skipped rather than drawn — it is a gap in Settings, not a choice.
 */
export function stripPresets(view: PresetsView): PresetView[] {
  return view.loadout
    .filter((id): id is string => id !== null)
    .map((id) => view.presets.find((p) => p.id === id))
    .filter((p): p is PresetView => p !== undefined);
}

/** A usable preset as the three form fields. `null` for one naming an unknown size. */
export function bundleOf(p: PresetView): MachineBundle | null {
  if (!p.usable || !isSizeId(p.size)) return null;
  return { size: p.size, volume_gib: p.volume_gib, root_gib: p.root_gib };
}

/**
 * Which fields a preset may move. On the reclaim path the data volume already
 * exists and has a size, so no preset touches it there — a preset that "set"
 * 200 GiB onto a 50 GiB volume would be describing a resize the create never
 * performs.
 */
export function presetFields(lockedVolume: boolean): readonly MachineField[] {
  return lockedVolume ? MACHINE_FIELDS.filter((f) => f !== "volume_gib") : MACHINE_FIELDS;
}

/**
 * The form after choosing a preset: its fields set and touched, everything
 * else as it was. An unusable preset changes nothing.
 */
export function applyPreset(p: PresetView, state: MachineState, lockedVolume: boolean): MachineState {
  const bundle = bundleOf(p);
  if (bundle === null) return state;
  const fields = presetFields(lockedVolume);
  const touched = new Set(state.touched);
  for (const f of fields) touched.add(f);
  const moves = (f: MachineField) => fields.includes(f);
  return {
    size: moves("size") ? bundle.size : state.size,
    volume_gib: moves("volume_gib") ? bundle.volume_gib : state.volume_gib,
    root_gib: moves("root_gib") ? bundle.root_gib : state.root_gib,
    touched,
  };
}

/**
 * Whether one machine field still reads "from preset": stated, and at the
 * preset's value. A field put back to inheriting the fleet, or moved off the
 * preset's number, has left it.
 */
export function fromPreset(p: PresetView, field: MachineField, state: MachineState): boolean {
  const bundle = bundleOf(p);
  return bundle !== null && state.touched.has(field) && state[field] === bundle[field];
}

/** How far the form has moved off the selected preset — the `+ N changes` badge. */
export function presetChanges(p: PresetView, state: MachineState, lockedVolume: boolean): number {
  return presetFields(lockedVolume).filter((f) => !fromPreset(p, f, state)).length;
}

/**
 * The preset a form opens on, by id. A fresh drawer opens on the loadout's
 * default. A restored draft carries values and `touched`: it keeps the preset
 * it remembers when the strip still offers it, else the first strip preset it
 * matches exactly, else the default (with its own `+ N`).
 */
export function initialPreset(
  view: PresetsView,
  state: MachineState | null,
  lockedVolume: boolean,
  remembered: string | null = null,
): string | null {
  const strip = stripPresets(view).filter((p) => p.usable);
  if (strip.length === 0) return null;
  if (remembered !== null && strip.some((p) => p.id === remembered)) return remembered;
  if (state !== null) {
    const match = strip.find((p) => presetChanges(p, state, lockedVolume) === 0);
    if (match) return match.id;
  }
  const def = strip.find((p) => p.id === view.default);
  return (def ?? strip[0])?.id ?? null;
}

/**
 * The drawer's opening machine: on a fresh drawer the loadout's default preset
 * stated over the fleet-seeded form; on a restored draft the draft's own
 * values, with only the card they came from recovered. Exported so
 * `tests/create-parity.test.ts` compares the drawer's real opening state with
 * the CLI's, not an imitation of it.
 */
export function openingMachine(
  view: PresetsView,
  base: MachineState,
  hasDraft: boolean,
  lockedVolume: boolean,
  remembered: string | null = null,
): { machine: MachineState; preset: string | null } {
  const id = initialPreset(view, hasDraft ? base : null, lockedVolume, remembered);
  const p = id === null ? null : (view.presets.find((x) => x.id === id) ?? null);
  const machine = p !== null && !hasDraft ? applyPreset(p, base, lockedVolume) : base;
  return { machine, preset: id };
}

/** 730 hours, the same month every size's `monthlyUsd` is quoted in. */
export const HOURS_PER_MONTH = 730;

/**
 * What a machine bills per month: the instance, the data volume and the system
 * disk, all gp3 at the one rate `format.ts` holds.
 */
export function machineMonthlyUsd(m: MachineBundle): number {
  return sizeSpec(m.size).monthlyUsd + volumeMonthlyUsd(m.volume_gib) + volumeMonthlyUsd(m.root_gib);
}

/** A preset's price, or `null` for one whose size this build cannot price. */
export function presetMonthlyUsd(p: PresetView): number | null {
  const bundle = bundleOf(p);
  return bundle === null ? null : machineMonthlyUsd(bundle);
}

/**
 * The same total, or `null` when any part of it is a value the portal is only
 * guessing at (`inherits` — a fleet default it could not read, and nobody chose
 * one). Pricing this build's constant as the fleet's answer is the lie
 * `create-form.ts` exists to stop telling.
 */
export function knownMonthlyUsd(
  m: MachineBundle,
  inherits: (field: MachineField) => boolean,
): number | null {
  return MACHINE_FIELDS.some(inherits) ? null : machineMonthlyUsd(m);
}
