/**
 * The create drawer's state: every control's value, which of them the operator
 * chose, the selected machine preset, and the submit.
 *
 * Kept apart from the markup so the drawer (`CreateDrawer.tsx`) and its pieces
 * under `components/create/` are layout only. What is *sent* is decided by the
 * pure builders in `create-form.ts`; what a preset *means* by
 * `create-presets.ts`. This hook is the React glue between the two.
 */
import { useEffect, useMemo, useState } from "react";
import { createAgent, fleetIdOf } from "../../api/index.ts";
import type { Meta, ProfileView, VolumeView } from "../../api/index.ts";
import { hostname, sizeSpec } from "../../logic/format.ts";
import type { SizeSpec } from "../../logic/format.ts";
import { randomAgentName } from "../../logic/name-dictionary.ts";
import { clearCreateDraft, loadCreateDraft } from "../../logic/create-draft.ts";
import type { CreateDraft } from "../../logic/create-draft.ts";
import {
  CREATE_FIELDS,
  createCliLine,
  createRequestBody,
  initialCreateForm,
  resolveDefaults,
} from "../../logic/create-form.ts";
import type {
  ApprovalsMode,
  CreateField,
  CreateFormState,
  ResolvedDefaults,
  SecretsMode,
} from "../../logic/create-form.ts";
import {
  MACHINE_FIELDS,
  applyPreset,
  bundleOf,
  fromPreset,
  initialPreset,
  knownMonthlyUsd,
  openingMachine,
  presetChanges,
  presetFields,
  stripPresets,
} from "../../logic/create-presets.ts";
import type { MachineField, MachineState } from "../../logic/create-presets.ts";
import { usePresets } from "../../state/presets-store.ts";
import type { PresetView } from "@hermetic/core/shared";
import { profileById, readyProfiles } from "../../logic/provider-logic.ts";
import { suggestedName } from "../../logic/volume-logic.ts";
import type { ProfilesState } from "../../state/state.tsx";
import { isValidName } from "@hermetic/core/shared";
import type { CreateOp } from "./types.ts";

/**
 * What a control shows in place of a value when the fleet's default for it
 * could not be read and nobody has chosen one (§4.6).
 *
 * The request omits such a field, so core creates the fleet's real answer —
 * which this portal does not know. Drawing this build's constant instead put a
 * number on screen that the create then contradicted, and priced it, which is
 * how "medium, 100 GiB, $8/mo" came to describe an agent that was about to be a
 * micro on 50 GiB. A phrase is the honest answer; a number is not available.
 */
export const INHERITED_VALUE = "fleet default";
export const INHERITED_HINT = "follows the fleet default, which the portal could not read";

const PRIMARY_SIZE_IDS = new Set<SizeSpec["id"]>(["small", "medium", "large"]);
export function isPrimarySize(id: SizeSpec["id"]): boolean {
  return PRIMARY_SIZE_IDS.has(id);
}

export interface CreateFormInput {
  meta: Meta | null;
  names: Set<string>;
  tailnet: string;
  profiles: ProfilesState;
  onVolume: VolumeView | null;
  onStart: (op: CreateOp) => void;
}

function isMachineField(f: CreateField): f is MachineField {
  return (MACHINE_FIELDS as readonly CreateField[]).includes(f);
}

export function useCreateForm({ meta, names, tailnet, profiles, onVolume, onStart }: CreateFormInput) {
  const fleetId = fleetIdOf(meta);
  const volumeTarget = onVolume?.volume_id ?? null;
  const locked = onVolume !== null;
  /**
   * A form left behind on the way to Settings → Providers (`create-draft.ts`).
   * Read once, at mount: the drawer is unmounted on close, so the initializer
   * *is* "restore what was typed before the detour".
   */
  const [draft] = useState(() => loadCreateDraft(fleetId, volumeTarget));
  /**
   * §4.6: what this fleet's own `defaults` say a create inherits, carried on
   * `/api/meta` so the form opens on them rather than on this build's constants
   * (`create-form.ts`). Seeding only — what is *sent* is decided by `touched`.
   *
   * `from_fleet` is read as well, because the fallback is not a fleet default:
   * a failed settings read gives `values` this build's constants, and drawing
   * them as the fleet's answer is a lie the request then contradicts.
   */
  const resolved: ResolvedDefaults = useMemo(() => resolveDefaults(meta), [meta]);
  const defaults = resolved.values;
  /**
   * This laptop's create presets (§4.6): the strip is its loadout. Until the
   * read answers this is the built-in document, which is what a laptop with
   * nothing saved gets anyway (`presets-store.ts`).
   */
  const presets = usePresets().view;
  /**
   * The opening state: the fleet-seeded form (`initialCreateForm`), then — on
   * a fresh drawer — the loadout's default preset stated over its machine
   * fields. A restored draft keeps its own values and only recovers which card
   * they came from.
   */
  const [opening] = useState(() => {
    const base = initialCreateForm({
      defaults,
      draft,
      profiles: profiles.list ?? [],
      default_profile: profiles.defaultProfile,
      volume: onVolume,
    });
    const machine0: MachineState = {
      size: base.size,
      volume_gib: base.volume_gib,
      root_gib: base.root_gib,
      touched: base.touched,
    };
    const open = openingMachine(presets, machine0, draft !== null, locked, draft?.preset ?? null);
    return { seed: { ...base, ...open.machine }, preset: open.preset };
  });
  const seed = opening.seed;
  /**
   * Which controls the operator actually chose. Everything else is left off the
   * request so core inherits the fleet's answer, which is what makes an
   * untouched drawer the same create as an untouched `hermetic agent create`
   * (a preset's machine fields are chosen: the preset chose them).
   */
  const [touched, setTouched] = useState<ReadonlySet<CreateField>>(seed.touched);
  function touch(field: CreateField) {
    setTouched((prev) => (prev.has(field) ? prev : new Set([...prev, field])));
  }
  /** Reset: the field inherits again, and the effect below re-seeds its value. */
  function untouch(field: CreateField) {
    setTouched((prev) => {
      if (!prev.has(field)) return prev;
      const next = new Set(prev);
      next.delete(field);
      return next;
    });
  }
  /**
   * Whether this control is showing a value nobody can vouch for: the fleet did
   * not report a default for it and the operator has not chosen one. The form
   * says "fleet default" there and prices nothing, since the number it would
   * price is this build's constant rather than what the agent will get.
   */
  function inherits(field: keyof typeof resolved.from_fleet): boolean {
    return !resolved.from_fleet[field] && !touched.has(field);
  }

  const list = profiles.list ?? [];
  const ready = readyProfiles(list);
  /**
   * The fleet default when it is ready, and otherwise nothing: §8.3 says a
   * fleet with no usable default *requires* a choice, and quietly substituting
   * another profile would build the agent against a credential nobody picked.
   */
  const [profileId, setProfileId] = useState<string>(seed.profile_id);
  const profile: ProfileView | null = profileById(list, profileId);
  /**
   * The selection is only usable if it is still *in* the ready list. A draft
   * survives a detour through Settings, and Settings is precisely where a
   * profile gets deleted, renamed onto another id, disabled, or has its key
   * removed — so a restored `profile_id` is a claim about a list this drawer
   * has not re-read yet, not a fact.
   */
  const chosenReady = profile !== null && ready.some((p) => p.id === profile.id);

  // Opened fresh each time (App unmounts the drawer on close), so the initializer
  // is the "populate with a random name when opened" behaviour.
  const [name, setName] = useState(
    () =>
      draft?.name ??
      (onVolume
        ? // A released volume carries no `agent` tag, only `former_agent`, and that name is free again, so it is the right prefill.
          suggestedName(onVolume.agent ?? onVolume.retained_by, names) || randomAgentName(names)
        : randomAgentName(names)),
  );
  const [size, setSize] = useState<SizeSpec["id"]>(seed.size);
  // Opened already expanded when the fleet's own default is not one of the three
  // primary cells: a form seeded with `micro` must show which cell is pressed.
  const [showMoreSizes, setShowMoreSizes] = useState(() => !isPrimarySize(seed.size));
  const [volume, setVolume] = useState(seed.volume_gib);
  /**
   * The root disk, which an adopted volume says nothing about: reclaiming
   * someone's `/data` does not tell you how big the new box's own filesystem
   * should be, so this control is offered on the reclaim path too.
   */
  const [rootGib, setRootGib] = useState(seed.root_gib);
  const [secrets, setSecrets] = useState<SecretsMode>(seed.secrets);
  /**
   * The model this agent starts on. Seeded from the chosen profile — which
   * resolved it once, at profile-create time, and persisted it — so a catalog
   * that moves later cannot move an agent that is already running. Changing it
   * here is a hermetic-held override, exactly as typing one always was.
   */
  const [model, setModel] = useState(seed.model);
  /**
   * Whether this agent asks before running a command it judges dangerous.
   * Unstated by default, and unstated is what inherits: the fleet's answer (or,
   * failing that, hermetic's own `off`) is what an omitted field resolves to,
   * and it is seeded rather than managed, so the agent can still change it from
   * its own dashboard afterwards.
   */
  const [approvals, setApprovals] = useState<ApprovalsMode | "">(seed.approvals_mode);
  // Off by default, like the flag: a failed create is resumable, and keeping
  // what it made is the safer answer for anyone who has not chosen otherwise.
  const [rollback, setRollback] = useState(seed.rollback);
  /**
   * The selected preset's id, `null` when the loadout offers none (the machine
   * then follows the fleet's defaults, untouched).
   */
  const [presetId, setPresetId] = useState<string | null>(opening.preset);
  const preset: PresetView | null =
    presetId === null ? null : (presets.presets.find((p) => p.id === presetId) ?? null);
  /**
   * Whether the operator has made any machine choice yet — a card, a size, a
   * disk. Until they have, a loadout that arrives after the drawer opened (the
   * read answering, or answering differently from the built-ins) re-opens the
   * form on *its* default. A restored draft is a choice already made.
   */
  const [machineChosen, setMachineChosen] = useState(draft !== null);
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  /**
   * Settings arriving, or moving, under an open drawer — and a field reset back
   * to inheriting.
   *
   * The controls are `useState` initializers, so the first render's `defaults`
   * used to be the only ones they ever saw: a drawer opened before `/api/meta`
   * had answered — or left open while somebody changed the fleet's defaults in
   * another tab — kept showing the old numbers while the request, which omits
   * every untouched field, created the new ones.
   *
   * Only untouched fields move. A field the operator chose is theirs, and a
   * fleet edit landing under an open form must not quietly retract it. The
   * dependencies are the default *values* rather than the object, because
   * `resolveDefaults` runs on every `/api/meta` poll and returns a fresh object
   * each time.
   */
  useEffect(() => {
    if (!touched.has("size")) {
      setSize(defaults.size);
      if (!isPrimarySize(defaults.size)) setShowMoreSizes(true);
    }
    // The reclaim path's size is the volume's, and no fleet edit changes it.
    if (!touched.has("volume_gib") && !locked) setVolume(defaults.volume_gib);
    if (!touched.has("root_gib")) setRootGib(defaults.root_gib);
    if (!touched.has("secrets")) setSecrets(defaults.secrets);
    if (!touched.has("rollback")) setRollback(false);
  }, [defaults.size, defaults.volume_gib, defaults.root_gib, defaults.secrets, locked, touched]);

  /**
   * Re-read the profiles every time the drawer opens.
   *
   * The list is not polled (`useProfiles`): it changes when somebody changes
   * it, and every writer refreshes it. But "somebody" includes another terminal
   * and the Settings page this drawer deliberately sends operators to, so
   * opening a create against a list read minutes ago is exactly how a deleted
   * or disabled `profile_id` reaches `agents.create` and comes back
   * `NOT_FOUND`. One read, on mount — the drawer is unmounted on close, so
   * "on mount" is "on open".
   */
  useEffect(() => {
    profiles.refresh();
    // Mount only: `refresh` bumps an epoch the read is keyed on, so listing it
    // as a dependency would re-read forever.
  }, []);

  /**
   * …and when that read lands, a selection the list no longer offers is
   * dropped rather than submitted.
   *
   * Cleared to `""`, not quietly swapped for the fleet default: §8.3's rule is
   * that a create with no usable default *requires* a choice, and choosing on
   * the operator's behalf is how an agent gets built against a credential
   * nobody picked. The model override goes with it, for the same reason
   * `chooseProfile` resets it — it belonged to the profile that has gone.
   *
   * `profiles.list === null` is "not read yet" and must not clear anything: a
   * restored draft would lose its profile in the window before the first read
   * comes back.
   */
  const readyIds = ready.map((p) => p.id).join(",");
  useEffect(() => {
    if (profiles.list === null || profileId === "") return;
    if (readyIds.split(",").includes(profileId)) return;
    setProfileId("");
    setModel("");
  }, [profiles.list, profileId, readyIds]);

  const trimmed = name.trim();
  const taken = names.has(trimmed);
  const invalid = trimmed.length > 0 && !isValidName(trimmed);
  /**
   * A taken name is a live agent's: a destroy releases the name (§6.7). On the
   * reclaim path that means a new agent already took the volume's former name,
   * so the hint says so rather than only reporting it.
   */
  const nameHint = !trimmed
    ? "lowercase, digits, dashes · becomes the EC2 tag, SSM path and tailnet hostname"
    : taken
      ? onVolume && (onVolume.agent ?? onVolume.retained_by) === trimmed
        ? `“${trimmed}” belongs to a live agent now — pick another; the volume keeps its memory either way`
        : `“${trimmed}” already exists`
      : invalid
        ? "lowercase letters, digits and dashes · no leading dash · 1–31 chars"
        : hostname(trimmed, tailnet, undefined, fleetId);
  /**
   * A create needs a profile. `ready.length === 0` is not "pick one anyway" —
   * it is the call-to-action, and Create stays disabled behind it.
   */
  const noProfiles = profiles.list !== null && ready.length === 0;
  /**
   * `profileId !== ""` is not enough on its own: a restored draft carries an id
   * that was ready when it was typed, and the whole point of the detour it
   * survived is that the profile list changed while it was gone. Submit is
   * gated on the *current* list saying this profile exists and is ready, which
   * is the same question core asks again before it creates anything.
   */
  const disabled = !trimmed || taken || invalid || submitting || !chosenReady;

  /**
   * The whole form in one object, so the request and the `cli` preview are
   * built from the same values by the same module (`create-form.ts`) and
   * cannot describe two different creates.
   */
  const form: CreateFormState = {
    name: trimmed,
    size,
    volume_gib: volume,
    root_gib: rootGib,
    secrets,
    rollback,
    // Only a profile the current list still calls ready is an answer; `""` is
    // the state Create is disabled behind.
    profile_id: chosenReady ? profileId : "",
    model,
    approvals_mode: approvals,
    profile_model: profile?.model ?? "",
    profile_name: profile?.name ?? "",
    volume_id: volumeTarget,
    touched,
  };
  const cli = createCliLine(form);

  const machine: MachineState = { size, volume_gib: volume, root_gib: rootGib, touched };
  const changes = preset === null ? 0 : presetChanges(preset, machine, locked);

  /** The loadout arriving (or changing) under a drawer nobody has chosen a machine in yet. */
  useEffect(() => {
    if (machineChosen) return;
    const id = initialPreset(presets, null, locked);
    const p = id === null ? null : (presets.presets.find((x) => x.id === id) ?? null);
    setPresetId(id);
    const base: MachineState = { size, volume_gib: volume, root_gib: rootGib, touched };
    if (p === null) {
      // No preset left to offer: the machine goes back to the fleet's defaults.
      const next = new Set(touched);
      for (const f of MACHINE_FIELDS) next.delete(f);
      setTouched(next);
      return;
    }
    applyMachine(p, base);
    // Keyed on the document alone: the form's own values are what it replaces.
  }, [presets]);
  const monthly = knownMonthlyUsd(machine, (f) => (f === "volume_gib" && locked ? false : inherits(f)));

  function chooseSize(next: SizeSpec["id"]) {
    setSize(next);
    touch("size");
    setMachineChosen(true);
  }
  function chooseVolume(next: number) {
    setVolume(next);
    touch("volume_gib");
    setMachineChosen(true);
  }
  function chooseRoot(next: number) {
    setRootGib(next);
    touch("root_gib");
    setMachineChosen(true);
  }
  function chooseSecrets(next: SecretsMode) {
    setSecrets(next);
    touch("secrets");
  }
  function chooseRollback(next: boolean) {
    setRollback(next);
    touch("rollback");
  }
  /** Put the machine on a preset: its fields stated, nothing else moved. */
  function applyMachine(p: PresetView | null, base: MachineState) {
    if (p === null) {
      setTouched(base.touched);
      return;
    }
    const next = applyPreset(p, base, locked);
    setSize(next.size);
    setVolume(next.volume_gib);
    setRootGib(next.root_gib);
    setTouched(next.touched);
    if (!isPrimarySize(next.size)) setShowMoreSizes(true);
  }
  /**
   * A preset sets exactly the fields it names, through the same `touched` the
   * individual controls use (`create-presets.ts`). An unusable one — a custom
   * preset naming a size this build does not know — cannot be chosen.
   */
  function choosePreset(id: string) {
    const p = presets.presets.find((x) => x.id === id);
    if (p === undefined || bundleOf(p) === null) return;
    setPresetId(id);
    setMachineChosen(true);
    applyMachine(p, machine);
  }
  /**
   * Whether a Customize field reads as changed. A machine field under a preset
   * is changed when it has left the preset's value; anything else when the
   * operator stated it (and never the reclaim path's fixed volume).
   */
  function fieldChanged(f: CreateField): boolean {
    if (locked && f === "volume_gib") return false;
    if (preset !== null && isMachineField(f) && presetFields(locked).includes(f)) {
      return !fromPreset(preset, f, machine);
    }
    return touched.has(f);
  }
  /**
   * `reset` on one field: a machine field under a preset goes back to the
   * preset's value (still stated); anything else goes back to inheriting.
   */
  function resetField(f: CreateField) {
    const bundle = preset === null ? null : bundleOf(preset);
    if (bundle !== null && isMachineField(f) && presetFields(locked).includes(f)) {
      if (f === "size") setSize(bundle.size);
      if (f === "volume_gib") setVolume(bundle.volume_gib);
      if (f === "root_gib") setRootGib(bundle.root_gib);
      touch(f);
      return;
    }
    untouch(f);
  }
  /**
   * Every Customize field back where it came from: the machine to the selected
   * preset, everything else to the fleet default, and no approvals mode.
   */
  function resetAll() {
    setApprovals("");
    applyMachine(preset, { size, volume_gib: volume, root_gib: rootGib, touched: new Set() });
  }
  /**
   * Switching profile re-seeds the model rather than carrying the old one over:
   * a model id belongs to the provider that lists it, and an Anthropic id
   * submitted against an OpenAI profile is an agent that cannot answer. An
   * override the operator typed is theirs to retype on the new profile.
   */
  function chooseProfile(id: string) {
    setProfileId(id);
    setModel("");
  }

  /** The form as `create-draft.ts` stores it, for the "Set up a provider" detour. */
  function draftNow(): CreateDraft {
    return {
      name,
      size,
      volume,
      root_gib: rootGib,
      profile_id: profileId,
      model,
      approvals_mode: approvals,
      secrets,
      rollback,
      volume_id: volumeTarget,
      touched: [...touched],
      preset: presetId,
    };
  }

  /** How many Customize fields are off their preset or fleet default, for its summary line. */
  const customized = CREATE_FIELDS.filter(fieldChanged).length + (approvals === "" ? 0 : 1);

  async function submit() {
    if (disabled) return;
    setSubmitting(true);
    setFailure(null);
    try {
      /*
       * Every field the operator did not touch is *absent*, so core fills it
       * from this fleet's `defaults` — the same agent `hermetic agent create
       * <name>` would produce (`create-form.ts`).
       */
      const accepted = await createAgent(createRequestBody(form));
      clearCreateDraft(fleetId);
      const spec = sizeSpec(size);
      onStart({
        name: trimmed,
        opId: accepted.op_id,
        /*
         * Same rule as the form: a field this request omitted, whose fleet
         * default the portal could not read, is named rather than guessed. The
         * progress rail is read while the agent is being built, and a subtitle
         * claiming an instance type core is about to pick differently is the
         * same lie one screen later.
         */
        sub: onVolume
          ? `${inherits("size") ? INHERITED_VALUE : spec.instance_type} · ${onVolume.volume_id} ${onVolume.size_gib} GiB · ${onVolume.availability_zone ?? meta?.config?.region ?? ""}`
          : `${inherits("size") ? INHERITED_VALUE : spec.instance_type} · ${inherits("volume_gib") ? `${INHERITED_VALUE} data volume` : `${volume} GB data volume`} · ${meta?.config?.region ?? ""}`,
      });
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return {
    fleetId,
    locked,
    resolved,
    defaults,
    touched,
    touch,
    untouch,
    inherits,
    ready,
    profile,
    profileId,
    chosenReady,
    chooseProfile,
    noProfiles,
    name,
    setName,
    trimmed,
    taken,
    invalid,
    nameHint,
    size,
    chooseSize,
    showMoreSizes,
    setShowMoreSizes,
    volume,
    chooseVolume,
    rootGib,
    chooseRoot,
    secrets,
    chooseSecrets,
    model,
    setModel,
    approvals,
    setApprovals,
    rollback,
    chooseRollback,
    presets,
    strip: stripPresets(presets),
    preset,
    choosePreset,
    fieldChanged,
    resetField,
    changes,
    monthly,
    customized,
    resetAll,
    cli,
    disabled,
    failure,
    draftNow,
    submit,
  };
}

export type CreateFormModel = ReturnType<typeof useCreateForm>;
