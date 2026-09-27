import { z } from "zod";
export {
  RELEASE_PREFIX,
  FLEET_MANIFEST_KEY,
  releaseKey,
  isReleaseObjectKey,
  BROWSER_BUILD_PREFIX,
  browserBuildKey,
  CHROME_REF_RE,
  isChromeRef,
  STAGE_FILE_RE,
  orderStages,
} from "../shared/release.ts";
export { FLEET_KEY, cloudName, legacyCloudNames } from "../shared/naming.ts";
import { FleetIdSchema, Iso, ProfileId, Region, SecretSlug, Sha256, Version } from "./common.ts";
import { FleetName } from "./directory.ts";
import {
  Lock,
  PROVIDERS,
  PROVIDERS_LIST,
  Provider,
  ROOT_GIB_MAX,
  ROOT_GIB_MIN,
  SecretsMode,
  Size,
} from "./agent.ts";
import { HermesSettings } from "./hermes.ts";
import { ProviderProfile } from "./profile.ts";

/**
 * How a fleet's agents reach the internet (§5). `public` puts them in public
 * subnets with their own addresses; `nat` puts them in private subnets behind a
 * single fck-nat instance.
 *
 * One enum, shared by every place the mode is recorded or asked for — the
 * `Network` stack parameter, `_fleet.network`, the fleet manifest,
 * `foundation.status` and `InitInput` — so the spellings cannot drift apart.
 */
export const NetworkMode = z.enum(["public", "nat"]);
export type NetworkMode = z.infer<typeof NetworkMode>;

/** Per-fleet defaults a new agent inherits when flags are omitted (§10). */
export const FleetDefaults = z.object({
  size: Size,
  provider: Provider,
  volume_gib: z.number().int().positive(),
  /**
   * The root disk a new agent inherits (§7.1).
   *
   * Optional, unlike every sibling here, because this key arrived after fleets
   * existed: a `_fleet` item written by any earlier build carries no such
   * field, and a required one would make the whole settings object unparseable
   * on every fleet already in the world. Absent reads as `DEFAULT_ROOT_GIB` at
   * the one place that resolves it, never as zero and never as "the AMI's".
   */
  root_gib: z.number().int().min(ROOT_GIB_MIN).max(ROOT_GIB_MAX).optional(),
  secrets: SecretsMode,
});
export type FleetDefaults = z.infer<typeof FleetDefaults>;

/**
 * What an operator may say about a provider, as opposed to what the provider
 * *is*. `PROVIDERS` (`agent.ts`) stays the catalog — auth mode, env var, base
 * URL, the name Hermes spells it with — because those are facts about Hermes,
 * not preferences: an operator who changed them would be pointing hermetic's
 * credential somewhere hermetic did not choose.
 */
export const ProviderSettings = z.object({
  /** Whether the create drawer offers this provider at all. */
  enabled: z.boolean(),
  /** Overrides `PROVIDERS[p].default_model`; absent leaves the catalog's. */
  default_model: z.string().min(1).max(200).optional(),
  /**
   * The slug of a fleet-level shared secret holding this provider's key. Only
   * ever the *name* of a slot: no value from `/hermetic/secrets/*` is on this
   * item, on any read, ever (§8.3).
   */
  secret: SecretSlug.optional(),
});
export type ProviderSettings = z.infer<typeof ProviderSettings>;

/** A shared secret slot, described without its value (§8.2). */
export const SharedSecretMeta = z.object({
  slug: SecretSlug,
  label: z.string().max(80).optional(),
  created_at: Iso,
  last_set_at: Iso,
});
export type SharedSecretMeta = z.infer<typeof SharedSecretMeta>;

/**
 * The fleet's shared settings: what every laptop attached to this fleet
 * inherits, as against the per-laptop `prefs` table (§4.6).
 *
 * `version` is an optimistic-concurrency counter and the only reason `_fleet`
 * has one at all: the item carries no row version the way an agent does, so a
 * settings write is conditional on this number rather than on a read-then-write
 * window (`FleetStore.putSettings`).
 */
export const FleetSettings = z.object({
  version: z.number().int().positive(),
  /** The same shape `_fleet.defaults` has, and kept in sync with it on write. */
  defaults: FleetDefaults,
  /** Fleet-wide Hermes settings a create inherits where it states none (§6.4). */
  agent_defaults: HermesSettings.optional(),
  /**
   * Every catalog provider, as `defaultFleetSettings` writes it — but
   * `partialRecord`, not `record`, and the difference is a fleet that keeps
   * working. Zod's exhaustive `z.record(enum, …)` *rejects* an object missing a
   * key, so the day a provider joins `Provider` every `_fleet` written before
   * it would fail to parse and the whole item would become unreadable. Absent
   * is therefore a shape the schema admits and every reader handles — an entry
   * nobody has written yet is an enabled provider with no override.
   */
  providers: z.partialRecord(Provider, ProviderSettings),
  /**
   * The fleet's provider profiles (§8.3), by id. Optional for the reason
   * `providers` is partial: a `_fleet` written before profiles existed must
   * keep parsing, and `settingsOf` is what turns such an item into one that has
   * them (the migration below `ProviderSettings`).
   *
   * A record rather than an array because every reader addresses a profile by
   * id — an agent pins one, `default_profile` names one — and an array would
   * make each of those a scan whose answer depends on ordering nobody maintains.
   */
  profiles: z.record(ProfileId, ProviderProfile).optional(),
  /**
   * The profile `agent create` uses when the operator names none. `null` is a
   * fleet that has profiles but has designated none of them — not the same as
   * absent, which is a fleet that has not been migrated yet.
   */
  default_profile: ProfileId.nullable().optional(),
  /** Slot names and timestamps — never values (§8.3). */
  secrets: z.array(SharedSecretMeta),
  updated_at: Iso,
  updated_by: z.string(),
});
export type FleetSettings = z.infer<typeof FleetSettings>;

/**
 * The settings a fleet starts life with: today's defaults, every catalog
 * provider enabled and none of them overridden, no shared secrets.
 *
 * One function, three callers — `init` writing a fresh `_fleet`, the v2
 * foundation migration back-filling an old one, and `settings.get` synthesizing
 * the answer for a fleet that has neither yet — because "what settings does a
 * fleet have before anybody set any" must have exactly one answer.
 */
export function defaultFleetSettings(
  defaults: FleetDefaults,
  actor: string,
  nowIso: string,
): FleetSettings {
  const providers: Record<string, ProviderSettings> = {};
  for (const provider of PROVIDERS_LIST) {
    // No `default_model`: the catalog's stays the fallback, so a provider whose
    // default moves in a later hermetic release reaches a fleet that never
    // overrode it (the same rule `HERMES_DEFAULTS` follows).
    providers[provider] = { enabled: true };
  }
  return {
    version: 1,
    defaults,
    providers: providers as FleetSettings["providers"],
    secrets: [],
    updated_at: nowIso,
    updated_by: actor,
  };
}

/** The model a provider resolves to on this fleet: the override, else the catalog. */
export function providerDefaultModel(settings: FleetSettings, provider: Provider): string {
  return settings.providers[provider]?.default_model ?? PROVIDERS[provider].default_model;
}

/** The reserved `_fleet` item (§4.2): the fleet's shared settings. */
export const FleetItem = z.object({
  fleet_id: FleetIdSchema,
  /**
   * The fleet's operator-chosen name, as the directory records it (§4.8). A
   * label an operator reads and may change, and — since v4 — nothing else: it
   * names no cloud resource, and `--fleet` accepts it only as an alias for the
   * `fleet_id` that is the fleet's real identity (§4.6). It lives on `_fleet`
   * as well as in the directory so a second laptop can show what this fleet is
   * called without an account-global directory read.
   *
   * Two things still read it. `legacyCloudNames` needs it to recognise a node
   * built under v3, when the name *was* the cloud prefix, and tell that node
   * apart from one whose name a dead device took. And the heads print it.
   *
   * `fleet_name`, not `name`: the agents table's partition key *is* `name`, and
   * on this item it holds the literal `_fleet` (`FLEET_KEY`). A field called
   * `name` here would be the same attribute as the key, so every read would
   * parse `_fleet` as a fleet name and every write would clobber the key.
   *
   * Optional because a fleet created before v3 has none; the v3 foundation
   * migration back-fills it from the directory entry.
   */
  fleet_name: FleetName.optional(),
  defaults: FleetDefaults,
  ubuntu_release: z.string(),
  ami_id: z.string().regex(/^ami-[0-9a-f]{8,17}$/),
  min_hermetic_version: Version,
  /**
   * Which version of the *foundation contract* (§6.6) this fleet is on — the
   * template, the S3 layout and the state shape, as
   * `FOUNDATION_VERSION` (`version.ts`) numbers them. Absent means **0**: every
   * fleet created before `foundation.update` existed, and the reason it is
   * optional rather than defaulted here — `_fleet` items already in DynamoDB
   * must keep parsing, and "absent" is the fact `foundation.status` reports.
   */
  foundation_version: z.number().int().nonnegative().optional(),
  /**
   * The digest of the template that produced this foundation. Recorded beside
   * the version so a template edit that forgot to bump it is still detected.
   */
  foundation_template_sha256: Sha256.optional(),
  /**
   * The item's own revision counter (§4.4) — the optimistic-concurrency key an
   * agent row has had all along, arriving late on `_fleet` because this item
   * was written whole for a long time.
   *
   * It counts changes to the fleet's *content*. The lock is not content: taking
   * it, renewing it and giving it back leave this number alone, so an operation
   * that holds the lock across long phases can still name the revision it
   * composed its final write against. `settings` keeps its own counter
   * (`FleetSettings.version`), because a settings write is guarded on that one.
   *
   * Optional, and absent means **0**: every `_fleet` item written before this
   * field existed carries none and must keep parsing, and every writer treats
   * absent and `0` as the same value — so nothing has to be migrated.
   */
  version: z.number().int().nonnegative().optional(),
  /**
   * The fleet-wide TTL lock (§4.4, the same shape an agent's lock has). Held for
   * the length of a `foundation.update`, which rewrites the stack, the release
   * and every agent row — so while it is live, `acquireLock` refuses every
   * per-agent operation with `LOCKED` rather than letting one race the update.
   */
  lock: Lock.nullish(),
  foundation_updated_at: Iso.optional(),
  foundation_updated_by: z.string().optional(),
  /**
   * The fleet's shared settings (§4.6). Optional for the same reason
   * `foundation_version` is: items written before this existed must keep
   * parsing, and "absent" is a fact `settings.get` reports (`persisted: false`,
   * with `defaultFleetSettings` synthesized from `defaults`) rather than a
   * parse failure. The v2 foundation migration back-fills it.
   */
  settings: FleetSettings.optional(),
  /**
   * The Bedrock model ids this fleet's instance role may actually invoke — the
   * `BedrockModelArns` the foundation stack was last given, recorded here in
   * the spelling an operator picks a model in (§8.3).
   *
   * Absent means nobody has reconciled the grant yet, and every reader falls
   * back to `DEFAULT_BEDROCK_MODEL_IDS`, which is what such a fleet was built
   * with. It is on `_fleet` rather than derived from the stack because
   * `providers.list` reports "this Bedrock profile needs a foundation update"
   * on every read, and a CloudFormation describe per read is not that.
   */
  bedrock_model_ids: z.array(z.string().min(1)).optional(),
  /**
   * The tailnet these agents join, e.g. `hermetic.ts.net`. Every Serve URL is
   * `https://<name>.<tailnet>`, so it is fleet-wide configuration rather than
   * something a render may guess (§6.4).
   */
  tailnet: z.string().min(3),
  /**
   * The id of the Tailscale OAuth client whose secret sits in SSM, parsed out
   * of the secret at `init` (`tskey-client-<id>-…`). Not a secret — it is what
   * an operator needs to find, rotate or revoke the client in the admin
   * console, and which client a fleet uses is fleet-wide fact. Null when
   * `init --create` ran without a secret; absent on fleets older than the
   * field.
   */
  tailscale_oauth_client_id: z.string().min(1).nullable().optional(),
  /**
   * Which network mode this fleet's agents run in (§5). The authoritative copy
   * is the stack's own `Network` parameter — CloudFormation owns the subnets,
   * so it owns the answer — and this is the cache a head reads without paying
   * for a `DescribeStacks` on every command.
   *
   * Optional, and **absent does not mean `public`**: a fleet created with
   * `--network nat` before this field existed has no value here, and assuming
   * one would describe the fleet as the opposite of what it is. Absent means
   * "not yet back-filled", and the v6 foundation migration fills it from the
   * real stack parameter.
   */
  network: NetworkMode.optional(),
  region: Region,
  bucket: z.string().min(3),
  stack_id: z.string(),
  created_by: z.string(),
  created_at: Iso,
});
export type FleetItem = z.infer<typeof FleetItem>;

/**
 * Every foundation resource is named for its stack, and the stack is named for
 * its fleet: `hermetic-<fleet_id>`. Two fleets in one account therefore share no
 * name at all — no table, bucket, role or instance profile — so a leftover from
 * a torn-down fleet can never block the next `init --create`, and a `teardown`
 * can never reach across into another fleet's resources.
 */
export const STACK_PREFIX = "hermetic";

/**
 * The name fleets created before fleet-scoped naming still carry. Nothing new is
 * ever created under it; it survives as the fallback `describeStack` tries when
 * `hermetic-<fleet_id>` is not there, so an older foundation stays operable.
 */
export const STACK_NAME = STACK_PREFIX;

export function stackNameFor(fleetId: string): string {
  return `${STACK_PREFIX}-${fleetId}`;
}

/**
 * The name an agent wears *in the cloud*: `<fleet id>-<agent>`.
 *
 * Operators keep typing and seeing the bare agent name (`atlas`); this is only
 * what AWS and the tailnet see — the EC2/EBS `Name` tag, the OS hostname, and
 * the Tailscale device hostname (and therefore the MagicDNS label). Two fleets
 * in one account and one tailnet must not collide on any of those, and the
 * agent name alone is unique only within a fleet.
 *
 * Keyed on `FleetItem.fleet_id` and **not** on `fleet_name`, since v4. A fleet's
 * name is an optional display alias an operator may assign, replace or clear at
 * any time (`hermetic fleet alias <fleet-id> …`, §4.6); its id is assigned once
 * at `init --create` and never moves. Stamping a mutable label into identifiers
 * that cannot be restamped without a reboot was the defect: relabelling left
 * every instance tag, OS hostname and MagicDNS label spelling a name the fleet
 * no longer had, and `doctor` calling each of them a stale device. The id
 * cannot drift, so these names cannot.
 *
 * The bound is exact rather than lucky: `FleetIdSchema` is 8 characters and
 * `validateName` caps an agent at 31, so the longest possible cloud name is
 * 8 + 1 + 31 = 40 — inside the 63-character DNS label limit MagicDNS enforces,
 * with room the fleet-name spelling (31 + 1 + 31 = 63) did not have. Nothing
 * here truncates, because nothing can overflow (`cloud-name.test.ts` pins it).
 *
 * `fleetId` is optional so callers can pass a partial fleet straight through,
 * and absent means the bare agent name — which is what the nodes of a fleet
 * created before v3 are actually called. Core always knows the id and always
 * passes it; the fallback is for heads that have not read `_fleet` yet.
 */
/**
 * The foundation contract at which `cloudName` moved to `fleet_id` (v4).
 *
 * Named rather than written as a bare `4` at the one place that compares against
 * it, because the comparison is a *diagnosis*: an agent created after its fleet
 * reached this version, yet wearing an older spelling, is not an old box — it is
 * a fleet whose published release is older than the rule. Bumping
 * `FOUNDATION_VERSION` again must not silently change what that means, so the
 * two numbers are deliberately not the same constant.
 */
export const CLOUD_NAME_FOUNDATION_VERSION = 4;

/**
 * The foundation contract at which a box may read the mirrored Chrome build (v14).
 *
 * Foundation v14 adds `browser/*` to the agent role's S3 read and to its
 * `ListBucket` prefix condition, so any agent created on a fleet that has not
 * been updated would boot and then fail stage 04 with a 403 — which is why
 * `agents.create` and `agents.rerun` refuse with
 * `BROWSER_NEEDS_FOUNDATION_UPDATE` instead (§7.3).
 *
 * Named rather than written as a bare `14` for the same reason
 * `CLOUD_NAME_FOUNDATION_VERSION` is: the comparison means "the fleet can read
 * the mirror", not "the fleet is current", and a later `FOUNDATION_VERSION`
 * bump must not silently change what is being asked.
 */
export const BROWSER_FOUNDATION_VERSION = 14;

/** True for any stack name hermetic could have created, old shape or new. */
export function isHermeticStackName(name: string): boolean {
  return name === STACK_PREFIX || name.startsWith(`${STACK_PREFIX}-`);
}

/**
 * A foundation in one of these states is *not* attachable (§4.7 step 4): its
 * VPC, tables and bucket are on their way out, so attaching would bind a home
 * to resources that are about to stop existing, and creating would race
 * CloudFormation for the one stack name. `init` refuses with `CONFLICT` and
 * asks for a retry instead of picking either branch.
 */
export const DELETING_STACK_STATUSES = ["DELETE_IN_PROGRESS", "DELETE_FAILED"] as const;

export function isStackDeleting(status: string | null | undefined): boolean {
  return (
    status !== null &&
    status !== undefined &&
    (DELETING_STACK_STATUSES as readonly string[]).includes(status)
  );
}

/**
 * The two DynamoDB tables (§4.2), named for the stack that creates them. They
 * are stack *outputs* as well, which is what core actually reads: the names are
 * derived here only so a head can talk about them before a stack is resolved.
 */
export interface FleetTables {
  readonly agents: string;
  readonly events: string;
}

/**
 * The stack's name, read back out of the ARN `_fleet.stack_id` holds
 * (`arn:aws:cloudformation:<region>:<account>:stack/<name>/<uuid>`). It is how a
 * fleet's table names are known without a second `DescribeStacks`, and a fleet
 * created before the rename parses to plain `hermetic`, which is correct for it.
 */
export function stackNameFromId(stackId: string): string {
  const match = /:stack\/([^/]+)\//.exec(stackId);
  return match?.[1] ?? STACK_NAME;
}

export function tablesFor(stackName: string): FleetTables {
  return { agents: `${stackName}-agents`, events: `${stackName}-events` };
}

/**
 * The pre-fleet-scoped table names. Still the fallback for a foundation created
 * before the rename, and the default `hermeticd` uses when its user-data — which
 * now carries the names — predates them.
 */
export const AGENTS_TABLE = `${STACK_NAME}-agents`;
export const EVENTS_TABLE = `${STACK_NAME}-events`;

/**
 * Order two `Version` strings: negative when `a` is older, 0 when they are the
 * same release, positive when `a` is newer. Numeric field by field, so `0.10.0`
 * is newer than `0.9.0`; a pre-release suffix (`-rc1`) orders before the
 * release it precedes, as semver says.
 *
 * It exists for the decisions that must not be taken on string equality alone:
 * `init --attach` refusing to repoint a fleet *backwards* to an older hermeticd
 * than the one it already runs, and the `min_hermetic_version` gate.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { parts: number[]; pre: string | null } => {
    const [core = "", ...rest] = v.split("-");
    return {
      parts: core.split(".").map((n) => Number.parseInt(n, 10) || 0),
      pre: rest.length > 0 ? rest.join("-") : null,
    };
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.parts.length, right.parts.length); i += 1) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  if (left.pre === right.pre) return 0;
  // A pre-release precedes the release it leads to (`0.5.0-rc1` < `0.5.0`).
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  return left.pre < right.pre ? -1 : 1;
}

/**
 * A SHA-256 hex digest, as it appears in the fleet manifest. The same shape as
 * `Sha256` in `common.ts` — named here because the manifest is where digests are
 * a *contract* between the laptop that writes them and the box that verifies
 * every downloaded byte against them (§1).
 */
export const Sha256Hex = Sha256;
export type Sha256Hex = z.infer<typeof Sha256Hex>;

/**
 * The generation manifest: the last object written into a release generation,
 * and therefore the only proof that the generation is complete. Its name is a
 * constant because both the writer (`pushRelease`) and the reader
 * (`describeRelease`) have to agree on it, and neither may guess.
 */
export const RELEASE_MANIFEST_NAME = "release.json";

/** A release generation id: the first 16 hex digits of the content digest. */
export const RELEASE_GENERATION_RE = /^[0-9a-f]{16}$/;

/** One object in a release: its release-relative key, its digest and its size. */
export const FleetManifestFile = z.object({
  key: z.string().min(1),
  sha256: Sha256Hex,
  size: z.number().int().nonnegative(),
});
export type FleetManifestFile = z.infer<typeof FleetManifestFile>;

/**
 * The *fleet manifest*: `manifest.json` at the root of the fleet bucket. It
 * names the hermeticd release agents should be running, every file in that
 * release with its digest, and the fleet's AWS resources. hermeticd pulls it
 * first at boot and on every nightly update, so it — not user-data, not a
 * per-agent pin — is the single source of both "which version" and "which
 * table" on the box.
 *
 * Not to be confused with the *agent manifest* (`AgentConfig` in `manifest.ts`),
 * the rendered per-agent config inside a config tarball. Never say bare
 * "manifest" about either.
 */
export const FleetManifest = z.object({
  schema_version: z.literal(1),
  fleet_id: FleetIdSchema,
  /**
   * The fleet's name (§4.8). **Reserved**: written by `artifacts push` (and by
   * every `init`/`foundation update` that republishes), and read by nothing on
   * the box — hermeticd is told its hostname by user-data, which is decided per
   * instance at launch. It is here so the manifest is a complete description of
   * the fleet, and for a human reading `manifest.json` in the bucket.
   *
   * It is no longer what a cloud name is built from: since v4 that is
   * `fleet_id`, required above, so a box that wanted to compute `cloudName` for
   * itself already has everything it needs and this field is not on that path.
   *
   * Absent on a manifest written before v3, and still absent on a fleet that
   * has just been migrated until the next push moves the pointer.
   */
  name: FleetName.optional(),
  region: Region,
  /** The laptop build that wrote this file, for support questions. */
  hermetic_version: Version,
  hermeticd: z.object({
    /** The release agents should run. The nightly update moves this pointer. */
    version: Version,
    /**
     * Which *generation* of that version — the content digest of the release,
     * and the directory its objects live in (`releaseKey`).
     *
     * The version alone cannot address a release: two pushes of the same
     * version are two different sets of bytes, and before generations existed
     * the second overwrote the first under keys already baked into a booting
     * instance's presigned URL. Recording the generation makes the pointer name
     * exactly one immutable set of objects.
     *
     * Absent on a manifest written before generations existed, whose `files`
     * carry the flat `artifacts/<version>/…` keys. Every consumer reads
     * `files[...].key` rather than rebuilding a key from this, so absent costs
     * nothing but the ability to say which generation is live.
     */
    generation: z.string().regex(RELEASE_GENERATION_RE).optional(),
    /**
     * *Which build* of hermetic pushed this release — a fingerprint of the
     * sources `hermeticd` was compiled from, not a version. Two source
     * checkouts a day apart both call themselves `0.5.0` while shipping
     * different bytes, and a box running the older one can fail to apply a
     * manifest rendered by the newer (a unit only the newer hermeticd
     * installs). `agent create` and `agent rerun` warn when this checkout's
     * build differs at the same version.
     *
     * Absent on manifests written before this field, and on one written by
     * `upgrade --hermeticd V` — which points at a release some other laptop
     * pushed and so has no build to record. `schema_version` stays `1`: the
     * addition is purely additive and hermeticd never reads it.
     */
    build: z.string().min(1).optional(),
    /**
     * `git rev-list --count HEAD` in the checkout this release was pushed from —
     * the human-facing half of the same question `build` answers.
     *
     * `build` is a digest, and a digest can only say *different*. This can say
     * *newer*, which is a different and more useful fact: two operators sharing
     * a fleet need to know whether the release they are about to push is ahead
     * of the published one or behind it, and those call for opposite actions.
     * `foundation update` reads it to tell "you have changes to push" from
     * "your checkout is older than the fleet — pull first".
     *
     * It counts *commits*, so it only means anything because a release cannot be
     * pushed from a tree with uncommitted changes (`assertCleanTree`,
     * `WORKING_TREE_DIRTY`). Without that rule the number would repeat the
     * failure it was introduced to fix — contents moving under an identifier
     * that did not.
     *
     * Absent wherever the checkout could not say: a release pushed from a built
     * binary, from a tarball, from a shallow clone (`rev-list --count` answers
     * `1` there, which is not a smaller number but a wrong one), or by
     * `upgrade --hermeticd V` pointing at another laptop's release. Absent reads
     * as *unknown* and never as `0`.
     */
    build_number: z.number().int().positive().optional(),
    /** Short sha of that commit, so the number resolves back to a tree. */
    commit: z.string().min(1).optional(),
    /**
     * What the `hermeticd` in this release can be *asked* to do — the
     * `AGENT_CONFIG_CAPABILITIES` names it implements (`schema/manifest.ts`).
     *
     * Recorded because the box cannot be asked in advance. A capability is
     * refused by the box *when it applies*, which is the right place for a
     * running agent and no place at all for `agent create`: there is no box yet,
     * and the config is rendered minutes before one exists. With this, the
     * laptop can refuse to render a config the fleet's published release could
     * never apply, and name `hermetic artifacts push` instead of leaving a new
     * instance to fail its bootstrap eight minutes later.
     *
     * Absent means "cannot tell", and is read conservatively as *no*
     * capabilities: a manifest written before this field, and one written by
     * `upgrade --hermeticd <ver>`, which points at a release some other laptop
     * pushed and can honestly say nothing about it. Same rule `build` follows.
     */
    capabilities: z.array(z.string().min(1)).optional(),
    /** Release-relative keys → digest: `hermeticd`, `stages/01-tailscale.sh`, … */
    files: z.record(z.string(), FleetManifestFile),
  }),
  /**
   * The fleet's AWS resources, as the stack's own outputs report them. Every
   * field is required and non-empty on purpose: the box reads its table names
   * and its SSM prefix from here, so a manifest written from a stack that could
   * not be described must fail to build rather than publish a blank that
   * overwrites a good one.
   */
  resources: z.object({
    bucket: z.string().min(1),
    stack_id: z.string().min(1),
    agents_table: z.string().min(1),
    events_table: z.string().min(1),
    /**
     * Fleet-level SSM prefix, `/hermes/<fleet_id>/`. An agent's own is
     * `${param_prefix}<name>/`. Fleet-scoped since v3, and read from here
     * rather than rebuilt on the box, so a fleet whose manifest still says
     * `/hermes/` keeps reading the paths it was created with.
     */
    param_prefix: z.string().min(1),
    vpc_id: z.string().min(1),
    subnet_ids: z.array(z.string().min(1)).min(1),
    security_group_id: z.string().min(1),
    instance_profile_arn: z.string().min(1),
    role_arn: z.string().min(1),
    /**
     * The fleet's network mode (§5), so the box can see which side of the NAT
     * it is on without an AWS call. Optional for the same reason
     * `_fleet.network` is — a manifest published before the field existed has
     * none, and absent means "not recorded", never `public`.
     */
    network: NetworkMode.optional(),
  }),
  /**
   * Which foundation contract the fleet is on, as of the last
   * `foundation.update` (§6.6). Absent ⇒ version 0, which is every manifest
   * written before this field existed; `schema_version` stays `1` because the
   * addition is purely additive and an older hermeticd ignores what it does not
   * know.
   */
  foundation: z
    .object({
      version: z.number().int().nonnegative(),
      template_sha256: Sha256Hex,
      applied_at: Iso,
      applied_by: z.string(),
    })
    .optional(),
  /**
   * The Hermes source mirror: for each mirrored git ref, the bundle in this
   * fleet's bucket that carries that ref's tree, and the upstream commit it was
   * taken from. A box that finds its ref here installs Hermes from the bucket
   * instead of cloning github.com; a box that does not falls back to the direct
   * clone, so a fleet whose manifest carries no mirror keeps working.
   *
   * **Keyed by ref, not one entry**, because `hermetic upgrade --hermes` is
   * per-agent and runs one agent at a time (§6.5): a half-upgraded fleet
   * legitimately has agents on two different refs, and both of them have to be
   * readable at once.
   *
   * `upstream_sha` is recorded because the commit in the bundle is *not*
   * upstream's. The bundle is synthesized as a single root commit over the
   * checked-out tree (a bundle made from a shallow clone claims a history it
   * does not have, which breaks every traversal on the box), so the only place
   * the real provenance survives is here and in the box's ref marker.
   *
   * Absent on every manifest written before this field. `schema_version` stays
   * `1` because the addition is purely additive and an older hermeticd ignores
   * what it does not know — the same reasoning the `foundation` block above
   * carries.
   */
  hermes: z
    .record(
      z.string(),
      z.object({
        /** `hermes/<ref>.bundle` — see `hermesBundleKey`. */
        key: z.string().min(1),
        sha256: Sha256Hex,
        size: z.number().int().nonnegative(),
        /** The real upstream commit the mirrored tree came from. */
        upstream_sha: z.string().min(1),
      }),
    )
    .optional(),
  /**
   * The mirrored browser: for each pinned Chrome for Testing build, the zip in
   * this fleet's bucket and the CDN object it was taken from. A `browser: true`
   * agent's bootstrap unzips the build its configuration names into
   * `/opt/hermetic/chrome/<chrome_ref>/` and verifies it against `sha256` and
   * `size` before anything executes — an unverified 150 MB zip is not something
   * a box should be asked to run (§7.3).
   *
   * **Keyed by `chrome_ref`, not one entry**, for the reason `hermes` above is:
   * a configuration uploaded by an older laptop pins the build that laptop
   * shipped, and it stays the document governing that box until something
   * re-renders it — so two builds can legitimately be in use at once, and both
   * have to be readable.
   *
   * Unlike `hermes`, there is no fallback: a box whose build is not named here
   * has no browser to run, which is why `foundation update`'s keep set holds
   * every build a live agent pins rather than only the one this checkout ships.
   *
   * Absent on every manifest written before this field, and on any fleet that
   * has never pushed since foundation v14. `schema_version` stays `1` because
   * the addition is purely additive and an older hermeticd ignores what it does
   * not know.
   */
  browser: z
    .record(
      z.string(),
      z.object({
        /** `browser/chrome-linux-arm64-<chrome_ref>.zip` — see `browserBuildKey`. */
        key: z.string().min(1),
        sha256: Sha256Hex,
        size: z.number().int().nonnegative(),
        /** The CDN object this was mirrored from, recorded as provenance. */
        url: z.string().url(),
      }),
    )
    .optional(),
  updated_at: Iso,
  updated_by: z.string(),
});
export type FleetManifest = z.infer<typeof FleetManifest>;

/** One mirrored Hermes ref, as the manifest records it. */
export type FleetManifestHermes = NonNullable<FleetManifest["hermes"]>;
export type HermesBundleEntry = FleetManifestHermes[string];

/** One mirrored Chrome for Testing build, as the manifest records it. */
export type FleetManifestBrowser = NonNullable<FleetManifest["browser"]>;
export type BrowserBuildEntry = FleetManifestBrowser[string];

/**
 * The generation manifest, written last into `artifacts/<version>/<generation>/`.
 *
 * It exists so completeness is a *fact in the bucket* rather than an inference
 * from the ordering of two uploads. `describeRelease` — the path that points a
 * fleet at a release some other laptop pushed — used to reason "a `hermeticd`
 * is present, so the stages beside it are the whole release", which stopped
 * being true the moment a same-version republish could overwrite one and not
 * the other. Now a generation with no `release.json` is simply not a release.
 */
export const ReleaseManifest = z.object({
  schema_version: z.literal(1),
  version: Version,
  generation: z.string().regex(RELEASE_GENERATION_RE),
  /** Release-relative name → the exact object recorded for it. */
  files: z.record(z.string(), FleetManifestFile),
  build: z.string().min(1).optional(),
  build_number: z.number().int().positive().optional(),
  commit: z.string().min(1).optional(),
  capabilities: z.array(z.string().min(1)).optional(),
  created_at: Iso,
});
export type ReleaseManifest = z.infer<typeof ReleaseManifest>;

/**
 * Where the Hermes source mirror lives: `hermes/<ref>.bundle` at the bucket
 * root, deliberately **outside** `artifacts/`.
 *
 * The §6.6 release prune deletes every `artifacts/<version>/` prefix outside its
 * keep set, and a live agent can be pinned to a `hermes_ref` far older than any
 * kept hermeticd release — filing bundles under a release would let a hermeticd
 * upgrade delete the source a running agent reinstalls from. Different lifetime,
 * different prefix.
 */
export const HERMES_BUNDLE_PREFIX = "hermes/";

/**
 * A git ref hermetic will mirror: a tag or branch name with no path separator,
 * no `..`, no whitespace and no leading dash. It becomes an object key and a
 * command-line argument, and neither is a place to discover that a ref was
 * something else.
 */
export const HERMES_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/** `true` when `ref` is safe to put in a key and pass to git. */
export function isHermesRef(ref: string): boolean {
  return HERMES_REF_RE.test(ref) && !ref.includes("..");
}

/** The one place the bundle key scheme is written down. */
export function hermesBundleKey(ref: string): string {
  return `${HERMES_BUNDLE_PREFIX}${ref}.bundle`;
}

/** The ref a `hermes/<ref>.bundle` key names, or `null` for any other key. */
export function hermesRefFromKey(key: string): string | null {
  if (!key.startsWith(HERMES_BUNDLE_PREFIX) || !key.endsWith(".bundle")) return null;
  const ref = key.slice(HERMES_BUNDLE_PREFIX.length, -".bundle".length);
  return isHermesRef(ref) ? ref : null;
}
