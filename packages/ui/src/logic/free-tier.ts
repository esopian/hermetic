/**
 * Settings › Defaults' "Set to AWS Free Tier" (§10): what the button writes,
 * as pure functions, so the plan the drawer shows and the requests it sends
 * are one computation.
 *
 * Two writes, to two owners, because the machine has two (§4.6):
 *
 * - the fleet's `defaults.size`, `defaults.volume_gib` and `defaults.root_gib`
 *   (`settings.set`) — what `agent create` falls back to on any laptop whose
 *   loadout is empty, and what the CLI shows as the fleet's machine;
 * - this laptop's create presets (`presets.set`) — the `free-tier` built-in
 *   placed in the loadout and made its default, which is what an untouched
 *   create drawer and an untouched `hermetic agent create` actually build.
 *
 * The numbers come from `AWS_FREE_TIER` in `@hermetic/core/shared`; nothing
 * here restates one.
 */
import { AWS_FREE_TIER, FREE_TIER_PRESET_ID, isFreeTierMachine } from "@hermetic/core/shared";
import type { PresetsView } from "@hermetic/core/shared";
import type { SettingsResult, SettingsSetInput } from "../api/index.ts";
import { docOf, placeInSlot } from "./preset-loadout.ts";

export interface FreeTierPresetsPlan {
  loadout: (string | null)[];
  default: string;
  /** The preset whose slot the baseline takes, or `null` for an empty slot or none taken. */
  replaces: string | null;
  /** 1-based, as the Create presets page numbers its cards. */
  slot: number;
}

/**
 * Where the `free-tier` preset goes: its own slot if it is already in the
 * loadout, else the first empty slot, else the slot of the current default —
 * the card an untouched create was going to use, which is the one being
 * replaced in spirit anyway. Never a slot the operator did not see named.
 */
export function freeTierPresetsPlan(view: PresetsView): FreeTierPresetsPlan {
  const doc = docOf(view);
  const at = doc.loadout.indexOf(FREE_TIER_PRESET_ID);
  if (at >= 0) {
    return { loadout: doc.loadout, default: FREE_TIER_PRESET_ID, replaces: null, slot: at + 1 };
  }
  const empty = doc.loadout.indexOf(null);
  const fromDefault = doc.default === null ? -1 : doc.loadout.indexOf(doc.default);
  const slot = empty >= 0 ? empty : Math.max(0, fromDefault);
  const replaces = doc.loadout[slot] ?? null;
  const next = placeInSlot(doc, FREE_TIER_PRESET_ID, slot);
  return { loadout: next.loadout, default: FREE_TIER_PRESET_ID, replaces, slot: slot + 1 };
}

/** The `settings.set` patch: the machine and nothing else, CAS'd on the version the page holds. */
export function freeTierSettingsPatch(result: SettingsResult): SettingsSetInput {
  return {
    defaults: { ...AWS_FREE_TIER.machine },
    expected_version: result.persisted ? result.settings.version : null,
  };
}

export interface FreeTierState {
  /** The fleet's machine defaults are the baseline's. */
  fleet: boolean;
  /** This laptop's default create preset is `free-tier`; `null` while presets are unread. */
  laptop: boolean | null;
}

export function freeTierState(result: SettingsResult, view: PresetsView | null): FreeTierState {
  return {
    fleet: isFreeTierMachine(result.settings.defaults),
    laptop: view === null ? null : view.default === FREE_TIER_PRESET_ID,
  };
}

/** What the row says about where the fleet and this laptop stand. */
export function freeTierStateText(s: FreeTierState): string {
  if (s.fleet && s.laptop === true) return "applied";
  if (s.fleet) return "fleet only";
  if (s.laptop === true) return "this laptop only";
  return "not applied";
}
