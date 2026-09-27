/**
 * The half-typed create form, kept across a detour into Settings.
 *
 * §8.3 says a fleet with no ready provider profile offers "Set up a provider"
 * instead of a profile picker — and that is a full-page navigation away from a
 * drawer somebody has already named an agent in. Losing that form would make
 * the call-to-action a punishment, so the draft is written before the detour
 * and read back when the drawer reopens.
 *
 * `sessionStorage`, not `localStorage`: a draft is about this tab and this
 * sitting, and one that outlived the browser would repopulate a form days later
 * with a name somebody else has since taken. Keyed on `fleet_id` for the same
 * reason every other cache in the UI is — a draft belongs to the fleet it was
 * typed against, and restoring it onto another one would propose an agent on
 * the wrong account.
 *
 * Nothing secret is ever in here. There is no key field on a create any more,
 * and that is precisely why this is safe to persist at all.
 */
import { CREATE_FIELDS } from "./create-form.ts";
import type { ApprovalsMode, CreateField } from "./create-form.ts";
import { APPROVALS_MODES } from "./settings-logic.ts";

const PREFIX = "hermetic.create-draft.";

export interface CreateDraft {
  name: string;
  size: string;
  volume: number;
  /** The box's own root disk (§7.1), which the `/data` size above says nothing about. */
  root_gib: number;
  /** The profile chosen, when one was; `""` when the picker had nothing ready. */
  profile_id: string;
  /** An explicit model override; `""` means "whatever the profile resolves to". */
  model: string;
  /**
   * §6.4's approvals mode, when the operator picked one; `""` means they did
   * not, and the fleet's answer is inherited by the request omitting the key.
   */
  approvals_mode: ApprovalsMode | "";
  secrets: string;
  rollback: boolean;
  /**
   * The reclaim path's volume, when the drawer was opened onto one. A draft is
   * only restored onto the same target: a form typed for `vol-abc` restored
   * into a plain create would silently drop the volume it was about.
   */
  volume_id: string | null;
  /**
   * Which fields the operator actually chose (`create-form.ts`). Carried
   * because it *is* the form: a draft that remembered `micro` but forgot that
   * somebody picked it would come back inheriting the fleet's size instead, and
   * a draft that remembered the fleet's own seeded values as choices would pin
   * them. Both are the bug this set exists to prevent, one in each direction.
   */
  touched: CreateField[];
  /**
   * The create preset the strip had selected (§4.6), so a detour into
   * Settings › Create presets comes back on the same card. Optional and read
   * leniently: a draft without it recovers the preset from its values
   * (`initialPreset`), and one naming a preset that has since left the
   * loadout does the same.
   */
  preset?: string | null;
}

function key(fleetId: string | null): string {
  return `${PREFIX}${fleetId ?? "unbound"}`;
}

/** Storage is allowed to be unavailable (private mode, a locked-down profile). */
function store(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function saveCreateDraft(fleetId: string | null, draft: CreateDraft): void {
  try {
    store()?.setItem(key(fleetId), JSON.stringify(draft));
  } catch {
    /* A draft that cannot be saved is a form that has to be retyped, not an error. */
  }
}

export function clearCreateDraft(fleetId: string | null): void {
  try {
    store()?.removeItem(key(fleetId));
  } catch {
    /* ignore */
  }
}

/**
 * The draft for this fleet and this target, or `null`.
 *
 * Every field is checked rather than trusted: what comes back is whatever was
 * in `sessionStorage`, which may have been written by an older build of this
 * page, and a half-shaped object spread into form state would produce a drawer
 * with `undefined` in its inputs.
 */
export function loadCreateDraft(fleetId: string | null, volumeId: string | null): CreateDraft | null {
  let raw: string | null = null;
  try {
    raw = store()?.getItem(key(fleetId)) ?? null;
  } catch {
    return null;
  }
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const d = parsed as Record<string, unknown>;
  if (
    typeof d["name"] !== "string" ||
    typeof d["size"] !== "string" ||
    typeof d["volume"] !== "number" ||
    typeof d["root_gib"] !== "number" ||
    typeof d["profile_id"] !== "string" ||
    typeof d["model"] !== "string" ||
    typeof d["secrets"] !== "string" ||
    typeof d["rollback"] !== "boolean" ||
    !Array.isArray(d["touched"])
  ) {
    return null;
  }
  /*
   * A draft written before `touched` existed fails the check above and is
   * dropped rather than adapted. There is no honest way to adapt one: its
   * values were all sent unconditionally, so reading them as choices would pin
   * the very defaults this field was added to stop pinning, and reading them as
   * inherited would discard choices that were made. A draft lives for one
   * sitting in one tab, so dropping it costs a retype at most.
   */
  const touched = (d["touched"] as unknown[]).filter((f): f is CreateField =>
    (CREATE_FIELDS as readonly string[]).includes(f as string),
  );
  /*
   * `approvals_mode` is read leniently rather than checked in the block above,
   * and the difference from `touched` is the point. A draft written before this
   * field existed simply has no such key, and absence has an exact honest
   * reading here: the operator chose no mode, which is what `""` already means
   * and what a fresh drawer opens on. There is nothing to guess and therefore
   * no reason to throw an otherwise-valid form away. A value that is not one of
   * this build's three modes — a newer build's fourth, or junk — reads the same
   * way, because "chose nothing" is the only choice this drawer can show for it.
   */
  const approvals = APPROVALS_MODES.find((m) => m === d["approvals_mode"]) ?? "";
  const target = typeof d["volume_id"] === "string" ? d["volume_id"] : null;
  if (target !== volumeId) return null;
  return {
    name: d["name"],
    size: d["size"],
    volume: d["volume"],
    root_gib: d["root_gib"],
    profile_id: d["profile_id"],
    model: d["model"],
    approvals_mode: approvals,
    secrets: d["secrets"],
    rollback: d["rollback"],
    volume_id: target,
    touched,
    preset: typeof d["preset"] === "string" ? d["preset"] : null,
  };
}
