import type {
  Agent,
  AgentEvent,
  AgentTombstone,
  DirectoryEntry,
  DirectoryStatus,
  FleetId,
  FleetItem,
  FleetSettings,
  HermesLogFile,
  NatHealth,
  RpcHealth,
} from "../schema/index.ts";
import type { BedrockApi } from "../aws/bedrock.ts";
import type { ResourceOwner } from "../agents/ownership.ts";

/**
 * Every cloud side-effect core can perform, behind one interface, so the same
 * lifecycle code runs against AWS (`AwsBackend`, phase 2) or against memory
 * (`MemoryBackend`, fixtures and tests). Nothing in `hermetic.ts` imports an AWS
 * SDK client directly; if a lifecycle step needs a new AWS call, it gets a method
 * here first.
 *
 * Method groups mirror the stores of §4.1 plus the two things that are neither a
 * store nor CloudFormation: Tailscale, and the hermeticd RPC.
 */

export interface CallerIdentity {
  account_id: string;
  arn: string;
  user_id: string;
}

export interface IdentityApi {
  /** `sts get-caller-identity`. Supplies the actor ARN stamped on every event (§4.4). */
  callerIdentity(): Promise<CallerIdentity>;
  /** `iam list-account-aliases`, best effort (§4.7 step 2). */
  accountAlias(): Promise<string | null>;
  /** `organizations describe-organization`, best effort; null on member accounts. */
  orgId(): Promise<string | null>;
}

/** A patch applied by a conditional update. `version` is managed by the store. */
export type AgentPatch = Partial<Omit<Agent, "name" | "version">>;

export interface AgentStore {
  get(name: string): Promise<Agent | null>;
  /** Conditional `PutItem` (§6.2 step 1). Returns false when the name already exists. */
  putIfAbsent(agent: Agent): Promise<boolean>;
  /**
   * `ConditionExpression: version = :expected` (§4.4). Throws `CONFLICT` when the
   * stored version has moved, `NOT_FOUND` when the row is gone. Returns the new row.
   */
  update(name: string, expectedVersion: number, patch: AgentPatch): Promise<Agent>;
  /** Full `Scan` — the read path of §4.5, no local mirror. */
  scan(): Promise<Agent[]>;
  /**
   * Remove the row. Two callers: the unwind of a failed `create`, which
   * deletes unconditionally because the row is its own half-written claim,
   * and the release at the end of `destroy` (§6.7), which passes
   * `expectedVersion` and `expectedCreatedAt` so the `DeleteItem` is
   * conditional on the row being the one it just read — a concurrent writer
   * that moved it makes this throw `CONFLICT` rather than delete somebody
   * else's account of the agent. The version alone is not enough: a later
   * incarnation of the same name can reach the same version, and `created_at`
   * (written once, at birth) is what tells the two apart. A row already gone
   * is not an error either way. Events are never deleted.
   */
  delete(name: string, opts?: { expectedVersion: number; expectedCreatedAt: string }): Promise<void>;
  /**
   * Names the most recent `scan` could not parse, when the store tracks them.
   * `scan` skips a half-written or foreign row rather than failing the whole
   * fleet read; `doctor` reports what was skipped so it stays visible (§9).
   */
  unparseable?(): string[];
}

export interface EventStore {
  append(event: AgentEvent): Promise<void>;
  /** Newest first. Events are never deleted (§6.6). */
  query(name: string, limit?: number): Promise<AgentEvent[]>;
  /**
   * The audit record a destroy leaves behind once the agent row is gone
   * (§6.7): one item under the reserved `_destroyed` partition of the events
   * table, range-keyed `<destroyed_at>#<name>` (`tombstoneSortKey`). Written
   * before the row is deleted, so a crash between the two leaves a tombstone
   * and a `destroying` row — which the next destroy finds and finishes — never
   * a freed name with no record. Idempotent for the same key.
   */
  appendTombstone(tombstone: AgentTombstone): Promise<void>;
  /**
   * Every tombstone, newest first — one `Query` on the reserved partition, no
   * `Scan`. `name` narrows to one agent's incarnations (a filter, still one
   * query); `limit` caps the count after filtering.
   */
  queryTombstones(opts?: { name?: string; limit?: number }): Promise<AgentTombstone[]>;
}

/**
 * The top-level attributes of `_fleet` an attribute-level write may set (§4.4).
 *
 * Four fields are deliberately not in it. `fleet_id` is the item's identity;
 * `version` is the store's to bump, never the caller's to state; `lock` has
 * two doors of its own (`lockFleet`, `renewFleetLock`, `unlockFleet`) because
 * the lock is not content and must not move the revision counter the lock
 * holder is writing against; and `settings` has `putSettings`, which is the
 * only write guarded on `settings.version`. A patch that could SET the whole
 * settings sub-document would be a second door onto it with none of that
 * guard — it would revert a concurrent `settings.set` wholesale, which is the
 * bug this type exists to make unexpressible.
 *
 * A patch names only the attributes it means to set. A key whose value is
 * `undefined` is dropped rather than written, because DynamoDB has no way to
 * `SET` an attribute to nothing — removing one would be a different expression,
 * and no caller wants it yet. A patch that names nothing at all writes nothing
 * and moves no counter: the stored row comes back as it stands.
 */
export type FleetPatch = Partial<Omit<FleetItem, "fleet_id" | "version" | "lock" | "settings">>;

/** What an attribute-level `_fleet` write is conditional on beyond the lock (§4.4). */
export interface FleetUpdateOptions {
  /** The clock the lock's expiry is compared against. */
  now: Date;
  /**
   * Our own lock owner, when we hold the lock and must not be refused by it.
   * Omit it — as `secrets.push` does — and a live lock of any owner refuses.
   */
  owner?: string;
  /**
   * Refuse unless the stored item is still on this revision. `0` also matches an
   * item written before `version` existed, which carries no such attribute.
   */
  expectVersion?: number;
}

/**
 * What a whole-item replacement believes about the row it is replacing (§4.4).
 *
 * Both counters are checked, because they move independently: `version` counts
 * every attribute-level content write, and `settings.version` is what a
 * `putSettings` bumps. A replacement that agrees with both is replacing the row
 * it read; one that disagrees with either is about to revert somebody.
 */
export interface FleetExpectation {
  /** The item's `version` when this operation read it; `0` for a row that carries none. */
  version: number;
  /** The stored `settings.version`, or `null` for a fleet that has no settings record yet. */
  settingsVersion: number | null;
}

export interface FleetStore {
  get(): Promise<FleetItem | null>;
  /**
   * Create the `_fleet` item. `init --create` is the only caller, and the write
   * is conditional on there being no such row: this is not a door onto an
   * existing fleet's item, and one that could overwrite it would undo every
   * guard the other methods here impose. A row that already exists throws
   * `CONFLICT` naming the fleet. The item is stored with `version` present.
   */
  put(item: FleetItem): Promise<void>;
  /**
   * Set the named top-level attributes of `_fleet` and nothing else, bumping the
   * item's `version` as it goes, and answer with the stored item as it now
   * stands — or `null` when a condition refused the write.
   *
   * This is the door for every fleet-wide *metadata* write, and it is
   * attribute-level for the reason `putSettings` is: a whole-item `Put` carries
   * whatever `settings`, `bedrock_model_ids` or `tailnet` the caller read
   * earlier, so any write that landed in between is silently reverted. A patch
   * cannot revert an attribute it does not name.
   *
   * The same four-way lock condition `lockFleet` uses guards it — absent, null,
   * expired, or `owner`'s — because a fleet-wide operation takes the lock
   * precisely so that the item stops changing underneath it.
   */
  updateFleet(patch: FleetPatch, opts: FleetUpdateOptions): Promise<FleetItem | null>;
  /**
   * Replace the whole `_fleet` item, conditional on the lock being available
   * *and* on the row still being the one the caller read (§4.4, §6.6).
   *
   * Only the two operations that genuinely rewrite most of the item use it:
   * `foundation.update`'s stamp and `apply` kind `network`'s. Both accumulate
   * changes across phases — a migration may seed `settings`, the Bedrock grant
   * is recorded, the network mode is reconciled — so the item they hold at the
   * commit point is not expressible as a short patch. The expectation is what
   * makes that safe: anything that moved since they read the row refuses the
   * write instead of being overwritten, and the caller turns that into
   * `CONFLICT`.
   *
   * Answers the item as written, or `null` when a condition refused it.
   */
  replaceFleet(
    item: FleetItem,
    owner: string,
    now: Date,
    expect: FleetExpectation,
  ): Promise<FleetItem | null>;
  /**
   * Take the fleet-wide lock (§4.4, §6.6) by writing the `lock` attribute and
   * nothing else, if the stored `lock` is absent, null, expired, or already
   * `owner`'s. `false` when somebody else's lock is live.
   *
   * A plain `get` then `put` cannot do this job: the check and the write would
   * be two calls with a window between them, and this is precisely the write
   * that decides whether two `foundation update`s run at once over one stack.
   * The condition is evaluated by the store against what is actually stored,
   * not against the caller's copy of it — and writing one attribute means a
   * lock take can never revert a `settings.set` that landed in the gap.
   *
   * It leaves `version` alone on purpose. An operation holding the lock across
   * long phases renews it from inside them, and a renew that bumped the
   * revision counter would invalidate the very expectation its final write is
   * made against.
   *
   * `expires` is passed rather than derived so the TTL stays the caller's
   * decision: the profile writes hold it for thirty seconds, not ten minutes.
   */
  lockFleet(owner: string, expires: string, now: Date): Promise<boolean>;
  /**
   * Push our own lock's expiry out, conditional on the stored lock being
   * `owner`'s *and* still live. `false` when it is neither.
   *
   * Separate from `lockFleet` because the two answer different questions.
   * Taking a lock may legitimately succeed on one that is absent, null or
   * expired; renewing one must not, or a run whose TTL lapsed inside a long
   * phase silently re-acquires and carries on as though the window in which
   * anybody could have taken the fleet had never happened. The caller turns
   * `false` into the lost-lock refusal its operation is unwound by.
   *
   * Like `lockFleet`, it writes the `lock` attribute alone and leaves `version`
   * where it is, so renewing across four phases does not invalidate the
   * expectation the commit point is written against.
   */
  renewFleetLock(owner: string, expires: string, now: Date): Promise<boolean>;
  /**
   * Give the lock back, conditional on still holding it. A release that lost
   * the race has nothing to release — somebody else's lock is theirs to drop —
   * so it is a no-op and never an error.
   */
  unlockFleet(owner: string): Promise<void>;
  /**
   * Write `_fleet.settings` (and the `_fleet.defaults` mirror) alone, on two
   * conditions the store evaluates against what is stored (§4.6):
   *
   * 1. `settings.version = expectedVersion` — `null` meaning "there are no
   *    settings yet", so a second writer that got there first is refused rather
   *    than overwritten. `false` is `CONFLICT`, the same posture an agent row's
   *    `version` check has (§4.4).
   * 2. no *live* fleet lock. A `foundation update` replaces the whole item at
   *    its commit point, and that replacement states the `settings.version` it
   *    was composed against — so a settings write landing mid-update would not
   *    be lost, but it would refuse the stamp and cost the update its commit
   *    point. Refusing it here is the cheaper end of the same rule; the caller
   *    turns `false` into `LOCKED` or `CONFLICT` after re-reading.
   *
   * `owner` is the re-entry case, and it is only given by a caller that holds
   * the lock itself: §8.3's profile writes take the fleet lock across their
   * settings write *and* the SSM write that follows it, so their own lock must
   * not be the thing that refuses them. Omit it — as `settings.set` and the
   * shared-secret writes do — and a live lock of any owner refuses the write.
   *
   * Passing an owner is not a way around the condition: a lock that expired
   * mid-operation and was taken by somebody else is a *different* owner, so the
   * write is still refused, which is what makes a lock lost under a profile
   * rotation surface as a failure rather than as a silent overwrite.
   */
  putSettings(
    settings: FleetSettings,
    expectedVersion: number | null,
    now: Date,
    owner?: string,
  ): Promise<boolean>;
}

/**
 * A TTL reservation on one volume id (§9.1). The same shape the `_fleet` lock
 * has — an owner and an expiry — because it is the same idea at a different
 * scope: something is mid-operation on this disk, and the operation is not
 * atomic in the underlying APIs.
 */
export interface VolumeClaim {
  volume_id: string;
  /** Who holds it, worded for a refusal: `agent create bravo`, `volume delete …`. */
  owner: string;
  /** ISO 8601. A claim whose expiry has passed holds nothing. */
  expires: string;
}

/**
 * The reservation store of §9.1: adoption (`agent create --volume`) and
 * deletion (`volume delete`) each take a claim on the volume id before they
 * touch the disk, so the window between "nothing else owns this" and "the row
 * says it is mine" is not a window two operators can both walk through.
 *
 * It is a store rather than a lock on the agent row because the thing being
 * reserved has no row yet — that is the whole point — and it is keyed by
 * volume id because two creates racing for one disk carry two different agent
 * names. The condition is evaluated by the store against what is stored, never
 * against the caller's copy of it, for the same reason the `_fleet` writes are
 * (§4.4): a read followed by a write is two calls with a race between them.
 *
 * `claim` is re-entrant for the same owner, which is what makes a resumed
 * create work: the re-run is the same operation, and the second claim only
 * pushes the expiry out.
 */
export interface VolumeClaimStore {
  /** The reservation on this id, live or expired; `null` when there is none. */
  get(volumeId: string): Promise<VolumeClaim | null>;
  /** Every reservation the fleet holds, expired ones included. */
  list(): Promise<VolumeClaim[]>;
  /**
   * Take it, conditional on the stored claim being absent, expired, or already
   * `owner`'s. Answers whether the write landed and who holds it either way, so
   * a refusal can name the holder without a second read.
   */
  claim(
    volumeId: string,
    owner: string,
    expires: string,
    now: Date,
  ): Promise<{ ok: boolean; holder: VolumeClaim }>;
  /**
   * Give it back, conditional on it still being ours. A release that lost the
   * race has nothing to release, so it is a no-op and never an error — the same
   * posture `unlockFleet` has.
   */
  release(volumeId: string, owner: string): Promise<void>;
}

export interface StoreApi {
  agents: AgentStore;
  events: EventStore;
  fleet: FleetStore;
  /** §9.1's volume reservations. Reserved rows of the agents table, never agents. */
  volumeClaims: VolumeClaimStore;
}

/** SSM Parameter Store: hermetic owns slot existence, never the value (§8.2). */
export interface SecretsApi {
  /** Create the parameter with a placeholder value if it does not exist. Idempotent. */
  ensureSlot(path: string): Promise<void>;
  put(path: string, value: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** True when the slot still holds hermetic's placeholder — `secrets verify` (§8.2). */
  isPlaceholder(path: string): Promise<boolean>;
  /**
   * The decrypted value of one slot, for the two callers that must *move* a
   * value rather than merely own its slot: copying a fleet-level shared key
   * into an agent's own slot (§8.3), and the digest comparison behind
   * `secrets verify`'s stale-copy report. `NOT_FOUND` when the slot is absent —
   * never `null`, because "there is no key there" is a fact a caller must
   * handle rather than a value it can pass on.
   *
   * Nothing that calls it may log, echo, or return what it gets back.
   */
  get(path: string): Promise<string>;
  /** One exact slot, not a prefix: `secrets rm <slug>` deletes a single parameter. */
  delete(path: string): Promise<void>;
  deleteByPrefix(prefix: string): Promise<string[]>;
  list(prefix: string): Promise<string[]>;
}

/** S3: the release (binary + stages), the fleet manifest, config tarballs (§4.1). */
export interface ArtifactsApi {
  putObject(key: string, body: Uint8Array, contentType?: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  deleteByPrefix(prefix: string): Promise<string[]>;
  /** Every key under a prefix. `describeRelease` enumerates `artifacts/<version>/`. */
  list(prefix: string): Promise<string[]>;
  /**
   * Read a small text object back: the *fleet manifest* (§1), which is the one
   * place `create` finds the digest cloud-init verifies its single presigned
   * fetch against — core never holds the binary at create time.
   */
  getText(key: string): Promise<string | null>;
  /**
   * Read an object's bytes. `upgrade --hermeticd V` recomputes the digests of a
   * release another laptop pushed, and a digest not computed from the object it
   * names would be worse than none: every box verifies against it.
   */
  getObject(key: string): Promise<Uint8Array | null>;
  /**
   * Delete every object *version* and delete marker in the bucket. The bucket is
   * versioned (§5), so `DeleteStack` fails with `BucketNotEmpty` unless teardown
   * empties it first — including the versions a plain delete leaves behind.
   * Returns how many versions were removed.
   *
   * `onPage` is awaited once per listing page, and exists for one caller:
   * teardown holds the fleet lock across this sweep and a bucket with enough
   * versions in it to page for more than ten minutes would otherwise unlock
   * itself in the middle (§4.4). A callback that throws stops the sweep, which
   * is the point — a heartbeat that failed means the lock is gone.
   */
  emptyBucket(onPage?: () => Promise<void>): Promise<number>;
  /**
   * Every *version* and delete marker under a prefix, gone — as opposed to
   * `deleteByPrefix`, which writes a delete marker over each current object and
   * frees nothing in a versioned bucket (§5). The two prunes that exist to
   * reclaim space use this: the recovery archive keeps one previous version and
   * the release prune keeps two, and both would otherwise grow forever.
   * Returns how many versions were removed.
   */
  purgeByPrefix(prefix: string): Promise<number>;
  /**
   * Server-side copy, one object to another key. The recovery archive of §6.6
   * copies the fleet manifest and every config tarball into
   * `archive/foundation-v<old>/` before an update touches anything, and pulling
   * megabytes through the laptop to put them back would be the same bytes and a
   * worse failure mode.
   */
  copy(fromKey: string, toKey: string): Promise<void>;
  /**
   * Presigned GET for the one fetch cloud-init makes before `hermeticd` exists
   * (§6.2 step 7). The window is the implementation's — `PRESIGN_TTL_SECONDS`
   * in `aws/s3.ts`, one hour — so no caller keeps a second copy of it.
   */
  presign(key: string, expiresInSeconds?: number): Promise<string>;
}

export interface VolumeRef {
  volume_id: string;
  size_gib: number;
  state: string;
}

/**
 * A volume hermetic owns, as `teardown` sees it: found by the managed tag alone,
 * because the agent row that used to name it may already be gone. `agent` is the
 * `agent=<name>` tag value, or null when the volume carries none.
 */
export interface ManagedVolumeRef {
  volume_id: string;
  size_gib: number;
  agent: string | null;
  /** The `hermetic:former_agent=<name>` tag a destroy leaves on a kept volume (§6.7), or null. */
  former_agent: string | null;
  state: string;
  /**
   * EC2's `CreateTime`, ISO-8601, or null when the answer carries none. The
   * release's sweep (§6.7) reads it to leave alone a disk created after its
   * own run began: that one can only be a later incarnation's.
   */
  created_at: string | null;
}

/** `ComputeApi.retagVolume`'s options; see there. */
export interface RetagVolumeOptions {
  roleData?: boolean;
  name?: string | null;
  formerAgent?: string | null;
  expectedAgent?: string;
}

/** One EBS snapshot, as the DLM policy of §7.1 produces them. */
export interface SnapshotRef {
  snapshot_id: string;
  volume_id: string;
  size_gib: number;
  started_at: string;
}

/**
 * One Elastic IP allocation, as `listAddresses` reports it (§4.6).
 *
 * An EIP is the one thing a `nat` fleet's stack owns that can outlive it: the
 * allocation is only deleted when its association releases cleanly, and an
 * association that did not costs `EIP_MONTHLY_COST` a month for ever afterwards while
 * appearing in no list hermetic used to print. `association_id` and
 * `instance_id` are what say whether it is still attached to something —
 * `ReleaseAddress` fails on an associated address, and disassociating it is not
 * teardown's call to make.
 */
export interface AddressRef {
  allocation_id: string;
  public_ip: string;
  association_id: string | null;
  instance_id: string | null;
  tags: Record<string, string>;
}

/** A single tag to select resources by, e.g. `hermetic:role=data`. */
export interface TagSelector {
  key: string;
  value: string;
}

export interface InstanceRef {
  instance_id: string;
  state: string;
  public_ip: string | null;
  /**
   * The subnet the instance is actually in (§5). Optional because most callers
   * neither set nor read it — a launch, a stop and a terminate all care about
   * the id and the state — and `network.status` is the one reader: an agent
   * sitting in a subnet the stack no longer launches into is the drift a mode
   * switch leaves behind, and there is nowhere else to see it. Absent means
   * "not asked"; `null` means EC2 reported none.
   */
  subnet_id?: string | null;
}

/**
 * One elastic network interface, as `listNetworkInterfaces` reports it (§5).
 *
 * `description` is EC2's own, and it is the only thing that distinguishes an
 * interface nothing else can identify — "ELB app/…", "VPC Endpoint Interface
 * vpce-…", or an empty string for a plain instance ENI. Carried so the refusal
 * can quote it rather than making an operator go and look the id up.
 */
export interface NetworkInterfaceRef {
  id: string;
  subnet_id: string;
  /** The instance this is attached to, or null when it is attached to something else. */
  instance_id: string | null;
  description: string | null;
}

/**
 * `DescribeInstanceStatus` for one instance: EC2's own opinion of whether the
 * hypervisor and the guest are healthy, which `DescribeInstances` does not
 * carry. `agents.probe` reads it to tell "the box is running but wedged" from
 * "the box is running and hermeticd is the problem" (§9).
 *
 * The two summaries are EC2's vocabulary verbatim — `ok`, `impaired`,
 * `insufficient-data`, `not-applicable`, `initializing` — and `null` when EC2
 * returns no summary at all, which is what a `stopped` instance looks like even
 * with `IncludeAllInstances`.
 */
export interface InstanceStatusChecks {
  instance_id: string;
  state: string;
  system_status: string | null;
  instance_status: string | null;
}

/** One EBS attachment as `DescribeVolumes` reports it. */
export interface VolumeAttachment {
  instance_id: string;
  /** `attaching` | `attached` | `detaching` | `detached`. */
  state: string;
}

/**
 * A volume looked up by id, with its attachments — what the attach waiter needs
 * to decide between "not ready yet" and "someone else's disk" (`attach.ts`).
 */
export interface VolumeStatus extends VolumeRef {
  attachments: VolumeAttachment[];
}

/** `describeOwnedVolume`'s answer: the status, plus the `hermetic:former_agent` tag or null. */
export interface OwnedVolumeStatus extends VolumeStatus {
  former_agent: string | null;
}

/**
 * A volume with everything the §9 volume surface needs to place it: its tags,
 * its AZ, its age and its attachments. `VolumeStatus` deliberately stays the
 * narrow shape the attach waiter reads — it is on the create path and wants no
 * more than "is this disk free" — while this is the inventory shape, answered
 * by one `DescribeVolumes` either way.
 */
export interface VolumeDetail extends VolumeStatus {
  availability_zone: string | null;
  created_at: string | null;
  /** The `agent=<name>` tag, or null when the volume carries none. */
  agent: string | null;
  /**
   * The `hermetic:former_agent=<name>` tag, or null. A destroy that keeps the
   * volume moves the name here from `agent` (§6.7): the volume is nobody's
   * now, adoptable only by an explicit `--volume`, and this says whose it was.
   */
  former_agent: string | null;
  /** Carries `hermetic:managed=true`: hermetic made this one. */
  managed: boolean;
  /** Carries `hermetic:role=data`: the label that settles an ambiguous pair. */
  role_data: boolean;
  /** Every tag on the volume, for `volume status`. */
  tags: Record<string, string>;
}

export interface RunInstanceSpec {
  name: string;
  instance_type: string;
  ami_id: string;
  user_data: string;
  tags: Record<string, string>;
  /**
   * The fleet's network mode, when the fleet records one. It decides whether
   * the box gets a public IP explicitly rather than inheriting the subnet's
   * `MapPublicIpOnLaunch`. Absent on fleets written before the field existed,
   * and the launch then keeps its historical shape — see `runInstance` in
   * `aws/ec2.ts`.
   */
  network?: "public" | "nat";
  /**
   * The root disk to launch with, in GiB (§7.1). Absent leaves the AMI's own
   * size, which is what every agent created before the field existed has and
   * what a resumed create of one of those must keep giving it.
   */
  root_gib?: number;
}

/** EC2. Every finder exists so create/destroy can check reality before acting (§4.5). */
export interface ComputeApi {
  findVolumeByTag(name: string): Promise<VolumeRef | null>;
  /**
   * `nameTag` is the human-facing `Name` tag the console shows —
   * `<fleet id>-<agent>-data` since v4, and the caller's to compute because only
   * it knows the fleet's name. Absent leaves the volume unlabelled rather than
   * guessing a prefix.
   */
  createVolume(name: string, sizeGib: number, nameTag?: string): Promise<VolumeRef>;
  deleteVolume(volumeId: string): Promise<void>;
  /**
   * The tag lookup: *every* live (`pending`/`running`/`stopping`/`stopped`)
   * managed instance tagged `agent=<name>`. There should be one, but nothing in
   * AWS enforces that — two recreates racing, or a launch whose id was never
   * persisted followed by another, leave two boxes for one agent, both billed
   * and both on the tailnet. The callers that must see all of them (recreate's
   * stray sweep, `doctor`'s `instance_duplicate`) use this, and so do the
   * callers that want just one — there is deliberately no first-match
   * convenience beside it, because a lookup that silently drops the second
   * box is the trap this method exists to close.
   *
   * `shuttingDown: true` adds instances already `shutting-down`. Only
   * `destroy`'s stray sweep asks for them: a box on its way out still runs its
   * hermeticd, which heartbeats into the agent row, so the release must wait
   * for it to be `terminated` too. Every other caller wants the boxes that can
   * still be adopted, attached or started, and a dying one is none of those.
   */
  listInstancesByTag(name: string, opts?: { shuttingDown?: boolean }): Promise<InstanceRef[]>;
  /**
   * Launch only. The data volume is attached separately (`attachVolume`) so
   * create can write the instance id onto the agent row between the two AWS
   * calls — attach can fail after RunInstances has already spent the money.
   */
  runInstance(spec: RunInstanceSpec): Promise<InstanceRef>;
  /**
   * One instance by id, or null when it no longer exists. Unlike
   * `listInstancesByTag` this reports terminated instances too — the attach
   * waiter has to tell "still booting" from "died before we got there" (§4.5).
   */
  describeInstance(instanceId: string): Promise<InstanceRef | null>;
  /**
   * The same lookup, but it proves the instance is the named agent's before it
   * answers: the ref when the instance exists and carries `hermetic:managed=true`,
   * `agent=<name>` and `hermetic:fleet_id=<id>`; `null` when EC2 no longer has
   * it; `RESOURCE_NOT_OWNED` when it exists and the tags name somebody else.
   *
   * Every by-id terminate goes through this, because the id comes off the agent
   * row and the agent row is writable by the box it describes (§6.7,
   * `ownership.ts`). `describeInstance` above stays for the callers asking about
   * a resource they just created or already matched by tag.
   */
  describeOwnedInstance(instanceId: string, owner: ResourceOwner): Promise<InstanceRef | null>;
  /**
   * Every elastic network interface currently attached to — or simply sitting
   * in — the named subnets (§5).
   *
   * The question `apply` kind `network` has to answer before it moves a fleet
   * back to `public`: CloudFormation cannot delete a subnet that holds an ENI,
   * and the agents table is not a complete list of what does. A create that
   * launched a box and then failed before persisting its id, an instance an
   * operator started by hand, a row that is mid-create and has no `instance_id`
   * yet — each leaves an interface EC2 can see and hermetic's own rows cannot.
   * Asking EC2 is the only reading that matches what the change set will hit.
   *
   * `instance_id` is null for an interface attached to something that is not an
   * instance (a VPC endpoint, a load balancer) or to nothing at all, which is
   * why the refusal names the interface when it cannot name an agent.
   */
  listNetworkInterfaces(subnetIds: readonly string[]): Promise<NetworkInterfaceRef[]>;
  /**
   * The same instance's two EC2 status checks, or null when EC2 knows nothing
   * about the id. Separate from `describeInstance` because it is a separate
   * API call with a separate failure mode, and only `agents.probe` wants it:
   * every other caller cares where the instance is in its lifecycle, not
   * whether the hypervisor is unhappy about it.
   */
  describeInstanceStatus(instanceId: string): Promise<InstanceStatusChecks | null>;
  /**
   * The instance's serial console, or null when EC2 has nothing buffered for it
   * yet (a box less than a few minutes old, or one that never booted far enough
   * to print). This is the *only* view of a boot that fails before it can reach
   * DynamoDB or the tailnet, and it needs no cooperation from the box, so it is
   * what `logs --console` reads (§6.3).
   */
  consoleOutput(instanceId: string): Promise<ConsoleOutput | null>;
  /**
   * One volume by id, with its attachments, or null when it no longer exists.
   * The attach waiter reads this before and after attaching.
   */
  describeVolume(volumeId: string): Promise<VolumeStatus | null>;
  /**
   * `describeVolume` with the ownership proof of `describeOwnedInstance`, plus
   * one more tag: a volume tagged `hermetic:role` as anything but `data` is the
   * instance's root disk and is refused too. A volume carrying no role tag at
   * all predates the tag and is still the agent's data disk, exactly as
   * `findVolumeByTag` treats it.
   *
   * The answer carries the volume's `hermetic:former_agent` tag, and so does a
   * refusal's `details.found`: a destroy that keeps the volume writes that tag
   * *before* it removes `agent` (`retagVolume`), so a volume carrying
   * `former_agent=<name>` is one a release of `<name>` already promised to
   * keep — whether or not it got as far as removing the `agent` tag (§6.7,
   * `release-name.ts`). An adoption interrupted between its two calls leaves
   * the same pair, which the adopt path's resume finishes (`create-agent.ts`).
   */
  describeOwnedVolume(volumeId: string, owner: ResourceOwner): Promise<OwnedVolumeStatus | null>;
  /**
   * The raw `AttachVolume`. Deliberately dumb: it does not wait, does not
   * retry, and does not decide whether attaching is a good idea — `attachAgentVolume`
   * (`attach.ts`) owns that policy so both backends behave identically.
   */
  attachVolume(instanceId: string, volumeId: string): Promise<void>;
  terminate(instanceId: string): Promise<void>;
  stop(instanceId: string): Promise<void>;
  start(instanceId: string): Promise<InstanceRef>;
  /**
   * An OS-level reboot of a running instance (§6.5 `agent reboot`). Unlike
   * `stop` + `start` the instance keeps its id, its root disk and its attached
   * data volume, and never leaves the `running` state — so there is no state to
   * wait for and nothing to re-attach afterwards.
   */
  reboot(instanceId: string): Promise<void>;
  /**
   * The sealing invariant: the agent security group must have zero inbound rules.
   * `doctor` reports drift and `create` refuses to run (§5, §11.3).
   */
  describeSecurityGroupInbound(): Promise<
    Array<{ protocol: string; from: number; to: number; cidr: string }>
  >;
  /**
   * The fleet's pinned stock Ubuntu ARM image, from Canonical's public SSM
   * parameter. Resolved at `init` and on `upgrade`, never per create (§6.2 step 7).
   */
  resolveUbuntuAmi(): Promise<string>;
  /**
   * Every instance hermetic manages (`hermetic:managed=true`), terminated ones
   * excluded — the EC2 half of `doctor`'s three-way reconciliation (§9). `agent`
   * is the `agent=<name>` tag value, or `null` when a managed instance somehow
   * carries none.
   */
  listManagedInstances(): Promise<Array<{ instance_id: string; agent: string | null; state: string }>>;
  /**
   * Every volume tagged `hermetic:managed=true` — what `teardown --delete-volumes`
   * has to enumerate, because a volume kept by `destroy` outlives the agent row
   * that named it and nothing else can find it afterwards (§6.6).
   */
  listManagedVolumes(): Promise<ManagedVolumeRef[]>;
  /**
   * Every volume this fleet manages that carries `agent=<name>`, any role, in
   * any state but going away — the same query `findVolumeByTag` makes, with
   * none of its decisions: it never tags anything and never refuses on several
   * matches. Releasing a name (§6.7) asks it which disks still hold the name
   * besides the one the row names, and moves each off it; `findVolumeByTag`
   * would label a lone untagged match `role=data` on the way past and throw
   * `CONFLICT` on two, which is exactly the shape the release is there to
   * clean up.
   */
  listVolumesByAgentTag(name: string): Promise<ManagedVolumeRef[]>;
  /**
   * The legacy sweep of the v3 foundation migration (§6.6): every managed
   * instance and volume in the account carrying *no* `hermetic:fleet_id` tag.
   *
   * It is the one reader that deliberately looks outside its own fleet, because
   * that is the question it is asking: resources created before fleet scoping
   * are untagged, and the migration can only adopt them when the directory
   * proves this account has a single fleet. Everything else here filters on the
   * fleet tag and cannot see them at all.
   */
  listUnscopedManaged(): Promise<{ instances: string[]; volumes: string[] }>;
  /**
   * Stamp `hermetic:fleet_id=<this fleet>` on resources the v3 migration
   * adopted. Idempotent (EC2 `CreateTags` overwrites), and a no-op on an empty
   * list.
   */
  tagFleetId(resourceIds: readonly string[]): Promise<void>;
  /**
   * The inventory behind `volume ls` (§9): every volume hermetic manages, plus
   * every *unattached* volume in the region that it does not. The second half
   * is not curiosity — an unattached volume bills whether or not hermetic made
   * it, and a list that hid the ones it did not make would be a list of the
   * cheap half of the problem. They come back `managed: false` and every write
   * path refuses them.
   */
  listVolumes(): Promise<VolumeDetail[]>;
  /**
   * The availability zone the fleet's launch subnet is in. A volume can only be
   * attached to an instance in its own AZ, so `agent create --volume` compares
   * against this before it spends anything (§6.2 step 7).
   */
  launchAz(): Promise<string>;
  /**
   * Move a volume's `agent` tag to a new name, and label it `role=data` if it
   * is not already. Only `agent create --volume` calls it, and only when the
   * new agent's name differs from the tag: without the rewrite
   * `findVolumeByTag` would never find the volume again, and the agent's memory
   * would be invisible to every later resume, recreate and destroy.
   *
   * `agent: null` *removes* the tag, and `roleData: false` removes the
   * `role=data` label — together they are how `rollback.ts` puts an adopted
   * volume back exactly as it found it, including the case where it carried no
   * agent tag at all. `hermetic:managed` is never touched: an adopted volume
   * was hermetic's before this call and stays hermetic's after it.
   *
   * `name` is the `Name` tag. The forward path states it — `<fleet id>-<agent>-data`
   * since v4 (`cloudName`), which only the caller can build because only it
   * knows the fleet's id — and so does a restore, because the volume may have
   * carried an operator's own `Name` before hermetic overwrote it, and putting
   * back the ownership tags while deleting that would be a rollback that left
   * the account worse than it found it. Absent leaves the tag alone; `null`
   * removes it.
   *
   * `formerAgent` is the `hermetic:former_agent` tag (§6.7, §9.1): a destroy
   * that keeps the volume moves the name from `agent` to it, so the disk still
   * says whose memory it holds without `findVolumeByTag` ever finding it under
   * that name again — the one hold on a destroyed name that would otherwise
   * survive. A string sets it, `null` removes it, absent leaves it alone; the
   * adopt path removes it when it gives the volume a new owner.
   *
   * `expectedAgent`, with `agent: null`, makes the removal conditional: the
   * `agent` tag goes only while it still reads that value (EC2's `DeleteTags`
   * with a `Value` deletes nothing on a mismatch). A release moving a disk off
   * `<name>` passes `<name>`, so a disk another agent's adoption retagged
   * between the release's read and this write keeps its new owner's tag.
   */
  retagVolume(volumeId: string, agent: string | null, opts?: RetagVolumeOptions): Promise<void>;
  /** Snapshots carrying one tag, e.g. the DLM policy's `hermetic:role=data` (§7.1). */
  listSnapshots(tag: TagSelector): Promise<SnapshotRef[]>;
  deleteSnapshot(snapshotId: string): Promise<void>;
  /**
   * Elastic IP allocations carrying one tag — in practice this fleet's own
   * `hermetic:fleet_id` (§4.6). The `nat` foundation allocates one for the NAT
   * instance, and an allocation whose association did not release survives
   * `DeleteStack`, so this is what teardown has to ask after the stack is gone.
   */
  listAddresses(tag: TagSelector): Promise<AddressRef[]>;
  /**
   * Release one allocation. It fails on an address that is still associated,
   * and that is deliberate: freeing it would need a `DisassociateAddress`
   * against whatever is holding it, which teardown cannot do blindly (§4.6).
   */
  releaseAddress(allocationId: string): Promise<void>;
}

export interface StackInfo {
  stack_id: string;
  stack_name: string;
  /**
   * The CloudFormation `StackStatus`, verbatim — `doctor` shows it, and `init`
   * reads it to decide whether the foundation is attachable at all
   * (`isStackDeleting`, §4.7 step 4).
   */
  status: string;
  tags: Record<string, string>;
  outputs: Record<string, string>;
  /**
   * The stack's own `Parameters`, flattened to key → value; empty when the
   * stack carries none. This is the authoritative source for `Network` (§5):
   * CloudFormation owns the subnets, so the parameter it was created with is
   * what the fleet actually is, and `_fleet.network` is only the cache heads
   * read without a `DescribeStacks`. The v6 foundation migration reconciles the
   * two.
   */
  parameters: Record<string, string>;
}

/** One CloudFormation resource transition, from `DescribeStackEvents`. */
export interface StackResourceEvent {
  event_id: string;
  logical_id: string;
  resource_type: string;
  /** `CREATE_IN_PROGRESS`, `CREATE_COMPLETE`, `CREATE_FAILED`, … verbatim. */
  status: string;
  reason: string | null;
  at: string;
}

/**
 * One poll of a stack in flight. `events` are the transitions new since the
 * previous poll, oldest first, so a caller can narrate them; an empty list on
 * a poll is a heartbeat. `events_available` goes false if the caller's IAM
 * cannot read `DescribeStackEvents` — the wait degrades to heartbeats rather
 * than failing.
 */
export interface StackProgress {
  status: string;
  elapsed_ms: number;
  events: StackResourceEvent[];
  events_available: boolean;
}

/**
 * One entry of a change set's `Changes[]`, flattened. `replacement` is only
 * meaningful for a `Modify`, and CloudFormation leaves it unset otherwise — the
 * `null` is that absence, and it is *not* the same as `"False"`.
 */
export interface ChangeSetChange {
  logicalId: string;
  resourceType: string;
  /** `Add` | `Modify` | `Remove` | `Import` | `Dynamic`, verbatim. */
  action: string;
  replacement: "True" | "False" | "Conditional" | null;
}

/**
 * One `DescribeChangeSet`. `status` is the change set's own creation status
 * (`CREATE_PENDING` → `CREATE_COMPLETE`, or `FAILED`), never the stack's, and
 * `statusReason` is where CloudFormation says "the submitted information didn't
 * contain changes" — the one FAILED that means success (§6.6 step 3).
 */
export interface ChangeSetInfo {
  name: string;
  id: string;
  status: string;
  statusReason: string | null;
  changes: ChangeSetChange[];
}

/** CloudFormation — the one declarative piece (§5). */
/** One live hermetic stack in the account, as `listStacks` reports it (§4.8). */
export interface StackSummary {
  stack_name: string;
  stack_id: string;
  /** The `hermetic:fleet_id` tag; null on a stack whose tags were edited away. */
  fleet_id: string | null;
  status: string;
}

export interface FoundationApi {
  describeStack(): Promise<StackInfo | null>;
  /**
   * Every hermetic stack in the account and region that has not finished
   * deleting, whichever fleet it belongs to (§4.8). `describeStack` answers "the stack of *this* fleet" and
   * cannot answer this one: an account may hold several fleets, and `init` has
   * to be able to see all of them before it decides whether it is creating a
   * new one or attaching to one that is there.
   *
   * Summaries, not `StackInfo`: the decision needs a name, an id, a fleet id
   * and a status, and describing every stack in full to make it would be a
   * `DescribeStacks` per fleet for facts nothing reads.
   */
  listStacks(): Promise<StackSummary[]>;
  /**
   * Point this backend at one specific fleet's stack (§4.8). `init` is the only
   * caller: it is the one command that runs against a backend built before the
   * fleet was chosen, and once it has chosen — a `--name` that names one of
   * several fleets in the account — every later read (the `_fleet` item, the
   * tables, the bucket) has to be about *that* stack rather than whichever one
   * discovery happened to land on.
   *
   * Idempotent, and safe to call with the id already bound. Callers must bind
   * before the first store or artifact read, since those memoise the stack's
   * outputs.
   */
  bindFleet(fleetId: string): void;
  createStack(params: {
    fleet_id: FleetId;
    network: "public" | "nat";
    tags: Record<string, string>;
    /** Stack creation is minutes long, so it honours the caller's signal (§3.2). */
    signal?: AbortSignal;
    /** Called once per poll while the stack is being created (see `StackProgress`). */
    onProgress?: (progress: StackProgress) => void;
  }): Promise<StackInfo>;
  /**
   * Resolves only once the stack is *gone*, not once `DeleteStack` has been
   * accepted — every teardown phase after it, and any `init` that follows,
   * assumes the VPC, tables and bucket have really been removed. Minutes long,
   * so it honours the caller's signal (§3.2 rule 2).
   */
  deleteStack(opts?: { signal?: AbortSignal }): Promise<void>;
  /**
   * `CreateChangeSet` of type `UPDATE` against this build's template (§6.6 step
   * 3). The fleet id and the network keep their previous values — both were
   * decided at `init` and an update must not redecide them — so the caller
   * supplies only the release being rolled forward and, since v10, the Bedrock
   * grant.
   *
   * `bedrockModelArns` is stated because it is the one parameter an update
   * legitimately *does* redecide (§8.3): the set a fleet needs follows its
   * provider profiles and its agents, and carrying the `init`-time value
   * forward forever is what made a Bedrock profile on any other model
   * permanently unusable. Omitted keeps the previous value, which is what an
   * update that has nothing to say about the grant means.
   *
   * Returns as soon as CloudFormation accepts it; the change set is still being
   * computed, which `describeChangeSet` reports.
   */
  createChangeSet(params: {
    name: string;
    hermeticVersion: string;
    bedrockModelArns?: readonly string[];
  }): Promise<{ name: string; id: string }>;
  /**
   * The sibling that *does* redecide the network (§5). `apply` kind `network`
   * is the one operation allowed to move a fleet between `public` and `nat`,
   * and it is a separate method rather than a flag on `createChangeSet` so that
   * the guarantee above stays a guarantee: a foundation update cannot re-network
   * a fleet by passing a wrong argument, because there is no argument to pass.
   *
   * `Network` is given explicitly; `FleetId` and `BedrockModelArns` keep their
   * previous values. `fckNatAmiId` is supplied when the target is `nat` — it is
   * resolved fresh on every re-network, because an AMI frozen at `init` is one
   * the fleet keeps booting its NAT appliance from years later.
   */
  createNetworkChangeSet(params: {
    name: string;
    hermeticVersion: string;
    network: "public" | "nat";
    fckNatAmiId?: string;
  }): Promise<{ name: string; id: string }>;
  /**
   * Today's fck-nat arm64 AMI in this region. Separate from the change set that
   * consumes it so `apply` kind `network` can fail in preflight — before
   * anything is archived or changed — when the lookup does not answer (§5).
   */
  resolveFckNatAmi(): Promise<string>;
  /**
   * The NAT appliance's health, or `null` on a stack that has none — which is
   * every `public` fleet, and is a *skip* rather than a pass (§9). Reads the
   * instance's state and, crucially, whether the private subnets' default route
   * still resolves: a route pinned to a dead instance goes `blackhole` and takes
   * the whole fleet's egress with it, silently.
   */
  describeNat(): Promise<NatHealth | null>;
  /** One poll of a change set. The caller owns the waiting, and the signal (§3.2). */
  describeChangeSet(name: string): Promise<ChangeSetInfo>;
  /**
   * `ExecuteChangeSet`, then wait for the stack to finish updating — minutes
   * long, so it honours the signal and narrates through `onProgress` exactly as
   * `createStack` does. `UPDATE_ROLLBACK_COMPLETE` is a *failure* here even
   * though it is a healthy terminal state elsewhere: the update did not happen.
   */
  executeChangeSet(params: {
    name: string;
    signal?: AbortSignal;
    onProgress?: (progress: StackProgress) => void;
  }): Promise<StackInfo>;
  /** Delete a change set that will not be executed. Idempotent. */
  deleteChangeSet(name: string): Promise<void>;
}

export interface TailscaleDevice {
  /**
   * Tailscale's own handle for the device, as `DELETE /api/v2/device/{id}`
   * takes it. The API accepts either the legacy numeric `id` or the newer
   * `nodeId`, so a reader may prefer whichever it has.
   */
  id: string;
  /**
   * The MagicDNS FQDN, sans trailing dot — `pink-otter-3.tail0123.ts.net`.
   * This is the name that carries a `-2` suffix when a dead device already
   * holds the canonical one, so it is what a message names.
   */
  name: string;
  /**
   * The *OS* hostname the node joined with, which stage 00 sets to the agent's
   * name. Two devices for one agent — the corpse and its replacement — share
   * this and differ on `name`, which is why ownership is decided here.
   */
  hostname: string;
  addresses: string[];
  online: boolean;
  tags: string[];
}

/**
 * What a delete asked for and what the tailnet already thought. Outcomes rather
 * than throws because none of the three is an error to the caller: a destroy
 * that cannot reach the tailnet still destroyed the agent (§6.7).
 */
export type TailscaleDeleteOutcome = "deleted" | "forbidden" | "not_found";

/** The policy file as Tailscale hands it over: HuJSON plus the ETag it came with. */
export interface TailscalePolicy {
  /** The document verbatim — comments, key order and all (`hujson.ts`). */
  text: string;
  /** The `ETag` header. Sent straight back as `If-Match` on the write. */
  etag: string;
}

/**
 * What `POST /api/v2/tailnet/-/acl` answered. Outcomes rather than throws for
 * the three answers a caller has to *decide* about — somebody edited the policy
 * (412), the client has no write scope (403), the policy is not valid (400) —
 * and a throw for anything else, which is a Tailscale hermetic cannot talk to.
 */
export type TailscaleWriteOutcome =
  | { kind: "written"; etag: string }
  | { kind: "conflict" }
  | { kind: "forbidden" }
  | { kind: "invalid"; message: string };

export interface TailscaleApi {
  /** Tagged, single-use, one-hour, pre-authorised, `--ssh` capable (§6.2 step 3). */
  mintAuthKey(name: string): Promise<string>;
  /**
   * `GET /api/v2/tailnet/-/devices` — the tailscale half of `doctor`'s
   * three-way reconciliation (§9). Degrades to `null` rather than throwing
   * when the OAuth client lacks the `devices:core` read scope or the call
   * otherwise fails; `doctor` reports that as informational, not a finding.
   */
  listDevices(): Promise<TailscaleDevice[] | null>;
  /**
   * `DELETE /api/v2/device/{id}` — how `recreate` and `destroy` give the
   * canonical MagicDNS name back to the next node (§6.5, §6.7). `forbidden` is
   * a client without `devices:core` *write*, `not_found` a device somebody
   * already deleted; only an answer that is none of the three throws.
   */
  deleteDevice(id: string): Promise<TailscaleDeleteOutcome>;
  /**
   * `GET /api/v2/tailnet/-/acl` — the tailnet policy file, HuJSON verbatim
   * (§4.7). `null` when the OAuth client carries no `policy_file` scope at all,
   * or the call otherwise failed: hermetic manages three blocks in a document
   * that is the operator's, so "we cannot see it" is a report, not a failure.
   * Anything that is neither a policy nor a 403 throws `TAILSCALE_UNAVAILABLE`.
   */
  getPolicy(): Promise<TailscalePolicy | null>;
  /**
   * `POST /api/v2/tailnet/-/acl/validate` — Tailscale's own opinion of a
   * candidate policy, including the policy's embedded tests. Nothing is stored.
   * Called before every write, because a policy hermetic renders and Tailscale
   * rejects must not be the thing that teaches an operator their tailnet is
   * down. Also how `policy.status` tells the write scope from the read scope
   * without writing (see `NO_POLICY_WRITE_SCOPE` in `policy.ts`).
   */
  validatePolicy(text: string): Promise<{ ok: true } | { ok: false; message: string }>;
  /**
   * `POST /api/v2/tailnet/-/acl` with `If-Match: <etag>` (§4.7). The `If-Match`
   * is the whole point: hermetic writes back a document it read a moment ago,
   * and a policy edited in the admin console in between must be a refusal
   * rather than an overwrite of somebody's work.
   */
  setPolicy(text: string, etag: string): Promise<TailscaleWriteOutcome>;
}

export interface LogLine {
  unit: string;
  at: string;
  message: string;
}

/** What EC2 buffered from an instance's serial console, and when it said so. */
export interface ConsoleOutput {
  /** EC2's own timestamp for the buffer, ISO-8601. */
  at: string;
  /** The buffer verbatim, newline-separated. Never empty when this is non-null. */
  output: string;
}

/**
 * What `GET /logs` is being asked for. `follow` is the load-bearing one and the
 * reason this is an options object rather than a second positional `unit`: a
 * `logs` without `--follow` must ask the box for a *bounded* read, because a
 * followed journal never sends its terminal frame and the socket is eventually
 * closed under it — which is a socket error at the caller for a command that
 * had, in fact, printed everything there was.
 */
export interface RpcLogsOptions {
  readonly unit?: string | undefined;
  /**
   * One of Hermes's own rotating logs under `$HERMES_HOME/logs` instead of a
   * journal unit (§6.4). The journal holds Hermes's banner and uvicorn's
   * request noise; a failed turn is only in these files, so this is the source
   * that answers "what went wrong" — and it is on the data volume, so it
   * survives a recreate. Never set together with `unit`.
   */
  readonly file?: HermesLogFile | undefined;
  readonly follow?: boolean | undefined;
  /** Journal lines to replay before following; hermeticd's own default is 200. */
  readonly tail?: number | undefined;
}

/**
 * The hermeticd RPC over the Tailscale interface (§6.4). Logs only: what used
 * to be pushed at a box is now pulled by it — the runner watches its own row
 * for a `rerun` command, and the nightly update follows the fleet manifest — so
 * the operator half of the RPC is a reader, not a controller.
 */
export interface RpcApi {
  logs(name: string, opts?: RpcLogsOptions): AsyncIterable<LogLine>;
  /**
   * `GET /healthz`: hermeticd answering for itself, right now. The one reader
   * is `agents.probe` (§9) — and the point of asking is that it fails in a
   * *different* way than the heartbeat does. A box whose heartbeat is stale but
   * whose `/healthz` answers is a box whose DynamoDB writes are broken, not a
   * box that is down, and no passive signal can tell those apart.
   *
   * Bounded: unlike `logs --follow` this must come back, so the implementation
   * owns a timeout and the caller may add its own signal on top.
   */
  health(name: string, opts?: { signal?: AbortSignal }): Promise<RpcHealth>;
}

/**
 * The account-global fleet directory (`schema/directory.ts`): one table, in one
 * region, listing every fleet in the account. It is deliberately *not* part of
 * `StoreApi` — the stores live in the per-fleet foundation stack and go away
 * with it, while this one has to outlive any single fleet's teardown, which is
 * the whole reason it is provisioned by the SDK rather than by CloudFormation.
 *
 * Every method is on the account-guarded client of a possibly *different*
 * region than the fleet's, so `region` is stated rather than inferred: a head
 * reporting "the directory is in us-east-1" must not have to know how the
 * backend was built.
 */
export interface DirectoryApi {
  /** The region the directory lives in. */
  readonly region: string;
  /** Create the table if missing (PAY_PER_REQUEST, STANDARD, PITR 7 days, deletion protection) and wait until ACTIVE; idempotent. Also (re)applies PITR/deletion-protection settings to an existing table when they drift. */
  ensure(): Promise<DirectoryStatus>;
  /** Table + backup facts, plus every item. `exists: false` and empty fleets when the table is absent — never throws for "no table". */
  status(): Promise<DirectoryStatus>;
  /** Read the canonical directory row by immutable fleet id. */
  get(fleet_id: string): Promise<DirectoryEntry | null>;
  list(): Promise<DirectoryEntry[]>;
  /** Creates a fleet id row and, when present, reserves its display alias. */
  register(entry: DirectoryEntry): Promise<boolean>;
  /**
   * Overwrite an existing item, moving its display-alias reservation with it.
   * Returns `false` when the write lost its condition: the row is not there, it
   * is some other fleet's, the alias asked for belongs to somebody else, or the
   * row moved since `expect` was read.
   *
   * `expect.alias` is the alias the caller *read*, which is what the write is
   * made conditional on. Passing it moves the optimistic window from the two
   * lines inside this method out to the whole of the caller's read-modify-write
   * — which is where an operator relabelling a fleet actually spends their
   * time. Callers that only change a status (teardown, the foundation stamp)
   * omit it and keep the older last-write-wins behaviour for that field.
   */
  update(entry: DirectoryEntry, expect?: { alias: string | null }): Promise<boolean>;
  /**
   * Drop a row by fleet id, releasing the display alias it reserved. Kept for
   * recovery tooling; normal teardown marks a row `torn_down` and alias changes
   * use `update`.
   */
  remove(fleet_id: string): Promise<boolean>;
  /**
   * Foundation v9: move any pre-alias rows onto the `fleet_id` key and reserve
   * the labels they carried (§4.8). Idempotent — a table this build already
   * wrote is scanned and left alone — so `ensure()` runs it on every `init` and
   * the v9 migration runs it again on `foundation update`.
   */
  migrate(): Promise<{ fleets: number; aliases: number; duplicates: number }>;
}

export interface Clock {
  now(): Date;
}

export interface Backend {
  identity: IdentityApi;
  store: StoreApi;
  secrets: SecretsApi;
  artifacts: ArtifactsApi;
  compute: ComputeApi;
  foundation: FoundationApi;
  tailscale: TailscaleApi;
  rpc: RpcApi;
  directory: DirectoryApi;
  /**
   * §8.3's Bedrock model catalog, in the fleet's region. Optional because it is
   * the one port a backend may legitimately not have: `MemoryBackend` has no
   * AWS at all, and fixture mode answers model discovery from a canned catalog
   * instead. A backend without it makes `providers.models --provider bedrock`
   * fail rather than answer with nothing.
   */
  bedrock?: BedrockApi;
  clock: Clock;
}

/** Every mutating `Backend` method, dotted. `MemoryBackend` records calls to these. */
export const MUTATING_METHODS: readonly string[] = [
  "store.agents.putIfAbsent",
  "store.agents.update",
  "store.agents.delete",
  "store.events.append",
  "store.events.appendTombstone",
  "store.fleet.put",
  "store.fleet.updateFleet",
  "store.fleet.replaceFleet",
  "store.fleet.lockFleet",
  "store.fleet.unlockFleet",
  "store.fleet.putSettings",
  "store.volumeClaims.claim",
  "store.volumeClaims.release",
  "secrets.ensureSlot",
  "secrets.put",
  "secrets.delete",
  "secrets.deleteByPrefix",
  "artifacts.putObject",
  "artifacts.copy",
  "artifacts.purgeByPrefix",
  "artifacts.deleteByPrefix",
  "artifacts.emptyBucket",
  "compute.createVolume",
  "compute.deleteVolume",
  "compute.deleteSnapshot",
  "compute.releaseAddress",
  "compute.runInstance",
  "compute.attachVolume",
  "compute.tagFleetId",
  "compute.terminate",
  "compute.stop",
  "compute.start",
  "foundation.createStack",
  "foundation.deleteStack",
  "foundation.createChangeSet",
  "foundation.executeChangeSet",
  "foundation.deleteChangeSet",
  "tailscale.mintAuthKey",
  "tailscale.setPolicy",
  "directory.ensure",
  "directory.register",
  "directory.update",
  "directory.remove",
  "directory.migrate",
] as const;
