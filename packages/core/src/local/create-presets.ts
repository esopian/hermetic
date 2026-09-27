/**
 * Create presets (§4.6, §9): `presets.get` and `presets.set`, and the rule
 * `agent create --preset` resolves by.
 *
 * Laptop state and nothing else — one row in this home's `prefs` table, no
 * AWS, no fleet guard, no `_fleet` write — so it answers whether or not the
 * fleet is reachable, and two operators on one fleet keep their own loadouts.
 * No row means the built-ins (`shared/presets.ts`).
 */
import { HermeticError } from "../errors.ts";
import {
  PresetsGetInput as PresetsGetInputSchema,
  PresetsSetInput as PresetsSetInputSchema,
  StoredCreatePresets,
} from "../schema/presets.ts";
import type {
  PresetsGetInput,
  PresetsSetInput,
  StoredCreatePresets as Stored,
} from "../schema/presets.ts";
import {
  BUILTIN_PRESETS,
  builtinPresetsDoc,
  findPreset,
  normalizePresetsDoc,
  presetsView,
} from "../shared/presets.ts";
import type { CreatePresetsDoc, PresetView, PresetsView } from "../shared/presets.ts";
import { isSizeId } from "../shared/sizes.ts";

/** Where the document is kept: one string, or none. */
export interface PresetStore {
  read(): Promise<string | null>;
  /** `null` deletes the row, which is what "reset to built-in" is. */
  write(value: string | null): Promise<void>;
}

/** The in-process store tests and a home-less instance get. */
export class MemoryPresetStore implements PresetStore {
  private value: string | null = null;
  async read(): Promise<string | null> {
    return this.value;
  }
  async write(value: string | null): Promise<void> {
    this.value = value;
  }
}

function parse<T>(
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: unknown } },
  input: unknown,
  what: string,
): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issues = (result.error as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
  const lines = (issues ?? []).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  throw new HermeticError(
    "VALIDATION",
    `${what} input does not validate${lines.length > 0 ? `: ${lines.join("; ")}` : ""}`,
    { issues: lines },
  );
}

function refuse(message: string): never {
  throw new HermeticError("VALIDATION", message);
}

/**
 * The stored document, or `null` when there is none — or when the row is not
 * one this build can read. An unreadable row falls back to the built-ins
 * rather than failing every create: it is a preference, and the next
 * `presets set` overwrites it.
 */
async function readDoc(store: PresetStore): Promise<CreatePresetsDoc | null> {
  const raw = await store.read();
  if (raw === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = StoredCreatePresets.safeParse(json);
  if (!parsed.success) return null;
  return { loadout: parsed.data.loadout, default: parsed.data.default, custom: parsed.data.custom };
}

export function createPresets({ store }: { store: PresetStore }) {
  async function get(input: PresetsGetInput = {}): Promise<PresetsView> {
    parse(PresetsGetInputSchema, input, "presets show");
    return presetsView(await readDoc(store));
  }

  /**
   * A patch over the current document. Each stated part replaces its field
   * whole; a part left out is carried over, healed the way a read heals it (a
   * loadout slot naming a custom preset this same patch deleted is emptied, a
   * default that left the loadout moves to its first filled slot). A stated
   * loadout or default is held strictly instead: naming a preset that does not
   * exist, or a default that is not in the loadout, is refused.
   */
  async function set(input: PresetsSetInput): Promise<PresetsView> {
    const req = parse(PresetsSetInputSchema, input, "presets set");
    if (req.reset === true) {
      await store.write(null);
      return presetsView(null);
    }
    const current = normalizePresetsDoc((await readDoc(store)) ?? builtinPresetsDoc());
    const custom = req.custom ?? current.custom;

    // An unknown size is kept on a preset another build wrote, never minted here.
    for (const p of custom) {
      if (isSizeId(p.size)) continue;
      const before = current.custom.find((c) => c.id === p.id);
      if (before === undefined || before.size !== p.size) {
        refuse(`preset ${p.id}: unknown size ${p.size}`);
      }
    }

    const known = new Set([...BUILTIN_PRESETS.map((p) => p.id), ...custom.map((p) => p.id)]);
    let loadout: (string | null)[];
    if (req.loadout !== undefined) {
      const seen = new Set<string>();
      for (const id of req.loadout) {
        if (id === null) continue;
        if (!known.has(id)) refuse(`loadout: no preset ${id}`);
        if (seen.has(id)) refuse(`loadout: ${id} is in the loadout twice`);
        seen.add(id);
      }
      loadout = [...req.loadout];
    } else {
      loadout = current.loadout.map((id) => (id !== null && known.has(id) ? id : null));
    }

    const filled = loadout.filter((id): id is string => id !== null);
    let def: string | null;
    if (req.default !== undefined) {
      def = req.default;
      if (def === null && filled.length > 0) refuse("default: the loadout needs a default preset");
      if (def !== null && !filled.includes(def)) refuse(`default: ${def} is not in the loadout`);
    } else {
      def =
        current.default !== null && filled.includes(current.default)
          ? current.default
          : (filled[0] ?? null);
    }

    const stored: Stored = { version: 1, loadout, default: def, custom };
    await store.write(JSON.stringify(stored));
    return presetsView({ loadout, default: def, custom });
  }

  return { get, set };
}

/** The machine flags `agent create` was given, in `CreateAgentInput`'s spelling. */
export interface CreateMachineFlags {
  preset?: string | undefined;
  size?: string | undefined;
  instance_type?: string | undefined;
  volume_gib?: number | undefined;
  root_gib?: number | undefined;
  volume_id?: string | undefined;
}

export interface ResolvedCreatePreset {
  /** The preset that applies, or `null` when none does. */
  preset: PresetView | null;
  /** The fields the preset fills: only those no flag stated. */
  machine: { size?: string; volume_gib?: number; root_gib?: number };
  /** The laptop's default preset, when it was skipped because this build cannot use it. */
  skipped_default: PresetView | null;
}

/**
 * What `agent create` sends for the machine, given this laptop's presets.
 *
 * `--preset <id|name>` names one; with none, and no explicit machine flag at
 * all, the laptop's default preset applies — the same one the New agent panel
 * opens on, so the two heads' untouched creates build the same machine. A
 * stated `--size`, `--instance-type`, `--volume-gib` or `--root-gib` wins over
 * the preset's value for that field. `--volume` (the reclaim path) means the
 * preset never sets `volume_gib`: attaching a volume is not resizing it.
 *
 * The request core receives stays explicit: a preset is resolved here, into
 * the three fields, and core never learns a preset was involved.
 */
export function resolveCreatePreset(
  view: PresetsView,
  flags: CreateMachineFlags,
): ResolvedCreatePreset {
  let preset: PresetView | null = null;
  let skipped: PresetView | null = null;
  if (flags.preset !== undefined) {
    preset = findPreset(view.presets, flags.preset);
    if (preset === null) {
      throw new HermeticError(
        "NOT_FOUND",
        `no create preset ${flags.preset}; \`hermetic presets show\` lists them`,
      );
    }
    if (!preset.usable) {
      throw new HermeticError(
        "VALIDATION",
        `preset ${preset.id} names size ${preset.size}, which this build does not know`,
      );
    }
  } else {
    const explicit =
      flags.size !== undefined ||
      flags.instance_type !== undefined ||
      flags.volume_gib !== undefined ||
      flags.root_gib !== undefined;
    const fallback = explicit || view.default === null ? null : findPreset(view.presets, view.default);
    if (fallback?.usable) preset = fallback;
    else if (fallback !== null) skipped = fallback;
  }
  if (preset === null) return { preset: null, machine: {}, skipped_default: skipped };
  const machine: ResolvedCreatePreset["machine"] = {};
  if (flags.size === undefined && flags.instance_type === undefined) machine.size = preset.size;
  if (flags.volume_gib === undefined && flags.volume_id === undefined) {
    machine.volume_gib = preset.volume_gib;
  }
  if (flags.root_gib === undefined) machine.root_gib = preset.root_gib;
  return { preset, machine, skipped_default: null };
}
