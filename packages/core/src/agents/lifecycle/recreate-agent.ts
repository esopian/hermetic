/**
 * `agents.recreate` (§6.5): new instance, same volume. Split out of
 * `lifecycle.ts` for size; the design comments travelled with the code.
 * `createLifecycle` still owns `LifecycleDeps` and assembles the surface.
 */
import { randomUUID } from "node:crypto";
import { RecreateAgentInput as RecreateAgentInputSchema, cloudName } from "../../schema/index.ts";
import type { OpEvent, RecreateAgentInput } from "../../schema/index.ts";
import { HermeticError } from "../../errors.ts";
import { validateName } from "../../shared/naming.ts";
import type { VolumeRef } from "../../backend/types.ts";
import { assertOwnedInstance, assertOwnedVolume } from "../ownership.ts";
import type { ExpectedResources } from "../plan-expectations.ts";
import { attachAgentVolume } from "../attach.ts";
import { abandoned, checkAbort } from "../../abort.ts";
import { evt } from "../../events.ts";
import { pendingApplied } from "../../profiles/profile-binding.ts";
import type { OpOptions } from "../../hermetic.ts";
import type { LifecycleDeps } from "../lifecycle.ts";
import type { ReleaseLookup } from "./release.ts";
import { createRetireNodes } from "./retire-nodes.ts";

export function createRecreateOp(deps: LifecycleDeps, shared: { release: ReleaseLookup }) {
  const { applyPending, tsKeyPath } = deps;
  const {
    acquireLock,
    actor,
    assertCanApply,
    assertSealed,
    attachDeps,
    backend,
    ensureConfig,
    getAgent,
    guardFleet,
    lockKeeper,
    nowIso,
    releaseLock,
    renewLock,
    transition,
    unwind,
  } = deps.ctx;
  const { currentRelease, userDataFor } = shared.release;
  const { retireNodes } = createRetireNodes(deps.ctx);

  /** §6.5: new instance, same volume. Memory and skills were never on the root volume. */
  async function* recreate(
    input: RecreateAgentInput,
    opts: OpOptions = {},
    /**
     * The plan's promise about this agent's resources, as `destroy` takes it
     * (§6.7). Accepted here so `apply` hands both operations the same thing.
     *
     * TODO(evan): make the comparison, the way `destroy` does — `assertUnmoved`
     * immediately after this operation's `acquireLock`, releasing the lock on a
     * mismatch. It is deliberately not wired up in this change: recreate's body
     * is being rewritten in parallel, and a check inserted into a moving
     * function is a check nobody can review against either version of it.
     */
    expected?: ExpectedResources,
  ): AsyncIterable<OpEvent> {
    void expected;
    const parsed = RecreateAgentInputSchema.parse(input);
    validateName(parsed.name);
    // Recreate terminates a running instance. That is destructive even though
    // the volume survives, so it asks for the same confirmation destroy does.
    if (!parsed.yes) {
      throw new HermeticError(
        "CONFIRMATION_REQUIRED",
        `recreating ${parsed.name} terminates its instance; pass --yes`,
        { name: parsed.name },
      );
    }
    const { fleet } = await guardFleet();
    // A recreate is a fresh boot into the shared group, so it is sealed-checked
    // exactly as a create is (§5).
    await assertSealed("recreate an agent");
    let agent = await getAgent(parsed.name);

    /**
     * Recreate only from a state whose §4.3 path to a fresh boot exists.
     * `ready`/`degraded` drain through `stopping`; `creating`, `stopped` and
     * `error` go straight back to `bootstrapping`. An agent that is mid-boot
     * (`bootstrapping`) has no edge to `stopping`, and inventing one to make
     * recreate convenient would make the state machine mean less.
     *
     * `stopping` drains too, and has to: it is where `stop` leaves the row when
     * EC2 says the instance is `shutting-down` — a terminate somebody else asked
     * for, which will never reach `stopped` — and the CONFLICT it raises there
     * tells the operator to run exactly this command. Refusing it would make that
     * advice a dead end. Nothing extra is needed for it: the `stopping`
     * transition below is a re-entry (no assert, no history event, `state.ts`),
     * terminating the box settles it at `stopped` over the edge §4.3 already has,
     * and recreate was going to terminate whatever instance is there anyway.
     */
    const DRAINS = ["ready", "degraded", "stopping"] as const;
    const DIRECT = ["creating", "stopped", "error"] as const;
    if (![...DRAINS, ...DIRECT].some((s) => s === agent.status)) {
      throw new HermeticError(
        "INVALID_TRANSITION",
        `${agent.name} is ${agent.status}; recreate needs it settled (creating, ready, degraded, stopping, stopped or error)`,
        { name: agent.name, status: agent.status },
      );
    }

    const owner = `${await actor()}#${randomUUID()}`;
    agent = await acquireLock(agent, owner);
    /** The TTL lock, renewed on every poll of every wait below (§4.4). */
    const keepLock = lockKeeper(
      () => agent,
      (next) => {
        agent = next;
      },
      owner,
    );

    /** See `abandoned`. */
    let done = false;
    let failure: unknown = null;
    try {
      yield evt("plan", 0.05, `recreating ${agent.name}; the data volume is kept`, nowIso());
      checkAbort(opts.signal, "terminate");

      const oldInstance = agent.resources.instance_id ?? agent.instance_id;
      /**
       * §6.7: the row says which box to replace, and the box can write the row.
       * Prove the id is this agent's before terminating it — and before the
       * status moves — so a poisoned row cannot turn a recreate into a terminate
       * of somebody else's instance (`ownership.ts`). `null` is an id EC2 has
       * already forgotten, which needs no terminate at all.
       */
      const owned = oldInstance
        ? await assertOwnedInstance(
            backend.compute,
            { fleet_id: fleet.fleet_id, agent: agent.name },
            oldInstance,
          )
        : null;

      /**
       * The data volume, resolved by the id the row records and proved the same
       * way — before anything is terminated, because a recreate that cannot
       * keep the agent's memory should not have spent the box first (§6.5).
       *
       * It used to be a tag scan with a `createVolume` behind it, which turned
       * every way a tag can drift into a silent swap for a fresh empty disk
       * under a row rewritten to name it, reported as "recreated on the same
       * volume". So: the recorded id wins when there is one, `null` from the
       * lookup is EC2 saying the disk is gone and is refused below,
       * `RESOURCE_NOT_OWNED` propagates, and only a row recording no volume at
       * all reaches discovery.
       */
      const recordedVolume = agent.resources.volume_id ?? agent.volume_id ?? null;
      const ownedVolume = recordedVolume
        ? await assertOwnedVolume(
            backend.compute,
            { fleet_id: fleet.fleet_id, agent: agent.name },
            recordedVolume,
          )
        : null;
      if (recordedVolume !== null && ownedVolume === null) {
        throw new HermeticError(
          "VOLUME_MISSING",
          `${agent.name} records data volume ${recordedVolume}, and EC2 no longer has it; ` +
            "recreate will not put an empty disk in its place. Run `hermetic volume ls` to find " +
            `the disk, then \`hermetic agent destroy ${agent.name}\` and \`hermetic agent create ` +
            `${agent.name} --volume <volume-id>\` to rebuild the agent on the one you name`,
          { name: agent.name, volume_id: recordedVolume },
        );
      }

      const drains = DRAINS.some((s) => s === agent.status);
      if (drains) {
        agent = await transition(agent, "stopping", "recreate: draining the old instance");
      }
      /**
       * Read before anything below can change it. It is the FQDN the box we
       * are terminating reported for itself, and it is the only thing that
       * identifies that box's tailnet device exactly — the sweep below needs
       * it, and the `stopped` transition after the sweep clears it from the
       * row.
       */
      const reportedNode = agent.tailscale_dns_name ?? null;
      if (oldInstance && owned) {
        await backend.compute.terminate(oldInstance);
        yield evt(
          "instance",
          0.35,
          owned.state === "terminated"
            ? `instance ${oldInstance} is already terminated`
            : `terminating instance ${oldInstance}`,
          nowIso(),
        );
      }

      /**
       * Reality-first, but *not* create's find-or-launch: a recreate whose whole
       * point is a new instance must never adopt a surviving one. Anything still
       * tagged for this agent — a box the row lost the id of, or one a recreate
       * that died before recording its launch left behind — is terminated here,
       * and the new instance below is launched unconditionally. There can be
       * more than one: two recreates racing leave two boxes for one agent, and
       * the next recreate must sweep both rather than the first it happens to
       * see.
       *
       * Here, with the old instance, rather than just before the launch: every
       * one of these boxes runs a node that joins the tailnet under this
       * agent's hostname, and any of them still online when the replacement
       * joins pushes it onto `<name>-2`. Terminated together, the one wait and
       * sweep below covers all of them. Nothing can add a box between here and
       * the launch short of another operation ignoring this run's lock, which
       * this run renews throughout.
       *
       * `shutting-down` boxes are listed too, as `destroy` lists them: one
       * already going is not terminated again, but it is waited on, because
       * its node is online until it is `terminated`. The old instance is
       * listed again while it shuts down, and is skipped — it is already
       * terminating and already waited on.
       */
      const going = oldInstance && owned ? [oldInstance] : [];
      for (const stray of await backend.compute.listInstancesByTag(agent.name, {
        shuttingDown: true,
      })) {
        if (stray.instance_id === oldInstance) continue;
        going.push(stray.instance_id);
        if (stray.state === "shutting-down") {
          yield evt(
            "instance",
            0.36,
            `instance ${stray.instance_id} is still tagged for ${agent.name} and already shutting down; waiting for it before launching the replacement`,
            nowIso(),
            "warn",
          );
          continue;
        }
        yield evt(
          "instance",
          0.36,
          `instance ${stray.instance_id} is still tagged for ${agent.name}; terminating it before launching the replacement`,
          nowIso(),
          "warn",
        );
        await backend.compute.terminate(stray.instance_id);
      }

      /**
       * Before the fresh auth key is minted, and so before the new node tries
       * to join: the replacement is only admitted as `<name>` if nothing else
       * in the tailnet still holds it (§6.5). Doing this after the mint would
       * be a race the old device usually wins — and so would sweeping straight
       * after the terminate request, when the old node still reads online and
       * the sweep must pass over it. So every box terminated above is waited
       * on until `terminated`, the tailnet is given a bounded time to notice,
       * and only then are the agent's devices swept; what is still online at
       * the deadline is named in one `warn`, and the replacement is launched
       * anyway (`retire-nodes.ts`, the sequence `destroy` runs before its
       * release).
       */
      yield* retireNodes(
        {
          name: agent.name,
          fleetId: fleet.fleet_id,
          dnsName: () => reportedNode,
          instanceIds: going,
          heartbeat: keepLock,
          tailnet: true,
          progress: { terminated: { waiting: 0.38, done: 0.4 }, offline: 0.42, sweep: 0.44 },
        },
        opts,
      );

      /**
       * After the wait, so that `stopped` — and this transition's message —
       * says what is true: the box is `terminated`, not merely asked to be. It
       * also clears whatever the dying box's hermeticd wrote while it was still
       * `shutting-down`.
       */
      if (drains) {
        agent = await transition(
          agent,
          "stopped",
          "recreate: old instance terminated",
          {
            instance_id: null,
            tailscale_ip: null,
            tailscale_dns_name: null,
            tailscale_version: null,
            last_heartbeat: null,
            metrics: null,
            // Same rule as `stop`: the box these came from has been terminated.
            applied_config_hash: null,
            running_hermeticd_sha256: null,
            running_hermes_version: null,
          },
          // We terminated the box this health came from, so it is stale whoever
          // moved the status — a `stop` that won the race would otherwise leave a
          // green health on the board for an instance that no longer exists.
          { health: null },
        );
      }
      yield evt("instance", 0.46, "old instance terminated", nowIso());

      checkAbort(opts.signal, "volume");
      // Discovery and creation are for the row that records no volume: an agent
      // whose create never reached the volume step, or one from before the field.
      let volume: VolumeRef;
      if (ownedVolume) {
        volume = {
          volume_id: ownedVolume.volume_id,
          size_gib: ownedVolume.size_gib,
          state: ownedVolume.state,
        };
      } else {
        volume =
          (await backend.compute.findVolumeByTag(agent.name)) ??
          (await backend.compute.createVolume(
            agent.name,
            agent.volume_gib,
            `${cloudName(fleet.fleet_id, agent.name)}-data`,
          ));
      }
      // The invariant the writes at the end of this op depend on: they rewrite
      // `volume_id`, and a recreate may never point it at a disk other than the
      // one the row already named. Unreachable above; asserted because it is
      // cheap here and silent data loss is what it stands in front of.

      if (recordedVolume !== null && volume.volume_id !== recordedVolume) {
        throw new HermeticError(
          "CONFLICT",
          `${agent.name} records data volume ${recordedVolume} but recreate resolved ${volume.volume_id}`,
          { name: agent.name, volume_id: recordedVolume, resolved: volume.volume_id },
        );
      }

      // A fresh boot needs a fresh single-use auth key (§8.3).
      await backend.secrets.ensureSlot(tsKeyPath(agent.name));
      const key = await backend.tailscale.mintAuthKey(cloudName(fleet.fleet_id, agent.name));
      await backend.secrets.put(tsKeyPath(agent.name), key);
      yield evt("secrets", 0.5, "fresh single-use tailscale auth key stored", nowIso());

      agent = await renewLock(agent, owner);
      /**
       * §8.3, before the render: a rebuild is a fresh boot into a fresh
       * configuration, so a change staged on this row is one the replacement
       * should come up on. Rendering first would upload the old binding and
       * boot the new box onto the credential the operator has already moved off.
       */
      /**
       * Before the commit, not after it — the same order `rollout.run` follows.
       * `applyPending` copies the credential, rewrites the binding and clears
       * `pending` in one conditional write; if the document that binding renders
       * needs a capability this fleet's published hermeticd does not have,
       * `ensureConfig` below would say so only once all of that had happened,
       * leaving a row bound to a slot no box reads and nothing staged to retry.
       * Asking first costs one pure render and refuses with the change intact.
       */
      if (agent.pending) await assertCanApply(pendingApplied(agent), fleet);
      agent = await applyPending(agent);
      const rendered = await ensureConfig(agent, fleet);
      // Read once, and stamped on the row below: the binary this instance will
      // fetch and the version the row claims cannot then disagree.
      const release = await currentRelease();

      yield evt(
        "instance",
        0.8,
        `launching a ${agent.instance_type} on ${fleet.ami_id}`,
        nowIso(),
        undefined,
        "start",
      );
      const instance = await backend.compute.runInstance({
        name: agent.name,
        instance_type: agent.instance_type,
        ami_id: fleet.ami_id,
        user_data: await userDataFor(agent.name, fleet, release),
        // As in create: the fleet's mode decides the public IP, not the subnet.
        network: fleet.network,
        // Recreate is where a changed `--root-gib` lands: the instance is being
        // replaced anyway, and the root disk goes with it (§7.1). A row written
        // before the field existed carries none and keeps the AMI's size.
        ...(agent.root_gib ? { root_gib: agent.root_gib } : {}),
        tags: { agent: agent.name, Name: cloudName(fleet.fleet_id, agent.name) },
      });
      agent = await backend.store.agents.update(agent.name, agent.version, {
        instance_id: instance.instance_id,
        volume_id: volume.volume_id,
        resources: {
          ...agent.resources,
          instance_id: instance.instance_id,
          volume_id: volume.volume_id,
        },
      });
      yield evt(
        "instance",
        0.85,
        `instance ${instance.instance_id} recorded on the agent row`,
        nowIso(),
      );

      yield* attachAgentVolume(attachDeps(), instance.instance_id, volume.volume_id, {
        ...(opts.signal ? { signal: opts.signal } : {}),
        heartbeat: keepLock,
        progress: { waiting: 0.9, done: 0.92 },
      });

      agent = await transition(
        agent,
        "bootstrapping",
        "recreate: new instance launched",
        {},
        // Every field here is something this run just made: the instance it
        // launched, the config it uploaded, the release it pinned — or something
        // it unmade, by terminating the box the old values described. Either way
        // it is true whoever moved the status, so all of it is written even if
        // somebody else moved it first — including the clearing of
        // `bootstrap`/`command`, because a fresh boot runs the stages from the
        // beginning and the previous boot's progress, or a command it never
        // acked, must not survive into it and be read as this one's (§4.2).
        //
        // The tailnet identity, the heartbeat, the health and the metrics are
        // cleared here rather than only on the drain path: `creating`, `stopped`
        // and `error` reach this line without passing through `stopped`, and a
        // row that kept `tailscale_dns_name` from the node just terminated would
        // send every link — and the drawer's stale-device note — at a corpse
        // until the replacement's first heartbeat overwrote it (§6.5).
        {
          instance_id: instance.instance_id,
          volume_id: volume.volume_id,
          config_hash: rendered.config_hash,
          hermeticd_version: release.version,
          bootstrap: null,
          command: null,
          tailscale_ip: null,
          tailscale_dns_name: null,
          tailscale_version: null,
          last_heartbeat: null,
          health: null,
          metrics: null,
          /**
           * The three facts only a box states, cleared for the same reason the
           * heartbeat above is: the box that stated them has been terminated.
           *
           * This line and `hermeticd_version` two lines up are deliberately
           * opposite. That one is written *forward* — the release this run
           * pinned, which the replacement will boot into — and is the laptop's
           * intention. These are written *back to null* because they are
           * reports, and there is nothing reporting yet. Leaving them would make
           * the new box answer `configVerdict` and the rollout's digest check
           * with the dead box's readings, which is precisely how the row would
           * claim the replacement had landed a release it has not downloaded.
           */
          applied_config_hash: null,
          running_hermeticd_sha256: null,
          running_hermes_version: null,
          resources: {
            ...agent.resources,
            instance_id: instance.instance_id,
            volume_id: volume.volume_id,
            config_key: rendered.key,
          },
        },
      );
      await releaseLock(agent);
      // Set before the yield: a consumer that stops at the done event resumes
      // this generator with a `return`, which runs `finally` (see `create`).
      done = true;
      yield evt("done", 1, `${agent.name} recreated on the same volume`, nowIso());
    } catch (e) {
      failure = e;
      throw e;
    } finally {
      if (!done)
        await unwind(parsed.name, "recreate", owner, failure ?? abandoned(parsed.name, "recreate"));
    }
  }

  return { recreate };
}
