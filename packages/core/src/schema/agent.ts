import { z } from "zod";
export {
  agentHostname,
  agentDashboardUrl,
  agentDesktopUrl,
  agentDesktopClientUrl,
  agentHostnameMismatch,
  staleDeviceNote,
} from "../shared/naming.ts";
export { ROOT_GIB_MIN, ROOT_GIB_MAX, DEFAULT_ROOT_GIB } from "../shared/box.ts";
import { PROVIDER_IDS } from "../shared/providers.ts";
import { SIZE_IDS } from "../shared/sizes.ts";
export { SIZE_IDS, isSizeId } from "../shared/sizes.ts";
export { PROVIDERS_LIST, PROVIDERS, providerNeedsKey } from "../shared/providers.ts";
export type { ProviderSpec } from "../shared/providers.ts";
import { browserIdentities } from "./browser.ts";
import { Iso, ProfileId, Region, Sha256, Version } from "./common.ts";
import { HermesSettings } from "./hermes.ts";

/** Stored lifecycle status (§4.3). `unreachable` is never stored — see DisplayStatus. */
export const AgentStatus = z.enum([
  "creating",
  "bootstrapping",
  "ready",
  "degraded",
  "stopping",
  "stopped",
  "destroying",
  "destroyed",
  "error",
]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const AGENT_STATUSES = AgentStatus.options;

/** What `ps` and the UI show: the stored status, or `unreachable` when the heartbeat is stale. */
export const DisplayStatus = z.enum([...AgentStatus.options, "unreachable"]);
export type DisplayStatus = z.infer<typeof DisplayStatus>;

/**
 * Named Arm instance profiles (§7.1). The initial S/M/L choices stay stable;
 * the remainder are available from the create drawer's "More sizes" picker.
 * `--instance-type` remains the escape hatch for anything else.
 */
export const Size = z.enum(SIZE_IDS);
export type Size = z.infer<typeof Size>;

export interface SizeSpec {
  readonly instance_type: string;
  readonly vcpu: number;
  readonly memGib: number;
  /** On-demand us-east-1 price per hour, derived from the ~$/mo figures in §7.1. */
  readonly hourlyUsd: number;
  readonly monthlyUsd: number;
  readonly description: string;
  /** Present only on the accelerated G5g profiles. */
  readonly gpu?: { readonly count: number; readonly memGib: number; readonly model: string };
}

/** §7.1 compute table. Monthly figures are us-east-1 on-demand at 730 h/mo. */
export const SIZES: Readonly<Record<Size, SizeSpec>> = {
  micro: {
    instance_type: "t4g.micro",
    vcpu: 2,
    memGib: 1,
    hourlyUsd: 7 / 730,
    monthlyUsd: 7,
    description: "Tiny tasks and lightweight API workers",
  },
  xxsmall: {
    instance_type: "t4g.small",
    vcpu: 2,
    memGib: 2,
    hourlyUsd: 14 / 730,
    monthlyUsd: 14,
    description: "Lightweight CLI and automation tasks",
  },
  xsmall: {
    instance_type: "t4g.medium",
    vcpu: 2,
    memGib: 4,
    hourlyUsd: 28 / 730,
    monthlyUsd: 28,
    description: "Small, burstable browser-free agents",
  },
  small: {
    instance_type: "r8g.large",
    vcpu: 2,
    memGib: 16,
    hourlyUsd: 86 / 730,
    monthlyUsd: 86,
    description: "No-browser agents: chat, API, tool-calling",
  },
  medium: {
    instance_type: "t4g.2xlarge",
    vcpu: 8,
    memGib: 32,
    hourlyUsd: 196 / 730,
    monthlyUsd: 196,
    description: "Hermes + browser + virtual display — 16 GiB is snug for this",
  },
  large: {
    instance_type: "r8g.2xlarge",
    vcpu: 8,
    memGib: 64,
    hourlyUsd: 344 / 730,
    monthlyUsd: 344,
    description: "Large contexts, multiple browser profiles, heavy local tooling",
  },
  xlarge: {
    instance_type: "r8g.4xlarge",
    vcpu: 16,
    memGib: 128,
    hourlyUsd: 688 / 730,
    monthlyUsd: 688,
    description: "Parallel browser sessions and memory-heavy tooling",
  },
  xxlarge: {
    instance_type: "r8g.8xlarge",
    vcpu: 32,
    memGib: 256,
    hourlyUsd: 1376 / 730,
    monthlyUsd: 1376,
    description: "Large concurrent workloads and local data processing",
  },
  "3xlarge": {
    instance_type: "r8g.16xlarge",
    vcpu: 64,
    memGib: 512,
    hourlyUsd: 2752 / 730,
    monthlyUsd: 2752,
    description: "Fleet-scale processing and very large contexts",
  },
  "gpu-xsmall": {
    instance_type: "g5g.xlarge",
    vcpu: 4,
    memGib: 8,
    hourlyUsd: 0.42,
    monthlyUsd: 0.42 * 730,
    description: "GPU graphics and light CUDA workloads",
    gpu: { count: 1, memGib: 16, model: "NVIDIA T4G" },
  },
  "gpu-small": {
    instance_type: "g5g.2xlarge",
    vcpu: 8,
    memGib: 16,
    hourlyUsd: 0.556,
    monthlyUsd: 0.556 * 730,
    description: "GPU-accelerated tools with more CPU headroom",
    gpu: { count: 1, memGib: 16, model: "NVIDIA T4G" },
  },
  "gpu-medium": {
    instance_type: "g5g.4xlarge",
    vcpu: 16,
    memGib: 32,
    hourlyUsd: 0.828,
    monthlyUsd: 0.828 * 730,
    description: "Balanced GPU compute and browser workloads",
    gpu: { count: 1, memGib: 16, model: "NVIDIA T4G" },
  },
  "gpu-large": {
    instance_type: "g5g.8xlarge",
    vcpu: 32,
    memGib: 64,
    hourlyUsd: 1.372,
    monthlyUsd: 1.372 * 730,
    description: "CPU-heavy GPU rendering and inference",
    gpu: { count: 1, memGib: 16, model: "NVIDIA T4G" },
  },
  "gpu-xlarge": {
    instance_type: "g5g.16xlarge",
    vcpu: 64,
    memGib: 128,
    hourlyUsd: 2.744,
    monthlyUsd: 2.744 * 730,
    description: "Dual-GPU accelerated workloads",
    gpu: { count: 2, memGib: 32, model: "NVIDIA T4G" },
  },
} as const;

export const DEFAULT_SIZE: Size = "medium";

export const Provider = z.enum(PROVIDER_IDS);
export type Provider = z.infer<typeof Provider>;

/** Whether this agent has a Bitwarden Secrets Manager integration at all (§8.1). */
export const SecretsMode = z.enum(["none", "bitwarden"]);
export type SecretsMode = z.infer<typeof SecretsMode>;

/**
 * Reported by hermeticd's heartbeat; absent until the first heartbeat lands.
 * `dashboard` is the end-to-end check — `https://<name>.<tailnet>/` answering
 * from the box itself, which proves the tailnet HTTPS cert, `tailscale serve`
 * and Hermes in one go. Optional because rows written by an older hermeticd
 * lack it; the UI shows it as pending, not failing, until a new heartbeat lands.
 */
export const Health = z.object({
  hermes: z.boolean(),
  tailscale: z.boolean(),
  disk: z.boolean(),
  dashboard: z.boolean().optional(),
});
export type Health = z.infer<typeof Health>;

/**
 * Utilisation reported by the heartbeat; the UI draws CPU/Mem/Disk bars from it.
 *
 * `disk_pct` is the **data** volume (`/data`) — the memory that survives a
 * rebuild. `root_disk_pct` is the **root** volume, which is a different failure
 * with a different remedy: it is what the self-update measures before it will
 * swap `/usr/local/bin/hermeticd`, and a box that fills it stops taking updates
 * while its `/data` bar still reads comfortable. Optional on the wire, because
 * a row written by an older hermeticd carries no such key — every reader must
 * render that absence as "not reported" (`—`), never as `0%`, which would
 * report the emptiest possible root disk for a box that never measured one.
 */
export const Metrics = z.object({
  cpu_pct: z.number().min(0).max(100),
  mem_pct: z.number().min(0).max(100),
  disk_pct: z.number().min(0).max(100),
  root_disk_pct: z.number().min(0).max(100).optional(),
  /**
   * Bytes actually free on the root filesystem, in MiB — the number the failure
   * is about, rather than the ratio it can be inferred from.
   *
   * It cannot be derived from `root_disk_pct` and `root_gib`, though it looks
   * like it can: the *volume* is not the *filesystem*. Canonical's image puts
   * an ESP and a `bls_boot` partition ahead of root, and ext4 keeps metadata
   * and a reserved-blocks margin besides, so a box at 86% of an 8 GiB volume
   * computes to ~1.12 GiB free and actually has 962 MiB. The gap is 160 MiB on
   * the smallest root disk hermetic offers, which is half of what a self-update
   * needs — exactly the margin an operator would be reading this number to
   * judge, and exactly where an estimate stops being good enough.
   *
   * hermeticd already measures it: the self-update calls `statfs` on the same
   * filesystem to decide whether it may write at all (`update.ts`). This
   * publishes what that check reads, so the dashboard and the refusal are
   * answering from one number.
   *
   * Optional, like `root_disk_pct` before it: a row written by an older
   * hermeticd carries none, and readers fall back to the estimate — marked as
   * one — rather than showing nothing.
   */
  root_free_mib: z.number().nonnegative().optional(),
});
export type Metrics = z.infer<typeof Metrics>;

/** TTL lock held while a long mutating operation runs (§4.4). */
export const Lock = z.object({
  owner: z.string().min(1),
  expires: Iso,
});
export type Lock = z.infer<typeof Lock>;

/** What each create step actually produced, so any operator can finish or clean up (§4.5). */
export const Resources = z.object({
  volume_id: z.string().optional(),
  instance_id: z.string().optional(),
  ssm_paths: z.array(z.string()),
  config_key: z.string().optional(),
});
export type Resources = z.infer<typeof Resources>;

/** How one bootstrap stage ended, as hermeticd reports it on the row (§4.2). */
export const StageStatus = z.enum(["pending", "running", "ok", "failed"]);
export type StageStatus = z.infer<typeof StageStatus>;

/** One stage of the ordered bootstrap, and what happened the last time it ran. */
export const StageState = z.object({
  /** The stage file name minus `.sh`, e.g. `01-tailscale`. */
  id: z.string(),
  status: StageStatus,
  /** Bumped by each `rerun`; a stage resumed after a failure is on attempt 2. */
  attempt: z.number().int().nonnegative(),
  started_at: Iso.nullish(),
  ended_at: Iso.nullish(),
  exit_code: z.number().int().nullish(),
  /**
   * The last redacted stderr line, truncated. Enough for the board to say why a
   * boot stopped; the full log stays on the box under `/var/log/hermetic/stages/`.
   */
  message: z.string().max(512).nullish(),
});
export type StageState = z.infer<typeof StageState>;

/**
 * The staged bootstrap's progress, written by hermeticd's runner. Present from
 * the moment the runner starts; null on a row that has never booted.
 */
export const BootstrapState = z.object({
  /** The hermeticd release whose stages ran — the fleet manifest's pointer at boot. */
  hermeticd_version: Version,
  stages: z.array(StageState),
  /** Id of the stage running right now, null between stages. */
  current: z.string().nullish(),
  started_at: Iso,
  updated_at: Iso,
  /** Ack: the last `BootstrapCommand.id` the runner applied, so it acts once. */
  last_command_id: z.string().nullish(),
});
export type BootstrapState = z.infer<typeof BootstrapState>;

/**
 * An operator instruction the resident runner polls for on its own row. The one
 * action is `rerun`: resume the stages that are not `ok`, from the first failure.
 */
export const BootstrapCommand = z.object({
  id: z.string(),
  action: z.enum(["rerun"]),
  issued_by: z.string(),
  issued_at: Iso,
});
export type BootstrapCommand = z.infer<typeof BootstrapCommand>;

/**
 * A fleet-wide rollout hint written by `foundation.update` (§6.6): "take the
 * release the manifest now points at, now, rather than on the nightly check".
 * Read by the resident runner on its heartbeat tick; never cleared, keyed by
 * `id` so a runner acts once. Older runners ignore it.
 */
export const UpdateRequest = z.object({
  id: z.string(),
  hermeticd_version: Version,
  issued_at: Iso,
  issued_by: z.string(),
});
export type UpdateRequest = z.infer<typeof UpdateRequest>;

/**
 * "Apply the config the row already names, now" — the §6.5 converge request,
 * written by a rollout and read by the resident `serve` on its heartbeat tick.
 *
 * The shape is `UpdateRequest`'s, deliberately, because the problem is the same
 * one: a fleet-wide instruction that must reach boxes whose only inbound channel
 * is their own row. Keyed by `id` so a box acts once; **never cleared**, because
 * hermetic decides "done" from a fact the box already reports — the row's
 * `applied_config_hash` reaching `config_hash`. There is no ack field to keep in
 * step with reality, and a `serve` too old to know this field simply never moves
 * its applied hash, which is exactly how the rollout reports it as unconverged
 * rather than as done.
 *
 * `config_hash` is carried rather than implied so a box can tell a request it
 * has already satisfied from one it has not: a row read mid-rollout can name a
 * newer config than the request that woke the loop.
 */
export const ApplyRequest = z.object({
  id: z.string(),
  /** The `config_hash` the requester wants applied — the row's, when it wrote this. */
  config_hash: z.string().min(1),
  issued_at: Iso,
  issued_by: z.string(),
});
export type ApplyRequest = z.infer<typeof ApplyRequest>;

/** The `agents` row (§4.2). Field names are the DynamoDB attribute names. */
export const Agent = z.object({
  name: z.string(),
  status: AgentStatus,
  version: z.number().int().nonnegative(),
  lock: Lock.nullish(),
  size: Size,
  instance_type: z.string(),
  region: Region,
  instance_id: z.string().nullish(),
  volume_id: z.string().nullish(),
  volume_gib: z.number().int().positive(),
  /**
   * The root disk this agent's instance was launched with (§7.1).
   *
   * Optional because a row written before the field existed carries none, and
   * absence is "whatever the AMI gave it" — not a number this build may invent.
   * Readers that need something to print say so as `ROOT_GIB_MIN`'s worth of
   * unknown rather than claiming today's default for a box that predates it.
   */
  root_gib: z.number().int().positive().nullish(),
  hermes_version: Version,
  hermeticd_version: Version.nullish(),
  config_hash: z.string().nullish(),
  /**
   * The config the *box* has actually applied, written only by hermeticd.
   *
   * `config_hash` above is the other half of the same question and is written
   * only by a laptop: it is what the fleet has rendered and uploaded for this
   * row. Keeping them apart is what makes drift visible — while one attribute
   * carried both meanings in turn, a box that applied a stale bundle
   * overwrote the record of what it should have applied, so the two could
   * never be compared (`configVerdict` in `skew.ts` is that comparison).
   *
   * Nullish because no row written before this field carries it, and because a
   * box that has not reported since it was created has nothing to say yet.
   * Both cases read as `unknown` rather than as agreement.
   */
  applied_config_hash: z.string().nullish(),
  /**
   * The digest of the hermeticd binary the box is *running*, written only by
   * hermeticd — the binary half of the same arrangement `applied_config_hash`
   * is the config half of.
   *
   * `hermeticd_version` above cannot do this job. It is a build-time label, and
   * `BUILD_VERSIONS.hermeticd` moves only when somebody edits it by hand, so
   * two releases a month apart both call themselves `0.5.0` while shipping
   * different bytes. Every comparison made on the label is therefore a
   * comparison of a constant with itself: it reads "up to date" for a box that
   * never took the release and for one that did, alike. The box's own updater
   * has always known better — it compares this digest against the fleet
   * manifest's (`update.ts`) — and this field is that fact reaching the fleet,
   * so a laptop can answer "did the rollout land" with something other than "the
   * box is still breathing".
   *
   * Read at process start rather than per tick, so it is the digest of the
   * binary *this process was launched from*: after a swap whose restart has not
   * happened yet, the file on disk is already the new release while the running
   * code is the old one, and the running code is what the fleet is asking about.
   *
   * Nullish for the usual two reasons: rows written before this field do not
   * carry it, and a box running a hermeticd too old to report it never will.
   * Both read as `unknown` rather than as agreement.
   *
   * Named `running_` and not `hermeticd_sha256` because `UserData` already has
   * a field by that name meaning the opposite side of the same transaction —
   * the digest cloud-init must *install*, which the laptop writes. One name for
   * "what we told it to run" and "what it is running" is how `config_hash` came
   * to carry both meanings in turn and made drift invisible; that mistake is
   * not worth making twice.
   */
  running_hermeticd_sha256: Sha256.nullish(),
  /**
   * The Hermes version the *box* reports running, read out of Hermes's own
   * `/api/health` body on the heartbeat tick — the third and last of the
   * box-written halves, beside `applied_config_hash` and
   * `running_hermeticd_sha256`.
   *
   * `hermes_version` above is the pin: `agents.create` seeds it and
   * `upgrade --hermes` moves it, and that command says in its own event text
   * that the change "takes effect on the next recreate". So between the upgrade
   * and the recreate the row named a version no box was running, and every
   * surface — the fleet table, the drawer, `foundation status` — rendered it as
   * fact. This is the same gap `config_hash`/`applied_config_hash` were split
   * to close, arriving late for the same field.
   *
   * Nullish, and read as *unknown* rather than as agreement: a hermeticd too
   * old to report it never will, and a box whose dashboard is down this tick
   * has not been asked. Deliberately **not** a skew axis (§6.6) — bumping
   * Hermes stays a manual per-agent decision, so a mismatch here is shown
   * beside the pin and never counted as drift.
   */
  /*
   * `z.string()`, deliberately, where every other version field on this row is
   * `Version`.
   *
   * This one is not hermetic's to shape. It is whatever Hermes answers with on
   * `/api/health`, and upstream is a Python project whose `__version__` follows
   * PEP 440 — `0.22.0.dev1`, `0.22.0rc1`, `0.22.0.post1` are all legal there and
   * none of them matches the strict `major.minor.patch` `Version` enforces.
   *
   * The failure mode if it did enforce it is disproportionate and silent: a row
   * that will not parse is *skipped* by `AgentStore.scan` (the agent vanishes
   * from `agent ps` and the dashboard) and *throws* in `get` (so `agent show`,
   * `stop`, `destroy` and `rerun` all fail) — and because the heartbeat rewrites
   * the same value every 30 s, the row would never heal. An agent made
   * unreachable by the version string its own Hermes reported is a far worse
   * outcome than an unusual string in a display field.
   *
   * Bounded rather than unbounded: this is a display fact, and nothing should
   * write a kilobyte into the row because a health endpoint returned something
   * strange.
   */
  running_hermes_version: z.string().min(1).max(64).nullish(),
  /** Staged bootstrap progress, written by hermeticd's runner (§4.2). */
  bootstrap: BootstrapState.nullish(),
  /** A pending operator instruction for that runner; cleared once acked. */
  command: BootstrapCommand.nullish(),
  update_request: UpdateRequest.nullish(),
  /**
   * A pending converge (§6.5). Optional and nullish for the usual reason: rows
   * written before it existed must keep parsing, and a fleet where nobody has
   * rolled out has none.
   */
  apply_request: ApplyRequest.nullish(),
  provider: Provider,
  /**
   * The provider profile this agent's running configuration came from, and the
   * revision of it that was resolved (§8.3).
   *
   * Optional because every row written before profiles existed has neither, and
   * such a row is read as belonging to whichever profile of its `provider` the
   * fleet designates — that is a fact about the fleet, not something to
   * back-fill onto the row. `provider` stays beside it as the *resolved*
   * provider of the running configuration, which is what every renderer and
   * hermeticd read; the profile is where it came from.
   */
  profile_id: ProfileId.optional(),
  profile_revision: z.number().int().positive().optional(),
  /**
   * The instance secret slot holding the credential the *running*
   * configuration was materialised from (§8.3): `provider-key` for rows
   * written before profiles existed, `provider-key-<profile_id>-r<revision>`
   * afterwards. The
   * manifest names the same slot as `provider_key_ref`, so a staged rotation
   * never overwrites the value the old configuration is still reading.
   *
   * Nullish rather than merely optional because an apply has to be able to
   * *clear* it: moving an agent onto Bedrock leaves it authenticating as the
   * instance role with no key at all, and a row that went on naming the slot
   * its previous binding filled would keep a stale credential alive in every
   * reading of the fleet. A row store cannot remove an attribute by writing
   * `undefined` (`dynamo.ts`), so the cleared state has to be a value.
   */
  credential_ref: z.string().min(1).nullish(),
  /**
   * A profile change saved but not yet applied (§8.3). `agents.set` writes it;
   * the existing apply rollout consumes it — copies the credential into the new
   * slot, re-renders the manifest, and clears this once hermeticd reports the
   * new `config_hash`. Heads render it as "Saved — pending apply".
   */
  pending: z
    .object({
      profile_id: ProfileId,
      profile_revision: z.number().int().positive(),
      provider: Provider,
      model: z.string().min(1),
      /**
       * The slot the apply will snapshot the credential into, or absent for a
       * role-authenticated provider — which has no key, and for which a slot
       * name would be a promise about a parameter nothing writes.
       */
      credential_ref: z.string().min(1).nullish(),
      staged_at: z.string(),
      staged_by: z.string(),
    })
    .nullish(),
  secrets_mode: SecretsMode,
  /**
   * How this agent configures Hermes itself (§6.4). Nullish because it is
   * entirely optional — a row that states nothing renders the fleet defaults —
   * and because rows written before this field existed do not carry it.
   */
  hermes: HermesSettings.nullish(),
  /**
   * The fleet's answers this agent was *created* with (§4.6): the model its
   * provider defaulted to plus whatever `settings.agent_defaults` stated, all
   * of it seeded rather than managed — a fleet default is not a per-agent
   * instruction, so the agent's own dashboard may still change every field here
   * (`resolveCreateDefaults`, `splitHermesSettings`).
   *
   * Pinned on the row rather than re-read from `_fleet` at render time, and
   * that is the whole reason the field exists: a later `settings set --model`
   * would otherwise change what every existing agent renders, moving each one's
   * `config_hash` and reporting the entire fleet as drifted.
   *
   * Nullish because rows written before it do not carry it; render then falls
   * back to the provider catalog's default, which is what those rows were
   * created with.
   */
  seed: HermesSettings.nullish(),
  tailscale_ip: z.string().nullish(),
  /**
   * The MagicDNS name the node actually holds (`tailscale status` `Self.DNSName`,
   * no trailing dot), reported by hermeticd. Usually `<name>.<tailnet>`, but a
   * recreate whose predecessor still sits in the tailnet's device list is
   * handed `<name>-2.<tailnet>`, and that is the only name Serve answers on and
   * the only Host the dashboard's guard admits — so every URL a head builds
   * must prefer this over the canonical spelling when the two differ.
   */
  tailscale_dns_name: z.string().nullish(),
  /**
   * The version of `tailscaled` the box is running, as the daemon reports it on
   * the heartbeat (`tailscale status --json`'s top-level `Version`) — the
   * release and its build commit, `1.86.2-t01ab2cd34`.
   *
   * The one version on the row that hermetic does not choose. `hermes_version`
   * is a pin and `hermeticd_version` is a release this laptop published;
   * Tailscale's own updater is on (`stages/01-tailscale.sh`), so this moves
   * between heartbeats and the row is the only place the fleet records where it
   * got to. A box that stops moving while the rest of the fleet advances is a
   * box whose updater is broken, and that is only visible because it is written
   * down.
   *
   * Nullish for the usual two reasons: a row written before the field existed
   * carries none, and a box that has not heartbeated has never reported one.
   * Absence reads as *unknown*, never as an old version.
   *
   * A free string, bounded, and not `Version`: Tailscale's own format is
   * `major.minor.patch-t<commit>`, an unstable build ships `1.87.0-dev…`, and
   * this is a display fact. Refusing to parse a row over it would take the
   * agent out of `agent ps` and fail every command that reads it — the
   * disproportion `running_hermes_version` spells out above.
   */
  tailscale_version: z.string().min(1).max(64).nullish(),
  resources: Resources,
  last_heartbeat: Iso.nullish(),
  health: Health.nullish(),
  metrics: Metrics.nullish(),
  created_by: z.string(),
  created_at: Iso,
  updated_at: Iso,
});
export type Agent = z.infer<typeof Agent>;

/** An agent as returned by `agents.list` / `agents.get`: the row plus derived state. */
export const AgentView = Agent.extend({
  display_status: DisplayStatus,
  heartbeat_age_ms: z.number().nullable(),
  /**
   * Whether the provider profile this agent is pinned to has moved since it was
   * pinned (§8.3) — a rotated key, a changed model, a rename. Heads render it
   * as "Update available"; nothing stages it, because a profile edit is not an
   * instruction to restart somebody's agent.
   *
   * Absent where the fleet's settings could not be read, which reads as *not
   * computed* and never as *up to date*.
   */
  update_available: z.boolean().optional(),
  /**
   * The browser identities this agent runs (§7.3), derived by
   * `browserIdentities` rather than stored: exactly one, named `default`.
   *
   * Only the two fields a head actually needs — the name to label a session
   * with, and the Serve path to point one at. A list rather than a pair of
   * scalars so that a second identity is a data change in one function rather
   * than a new field on every head.
   */
  browsers: z.array(
    z.object({
      name: z.string(),
      /** Where `tailscale serve` publishes this browser's noVNC: `/vnc`. */
      serve_path: z.string(),
    }),
  ),
});
export type AgentView = z.infer<typeof AgentView>;

/** The `browsers` an `AgentView` carries, for the one place that fills it in. */
export function agentBrowserViews(): AgentView["browsers"] {
  return browserIdentities().map((b) => ({ name: b.name, serve_path: b.serve_path }));
}
