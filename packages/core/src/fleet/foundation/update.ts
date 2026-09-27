/**
 * `foundation.update` (§6.6): the phases in the order that is the safety
 * property —
 *
 *   preflight → archive → stack → artifacts → migrate → rollout → done
 *
 * — with the stamp, the stack step and the migration glue beside the sequence
 * that calls them. `release.ts` and `rollout.ts` hold the two phases long
 * enough to be their own modules.
 */
import { randomUUID } from "node:crypto";
import { FLEET_KEY, FoundationUpdateInput as FoundationUpdateInputSchema } from "../../schema/index.ts";
import type { FleetItem, FoundationUpdateInput, OpEvent } from "../../schema/index.ts";
import { bedrockModelArns } from "../../aws/index.ts";
import { HermeticError } from "../../errors.ts";
import type { FleetExpectation, StackInfo } from "../../backend/types.ts";
import { assertPublishableTree } from "../../release/artifacts.ts";
import { expectationOf, fleetLockKeeper, lockActivity } from "../fleet-lock.ts";
import { runChangeSet } from "../stack-change.ts";
import { backfillNetworkMode, migrationsBetween } from "../foundation-migrations.ts";
import { HERMETIC_VERSION } from "../../version.ts";
import { PHASE, foundationHelpers, type FoundationCtx } from "./shared.ts";
import { checkAbort } from "../../abort.ts";
import { evt } from "../../events.ts";
import type { createChangeSet } from "./change-set.ts";
import type { createRelease } from "./release.ts";
import type { createRollout } from "./rollout.ts";

export function createUpdate(
  ctx: FoundationCtx,
  phases: {
    changeSet: ReturnType<typeof createChangeSet>;
    release: ReturnType<typeof createRelease>;
    rollout: ReturnType<typeof createRollout>;
  },
) {
  const { deps, core, backend, hermeticdVersion, nowIso, now, versionOf, lockIsLive } = ctx;
  const { foundationVersion, templateSha256, lockTtlMs } = ctx;
  const { archive, fleetLock } = ctx;
  const { acquire, withLock, writeLocked, renew, release } = fleetLock;
  const { stackDeps, bedrockGrant, createUpdateChangeSet, changeSetName } = phases.changeSet;
  const { pushAndPrune } = phases.release;
  const { rollout } = phases.rollout;
  const { newerError, blockingAgents } = foundationHelpers(ctx);

  // ─── foundation.update ─────────────────────────────────────────────────────

  async function* update(
    input: FoundationUpdateInput = {},
    opts: { signal?: AbortSignal; opId?: string } = {},
  ): AsyncIterable<OpEvent> {
    const parsed = FoundationUpdateInputSchema.parse(input);
    const owner = `${await core.actor()}#${opts.opId ?? randomUUID()}`;

    // ── preflight ───────────────────────────────────────────────────────────
    yield evt(
      "preflight",
      PHASE.preflight[0],
      "checking this checkout, the account, the fleet and every agent",
      nowIso(),
      undefined,
      "start",
    );
    /**
     * §3.6's clean-tree rule, asked here rather than only where the release is
     * pushed.
     *
     * `releaseFiles` asks too, and refuses identically — but it is reached in
     * the `artifacts` phase, about 60% of the way in, by which point this
     * operation has taken the fleet lock, written an archive of the fleet's
     * state to S3, and computed *and executed* a CloudFormation change set. The
     * refusal was correct and the answer never changed: the tree was already
     * dirty before the first byte moved. Paying for an archive and a stack
     * update to learn it left the fleet on a new template with no release to
     * match, which `foundation status` then reports as an update still
     * available — recoverable by re-running, but only after committing, and
     * only if the operator reads far enough to see which phase failed.
     *
     * First statement in the operation, before `guardFleet` and therefore
     * before any network call at all: this is a fact about the local checkout,
     * it is knowable for free, and nothing later can make it less true. The
     * same resolution the push uses (`assertPublishableTree`), so the two
     * cannot disagree — including in fixture mode, where both read `null` and
     * neither ever refuses.
     */
    assertPublishableTree(core.publishDeps());
    const { config: frozen, fleet: found, stack: guarded } = await core.guardFleet();
    const from = versionOf(found);
    if (from > foundationVersion) throw newerError(found);
    if (lockIsLive(found, owner)) {
      throw new HermeticError(
        "LOCKED",
        // Not always another foundation update: §8.3's profile writes take the
        // same lock, and the owner string says which (`fleet-lock.ts`).
        `${found.lock === undefined || found.lock === null ? "a foundation update is in progress" : lockActivity(found.lock.owner)} — the ${FLEET_KEY} lock is held by ${found.lock?.owner ?? "another operator"} until ${found.lock?.expires}`,
        { owner: found.lock?.owner ?? null, expires: found.lock?.expires ?? null },
      );
    }
    const agents = (await backend.store.agents.scan()).filter((a) => a.status !== "destroyed");
    const blocking = blockingAgents(agents);
    if (blocking.length > 0) {
      throw new HermeticError(
        "CONFLICT",
        `a foundation update rewrites the stack, the release and every agent row, so it cannot start while an agent is mid-operation: ${blocking.join("; ")}`,
        { agents: blocking },
      );
    }

    /**
     * Take the lock first, then read. The lock is taken by writing the `lock`
     * attribute alone, so it needs no copy of the item and can revert nothing;
     * and once it is held, nothing else may write `_fleet` — every content
     * write on this row is conditional on the lock being free. So a read taken
     * *after* the take is the last word, where the read `guardFleet()` did
     * several awaits ago (an agent scan sits between them) is only a guess.
     *
     * That matters because of what the read is now for: the revision the
     * commit point is written against. The checks above still stand on `found`;
     * only the counters carried forward from here have to be current.
     */
    if (!(await acquire(owner))) {
      throw new HermeticError(
        "LOCKED",
        `another operator took the ${FLEET_KEY} lock first; try again once their foundation update finishes`,
        {},
      );
    }
    let current: FleetItem = withLock((await backend.store.fleet.get()) ?? found, owner);
    /**
     * Never recomputed after this line: the phases below patch `current` — a
     * migration may seed `settings`, the Bedrock grant is recorded — and the
     * question the stamp asks is not "is my copy self-consistent" but "did
     * anybody else write `_fleet` while I was gone".
     */
    const at = expectationOf(current);
    let released = false;
    /**
     * §4.4: push the expiry out once the lock is a third of its life old, and
     * not once per poll. Renewing only *between* phases was the bug — a stack
     * update, a large archive or a slow push can each outlast the ten-minute
     * TTL on their own, at which point the lock this run believes it holds is
     * free for anyone to take while it is still mid-flight. The rule lives in
     * `fleet-lock.ts` because `apply` kind `network` needs exactly the same one.
     */
    const keepLock = fleetLockKeeper(
      fleetLock,
      lockTtlMs,
      () => current,
      (next) => {
        current = next;
      },
      owner,
    );
    /**
     * The lock is released in `finally` whatever happens — including an abort,
     * which is the case that would otherwise leave a fleet locked for the whole
     * TTL because somebody closed a browser tab (§4.4).
     */
    try {
      /**
       * §4.4, the second half of the agent check: the scan above ran *before*
       * this run held the fleet lock, so an `agents.create` could pass
       * `assertFleetUnlocked`, claim a row and start launching a box in the gap
       * between the two. Asking again now that the door is shut is the only
       * reading that means anything — and a `no` here is a refusal, not a
       * failure, so the lock goes back (the `finally` below releases it) and
       * nothing has been touched.
       */
      const racing = blockingAgents(
        (await backend.store.agents.scan()).filter((a) => a.status !== "destroyed"),
      );
      if (racing.length > 0) {
        throw new HermeticError(
          "CONFLICT",
          `an agent operation started while this update was taking the ${FLEET_KEY} lock, so the update cannot go on: ${racing.join("; ")}`,
          { agents: racing },
        );
      }
      yield evt(
        "preflight",
        PHASE.preflight[1],
        `foundation v${from} → v${foundationVersion}, hermeticd ${current.min_hermetic_version} → ${hermeticdVersion}; took the ${FLEET_KEY} lock`,
        nowIso(),
        undefined,
        "done",
      );

      // ── archive ───────────────────────────────────────────────────────────
      checkAbort(opts.signal, "archive");
      current = await renew(current, owner);
      yield* archive({
        fleetId: current.fleet_id,
        version: from,
        actor: await core.actor(),
        from: PHASE.archive[0],
        to: PHASE.archive[1],
        heartbeat: keepLock,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });

      /**
       * ── pre-stack migration steps ──────────────────────────────────────────
       *
       * §6.6: the half of a migration that has to happen *before* the template
       * lands. v3's is the copy of every parameter under the fleet-scoped
       * prefix, because the same template narrows the agent role to that
       * prefix — do them the other way round and there is a window in which the
       * role can read only an empty namespace. Emitted under the `archive`
       * phase's progress, which is where they sit in the bar.
       */
      checkAbort(opts.signal, "archive");
      current = await renew(current, owner);
      current = yield* runMigrationsBefore(current, from, keepLock, opts.signal);

      // ── stack ─────────────────────────────────────────────────────────────
      checkAbort(opts.signal, "stack");
      current = await renew(current, owner);
      /**
       * §8.3: the grant this fleet needs, computed before the change set and
       * recorded on `_fleet` after it. Stated on the change set rather than
       * carried forward, which is the whole of v10 — a Bedrock profile naming a
       * model outside the `init`-time list was otherwise unusable forever.
       */
      const bedrockIds = await bedrockGrant(current);
      const stack = yield* updateStack(
        guarded,
        keepLock,
        bedrockModelArns(current.region, frozen.account_id, bedrockIds),
        opts.signal,
      );
      const grantedBefore = current.bedrock_model_ids ?? [];
      current.bedrock_model_ids = bedrockIds;
      const newlyGranted = bedrockIds.filter((id) => !grantedBefore.includes(id));
      yield evt(
        "stack",
        PHASE.stack[1],
        newlyGranted.length === 0
          ? `the fleet's Bedrock grant is unchanged: ${bedrockIds.length} model(s)`
          : `granted ${newlyGranted.length} further Bedrock model(s): ${newlyGranted.join(", ")}`,
        nowIso(),
      );

      // ── artifacts ─────────────────────────────────────────────────────────
      checkAbort(opts.signal, "artifacts");
      current = await renew(current, owner);
      const targetSha256 = yield* pushAndPrune(current, stack, keepLock);

      // ── migrate ───────────────────────────────────────────────────────────
      checkAbort(opts.signal, "migrate");
      // The migrations may patch the item itself (v2 seeds `settings`), and
      // the stamp below rewrites `_fleet` from this copy — so the patched copy
      // is what it has to be handed, or the seed is written and immediately
      // overwritten by the commit point.
      current = yield* runMigrations(current, from, keepLock, opts.signal);
      current = yield* reconcileNetworkMode(current, opts.signal);
      current = await stamp(current, owner, at);
      yield evt(
        "migrate",
        PHASE.migrate[1],
        `${FLEET_KEY} now records foundation v${foundationVersion} (template ${templateSha256().slice(0, 12)}…) and hermeticd ${hermeticdVersion}`,
        nowIso(),
        undefined,
        "done",
      );

      /**
       * §4.8: the directory carries each fleet's `foundation_version` so a head
       * can flag the fleets that are behind without opening any of them. It is
       * an *index*, though, and `_fleet` is the commit point — so a directory
       * that cannot be written is a warning on this op, never a failure of it.
       * The next `init --attach`, `foundation update` or `doctor` says the same
       * thing again, and `doctor` reports the disagreement explicitly.
       */
      yield* recordDirectoryVersion(frozen.fleet_id, current);

      // ── rollout ───────────────────────────────────────────────────────────
      yield* rollout(targetSha256, keepLock, parsed.rollout_wait_ms, opts.signal);

      // ── done ──────────────────────────────────────────────────────────────
      await core.appendEvent(
        FLEET_KEY,
        "foundation.update",
        `foundation v${from} → v${foundationVersion}; hermeticd ${found.min_hermetic_version} → ${hermeticdVersion}`,
      );
      current = await release(current, owner);
      released = true;
      yield evt(
        "done",
        1,
        `the foundation is on v${foundationVersion} and the fleet manifest names hermeticd ${hermeticdVersion}`,
        nowIso(),
      );
    } finally {
      if (!released) {
        // Best effort, and silent: the error on its way out is the one worth
        // reading, and a lock left behind expires on its own (§4.4).
        try {
          const latest = await backend.store.fleet.get();
          if (latest?.lock?.owner === owner) await release(latest, owner);
        } catch {
          /* the caller's error is the one that matters */
        }
      }
    }
  }

  // ─── the phases ────────────────────────────────────────────────────────────
  /**
   * §4.8's half of the commit: the directory's copy of `foundation_version`.
   * Best effort by construction — it is written *after* the stamp, so a failure
   * here leaves a fleet that is correctly updated and an index that is one
   * version stale, which `doctor` names and the next update fixes.
   */
  async function* recordDirectoryVersion(fleetId: string, fleet: FleetItem): AsyncIterable<OpEvent> {
    try {
      const entry = await backend.directory.get(fleetId);
      if (!entry) {
        yield evt(
          "migrate",
          PHASE.migrate[1],
          `the fleet directory has no entry for ${fleetId}; run \`hermetic init --attach --fleet ${fleetId}\` to register this fleet`,
          nowIso(),
          "warn",
        );
        return;
      }
      await backend.directory.update({
        ...entry,
        foundation_version: foundationVersion,
        hermetic_version: HERMETIC_VERSION,
        tailnet: fleet.tailnet ?? entry.tailnet,
        updated_at: nowIso(),
        updated_by: await core.actor(),
      });
    } catch (e) {
      yield evt(
        "migrate",
        PHASE.migrate[1],
        `the fleet directory still records the old foundation version for "${name}": ${e instanceof Error ? e.message : String(e)}`,
        nowIso(),
        "warn",
      );
    }
  }

  /**
   * The commit point (§6.6 step 5): everything before it is re-runnable,
   * nothing after it is undone.
   *
   * `expect` is the revision the run took the lock at, so this replacement
   * refuses rather than reverting a write that landed while the lock had
   * lapsed. It is the caller's to supply — two updates running against two
   * fleets share this closure, and a watermark kept here would be the wrong
   * one for one of them.
   */
  async function stamp(fleet: FleetItem, owner: string, expect: FleetExpectation): Promise<FleetItem> {
    const next: FleetItem = {
      ...fleet,
      foundation_version: foundationVersion,
      foundation_template_sha256: templateSha256(),
      min_hermetic_version: hermeticdVersion,
      foundation_updated_at: nowIso(),
      foundation_updated_by: await core.actor(),
      lock: { owner, expires: new Date(now().getTime() + lockTtlMs).toISOString() },
    };
    return writeLocked(next, owner, "stamping the foundation version", expect);
  }

  /**
   * §6.6 step 3, through the shared choreography in `stack-change.ts`: compute,
   * inspect, execute, narrate — and delete any change set that will not be run.
   */
  function updateStack(
    guarded: StackInfo,
    keepLock: () => Promise<void>,
    bedrockModelArns: readonly string[],
    signal?: AbortSignal,
  ): AsyncGenerator<OpEvent, StackInfo> {
    const name = changeSetName(foundationVersion);
    return runChangeSet(stackDeps, {
      guarded,
      name,
      create: createUpdateChangeSet(name, bedrockModelArns),
      phase: "stack",
      errorCode: "FOUNDATION_UPDATE_FAILED",
      from: PHASE.stack[0],
      to: PHASE.stack[1],
      verb: "updating",
      keepLock,
      ...(signal ? { signal } : {}),
      noChangesMessage: `stack already at this template; ${guarded.stack_name} unchanged`,
    });
  }

  /** §6.6 step 5, minus the stamp: every migration `old < version <= new`, in order. */
  /**
   * The `before` half of every pending migration, run before CloudFormation is
   * asked for anything. Same shape as `runMigrations` below — every note
   * yielded — and it may patch `deps.fleet` too, so the patched copy is
   * threaded on rather than dropped.
   *
   * `keepLock` goes in with the rest (§4.4). A hook is not a phase boundary but
   * it takes phase-sized time — v3's copy is two round trips per slot over
   * however many slots the fleet has — so renewing only on either side of it
   * lets the lock lapse mid-hook, which is the bug `fleetLockKeeper` was
   * written for in the first place.
   */
  async function* runMigrationsBefore(
    fleet: FleetItem,
    from: number,
    keepLock: () => Promise<void>,
    signal?: AbortSignal,
  ): AsyncGenerator<OpEvent, FleetItem> {
    const pending = migrationsBetween(from, foundationVersion, deps.migrations).filter(
      (m) => m.before !== undefined,
    );
    for (const migration of pending) {
      checkAbort(signal, "archive");
      const notes: string[] = [];
      /**
       * Best effort unless the entry says the stack change depends on it
       * (`beforeRequired`, §6.6). For an optional step the old reasoning holds:
       * the template has not been touched yet, so an update that carries on
       * lands a consistent foundation whose leftover state the *next*
       * `foundation update` (or `doctor`) will report and re-attempt — where a
       * throw would leave the operator with a half-run op and nothing to re-run
       * it with.
       *
       * A *required* step is the case that reasoning does not cover. Its
       * leftover state is not something a later run picks up, because carrying
       * on reaches the stamp, and the stamp takes this entry out of every
       * future `migrationsBetween` — the update would apply a template that
       * assumes the step finished and then record the version that says it did.
       * So the failure is held until its notes have been said and then thrown,
       * before the change set is computed.
       */
      let required: HermeticError | null = null;
      try {
        await migration.before?.({
          backend,
          fleet,
          actor: await core.actor(),
          nowIso,
          notes,
          heartbeat: keepLock,
          ...(signal ? { signal } : {}),
        });
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        if (migration.beforeRequired) {
          required = new HermeticError(
            e instanceof HermeticError ? e.code : "FOUNDATION_UPDATE_FAILED",
            `v${migration.version} (pre-stack) did not finish: ${why} — the stack was not changed and ${FLEET_KEY} still records v${from}; fix the cause and run \`hermetic foundation update\` again`,
            { version: migration.version, step: "before" },
          );
        } else {
          notes.push(
            `did not finish: ${why} — the stack update continues, and the next \`hermetic foundation update\` re-runs it`,
          );
        }
      }
      for (const note of notes) {
        yield evt(
          "archive",
          PHASE.archive[1],
          `v${migration.version} (pre-stack): ${note}`,
          nowIso(),
          note.startsWith("did not finish") ? "warn" : undefined,
        );
      }
      if (required) {
        yield evt("archive", PHASE.archive[1], required.message, nowIso(), "error");
        throw required;
      }
    }
    return fleet;
  }

  async function* runMigrations(
    fleet: FleetItem,
    from: number,
    keepLock: () => Promise<void>,
    signal?: AbortSignal,
  ): AsyncGenerator<OpEvent, FleetItem> {
    const migrations = migrationsBetween(from, foundationVersion, deps.migrations);
    yield evt(
      "migrate",
      PHASE.migrate[0],
      migrations.length === 0
        ? `no migrations between v${from} and v${foundationVersion}`
        : `running ${migrations.length} migration(s)`,
      nowIso(),
      undefined,
      "start",
    );
    for (const migration of migrations) {
      checkAbort(signal, "migrate");
      // Each hook's own account of what it did, yielded before the one-line
      // `describe`: a best-effort step that skipped something has to be able to
      // say so, and core says it rather than printing it (rule 1).
      const notes: string[] = [];
      await migration.remote?.({
        backend,
        fleet,
        actor: await core.actor(),
        nowIso,
        notes,
        heartbeat: keepLock,
        ...(signal ? { signal } : {}),
      });
      for (const note of notes) {
        yield evt("migrate", PHASE.migrate[0] + 0.02, `v${migration.version}: ${note}`, nowIso());
      }
      if (migration.local) {
        if (deps.localDb) migration.local(deps.localDb);
        else {
          yield evt(
            "migrate",
            PHASE.migrate[0],
            `v${migration.version} has a local migration but this session has no local database; it will run on the next real-mode update`,
            nowIso(),
            "warn",
          );
        }
      }
      yield evt(
        "migrate",
        PHASE.migrate[0] + 0.02,
        `v${migration.version}: ${migration.describe}`,
        nowIso(),
      );
    }
    // The same object the hooks were handed, patches and all (see
    // `FoundationMigrationDeps.fleet`). Returned rather than left to the
    // caller's own reference so the coupling is stated in the signature.
    return fleet;
  }

  /**
   * Reconcile `_fleet.network` with the stack's own `Network` parameter, on
   * every update rather than only on the v5 → v6 crossing (§5).
   *
   * The v6 migration hook does this for a fleet coming *from* an earlier
   * version, and that is all a migration list can do: `migrationsBetween(6, 6)`
   * is empty, so a fleet already at v6 whose cache had drifted was stuck. It
   * could not be fixed by `foundation update`, because the hook never ran, and
   * it could not be fixed by `plan network --to <the stack's mode>`, because
   * that refuses a mode the fleet is already in. `doctor` said so on every run
   * and named a command that did nothing.
   *
   * Run here, right before the commit point, an update of any kind — including
   * a same-version re-run, which this operation has always allowed — puts the
   * cache back in agreement. Idempotent, one `DescribeStacks`, and it patches
   * the copy `stamp` is about to write for the same reason the hooks do.
   */
  async function* reconcileNetworkMode(
    fleet: FleetItem,
    signal?: AbortSignal,
  ): AsyncGenerator<OpEvent, FleetItem> {
    const notes: string[] = [];
    await backfillNetworkMode({
      backend,
      fleet,
      actor: await core.actor(),
      nowIso,
      notes,
      ...(signal ? { signal } : {}),
    });
    for (const note of notes) {
      yield evt("migrate", PHASE.migrate[0] + 0.03, `network mode: ${note}`, nowIso());
    }
    return fleet;
  }

  return { update };
}
