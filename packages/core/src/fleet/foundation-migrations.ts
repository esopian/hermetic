/**
 * The foundation contract's migration list (§6.6).
 *
 * `FOUNDATION_VERSION` (`version.ts`) numbers the *contract* — the
 * CloudFormation template, the S3 layout, and the shape of the remote and local
 * state. Bumping it is a promise that everything a fleet on the previous
 * version carries can be moved forward, and this is where that promise is kept:
 * one entry per version, each idempotent, each describing itself in a sentence
 * an operator reads in `plan foundation` before anything runs.
 *
 * The stack itself is *not* migrated here — CloudFormation does that, from the
 * template, in the `stack` phase. These hooks are for the state CloudFormation
 * does not own: an attribute that has to be back-filled onto every agent row, a
 * bucket key that has to move, a local table that has to gain a column.
 *
 * Ordering is by `version`, and a run applies every entry with
 * `old < version <= FOUNDATION_VERSION`. An entry with no hooks is still worth
 * having: it is the record of what that version changed.
 */
import type { Database } from "bun:sqlite";
import { FLEET_KEY, defaultFleetSettings } from "../schema/index.ts";
import type { DirectoryEntry, FleetItem } from "../schema/index.ts";
import type { Backend, StackInfo } from "../backend/types.ts";
import {
  AGENT_PARAM_ROOT,
  HERMETIC_PARAM_ROOT,
  agentParamPrefix,
  hermeticParamPrefix,
} from "../backend/constants.ts";
import { abortableSleep } from "../abort.ts";
import { HermeticError } from "../errors.ts";
import { LEGACY_FLEET_LAYOUTS } from "./legacy-params.ts";
import type { DirectoryScope } from "./legacy-params.ts";
import { bedrockIdsFromArns } from "../profiles/bedrock-grants.ts";
import {
  legacyParamPrefixes,
  listLegacyParams,
  readDirectoryScope,
  readFleetScope,
} from "./legacy-params.ts";

/** What a remote migration hook may reach. Deliberately the whole backend: a
 * migration is the one place that legitimately rewrites rows and objects that
 * no ordinary operation touches, and narrowing it per entry would mean editing
 * this file's types every time one is added. */
export interface FoundationMigrationDeps {
  backend: Backend;
  /**
   * The `_fleet` item as it stands *before* the stamp of step 5 (§6.6), and the
   * object the stamp will write. A hook that needs to change the item itself
   * patches this in place: the stamp rewrites the whole item from this copy, so
   * a separate conditional write of the same item would only be overwritten by
   * it a moment later. `runMigrations` hands it back for the stamp to use.
   */
  fleet: FleetItem;
  /** The ARN of whoever is running the update, for anything a hook records. */
  actor: string;
  nowIso: () => string;
  /**
   * What this hook has to say, one sentence per line. `runMigrations` yields
   * each as its own `OpEvent`, which is how a best-effort step reports what it
   * did or why it could not — core states, the head prints (rule 1).
   */
  notes: string[];
  /**
   * The op's own signal (§3.2 rule 2). A migration hook can be minutes of round
   * trips — v3's copy is one `GetParameter` and one `PutParameter` per slot —
   * so an operator who pressed Ctrl-C must not have to wait for all of them.
   */
  signal?: AbortSignal | undefined;
  /**
   * Push the fleet lock's expiry out from inside the hook (§4.4).
   *
   * The same reasoning as the op's other long phases: a hook that is minutes of
   * round trips can outlast the ten-minute TTL on its own, and a lock that
   * lapses mid-hook is free for another laptop to take while this one is still
   * writing. The keeper the op already holds is rate-limited to once per third
   * of the TTL, so calling it per slot costs nothing.
   */
  heartbeat?: (() => Promise<void>) | undefined;
  /**
   * How a hook waits. `abortableSleep` in production; a test hands in a
   * no-op, because the only thing that waits here is a consistency retry and a
   * suite must not spend real seconds proving it gave up.
   */
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
}

export interface FoundationMigration {
  /** The version this entry brings a fleet *to*. */
  version: number;
  /** One sentence, shown in `plan foundation` and emitted as an event. */
  describe: string;
  /**
   * State that has to move **before** CloudFormation applies the new template.
   *
   * The v3 entry is why this exists: its template narrows the agent role from
   * `parameter/hermes/*` to `parameter/hermes/<fleet_id>/*`, and its state step
   * copies every parameter under that new prefix. Run in the usual `remote`
   * slot the two would happen in the wrong order — the role would be narrowed
   * to a prefix that is still empty, and a box rebooting in that window would
   * find nothing it is allowed to read.
   *
   * Idempotent, and its `notes` are yielded as events. `plan.foundation` lists
   * these separately as "pre-stack steps", because they are the part of an
   * update that has already happened by the time CloudFormation is asked for
   * anything.
   *
   * Best effort *unless* `beforeRequired` says otherwise.
   */
  before?: (deps: FoundationMigrationDeps) => Promise<void>;
  /**
   * Whether the stack change depends on `before` having finished (§6.6).
   *
   * A pre-stack step exists because the template that follows it assumes its
   * work is done, and for v3 that assumption is load-bearing: the template
   * narrows the agent role to `parameter/hermes/<fleet_id>/*`, so a copy that
   * did not finish leaves a role pointed at a prefix that does not hold the
   * parameters the boxes read. Carrying on from there applies the narrowing
   * anyway and then stamps the new foundation version, which takes the entry
   * out of `migrationsBetween` for good — the failure is recorded as a note and
   * never retried.
   *
   * So a required step that throws fails the whole update *before* the change
   * set is computed: the template is untouched, the stamp never happens, the
   * fleet is still on the version it was, and the same command re-runs every
   * step from the start. Default `false`, which is the older best-effort
   * contract: a step whose failure the following template does not care about
   * says so on a `warn` and the update continues.
   */
  beforeRequired?: boolean;
  /**
   * State in AWS that CloudFormation does not own, after the stack is updated.
   * Must be idempotent: a `foundation.update` that fails in a later phase is
   * re-run from the start, and this hook runs again.
   */
  remote?: (deps: FoundationMigrationDeps) => Promise<void>;
  /**
   * The laptop's own `hermetic.db`. Runs *after* `db.ts`'s `MIGRATIONS` have
   * brought the schema up — a foundation migration that needs a new column adds
   * one there and reads it here — and is skipped, with a warning, on a core
   * instance that has no local database (fixtures and tests).
   */
  local?: (db: Database) => void;
}

export const FOUNDATION_MIGRATIONS: ReadonlyArray<FoundationMigration> = [
  {
    version: 1,
    describe: "stamp foundation_version on _fleet and the fleet manifest",
    // No hooks: version 1 *is* the introduction of the stamp, and the stamp is
    // written by the update's own commit point (§6.6 step 5). An entry with no
    // hooks still earns its place — it is what `plan foundation` shows for a
    // fleet on version 0, and what proves the list is applied in order.
  },
  {
    version: 2,
    describe: "seed _fleet.settings from the fleet defaults and the provider catalog",
    /**
     * The fleet's shared settings (§4.6) back-filled onto an item that predates
     * them. No stack change, which is why the template digest for v2 is the
     * digest for v1: the contract moved, the CloudFormation did not.
     *
     * It patches `deps.fleet` **in place** rather than writing through
     * `FleetStore.putSettings`, and both halves of that are deliberate:
     *
     * - The update holds the fleet lock, and `putSettings` refuses a locked
     *   item on purpose — a settings write landing mid-update would be
     *   discarded moments later by the stamp of §6.6 step 5, which rewrites the
     *   whole item from the caller's copy.
     * - So the copy is what has to carry it. `runMigrations` hands the patched
     *   item back and the stamp writes it, which makes the settings and the
     *   version stamp one conditional write rather than two.
     *
     * Idempotent by the first line: a fleet that already has settings — because
     * a laptop wrote some, or because a previous attempt at this update got
     * past here before failing later — keeps them untouched.
     */
    remote: async ({ fleet, actor, nowIso }: FoundationMigrationDeps): Promise<void> => {
      if (fleet.settings) return;
      fleet.settings = defaultFleetSettings(fleet.defaults, actor, nowIso());
    },
  },
  {
    version: 3,
    describe:
      "scope this fleet's SSM parameters and EC2/EBS tags by its fleet id, and record its name on _fleet",
    /**
     * §5/§8.2: two fleets in one AWS account must not collide on any cloud-side
     * identifier. The template half of that is CloudFormation's (the agent role
     * is re-scoped to `parameter/hermes/<fleet_id>/*`); this is the state half.
     *
     * Every step is idempotent and says what it did, and the three that run
     * *after* the stack are best effort besides. A fleet in the middle of a
     * foundation update is a fleet an operator is watching, and failing the
     * whole op because one of three clean-ups could not be finished would
     * leave the *template* half applied and the fleet on the old version — the
     * worst of both.
     *
     * The parameter copy is the exception, and `beforeRequired` below is why:
     * it runs before the template, and the template depends on it.
     */
    /**
     * Before the stack: the parameter copy. The v3 template narrows the agent
     * role to `parameter/hermes/<fleet_id>/*`, so the parameters have to be
     * *there* before the narrowing lands, or an agent that reboots between the
     * two finds an empty prefix it is allowed to read and a full one it is not.
     */
    before: copyParametersUnderFleetId,
    /**
     * And it is *required*: the same template narrows the role to the prefix
     * the copy writes into, so a copy that could not finish must stop the
     * update rather than be recorded as a note under a fleet that has already
     * been stamped past this entry.
     */
    beforeRequired: true,
    remote: async (deps: FoundationMigrationDeps): Promise<void> => {
      await backfillFleetName(deps);
      await adoptUntaggedResources(deps);
      /**
       * Step 4 is deliberately a no-op. A running box's OS hostname, and the
       * tailnet device it registered with it, cannot be changed from here: the
       * node is already admitted under its bare name and renaming it would take
       * a boot. So existing nodes keep the names they have until they are
       * recreated, and `doctor` reports the disagreement it can already see
       * (`hostname_mismatch`) rather than this migration pretending to fix it.
       */
      deps.notes.push(
        "hostnames are not migrated: existing nodes keep their bare tailnet name until they are recreated; `hermetic doctor` lists them",
      );
    },
  },
  {
    version: 4,
    describe:
      "name cloud resources for this fleet's id rather than its name; existing nodes keep their hostnames until they are recreated",
    /**
     * §5/§6.1: `cloudName` is keyed on `fleet_id`, not `fleet_name`.
     *
     * **No hooks, and that is the whole entry.** Nothing in AWS or in the
     * remote state has to move, because nothing that already exists can be
     * renamed from here:
     *
     * - An instance's OS hostname, and the tailnet device it registered under,
     *   are written by cloud-init at first boot. Changing either takes a boot,
     *   so a running box keeps the name it has — the same reason v3's step 4
     *   was a no-op, and the reason `legacyCloudNames` exists to recognise both
     *   of the older spellings rather than call them faults.
     * - An EC2/EBS `Name` tag *could* be rewritten in place, and deliberately
     *   is not. It would then disagree with the hostname on the same box, which
     *   is worse than either spelling: the tag is how an operator finds the
     *   instance in the console for the node they are ssh'd into.
     * - `_fleet.fleet_name` stays exactly where it is. It is still the fleet's
     *   label, and `legacyCloudNames` needs it to recognise a v3 node.
     *
     * So the fleet moves to v4 by being *told* it has, and every agent adopts
     * the new spelling the next time it is recreated. What the version stamp
     * buys is the ability to say which rule a fleet is on, which is what
     * `doctor` and `foundation status` report.
     */
    remote: async (deps: FoundationMigrationDeps): Promise<void> => {
      deps.notes.push(
        "cloud names are now built from this fleet's id: new instances, volumes and tailnet nodes are `<fleet id>-<agent>`",
      );
      deps.notes.push(
        "nothing is renamed: a hostname is fixed at boot, so existing nodes keep theirs until `hermetic agent recreate` rebuilds them; `hermetic doctor` lists them and does not call them stale",
      );
    },
  },
  {
    version: 5,
    describe: "bound the fleet bucket: expire noncurrent object versions",
    // No hooks: the whole change is a `LifecycleConfiguration` on the bucket,
    // which CloudFormation applies from the template in the `stack` phase.
    // Nothing in the remote or local state moves, and nothing has to be
    // back-filled — the rules act on noncurrent versions S3 already holds.
  },
  {
    version: 6,
    describe:
      "harden the nat branch with a stable egress address and IPv6 egress, and record the fleet's network mode on _fleet",
    /**
     * Two changes in one version (§5).
     *
     * The template half is CloudFormation's and needs no hook: a `nat` fleet
     * gains `NatEip` + `NatEipAssociation`, so its egress address stops
     * changing under every replacement, and `EgressOnlyInternetGateway` +
     * `PrivateDefaultRouteV6` with `Ipv6CidrBlock` on each private subnet, so
     * `nat` is dual-stack like `public` already was. A `public` fleet's stack
     * is unchanged — every one of those resources is gated on `IsNat`.
     *
     * The state half is this hook: `_fleet.network`, back-filled from the
     * stack's own `Network` parameter. Every fleet ever created passed that
     * parameter, and until now nothing read it back — so a fleet built with
     * `--network nat` was indistinguishable, from the laptop, from one built
     * without it.
     *
     * It runs in the `migrate` phase, *after* the change set has executed, so
     * `describeStack` answers with the stack as it now stands. That is the
     * right side of the update for this particular back-fill: `Network` is
     * carried forward by `UsePreviousValue` and the update does not redecide it
     * (`cfn.ts`), so the value is the same before and after — and reading after
     * means reading the stack the fleet actually ended up with.
     *
     * Idempotent, and careful about absence: a stack that reports no `Network`
     * parameter leaves the field alone rather than being called `public`, which
     * is the assumption this whole field exists to stop anyone making.
     */
    remote: async (deps: FoundationMigrationDeps): Promise<void> => {
      await backfillNetworkMode(deps);
    },
  },
  {
    version: 7,
    describe:
      "let an agent read the Hermes source mirror from the fleet bucket, and list Bedrock models",
    /**
     * §3.6/§5: a policy widening, and nothing else.
     *
     * **No hooks, and that is the whole entry.** Both halves are CloudFormation's
     * — the agent role's S3 read and `ListBucket` prefix condition gain
     * `hermes/*`, and a separate read-only statement grants
     * `bedrock:ListFoundationModels` and `bedrock:ListInferenceProfiles` — so
     * the stack update *is* the migration. Nothing in the remote state and
     * nothing on the laptop has to move:
     *
     * - The mirror block on the fleet manifest is additive and written by the
     *   next push, not by this. A fleet that is updated and never pushed to
     *   again simply has a permission it does not use, and its boxes go on
     *   cloning Hermes from github.com exactly as before.
     * - Nothing is deleted. The two prefixes a box could already read are still
     *   there, so a box on the old policy and a box on the new one both boot.
     *
     * The note is the whole point of the entry: `plan foundation` has something
     * to show for the version, and an operator can see which fleets can serve
     * Hermes from their own bucket and which cannot yet.
     */
    remote: async (deps: FoundationMigrationDeps): Promise<void> => {
      deps.notes.push(
        "agents may now read `hermes/*` from the fleet bucket: once `hermetic artifacts push` has mirrored a Hermes ref, new boxes install it from S3 instead of cloning github.com",
      );
      deps.notes.push(
        "agents may now list Bedrock foundation models and inference profiles, which `hermes doctor` and the model picker need; invocation stays scoped to the fleet's model ARNs",
      );
    },
  },
  {
    version: 8,
    describe: "agents report which binary and which Hermes they are actually running",
    /**
     * §6.6: a *state* change with nothing to move, and the reason it is a new
     * contract version anyway.
     *
     * The agent row gains two fields only a box writes —
     * `running_hermeticd_sha256`, the digest of the hermeticd binary its process
     * was launched from, and `running_hermes_version`, read out of Hermes's own
     * `/api/health` — joining `applied_config_hash` as the facts a box states
     * about itself rather than has stated about it. The fleet manifest's
     * `hermetic_version` also stops carrying the hermeticd release and starts
     * carrying what it has always claimed to: the tool build that wrote the file.
     *
     * **No hooks, and there is nothing a hook could do.** Both fields are
     * written only by hermeticd, on a heartbeat, about the moment it is writing
     * them; a laptop cannot back-fill a fact it does not have, and inventing one
     * is precisely the failure the fields exist to end. A fleet arrives at v8
     * with both absent on every row, which reads as *unknown* everywhere — never
     * as agreement — and each box fills its own in as it takes the release.
     *
     * The version moves regardless, because the contract did: §6.6's rollout no
     * longer confirms a landing from `hermeticd_version` (a build-time label, a
     * constant compared with itself, a guard that could not fail) but from the
     * digest, and a fleet's boxes have to be new enough to report one before
     * that confirmation can succeed. An operator reading `foundation status` is
     * entitled to know which side of that line their fleet is on, and the
     * version number is how they know.
     */
    remote: async (deps: FoundationMigrationDeps): Promise<void> => {
      deps.notes.push(
        "agents now report the digest of the hermeticd binary they are running, which is what a rollout confirms against — until each box has taken this release it reports no digest, and `foundation update` names it as unconfirmed rather than as landed",
      );
      deps.notes.push(
        "agents now report the Hermes version their own dashboard answers with, beside the version the row pins; the two differ between `hermetic upgrade --hermes` and the recreate that applies it",
      );
    },
  },
  {
    version: 9,
    describe: "migrate the account directory to fleet-id rows and display aliases",
    /**
     * §4.6/§4.8: a fleet's name stops being its identity and becomes an
     * optional display alias. The account directory is the one place that
     * change has state to move: pre-v9 rows are keyed by the *name*, so a fleet
     * could not be renamed without moving its row, two fleets could not both be
     * unnamed, and a label could be recycled onto a different fleet the moment
     * the first one was torn down.
     *
     * After this hook every row is keyed by `fleet_id`, the label rides on the
     * row as `alias`, and each label in use has a reservation row of its own so
     * uniqueness is a conditional write rather than a convention. Idempotent:
     * rows already in the new shape are skipped, so re-running a failed
     * `foundation update` re-runs this for nothing.
     *
     * The directory is account-global, not per-fleet (§4.8) — it is not owned
     * by any fleet's stack — so this runs once per `foundation update` in the
     * account and is a no-op for every fleet after the first.
     */
    remote: async (deps: FoundationMigrationDeps): Promise<void> => {
      await migrateDirectoryToFleetIds(deps);
    },
  },
  {
    version: 10,
    describe:
      "reconcile the fleet's Bedrock model grant with its provider profiles and agents, and record it on _fleet",
    /**
     * §8.3: the grant stops being a decision `init` made once.
     *
     * `BedrockModelArns` has been a stack parameter since v1, but every
     * `foundation update` carried it forward with `UsePreviousValue` — so a
     * fleet created before a model existed could never be granted it, and a
     * Bedrock profile naming one produced an agent that booted and then failed
     * every turn with `AccessDeniedException` from a policy nothing in hermetic
     * would rewrite. From v10 the update computes the set the fleet needs (this
     * build's defaults ∪ every Bedrock profile's model ∪ every Bedrock model an
     * agent pins or has staged), states it on the change set, and records the
     * result on `_fleet.bedrock_model_ids`.
     *
     * The template does not change, which is why the digest for v10 is the
     * digest for v9: the parameter and the policy that reads it were already
     * there. What changed is who decides the parameter's value.
     *
     * **The hook is a `before`, not a `remote`, and the ordering is the point.**
     * The computation above unions with what the fleet already holds, so that
     * an update can widen a grant and never narrow one under a box that is
     * serving. On a fleet that has never recorded the field there is nothing to
     * union with, and this is where it comes from: the stack's own current
     * parameter, parsed back into ids. Run after the change set it would be
     * reading the value this update had just written, and a fleet granted
     * something no build of hermetic defaults to would have lost it.
     */
    before: async (deps: FoundationMigrationDeps): Promise<void> => {
      await backfillBedrockGrant(deps);
    },
  },
  {
    version: 11,
    describe: "agents report the tailscaled they are running, and keep it up to date themselves",
    /**
     * §4.3/§4.2: a state change with no template behind it and, like v8,
     * nothing a laptop could move.
     *
     * Two halves of one fact. `stages/01-tailscale.sh` now calls
     * `tailscale set --auto-update`, so a box takes new stable Tailscale
     * releases on its own — until this release nothing on a box ever upgraded
     * it, since the stage installs only when the binary is absent, hermeticd's
     * apply installs only packages that are missing, and Ubuntu's
     * `unattended-upgrades` allows the Ubuntu security pocket and not
     * pkgs.tailscale.com. A fleet ran whatever the repository served on each
     * box's create day until somebody recreated it. And the agent row gains
     * `tailscale_version`, which the heartbeat reads out of the
     * `tailscale status --json` it already runs, because a version that now
     * moves without hermetic asking is a version hermetic has to record to know
     * anything about.
     *
     * **No hooks, and nothing for one to do.** Only a box can state either
     * thing: the field is written on a heartbeat, and the updater is turned on
     * by a stage, which reaches an existing box through `artifacts push` plus
     * `agent rerun` rather than through a foundation update. A fleet arrives at
     * v11 with the field absent on every row — *unknown*, never an old version
     * — and each box fills its own in on its next heartbeat.
     *
     * The version moves anyway, for v8's reason: what a row means changed. An
     * operator reading `agent status` is entitled to know whether a blank
     * Tailscale version is a box that has not reported yet or a fleet whose
     * boxes cannot report at all.
     */
    remote: async (deps: FoundationMigrationDeps): Promise<void> => {
      deps.notes.push(
        "agents now report the version of tailscaled they are running, and keep it current themselves — `hermetic artifacts push` and then `hermetic agent rerun <name>` is what turns the updater on for a box that already exists",
      );
    },
  },
  {
    version: 12,
    describe: "narrow the agent role's SSM permissions to the fleet's own parameter tree",
    /**
     * §5.1: a template change with nothing to move, and a narrowing rather than
     * a widening — which is the only reason it needs saying out loud here.
     *
     * The agent role stops attaching `AmazonSSMManagedInstanceCore` and states
     * that policy's contents inline instead, minus `ssm:GetParameter` and
     * `ssm:GetParameters`. The managed policy granted both on `Resource: "*"`,
     * and IAM unions an attached policy with an inline one, so the fleet-scoped
     * `FleetParameters` statement — narrowed at v3 for exactly this reason —
     * bounded nothing: every box could read any parameter name in the account
     * it could guess, including its own fleet's Tailscale OAuth secret under
     * `/hermetic/<fleet_id>/tailscale/` and any other fleet's `/hermes/` slots.
     *
     * **No hooks, and a narrowing needs none, because nothing legitimate was
     * using the reach being removed.** The only parameter read from a box is
     * hermeticd fetching its own `/hermes/<fleet_id>/<agent>/*` slots
     * (`agentd/src/aws.ts`), which `FleetParameters` has always allowed and
     * still does. Session Manager keeps working — `SsmMessages` and `SsmAgent`
     * carry the connectivity half of the managed policy verbatim — so the
     * break-glass path of §6.3 is unaffected.
     *
     * The stack update *is* the migration: CloudFormation rewrites the role's
     * policy in the `stack` phase and a running box picks the new credentials
     * up on its next IMDS refresh. This entry is the note that says so, so that
     * `plan foundation` has something to show for the version.
     */
    remote: async (deps: FoundationMigrationDeps): Promise<void> => {
      deps.notes.push(
        "the agent role no longer attaches AmazonSSMManagedInstanceCore: SSM parameter reads are now confined to this fleet's own `/hermes/<fleet_id>/*` tree, and a box can no longer read the fleet's Tailscale OAuth secret or another fleet's slots",
      );
      deps.notes.push(
        "Session Manager is unaffected — the ssmmessages, ec2messages and SSM-agent permissions the managed policy carried are now stated inline on the role",
      );
    },
  },
  {
    version: 13,
    describe:
      "record the _fleet revision counter every fleet-wide write is now guarded on, and fill any fleet-scoped SSM parameter an earlier update left empty",
    /**
     * §4.4: `_fleet` gained a `version` attribute, and `_fleet` is remote state,
     * so the contract moved even though the template did not.
     *
     * The counter is what `replaceFleet` states and `updateFleet` bumps, and it
     * is optional on read because absent means 0 — which is what made it look
     * like a change needing no version at all. It is not, and the reason is an
     * *older* build: `FleetItem` is a non-strict object, so a build that
     * predates the field parses a row carrying it, drops it on the floor, and
     * writes the item back whole without it. The counter rewinds to absent, two
     * newer-build replacements composed against `version: 0` then both pass
     * their condition, and the second silently reverts the first. The fence is
     * the one this bump buys: `guardFleet` refuses a build whose
     * `FOUNDATION_VERSION` is behind the fleet's with `FOUNDATION_NEWER`, so a
     * build old enough to strip the attribute never reaches a write.
     *
     * The hook patches `deps.fleet` in place rather than writing through
     * `updateFleet`, for the reason v2's does: this update holds the fleet lock
     * and its commit point (§6.6 step 5) rewrites the whole item from this copy,
     * against the revision it captured when it took the lock. A conditional
     * write from inside a migration would bump that revision and so refuse the
     * very stamp that carries this change — the patch door is the right door,
     * and the stamp is the one going through it.
     *
     * Idempotent, and a no-op on all but the oldest fleets: any row written or
     * replaced since the counter existed already carries one.
     */
    /**
     * And the repair v3's own fix could not reach.
     *
     * v3's parameter copy became a *required* step, so a slot it cannot finish
     * now fails the update with nothing stamped. That is the whole fix for a
     * fleet taking v3 from here on, and no fix at all for one already carried
     * past v3 by the older best-effort path: there, a copy that did not land
     * was recorded as a note under a stamped version, and `migrationsBetween`
     * has not offered v3 since. The destination is absent or still holds
     * hermetic's placeholder, the legacy source still holds the value, `secrets
     * verify` reports the slot as unpushed, and nothing re-runs the copy.
     *
     * So the first version after that fix carries it: the same routine, in
     * `repair` mode, filling only destinations that are empty from sources that
     * are not. A destination holding a value is kept exactly as v3 keeps one —
     * it may have been pushed since, and the stale original must not be written
     * over it — and a fleet with nothing of the kind gets no note.
     *
     * Required for v3's second reason rather than its first. No template change
     * depends on it here, but the stamp does: a failure recorded as a note under
     * a stamped v13 is a failure nothing retries, which is the exact shape this
     * entry exists to undo.
     *
     * A fleet crossing v3 and v13 in one update runs both, and the second finds
     * the first's work done and keeps it — the cost is a pair of reads per slot
     * and the gain is that "did v3 run here, or was it stamped past?" is not a
     * question this has to answer.
     */
    before: async (deps: FoundationMigrationDeps): Promise<void> => {
      await copyParametersUnderFleetId(deps, "repair");
    },
    beforeRequired: true,
    remote: async ({ fleet, notes }: FoundationMigrationDeps): Promise<void> => {
      if (fleet.version !== undefined) return;
      fleet.version = 0;
      notes.push(
        `${FLEET_KEY} had no revision counter, so it starts at 0; every fleet-wide write is conditional on it from this version on`,
      );
    },
  },
  {
    version: 14,
    describe: "grant agents read on browser/* and mirror the pinned Chrome for Testing build",
    /**
     * §7.3: the agent's browser stops being an apt package that cannot work and
     * becomes a pinned build in the fleet's own bucket.
     *
     * The template half is two lines in the agent role — `browser/*` added to
     * the S3 read and to the `ListBucket` prefix condition — and it is what
     * `BROWSER_NEEDS_FOUNDATION_UPDATE` refuses on behalf of: every agent now
     * runs a browser, so one created on a fleet below this version would boot
     * and then 403 in the stage that unpacks the build, minutes into a first
     * boot nobody is watching.
     *
     * No hooks, because the state this version needs is not state a laptop
     * back-fills: the build itself is uploaded by the update's own artifacts
     * phase, which mirrors it beside the Hermes bundle and records it on the
     * fleet manifest. An entry with no hooks still earns its place — it is what
     * `plan foundation` shows for a fleet below v14, and what makes the grant and
     * the upload one numbered contract rather than two coincidences.
     */
  },
  {
    version: 15,
    describe: "roll the passwordless sudo grant and the per-agent approvals_mode setting to every box",
    /**
     * The first entry whose whole purpose is the *rollout*, not the contract.
     *
     * CloudFormation gains nothing — v15 applies v14's template, and the
     * repeated digest in `foundation-version.test.ts` is the record of that.
     * No remote state moves and no local state moves either, so the entry
     * carries no hooks, the same shape v14 ended on.
     *
     * What did change is on the box: the rendered sudoers grant, a new
     * per-agent `approvals_mode` Hermes setting, and `hermeticd`'s advisory
     * `approvals` check in `verify-hermes`. None of that is CloudFormation's,
     * and none of it reaches an existing box through a stack update — it
     * reaches one through `artifacts push` and a rollout. `foundation update`
     * is the single operator-invoked path that does both in order
     * (`preflight → archive → stack → artifacts → migrate → rollout → done`),
     * and a version bump is what makes `update_available` true so that a fleet
     * sitting on the old grant *says* so instead of waiting to be asked.
     *
     * So the stamp is the migration, and the honest reading of the empty
     * change set is the one `runChangeSet` already has: an update whose
     * template is unchanged yields `stack already at this template` as a
     * `done` event and carries straight on to the phases that matter here.
     */
  },
];

/**
 * v10: `_fleet.bedrock_model_ids`, from the `BedrockModelArns` parameter on the
 * fleet's own stack.
 *
 * The stack is the register of record for what the role may invoke and `_fleet`
 * is the cache, exactly as `backfillNetworkMode` treats `Network` — this is the
 * one place the cache is written from the truth. Exported for the same reason
 * that one is: `foundation.update` falls back to it whenever the field is
 * absent, so a `_fleet` restored from an older archive heals rather than having
 * its grant silently recomputed from this build's defaults.
 *
 * Idempotent and careful about absence: a stack that reports no parameter, or
 * one whose value parses to nothing, leaves the field alone. "Not recorded" is
 * a fact a head can report; a guessed empty grant is not.
 */
export async function backfillBedrockGrant(deps: FoundationMigrationDeps): Promise<void> {
  if (deps.fleet.bedrock_model_ids !== undefined) {
    deps.notes.push(
      `_fleet already records this fleet's Bedrock grant (${String(deps.fleet.bedrock_model_ids.length)} model(s))`,
    );
    return;
  }
  let stack: StackInfo | null;
  try {
    stack = await deps.backend.foundation.describeStack();
  } catch (e) {
    deps.notes.push(`could not describe the foundation stack to read its Bedrock grant: ${why(e)}`);
    return;
  }
  const ids = bedrockIdsFromArns(stack?.parameters["BedrockModelArns"]);
  if (ids.length === 0) {
    deps.notes.push(
      "the foundation stack reports no `BedrockModelArns` parameter this build can read, so the grant this update states is computed from the defaults, the fleet's Bedrock profiles and its agents alone",
    );
    return;
  }
  deps.fleet.bedrock_model_ids = ids;
  deps.notes.push(
    `read this fleet's existing Bedrock grant off its stack and recorded it on ${"_fleet"}: ${ids.join(", ")}`,
  );
}

/**
 * v9: the account directory's rows, rewritten under `fleet_id`.
 *
 * Best effort and *said*, like every other hook here: a fleet whose stack has
 * already taken the new template must not be left on the old version because
 * one account-level table could not be read. Both the directory's own
 * `DIRECTORY_UNAVAILABLE` and any other failure become a note.
 */
async function migrateDirectoryToFleetIds(deps: FoundationMigrationDeps): Promise<void> {
  let moved: { fleets: number; aliases: number; duplicates: number };
  try {
    moved = await deps.backend.directory.migrate();
  } catch (e) {
    deps.notes.push(
      `could not migrate the account's fleet directory to fleet-id rows: ${why(e)} — re-run \`hermetic foundation update\` once the directory is reachable`,
    );
    return;
  }
  if (moved.fleets === 0 && moved.duplicates === 0) {
    deps.notes.push("the account's fleet directory is already keyed by fleet id");
    return;
  }
  const said: string[] = [];
  if (moved.fleets > 0) {
    said.push(
      `moved ${moved.fleets} directory row(s) onto their fleet id and reserved ${moved.aliases} display alias(es)`,
    );
  }
  if (moved.duplicates > 0) {
    said.push(
      `kept ${moved.duplicates} older row(s) as history: an interrupted rename had left two rows for one fleet, and a fleet has exactly one current alias`,
    );
  }
  deps.notes.push(said.join("; "));
}

/**
 * v6: `_fleet.network`, from the `Network` parameter on the fleet's own stack.
 *
 * CloudFormation owns the subnets, so the parameter is the truth and `_fleet`
 * is the cache; this is the one place the cache is written from the truth.
 * Patches `deps.fleet` in place for the same reason v2's hook does — the stamp
 * of §6.6 step 5 rewrites the whole item from this copy, so a separate write
 * would be overwritten moments later.
 *
 * Exported because `foundation.update` runs it on **every** update, not only on
 * the v5 → v6 crossing. A migration list is keyed on the version a fleet is
 * coming *from*, so `migrationsBetween(6, 6)` is empty and a fleet already at v6
 * whose cache has since gone stale — restored from an old archive, written by a
 * build with the bug, edited by hand — had no way back: `doctor` reported
 * `network_mode_drift` and named an update that could not fix it, while
 * `plan network --to <the stack's own mode>` refused with `CONFLICT` because
 * the stack is already there. Reconciling a cache from its source is idempotent
 * and costs one `DescribeStacks`, so it is not worth gating on a version
 * comparison.
 */
export async function backfillNetworkMode(deps: FoundationMigrationDeps): Promise<void> {
  let stack: StackInfo | null;
  try {
    stack = await deps.backend.foundation.describeStack();
  } catch (e) {
    deps.notes.push(`could not describe the foundation stack to read its network mode: ${why(e)}`);
    return;
  }
  const parameter = stack?.parameters["Network"];
  if (parameter !== "public" && parameter !== "nat") {
    /**
     * Should not happen: `Network` has been a template parameter since v1. If
     * it ever does, the field stays absent — "not recorded" is a fact a head
     * can report, and a guessed `public` on a fleet that is actually behind a
     * NAT is not.
     */
    deps.notes.push(
      "the foundation stack reports no `Network` parameter, so this fleet's network mode stays unrecorded; `hermetic doctor` will keep saying so",
    );
    return;
  }
  if (deps.fleet.network === parameter) {
    deps.notes.push(`_fleet already records this fleet's network mode as \`${parameter}\``);
    return;
  }
  deps.fleet.network = parameter;
  deps.notes.push(`recorded this fleet's network mode on _fleet as \`${parameter}\``);
}

/**
 * Step 1: `_fleet.fleet_name`, from the directory entry that already holds it (§4.8).
 * The directory is the register of record for what a fleet is called, so this
 * copies rather than invents. A fleet the directory has never heard of keeps no
 * name, and `cloudName` then goes on returning bare agent names — correct for a
 * fleet nobody has told hermetic the name of.
 */
async function backfillFleetName(deps: FoundationMigrationDeps): Promise<void> {
  if (deps.fleet.fleet_name !== undefined) {
    deps.notes.push(`_fleet already records the fleet name "${deps.fleet.fleet_name}"`);
    return;
  }
  let entries: DirectoryEntry[];
  try {
    entries = await deps.backend.directory.list();
  } catch (e) {
    deps.notes.push(`could not read the fleet directory to find this fleet's name: ${why(e)}`);
    return;
  }
  const mine = entries.find((e) => e.fleet_id === deps.fleet.fleet_id);
  if (!mine) {
    deps.notes.push(
      `this fleet is not in the account's directory, so it has no name to record; run \`hermetic init --attach --fleet ${deps.fleet.fleet_id}\` and update again`,
    );
    return;
  }
  if (mine.name !== null) {
    deps.fleet.fleet_name = mine.name;
    deps.notes.push(`recorded the fleet name "${mine.name}" on ${"_fleet"}`);
  }
}

/**
 * Step 2: adopt the instances and volumes created before the `hermetic:fleet_id`
 * tag existed.
 *
 * The condition is the whole safety argument: an untagged managed resource is
 * *this* fleet's only if this fleet is the only one in the account. With two
 * fleets there is no way to tell whose a bare `agent=atlas` volume is, and
 * guessing would hand one fleet's data disk to the other — so the step refuses
 * and says how many fleets it found. Untagged resources stay invisible to every
 * filter until an operator sorts them out; nothing is deleted either way.
 */
async function adoptUntaggedResources(deps: FoundationMigrationDeps): Promise<void> {
  let stray: { instances: string[]; volumes: string[] };
  try {
    stray = await deps.backend.compute.listUnscopedManaged();
  } catch (e) {
    deps.notes.push(`could not look for untagged instances and volumes: ${why(e)}`);
    return;
  }
  const total = stray.instances.length + stray.volumes.length;
  if (total === 0) {
    deps.notes.push("every managed instance and volume already carries this fleet's id");
    return;
  }
  /**
   * The gate, and all three of its conditions matter (`isSoleFleet`): the
   * directory was readable, it lists exactly one live fleet, and that fleet is
   * this one. `<= 1` would have adopted on an account whose directory has not
   * been written yet — which may hold any number of fleets — and an unreadable
   * directory would have read as permission rather than as "cannot tell".
   */
  const scope = await readFleetScope(deps.backend, deps.fleet.fleet_id);
  if (!scope.sole) {
    deps.notes.push(
      `${total} managed resource(s) carry no fleet tag and are left alone: ${scope.reason ?? "this is not the account's only fleet"} — which fleet they belong to cannot be told from a tag that is not there`,
    );
    return;
  }
  try {
    await deps.backend.compute.tagFleetId([...stray.instances, ...stray.volumes]);
  } catch (e) {
    deps.notes.push(`could not tag ${total} untagged resource(s) with this fleet's id: ${why(e)}`);
    return;
  }
  deps.notes.push(
    `tagged ${stray.instances.length} instance(s) and ${stray.volumes.length} volume(s) with hermetic:fleet_id=${deps.fleet.fleet_id}`,
  );
}

/**
 * Step 3: copy this fleet's pre-v3 parameters to its fleet-scoped paths.
 *
 * Copied and not moved. The old paths are what a *rolled-back* hermetic, and
 * every box still running the previous release, would read; deleting them here
 * would take a working fleet off the air to tidy up. `teardown --purge` removes
 * them when the directory proves this is the account's last fleet, and `doctor`
 * reports them in the meantime.
 *
 * The source set is *enumerated*, never swept: `legacy-params.ts` builds it
 * from this fleet's own agent table plus the two fixed fleet-level layouts, so
 * `/hermes/<other fleet id>/…` — which is where every already-migrated fleet in
 * the account keeps its parameters — is not reachable from here at all. It
 * replaced a "does the first segment look like a fleet id" test that would have
 * skipped an agent called `research` and read another fleet's keys for one
 * called `fxtr0001`.
 *
 * A scoped target that already holds something is *kept*: a re-run of a
 * migration that failed later must not overwrite a key rotated since the first
 * attempt with the stale copy still sitting on the old path.
 */
/**
 * The gaps between re-reads of a slot that has just been written, before the
 * write is called lost. One immediate read, then these — under a second in
 * total, and only ever paid on the path that is about to fail the update.
 */
const VERIFY_BACKOFF_MS: readonly number[] = [100, 250, 500];

/**
 * What this routine is being run for. The sequence is the same either way —
 * enumerate, refuse what cannot be proved, then intent, value and verification
 * per slot — and only what it says afterwards, and what it does with a source
 * nobody has ever pushed to, differ.
 *
 * `migrate` is v3's own copy, on a fleet that has not taken v3 yet: a source
 * holding nothing but the placeholder gets a declared destination to match it,
 * and the step always reports, because an operator moving a fleet across v3 is
 * entitled to the count even when it is zero.
 *
 * `repair` is the same sequence pointed at a fleet already stamped *past* v3 by
 * the older best-effort path, where a slot the copy could not finish became a
 * note under a stamped version and `migrationsBetween` has not selected v3
 * since. It fills only what that left behind — a legacy source holding a real
 * value whose fleet-scoped destination is absent or still holds the placeholder
 * — and says nothing at all when there is none, because on every other fleet it
 * is a check that found nothing rather than a step that ran.
 */
type ParameterCopyMode = "migrate" | "repair";

async function copyParametersUnderFleetId(
  deps: FoundationMigrationDeps,
  mode: ParameterCopyMode = "migrate",
): Promise<void> {
  const id = deps.fleet.fleet_id;
  const sleep = deps.sleep ?? abortableSleep;
  const scope = await readDirectoryScope(deps.backend.directory);
  let agents: string[];
  try {
    agents = (await deps.backend.store.agents.scan()).map((a) => a.name);
  } catch (e) {
    /**
     * Without the agent table there is no list of legacy prefixes, so "nothing
     * to copy" and "could not look" are indistinguishable — and this step is
     * required, so the one that cannot be told apart from a finished copy is
     * the one that must stop the update (§6.6).
     */
    throw new HermeticError(
      "FOUNDATION_UPDATE_FAILED",
      `could not read the agent table to find this fleet's legacy parameters: ${why(e)}`,
    );
  }
  /**
   * Without the directory there is no list of fleet ids to check an agent name
   * against, and `/hermes/<agent>/` is exactly where a *different* fleet that
   * has already taken v3 keeps its parameters.
   *
   * That used to copy the two fleet-level layouts, skip every per-agent prefix,
   * and say so in a note telling the operator to re-run — advice that was false
   * by the time it was printed. The update carried on from here, the template
   * narrowed the role onto the per-agent prefixes nothing had filled, and the
   * stamp took v3 out of `migrationsBetween` for good, so the re-run the note
   * asked for would skip the step entirely. A required step that cannot *prove*
   * it copied everything has to stop instead, before anything is narrowed.
   */
  if (scope.active === null) {
    throw new HermeticError(
      "FOUNDATION_UPDATE_FAILED",
      `the account's fleet directory could not be read (${scope.error ?? "unknown error"}), so this fleet's pre-v3 agent paths cannot be told apart from the scoped root of a fleet that has already taken v3; nothing was copied and the stack was not changed. Restore this laptop's access to the account's hermetic fleet directory table and run \`hermetic foundation update\` again`,
      { fleet_id: id },
    );
  }
  const { prefixes, skipped } = legacyParamPrefixes(agents, scope);
  /**
   * A name that is both one of this fleet's agents and a fleet id: `skipped` is
   * the right answer for the callers that *delete*, and the wrong one here.
   * Leaving the prefix uncopied and carrying on narrowed the role onto a
   * fleet-scoped path that was never written, which is the same silent break as
   * the unreadable directory above.
   */
  if (skipped.length > 0)
    prefixes.push(...(await resolveContestedPrefixes(deps, scope, agents, skipped)));

  let sources: string[];
  try {
    sources = await listLegacyParams(deps.backend.secrets, prefixes);
  } catch (e) {
    throw new HermeticError(
      "FOUNDATION_UPDATE_FAILED",
      `could not list this fleet's pre-v3 SSM parameters: ${why(e)}`,
    );
  }

  /**
   * The destinations this run filled, named and never valued (§8.3). A count is
   * all the migrate note needs, but the repair note lists them: on a fleet where
   * an earlier update left something empty, *which* slots those were is the
   * whole of what the operator is being told.
   */
  const written: string[] = [];
  let kept = 0;
  let resumed = 0;
  let declared = 0;
  /** One line per slot that did not make it, named and never valued (§8.3). */
  const failed: string[] = [];
  for (const path of sources) {
    // A copy is one round trip per slot; an abandoned op stops here rather than
    // paying for the rest of them (§3.2 rule 2).
    if (deps.signal?.aborted) {
      deps.notes.push(
        `stopped after ${written.length + kept} of ${sources.length} parameter(s): the operation was cancelled`,
      );
      // Whatever had already gone wrong is said too rather than dropped with
      // the loop. A cancelled run never reaches the throw below, so these notes
      // are the only account of it the operator gets.
      for (const line of failed) deps.notes.push(`could not copy ${line}`);
      return;
    }
    // §4.4: the copy is one round trip per slot over an unbounded number of
    // them, so the lock is renewed from inside the loop rather than only
    // between the op's phases. The keeper renews at most once per third of the
    // TTL, so this is free on all but a handful of turns.
    await deps.heartbeat?.();
    const target = scopedPathFor(id, path);
    if (target === null) continue;
    try {
      /**
       * A scoped slot holding a *value* is a copy that finished — kept as it
       * stands, because it may be a key rotated since the first attempt and the
       * stale original must not be written over it.
       *
       * A scoped slot still holding hermetic's placeholder is the opposite, and
       * telling the two apart is the whole point of reading it: the placeholder
       * is what `ensureSlot` wrote as this step's record of *intent*, so a slot
       * that still holds it is a copy interrupted between the slot and the
       * value. Reading mere existence as "already done" is how a fault-injected
       * update left an unusable destination behind and then reported the new
       * foundation version; such a slot is finished here instead.
       */
      const present = await deps.backend.secrets.exists(target);
      if (present && !(await deps.backend.secrets.isPlaceholder(target))) {
        kept += 1;
        continue;
      }
      /**
       * Unless the *source* was only ever declared: hermetic owns slot
       * existence and never the value (§8.2), so a slot nobody has pushed to
       * holds the placeholder too, and there is no value to move. The
       * destination is declared to match — the narrowed role finds the slot it
       * expects — and a destination that already matches is nothing to do.
       */
      if (await deps.backend.secrets.isPlaceholder(path)) {
        /**
         * A repair moves values and declares nothing. Both ends holding the
         * placeholder is the state v3 itself leaves behind for a slot nobody
         * has pushed to, so on a fleet past v3 it is not damage to fix; and a
         * destination this run invented would be a note on a fleet that had
         * nothing wrong with it, which is what `repair` promises not to be.
         */
        if (mode === "repair") continue;
        if (present) kept += 1;
        else {
          await deps.backend.secrets.ensureSlot(target);
          declared += 1;
        }
        continue;
      }
      const value = await deps.backend.secrets.get(path);
      // Intent before the value: the destination exists, holding the
      // placeholder, before anything is written into it. That is what makes the
      // window between the two recoverable rather than invisible.
      await deps.backend.secrets.ensureSlot(target);
      await deps.backend.secrets.put(target, value);
      /**
       * And completion only once the value is verified to have landed: the slot
       * is there and no longer holds the placeholder (`verifyCopyLanded`, which
       * is where both halves of that and the retry for a stale read live).
       */
      if (!(await verifyCopyLanded(deps, target, sleep))) {
        failed.push(
          `${path} → ${target}: the destination does not hold the copied value after the write`,
        );
        continue;
      }
      written.push(target);
      if (present) resumed += 1;
    } catch (e) {
      // Named, never valued (§8.3).
      failed.push(`${path} → ${target}: ${why(e)}`);
    }
  }
  if (mode === "repair") {
    /**
     * Silent unless something was actually filled. A repair runs on every
     * update from here on, and on all but the fleets the old best-effort copy
     * left behind it finds nothing — a note saying so on every one of them
     * would bury the one that matters.
     */
    if (written.length > 0) {
      deps.notes.push(
        `filled ${written.length} fleet-scoped SSM parameter(s) that an earlier update left empty, from the legacy path that still holds their value: ${written.join(", ")}`,
      );
    }
    if (failed.length > 0) {
      throw new HermeticError(
        "FOUNDATION_UPDATE_FAILED",
        `could not fill ${failed.length} fleet-scoped SSM parameter(s) an earlier update left empty: ${failed.join("; ")}`,
        { failed: failed.length, of: sources.length },
      );
    }
    return;
  }
  const said: string[] = [];
  if (written.length > 0) {
    said.push(
      `copied ${written.length} SSM parameter(s) to this fleet's prefixes; the originals are kept until \`hermetic teardown --purge\``,
    );
  }
  if (resumed > 0) {
    said.push(
      `${resumed} of them finished a copy a previous attempt had left as an empty slot rather than counting it as done`,
    );
  }
  if (declared > 0) {
    said.push(
      `declared ${declared} scoped slot(s) whose source has never been pushed to; \`hermetic secrets push\` fills them`,
    );
  }
  if (kept > 0) {
    said.push(`kept existing ${kept} scoped parameter(s) rather than overwriting them`);
  }
  deps.notes.push(
    said.length === 0 ? "no legacy SSM parameters to copy under this fleet's id" : said.join("; "),
  );
  /**
   * Said first, then thrown. The notes above are the account of what *did*
   * move, and `runMigrationsBefore` yields them whether this returns or throws
   * — an operator who has to re-run needs to know which slots are already
   * there. The throw is what keeps the template from narrowing the role onto a
   * prefix that is missing a parameter, and keeps the stamp from taking this
   * entry out of every future `migrationsBetween`.
   */
  if (failed.length > 0) {
    throw new HermeticError(
      "FOUNDATION_UPDATE_FAILED",
      `could not copy ${failed.length} of ${sources.length} SSM parameter(s) under this fleet's id: ${failed.join("; ")}`,
      { failed: failed.length, of: sources.length },
    );
  }
}

/**
 * Which of the contested pre-v3 prefixes are this fleet's after all.
 *
 * `legacyParamPrefixes` skips a name that is both one of this fleet's agents
 * and an id the directory has listed, because `/hermes/<name>/` is then
 * ambiguous with that fleet's own scoped root. For a caller that *deletes* the
 * skip is the end of it — an ambiguous path is never deleted. For this one it
 * cannot be, because the template that follows narrows the role onto the path
 * the skip left empty.
 *
 * So the ambiguity is resolved rather than tolerated, against live evidence and
 * not against the directory's memory: a fleet that answers to that id is one
 * the directory lists as *not torn down*, or one CloudFormation still has a
 * stack for. `readFleetScope` asks both for the same reason — the directory is
 * an index rather than the truth, and a fleet created before it existed has a
 * stack and no entry. A name no live fleet answers to is this fleet's own agent
 * and its prefix is copied like any other.
 *
 * What is left is genuinely contested, and there the migration stops. Copying
 * would move another live fleet's keys into this one, and carrying on would
 * narrow the role onto a slot that will never be filled; the operator is given
 * the one command that resolves it by hand.
 */
async function resolveContestedPrefixes(
  deps: FoundationMigrationDeps,
  scope: DirectoryScope,
  agents: readonly string[],
  skipped: readonly string[],
): Promise<string[]> {
  const live = new Set<string>((scope.active ?? []).map((e) => e.fleet_id));
  let corroborated = true;
  try {
    for (const stack of await deps.backend.foundation.listStacks()) {
      if (stack.fleet_id) live.add(stack.fleet_id);
    }
  } catch (e) {
    // Not an answer. An unasked source cannot clear a name, so every contested
    // one stays contested and the throw below explains what could not be read.
    corroborated = false;
    deps.notes.push(
      `CloudFormation could not be asked which fleets this account holds (${why(e)}), so no ambiguous pre-v3 prefix could be cleared`,
    );
  }

  const claimed: string[] = [];
  const contested: string[] = [];
  for (const name of skipped) {
    if (!corroborated || live.has(name)) {
      contested.push(name);
      continue;
    }
    if (agents.includes(name)) claimed.push(`${AGENT_PARAM_ROOT}${name}/`);
    const layout = `${HERMETIC_PARAM_ROOT}${name}/`;
    if (LEGACY_FLEET_LAYOUTS.includes(layout)) claimed.push(layout);
  }
  if (contested.length > 0) {
    throw new HermeticError(
      "FOUNDATION_UPDATE_FAILED",
      `${contested.length} pre-v3 prefix(es) could not be shown to be this fleet's: ${contested
        .map(
          (name) =>
            `"${name}" is an agent in this fleet and also a fleet this account still answers for, so ${AGENT_PARAM_ROOT}${name}/ may hold either fleet's parameters`,
        )
        .join(
          "; ",
        )}. Nothing was copied and the stack was not changed. Fill this agent's fleet-scoped slots by hand with \`hermetic secrets push ${contested[0]}\` and run \`hermetic foundation update\` again — a destination that already holds a value is kept, never overwritten`,
      { contested: contested.length },
    );
  }
  if (claimed.length > 0) {
    deps.notes.push(
      `${claimed.length} pre-v3 prefix(es) named after a fleet id this account once listed are this fleet's own: no live fleet and no stack answers to ${skipped
        .map((n) => `"${n}"`)
        .join(", ")}`,
    );
  }
  return claimed;
}

/**
 * Whether the value written a moment ago is really in the destination slot.
 *
 * Two ways to get this wrong, and the first one shipped. An *absent* parameter
 * is not a placeholder — `SsmSecrets.isPlaceholder` reads it, gets nothing back
 * and answers `false` — so `!isPlaceholder` alone calls a write that never
 * landed at all a finished copy, which is the exact reading this whole step
 * exists to stop. Existence is asked first, and separately.
 *
 * The second is the other direction: `PutParameter` is not read-your-writes, so
 * a slot that *does* hold the value can still read back as the placeholder for
 * a moment. That was harmless while nothing read the slot back; now that the
 * answer fails the whole update, a stale read has to be retried before it is
 * believed. Short and bounded — this is a consistency lag, not an outage, and
 * an outage must still fail rather than be waited out.
 *
 * Nothing read here leaves the function: `isPlaceholder` compares and discards
 * (§8.3).
 */
async function verifyCopyLanded(
  deps: FoundationMigrationDeps,
  target: string,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
): Promise<boolean> {
  for (let attempt = 0; ; attempt += 1) {
    if (
      (await deps.backend.secrets.exists(target)) &&
      !(await deps.backend.secrets.isPlaceholder(target))
    ) {
      return true;
    }
    const wait = VERIFY_BACKOFF_MS[attempt];
    if (wait === undefined || deps.signal?.aborted) return false;
    await sleep(wait, deps.signal);
  }
}

/**
 * Where a legacy path moves to. `null` for anything that is not under one of the
 * two roots — a path this migration has no opinion about, and therefore must
 * not rewrite.
 */
function scopedPathFor(fleetId: string, path: string): string | null {
  if (path.startsWith(AGENT_PARAM_ROOT)) {
    return `${agentParamPrefix(fleetId)}${path.slice(AGENT_PARAM_ROOT.length)}`;
  }
  if (path.startsWith(HERMETIC_PARAM_ROOT)) {
    return `${hermeticParamPrefix(fleetId)}${path.slice(HERMETIC_PARAM_ROOT.length)}`;
  }
  return null;
}

function why(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Every migration a fleet on `from` needs to reach `to`, in order. Exclusive of
 * `from` and inclusive of `to`, which is what makes "already up to date" an
 * empty list rather than a re-run of the last entry.
 */
export function migrationsBetween(
  from: number,
  to: number,
  /**
   * The list to draw from. Defaults to the real one; `foundation.ts` passes
   * `deps.migrations` so a test can hand in throwaway entries with hooks and
   * exercise the re-run contract above — the shipped list has never had a hook,
   * so without this the promise those hooks make is untested.
   */
  migrations: ReadonlyArray<FoundationMigration> = FOUNDATION_MIGRATIONS,
): FoundationMigration[] {
  return migrations
    .filter((m) => m.version > from && m.version <= to)
    .sort((a, b) => a.version - b.version);
}
