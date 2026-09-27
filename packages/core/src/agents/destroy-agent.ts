/**
 * `agents.destroy` (§6.6, §6.7): terminate the instance, sweep the tailnet, the
 * SSM prefix and the config prefix, and — only when asked — delete the data
 * volume.
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
import { assertOwnedInstance, assertOwnedVolume } from "./ownership.ts";
import { assertUnmoved, type ExpectedResources } from "./plan-expectations.ts";
import { waitVolumeReleased } from "./attach.ts";
import { abandoned, checkAbort } from "../abort.ts";
import { evt } from "../events.ts";
import { createTailnetCleanup } from "../fleet/tailnet-devices.ts";
import type { OpOptions } from "../hermetic.ts";
import type { CoreContext } from "../context.ts";

/** `destroy` needs nothing beyond the shared context. */
export interface DestroyDeps {
  ctx: CoreContext;
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
    const owner = `${await actor()}#${randomUUID()}`;

    if (agent.status === "destroyed") {
      yield evt("done", 1, `${agent.name} is already destroyed`, nowIso());
      return;
    }

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
      const live = instanceId ? await assertOwnedInstance(backend.compute, owned, instanceId) : null;
      if (parsed.delete_volume && volumeId) {
        await assertOwnedVolume(backend.compute, owned, volumeId);
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
       * The six steps below are exactly `plan.destroy`'s, in order, one at a
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

      // §6.6: the data volume is kept by default. Volumes are precious (§1).
      checkAbort(opts.signal, "volume");
      await keepLock();
      if (!parsed.delete_volume) {
        yield evt(
          "volume",
          0.8,
          `kept data volume ${volumeId ?? "(none)"}; pass --delete-volume to remove it`,
          nowIso(),
        );
      } else if (!volumeId) {
        yield evt("volume", 0.8, "no data volume on the agent row; nothing to delete", nowIso());
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

      agent = await transition(agent, "destroyed", "destroy complete", {
        instance_id: null,
        volume_id: parsed.delete_volume ? null : volumeId,
        // The node is gone, so everything it reported about itself goes with
        // it: an address nothing answers on, a MagicDNS name that now belongs
        // to a dead device, and — the three facts only a box can state — which
        // config it had applied, which binary it was running, and which Hermes
        // answered on it. Those two are
        // the ones the fleet reasons from (`configVerdict`, the rollout's
        // digest check), so a stale copy outliving the box it described is a
        // fact about nothing being read as a fact about something.
        tailscale_ip: null,
        tailscale_dns_name: null,
        tailscale_version: null,
        health: null,
        metrics: null,
        last_heartbeat: null,
        applied_config_hash: null,
        running_hermeticd_sha256: null,
        running_hermes_version: null,
        resources: {
          ssm_paths: [],
          ...(parsed.delete_volume || !volumeId ? {} : { volume_id: volumeId }),
        },
      });
      // Events are never deleted (§6.6) — the history of a destroyed agent stays.
      await releaseLock(agent);
      // Set before the yield: a consumer that stops at the done event resumes
      // this generator with a `return`, which runs `finally` (see `create`).
      done = true;
      yield evt("done", 1, `${agent.name} destroyed`, nowIso());
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
