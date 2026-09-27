/**
 * What the create drawer *shows* and what it *sends*, as two separate answers.
 *
 * §4.6 and §10: a fleet's `defaults` are what a create inherits when the
 * operator states nothing. `hermetic agent create atlas` states nothing, so
 * core fills every omitted field from `settings.defaults`. The drawer used to
 * state everything — it initialised `medium`, 100 GiB, the build's own root
 * disk and no secrets, and put all four on the wire whether or not
 * anybody had looked at them. Those five happen to be what `init` writes into a
 * brand-new fleet, which is why it read as correct: on a fleet whose defaults
 * were later changed to micro / 50 GiB / bitwarden, an untouched form silently
 * overrode them and produced a different agent than the same
 * untouched CLI command.
 *
 * So the two answers are kept apart:
 *
 * - **Shown** — `formDefaults` seeds the controls from the fleet's own
 *   `defaults`, so the form opens on what this fleet actually does. `/api/meta`
 *   already carries them, so there is no extra round trip and no correction
 *   flash. A server too old to report settings, or a read that failed, falls
 *   back to this build's constants — that is a display fallback and nothing
 *   more.
 * - **Sent** — `createRequestBody` omits every field the operator did not
 *   touch. Omission is the only spelling of "inherit": there is no sentinel
 *   `CreateAgentInput` accepts for it, and sending the value the form happened
 *   to be showing would pin a default that was meant to follow the fleet. It
 *   also means a fleet whose defaults changed between the drawer opening and
 *   the submit lands on the *current* default, exactly as the CLI would.
 *
 * `touched` is therefore intent, not difference: an operator who clicks the
 * size the form is already showing has chosen it, and that choice is pinned
 * even though the value did not change.
 *
 * Pure on purpose — the drawer stays about markup, and `tests/create-parity.
 * test.ts` can put this builder's output and the CLI's through the same core.
 */
import type { CreateAgentInput, Meta, ProfileView } from "../api/index.ts";
import { DEFAULT_ROOT_GIB, SIZES } from "./format.ts";
import type { SizeSpec } from "./format.ts";
import { preselectedProfile } from "./provider-logic.ts";

/**
 * Every control whose value has a fleet default behind it, as a list so that a
 * restored draft can be checked against it (`create-draft.ts`).
 */
export const CREATE_FIELDS = ["size", "volume_gib", "root_gib", "secrets", "rollback"] as const;
export type CreateField = (typeof CREATE_FIELDS)[number];

export type SecretsMode = "none" | "bitwarden";

/**
 * §6.4's approvals mode, read back off the request type rather than imported:
 * the UI may not import core (§3.1), and a hand-written union here would be a
 * second copy of the enum that nothing checks against the first.
 */
export type ApprovalsMode = NonNullable<NonNullable<CreateAgentInput["hermes"]>["approvals_mode"]>;

/** The fleet's `defaults`, narrowed to what this form renders. */
export interface FormDefaults {
  size: SizeSpec["id"];
  volume_gib: number;
  root_gib: number;
  secrets: SecretsMode;
}

/**
 * This build's own constants, used only when the fleet's defaults are not
 * reported. They are what `init` writes into a fresh fleet, so a fleet that has
 * never been reconfigured shows the same numbers either way.
 */
export const BUILD_FORM_DEFAULTS: FormDefaults = {
  size: "medium",
  volume_gib: 100,
  root_gib: DEFAULT_ROOT_GIB,
  secrets: "none",
};

function knownSize(value: unknown): SizeSpec["id"] | null {
  return SIZES.find((s) => s.id === value)?.id ?? null;
}

/** EBS has no fractional or zero size, so neither is a default worth rendering. */
function wholeGib(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** Which inherited fields the fleet itself answered for. */
export type DefaultsFromFleet = Readonly<Record<keyof FormDefaults, boolean>>;

/**
 * The fleet's defaults, and how much of them is really the fleet's.
 *
 * Every field is checked rather than trusted: this is a wire document, it may
 * have been written by a newer build that knows a size this one does not, and a
 * `Seg` or `SizeCells` whose value is not among its options renders with
 * nothing selected at all. An unreadable field falls back on its own — a fleet
 * with an unknown size still gets its own volume size.
 *
 * `from_fleet` is the half that was missing. A settings read that failed, or a
 * server too old to report one, left `values` holding this build's constants,
 * and the drawer drew them as though the fleet had said them: medium, 100 GiB,
 * a monthly cost computed from the pair — while the request, correctly, omitted
 * all of it and let core inherit whatever the fleet actually says. Shown and
 * sent then disagree, and the operator has no way to tell. So the drawer asks
 * this as well, and renders "fleet default" rather than a number it made up.
 */
export interface ResolvedDefaults {
  /** What the controls open on, guaranteed renderable by every picker. */
  values: FormDefaults;
  from_fleet: DefaultsFromFleet;
}

const NONE_FROM_FLEET: DefaultsFromFleet = {
  size: false,
  volume_gib: false,
  root_gib: false,
  secrets: false,
};

export function resolveDefaults(meta: Meta | null | undefined): ResolvedDefaults {
  const d = meta?.settings?.settings?.defaults;
  if (d === undefined || d === null) {
    return { values: BUILD_FORM_DEFAULTS, from_fleet: NONE_FROM_FLEET };
  }
  const size = knownSize(d.size);
  const volumeGib = wholeGib(d.volume_gib);
  const rootGib = wholeGib(d.root_gib);
  const secrets = d.secrets === "bitwarden" || d.secrets === "none" ? d.secrets : null;
  return {
    values: {
      size: size ?? BUILD_FORM_DEFAULTS.size,
      volume_gib: volumeGib ?? BUILD_FORM_DEFAULTS.volume_gib,
      root_gib: rootGib ?? BUILD_FORM_DEFAULTS.root_gib,
      secrets: secrets ?? BUILD_FORM_DEFAULTS.secrets,
    },
    from_fleet: {
      size: size !== null,
      volume_gib: volumeGib !== null,
      root_gib: rootGib !== null,
      secrets: secrets !== null,
    },
  };
}

/** The fleet's defaults as the form should open on them. */
export function formDefaults(meta: Meta | null | undefined): FormDefaults {
  return resolveDefaults(meta).values;
}

/** The form as the drawer holds it, plus which of its fields were chosen. */
export interface CreateFormState {
  /** Already trimmed by the caller: the name is validated before this is built. */
  name: string;
  size: SizeSpec["id"];
  volume_gib: number;
  root_gib: number;
  secrets: SecretsMode;
  rollback: boolean;
  /** The profile picked, `""` when the picker had nothing ready (submit is disabled). */
  profile_id: string;
  /** The model box's contents; `""` is "whatever the profile resolves to". */
  model: string;
  /** The chosen profile's own model, which is not an override when re-sent. */
  profile_model: string;
  /**
   * The approvals mode, `""` meaning "the operator has not touched this". Like
   * the model box it carries its own sentinel rather than joining `touched`:
   * there is no fleet value to re-seed it from — the mode is inherited by
   * *omission*, and a select showing one would be stating an answer nobody gave.
   */
  approvals_mode: ApprovalsMode | "";
  /**
   * The chosen profile's display name, for the `cli` preview only. Never on the
   * wire: the request pins the id, because a profile can be renamed onto
   * another one's name and the id is the thing that cannot move.
   */
  profile_name: string;
  /** The reclaim path's volume (§6.2 step 6), or `null` for a fresh one. */
  volume_id: string | null;
  /** Intent, not difference — see the note at the top of this file. */
  touched: ReadonlySet<CreateField>;
}

/**
 * The stored draft, narrowed to the fields a seed reads from it.
 *
 * Structural rather than imported: `create-draft.ts` reads `CREATE_FIELDS` from
 * this module, and a module that imports its own importer is a cycle nobody
 * needs. `CreateDraft` satisfies this shape, which is all either side wants.
 */
export interface CreateDraftSeed {
  size: string;
  volume: number;
  root_gib: number;
  secrets: string;
  rollback: boolean;
  profile_id: string;
  model: string;
  approvals_mode: ApprovalsMode | "";
  touched: readonly CreateField[];
}

/** Everything the drawer's opening state is a function of, except the name. */
export interface CreateSeedInput {
  /** This fleet's defaults as `resolveDefaults` read them. */
  defaults: FormDefaults;
  /** The session draft being restored, or null for a fresh drawer. */
  draft: CreateDraftSeed | null;
  /** §8.3's profiles, for the preselection, and the fleet's default among them. */
  profiles: readonly ProfileView[];
  default_profile: string | null;
  /** The volume being reclaimed (§6.2 step 6), whose size the form cannot change. */
  volume: { size_gib: number } | null;
}

/** The drawer's controls as they open, before anybody touches one. */
export interface InitialCreateForm {
  size: SizeSpec["id"];
  volume_gib: number;
  root_gib: number;
  secrets: SecretsMode;
  rollback: boolean;
  profile_id: string;
  model: string;
  approvals_mode: ApprovalsMode | "";
  touched: ReadonlySet<CreateField>;
}

/**
 * What `CreateDrawer` seeds its controls from — the one function, exported so
 * that `tests/create-parity.test.ts` can compare the drawer's *real* opening
 * state against the CLI's instead of a hand-written imitation of it. A
 * hand-written one asserts its own premise: it said `touched: new Set()` and
 * the fleet's default profile, and would have kept saying so however the drawer
 * had drifted — a control that touched itself on mount, or a picker that fell
 * back to the first ready profile, changes what an untouched create sends and
 * changed nothing in that test.
 *
 * **Untouched fields come from `defaults`, touched ones from the draft.** A
 * draft carries both the values and the set of fields somebody chose, and only
 * the second is a statement about intent: replaying a default-seeded value from
 * a draft written an hour ago shows the operator the old default while the
 * request — which omits it — creates the current one. So the draft is read for
 * exactly the fields it says were chosen, and everything else is re-seeded.
 */
export function initialCreateForm(input: CreateSeedInput): InitialCreateForm {
  const { defaults, draft, volume } = input;
  const touched = new Set<CreateField>(draft?.touched ?? []);
  const chose = (field: CreateField) => draft !== null && touched.has(field);
  return {
    // A draft is a wire-ish document too (`sessionStorage`, possibly written by
    // an older build), so its size is checked against this build's list rather
    // than trusted into a picker that would then show nothing pressed.
    size: (chose("size") ? knownSize(draft?.size) : null) ?? defaults.size,
    /*
     * The reclaim path fixes the data volume: it already has a size, and the
     * request sends the id rather than a size either way. It therefore outranks
     * the fleet default, and is outranked by a size the operator chose.
     */
    volume_gib: chose("volume_gib")
      ? (draft?.volume ?? defaults.volume_gib)
      : (volume?.size_gib ?? defaults.volume_gib),
    root_gib: chose("root_gib") ? (draft?.root_gib ?? defaults.root_gib) : defaults.root_gib,
    secrets: chose("secrets")
      ? draft?.secrets === "bitwarden"
        ? "bitwarden"
        : "none"
      : defaults.secrets,
    /*
     * `rollback` has no fleet default: core's answer to an omitted flag is
     * "keep it for a re-run" (§4.5), which is what `false` shows. So there is
     * nothing to re-seed from and the draft's value stands whenever there is one.
     */
    rollback: draft?.rollback ?? false,
    /*
     * The draft's profile, when it named one, and otherwise the fleet's default
     * *if it is ready* — never the first ready profile, which would build the
     * agent against a credential nobody picked (§8.3). The restored id is still
     * only a claim: the drawer re-reads the list and drops it if it no longer
     * holds.
     */
    profile_id:
      draft !== null && draft.profile_id !== ""
        ? draft.profile_id
        : (preselectedProfile(input.profiles, input.default_profile)?.id ?? ""),
    model: draft?.model ?? "",
    /*
     * Read straight off the draft, like `model` and unlike everything above:
     * neither is in `CREATE_FIELDS` because neither has a fleet default to
     * inherit *visibly*. The fleet's answer reaches the agent by this request
     * omitting the key, so there is no re-seeding to do and no ambiguity for
     * `touched` to resolve — `""` is already the exact spelling of "the
     * operator chose nothing", which is what a fresh drawer opens on. A mode
     * somebody picked before detouring into Settings is theirs, and coming back
     * to an emptied control was the form quietly discarding a choice.
     */
    approvals_mode: draft?.approvals_mode ?? "",
    touched,
  };
}

/**
 * The `POST /api/agents` body for this form.
 *
 * Untouched fields are absent, which is what makes an untouched drawer the same
 * request as `hermetic agent create <name>`. `rollback_on_failure` is in the
 * same rule even though it has no fleet default: core's answer for an omitted
 * one is "keep it for a re-run" (§4.5), and sending `false` says the operator
 * decided that when they did not.
 */
export function createRequestBody(form: CreateFormState): CreateAgentInput {
  const chose = (field: CreateField) => form.touched.has(field);
  const model = form.model.trim();
  /*
   * The Hermes settings the operator actually stated, and only those. An
   * absent `hermes` is not an empty one: it is what leaves the model where the
   * profile resolved it and the approvals mode where the fleet has it.
   */
  const hermes: NonNullable<CreateAgentInput["hermes"]> = {};
  if (model.length > 0 && model !== form.profile_model) hermes.model = model;
  if (form.approvals_mode !== "") hermes.approvals_mode = form.approvals_mode;
  return {
    name: form.name,
    ...(chose("size") ? { size: form.size } : {}),
    /*
     * One or the other, never both: `--volume` takes the volume as it is, and
     * resizing a volume is not something attaching it does. A reclaimed volume
     * also has no size to inherit — it already has one.
     */
    ...(form.volume_id !== null
      ? { volume_id: form.volume_id }
      : chose("volume_gib")
        ? { volume_gib: form.volume_gib }
        : {}),
    ...(chose("root_gib") ? { root_gib: form.root_gib } : {}),
    ...(chose("secrets") ? { secrets: form.secrets } : {}),
    ...(chose("rollback") ? { rollback_on_failure: form.rollback } : {}),
    /*
     * §8.3: the profile, and nothing else. No `provider`, no `api_key` — core
     * refuses a key on a fresh create, and there is no field here that could
     * produce one.
     *
     * Always sent, unlike everything above, and deliberately: the picker shows
     * a named profile and that name is the operator's answer to "which
     * credential". Omitting it would resolve to the fleet default, which is
     * usually the same profile and occasionally is not.
     */
    ...(form.profile_id === "" ? {} : { provider_profile: form.profile_id }),
    /*
     * One `hermes` object for however many of its fields were stated, built
     * above rather than spread twice: `hermes` is a single key, so two
     * conditional spreads naming it would have the second silently drop the
     * first's field on the form that set both.
     */
    ...(Object.keys(hermes).length === 0 ? {} : { hermes }),
  };
}

/**
 * The command that would produce the same agent, for the `cli` line in the
 * drawer's info box.
 *
 * Built from the same `touched` set as the request, so the line is the request:
 * a flag appears here exactly when the field appears on the wire. A preview
 * that printed `--size medium` under an untouched form was describing a command
 * that is *not* equivalent to the one the drawer sends.
 */
export function createCliLine(form: CreateFormState): string {
  const body = createRequestBody(form);
  return [
    "hermetic agent create",
    form.name || "<name>",
    body.size === undefined ? "" : `--size ${body.size}`,
    body.volume_id === undefined ? "" : `--volume ${body.volume_id}`,
    body.volume_gib === undefined ? "" : `--volume-gib ${body.volume_gib}`,
    body.root_gib === undefined ? "" : `--root-gib ${body.root_gib}`,
    body.provider_profile === undefined
      ? ""
      : `--provider-profile ${form.profile_name || body.provider_profile}`,
    body.secrets === undefined ? "" : `--secrets ${body.secrets}`,
    body.hermes?.model === undefined ? "" : `--model ${body.hermes.model}`,
    body.hermes?.approvals_mode === undefined ? "" : `--approvals ${body.hermes.approvals_mode}`,
    body.rollback_on_failure === true ? "--rollback-on-failure" : "",
  ]
    .filter(Boolean)
    .join(" ");
}
