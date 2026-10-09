import { z } from "zod";
import { AGENT_NAME_RE } from "../shared/naming.ts";
export { AGENT_NAME_RE } from "../shared/naming.ts";
import { Iso, ProfileId, Region, SecretSlug } from "./common.ts";
import { AutoClearRead, NotificationSource, NotificationView } from "./notification.ts";
import { Plan } from "./ops.ts";
import { Provider, ROOT_GIB_MAX, ROOT_GIB_MIN, SecretsMode, Size } from "./agent.ts";
import { ProfileName } from "./profile.ts";
import { HermesSettings } from "./hermes.ts";
import { FLEET_KEY, FleetDefaults, NetworkMode } from "./fleet.ts";
import { FleetName } from "./directory.ts";
import { VolumeId } from "./volumes.ts";
import { HermesLogFile } from "./rpc.ts";

/**
 * The twelve digits of an AWS account id, typed back by the operator (§4.7 step
 * 3). It is the ceremony for account-level destruction, so it appears on every
 * request that can reach one — `init`, `teardown`, and the `apply` of a teardown
 * plan — and always under this name.
 */
export const ConfirmAccountId = z.string().regex(/^\d{12}$/, "twelve digits, no separators");

export const AgentName = z
  .string()
  .regex(AGENT_NAME_RE)
  .refine((n) => n !== FLEET_KEY, { message: "reserved name" });
export type AgentName = z.infer<typeof AgentName>;

export const CreateAgentInput = z
  .object({
    name: AgentName,
    size: Size.optional(),
    instance_type: z.string().min(1).optional(),
    /**
     * A bare provider, as a convenience (§8.3). It does not name a credential:
     * core resolves it to the fleet's *designated* profile for that provider —
     * the fleet default when its provider matches, else the single ready
     * profile of that provider — and refuses with `AMBIGUOUS_PROFILE` when
     * there is more than one to choose between. Never given together with
     * `provider_profile`.
     */
    provider: Provider.optional(),
    /**
     * The provider profile this agent is created against, by id or by name
     * (§8.3). It is where the provider, the model and the credential all come
     * from, and the row pins the profile's revision so a later edit of the
     * profile is a change an operator applies rather than one that happens.
     *
     * Absent falls back to `provider`, and then to the fleet's default profile.
     */
    provider_profile: z.string().min(1).optional(),
    secrets: SecretsMode.optional(),
    volume_gib: z.number().int().min(8).max(16384).optional(),
    /**
     * The box's own root disk (§7.1). Unrelated to `volume_gib` above, which
     * sizes the `/data` volume: this one holds the operating system, Hermes and
     * its browser stack, and is replaced with the instance.
     *
     * Compatible with `volume_id` in a way `volume_gib` is not — reclaiming a
     * volume says nothing about the root disk of the box that will read it.
     */
    root_gib: z.number().int().min(ROOT_GIB_MIN).max(ROOT_GIB_MAX).optional(),
    /**
     * **No longer accepted on a fresh create** (§8.3), and still declared so
     * that core can refuse it with a sentence that says where keys live now
     * rather than with "unrecognized key". A credential belongs to a provider
     * profile; `hermetic providers create --provider <p> --api-key-stdin` is
     * the one place a key is typed.
     *
     * It is redacted wherever a head records an input (`redactCreateInput`) for
     * as long as the field exists at all: a refusal must not be the thing that
     * writes a key to the `runs` log.
     */
    api_key: z.string().min(1).optional(),
    /**
     * Undo, in reverse order, whatever *this run* created, if the create fails
     * after it claimed the row — then rethrow the original error (`rollback.ts`).
     *
     * Off by default, because create is resume-forward (§4.5): a half-made agent
     * is a row that names what exists in AWS, and any operator can re-run
     * `create` to finish it or `destroy` to clean it up. Rolling back instead is
     * the choice of an operator — usually a script, or a first attempt — who
     * would rather have nothing than something to finish, and it is never
     * inferred. It never touches a volume or an instance the run merely *found*
     * by tag, nor the secrets and config of a resumed create.
     */
    rollback_on_failure: z.boolean().optional(),
    /**
     * Build this agent on a volume that already exists, instead of creating one
     * (§6.2 step 6). The reclaim path: `destroy` keeps the data volume, so an
     * agent's memory outlives it, and this is how it gets read again.
     *
     * Create skips `CreateVolume`, refuses if the volume is in use, unmanaged,
     * or in another AZ than the fleet launches into, and rewrites the volume's
     * `agent` tag when the new name differs — otherwise `findVolumeByTag` would
     * never find it again. The rewrite is recorded as an event, never confirmed
     * a second time.
     */
    volume_id: VolumeId.optional(),
    /**
     * How Hermes itself is configured on this agent (§6.4) — the model above all,
     * since an agent whose model nobody chose is an agent that cannot answer.
     * Everything here is optional; what is left unsaid comes from
     * `HERMES_DEFAULTS` and the provider's `default_model` at render time, so a
     * create that names nothing still produces a usable agent.
     */
    hermes: HermesSettings.optional(),
  })
  .refine((v) => v.volume_id === undefined || v.volume_gib === undefined, {
    message: "--volume takes the volume as it is; --volume-gib would have to resize it",
    path: ["volume_gib"],
  });
export type CreateAgentInput = z.infer<typeof CreateAgentInput>;

/** `volume ls` (§9). `unattached` narrows to what nothing is reading. */
export const ListVolumesInput = z.object({
  unattached: z.boolean().optional(),
});
export type ListVolumesInput = z.infer<typeof ListVolumesInput>;

/** `volume status <volume-id>`. */
export const VolumeRefInput = z.object({ volume_id: VolumeId });
export type VolumeRefInput = z.infer<typeof VolumeRefInput>;

/**
 * `volume delete <volume-id> --yes` (§9). One step and a typed confirmation,
 * the same ceremony `agent destroy --yes` has — not a plan. The whole plan is
 * one line, so a review stage would show nothing the confirmation does not, and
 * the volume's snapshots keep it recoverable for as long as the DLM policy
 * holds them (§7.1).
 */
export const DeleteVolumeInput = z.object({
  volume_id: VolumeId,
  yes: z.boolean(),
});
export type DeleteVolumeInput = z.infer<typeof DeleteVolumeInput>;

/**
 * `agent set` — re-renders and re-uploads the agent's config, so the change
 * takes effect on the next rerun or recreate (§9): those are the two things
 * that run an apply, and `set` itself never touches the box.
 */
export const SetAgentInput = z.object({
  name: AgentName,
  /**
   * The row version the caller was looking at when they decided (§8.3).
   *
   * Optional, and exactly the guard `SettingsSetInput.expected_version` is for
   * the fleet's settings: a drawer left open while somebody else staged a
   * provider change, or a second terminal, would otherwise overwrite that
   * staging with a patch composed against a row that no longer exists. Core
   * refuses `CONFLICT` when the row has moved, so the loser re-reads instead of
   * silently winning.
   *
   * Absent means "whatever the row says now", which is what a one-shot script
   * and every call written before this field wants.
   */
  expected_version: z.number().int().nonnegative().optional(),
  secrets: SecretsMode.optional(),
  provider: Provider.optional(),
  /**
   * Move this agent onto another provider profile, by id or by name (§8.3).
   *
   * It is *staged*, not applied: core writes `Agent.pending` and the existing
   * `apply` rollout is what copies the credential, re-renders the manifest and
   * asks the box to take it. Switching profiles resets the model to the new
   * profile's unless `model` is stated in the same call.
   */
  provider_profile: z.string().min(1).optional(),
  /**
   * Re-pin the profile this agent is already on at its latest revision (§8.3) —
   * which is how a key rotation, a model change or a rename made on the profile
   * reaches an agent that was bound to an earlier revision. An explicit model
   * override on the row is kept; pass `model` to change it in the same call.
   */
  refresh_profile: z.boolean().optional(),
  /**
   * The model this agent runs. Stated at the top level rather than inside
   * `hermes` because it is the one Hermes setting a profile also has an opinion
   * about: with a profile change staged it is the staged model, and without one
   * it is an ordinary managed setting merged onto `hermes` exactly as before.
   */
  model: z.string().min(1).max(200).optional(),
  size: Size.optional(),
  instance_type: z.string().min(1).optional(),
  /** Takes effect on the next `recreate`, exactly as `size` does (§7.1). */
  root_gib: z.number().int().min(ROOT_GIB_MIN).max(ROOT_GIB_MAX).optional(),
  hermes_version: z.string().optional(),
  /**
   * Hermes's own configuration. Unlike the fields above this one is a *merge*,
   * not a replacement: `agent set --model X` must not silently clear a
   * `max_turns` the operator set last week. Core merges it onto whatever the
   * row already carries.
   */
  hermes: HermesSettings.optional(),
});
export type SetAgentInput = z.infer<typeof SetAgentInput>;

export const DestroyAgentInput = z.object({
  name: AgentName,
  yes: z.boolean(),
  delete_volume: z.boolean().optional(),
});
export type DestroyAgentInput = z.infer<typeof DestroyAgentInput>;

export const AgentRefInput = z.object({ name: AgentName });
export type AgentRefInput = z.infer<typeof AgentRefInput>;

/** Recreate terminates a running instance, so it needs the same `--yes` destroy does. */
export const RecreateAgentInput = z.object({
  name: AgentName,
  yes: z.boolean().default(false),
});
export type RecreateAgentInput = z.infer<typeof RecreateAgentInput>;

/**
 * `hermetic upgrade` (§6.5). The two halves are not symmetrical:
 *
 * - `--hermes V` is per-agent, so it needs a target — a name or `--all`.
 * - `--hermeticd V` is fleet-wide: it moves the one pointer in the fleet
 *   manifest that every box follows. There is nothing for a target to select,
 *   so it takes none — and `--hermeticd` *with* a name is refused by core with
 *   `VALIDATION`, because "upgrade hermeticd on this one box" is not a thing
 *   the fleet manifest can express.
 */
export const UpgradeInput = z
  .object({
    name: AgentName.optional(),
    hermes: z.string().optional(),
    hermeticd: z.string().optional(),
    all: z.boolean().optional(),
  })
  .refine((v) => v.hermes !== undefined || v.hermeticd !== undefined, {
    message: "one of --hermes or --hermeticd is required",
  })
  .refine((v) => v.hermes === undefined || v.all === true || v.name !== undefined, {
    message: "--hermes needs an agent name or --all",
  });
export type UpgradeInput = z.infer<typeof UpgradeInput>;

/**
 * Who a `secrets` command is about. Every agent slot belongs to an agent, so
 * this is `AgentName` plus the single exception: the fleet's Tailscale OAuth
 * client secret (§8.3) belongs to no agent, and `_fleet` is the name an
 * operator types to reach it. The refinements below are what keep it from
 * leaking into an agent's slots.
 *
 * `HistoryInput` reuses it, because the fleet item's event log is reached by
 * the same name — the reserved key is legal exactly where hermetic writes
 * something under it, and nowhere else.
 */
export const SecretsTargetName = z.union([AgentName, z.literal(FLEET_KEY)]);
export type SecretsTargetName = z.infer<typeof SecretsTargetName>;

/**
 * How many slot-selecting flags a push carries; exactly one is legal.
 *
 * `shared` counts even though it is a string rather than a boolean: it names
 * which slot to write just as much as `--provider-key` does, and a push that
 * carried both would be two different writes with one value.
 */
function pushFlagCount(v: {
  provider_key?: boolean | undefined;
  bws_token?: boolean | undefined;
  from_bitwarden?: boolean | undefined;
  tailscale_oauth?: boolean | undefined;
  shared?: string | undefined;
}): number {
  return (
    [v.provider_key, v.bws_token, v.from_bitwarden, v.tailscale_oauth].filter((f) => f === true)
      .length + (v.shared === undefined ? 0 : 1)
  );
}

/** The flags that write a fleet-wide slot rather than an agent's (§8.3). */
function isFleetFlag(v: {
  tailscale_oauth?: boolean | undefined;
  shared?: string | undefined;
}): boolean {
  return v.tailscale_oauth === true || v.shared !== undefined;
}

export const SecretsPushInput = z
  .object({
    name: SecretsTargetName,
    /** The model provider's API key, into `/hermes/<name>/provider-key` (§8.1). */
    provider_key: z.boolean().optional(),
    bws_token: z.boolean().optional(),
    from_bitwarden: z.boolean().optional(),
    /**
     * The one fleet-wide slot (§8.3, §5): the Tailscale OAuth client secret,
     * into `/hermetic/tailscale/oauth-secret`, with the client id parsed out of
     * it into its companion slot and onto `_fleet`. It exists because Tailscale
     * cannot add a scope to an existing client — widening the fleet's client
     * from `auth_keys` alone to `auth_keys` + `devices:core` means creating a
     * new client and rotating the secret, and this is that rotation.
     */
    tailscale_oauth: z.boolean().optional(),
    /**
     * The other fleet-wide slot (§8.3): a *shared* provider key, into
     * `/hermetic/secrets/<slug>`, which every future `agent create` on a
     * provider naming this slug copies into that agent's own slot rather than
     * prompting for. The slug is the name of the slot and never a value.
     */
    shared: SecretSlug.optional(),
    /** What an operator calls this slot in a list. Only meaningful with `shared`. */
    label: z.string().max(80).optional(),
    /**
     * Re-copy the new value into the slots of agents already running on it.
     * Rotating a shared secret does *not* reach live agents on its own (§8.3) —
     * each box reads only its own copy — so re-keying is a stated act, and each
     * named agent takes it on its next `recreate`.
     */
    rekey: z.union([z.literal("all"), z.array(AgentName).min(1)]).optional(),
    /** Read from stdin by the head; core takes the value and never logs it. */
    value: z.string().optional(),
  })
  .refine((v) => pushFlagCount(v) > 0, {
    message:
      "one of --provider-key, --bws-token, --from-bitwarden, --tailscale-oauth or --shared is required",
  })
  .refine((v) => pushFlagCount(v) <= 1, {
    message: "those flags write different slots; push one at a time",
  })
  .refine((v) => !isFleetFlag(v) || v.name === FLEET_KEY, {
    message: `the Tailscale OAuth secret and shared secrets are fleet-wide slots: use \`${FLEET_KEY}\``,
  })
  .refine((v) => v.name !== FLEET_KEY || isFleetFlag(v), {
    message: `\`${FLEET_KEY}\` has the Tailscale OAuth slot and the shared slots: use --tailscale-oauth or --shared <slug>`,
  })
  .refine((v) => v.label === undefined || v.shared !== undefined, {
    message: "--label names a shared slot; it goes with --shared",
  })
  .refine((v) => v.rekey === undefined || v.shared !== undefined, {
    message: "--rekey re-copies a shared slot; it goes with --shared",
  });
export type SecretsPushInput = z.infer<typeof SecretsPushInput>;

/**
 * `secrets ls` (§8.2). There is one set of fleet-level slots and the answer is
 * always every one of them, so it takes nothing — and it returns no value, ever.
 */
export const SecretsListInput = z.object({}).partial();
export type SecretsListInput = z.infer<typeof SecretsListInput>;

/**
 * `secrets rm <slug>` (§8.2). `yes` is the same posture `volumes.delete` has:
 * core refuses without it rather than trusting the head to have asked, because
 * a slot deleted is a key nobody on the laptop still has.
 */
export const SecretsDeleteInput = z.object({
  slug: SecretSlug,
  yes: z.boolean().optional(),
});
export type SecretsDeleteInput = z.infer<typeof SecretsDeleteInput>;

export const SecretsVerifyInput = z.object({ name: SecretsTargetName });
export type SecretsVerifyInput = z.infer<typeof SecretsVerifyInput>;

/**
 * How every profile-addressing request names one: the profile's `id`, or the
 * `name` an operator gave it. The id is tried first, so a profile somebody
 * named after another profile's id cannot shadow it (§8.3).
 */
export const ProfileSelector = z.string().min(1).max(40);
export type ProfileSelector = z.infer<typeof ProfileSelector>;

/** `settings show` (§9). There is one settings object; it takes nothing. */
export const SettingsGetInput = z.object({}).partial();
export type SettingsGetInput = z.infer<typeof SettingsGetInput>;

/**
 * The fleet's Hermes defaults as a *request* states them, which is not the
 * shape they are stored in: every key gains `null`, spelling "clear this one
 * key". `FleetSettings.agent_defaults` stays plain `HermesSettings`, so no
 * `null` ever reaches storage — the merge in `settings.set` turns a stated
 * `null` into a deleted key.
 */
const HermesSettingsPatch = HermesSettings.extend({
  model: HermesSettings.shape.model.nullable(),
  terminal_backend: HermesSettings.shape.terminal_backend.nullable(),
  max_turns: HermesSettings.shape.max_turns.nullable(),
  reasoning_effort: HermesSettings.shape.reasoning_effort.nullable(),
  approvals_mode: HermesSettings.shape.approvals_mode.nullable(),
});

/**
 * `settings set` (§9): a *patch*, not a replacement.
 *
 * Every part is optional and at least one must be present, because a write
 * that names nothing is an operator mistake rather than a no-op worth
 * performing on a fleet-wide item.
 *
 * `agent_defaults` has three meanings, and they are the reason it is a patch
 * schema of its own: absent leaves the fleet's Hermes defaults alone, `null`
 * clears all of them — the one thing an absent key cannot say — and an object
 * merges key by key onto what is stored, where a key set to `null` clears that
 * one key and a key set to any other value replaces it.
 *
 * `defaults` omits `provider`. Since §8.3 the thing a create with no flags
 * resolves is the fleet's default *profile*, not a bare provider, so the field
 * that names it is `default_profile` — a profile id or name — and
 * `_fleet.defaults.provider` is left as the pre-profile record it now is.
 */
export const SettingsSetInput = z
  .object({
    defaults: FleetDefaults.omit({ provider: true }).partial().optional(),
    agent_defaults: HermesSettingsPatch.nullable().optional(),
    /** The profile a create with no `--provider-profile` resolves to (§8.3). */
    default_profile: ProfileSelector.optional(),
    /**
     * The `settings.version` this write was composed against. Given, a
     * mismatch is `CONFLICT` before anything is written; omitted, the store's
     * own conditional write still refuses a lost update — this is how a head
     * makes that refusal happen at the version the operator actually read.
     */
    expected_version: z.number().int().positive().nullable().optional(),
  })
  .refine(
    (v) =>
      v.defaults !== undefined || v.agent_defaults !== undefined || v.default_profile !== undefined,
    { message: "name at least one of defaults, agent_defaults or default_profile" },
  );
export type SettingsSetInput = z.infer<typeof SettingsSetInput>;

/** `providers ls` (§9). One set of profiles per fleet, so it takes nothing. */
export const ProvidersListInput = z.object({}).partial();
export type ProvidersListInput = z.infer<typeof ProvidersListInput>;

/**
 * `providers create` (§9): a new named credential for one provider.
 *
 * `api_key` is write-only in every direction — read from a prompt or stdin by
 * the head, never a flag value, never echoed back on the result, and stripped
 * from anything the run log records (`redactProvidersCreateInput`). It is
 * *optional*: model discovery is not a prerequisite for saving a profile, and a
 * profile without a key is simply not ready rather than not creatable.
 */
export const ProvidersCreateInput = z.object({
  provider: Provider,
  name: ProfileName,
  /** Absent takes the provider's catalog default, resolved once and then persisted. */
  model: z.string().min(1).max(200).optional(),
  api_key: z.string().optional(),
  /** Absent means enabled: a profile nobody can use is not worth creating. */
  enabled: z.boolean().optional(),
  /** Make this the fleet default profile in the same write. */
  default: z.boolean().optional(),
  expected_version: z.number().int().positive().nullable().optional(),
});
export type ProvidersCreateInput = z.infer<typeof ProvidersCreateInput>;

/**
 * `providers update <id|name>` (§9): a *patch* over one profile.
 *
 * `provider` is not here and never will be: it is immutable after create, and a
 * request that names it is refused rather than ignored, so a caller that
 * believed it could switch endpoints under a bound agent finds out.
 */
export const ProvidersUpdateInput = z
  .object({
    profile: ProfileSelector,
    name: ProfileName.optional(),
    model: z.string().min(1).max(200).optional(),
    enabled: z.boolean().optional(),
    /** Rotates the key in the profile's existing slot. Write-only, like create's. */
    api_key: z.string().optional(),
    default: z.boolean().optional(),
    expected_version: z.number().int().positive().nullable().optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.model !== undefined ||
      v.enabled !== undefined ||
      v.api_key !== undefined ||
      v.default !== undefined,
    { message: "name at least one of --name, --model, --enable/--disable, a key, or --default" },
  );
export type ProvidersUpdateInput = z.infer<typeof ProvidersUpdateInput>;

/**
 * `providers rm <id|name>` (§9). `yes` is the same posture `secrets rm` has:
 * core refuses without it rather than trusting the head to have asked, because
 * the profile's own credential slot goes with it.
 */
export const ProvidersDeleteInput = z.object({
  profile: ProfileSelector,
  yes: z.boolean().optional(),
});
export type ProvidersDeleteInput = z.infer<typeof ProvidersDeleteInput>;

/**
 * `providers models` (§9): the provider's own catalog, fetched live.
 *
 * Exactly one of `profile` and `provider`. A saved profile uses the credential
 * the fleet already holds; a bare provider is the *setup* case, where the only
 * credential is the draft one the operator is typing — which is why `api_key`
 * is admitted only beside `provider`, and why it is never persisted, never
 * logged, and never in the answer.
 */
export const ProvidersModelsInput = z
  .object({
    profile: ProfileSelector.optional(),
    provider: Provider.optional(),
    api_key: z.string().optional(),
  })
  .refine((v) => (v.profile === undefined) !== (v.provider === undefined), {
    message: "name exactly one of --profile or --provider",
  })
  .refine((v) => v.api_key === undefined || v.provider !== undefined, {
    message: "a draft key goes with --provider; a saved profile already has one",
  });
export type ProvidersModelsInput = z.infer<typeof ProvidersModelsInput>;

/** One entry of a provider's catalog, normalised across six different shapes. */
export const CatalogModel = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  capabilities: z
    .object({
      text: z.boolean().optional(),
      tools: z.boolean().optional(),
      vision: z.boolean().optional(),
      context: z.number().int().positive().optional(),
    })
    .optional(),
  /**
   * The selected or default model, absent from the catalog the provider just
   * returned. Marked rather than dropped: a custom id an operator entered, or a
   * model a provider retired, must stay visible and stay selected (§8.3).
   */
  unlisted: z.boolean().optional(),
});
export type CatalogModel = z.infer<typeof CatalogModel>;

export const ProvidersModelsOutput = z.object({
  provider: Provider,
  /** The profile this was fetched for, when it was fetched for one. */
  profile: ProfileId.optional(),
  models: z.array(CatalogModel),
  /** What a new profile on this provider would select, pinned first in `models`. */
  default_model: z.string(),
  fetched_at: z.string(),
});
export type ProvidersModelsOutput = z.infer<typeof ProvidersModelsOutput>;

export const InitInput = z.object({
  /**
   * The branch of §4.7 step 4 to take. `auto` detects; `attach` and `create`
   * force one and fail if the other applies, for scripts. `--attach`/`--create`
   * set the booleans below and normalise to this.
   */
  mode: z.enum(["attach", "create", "auto"]).optional(),
  attach: z.boolean().optional(),
  create: z.boolean().optional(),
  reset: z.boolean().optional(),
  yes: z.boolean().optional(),
  profile: z.string().min(1).optional(),
  region: Region.optional(),
  network: NetworkMode.optional(),
  /** The twelve digits the operator typed to confirm (§4.7 step 3). */
  confirm_account_id: z.string().optional(),
  /** Alias of `confirm_account_id`; both spellings mean the typed twelve digits. */
  account_id_typed: z.string().optional(),
  /** Tailscale OAuth client secret, only on the create branch. Never logged. */
  tailscale_oauth_secret: z.string().optional(),
  /**
   * The tailnet name, e.g. `acme.ts.net`. Required on the create branch (§6.4),
   * but not from the caller: `init` detects it from this machine's own Tailscale
   * daemon and uses that. Supplying it overrides the detected value, and a
   * disagreement is reported as a warning on the op — an operator who types it
   * has said something deliberate, and core does not talk them out of it (§3.2).
   */
  tailnet: z.string().min(3).optional(),
  /**
   * Create a foundation even though this machine is not on a tailnet (§4.7
   * preflight). The escape hatch for a headless or CI `init --create`; it is
   * recorded on the op, because the resulting fleet is reachable only by
   * whoever *is* on the tailnet.
   */
  skip_tailscale_check: z.boolean().optional(),
  /**
   * Create without pushing `hermeticd` (§3.6). Headless escape hatch, recorded
   * on the op: the fleet it produces cannot launch an agent until
   * `hermetic artifacts push` runs somewhere that has the binary.
   */
  skip_artifacts: z.boolean().optional(),
  /**
   * Do not write hermetic's blocks into the tailnet policy file (§4.7). For
   * operators whose policy lives in git and is deployed from there: a write
   * from `init` would be an edit their pipeline did not make, and the next
   * deploy would silently take it out again. They get the paste-ready snippet
   * instead, which is what everyone got before this existed.
   */
  skip_policy: z.boolean().optional(),
  /**
   * Retired (§4.6). A fleet is created with no display alias and labelled
   * afterwards with `hermetic fleet alias <fleet-id> <alias>`, so `--name` is
   * refused on the create branch rather than silently meaning something else.
   * It is still accepted on the attach branch, where it only ever *selected* an
   * existing fleet by its label — `--fleet` is the spelling that does that now.
   */
  name: FleetName.optional(),
  /**
   * Which existing fleet `--attach` is about, by `fleet_id` or display alias
   * (§4.7). Never a rename: attaching to a fleet joins this laptop to it and
   * leaves its label exactly as the directory has it.
   */
  fleet: z.string().min(1).optional(),
  /**
   * The region the account-global directory table lives in (§4.8). One per
   * account, so it is asked for once, at `init`, and persisted locally
   * afterwards; `HERMETIC_DIRECTORY_REGION` overrides it for a single command.
   */
  directory_region: Region.optional(),
});
export type InitInput = z.infer<typeof InitInput>;

/**
 * `hermetic teardown --yes` (§9). The four flags decide how much of the account
 * goes with the stack; each has a default, so a head that knows nothing about
 * them still gets the documented behaviour. The exported type is the *input*
 * shape — `{ yes: true }` alone is a valid call — and `TeardownInput.parse`
 * resolves it to `ResolvedTeardownInput`, where every flag is present.
 */
export const TeardownInput = z.object({
  yes: z.boolean(),
  /**
   * The twelve digits of the frozen account, typed by the operator (§4.7 step
   * 3). Optional here because the *interactive* heads compare it themselves
   * before they ever call core; when it is present core re-checks it against
   * the frozen `config.account_id` and refuses on a mismatch. The HTTP route
   * requires it — a browser has no prompt to type at, so the UI sends it — and
   * `apply` requires it for a teardown plan, which is the one path that used to
   * reach a whole-foundation delete with no ceremony at all.
   */
  confirm_account_id: ConfirmAccountId.optional(),
  /** Delete the SSM parameters under `/hermetic/` and `/hermes/` too (§8). */
  purge: z.boolean().default(true),
  /** Delete the DLM snapshots tagged `hermetic:role=data`. Off: they are precious (§1). */
  delete_snapshots: z.boolean().default(false),
  /** Delete leftover volumes tagged `hermetic:managed=true`. Off: they are precious (§1). */
  delete_volumes: z.boolean().default(false),
  /** Archive the runs log and drop the frozen config row, so the home re-inits (§4.6). */
  reset_local: z.boolean().default(true),
});
export type TeardownInput = z.input<typeof TeardownInput>;
/** What `TeardownInput.parse` returns: the same shape with every flag resolved. */
export type ResolvedTeardownInput = z.output<typeof TeardownInput>;

/**
 * Where the lines come from. `agent` is the hermeticd RPC over the tailnet — the
 * good case, and useless in the one that matters: a boot that fails before the
 * tailnet is up cannot serve its own logs. `console` reads the instance's serial
 * console straight from EC2, which needs nothing from the box at all, so it is
 * the fallback that always answers (§6.3).
 */
export const LogSource = z.enum(["agent", "console"]);
export type LogSource = z.infer<typeof LogSource>;

/**
 * `unit`, `file` and `source: "console"` are three different places the lines
 * can come from, and exactly one of them answers a given request. Naming two is
 * refused rather than resolved by precedence: an operator who asked for
 * `errors.log` and got the journal would read an empty stream as "nothing went
 * wrong", which is the opposite of what happened.
 */
export const LogsInput = z
  .object({
    name: AgentName,
    unit: z.string().min(1).optional(),
    /** One of Hermes's own log files on the data volume instead of a journal unit. */
    file: HermesLogFile.optional(),
    follow: z.boolean().optional(),
    source: LogSource.optional(),
  })
  .refine((i) => !(i.unit && i.file), {
    message: "unit and file name different sources; pass one or the other",
    path: ["file"],
  })
  .refine((i) => !(i.file && i.source === "console"), {
    message: "the serial console carries no Hermes log files; drop --console or --file",
    path: ["file"],
  });
export type LogsInput = z.infer<typeof LogsInput>;

export const SshInput = z.object({ name: AgentName });
export type SshInput = z.infer<typeof SshInput>;

/**
 * `agent rerun` (§9): re-run the bootstrap stages that are not `ok`, resuming at
 * the first failure. Name-only, so it *is* `AgentRefInput` — the same object
 * `agents.get`/`stop`/`start` validate with — under the name the method reads by.
 */
export const RerunInput = AgentRefInput;
export type RerunInput = z.infer<typeof RerunInput>;

export const HistoryInput = z.object({
  /**
   * `SecretsTargetName`, not `AgentName`, so `_fleet` can be read. The fleet
   * item has a history for the same reason an agent does — `secrets push _fleet
   * --tailscale-oauth` and `foundation update` both append to it — and it was
   * the one log with no way to read it: the append side already wrote `_fleet`
   * events, and the read side refused the only name that reaches them.
   */
  name: SecretsTargetName,
  limit: z.number().int().min(1).max(1000).optional(),
});
export type HistoryInput = z.infer<typeof HistoryInput>;

export const ListAgentsInput = z.object({
  status: z.string().optional(),
});
export type ListAgentsInput = z.infer<typeof ListAgentsInput>;

/** `hermetic teardowns` — the permanent local record of §4.6. */
export const TeardownsListInput = z.object({
  last: z.boolean().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});
export type TeardownsListInput = z.infer<typeof TeardownsListInput>;

export const RunsListInput = z.object({
  last: z.boolean().optional(),
  agent: AgentName.optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});
export type RunsListInput = z.infer<typeof RunsListInput>;

/**
 * `hermetic inbox` (§4.9): the local notification log, read newest
 * first. `since` is what a poller passes — rows strictly newer than a timestamp
 * it already delivered — so a reconnecting client is not handed its own inbox
 * a second time. `view` picks the slice (`NotificationView`); absent is
 * `inbox`, the rows still in front of the operator.
 */
export const NotificationsListInput = z.object({
  unread: z.boolean().optional(),
  limit: z.number().int().min(1).max(500).default(100),
  since: Iso.optional(),
  view: NotificationView.optional(),
});
export type NotificationsListInput = z.infer<typeof NotificationsListInput>;

/** The most rows one inbox write may name, so a batch is one bounded statement. */
export const NOTIFICATION_BATCH_MAX = 500;

const NotificationIds = z.array(z.string().min(1)).min(1).max(NOTIFICATION_BATCH_MAX);

/** How many of a request's selectors are present; every inbox write wants exactly one. */
function selectorCount(...present: boolean[]): number {
  return present.filter(Boolean).length;
}

/**
 * `hermetic inbox ack <id...>` / `--all`, optionally `--unread`. Exactly one
 * selector, for the reason `FleetsAliasInput` insists on exactly one: "mark
 * everything read" is a different instruction from "mark these read", and a
 * request carrying both says neither.
 *
 * `unread` reverses the write — it clears `read_at` — and is refused with
 * `all`: "mark everything unread" is not a thing anybody asks for, and a
 * mistyped one would bury the inbox's only record of what was already seen.
 */
export const NotificationsAckInput = z
  .object({
    id: z.string().min(1).optional(),
    ids: NotificationIds.optional(),
    all: z.boolean().optional(),
    unread: z.boolean().optional(),
  })
  .refine((v) => selectorCount(v.id !== undefined, v.ids !== undefined, v.all === true) === 1, {
    message: "provide notification ids or --all, not both",
  })
  .refine((v) => !(v.all === true && v.unread === true), {
    message: "--unread takes notification ids, not --all",
  });
export type NotificationsAckInput = z.infer<typeof NotificationsAckInput>;

/**
 * `hermetic inbox clear <id...>` / `--read` / `--resolved`, optionally
 * `--restore`. Clearing takes rows out of the inbox and into History, where
 * they stay until retention deletes them (§4.9).
 *
 * `read` and `resolved` address the inbox view in the caller's scope — the
 * rows the operator can see, not the whole table. `restore` puts named rows
 * back (clearing both `cleared_at` and `snoozed_until`), which is what an undo
 * sends; it takes ids only, because "restore everything I have ever cleared"
 * would resurrect a month of history in one keystroke.
 */
export const NotificationsClearInput = z
  .object({
    ids: NotificationIds.optional(),
    read: z.boolean().optional(),
    resolved: z.boolean().optional(),
    restore: z.boolean().optional(),
  })
  .refine((v) => selectorCount(v.ids !== undefined, v.read === true, v.resolved === true) === 1, {
    message: "provide notification ids, --read or --resolved — exactly one",
  })
  .refine((v) => !(v.restore === true && v.ids === undefined), {
    message: "--restore takes notification ids",
  });
export type NotificationsClearInput = z.infer<typeof NotificationsClearInput>;

/**
 * `hermetic inbox snooze <id...> --until <iso>` / `--clear`. Either a moment
 * to hide the rows until, or `clear` to bring them back now — never both. The
 * moment has to be in the future; that is checked against core's clock when the
 * request runs, not here, because a schema has no clock worth trusting.
 */
export const NotificationsSnoozeInput = z
  .object({
    ids: NotificationIds,
    until: Iso.optional(),
    clear: z.boolean().optional(),
  })
  .refine((v) => (v.until !== undefined) !== (v.clear === true), {
    message: "provide --until or --clear, not both",
  });
export type NotificationsSnoozeInput = z.infer<typeof NotificationsSnoozeInput>;

/**
 * `hermetic inbox settings [--auto-clear …] [--clear-resolved-on-read …]`.
 * A patch: each stated field replaces its value, and an empty request reads.
 */
export const NotificationsSettingsInput = z.object({
  auto_clear_read: AutoClearRead.optional(),
  clear_resolved_on_read: z.boolean().optional(),
});
export type NotificationsSettingsInput = z.infer<typeof NotificationsSettingsInput>;

/**
 * `hermetic inbox mute <agent>` / `mute source:<source>` / `--clear`. The two
 * things that can be silenced are mutually exclusive: a mute is one target, and
 * `--clear` says which direction the write goes rather than what it addresses.
 */
export const NotificationsMuteInput = z
  .object({
    agent: AgentName.optional(),
    source: NotificationSource.optional(),
    clear: z.boolean().optional(),
  })
  .refine((v) => (v.agent !== undefined) !== (v.source !== undefined), {
    message: "mute an agent or a source, not both",
  });
export type NotificationsMuteInput = z.infer<typeof NotificationsMuteInput>;

/* ── chat (§9.2) ────────────────────────────────────────────────────────── */

/**
 * The Hermes profile that *is* `$HERMES_HOME` on a box. Today every box has
 * exactly one profile and it is this one — "a swarm of one" (§9.2) —
 * so every command that addresses a bot falls back to it when the operator
 * named only an instance.
 */
export const ChatListeningInput = z.object({});
export type ChatListeningInput = z.infer<typeof ChatListeningInput>;
export const ChatListenInput = z.object({ instance: AgentName, listening: z.boolean() });
export type ChatListenInput = z.infer<typeof ChatListenInput>;

export const DEFAULT_BOT = "default";

/**
 * A Hermes profile name, as an address rather than as a label.
 *
 * The shape is narrow because a bot name is a *path segment*: it is spliced
 * into the URL the adapter builds for the box's gateway, and a name containing
 * `/` or `..` would address something other than a bot on that box. The one
 * place a bot name is validated is here, for the same reason `names.ts` is the
 * one place an agent name is (§6.1).
 */
export const BotName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/i, "a bot name is letters, digits, dot, underscore and hyphen");
export type BotName = z.infer<typeof BotName>;

/**
 * `hermetic bots ls [--instance <n>]` — one instance's roster, or every
 * instance's.
 *
 * The instance is optional because the rail's default scope is all listened-to instances
 * (§9.2): the question an operator asks first is "who is there", and
 * asking it one box at a time is the shape the portal exists to replace. A
 * fleet-wide read is a fan-out over boxes that can each be unreachable
 * independently, which is why `Swarm` carries `reachable` rather than the read
 * carrying a failure.
 */
export const ChatSwarmsInput = z.object({ instance: AgentName.optional() });
export type ChatSwarmsInput = z.infer<typeof ChatSwarmsInput>;

/** `hermetic chat ls <instance>/<bot>` — the bot's conversations, with their origins. */
export const ChatSessionsInput = z.object({ instance: AgentName, bot: BotName });
export type ChatSessionsInput = z.infer<typeof ChatSessionsInput>;

/**
 * `hermetic chat log <instance>/<bot> [--limit]` — the transcript, which lives
 * on the box (§9.2) and is read from it every time.
 *
 * `session` is optional: a bot always has a canonical session, and omitting the
 * id means "the one the operator would be looking at". The limit bounds the
 * newest messages returned to a head. The adapter reads the durable dashboard
 * REST endpoint with latest-page ordering; an omitted bound pages the complete
 * transcript without allocating a live session or warming a model backend.
 */
export const ChatHistoryInput = z.object({
  instance: AgentName,
  bot: BotName,
  session: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});
export type ChatHistoryInput = z.infer<typeof ChatHistoryInput>;

/**
 * `hermetic chat <instance>/<bot> [message]` — one turn.
 *
 * `message` is required and non-empty: an empty turn is a mistake in every head
 * (a stray Enter in the composer, an empty pipe on the CLI) and costs one of
 * the box's ~3 warm backend slots to discover otherwise.
 *
 * The ceiling is a sanity cap, not a model's context window: an accidental
 * multi-megabyte paste (or a `cat` of the wrong file into `hermetic chat`)
 * should be refused here, by name, rather than travel the tailnet and be cut
 * down by a payload limit further along — Hermes' own gateway refuses a prompt
 * over 256 KiB, and a failure that arrives from over there names neither the
 * field nor the head that sent it. 200,000 characters is far past any message
 * a person types or a bot composes, so nothing legitimate meets it.
 */
export const ChatSendInput = z.object({
  instance: AgentName,
  bot: BotName,
  message: z.string().min(1).max(200_000),
  /** Continue a session; omitted means the bot's canonical one. */
  session: z.string().min(1).optional(),
  new_session: z.boolean().optional(),
});
export type ChatSendInput = z.infer<typeof ChatSendInput>;

export const ChatOpenInput = z.object({
  instance: AgentName,
  bot: BotName,
  session: z.string().min(1).optional(),
  new_session: z.boolean().optional(),
});
export type ChatOpenInput = z.infer<typeof ChatOpenInput>;

export const ChatCompactInput = z.object({
  instance: AgentName,
  bot: BotName,
  session: z.string().min(1).optional(),
  focus_topic: z.string().max(4000).optional(),
});
export type ChatCompactInput = z.infer<typeof ChatCompactInput>;

export const ChatArchiveInput = z.object({
  instance: AgentName,
  bot: BotName,
  session: z.string().min(1),
});
export type ChatArchiveInput = z.infer<typeof ChatArchiveInput>;

export const ChatRespondInput = z
  .object({
    instance: AgentName,
    bot: BotName,
    session: z.string().min(1),
    request_id: z.string().min(1),
    kind: z.enum(["approval", "question"]),
    choice: z.enum(["once", "session", "always", "deny"]).optional(),
    answer: z.string().max(65536).optional(),
    question_id: z.string().min(1).optional(),
  })
  .superRefine((input, ctx) => {
    if (input.kind === "approval" && !input.choice)
      ctx.addIssue({ code: "custom", path: ["choice"], message: "Approval choice required" });
    if (input.kind === "question" && input.answer === undefined)
      ctx.addIssue({ code: "custom", path: ["answer"], message: "Question answer required" });
  });
export type ChatRespondInput = z.infer<typeof ChatRespondInput>;

/**
 * `hermetic chat abort <instance>/<bot>` — stop the turn in flight.
 *
 * It names a bot rather than a turn because that is what the operator can see:
 * a turn has no id until it has produced a frame, and the reason to abort one
 * is usually that it has produced nothing.
 */
export const ChatAbortInput = z.object({
  instance: AgentName,
  bot: BotName,
  session: z.string().min(1).optional(),
});
export type ChatAbortInput = z.infer<typeof ChatAbortInput>;

/**
 * `hermetic chat watch <instance>/<bot>` — keep watching one conversation
 * (§9.2).
 *
 * The shape is `ChatHistoryInput` without the limit, and the absence is the
 * point: an observation reads a bounded tail of its own choosing
 * (`OBSERVE_WINDOW`), because the window is what its deduplication is built on
 * and a caller who narrowed it to one message would be asking for a cursor that
 * cannot tell a new message from a forgotten one.
 *
 * It carries no `message` and there is no spelling of it that does. Observation
 * is passive: it never submits a prompt, never creates a canonical session and
 * never warms a model. That is a property of the surface, not a default.
 */
export const ChatObserveInput = z.object({
  instance: AgentName,
  bot: BotName,
  /** Watch one session; omitted means the bot's canonical one. */
  session: z.string().min(1).optional(),
});
export type ChatObserveInput = z.infer<typeof ChatObserveInput>;

/**
 * What a *local* caller may push: the CLI knows a filesystem path because it is
 * running on the operator's laptop.
 */
export const ArtifactsPushInput = z.object({
  version: z.string().min(1).optional(),
  /**
   * Path of the compiled `bun build --compile --target=bun-linux-arm64` output.
   * Core reads it, pushes the bytes, and records the digest in the fleet
   * manifest — there is no `.sha256` sidecar (§3.6).
   */
  path: z.string().min(1).optional(),
  /** Bytes of the hermeticd binary, when the caller already has them. */
  bytes: z.instanceof(Uint8Array).optional(),
});
export type ArtifactsPushInput = z.infer<typeof ArtifactsPushInput>;

/**
 * What an *HTTP* caller may push: a version and nothing else. A browser must not
 * be able to name a path on the server's filesystem, so the route validates with
 * this and the binary comes from the build the server itself ships.
 */
export const ArtifactsPushApiInput = z.object({
  version: z.string().min(1).optional(),
});
export type ArtifactsPushApiInput = z.infer<typeof ArtifactsPushApiInput>;

/** `config show` takes nothing; it has its own schema so it borrows no other. */
export const ConfigShowInput = z.object({}).partial();
export type ConfigShowInput = z.infer<typeof ConfigShowInput>;

/**
 * `fleet ls` takes nothing: it lists every fleet this home has frozen and every
 * fleet the account's directory knows about, and there is one of each (§4.8).
 */
export const FleetsListInput = z.object({}).partial();
export type FleetsListInput = z.infer<typeof FleetsListInput>;

/**
 * `fleet use <fleet-id|alias>`: which frozen fleet later commands default to
 * (§4.8). The field is `fleet`, like `--fleet` and like `FleetsAliasInput`,
 * because what goes in may be either spelling — and what is recorded is always
 * the `fleet_id` the resolver answers with.
 */
export const FleetsUseInput = z.object({ fleet: z.string().min(1) });
export type FleetsUseInput = z.infer<typeof FleetsUseInput>;

/**
 * `fleet alias <fleet-id> <alias>` / `--clear` (§4.8): assign, replace or clear
 * a fleet's optional display label after it exists. The target is a `fleet_id`
 * and only a `fleet_id` — every other command takes either spelling, and this
 * one does not, because renaming *by the label being replaced* is how the wrong
 * fleet gets relabelled.
 */
export const FleetsAliasInput = z
  .object({ fleet: z.string().min(1), alias: FleetName.optional(), clear: z.boolean().optional() })
  .refine((v) => (v.clear === true) !== (v.alias !== undefined), {
    message: "provide an alias or --clear",
  });
export type FleetsAliasInput = z.infer<typeof FleetsAliasInput>;

/** `directory status` takes nothing either; there is one directory per account. */
export const DirectoryStatusInput = z.object({}).partial();
export type DirectoryStatusInput = z.infer<typeof DirectoryStatusInput>;

export const DoctorInput = z.object({}).partial();
export type DoctorInput = z.infer<typeof DoctorInput>;

/** `foundation status` takes nothing; it has its own schema so it borrows no other. */
export const FoundationStatusInput = z.object({}).partial();
export type FoundationStatusInput = z.infer<typeof FoundationStatusInput>;

/** `plan foundation` takes nothing either: the plan is of the whole foundation. */
export const PlanFoundationInput = z.object({}).partial();
export type PlanFoundationInput = z.infer<typeof PlanFoundationInput>;

/**
 * `hermetic policy` takes nothing: the policy file is the tailnet's, there is
 * exactly one of it, and hermetic manages exactly three blocks in it (§4.7).
 * Its own schema, so it borrows no other.
 */
export const PolicyStatusInput = z.object({}).partial();
export type PolicyStatusInput = z.infer<typeof PolicyStatusInput>;

/** `plan policy` takes nothing either, for the same reason. */
export const PlanPolicyInput = z.object({}).partial();
export type PlanPolicyInput = z.infer<typeof PlanPolicyInput>;

/**
 * `hermetic network status` takes nothing: there is one fleet open at a time
 * and one network mode on it (§5). Its own schema rather than a borrowed empty
 * one, so the parity test compares an object that means this and only this.
 */
export const NetworkStatusInput = z.object({}).partial();
export type NetworkStatusInput = z.infer<typeof NetworkStatusInput>;

/**
 * `plan network --to <mode>` (§5): the mode the fleet would be moved to.
 *
 * Required, and there is no default. The one thing this plan must never do is
 * guess at a target — re-networking is the most destructive operation short of
 * teardown, and "the other one" is not an instruction an operator gave.
 */
export const PlanNetworkInput = z.object({ to: NetworkMode });
export type PlanNetworkInput = z.infer<typeof PlanNetworkInput>;

/**
 * `plan rollout` (§6.5): re-render every agent's config and converge the boxes
 * that are behind.
 *
 * `agents` narrows to a subset — a rollout is the one operation an operator may
 * reasonably want to try on one box before the other eleven. Absent means every
 * agent the fleet has, which is the point of the command.
 *
 * `concurrency` is capped low and defaults to one on purpose: a converge applies
 * a *new* configuration, and a configuration that breaks a box breaks every box
 * it reaches. One at a time means a bad render stops at the first agent with
 * every agent after it untouched — the same argument `upgrade --all` makes
 * (§6.5), and it applies harder here because this one takes effect immediately
 * rather than on the next recreate.
 */
export const PlanRolloutInput = z
  .object({
    agents: z.array(z.string()).nonempty().optional(),
    concurrency: z.number().int().min(1).max(8).optional(),
  })
  .partial();
export type PlanRolloutInput = z.infer<typeof PlanRolloutInput>;

export const PlanDestroyInput = z.object({
  name: AgentName,
  delete_volume: z.boolean().optional(),
});
export type PlanDestroyInput = z.infer<typeof PlanDestroyInput>;

/**
 * `plan.teardown` takes exactly what `teardown` takes, minus the confirmation —
 * both halves of it: a dry run destroys nothing, so neither `yes` nor the typed
 * account id has anything to gate.
 */
export const PlanTeardownInput = TeardownInput.omit({ yes: true, confirm_account_id: true });
export type PlanTeardownInput = z.input<typeof PlanTeardownInput>;
export type ResolvedPlanTeardownInput = z.output<typeof PlanTeardownInput>;

export const PlanRecreateInput = z.object({ name: AgentName });
export type PlanRecreateInput = z.infer<typeof PlanRecreateInput>;

/**
 * `apply(plan)` executes a plan a head has shown the operator. Core never asks
 * "are you sure" (§3.2 rule 3) — but it does insist the head did.
 */
export const ApplyInput = z.object({
  plan: Plan,
  yes: z.boolean().default(false),
  /**
   * The twelve digits of §4.7 step 3. `yes` is the head saying "the operator
   * confirmed"; this is the ceremony a *teardown* plan additionally demands, and
   * `apply` refuses a `kind: "teardown"` plan without it. Ignored for the
   * agent-level plans, whose own confirmation is `yes` (§6.6).
   */
  confirm_account_id: ConfirmAccountId.optional(),
});
export type ApplyInput = z.infer<typeof ApplyInput>;
