/**
 * §6.5 Update: `agent rerun`, `agent reboot`, `upgrade`.
 *
 * These three are one module because they are the three ways an agent is moved
 * forward *without being replaced* — a box asked to re-run its bootstrap
 * stages, a box asked to bounce its operating system, and a version pin moved
 * so the next boot picks a newer release up. None of them creates or destroys
 * anything, and all three share the same small vocabulary: the agent row's
 * `command` slot the resident runner polls (§4.2), the §4.4 lock they must not
 * cut across, and the fleet manifest that names the release every box installs.
 *
 * `UpdateDeps` is the honest list of what they need from the SDK closure, same
 * shape as `LifecycleDeps` (`lifecycle.ts`) and `TeardownDeps` (`teardown.ts`).
 * `hermesRef` is passed in rather than read from `BUILD_VERSIONS` so that this
 * module does not import back from `hermetic.ts`, which imports it.
 */
import { randomUUID } from "node:crypto";
import {
  describeRelease,
  pointFleetAt,
  readFleetManifest,
  releaseDrift,
  recordHermesMirror,
} from "../release/artifacts.ts";
import { HERMES_REPO_URL, type HermesMirrorFn } from "../release/hermes-mirror.ts";
import { assertBrowserSupported } from "../release/browser-mirror.ts";
import {
  AgentRefInput as AgentRefInputSchema,
  FLEET_KEY,
  hermesBundleKey,
  releaseKey,
  RerunInput as RerunInputSchema,
  UpgradeInput as UpgradeInputSchema,
} from "../schema/index.ts";
import type {
  Agent,
  AgentRefInput,
  AgentStatus,
  AgentView,
  OpEvent,
  RerunInput,
  UpgradeInput,
} from "../schema/index.ts";
import { HermeticError } from "../errors.ts";
import { validateName } from "../shared/naming.ts";
import { checkAbort } from "../abort.ts";
import { LOCK_TTL_MS } from "../fleet/fleet-lock.ts";
import type { CoreContext } from "../context.ts";

import { evt } from "../events.ts";
import type { OpOptions } from "../hermetic.ts";

/** What §6.5 needs beyond the shared context: the pinned Hermes ref and the mirror that refreshes it. */
export interface UpdateDeps {
  ctx: CoreContext;
  /** `BUILD_VERSIONS.hermes_ref`, what a rerun's fresh render pins. */
  hermesRef: string;
  /** §3.6's mirror; real by default (rule 6), so an absent one is a type error. */
  hermesMirror: HermesMirrorFn;
}

export function createUpdate(deps: UpdateDeps) {
  const { hermesRef, hermesMirror } = deps;
  const {
    backend,
    hermeticdVersion,
    localBuild,
    acquireLock,
    actor,
    assertFleetUnlocked,
    appendEvent,
    ensureConfig,
    getAgent,
    guardFleet,
    lockHeldByOther,
    nowIso,
    releaseLock,
    view,
  } = deps.ctx;

  /**
   * §9 `agent rerun`: ask the box to re-run the bootstrap stages that are not
   * `ok`, resuming at the first failure. Core writes a *command* on the row and
   * nothing else — the resident runner polls its own row and acts (§4.2), so
   * there is no RPC to hang on and no partial state if the laptop dies here.
   *
   * `error` only: an agent that is still booting will reach its next stage on
   * its own, and one that is `ready` has nothing to resume.
   */
  async function rerun(input: RerunInput): Promise<AgentView> {
    const parsed = RerunInputSchema.parse(input);
    validateName(parsed.name);
    const { fleet } = await guardFleet();
    await assertFleetUnlocked(parsed.name);
    const agent = await getAgent(parsed.name);
    if (agent.status !== "error") {
      throw new HermeticError(
        "INVALID_TRANSITION",
        `${agent.name} is ${agent.status}; rerun re-runs the bootstrap stages of an agent that failed one (error)`,
        { name: agent.name, status: agent.status },
      );
    }
    // §7.3: a rerun re-runs the stage that fetches the browser from `browser/*`.
    assertBrowserSupported(fleet);
    /**
     * A command the runner has not acked yet is a rerun already in flight. The
     * runner acts on one command id at a time (§4.2), so overwriting it would
     * either lose the first request or — if it arrives mid-poll — start the
     * stages twice; the operator is told to wait instead.
     */
    if (agent.command && agent.command.id !== agent.bootstrap?.last_command_id) {
      throw new HermeticError(
        "CONFLICT",
        `${agent.name} already has a ${agent.command.action} the box has not acknowledged yet (issued by ${agent.command.issued_by}); wait for it to be picked up`,
        { name: agent.name, command_id: agent.command.id, issued_at: agent.command.issued_at },
      );
    }
    /**
     * §4.4: rerun takes no lock of its own — it is one row write — but it must
     * not cut across an operation that holds one. A create or recreate in
     * flight is about to replace this boot entirely.
     */
    const self = `${await actor()}#${randomUUID()}`;
    if (lockHeldByOther(agent, self)) {
      throw new HermeticError(
        "LOCKED",
        `agent ${agent.name} is locked by ${agent.lock?.owner ?? "another operator"}; rerun would cut across the operation holding it`,
        { name: agent.name, owner: agent.lock?.owner ?? null, expires: agent.lock?.expires ?? null },
      );
    }
    const command = {
      id: randomUUID(),
      action: "rerun" as const,
      issued_by: await actor(),
      issued_at: nowIso(),
    };
    // The same optimistic CAS every operator write uses (§4.4): two operators
    // clicking "rerun" must not leave two commands the runner acts on twice.
    const next = await backend.store.agents.update(agent.name, agent.version, { command });
    const failed = agent.bootstrap?.stages.find((stage) => stage.status === "failed");
    await appendEvent(
      agent.name,
      "rerun",
      failed ? `re-run requested from ${failed.id}` : "re-run requested for every stage that is not ok",
    );
    /**
     * §3.6: a rerun re-runs the box's stages against the release the *fleet*
     * names, using a config this checkout renders. If the two came from
     * different builds of hermetic at the same version, the rerun is very
     * likely to fail the same stage again — so the drift is said here, where an
     * operator is looking at a box that already failed one.
     *
     * `rerun` writes one row and returns a view, not an event stream, so the
     * sentence goes into the agent's own history: the drawer and `agent show`
     * both read it, and it is still there when the next rerun fails too.
     *
     * A manifest that cannot be read is not this warning's problem — it is
     * `currentRelease`'s, on the next create — so the read is best-effort.
     */
    const drift = releaseDrift(
      (await readFleetManifest(backend.artifacts).catch(() => null))?.hermeticd ?? null,
      { version: hermeticdVersion, build: localBuild() },
    );
    if (drift) await appendEvent(agent.name, "rerun", drift);
    return view(next);
  }

  /**
   * §6.5 `agent reboot`: bounce the operating system on the instance the agent
   * already has. One `RebootInstances` and nothing else — the instance keeps its
   * id, its root disk and its attached data volume, and never leaves `running`,
   * which is what separates this from `recreate` (a new box from a fresh disk)
   * and from `stop`+`start` (the same box, powered off and on, minutes of it).
   *
   * The row's status is deliberately left alone. `hermeticd`'s bootstrap unit
   * re-runs on the way back up and finds every stage marker matching, so it
   * writes nothing and the agent is `ready` again the moment it heartbeats
   * (§6.3). What is cleared is what the reboot invalidates: the readings taken
   * from the box that just went down, and any command addressed to the run that
   * just ended — an unacknowledged one would refuse every later `agent rerun`
   * with CONFLICT (§6.5), the same reason `start` clears it.
   */
  async function reboot(input: AgentRefInput): Promise<AgentView> {
    const parsed = AgentRefInputSchema.parse(input);
    validateName(parsed.name);
    await guardFleet();
    await assertFleetUnlocked(parsed.name);
    const agent = await getAgent(parsed.name);

    /**
     * Only a box that is up. `stopped` has an instance but no OS to ask, and
     * saying so names the command that does what the operator meant; the
     * in-flight statuses are somebody else's operation mid-step.
     */
    const REBOOTABLE: readonly AgentStatus[] = ["ready", "degraded", "bootstrapping", "error"];
    if (!REBOOTABLE.includes(agent.status)) {
      throw new HermeticError(
        "INVALID_TRANSITION",
        agent.status === "stopped"
          ? `${agent.name} is stopped; use \`hermetic agent start ${agent.name}\``
          : `${agent.name} is ${agent.status}; reboot needs a running instance (ready, degraded, bootstrapping or error)`,
        { name: agent.name, status: agent.status },
      );
    }

    /**
     * §4.4: like `rerun`, reboot takes no lock of its own — it is one AWS call
     * and one row write — but it must not cut across an operation holding one,
     * which is about to terminate or replace this instance anyway.
     */
    const self = `${await actor()}#${randomUUID()}`;
    if (lockHeldByOther(agent, self)) {
      throw new HermeticError(
        "LOCKED",
        `agent ${agent.name} is locked by ${agent.lock?.owner ?? "another operator"}; reboot would cut across the operation holding it`,
        { name: agent.name, owner: agent.lock?.owner ?? null, expires: agent.lock?.expires ?? null },
      );
    }

    const instanceId = agent.resources.instance_id ?? agent.instance_id;
    if (!instanceId) {
      throw new HermeticError(
        "CONFLICT",
        `${agent.name} has no instance to reboot; use \`hermetic agent recreate ${agent.name}\``,
        { name: agent.name },
      );
    }
    // Reality first (§4.5): EC2 refuses a reboot of anything but a running
    // instance, and its own error would name neither the agent nor the fix.
    const live = await backend.compute.describeInstance(instanceId);
    if (!live || live.state === "terminated") {
      throw new HermeticError(
        "CONFLICT",
        `instance ${instanceId} is ${live?.state ?? "gone"}; use \`hermetic agent recreate ${agent.name}\``,
        { name: agent.name, instance_id: instanceId, state: live?.state ?? null },
      );
    }
    if (live.state !== "running") {
      throw new HermeticError(
        "CONFLICT",
        `instance ${instanceId} is ${live.state}, not running; reboot needs a running instance`,
        { name: agent.name, instance_id: instanceId, state: live.state },
      );
    }

    await backend.compute.reboot(instanceId);
    // The heartbeat, health and metrics all describe the box as it was a moment
    // ago; the row write itself refreshes `updated_at`, which is the grace
    // period §4.3 gives a row with no heartbeat before it reads `unreachable`.
    const next = await backend.store.agents.update(agent.name, agent.version, {
      command: null,
      health: null,
      metrics: null,
      last_heartbeat: null,
    });
    await appendEvent(agent.name, "reboot", `rebooting instance ${instanceId}`);
    return view(next);
  }

  /**
   * §6.5. Two halves that no longer resemble each other:
   *
   * - `--hermeticd V` is **fleet-wide**. It moves one pointer — the fleet
   *   manifest's `hermeticd.version` — and writes not a single agent row: every
   *   box picks the new release up on its nightly update (§4.4). A name would
   *   mean "upgrade this one box", which the fleet manifest cannot express, so
   *   it is refused rather than silently widened.
   * - `--hermes V` is per-agent: the pin, the re-render and the upload, and then
   *   nothing, because a running Hermes is replaced by a recreate and not by an
   *   RPC that reaches into the box.
   */
  async function* upgrade(input: UpgradeInput, opts: OpOptions = {}): AsyncIterable<OpEvent> {
    const parsed = UpgradeInputSchema.parse(input);
    const { fleet, stack } = await guardFleet();

    if (parsed.hermeticd !== undefined) {
      if (parsed.name !== undefined) {
        throw new HermeticError(
          "VALIDATION",
          "hermeticd upgrades are fleet-wide: the fleet manifest names one release for every agent. Drop the name and pass --all.",
          { name: parsed.name, hermeticd: parsed.hermeticd },
        );
      }
      yield evt(
        "release",
        0.2,
        `checking hermeticd ${parsed.hermeticd} in s3://${fleet.bucket}/${releaseKey(parsed.hermeticd, "")}`,
        nowIso(),
      );
      // Digests recomputed from the objects themselves: the manifest is what
      // every box verifies its download against, so a copied digest would be
      // worse than none (§3.1).
      const hermeticd = await describeRelease(backend.artifacts, parsed.hermeticd);
      checkAbort(opts.signal, "manifest");
      /**
       * §6.6: the pointer is moved *holding* the fleet lock (`pointFleetAt`),
       * not merely after a read of it — `foundation.update`'s prune decides what
       * to delete from the manifest it read a moment ago, so a pointer moved
       * into that gap names a release the prune then removes. The lock is given
       * back before the per-agent `--hermes` phase, which needs it free.
       */
      await pointFleetAt(backend.artifacts, backend.store.fleet, {
        fleet,
        stack,
        hermeticd,
        owner: `${await actor()}#${randomUUID()}`,
        ttlMs: LOCK_TTL_MS,
        now: () => backend.clock.now(),
        updatedBy: await actor(),
        updatedAt: nowIso(),
      });
      await appendEvent(FLEET_KEY, "upgrade", `hermeticd → ${parsed.hermeticd}`);
      yield evt(
        "manifest",
        parsed.hermes === undefined ? 1 : 0.4,
        `the fleet manifest now names hermeticd ${parsed.hermeticd}; every agent takes it on its next nightly update`,
        nowIso(),
      );
      if (parsed.hermes === undefined) return;
    }

    /**
     * §3.6, and **before** any agent manifest is rewritten: the bundle for the
     * ref those manifests are about to pin has to be in the bucket before a box
     * can be asked to install from it. The manifest write that records it is the
     * last step, as every push's is.
     *
     * There is no "refuse an unknown ref" here, which the plan for this called
     * for, because there is no ref to be unknown: every render pins
     * `BUILD_VERSIONS.hermes_ref` (see `renderFor`), so `--hermes <version>`
     * moves the *version* an agent asserts and never the ref it checks out. When
     * the agent row gains a `hermes_ref` of its own, this is where the refusal
     * belongs.
     */
    const mirrorProgress = parsed.hermeticd === undefined ? 0.05 : 0.45;
    const published = await readFleetManifest(backend.artifacts).catch(() => null);
    const mirror = await hermesMirror({
      ref: hermesRef,
      existing: published?.hermes,
    });
    if (mirror.warning !== undefined) {
      yield evt("mirror", mirrorProgress, mirror.warning, nowIso(), "warn");
    } else if (mirror.status === "pushed") {
      const recorded = await recordHermesMirror(backend.artifacts, backend.store.fleet, {
        fleet,
        stack,
        hermes: mirror.block,
        owner: `${await actor()}#${randomUUID()}`,
        ttlMs: LOCK_TTL_MS,
        now: () => backend.clock.now(),
        updatedBy: await actor(),
        updatedAt: nowIso(),
      });
      if (recorded) {
        yield evt(
          "mirror",
          mirrorProgress,
          `mirrored hermes ${hermesRef} to s3://${fleet.bucket}/${hermesBundleKey(hermesRef)}`,
          nowIso(),
        );
      } else {
        /**
         * `false` means there is no published manifest to add the block to —
         * a fleet created with `--skip-artifacts`, or one whose bucket was
         * emptied. The bundle is in the bucket and nothing names it, so every
         * box goes on cloning github.com and the operator would have no way of
         * knowing why. Said out loud, with the command that fixes it.
         */
        yield evt(
          "mirror",
          mirrorProgress,
          `mirrored hermes ${hermesRef} to s3://${fleet.bucket}/${hermesBundleKey(hermesRef)}, ` +
            "but this fleet has no published manifest to name it in, so agents will still clone " +
            `Hermes from ${HERMES_REPO_URL} at boot; run \`hermetic artifacts push\` to publish one`,
          nowIso(),
          "warn",
        );
      }
    }
    checkAbort(opts.signal, "mirror");

    const targets: Agent[] = parsed.all
      ? (await backend.store.agents.scan()).filter((a) => a.status !== "destroyed")
      : [await getAgent(validateName(parsed.name))];

    const owner = `${await actor()}#${randomUUID()}`;

    /**
     * One agent's hermes upgrade. It takes the agent's TTL lock (§4.4) for the
     * same reason `create` and `destroy` do: it rewrites the pin and the
     * `config_hash`, and two operators doing that at once would race the row.
     */
    async function* upgradeOne(target: Agent, index: number): AsyncGenerator<OpEvent> {
      let agent = await acquireLock(target, owner);
      try {
        checkAbort(opts.signal, "upgrade");
        agent = await backend.store.agents.update(agent.name, agent.version, {
          hermes_version: parsed.hermes as string,
        });
        await appendEvent(agent.name, "upgrade", `hermes → ${parsed.hermes}`);

        const rendered = await ensureConfig(agent, fleet);
        if (agent.config_hash !== rendered.config_hash) {
          agent = await backend.store.agents.update(agent.name, agent.version, {
            config_hash: rendered.config_hash,
            resources: { ...agent.resources, config_key: rendered.key },
          });
        }
        yield evt(
          `${agent.name}:render`,
          (index + 1) / targets.length,
          `${agent.name} pinned to hermes ${parsed.hermes}; config ${rendered.config_hash} uploaded — it takes effect on the next recreate`,
          nowIso(),
        );
      } finally {
        const latest = await backend.store.agents.get(agent.name);
        if (latest?.lock?.owner === owner) await releaseLock(latest);
      }
    }

    /**
     * §6.5: the fleet is upgraded one agent at a time.
     *
     * This used to run `--rolling N` agents at once, which needed a queue, a
     * `wake` promise and an `N`-worker pool to feed one generator — about
     * seventy lines whose only job was to interleave events that are then read
     * in sequence anyway. Serial costs wall-clock on a large fleet and buys back
     * a run that can be read top to bottom, a failure that stops at a known
     * agent with the ones before it done and the ones after it untouched, and no
     * second code path in which a partly-applied upgrade can be observed.
     */
    let done = 0;
    let skipped = 0;
    for (const [index, target] of targets.entries()) {
      checkAbort(opts.signal, "upgrade");
      try {
        yield* upgradeOne(target, index);
      } catch (e) {
        /**
         * A fleet-wide `--all` must not abort because one agent is busy: a held
         * lock is another operator's work in progress, not a failure of this
         * one. Everything else stops the run, leaving every agent before this
         * one upgraded and every agent after it untouched.
         */
        if (e instanceof HermeticError && e.code === "LOCKED" && parsed.all) {
          yield evt(
            `${target.name}:skipped`,
            (index + 1) / targets.length,
            `${target.name} is locked by another operator; skipped`,
            nowIso(),
            "warn",
          );
          skipped += 1;
          continue;
        }
        throw e;
      }
      done += 1;
      yield evt(
        `${target.name}:done`,
        (index + 1) / targets.length,
        `${target.name} upgraded`,
        nowIso(),
      );
    }

    yield evt(
      "done",
      1,
      skipped === 0
        ? `pinned ${done} agent(s) to hermes ${parsed.hermes}; each takes it on its next recreate`
        : `pinned ${done} agent(s) to hermes ${parsed.hermes}; skipped ${skipped} held by another operator`,
      nowIso(),
      skipped === 0 ? undefined : "warn",
    );
  }

  return { rerun, reboot, upgrade };
}
