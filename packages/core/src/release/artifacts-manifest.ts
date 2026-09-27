/**
 * The fleet manifest — `manifest.json` at the root of the bucket — and the lock
 * that serialises writers of it (§1, §4.2). `writeFleetManifest` publishes the
 * pointer, `readFleetManifest` reads it back, `pointFleetAt` and
 * `recordHermesMirror` move one block of it under the fleet lock.
 *
 * The manifest is always the *last* write of a push: until it moves, every box
 * is still running the release it names, and a half-uploaded one is invisible.
 */
import { HermeticError } from "../errors.ts";
import { lockActivity } from "../fleet/fleet-lock.ts";
import { HERMETIC_VERSION } from "../version.ts";
import {
  FLEET_KEY,
  FLEET_MANIFEST_KEY,
  FleetManifest as FleetManifestSchema,
  isReleaseObjectKey,
  stackNameFromId,
  tablesFor,
} from "../schema/index.ts";
import type { FleetItem, FleetManifest } from "../schema/index.ts";
import { agentParamPrefix } from "../backend/constants.ts";
import type { ArtifactsApi, StackInfo } from "../backend/types.ts";
// ─── the fleet manifest ──────────────────────────────────────────────────────

export interface FleetManifestInput {
  fleet: FleetItem;
  /**
   * The foundation stack, for its outputs — the fleet's resources live there,
   * and nowhere else. `null` (a `DescribeStacks` that failed or found nothing)
   * is a refusal, not a set of defaults: see `fleetManifestFrom`.
   */
  stack: StackInfo | null;
  hermeticd: FleetManifest["hermeticd"];
  /**
   * No `hermeticVersion` here. The manifest's `hermetic_version` is the *tool*
   * build writing the file, which is `HERMETIC_VERSION` and is the same for
   * every caller — so `fleetManifestFrom` reads it directly rather than taking
   * it as an argument.
   *
   * It used to be threaded through, and every one of the five writers passed
   * `BUILD_VERSIONS.hermeticd` instead: the field documented as "the laptop
   * build that wrote this file, for support questions" could only ever hold the
   * release version, identical across every checkout that pushed it. A
   * parameter nobody could supply correctly is better deleted than documented.
   */
  updatedBy: string;
  updatedAt: string;
  /**
   * The foundation contract this manifest records (§6.6). Supplied by
   * `foundation.update`, which writes the manifest *before* it stamps `_fleet`
   * and so knows the new version before the item does — and by any other writer
   * that read a published manifest and must not rewind it (`laterFoundation`).
   * A caller that supplies none lets it be derived from `fleet` below.
   */
  foundation?: FleetManifest["foundation"];
  /**
   * The Hermes source mirror block (§3.6). Every writer of this file has to
   * pass it through: it is written by the mirror step and read by nobody here,
   * so a writer that simply rebuilt the manifest without it would delete a
   * fleet's mirror as a side effect of pushing a release. `undefined` and `{}`
   * both mean "record no mirror".
   */
  hermes?: FleetManifest["hermes"];
  /**
   * The mirrored browser block (§7.3), passed through by every writer for
   * exactly the reason `hermes` above is — and with a sharper consequence for
   * dropping it: a box whose build is not named here has no browser at all,
   * where a missing Hermes bundle only means a slower boot off GitHub.
   */
  browser?: FleetManifest["browser"];
}

/**
 * The manifest's `foundation` block as the `_fleet` item already says it (§6.6).
 * Derived rather than passed in, so a manifest always reports what the *fleet*
 * is on: an older laptop attaching to a fleet somebody else updated rewrites
 * `resources`, and must not rewrite this backwards while doing so. A fleet with
 * no stamp yields no block, which reads as version 0 — which is what it is.
 */
export function manifestFoundationOf(fleet: FleetItem): FleetManifest["foundation"] {
  if (fleet.foundation_version === undefined || fleet.foundation_template_sha256 === undefined) {
    return undefined;
  }
  return {
    version: fleet.foundation_version,
    template_sha256: fleet.foundation_template_sha256,
    applied_at: fleet.foundation_updated_at ?? fleet.created_at,
    applied_by: fleet.foundation_updated_by ?? fleet.created_by,
  };
}

/**
 * The `_fleet` reads and the two conditional writes a manifest writer needs to
 * hold the fleet-wide lock for the length of its write (§4.4, §6.6).
 *
 * Narrower than `StoreApi["fleet"]` on purpose: this is the whole of what
 * `withFleetLock` touches, so a reader can see that it neither reads an agent
 * row nor writes anything but the lock.
 */
export interface FleetLockStore {
  get(): Promise<FleetItem | null>;
  lockFleet(owner: string, expires: string, now: Date): Promise<boolean>;
  unlockFleet(owner: string): Promise<void>;
}

/**
 * Run `body` holding the fleet lock, and give it back however that ends.
 *
 * Checking `assertFleetUnlocked` and *then* writing the manifest is two calls
 * with a window between them, and the window is exactly the thing that goes
 * wrong: `foundation.update`'s `pushAndPrune` reads the live manifest to decide
 * which release directories it may delete, and a pointer moved after that read
 * names a release the prune then removes — every box's next update 404s on a
 * key that was there when the pointer was written. A read cannot close that; a
 * conditional write can, and `lockFleet` is the same primitive
 * `foundation.update` itself takes the lock with.
 *
 * The cost is that agent operations are refused with `LOCKED` for as long as
 * the body runs — a manifest write, or a release upload for `artifacts push`.
 * That is seconds, it is the honest answer (a release *is* being replaced under
 * them), and it is bounded by the same TTL everything else uses.
 *
 * The lock is taken by writing the `lock` attribute alone, so nothing here can
 * revert a settings or metadata write that landed since the caller's read.
 * `_fleet` is still re-read and handed to `body`, because a manifest is
 * composed from the row and a stale row would publish a stale manifest — and
 * the re-read happens *after* the lock is taken, which is the whole of what
 * makes it worth doing. A copy read before the door shut is a copy anything
 * could still have moved; the §4.4 rule is acquire, then read, and a read taken
 * either side of a lock take is otherwise indistinguishable in the code.
 */
export async function withFleetLock<T>(
  store: FleetLockStore,
  /** `fleet` is the caller's copy, used only if `_fleet` cannot be re-read. */
  lock: { fleet: FleetItem; owner: string; ttlMs: number; now: () => Date },
  body: (fleet: FleetItem) => Promise<T>,
): Promise<T> {
  const { owner, ttlMs, now } = lock;
  const expires = new Date(now().getTime() + ttlMs).toISOString();
  if (!(await store.lockFleet(owner, expires, now()))) {
    const latest = await store.get();
    // A lock write is conditional on the row existing, so a refusal with no row
    // behind it is a missing `_fleet` rather than a busy one, and saying
    // "locked" about it would send an operator looking for an operator.
    if (latest === null) {
      throw new HermeticError(
        "NOT_FOUND",
        `this fleet has no ${FLEET_KEY} record, so the fleet manifest cannot be written; run \`hermetic doctor\``,
        { scope: "fleet" },
      );
    }
    const holder = latest.lock ?? null;
    throw new HermeticError(
      "LOCKED",
      // What the holder is actually doing, read off the owner string, so a
      // manifest write refused by a teardown says `teardown` rather than
      // blaming a foundation update that is not running (`fleet-lock.ts`).
      `${holder === null ? "a foundation update is in progress" : lockActivity(holder.owner)} (${FLEET_KEY} locked by ${holder?.owner ?? "another operator"} until ${holder?.expires ?? "it finishes"}); the release and the fleet manifest are being rewritten`,
      { owner: holder?.owner ?? null, expires: holder?.expires ?? null, scope: "fleet" },
    );
  }
  try {
    // Read with the door shut. `lock.fleet` is the fallback for a store that
    // cannot answer, not a copy to prefer.
    return await body((await store.get()) ?? lock.fleet);
  } finally {
    // A release that loses the race has nothing to release: if our lock expired
    // and somebody else took it, theirs is not ours to drop. `unlockFleet` is
    // silent about exactly that, so the `catch` is only for a store that is
    // unreachable by the time the body ends.
    await store.unlockFleet(owner).catch(() => undefined);
  }
}

/**
 * The more recent of two foundation stamps, for a writer that has one from the
 * `_fleet` row and one from the manifest already in the bucket.
 *
 * They can legitimately disagree, and in exactly one direction: `pushAndPrune`
 * writes the *new* version into the manifest before `foundation.update` stamps
 * `_fleet` (§6.6), so for the length of the migrate phase the bucket is ahead
 * of the row. Any other manifest write landing in that window — `upgrade
 * --hermeticd`, an `artifacts push` — would otherwise publish the row's older
 * stamp over it, and every box would read a foundation version the fleet had
 * already left. A version only ever goes forward, so keeping the larger one is
 * the whole rule.
 */
export function laterFoundation(
  a: FleetManifest["foundation"],
  b: FleetManifest["foundation"],
): FleetManifest["foundation"] {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return b.version > a.version ? b : a;
}

/**
 * Build the fleet manifest from the `_fleet` row, the stack outputs and a
 * pushed release, and validate it. Separate from the write so a caller can
 * inspect what it is about to publish (and so tests can).
 */
export function fleetManifestFrom(input: FleetManifestInput): FleetManifest {
  /**
   * No stack, no manifest. `resources` is where the box reads its table names
   * and its SSM prefix, and every one of them comes from a stack output — so a
   * `DescribeStacks` that failed or came back empty must stop the write, not
   * fill the gaps with blanks that overwrite a manifest which had them right.
   */
  if (!input.stack) {
    throw new HermeticError(
      "NOT_FOUND",
      `the foundation stack for fleet ${input.fleet.fleet_id} could not be described, so the fleet manifest's resources cannot be built; nothing was written`,
      { fleet_id: input.fleet.fleet_id, stack_id: input.fleet.stack_id },
    );
  }
  const out = input.stack.outputs;
  const tables = tablesFor(stackNameFromId(input.fleet.stack_id));
  const value = {
    schema_version: 1,
    fleet_id: input.fleet.fleet_id,
    // The fleet's label, for a human reading `manifest.json`. Not what any
    // cloud name is built from — that is `fleet_id` above, since v4.
    ...(input.fleet.fleet_name === undefined ? {} : { name: input.fleet.fleet_name }),
    region: input.fleet.region,
    // The tool build, not the release. `HERMETIC_VERSION` is `0.0.0-dev` on a
    // dev run, which matches `Version` and is the honest answer for one.
    hermetic_version: HERMETIC_VERSION,
    hermeticd: input.hermeticd,
    resources: {
      bucket: out["BucketName"] ?? out["Bucket"] ?? input.fleet.bucket,
      stack_id: input.fleet.stack_id,
      agents_table: out["AgentsTable"] ?? tables.agents,
      events_table: out["EventsTable"] ?? tables.events,
      // An agent's own prefix is `${param_prefix}<name>/` (§8.2). Fleet-scoped
      // since v3, so two fleets in one account cannot share a slot.
      param_prefix: agentParamPrefix(input.fleet.fleet_id),
      vpc_id: out["VpcId"] ?? "",
      subnet_ids: (out["SubnetIds"] ?? "").split(",").filter((s) => s.length > 0),
      security_group_id: out["SecurityGroupId"] ?? out["AgentSecurityGroupId"] ?? "",
      instance_profile_arn: out["InstanceProfileArn"] ?? "",
      role_arn: out["RoleArn"] ?? "",
      // §5: the box reads its own network mode from here rather than calling
      // AWS. Omitted rather than defaulted when `_fleet` has none — a fleet
      // that predates the field is not thereby a `public` fleet.
      ...(input.fleet.network === undefined ? {} : { network: input.fleet.network }),
    },
    ...((): { foundation?: FleetManifest["foundation"] } => {
      const foundation = input.foundation ?? manifestFoundationOf(input.fleet);
      return foundation === undefined ? {} : { foundation };
    })(),
    // An empty block is no block: a fleet whose every bundle was pruned should
    // read as one that has no mirror, not as one with an empty record of it.
    ...(input.hermes && Object.keys(input.hermes).length > 0 ? { hermes: input.hermes } : {}),
    // Same rule for the browser: a fleet whose every build was pruned reads as
    // one that has no mirrored browser, not as one with an empty record of it.
    ...(input.browser && Object.keys(input.browser).length > 0 ? { browser: input.browser } : {}),
    updated_at: input.updatedAt,
    updated_by: input.updatedBy,
  };
  /**
   * The schema requires every resource field, so a stack that answered without
   * one of its outputs lands here rather than in the bucket: the message names
   * the field, which is the thing an operator can act on.
   */
  const parsed = FleetManifestSchema.safeParse(value);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))];
    throw new HermeticError(
      "INTERNAL",
      `the fleet manifest hermetic built from stack ${input.stack.stack_name} does not validate (${fields.join(", ")}); nothing was written`,
      { issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) },
    );
  }
  // A writer is the last safe place to reject a pointer outside the release it
  // claims. Readers check too, but publishing a manifest that refuses its own
  // keys would leave the whole fleet unable to read the previous good one.
  assertReleaseKeys(parsed.data.hermeticd);
  return parsed.data;
}

/**
 * Publish the pointer. Always the last write of a push (§1): until it lands,
 * every box is still fetching the release the previous one named.
 */
export async function writeFleetManifest(
  artifacts: Pick<ArtifactsApi, "putObject">,
  input: FleetManifestInput,
): Promise<FleetManifest> {
  const manifest = fleetManifestFrom(input);
  await artifacts.putObject(
    FLEET_MANIFEST_KEY,
    new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
    "application/json",
  );
  return manifest;
}

/**
 * Point the fleet at a release that is already in the bucket, holding the fleet
 * lock while doing it — `upgrade --hermeticd`'s whole job (§6.5).
 *
 * Here rather than in `hermetic.ts` because every part of it is this module's
 * subject: which object is the pointer, what a pointer move has to preserve,
 * and the lock that keeps a `foundation.update`'s prune from deleting the
 * release the pointer now names. The SDK is left with the sentence that says
 * what happened.
 */
export async function pointFleetAt(
  artifacts: Pick<ArtifactsApi, "putObject" | "getText">,
  store: FleetLockStore,
  input: {
    fleet: FleetItem;
    stack: StackInfo | null;
    hermeticd: FleetManifest["hermeticd"];
    owner: string;
    ttlMs: number;
    now: () => Date;
    updatedBy: string;
    updatedAt: string;
  },
): Promise<void> {
  const { fleet, owner, ttlMs, now } = input;
  await withFleetLock(store, { fleet, owner, ttlMs, now }, async (locked) => {
    /**
     * Merged, not rebuilt from `_fleet` alone: the foundation stamp lands in
     * the bucket before it lands on the row, so a rebuild taken from the row
     * inside that window silently rewinds it (`laterFoundation`).
     */
    const published = await carriedBlocks(artifacts);
    const foundation = laterFoundation(manifestFoundationOf(locked), published.foundation);
    await writeFleetManifest(artifacts, {
      fleet: locked,
      stack: input.stack,
      hermeticd: input.hermeticd,
      updatedBy: input.updatedBy,
      updatedAt: input.updatedAt,
      ...(foundation === undefined ? {} : { foundation }),
      // Carried over, never rebuilt: `upgrade --hermeticd` moves the release
      // pointer and has nothing to say about the Hermes mirror, so dropping the
      // block here would send every box back to cloning github.com (§3.6).
      // `carriedBlocks` rather than the manifest itself, so a manifest refused
      // for its keys is repaired by this write instead of read as an absent one
      // whose mirror block never existed.
      ...(published.hermes === undefined ? {} : { hermes: published.hermes }),
      // And the browser, on the same rule and for a worse failure: dropping it
      // would leave every agent with no build to install (§7.3).
      ...(published.browser === undefined ? {} : { browser: published.browser }),
    });
  });
}

/**
 * Record a Hermes bundle the mirror step just pushed, without touching anything
 * else the manifest says (§3.6).
 *
 * Its own function rather than a flag on `pointFleetAt` because the two are
 * different writes: that one moves the release pointer, this one only adds to
 * the mirror block. `upgrade --hermes` is the caller — it rewrites agent
 * configs and no release — and it takes the fleet lock here for the reason
 * every other manifest write does: a `foundation.update`'s prune decides what
 * to delete from the manifest it read a moment ago.
 *
 * A fleet with no published manifest is left alone and answers `false`: there
 * is nothing to add the block to, and inventing a manifest from here would
 * publish a release pointer no push ever made.
 */
export async function recordHermesMirror(
  artifacts: Pick<ArtifactsApi, "putObject" | "getText">,
  store: FleetLockStore,
  input: {
    fleet: FleetItem;
    stack: StackInfo | null;
    hermes: FleetManifest["hermes"];
    owner: string;
    ttlMs: number;
    now: () => Date;
    updatedBy: string;
    updatedAt: string;
  },
): Promise<boolean> {
  const { fleet, owner, ttlMs, now } = input;
  return withFleetLock(store, { fleet, owner, ttlMs, now }, async (locked) => {
    /**
     * Refused is not absent. This write copies the release pointer forward
     * untouched, so a manifest whose keys were refused cannot be answered with
     * `false`: that reads as "this fleet has no manifest", which is a different
     * sentence and the wrong remedy.
     */
    const published = await readFleetManifest(artifacts).catch(nullUnlessRefused);
    if (!published) return false;
    const foundation = laterFoundation(manifestFoundationOf(locked), published.foundation);
    await writeFleetManifest(artifacts, {
      fleet: locked,
      stack: input.stack,
      hermeticd: published.hermeticd,
      updatedBy: input.updatedBy,
      updatedAt: input.updatedAt,
      ...(foundation === undefined ? {} : { foundation }),
      // Merged over what the bucket says *now*, not over what the mirror step
      // was handed: another laptop may have added a ref inside that window.
      hermes: { ...(published.hermes ?? {}), ...(input.hermes ?? {}) },
      // Carried over untouched. This write is about the Hermes mirror and has
      // nothing to say about the browser, but it rewrites the whole manifest —
      // so not naming the block would delete it (§7.3).
      ...(published.browser === undefined ? {} : { browser: published.browser }),
    });
    return true;
  });
}

/**
 * The fleet manifest as it stands, or `null` when none has been written yet —
 * a fleet created with `--skip-artifacts`, or one whose bucket was emptied. A
 * manifest that is *there* and does not validate is an error, not a `null`:
 * everything downstream of it verifies bytes against its digests.
 *
 * Validating includes the keys it records, which the schema cannot express: see
 * `assertReleaseKeys`. This is the laptop's half of the check hermeticd makes
 * on the box (`releaseObjectKey` in `packages/agentd/src/stages.ts`), and it is
 * here rather than at each use because every core caller reaches the manifest
 * through this function — `create` presigning a bootstrap URL, `upgrade`
 * repointing the fleet, `foundation update` republishing. One refusal covers
 * them all, and a key nobody may act on is not a fact worth returning.
 */
export async function readFleetManifest(
  artifacts: Pick<ArtifactsApi, "getText">,
): Promise<FleetManifest | null> {
  const manifest = await parseFleetManifest(artifacts);
  if (manifest !== null) assertReleaseKeys(manifest.hermeticd);
  return manifest;
}

/**
 * The manifest as the bucket holds it: read, parsed and validated against the
 * schema, but *not* against the key rule of `assertReleaseKeys`.
 *
 * Split out for one caller shape only — a writer that is about to replace the
 * `hermeticd` block outright and needs the blocks beside it (`carriedBlocks`).
 * It is not exported, because "the manifest without the check" is not a thing
 * any consumer of a key should be able to ask for.
 */
async function parseFleetManifest(
  artifacts: Pick<ArtifactsApi, "getText">,
): Promise<FleetManifest | null> {
  const text = await artifacts.getText(FLEET_MANIFEST_KEY);
  if (text === null || text.trim().length === 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new HermeticError("VALIDATION", `${FLEET_MANIFEST_KEY} is not JSON`, {
      cause: e instanceof Error ? e.message : String(e),
    });
  }
  const parsed = FleetManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new HermeticError("VALIDATION", `${FLEET_MANIFEST_KEY} does not validate`, {
      issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    });
  }
  return parsed.data;
}

/** The blocks a manifest rewrite carries across from the one already published. */
interface CarriedBlocks {
  foundation?: FleetManifest["foundation"];
  hermes?: FleetManifest["hermes"];
  browser?: FleetManifest["browser"];
}

/**
 * What a writer that replaces the `hermeticd` block keeps from the manifest
 * already in the bucket: the foundation stamp and the Hermes mirror, neither of
 * which it has anything to say about.
 *
 * This exists because `readFleetManifest().catch(() => null)` answered the same
 * `null` to two different questions. "There is no manifest yet" and "there is a
 * manifest and it is refused" are not the same fact, and collapsing them broke
 * the remedy the refusal names: `artifacts push` republished with `hermes`
 * undefined, so a fleet whose agents sit on two Hermes refs (§6.5) — only one of
 * which `mirrorHermes` rebuilds — lost the other ref's bundle entry and sent
 * those boxes back to cloning github.com.
 *
 * So the refusal is not swallowed; it is *routed*. The key rule guards keys
 * anyone might act on, and these two blocks are neither of the block being
 * refused — carrying them across a rewrite that replaces `hermeticd` wholesale
 * both preserves them and repairs the manifest. A genuinely unreadable object
 * (not JSON, or not this schema) is still treated as absent, because a push has
 * to be able to write over one: it is the operator's repair.
 */
export async function carriedBlocks(artifacts: Pick<ArtifactsApi, "getText">): Promise<CarriedBlocks> {
  const manifest = await parseFleetManifest(artifacts).catch(() => null);
  if (manifest === null) return {};
  return {
    ...(manifest.foundation === undefined ? {} : { foundation: manifest.foundation }),
    ...(manifest.hermes === undefined ? {} : { hermes: manifest.hermes }),
    ...(manifest.browser === undefined ? {} : { browser: manifest.browser }),
  };
}

/**
 * Read the published manifest for a caller that is going to *copy* part of it
 * forward, swallowing an unreadable object and never a refused one.
 *
 * `upgrade --hermes` is that caller: it rewrites only the mirror block and
 * carries the release pointer over untouched, so reading a refused manifest as
 * an absent one would either publish the refused keys again or silently do
 * nothing while reporting that the fleet has no manifest at all.
 */
function nullUnlessRefused(e: unknown): null {
  if (e instanceof HermeticError && e.code === "MANIFEST_REFUSED") throw e;
  return null;
}

/**
 * Refuse a `hermeticd` block whose files sit outside the release it claims.
 *
 * `FleetManifestFile.key` is a non-empty string to the schema and an
 * *instruction* to everything that reads it: hermeticd fetches it and runs it
 * as a bootstrap stage, and `create` presigns it into a booting instance's
 * user-data as a one-hour bearer credential. The fleet role can read `config/*`
 * and `hermes/*` in the same bucket, so a manifest naming one of those keys for
 * `hermeticd` would hand a new box another agent's rendered config — secrets
 * and all — under the name of a binary it is about to execute.
 *
 * Only the keys are checked, not the digests: a digest is verified against the
 * bytes by whoever downloads them, and that check already exists. What no later
 * check can undo is a URL already minted for the wrong object.
 *
 * `hermes` is deliberately not checked here. Its keys are `hermes/<ref>.bundle`
 * by design (§3.6) — a different namespace with a different reader — and
 * holding it to the release prefix would refuse every fleet that has a mirror.
 *
 * The scope is the *generation* the block names, not only its version, whenever
 * it names one. A manifest saying the fleet is on generation B while recording
 * generation A's binary describes two releases exactly as a version mismatch
 * does, and it is the likelier of the two to be written by accident or by a
 * hand edit: every key is still under the version, every digest still names a
 * real object, and the generation field is the only thing in the manifest that
 * disagrees. A block with no generation — one written before generations
 * existed, or `describeRelease`'s flat fallback — is held to the version alone.
 */
function assertReleaseKeys(hermeticd: FleetManifest["hermeticd"]): void {
  const generation = hermeticd.generation;
  for (const [name, entry] of Object.entries(hermeticd.files)) {
    if (isReleaseObjectKey(entry.key, hermeticd.version, generation)) continue;
    throw new HermeticError(
      "MANIFEST_REFUSED",
      `${FLEET_MANIFEST_KEY} records ${name} of hermeticd ${hermeticd.version} at ${entry.key}, which is not an object of that release; refusing to act on it — run \`hermetic artifacts push\` to republish`,
      {
        version: hermeticd.version,
        file: name,
        key: entry.key,
        ...(generation === undefined ? {} : { generation }),
      },
    );
  }
}
