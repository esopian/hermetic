/**
 * `agents.destroy` (§6.6, §6.7): terminate the instance, sweep the tailnet, the
 * SSM prefix and the config prefix, delete the data volume (unless
 * `keep_volume`), wait for the instance to be `terminated`, and release the
 * name — tombstone written, agent row deleted (`lifecycle/release-name.ts`).
 * Afterwards only the per-name events and the tombstone hold the name, and a
 * `create` of it starts a brand-new agent.
 *
 * It sits beside `lifecycle.ts` rather than in it for the reason that file's own
 * header gives: a file nobody can hold in their head is a file nobody reviews,
 * and the 2500-line cap is the mechanical statement of that. `destroy` is the
 * cleanest thing to lift out because it shares no closure state with the other
 * four lifecycle operations — it reads the row, takes the lock and works from
 * there, exactly as it did while it lived one scope up.
 *
 * `DestroyDeps` is the honest list of what it needs from the SDK closure. Same
 * shape as `LifecycleDeps` (`lifecycle.ts`), `PowerDeps` (`power.ts`),
 * `TeardownDeps` (`teardown.ts`) and `PlanDeps` (`plans.ts`).
 */
import { randomUUID } from "node:crypto";
import { DestroyAgentInput as DestroyAgentInputSchema } from "../schema/index.ts";
import type { DestroyAgentInput, OpEvent } from "../schema/index.ts";
import { HermeticError, hasCode } from "../errors.ts";
import { assertOwnedInstance, assertOwnedVolume } from "./ownership.ts";
import { assertUnmoved, type ExpectedResources } from "./plan-expectations.ts";
import { waitInstanceTerminated, waitVolumeReleased } from "./attach.ts";
import { createReleaseName, type ReleaseResult } from "./lifecycle/release-name.ts";
import { abandoned, checkAbort } from "../abort.ts";
import { evt } from "../events.ts";
import { createTailnetCleanup } from "../fleet/tailnet-devices.ts";
import type { OpOptions } from "../hermetic.ts";
import type { CoreContext } from "../context.ts";

/** `destroy` needs the shared context, and the release's optional local purge. */
export interface DestroyDeps {
  ctx: CoreContext;
  /** See `ReleaseNameDeps.purgeLocal`. */
  purgeLocal?: ((fleetId: string, name: string) => Promise<void>) | undefined;
}

export function createDestroy(deps: DestroyDeps) {
  const {
    acquireLock,
    actor,
    agentPrefix,
    attachDeps,
    backend,
    configPrefix,
    getAgent,
    guardFleet,
    lockKeeper,
    nowIso,
    releaseLock,
    transition,
    unwind,
  } = deps.ctx;

  const { removeTailnetDevices } = createTailnetCleanup(deps.ctx);
  const { releaseName, existingTombstone } = createReleaseName({
    ctx: deps.ctx,
    purgeLocal: deps.purgeLocal,
  });

  /** The release's own events: what became of a kept volume, and a failed local purge. */
  function* released(result: ReleaseResult, name: string): Generator<OpEvent> {
    const volumeId = result.tombstone.volume_id;
    if (result.volume === "released") {
      yield evt(
        "release",
        0.95,
        `kept data volume ${volumeId}, released from the name (tagged former_agent=${name}); adopt it with agent create <name> --volume ${volumeId}`,
        nowIso(),
      );
    } else if (result.volume === "gone") {
      yield evt("release", 0.95, `data volume ${volumeId} no longer exists`, nowIso());
    } else if (result.volume === "foreign") {
      yield evt(
        "release",
        0.95,
        `data volume ${volumeId} now belongs to someone else; left untouched`,
        nowIso(),
        "warn",
      );
    }
    yield evt("release", 0.97, `tombstone written; the name ${name} is free`, nowIso());
    if (result.localPurgeError !== null) {
      yield evt(
        "release",
        0.98,
        `could not clear this machine's local state for ${name}; it is stale, not load-bearing`,
        nowIso(),
        "warn",
      );
    }
  }

  async function* destroy(
    input: DestroyAgentInput,
    opts: OpOptions = {},
    /**
     * What the reviewed plan promised, when this destroy is an `apply` of one
     * (§6.7). A direct `agent destroy --yes` passes nothing and is unchanged:
     * there is no document to be stale, so there is nothing to compare against.
     */
    expected?: ExpectedResources,
  ): AsyncIterable<OpEvent> {
    const parsed = DestroyAgentInputSchema.parse(input);
    if (!parsed.yes) {
      throw new HermeticError(
        "CONFIRMATION_REQUIRED",
        `destroying ${parsed.name} is irreversible; pass --yes`,
        { name: parsed.name },
      );
    }
    const { fleet } = await guardFleet();
    let agent = await getAgent(parsed.name);
    const who = await actor();
    const owner = `${who}#${randomUUID()}`;

    /**
     * A `destroyed` row is a legacy one: destroys before tombstones kept the
     * row forever and so held the name forever. Its box and prefixes are long
     * gone; all that is left to do is the release — under the lock, like any
     * other write. Its volume, when the row still names one, was kept by that
     * destroy and is released from the name here, never deleted: nobody asked
     * this run to delete a disk an earlier run promised to keep.
     */
    const legacy = agent.status === "destroyed";

    agent = await acquireLock(agent, owner);
    if (expected) {
      /**
       * Before the row moves and before anything is read off it: the lock is
       * ours, so this is the first moment the answer cannot go stale between
       * the asking and the acting. A refusal gives the lock straight back —
       * this run has done nothing, and leaving a ten-minute lock on an agent
       * nobody destroyed would make a stale plan cost the next operator a wait.
       */
      try {
        assertUnmoved(agent, expected);
      } catch (e) {
        await releaseLock(agent);
        throw e;
      }
    }
    const keepLock = lockKeeper(
      () => agent,
      (a) => {
        agent = a;
      },
      owner,
    );
    /** See `abandoned`. */
    let done = false;
    let failure: unknown = null;
    try {
      checkAbort(opts.signal, "destroy");
      if (legacy) {
        const legacyVolume = agent.resources.volume_id ?? agent.volume_id ?? null;
        const result = await releaseName(agent, {
          volumeKept: legacyVolume !== null,
          actor: who,
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        // The row is gone, and the lock with it: nothing to release, nothing
        // for `unwind` to find.
        done = true;
        yield* released(result, parsed.name);
        yield evt("done", 1, `${parsed.name} released (destroyed before tombstones existed)`, nowIso());
        return;
      }
      /**
       * §6.7, before the row moves and before anything is terminated: the two
       * ids below come off the agent row, and the agent row is writable by the
       * box it describes. Each is resolved and its tags checked to say it is
       * this agent's, in this fleet, and hermetic's. A refusal costs two
       * describes and leaves the row exactly as it was found; trusting the ids
       * would let a compromised box redirect this destroy at another fleet's
       * instance, or at a disk nobody meant to lose (`ownership.ts`).
       */
      const instanceId = agent.resources.instance_id ?? agent.instance_id;
      const volumeId = agent.resources.volume_id ?? agent.volume_id;
      const owned = { fleet_id: fleet.fleet_id, agent: agent.name };
      /**
       * A retry of a destroy that crashed between its tombstone and its delete
       * (`release-name.ts`) finds the tombstone for this incarnation. The
       * tombstone decides one thing only: the volume, and only towards keeping
       * it. A prior `volume_kept: true` is what the first run acted on — the
       * disk may already be retagged off the name — so it keeps the volume
       * even when this run's flag did not ask. A prior `volume_kept: false`
       * never overrides `--keep-volume`: the tombstone may be forged by the box
       * or matched by a `created_at` collision, and a record nobody can vouch
       * for must not be what deletes a disk the operator asked to keep. On a
       * delete, a disk that now fails the ownership check (gone to another
       * agent since) is left alone rather than wedging the retry and holding
       * the name.
       *
       * Everything else runs again, every step idempotent: the events table is
       * writable by the boxes (the instance role may put any item in it), so a
       * tombstone is not proof that the box is gone. A compromised box that
       * planted one for its own row must still be terminated, swept and
       * stripped of its secrets before the name is released.
       */
      const prior = await existingTombstone(agent);
      const keepVolume = !!parsed.keep_volume || (prior?.volume_kept ?? false);
      const live = instanceId ? await assertOwnedInstance(backend.compute, owned, instanceId) : null;
      let volumeNotOwned = false;
      if (!keepVolume && volumeId) {
        try {
          await assertOwnedVolume(backend.compute, owned, volumeId);
        } catch (e) {
          if (!prior || !hasCode(e, "RESOURCE_NOT_OWNED")) throw e;
          volumeNotOwned = true;
        }
      }
      if (prior) {
        yield evt(
          "destroy",
          0.1,
          `a previous destroy of ${agent.name} already wrote its tombstone; re-running every step before the release`,
          nowIso(),
        );
      }

      // Re-entrant: a retry of a destroy that died partway finds the row already
      // in `destroying` and carries on from whichever step is still undone.
      agent = await transition(agent, "destroying", "destroy requested");
      /**
       * §4.5's resync can hand back a row this run did not read: asked for a
       * status the store already holds, the transition adopts the store's row
       * as its picture. That row is another operator's account of the same
       * agent, and it may name other resources than the plan did — so the
       * comparison is made again over whatever the adoption brought in, before
       * the first terminate. The steps below still work from the ids read
       * before the transition, which is exactly why the adopted row has to
       * agree with them.
       */
      if (expected) assertUnmoved(agent, expected);

      /**
       * The steps below are exactly `plan.destroy`'s, in order, one at a
       * time — the tailnet cleanup included, since a device that keeps the
       * agent's name is a record the operator would otherwise have to remove by
       * hand in the admin console (§6.7). Each one
       * asks reality what is left to do before doing it (§4.5), so running this
       * twice costs a few describes and changes nothing the first run already
       * finished.
       */
      if (!instanceId) {
        yield evt("instance", 0.2, "no instance on the agent row; nothing to terminate", nowIso());
      } else {
        if (!live || live.state === "terminated") {
          yield evt(
            "instance",
            0.2,
            `instance ${instanceId} is already ${live?.state ?? "gone"}`,
            nowIso(),
          );
        } else {
          await backend.compute.terminate(instanceId);
          yield evt("instance", 0.2, `terminating instance ${instanceId}`, nowIso());
        }
      }

      /**
       * Any other box still tagged for this agent — a launch whose id was never
       * persisted, two recreates that raced (`doctor`'s `instance_duplicate`).
       * The row names one instance; the name is held by all of them. A stray
       * left running would be adopted by the next `create` of this name
       * (`liveTagged`) and its hermeticd would heartbeat into the new row, so
       * each is terminated and waited on below exactly as the row's own
       * instance is — the sweep `recreate` makes before it launches.
       *
       * No per-stray ownership describe: unlike the row's ids, which the box
       * can write, this list comes from EC2 filtered on exactly the tags an
       * ownership check reads (`agent`, `hermetic:managed`, the fleet id), so a
       * second describe would ask the same question twice. It lists only
       * `pending`/`running`/`stopping`/`stopped` boxes: a stray already
       * `shutting-down` when a crashed destroy is retried is not waited on.
       * That gap is accepted — its hermeticd's writes are all conditional on
       * the row existing, and one that lands first moves the version, so the
       * conditional delete refuses with CONFLICT and the next retry heals it.
       */
      const strays: string[] = [];
      for (const stray of await backend.compute.listInstancesByTag(agent.name)) {
        if (stray.instance_id === instanceId) continue;
        strays.push(stray.instance_id);
        await backend.compute.terminate(stray.instance_id);
        yield evt(
          "instance",
          0.22,
          `instance ${stray.instance_id} is also tagged for ${agent.name}; terminating it`,
          nowIso(),
          "warn",
        );
      }

      /**
       * The terminate above has been accepted, which is all this needs — the
       * device is the node's, not the volume's, so it is cleaned up here rather
       * than after the (possibly long) wait for the volume to come free. An agent
       * created under this name later then gets the name, instead of `<name>-2`.
       */
      checkAbort(opts.signal, "tailnet");
      /**
       * §4.4: every one of the steps below is a round trip to a different API,
       * and the tailnet call in particular waits on an HTTP request to somebody
       * else's service. `create` heartbeats between its steps for exactly this
       * reason; a destroy that heartbeat once and then spent longer than
       * `LOCK_TTL_MS` sweeping prefixes would silently unlock itself while still
       * deleting things.
       */
      await keepLock();
      yield* removeTailnetDevices(
        agent.name,
        fleet.fleet_id,
        agent.tailscale_dns_name ?? null,
        "tailnet",
        0.3,
        opts,
      );

      checkAbort(opts.signal, "secrets");
      await keepLock();
      const removedParams = await backend.secrets.deleteByPrefix(agentPrefix(agent.name));
      yield evt("secrets", 0.45, `removed ${removedParams.length} SSM parameter(s)`, nowIso());

      checkAbort(opts.signal, "config");
      await keepLock();
      const removedObjects = await backend.artifacts.deleteByPrefix(configPrefix(agent.name));
      yield evt("config", 0.6, `removed ${removedObjects.length} config object(s)`, nowIso());

      /**
       * §6.7: the data volume goes with the agent by default — a destroyed
       * agent releases everything but its history. `--keep-volume` keeps it,
       * and the release below moves it off the name (`former_agent`), so a
       * later `create` of this name starts on a fresh disk.
       */
      checkAbort(opts.signal, "volume");
      await keepLock();
      if (keepVolume) {
        yield evt(
          "volume",
          0.8,
          `keeping data volume ${volumeId ?? "(none)"}; it is released from the name below`,
          nowIso(),
        );
      } else if (!volumeId) {
        yield evt("volume", 0.8, "no data volume on the agent row; nothing to delete", nowIso());
      } else if (volumeNotOwned) {
        yield evt(
          "volume",
          0.8,
          `data volume ${volumeId} is no longer ${agent.name}'s; left untouched`,
          nowIso(),
          "warn",
        );
      } else {
        /**
         * The terminate above only *asked*: EC2 keeps the volume attached
         * through `shutting-down` and detaches it seconds later. `DeleteVolume`
         * sent into that window is refused with `VolumeInUse`, which is what
         * stranded this agent in the first place. Wait for the detach, however
         * long it takes, renewing the lock while we do (§4.4).
         */
        const release = yield* waitVolumeReleased(attachDeps(), volumeId, {
          ...(opts.signal ? { signal: opts.signal } : {}),
          heartbeat: keepLock,
          phase: "volume",
          progress: { waiting: 0.7, done: 0.75 },
        });
        /**
         * `gone` means the volume no longer exists — deleted by an earlier run of
         * this destroy, or already deleting. `rollback.ts` has read the same
         * answer this way since it was written; saying "deleted data volume" for
         * a `DeleteVolume` that did nothing tells the operator this run destroyed
         * data it never touched.
         */
        if (release === "gone") {
          yield evt("volume", 0.8, `data volume ${volumeId} is already gone`, nowIso());
        } else {
          await backend.compute.deleteVolume(volumeId);
          yield evt("volume", 0.8, `deleted data volume ${volumeId}`, nowIso(), "warn");
        }
      }

      /**
       * The release deletes the row, and the box writes to that row until it
       * stops. Its hermeticd writes are all `attribute_exists(#name)`
       * conditional (`packages/agentd/src/aws.ts`), so none of them can
       * re-create a deleted row — but a box still `shutting-down` can still land
       * a write on the row before the delete and move facts we are about to
       * record. Waiting for `terminated` (however long; the lock is renewed
       * while we do) means nothing on the box is running when the name goes,
       * and needs no agentd change.
       */
      for (const id of [...(instanceId ? [instanceId] : []), ...strays]) {
        checkAbort(opts.signal, "instance");
        yield* waitInstanceTerminated(attachDeps(), id, {
          ...(opts.signal ? { signal: opts.signal } : {}),
          heartbeat: keepLock,
          phase: "instance",
          progress: { waiting: 0.85, done: 0.9 },
        });
      }

      /**
       * §6.7: tombstone written, row deleted — the name is free. The
       * `destroyed` status is no longer written; it survives only on legacy
       * rows and on old events' `to_status`. The row goes with its lock, so
       * there is no `releaseLock` after this, and `done` is set first so a
       * consumer stopping here does not send `unwind` after a row that no
       * longer exists.
       */
      await keepLock();
      const result = await releaseName(agent, {
        volumeKept: keepVolume && !!volumeId,
        actor: who,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      // Set before the yield: a consumer that stops at the done event resumes
      // this generator with a `return`, which runs `finally` (see `create`).
      done = true;
      yield* released(result, parsed.name);
      yield evt("done", 1, `${parsed.name} destroyed`, nowIso());
    } catch (e) {
      failure = e;
      throw e;
    } finally {
      if (!done)
        await unwind(parsed.name, "destroy", owner, failure ?? abandoned(parsed.name, "destroy"));
    }
  }

  return { destroy };
}
