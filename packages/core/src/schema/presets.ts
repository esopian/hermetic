import { z } from "zod";
import { ROOT_GIB_MAX, ROOT_GIB_MIN } from "../shared/box.ts";
import { LOADOUT_SLOTS, PRESET_ID_RE, PRESET_NAME_MAX, isBuiltinPresetId } from "../shared/presets.ts";
export {
  BUILTIN_DEFAULT_PRESET,
  BUILTIN_LOADOUT,
  BUILTIN_PRESETS,
  CREATE_PRESETS_PREF,
  LOADOUT_SLOTS,
  builtinPresetsDoc,
  findPreset,
  normalizePresetsDoc,
  presetsView,
} from "../shared/presets.ts";
export type {
  BuiltinPreset,
  CreatePresetsDoc,
  MachinePreset,
  PresetLane,
  PresetView,
  PresetsView,
} from "../shared/presets.ts";

/**
 * Create presets (§4.6, §9): this laptop's machine bundles and the four the
 * New agent panel offers. The plain values and the read-side normalisation
 * live in `shared/presets.ts`; these are the shapes a stored row and a request
 * are held to.
 */

export const PresetId = z
  .string()
  .regex(PRESET_ID_RE, "a preset id is lowercase letters, digits and dashes, at most 40");

/**
 * An operator's own preset. `size` is any short string, not `Size`: a stored
 * row may name a size another build knows and this one does not, and that
 * preset is kept and reported unusable rather than dropped (`presetList`).
 * `presets.set` refuses an unknown size on anything but a preset it is
 * re-sending unchanged.
 */
export const CustomPreset = z.object({
  id: PresetId,
  name: z.string().trim().min(1).max(PRESET_NAME_MAX),
  size: z.string().min(1).max(40),
  volume_gib: z.number().int().min(8).max(16384),
  root_gib: z.number().int().min(ROOT_GIB_MIN).max(ROOT_GIB_MAX),
});
export type CustomPreset = z.infer<typeof CustomPreset>;

/**
 * The `prefs` row as it is stored under `create.presets`. Read leniently — a
 * loadout of the wrong length or naming a preset that is gone is healed by
 * `normalizePresetsDoc`, not refused — because a row written by another build
 * must not take the create drawer down with it.
 */
export const StoredCreatePresets = z.object({
  version: z.literal(1),
  loadout: z.array(PresetId.nullable()).max(16),
  default: PresetId.nullable(),
  custom: z.array(CustomPreset).max(200),
});
export type StoredCreatePresets = z.infer<typeof StoredCreatePresets>;

/** `presets show`: takes nothing — there is one document per laptop. */
export const PresetsGetInput = z.object({}).partial();
export type PresetsGetInput = z.infer<typeof PresetsGetInput>;

/**
 * `presets set`: a patch over the stored document (or the built-ins, when
 * nothing is stored). Each part replaces its whole field — the loadout is four
 * slots, the custom list is every custom preset — so a head that edits one
 * preset re-sends the list with it changed. `reset` deletes the row, which is
 * how the loadout goes back to Light · Standard · Heavy · GPU; it may not be
 * combined with anything else.
 */
export const PresetsSetInput = z
  .object({
    loadout: z.array(PresetId.nullable()).length(LOADOUT_SLOTS).optional(),
    default: PresetId.nullable().optional(),
    custom: z
      .array(CustomPreset)
      .max(200)
      .superRefine((list, ctx) => {
        const seen = new Set<string>();
        for (const [i, p] of list.entries()) {
          if (isBuiltinPresetId(p.id)) {
            ctx.addIssue({
              code: "custom",
              path: [i, "id"],
              message: `${p.id} is a built-in preset id`,
            });
          }
          if (seen.has(p.id)) {
            ctx.addIssue({ code: "custom", path: [i, "id"], message: `${p.id} appears twice` });
          }
          seen.add(p.id);
        }
      })
      .optional(),
    reset: z.literal(true).optional(),
  })
  .refine(
    (v) =>
      v.reset !== undefined ||
      v.loadout !== undefined ||
      v.default !== undefined ||
      v.custom !== undefined,
    { message: "name at least one of loadout, default, custom or reset" },
  )
  .refine(
    (v) =>
      v.reset === undefined ||
      (v.loadout === undefined && v.default === undefined && v.custom === undefined),
    { message: "reset replaces the whole document; send it on its own" },
  );
export type PresetsSetInput = z.infer<typeof PresetsSetInput>;
