/**
 * `agents.destroy` (§6.6, §6.7): terminate the instance, sweep the tailnet, the
 * SSM prefix and the config prefix, delete the data volume (unless
 * `keep_volume`), wait for every instance to be `terminated`, sweep the
 * tailnet once more, and release the name — tombstone written, agent row
 * deleted (`lifecycle/release-name.ts`).
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
import { HermeticError } from "../errors.ts";
import { assertOwnedInstance } from "./ownership.ts";
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
  const { releaseName, existingTombstone, volumeHold } = createReleaseName({
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
    for (const v of result.swept) {
      yield evt(
        "release",
        0.96,
        `volume ${v.volume_id} (${v.state}) was still tagged agent=${name} but is not the row's; kept, not deleted, and released from the name (tagged former_agent=${name}); adopt it with agent create <name> --volume ${v.volume_id}`,
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
    /**
     * Read before the lock is taken: the release leaves alone any disk EC2
     * created after this instant, which only a later incarnation can own
     * (`ReleaseNameOptions.runStartedAt`).
     */
    const runStartedAt = nowIso();
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
          runStartedAt,
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
       * The volume itself is the other, stronger witness. A destroy that
       * keeps it writes `hermetic:former_agent=<name>` onto it before it
       * terminates anything (below), and the release later sets that tag
       * again and only then removes `agent` (`retagVolume`) — all of it
       * before any tombstone is written. A destroy interrupted anywhere after
       * that first write leaves no tombstone, but a volume carrying
       * `former_agent=<name>` — with or without `agent` still on it. That tag
       * is a promise to keep the disk, made by an operator who asked for it,
       * so this run keeps it too, whatever its own flag said, and the release
       * finishes the retag (`volumeHold`).
       *
       * Any other disk still tagged `agent=<name>` — the real one, if the box
       * pointed its row at an earlier incarnation's kept disk or at none — is
       * the release's to move off the name, never to delete (`taggedExtras`).
       *
       * Everything else runs again, every step idempotent: the events table is
       * writable by the boxes (the instance role may put any item in it), so a
       * tombstone is not proof that the box is gone. A compromised box that
       * planted one for its own row must still be terminated, swept and
       * stripped of its secrets before the name is released.
       */
      const prior = await existingTombstone(agent);
      let keepVolume = !!parsed.keep_volume || (prior?.volume_kept ?? false);
      const live = instanceId ? await assertOwnedInstance(backend.compute, owned, instanceId) : null;
      let volumeNotOwned = false;
      /** An earlier, interrupted release already tagged the disk to be kept. */
      let keptByEarlierRelease = false;
      const hold = volumeId ? await volumeHold(agent.name, volumeId) : null;
      if (!keepVolume && hold !== null) {
        if (hold.kind === "released") {
          keepVolume = true;
          keptByEarlierRelease = true;
        } else if (hold.kind === "foreign") {
          if (!prior) throw hold.refusal;
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
       * §6.7: `--keep-volume` made durable before anything is destroyed. The
       * flag lives in this run's memory, and the release that acts on it
       * comes last; a run that dies after the terminate and before that retag
       * would leave a retry — perhaps typed without the flag — free to delete
       * the disk the operator asked to keep. So the promise goes onto the
       * disk now, as the one tag every later run reads as "keep"
       * (`volumeHold`'s `released`), and the retry keeps it whatever its own
       * flag says.
       *
       * Only `CreateTags`: `agent=<name>` stays, so the disk is still this
       * agent's to every ownership check (`ownership.ts` reads `agent`, the
       * fleet and the managed tag, never `former_agent`) until the release
       * moves it off the name. Only on a disk that is this agent's (`owned`):
       * one already `released` carries the tag, one `gone` has nothing to
       * tag, and a `foreign` one is somebody else's and is left exactly as
       * found. It comes after every ownership check above has passed, so a
       * refused destroy has still written nothing.
       */
      if (keepVolume && volumeId && hold?.kind === "owned") {
        await backend.compute.retagVolume(volumeId, agent.name, { formerAgent: agent.name });
        yield evt(
          "volume",
          0.15,
          `keeping data volume ${volumeId}: tagged former_agent=${agent.name} before anything is terminated, so a retry keeps it too`,
          nowIso(),
        );
      }

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
       * second describe would ask the same question twice.
       *
       * It lists `shutting-down` boxes too (`shuttingDown`), and waits on them
       * below like the rest. A stray already on its way out when a crashed
       * destroy is retried still runs its hermeticd until it is `terminated`,
       * and that heartbeat is conditional on the row *existing* only — it does
       * not move the row's `version` (`packages/agentd/src/aws.ts`). Nothing
       * the release does would notice it: a heartbeat landing after the delete
       * is refused, but one landing on a same-name row a later `create` has
       * written by then would put the dead box's health into the new agent.
       * Only waiting for `terminated` closes that, so a dying stray is never
       * skipped. It is not terminated again: it is already going.
       */
      const strays: string[] = [];
      for (const stray of await backend.compute.listInstancesByTag(agent.name, {
        shuttingDown: true,
      })) {
        if (stray.instance_id === instanceId) continue;
        strays.push(stray.instance_id);
        if (stray.state === "shutting-down") {
          yield evt(
            "instance",
            0.22,
            `instance ${stray.instance_id} is also tagged for ${agent.name} and already shutting down; waiting for it`,
            nowIso(),
            "warn",
          );
          continue;
        }
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
       * The terminate above has been accepted, which is enough to start — the
       * device is the node's, not the volume's, so a corpse already offline is
       * cleaned up here rather than after the (possibly long) wait for the
       * volume to come free. The box just asked to terminate is usually still
       * online at this point, so an online device is passed over silently
       * (`online: "defer"`): the sweep runs again once every instance is
       * `terminated`, below, and that pass deletes whatever still holds the
       * name. An agent created under this name later then gets the name,
       * instead of `<name>-2`.
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
      const firstSweep = yield* removeTailnetDevices(
        agent.name,
        fleet.fleet_id,
        agent.tailscale_dns_name ?? null,
        "tailnet",
        0.3,
        opts,
        { online: "defer" },
      );

      checkAbort(opts.signal, "secrets");
      await keepLock();
      const removedParams = await backend.secrets.deleteByPrefix(agentPrefix(agent.name));
      yield evt("secrets", 0.45, `removed ${removedParams.length} SSM parameter(s)`, nowIso());

      checkAbort(opts.signal, "config");
      await keepLock();
      /**
       * §6.7: every version, not just the current one. The bucket is
       * versioned and its lifecycle rule keeps the newest noncurrent versions
       * of a key indefinitely, so `deleteByPrefix` would only lay delete
       * markers over this agent's rendered config — which still carries its
       * settings — and leave it readable by version long after the name was
       * released. `purgeByPrefix` removes the versions and the markers, so a
       * later agent of this name starts with nothing under `config/<name>/`.
       */
      const removedObjects = await backend.artifacts.purgeByPrefix(configPrefix(agent.name));
      yield evt(
        "config",
        0.6,
        `removed ${removedObjects} config object version(s) and delete marker(s)`,
        nowIso(),
      );

      /**
       * §6.7: the data volume goes with the agent by default — a destroyed
       * agent releases everything but its history. `--keep-volume` keeps it,
       * and the release below moves it off the name (`former_agent`), so a
       * later `create` of this name starts on a fresh disk.
       */
      checkAbort(opts.signal, "volume");
      await keepLock();
      if (keptByEarlierRelease) {
        yield evt(
          "volume",
          0.8,
          `data volume ${volumeId} already carries former_agent=${agent.name}: an earlier destroy that kept it was interrupted; keeping it, not deleting it, and finishing its release below`,
          nowIso(),
          "warn",
        );
      } else if (keepVolume) {
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
       * The second tailnet pass (§6.5, §6.7). The first ran while the boxes
       * were still going down, when their nodes were usually still online;
       * every instance tagged for the name — the row's and every stray — is
       * `terminated` now, confirmed above. A matching device that still reads
       * online is therefore a node whose box is gone, and the flag is only
       * Tailscale's lag in noticing (a node can show online for minutes after
       * its machine stopped). So this pass deletes such a match even online
       * (`online: "delete"`): left, it would hold the name, and the next node
       * to join as this agent would be admitted as `<name>-2`.
       *
       * Only on the fleet-scoped hostname arm, `tag:hermetic` plus
       * `cloudName(fleet id, name)`, which only a box this fleet launched for
       * this name joins as — and every such box is terminated, while the lock
       * is ours (`keepLock` just above) so no later incarnation has launched.
       * That is not a guess about a live machine (§1). The other arm, the
       * FQDN in the row's `tailscale_dns_name`, is written by the box itself
       * and could name another agent's or another fleet's live node: a device
       * matched by it alone is still deleted when offline, but while online
       * it is named in a `warn` and left. Idempotent: a device the first pass
       * removed is simply not listed again.
       *
       * Skipped when the first pass could not finish (`null`): an OAuth client
       * without `devices:core`, a refused delete or an unreachable API has
       * already said so in one `warn`, and asking again would only say it
       * twice — one warning is the useful number. Never a refusal: the
       * release below runs either way.
       */
      checkAbort(opts.signal, "tailnet");
      await keepLock();
      if (firstSweep !== null) {
        yield* removeTailnetDevices(
          agent.name,
          fleet.fleet_id,
          agent.tailscale_dns_name ?? null,
          "tailnet",
          0.92,
          opts,
          { online: "delete" },
        );
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
        runStartedAt,
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
