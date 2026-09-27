/**
 * Create presets (§4.6, §9): the machine bundles a create starts from, and
 * which four of them this laptop offers.
 *
 * A preset is the machine and nothing else — a size, a data volume and a
 * system disk. Everything else a create can state (the provider profile, the
 * model, secrets, approvals) is either picked per create or inherited from the
 * fleet's `defaults`, so a preset can never disagree with a fleet setting.
 *
 * Laptop state, not fleet state: the document lives in this home's SQLite
 * `prefs` table under `CREATE_PRESETS_PREF`, and two operators on one fleet
 * keep their own. No row means the built-in document below.
 *
 * Here, in `shared/`, because three packages need the same answers: core
 * validates and stores the document, the CLI resolves `agent create --preset`
 * against it, and the UI draws the loadout and the create drawer's strip from
 * it. Pure values and pure functions only (`shared-browser-safe.test.ts`); the
 * Zod schema that validates a stored or requested document is
 * `schema/presets.ts`.
 */
import { DEFAULT_ROOT_GIB } from "./box.ts";
import { isSizeId } from "./sizes.ts";
import type { SizeId } from "./sizes.ts";

/** The `prefs` key the document is stored under. */
export const CREATE_PRESETS_PREF = "create.presets";

/** The loadout is always exactly this many slots, left to right; a slot may be empty. */
export const LOADOUT_SLOTS = 4;

/** A preset id: lowercase, digits and dashes, 1–40 characters. */
export const PRESET_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const PRESET_NAME_MAX = 40;

/** Which library lane a preset is drawn in. */
export type PresetLane = "cpu" | "gpu" | "custom";

/**
 * One machine bundle. `size` is a string rather than a `SizeId` because a
 * stored custom preset may name a size a newer build wrote and this one does
 * not know: it is kept, and reported unusable, rather than dropped.
 */
export interface MachinePreset {
  id: string;
  name: string;
  size: string;
  volume_gib: number;
  root_gib: number;
}

export interface BuiltinPreset extends MachinePreset {
  size: SizeId;
  lane: "cpu" | "gpu";
}

/**
 * The built-ins, read-only, in library order. The disks grow with the box
 * because the work does, and the GPU images carry the NVIDIA stack on the
 * system disk. Light, Standard, Heavy and GPU are the four the create drawer
 * has always offered; Standard is now a bundle of its own (medium, 100 GiB,
 * 40 GiB) rather than "whatever the fleet's defaults say".
 */
export const BUILTIN_PRESETS: readonly BuiltinPreset[] = [
  {
    id: "micro",
    name: "Micro",
    size: "micro",
    volume_gib: 40,
    root_gib: DEFAULT_ROOT_GIB,
    lane: "cpu",
  },
  {
    id: "scratch",
    name: "Scratch",
    size: "xsmall",
    volume_gib: 50,
    root_gib: DEFAULT_ROOT_GIB,
    lane: "cpu",
  },
  {
    id: "light",
    name: "Light",
    size: "small",
    volume_gib: 50,
    root_gib: DEFAULT_ROOT_GIB,
    lane: "cpu",
  },
  { id: "standard", name: "Standard", size: "medium", volume_gib: 100, root_gib: 40, lane: "cpu" },
  { id: "heavy", name: "Heavy", size: "large", volume_gib: 200, root_gib: 40, lane: "cpu" },
  {
    id: "big-context",
    name: "Big context",
    size: "xlarge",
    volume_gib: 200,
    root_gib: 40,
    lane: "cpu",
  },
  { id: "xxl", name: "XXL", size: "xxlarge", volume_gib: 200, root_gib: 40, lane: "cpu" },
  { id: "gpu", name: "GPU", size: "gpu-xsmall", volume_gib: 100, root_gib: 40, lane: "gpu" },
  { id: "gpu-s", name: "GPU S", size: "gpu-small", volume_gib: 100, root_gib: 40, lane: "gpu" },
  { id: "gpu-m", name: "GPU M", size: "gpu-medium", volume_gib: 150, root_gib: 60, lane: "gpu" },
  { id: "gpu-l", name: "GPU L", size: "gpu-large", volume_gib: 200, root_gib: 80, lane: "gpu" },
  { id: "gpu-xl", name: "GPU XL", size: "gpu-xlarge", volume_gib: 300, root_gib: 80, lane: "gpu" },
];

export const BUILTIN_LOADOUT: readonly string[] = ["light", "standard", "heavy", "gpu"];
export const BUILTIN_DEFAULT_PRESET = "standard";

export function isBuiltinPresetId(id: string): boolean {
  return BUILTIN_PRESETS.some((p) => p.id === id);
}

/** What is stored: the loadout, which card is the default, and the operator's own presets. */
export interface CreatePresetsDoc {
  loadout: (string | null)[];
  default: string | null;
  custom: MachinePreset[];
}

export function builtinPresetsDoc(): CreatePresetsDoc {
  return { loadout: [...BUILTIN_LOADOUT], default: BUILTIN_DEFAULT_PRESET, custom: [] };
}

/** One preset as every head reads it: built-in or custom, and whether a create can use it. */
export interface PresetView extends MachinePreset {
  builtin: boolean;
  lane: PresetLane;
  /** False for a custom preset whose size this build does not know. */
  usable: boolean;
}

/** `presets.get`'s answer. */
export interface PresetsView {
  /** `builtin` when no row is stored (or the row could not be read), `stored` otherwise. */
  source: "builtin" | "stored";
  /** Every preset, built-ins first in library order, then custom ones in stored order. */
  presets: PresetView[];
  /** Exactly `LOADOUT_SLOTS` entries; `null` is an empty slot. */
  loadout: (string | null)[];
  /** A loadout id, or `null` only when every slot is empty. */
  default: string | null;
  custom: MachinePreset[];
}

/**
 * The document as it may be *read*: a loadout padded or cut to four slots,
 * slots naming nothing (or naming a preset twice) emptied, and a default that
 * is not in the loadout moved to its first filled slot. Lenient on purpose —
 * this is what heals a row written by another build; a *write* is held to the
 * strict rules in `schema/presets.ts` instead.
 */
export function normalizePresetsDoc(doc: CreatePresetsDoc): CreatePresetsDoc {
  const known = new Set([...BUILTIN_PRESETS.map((p) => p.id), ...doc.custom.map((p) => p.id)]);
  const seen = new Set<string>();
  const loadout: (string | null)[] = [];
  for (let i = 0; i < LOADOUT_SLOTS; i++) {
    const id = doc.loadout[i] ?? null;
    if (id === null || !known.has(id) || seen.has(id)) {
      loadout.push(null);
      continue;
    }
    seen.add(id);
    loadout.push(id);
  }
  const def =
    doc.default !== null && loadout.includes(doc.default)
      ? doc.default
      : (loadout.find((id): id is string => id !== null) ?? null);
  return { loadout, default: def, custom: doc.custom };
}

/** Built-ins plus custom presets, each with its lane and whether it is usable. */
export function presetList(custom: readonly MachinePreset[]): PresetView[] {
  return [
    ...BUILTIN_PRESETS.map(
      (p): PresetView => ({
        id: p.id,
        name: p.name,
        size: p.size,
        volume_gib: p.volume_gib,
        root_gib: p.root_gib,
        builtin: true,
        lane: p.lane,
        usable: true,
      }),
    ),
    ...custom.map(
      (p): PresetView => ({ ...p, builtin: false, lane: "custom", usable: isSizeId(p.size) }),
    ),
  ];
}

/** The whole answer for a document, or for no stored row at all. */
export function presetsView(doc: CreatePresetsDoc | null): PresetsView {
  const source = doc === null ? "builtin" : "stored";
  const normal = normalizePresetsDoc(doc ?? builtinPresetsDoc());
  return {
    source,
    presets: presetList(normal.custom),
    loadout: normal.loadout,
    default: normal.default,
    custom: normal.custom,
  };
}

/** A preset by id, or else by its name, ignoring case — `agent create --preset heavy`. */
export function findPreset(presets: readonly PresetView[], idOrName: string): PresetView | null {
  const byId = presets.find((p) => p.id === idOrName);
  if (byId !== undefined) return byId;
  const lower = idOrName.trim().toLowerCase();
  return presets.find((p) => p.name.toLowerCase() === lower) ?? null;
}
