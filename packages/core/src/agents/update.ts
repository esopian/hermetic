/**
 * §6.5 Update: `agent rerun`, `agent reboot`, `upgrade`.
 *
 * These three are one module because they are the three ways an agent is moved
 * forward *without being replaced* — a box asked to re-run its bootstrap
 * stages, a box asked to bounce its operating system, and a version pin moved
 * so the next recreate — or, with `--now`, an in-place converge — picks a newer
 * release up. None of them creates or destroys
 * anything, and all three share the same small vocabulary: the agent row's
 * `command` slot the resident runner polls (§4.2), the §4.4 lock they must not
 * cut across, and the fleet manifest that names the release every box installs.
 *
 * `UpdateDeps` is the honest list of what they need from the SDK closure, same
 * shape as `LifecycleDeps` (`lifecycle.ts`) and `TeardownDeps` (`teardown.ts`).
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
  HERMES_OLD_VERSION_RUNNING,
  HERMES_ROLLBACK_FAILED,
  hermesBundleKey,
  releaseKey,
  RerunInput as RerunInputSchema,
  UpgradeInput as UpgradeInputSchema,
  autoUpdateHermeticd,
} from "../schema/index.ts";
import type {
  Agent,
  AgentRefInput,
  ApplyRequest,
  AgentStatus,
  AgentView,
  OpEvent,
  RerunInput,
  UpgradeInput,
} from "../schema/index.ts";
import { HermeticError } from "../errors.ts";
import { BUILD_VERSIONS } from "../build-versions.ts";
import { hermesRefFor } from "../shared/hermes.ts";
import { validateName } from "../shared/naming.ts";
import { configHermesVersion, requireConfigHermesVersion } from "./config-diff.ts";
import { checkAbort } from "../abort.ts";
import {
  CONVERGE_POLL_MS,
  HERMES_CONVERGE_TIMEOUT_MS,
  HERMES_SWAP_CONVERGE_TIMEOUT_MS,
  convergeDeferral,
  createConverge,
  hermesHeldDown,
  neverApplied,
} from "./converge.ts";
import { LOCK_TTL_MS } from "../fleet/fleet-lock.ts";
import {
  UPGRADE_IDLE_POLL_MS,
  UPGRADE_IDLE_TIMEOUT_MS,
  waitForIdle,
  type BoxBusy,
} from "./upgrade-idle.ts";
import { followRelease, releaseIdentityOf } from "../fleet/hermeticd-rollout.ts";
import type { CoreContext } from "../context.ts";

import { evt } from "../events.ts";
import type { OpOptions } from "../hermetic.ts";

/** What §6.5 needs beyond the shared context: the mirror that refreshes a Hermes ref. */
export interface UpdateDeps {
  ctx: CoreContext;
  /** §3.6's mirror; real by default (rule 6), so an absent one is a type error. */
  hermesMirror: HermesMirrorFn;
  /**
   * How long `upgrade --now` waits for each box to report the new config, and
   * how often it looks. Tests shrink both; a real fleet gets
   * `HERMES_CONVERGE_TIMEOUT_MS` and `CONVERGE_POLL_MS` (`converge.ts`).
   */
  convergeTimeoutMs?: number;
  convergePollMs?: number;
  /**
   * How long `upgrade --hermeticd` watches the fleet take the release when the
   * request names no `rollout_wait_ms`, and how often it looks: the same
   * deployment values `foundation.update` uses (`FoundationDeps`), zero in
   * fixtures and tests.
   */
  rolloutWaitMs?: number | undefined;
  rolloutPollMs?: number | undefined;
  /** Whether a box has a session running, for `--now`'s idle wait (`upgrade-idle.ts`). */
  boxBusy: BoxBusy;
  /** The idle wait's budget and poll; tests shrink both. */
  idleTimeoutMs?: number | undefined;
  idlePollMs?: number | undefined;
}

/**
 * What one agent's `--hermes` upgrade came to, for the run's closing tally.
 * `refused`: the row is as it was — the box stayed busy, or failed before it
 * touched Hermes and the previous pin was put back.
 */
type UpgradeOutcome = "pinned" | "converged" | "skipped" | "unconverged" | "refused";

export function createUpdate(deps: UpdateDeps) {
  const { hermesMirror } = deps;
  const converge = createConverge({
    ctx: deps.ctx,
    timeoutMs: deps.convergeTimeoutMs ?? HERMES_CONVERGE_TIMEOUT_MS,
    pollMs: deps.convergePollMs ?? CONVERGE_POLL_MS,
  });
  /** A version change waits out install, gate and rollback; the test knob shrinks both. */
  const swapConverge = createConverge({
    ctx: deps.ctx,
    timeoutMs: deps.convergeTimeoutMs ?? HERMES_SWAP_CONVERGE_TIMEOUT_MS,
    pollMs: deps.convergePollMs ?? CONVERGE_POLL_MS,
  });
  const {
    backend,
    hermeticdVersion,
    localBuild,
    acquireLock,
    actor,
    assertFleetUnlocked,
    appendEvent,
    assertCanApply,
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
          : agent.status === "paused"
            ? `${agent.name} is paused; use \`hermetic agent resume ${agent.name}\``
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
   *   manifest's `hermeticd.version` — and then, if the fleet auto-updates
   *   hermeticd (or `--now` says so regardless), asks every running box to
   *   take it at once with the `update_request` `foundation.update` writes
   *   (`fleet/hermeticd-rollout.ts`). Otherwise, or with `--no-rollout`, each
   *   box takes it at its own next update check. A name would mean "upgrade
   *   this one box", which the fleet manifest cannot express, so it is refused
   *   rather than silently widened.
   * - `--hermes V` is per-agent, and on its own moves only the pin — the box
   *   goes on running the Hermes it has, and every message says what installs
   *   the pin: the next recreate, or this command again with `--now`. A rollout
   *   or a push defers a row whose pin its box does not run (`hermesDeferral`).
   *   `--now` on a box that is not up does the same and says so.
   * - `--hermes V --now` re-renders and uploads, then asks each box to apply it in place: the
   *   same `apply_request` a rollout writes (`converge.ts`), which hermeticd
   *   picks up on its heartbeat and answers by reinstalling Hermes and
   *   restarting its units. It waits for each box's own report, one agent at a
   *   time, and a box that does not answer in time is reported unconverged,
   *   not failed.
   *
   * `V` is any version with a known upstream ref (`hermesRefFor`): the render
   * derives the ref from the row's pin (`renderAgentRow`), so a box installs
   * exactly the version it is told to assert. Everything that can refuse — an
   * unknown ref, a bundle that cannot be mirrored, a published hermeticd that
   * cannot install the target — refuses before the idle wait and before any
   * row is written.
   */
  async function* upgrade(input: UpgradeInput, opts: OpOptions = {}): AsyncIterable<OpEvent> {
    const parsed = UpgradeInputSchema.parse(input);
    const { fleet, stack } = await guardFleet();
    /**
     * A version with no known ref is refused before either half writes
     * anything: a render pinning it would carry this build's ref beside it,
     * which the box refuses.
     */
    const hermesRef = parsed.hermes === undefined ? null : hermesRefFor(parsed.hermes);
    if (parsed.hermes !== undefined && hermesRef === null) {
      throw new HermeticError(
        "VALIDATION",
        `hermetic knows no upstream ref for Hermes ${parsed.hermes}, so no agent can be pinned to it; nothing was changed`,
        { hermes: parsed.hermes },
      );
    }

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
      const moved = await pointFleetAt(backend.artifacts, backend.store.fleet, {
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
      const alone = parsed.hermes === undefined;
      yield evt(
        "manifest",
        alone ? 0.3 : 0.25,
        `the fleet manifest now names hermeticd ${parsed.hermeticd}`,
        nowIso(),
      );
      /**
       * §6.5: whether the running boxes are asked to take it now — the fleet's
       * `auto_update_hermeticd`, or `--now`/`--no-rollout` over it — decided
       * and done by the rollout every hermeticd publisher shares. After the
       * pointer's lock is given back, and never a failure of this command:
       * the pointer has moved whatever the boxes do. The `--hermes` half, if
       * any, still runs after it.
       */
      yield* followRelease(
        {
          ctx: deps.ctx,
          waitMs: deps.rolloutWaitMs ?? 0,
          pollMs: deps.rolloutPollMs,
        },
        {
          move: {
            before: moved.previous === null ? null : releaseIdentityOf(moved.previous),
            after: releaseIdentityOf(hermeticd),
          },
          options: parsed,
          autoUpdate: autoUpdateHermeticd(moved.fleet.settings),
          phase: "rollout",
          progress: alone ? [0.3, 0.99] : [0.25, 0.4],
          nowCommand: `hermetic upgrade --hermeticd ${parsed.hermeticd} --now`,
          signal: opts.signal,
        },
      );
      if (alone) {
        yield evt("done", 1, `the fleet's release is hermeticd ${parsed.hermeticd}`, nowIso());
        return;
      }
    }

    const version = parsed.hermes as string;
    /**
     * §3.6, and **before** any agent manifest is rewritten: the bundle for the
     * ref those manifests are about to pin has to be in the bucket before a box
     * can be asked to install from it. The manifest write that records it is the
     * last step, as every push's is.
     */
    if (hermesRef === null) throw new HermeticError("INTERNAL", "unreachable: --hermes without a ref");
    const mirrorProgress = parsed.hermeticd === undefined ? 0.05 : 0.45;
    const published = await readFleetManifest(backend.artifacts).catch(() => null);
    const mirror = await hermesMirror({
      ref: hermesRef,
      existing: published?.hermes,
    });
    /**
     * A ref other than this build's that cannot be mirrored may not exist
     * upstream at all, and the box would find out mid-install. This build's own
     * ref keeps the old rule: the box clones it from GitHub instead.
     */
    if (
      mirror.status === "skipped" &&
      hermesRef !== BUILD_VERSIONS.hermes_ref &&
      published?.hermes?.[hermesRef] === undefined
    ) {
      throw new HermeticError(
        "VALIDATION",
        `${mirror.warning ?? `could not mirror Hermes ${hermesRef}`}; Hermes ${version} is not this build's pin, ` +
          "so it is not pinned on an unverified ref. Nothing was changed",
        { hermes: version, ref: hermesRef },
      );
    }
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
    const issuedBy = await actor();
    const now = parsed.now === true;
    const idle = {
      ctx: deps.ctx,
      busy: deps.boxBusy,
      timeoutMs: deps.idleTimeoutMs ?? UPGRADE_IDLE_TIMEOUT_MS,
      pollMs: deps.idlePollMs ?? UPGRADE_IDLE_POLL_MS,
    };
    /**
     * The command that lands a pin in place, as the no-`--now` lines name it —
     * in the order `hermetic upgrade --help` prints its usage, target first.
     */
    const nowCommand = (target: string) => `\`hermetic upgrade ${target} --hermes ${version} --now\``;

    /**
     * Where step `step` (0 to 1) of agent `index`'s own share sits on the run's
     * bar: after the mirror, and short of 1, which only the run's `done` says.
     * Every per-agent event used to carry `(index + 1) / n`, so a one-agent
     * `--now` read 100% from the upload on, through the whole converge wait.
     */
    const barAt = (index: number, step: number): number =>
      mirrorProgress + ((0.98 - mirrorProgress) * (index + step)) / targets.length;

    /**
     * One agent's hermes upgrade. It takes the agent's TTL lock (§4.4) for the
     * same reason `create` and `destroy` do: it rewrites the pin and the
     * `config_hash`, and two operators doing that at once would race the row.
     *
     * With `--now` the converge request is written under the same lock, then
     * the lock is given back *before* the wait — the wait only reads the row,
     * and holding the lock through ten minutes of a slow box would block every
     * other operator's write for nothing.
     */
    /**
     * What the box runs, which a failed swap puts back and the box checks its
     * installed Hermes against (`upgrade_from`). The config is the one it last
     * applied; the version is what the box reports running, else what that
     * config pins. A pin moved without `--now` names a Hermes the box has not
     * installed, so the row's pin is the answer only when nothing else is.
     *
     * A string is the refusal: no applied config to put back, or a box that
     * reports another Hermes than its applied config pins — a swap that passed
     * its gate and failed later — where converging first (`plan rollout`) is
     * what makes the two agree again.
     */
    async function runningOf(
      agent: Agent,
    ): Promise<NonNullable<ApplyRequest["upgrade_from"]> | string> {
      const applied = agent.applied_config_hash ?? null;
      // The box runs the row's own config (or, never having reported one, names none).
      const current = applied === (agent.config_hash ?? null);
      // The row's own applied config is read fail-closed: falling back to a
      // pin moved without `--now` would name a Hermes the box never installed.
      let named: string | null;
      try {
        named =
          current && applied !== null
            ? await requireConfigHermesVersion(backend.artifacts, agent.name, applied)
            : ((await configHermesVersion(backend.artifacts, agent.name, applied)) ??
              (current ? agent.hermes_version : null));
      } catch (e) {
        // Under `--all` one unreadable bundle is that agent's refusal, not the end of the run;
        // `refused` says what was changed, so the error's own "Nothing was changed" goes.
        if (!parsed.all || !(e instanceof HermeticError)) throw e;
        return e.message.replace(". Nothing was changed; ", "; ");
      }
      const converge = `converge it first with \`hermetic plan rollout --agent ${agent.name}\``;
      if (named === null && applied === null) {
        return (
          `its box has never applied a config, so a failed upgrade could not tell which Hermes to put ` +
          `back; ${neverApplied(agent.name)}, or pin another Hermes with ` +
          `\`hermetic upgrade --hermes <version> ${agent.name}\` (no \`--now\`) and then ` +
          `\`hermetic plan recreate ${agent.name}\``
        );
      }
      if (named === null) {
        return (
          `its box has not applied its current config ${agent.config_hash ?? "(none)"}, and the config ` +
          `it did apply cannot be read, so a failed upgrade could not tell which Hermes to put back; ${converge}`
        );
      }
      const running = agent.running_hermes_version ?? null;
      if (running !== null && running !== named) {
        return (
          `its box runs Hermes ${running}, but the config it last applied pins ${named}, so a failed ` +
          `upgrade could not tell which Hermes to put back; ${converge}`
        );
      }
      const key = current ? agent.resources.config_key : `config/${agent.name}/${applied}.tgz`;
      return {
        hermes_version: named,
        config_hash: applied,
        ...(key === undefined ? {} : { config_key: key }),
      };
    }

    /**
     * Refuse a pin-only write that could leave the row naming a Hermes its
     * config does not, while that config has not been applied: the box installs
     * whatever its config names on its next start or apply. Allowed when the
     * pin agrees with the config, or when the box is known to run what the
     * config names (a plain pin for the next recreate). Refused when the config
     * names a Hermes the box does not run (armed: only another `--now` finishes
     * or cancels the move), and when what the box runs is unknown while the
     * row carries a request — `agent stop` clears both reports, so a stopped
     * box that was asked to converge could hold either. Unknown with no
     * request is allowed: no converge was ever asked of this instance, so its
     * box was built from the row's config and holds that Hermes or nothing
     * (a create or recreate that failed, or a clean agent stopped), and the
     * pin is for the next recreate — the way back from a version that does not
     * start. Equal hashes read nothing, and a bundle that cannot be read refuses.
     */
    async function assertNoArmedMove(agent: Agent): Promise<void> {
      const hash = agent.config_hash ?? null;
      const applied = agent.applied_config_hash ?? null;
      if (hash === null || hash === applied || version === agent.hermes_version) return;
      const to = await requireConfigHermesVersion(backend.artifacts, agent.name, hash);
      if (to === version) return;
      const runs =
        agent.running_hermes_version ??
        (applied === null
          ? null
          : await requireConfigHermesVersion(backend.artifacts, agent.name, applied));
      if (runs === to) return;
      if (runs === null && (agent.apply_request ?? null) === null) return;
      if (runs === null) {
        const up = convergeDeferral(agent) === null;
        throw new HermeticError(
          "HERMES_UPGRADE_REQUIRED",
          `${agent.name} ${up ? "has not reported which Hermes it runs" : `is not up (${agent.status})`}, ` +
            `so hermetic cannot tell which Hermes its box holds, and its config ${hash} names ${to}; ` +
            "a stopped agent is pinned to another Hermes only once it is up. Nothing was changed; " +
            (up
              ? "wait for its box to report and run this again"
              : `start it (\`hermetic agent start ${agent.name}\`) and run this again`) +
            `, or \`hermetic plan recreate ${agent.name}\` to keep it on ${agent.hermes_version}`,
          {
            name: agent.name,
            hermes_version: version,
            config_hermes: to,
            running_hermes_version: null,
          },
        );
      }
      throw new HermeticError(
        "HERMES_UPGRADE_REQUIRED",
        `${agent.name}'s config ${hash} names Hermes ${to}, but its box runs ${runs} and has not applied ` +
          `it, so an upgrade is unfinished and its box installs ${to} on its next start or apply. Nothing was ` +
          `changed; finish it with \`hermetic upgrade --hermes ${to} ${agent.name} --now\`, or cancel it with ` +
          `\`hermetic upgrade --hermes ${runs} ${agent.name} --now\``,
        { name: agent.name, hermes_version: version, config_hermes: to, running_hermes_version: runs },
      );
    }

    async function* upgradeOne(listed: Agent, index: number): AsyncGenerator<OpEvent, UpgradeOutcome> {
      // Re-read: under `--all` the row was listed before earlier agents' waits,
      // and a box that came up since is waited on like any other.
      const target = await getAgent(listed.name);
      const progress = barAt(index, 1);
      const refused = (name: string, why: string, changed = "nothing was changed"): OpEvent =>
        evt(
          `${name}:refused`,
          progress,
          `${name} not upgraded — ${why}, and ${changed}`,
          nowIso(),
          "warn",
        );
      /**
       * D4, before the idle wait and before anything is written: the published
       * hermeticd must be able to install the target (its message names
       * `hermetic artifacts push`), and `--now` must know what to put back.
       */
      await assertCanApply({ ...target, hermes_version: version }, fleet);
      const live = now && convergeDeferral(target) === null;
      if (live) {
        const from = await runningOf(target);
        if (typeof from === "string") {
          yield refused(target.name, from);
          return "refused";
        }
      }
      /**
       * A refused wait publishes nothing. A box that is not up has nothing
       * running to cut and only has its pin recorded below, so it is not waited on.
       */
      if (live && parsed.force !== true) {
        if (!(yield* waitForIdle(idle, target, barAt(index, 0.1), opts.signal))) {
          yield refused(
            target.name,
            `it did not show idle within ${String(Math.round(idle.timeoutMs / 60_000))}m; ` +
              "try again later, or add --force to stop Hermes mid-session",
          );
          return "refused";
        }
      }
      let agent = await acquireLock(await getAgent(target.name), owner);
      // An earlier upgrade the box answered after its wait ended is settled
      // first, so `before` is the Hermes the box actually runs.
      let settled: string | null = null;
      try {
        ({ agent, code: settled } = await converge.reconcileRolledBack(agent, issuedBy));
      } catch (e) {
        await releaseLock(agent).catch(() => undefined);
        throw e;
      }
      // The reconcile above did write, so a refusal from here on must not say "nothing was changed".
      const reconciled =
        settled === null
          ? undefined
          : `the earlier upgrade its box did not apply (${settled}) was reconciled back to Hermes ` +
            `${agent.hermes_version}, and the pin was not moved`;
      /** What this run writes over, put back if it fails before the box is asked. */
      const original = {
        hermes_version: agent.hermes_version,
        config_hash: agent.config_hash ?? null,
        config_key: agent.resources.config_key,
        request: agent.apply_request?.id,
      };
      let before: NonNullable<ApplyRequest["upgrade_from"]> | null = null;
      let asked: string | null = null;
      let requestId: string | undefined;
      let wrote = false;
      // Set once what this run wrote is complete: the outcome it returns, or a request the box answers.
      let finished = false;
      try {
        checkAbort(opts.signal, "upgrade");
        /**
         * Without `--now`, or with it on a box that is not up, the pin is all
         * that moves: no render, no upload, no converge. A config naming
         * another Hermes never reaches the box this way, so a boot, a start or
         * a rerun resumes the config it already has; a recreate renders the
         * pin, and `--now` on a box that is up lands it in place.
         */
        const down = convergeDeferral(agent);
        if (!now || down !== null) {
          await assertNoArmedMove(agent).catch((e: unknown) => {
            if (reconciled === undefined || !(e instanceof HermeticError)) throw e;
            throw new HermeticError(
              e.code,
              e.message.replace(
                "Nothing was changed",
                reconciled.charAt(0).toUpperCase() + reconciled.slice(1),
              ),
              e.details,
            );
          });
          wrote = true;
          agent = await backend.store.agents.update(agent.name, agent.version, {
            hermes_version: version,
          });
          await appendEvent(agent.name, "upgrade", `hermes → ${version} (pinned; nothing applied)`);
          finished = true;
          if (now) {
            yield evt(
              `${agent.name}:skipped`,
              progress,
              `${agent.name} is not up (${down ?? agent.status}), so nothing was applied; the pin to hermes ` +
                `${version} is recorded — start it and run ${nowCommand(agent.name)} again, or ` +
                `\`hermetic plan recreate ${agent.name}\``,
              nowIso(),
              "warn",
            );
            return "skipped";
          }
          yield evt(
            `${agent.name}:render`,
            progress,
            `${agent.name} pinned to hermes ${version} — nothing on its box changes; it takes effect on ` +
              `the next recreate, or now with ${nowCommand(agent.name)}`,
            nowIso(),
          );
          return "pinned";
        }
        // A box that came up after the read above had no idle wait, and is not
        // cut mid-turn without `--force`.
        if (!live && parsed.force !== true) {
          yield refused(
            agent.name,
            `it came up while this run was starting (${target.status} → ${agent.status}), so it was not ` +
              `waited on; run ${nowCommand(agent.name)} again`,
            reconciled,
          );
          return "refused";
        }
        // Asked again under the lock: the row may have moved during the wait.
        const back = await runningOf(agent);
        if (typeof back === "string") {
          yield refused(agent.name, back, reconciled);
          return "refused";
        }
        before = back;
        /**
         * The bundle goes up first, then pin, hash and key land in one row
         * write, so no crash can leave a pin without its config or the reverse.
         */
        const rendered = await ensureConfig({ ...agent, hermes_version: version }, fleet);
        wrote = true;
        agent = await backend.store.agents.update(agent.name, agent.version, {
          hermes_version: version,
          config_hash: rendered.config_hash,
          resources: { ...agent.resources, config_key: rendered.key },
        });
        await appendEvent(agent.name, "upgrade", `hermes → ${version}`);
        yield evt(
          `${agent.name}:render`,
          barAt(index, 0.25),
          `${agent.name} pinned to hermes ${version}; config ${rendered.config_hash} uploaded`,
          nowIso(),
        );

        if (agent.applied_config_hash === rendered.config_hash) {
          finished = true;
          yield evt(
            `${agent.name}:done`,
            progress,
            `${agent.name} already runs config ${rendered.config_hash}`,
            nowIso(),
          );
          return "converged";
        }
        // `upgrade_from` always: it is the box's consent to change Hermes, and the pin to put back.
        try {
          agent = await converge.request(agent, rendered.config_hash, issuedBy, "upgrade", before);
        } catch (e) {
          // The row write may have landed before the event append failed: a
          // request of this run's on the row is one the box will answer.
          const latest = await backend.store.agents.get(agent.name);
          const req = latest?.apply_request;
          if (
            !latest ||
            !req ||
            req.id === original.request ||
            req.config_hash !== rendered.config_hash
          ) {
            throw e;
          }
          agent = latest;
        }
        asked = rendered.config_hash;
        requestId = agent.apply_request?.id;
        finished = true;
      } finally {
        /**
         * I5: a run that stops after the pin moved and before the box was
         * asked — a throw, or a consumer that stopped iterating at a yield
         * (a generator's `return()` skips `catch`) — leaves the row naming a
         * Hermes nothing will install, so what this run wrote is put back:
         * only once a re-read shows no request of this run's on the row, since
         * the box answers one that is there.
         */
        if (wrote && !finished) {
          const latest = await backend.store.agents.get(agent.name);
          const unasked = latest?.apply_request?.id === original.request;
          if (latest && latest.lock?.owner === owner && unasked) {
            const { config_key: _, ...resources } = latest.resources;
            await backend.store.agents
              .update(latest.name, latest.version, {
                hermes_version: original.hermes_version,
                config_hash: original.config_hash,
                resources:
                  original.config_key === undefined
                    ? resources
                    : { ...resources, config_key: original.config_key },
              })
              .catch(() => undefined);
          }
        }
        const latest = await backend.store.agents.get(agent.name);
        if (latest?.lock?.owner === owner) await releaseLock(latest);
      }
      // Only `--now` with a box that is up reaches the request above.
      const from = before as NonNullable<typeof before>;

      yield evt(
        `${agent.name}:requested`,
        barAt(index, 0.5),
        `${agent.name} asked to apply ${asked}; waiting for the box to restart Hermes on ${version}`,
        nowIso(),
      );
      const waiter = from.hermes_version === version ? converge : swapConverge;
      const outcome = await waiter.waitForConverge(agent.name, asked, opts.signal, requestId);
      // An abort ends the wait early; it is the operator hanging up, not a box
      // that stayed silent, and is reported as such rather than as unconverged.
      checkAbort(opts.signal, "converge");
      if (outcome === "converged") {
        yield evt(
          `${agent.name}:done`,
          progress,
          `${agent.name} is running hermes ${version} (config ${asked})`,
          nowIso(),
        );
        return "converged";
      }
      if (outcome === "failed") {
        const failed = await getAgent(agent.name);
        const code = failed.apply_failure?.code ?? "INTERNAL";
        if (hermesHeldDown(code)) {
          const undo = code === HERMES_ROLLBACK_FAILED ? "roll back" : "restore its previous Hermes";
          const why =
            `${agent.name} failed hermes ${version} and could not ${undo} (${code}): Hermes is down on the box. ` +
            `Nothing was deleted; \`hermetic agent history ${agent.name}\` names the backup and the ` +
            "state moved aside";
          yield evt(`${agent.name}:failed`, progress, why, nowIso(), "error");
          throw new HermeticError("HERMES_UPGRADE_FAILED", why, {
            name: agent.name,
            hermes: version,
            code,
          });
        }
        if (!HERMES_OLD_VERSION_RUNNING.includes(code)) {
          yield evt(
            `${agent.name}:failed`,
            progress,
            `${agent.name} failed to apply config ${asked} (${code}); the pin to hermes ${version} ` +
              `stands, so the next apply repairs forward — \`hermetic agent history ${agent.name}\` has what it said`,
            nowIso(),
            "warn",
          );
          return "unconverged";
        }
        /**
         * The box still runs the version it had — it stopped before touching
         * the checkout, or rolled back to it — so the row goes back to naming
         * it, unless someone moved the row on since, whose pin this must not undo.
         */
        const rolledBack = code === "HERMES_UPGRADE_ROLLED_BACK";
        /**
         * The lock was given back for the wait, so another operation may hold
         * it now. That must not turn this outcome into `--all`'s "locked;
         * skipped": the pin waits for the next writer, which reconciles first.
         */
        const row = await acquireLock(failed, owner).catch((e: unknown) => {
          if (e instanceof HermeticError && e.code === "LOCKED") return null;
          throw e;
        });
        if (row !== null) {
          try {
            await converge.reconcileRolledBack(row, issuedBy);
          } finally {
            const latest = await backend.store.agents.get(row.name);
            if (latest?.lock?.owner === owner) await releaseLock(latest);
          }
        }
        const pinNow =
          row !== null
            ? `its pin is back to ${from.hermes_version}`
            : `its pin could not be restored yet (another operation holds ${agent.name}'s lock); ` +
              `the next upgrade or rollout of ${agent.name} puts it back to ${from.hermes_version}`;
        if (rolledBack) {
          // The new version is bad on this box: the run fails here rather than
          // carrying it to the next one.
          const why =
            `${agent.name} rolled back and is running hermes ${from.hermes_version}; the upgrade to ` +
            `${version} failed on the box (${code}), and ${pinNow} — ` +
            `\`hermetic agent history ${agent.name}\` has the box's timeline and backup`;
          yield evt(`${agent.name}:failed`, progress, why, nowIso(), "error");
          throw new HermeticError("HERMES_UPGRADE_ROLLED_BACK", why, {
            name: agent.name,
            hermes: version,
            running: from.hermes_version,
            code,
          });
        }
        yield evt(
          `${agent.name}:refused`,
          progress,
          `${agent.name} refused hermes ${version} before touching its Hermes (${code}) and still runs ` +
            `${from.hermes_version}; ${pinNow} — ` +
            `\`hermetic agent history ${agent.name}\` has what it said`,
          nowIso(),
          "warn",
        );
        return "refused";
      }
      yield evt(
        `${agent.name}:unconverged`,
        progress,
        waiter.unconvergedMessage(agent.name, asked),
        nowIso(),
        "warn",
      );
      return "unconverged";
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
     * second code path in which a partly-applied upgrade can be observed. With
     * `--now` it is also what keeps a pin that breaks Hermes to one box.
     */
    let done = 0;
    let locked = 0;
    let converged = 0;
    let deferred = 0;
    let unconverged = 0;
    let refused = 0;
    for (const [index, target] of targets.entries()) {
      checkAbort(opts.signal, "upgrade");
      let outcome: UpgradeOutcome;
      try {
        outcome = yield* upgradeOne(target, index);
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
            barAt(index, 1),
            `${target.name} is locked by another operator; skipped`,
            nowIso(),
            "warn",
          );
          locked += 1;
          continue;
        }
        // A pin this row's state refuses (`assertNoArmedMove`) is thrown before
        // anything of this run's is written; under `--all` it is that agent's
        // refusal, and a single agent still fails with it.
        if (e instanceof HermeticError && e.code === "HERMES_UPGRADE_REQUIRED" && parsed.all) {
          yield evt(`${target.name}:refused`, barAt(index, 1), e.message, nowIso(), "warn");
          refused += 1;
          continue;
        }
        const rest = targets.slice(index + 1).map((a) => a.name);
        if (
          e instanceof HermeticError &&
          (e.code === "HERMES_UPGRADE_ROLLED_BACK" || e.code === "HERMES_UPGRADE_FAILED") &&
          rest.length > 0
        ) {
          throw new HermeticError(e.code, `${e.message}; not attempted: ${rest.join(", ")}`, {
            ...e.details,
            not_attempted: rest,
          });
        }
        throw e;
      }
      if (outcome === "refused") {
        refused += 1;
        continue;
      }
      done += 1;
      if (outcome === "converged") converged += 1;
      else if (outcome === "skipped") deferred += 1;
      else if (outcome === "unconverged") unconverged += 1;
      else {
        yield evt(`${target.name}:done`, barAt(index, 1), `${target.name} upgraded`, nowIso());
      }
    }

    if (now) {
      const skipped = locked + deferred;
      yield evt(
        "done",
        1,
        `pinned ${done} agent(s) to hermes ${version}: ${converged} converged, ` +
          `${skipped} skipped, ${unconverged} unconverged` +
          (refused === 0 ? "" : `; ${refused} refused and left as they were`),
        nowIso(),
        skipped + unconverged + refused === 0 ? undefined : "warn",
      );
      return;
    }
    const target = parsed.all ? "--all" : (parsed.name as string);
    yield evt(
      "done",
      1,
      `pinned ${done} agent(s) to hermes ${version}; ` +
        (locked === 0 ? "" : `skipped ${locked} held by another operator; `) +
        (refused === 0 ? "" : `${refused} refused and left as they were; `) +
        `each takes it on its next recreate, or now with ${nowCommand(target)}`,
      nowIso(),
      locked + refused === 0 ? undefined : "warn",
    );
  }

  return { rerun, reboot, upgrade };
}
