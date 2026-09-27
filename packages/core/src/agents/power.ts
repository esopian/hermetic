/**
 * `agents.stop` and `agents.start` (§6.6): powering an agent's instance off and
 * on again, leaving the data volume where it is.
 *
 * The two are one module because they are one subject — the §4.3 edges
 * `ready → stopping → stopped` and `stopped → bootstrapping`, and the rule that
 * the row does not claim `stopped` until EC2 agrees — and because neither of
 * them shares a line of closure state with `create` or `recreate`. Lifting them
 * out of `lifecycle.ts` is what keeps that file under the 2500-line cap its own
 * header explains.
 *
 * `PowerDeps` is the honest list of what they need from the SDK closure. Same
 * shape as `LifecycleDeps` (`lifecycle.ts`), `DestroyDeps` (`destroy-agent.ts`),
 * `TeardownDeps` (`teardown.ts`) and `PlanDeps` (`plans.ts`).
 */
import { randomUUID } from "node:crypto";
import type { OpEvent } from "../schema/index.ts";
import { HermeticError, isHermeticError } from "../errors.ts";
import { validateName } from "../shared/naming.ts";
import type { InstanceRef } from "../backend/types.ts";
import { ATTACH_POLL_MS, ATTACH_PROGRESS_MS, elapsed } from "./attach.ts";
import { abandoned, abortableSleep, checkAbort } from "../abort.ts";
import { evt } from "../events.ts";
import type { OpOptions } from "../hermetic.ts";
import type { CoreContext } from "../context.ts";

/** `stop` and `start` need nothing beyond the shared context. */
export interface PowerDeps {
  ctx: CoreContext;
}

export function createPower(deps: PowerDeps) {
  const {
    acquireLock,
    actor,
    appendEvent,
    attachDeps,
    backend,
    getAgent,
    guardFleet,
    lockKeeper,
    nowIso,
    releaseLock,
    transition,
    unwind,
  } = deps.ctx;

  /**
   * How many polls in a row must find nothing before `waitInstanceStopped` calls
   * the instance gone.
   *
   * `describeInstance` returns `null` for two quite different worlds: the
   * instance genuinely no longer exists, and EC2's eventually-consistent
   * `DescribeInstances` answered `InvalidInstanceID.NotFound` about one that does
   * — which is most likely in exactly the seconds after `StopInstances`, i.e.
   * exactly when this wait is polling. One unlucky read used to end the wait and
   * write `stopped` over a box still shutting down, which is the lie this whole
   * function exists to stop telling. A single miss is therefore just another wait
   * iteration; two, separated by a full `pollMs`, are an answer.
   */
  const MISSING_POLLS_TO_CONFIRM = 2;

  /**
   * Instance states `StopInstances` can do something about, and therefore the
   * only ones that make a row saying `stopped` worth acting on. Deliberately an
   * allow-list: EC2's state vocabulary is theirs to extend, and a state nobody
   * here has heard of is not one to send a stop into (§4.5).
   */
  const STOPPABLE_STATES = new Set(["pending", "running", "stopping"]);

  /**
   * Wait until EC2 says the instance is actually `stopped`.
   *
   * `StopInstances` returns as soon as the request is *accepted*; the box then
   * spends anywhere from seconds to minutes in `stopping`. `stop` used to write
   * the row to `stopped` on that acceptance, so `hermetic agent stop x` finished
   * in two seconds against an instance that was still shutting down — and the
   * `agent start x` an operator typed straight after was refused by EC2 with "the
   * instance is not in a state from which it can be started", while the row and
   * the dashboard both said `stopped`. `start`'s guard on the row is right; the
   * row was lying. §4.3's `ready → stopping → stopped` exists precisely to name
   * this window, so `stopping` is where the row stays until EC2 agrees.
   *
   * Unbounded and abort-aware for `attach.ts`'s reason: a slow shutdown is not a
   * failure, and there is no deadline after which powering a box off becomes
   * wrong. Aborting leaves the row in `stopping`, which is honest — the stop was
   * asked for and is still happening — and `stop` is re-entrant from there.
   *
   * An instance that is gone is not a failure: there is nothing left running,
   * which is all `stop` promised. An instance that is *terminating* is a
   * different animal — see below.
   */
  async function* waitInstanceStopped(
    instanceId: string,
    opts: OpOptions,
    heartbeat: () => Promise<void>,
  ): AsyncIterable<OpEvent> {
    const wait = attachDeps();
    const now = wait.now ?? Date.now;
    const pollMs = wait.pollMs ?? ATTACH_POLL_MS;
    const progressMs = wait.progressMs ?? ATTACH_PROGRESS_MS;

    const started = now();
    let lastSaid = 0;
    /** Only worth announcing the stop landing if the operator was made to wait. */
    let waited = false;
    /** Consecutive polls that found nothing; see `MISSING_POLLS_TO_CONFIRM`. */
    let missed = 0;

    for (;;) {
      checkAbort(opts.signal, "stop");
      await heartbeat();

      const live = await wait.compute.describeInstance(instanceId);
      if (live) missed = 0;
      if (!live && (missed += 1) >= MISSING_POLLS_TO_CONFIRM) {
        yield evt(
          "instance",
          0.8,
          `instance ${instanceId} is gone; nothing left to stop`,
          nowIso(),
          "warn",
        );
        return;
      }
      if (live?.state === "terminated") {
        yield evt(
          "instance",
          0.8,
          `instance ${instanceId} is terminated; nothing left to stop`,
          nowIso(),
          "warn",
        );
        return;
      }
      if (live?.state === "shutting-down") {
        /**
         * Not a slow stop — a *terminate*, asked for by something that is not
         * this run. It will never reach `stopped`, so waiting is pointless, and
         * writing the row `stopped` would name a box that is being deleted as one
         * an operator can `start` again. `stop`'s catch runs `unwind`, which
         * releases the lock and records the failure, leaving the row in
         * `stopping` — honest about what was asked for, and re-runnable once the
         * terminate has landed.
         */
        throw new HermeticError(
          "CONFLICT",
          `instance ${instanceId} is shutting down (terminating), not stopping; run \`hermetic agent recreate\``,
          { instance_id: instanceId, state: live.state },
        );
      }
      if (live?.state === "stopped") {
        if (waited) {
          yield evt(
            "instance",
            0.8,
            `instance ${instanceId} stopped after ${elapsed(now() - started)}`,
            nowIso(),
            undefined,
            "done",
          );
        }
        return;
      }

      if (!waited || now() - lastSaid >= progressMs) {
        lastSaid = now();
        waited = true;
        yield evt(
          "instance",
          0.6,
          live
            ? `waiting for ${instanceId} to stop (${elapsed(now() - started)} so far)`
            : `EC2 does not know ${instanceId} yet; reading again before calling it gone`,
          nowIso(),
        );
      }
      await abortableSleep(pollMs, opts.signal);
    }
  }

  async function* stop(name: string, opts: OpOptions = {}): AsyncIterable<OpEvent> {
    validateName(name);
    await guardFleet();
    let agent = await getAgent(name);

    /**
     * `stopped` on the row is a claim, not evidence, and `stop` was the one
     * lifecycle op that acted on the claim alone — `destroy`, `start` and
     * `recreate` all ask EC2 first (§4.5). Two ordinary ways the row lies: a
     * `start` whose transition write failed after `StartInstances` was accepted,
     * and a box somebody started from the console. Either leaves a running,
     * billing instance that every later `hermetic agent stop` would no-op on
     * forever, because the shortcut returned before anything looked.
     *
     * So the shortcut is taken only once EC2 agrees. When it does not, the run
     * carries on and stops the box — *without* moving the status: `stopped` is
     * already where this run is going, §4.3 has no `stopped → stopping` edge, and
     * inventing one to describe a row that is merely ahead of reality would make
     * the table mean less. The final `transition` to `stopped` is then a
     * re-entry (`state.ts`), which writes the facts and no history line.
     */
    const drifted = agent.status === "stopped";
    let driftedFrom: string | null = null;
    if (drifted) {
      const recorded = agent.resources.instance_id ?? agent.instance_id ?? null;
      /**
       * The extra read must not be able to *break* a command that used to need no
       * read at all. A throttle, an expired session, a describe that fails for any
       * reason: the row already says `stopped`, so the honest answer is the one
       * this command has always given, plus a line saying EC2 was not asked.
       * Turning "your stopped agent is stopped" into a failed op because AWS was
       * busy would be a worse bug than the one this check exists to fix.
       */
      let live: InstanceRef | null;
      try {
        live = recorded === null ? null : await backend.compute.describeInstance(recorded);
      } catch (e) {
        yield evt(
          "done",
          1,
          `${name} is recorded as stopped; EC2 could not be asked to confirm it (${isHermeticError(e) ? e.code : "INTERNAL"})`,
          nowIso(),
          "warn",
        );
        return;
      }
      /**
       * Only states `StopInstances` can act on. Everything else — `stopped`,
       * `terminated`, a box already `shutting-down` under a terminate somebody
       * else asked for, or a state EC2 has invented since this was written — is
       * left alone: `stop` promised that nothing is running, and asking EC2 to
       * stop a dying instance earns an `IncorrectInstanceState` that names
       * neither the agent nor the fix.
       */
      if (live === null || !STOPPABLE_STATES.has(live.state)) {
        if (live !== null && live.state !== "stopped") {
          yield evt(
            "instance",
            0.5,
            `instance ${recorded} is ${live.state}; there is nothing for stop to do to it`,
            nowIso(),
            "warn",
          );
        }
        yield evt("done", 1, `${name} is already stopped`, nowIso());
        return;
      }
      driftedFrom = live.state;
    }

    const owner = `${await actor()}#${randomUUID()}`;
    agent = await acquireLock(agent, owner);
    /**
     * The wait below can outlive `LOCK_TTL_MS` on a slow shutdown, and a lock
     * that expires under a still-running stop lets a second operator walk in
     * (§4.4) — so the wait renews it on every poll, the same way `create`'s
     * attach and `destroy`'s detach do.
     */
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
      checkAbort(opts.signal, "stop");
      if (drifted) {
        // The row and EC2 disagreed; say so once, on the op stream and on the
        // agent's history, because a row that was wrong about a running box is
        // the kind of thing an operator wants to be able to find afterwards.
        const said = `${name} is recorded as stopped but instance ${agent.resources.instance_id ?? agent.instance_id} is ${driftedFrom}; stopping it`;
        await appendEvent(name, "stop", said);
        yield evt("instance", 0.2, said, nowIso(), "warn");
      } else {
        // Re-entrant for the same reason destroy is: a stop that died after
        // `StopInstances` was accepted — or was aborted while waiting for EC2 to
        // finish — left the row in `stopping`, where the §4.3 table has no
        // self-edge and every retry threw before reaching the box.
        agent = await transition(agent, "stopping", "stop requested");
      }

      const instanceId = agent.resources.instance_id ?? agent.instance_id;
      if (!instanceId) {
        yield evt("instance", 0.4, "no instance on the agent row; nothing to stop", nowIso());
      } else {
        const live = await backend.compute.describeInstance(instanceId);
        if (!live || live.state === "terminated") {
          yield evt(
            "instance",
            0.4,
            `instance ${instanceId} is already ${live?.state ?? "gone"}`,
            nowIso(),
            "warn",
          );
        } else if (live.state === "stopped") {
          yield evt("instance", 0.4, `instance ${instanceId} is already stopped`, nowIso());
        } else {
          if (live.state === "stopping") {
            // Somebody (or a previous run of this stop) already asked. Asking
            // again is not wrong, but it is not needed either; join the wait.
            yield evt("instance", 0.4, `instance ${instanceId} is already stopping`, nowIso());
          } else {
            await backend.compute.stop(instanceId);
            yield evt("instance", 0.4, `stopping instance ${instanceId}`, nowIso());
          }
          // The row does not say `stopped` until EC2 does.
          yield* waitInstanceStopped(instanceId, opts, keepLock);
        }
      }

      agent = await transition(agent, "stopped", "instance stopped", {
        // A powered-off box holds neither its address nor its MagicDNS name: the
        // next boot re-registers and may well be admitted under a different one
        // (§6.5), so keeping the old name would point every link at a dead node.
        tailscale_ip: null,
        tailscale_dns_name: null,
        // Including the `tailscaled` it was running: Tailscale's updater runs on
        // the box, so a version read before it was switched off says nothing
        // about the one it will answer with when it comes back.
        tailscale_version: null,
        last_heartbeat: null,
        metrics: null,
        // And it is reporting nothing, so the three things only it can report go
        // too. A stopped box that kept its last applied config and binary digest
        // would answer `configVerdict` and the rollout's digest check from a
        // reading taken before it was switched off — and it may be started again
        // onto a manifest that has moved since.
        applied_config_hash: null,
        running_hermeticd_sha256: null,
        running_hermes_version: null,
      });
      await releaseLock(agent);
      // Set before the yield: a consumer that stops at the done event resumes
      // this generator with a `return`, which runs `finally` (see `create`).
      done = true;
      yield evt("done", 1, `${name} stopped; the data volume is untouched`, nowIso());
    } catch (e) {
      failure = e;
      throw e;
    } finally {
      if (!done) await unwind(name, "stop", owner, failure ?? abandoned(name, "stop"));
    }
  }

  async function* start(name: string, opts: OpOptions = {}): AsyncIterable<OpEvent> {
    validateName(name);
    await guardFleet();
    let agent = await getAgent(name);
    if (agent.status !== "stopped") {
      throw new HermeticError(
        "INVALID_TRANSITION",
        `${name} is ${agent.status}; only a stopped agent can be started`,
        { name, status: agent.status },
      );
    }
    const owner = `${await actor()}#${randomUUID()}`;
    agent = await acquireLock(agent, owner);
    /** See `abandoned`. */
    let done = false;
    let failure: unknown = null;
    try {
      checkAbort(opts.signal, "start");
      const instanceId = agent.resources.instance_id ?? agent.instance_id;
      if (!instanceId) {
        throw new HermeticError(
          "CONFLICT",
          `${name} has no instance to start; use \`hermetic agent recreate ${name}\``,
          { name },
        );
      }
      const instance = await backend.compute.start(instanceId);
      yield evt("instance", 0.5, `instance ${instance.instance_id} starting`, nowIso());
      /**
       * A restarted instance re-runs bootstrap and reports from there (§4.3) —
       * but on the *same* root disk, so `bootstrap` stays: the stage markers are
       * still there and the re-run of the oneshot unit is a fast no-op resume
       * (§6.3). That is what makes this unlike `recreate`, which gets a fresh disk
       * and so must clear the previous boot's progress. `command` is cleared
       * either way, and as a *fact*: it addressed the run that just ended, and an
       * unacknowledged one left behind would refuse every future `agent rerun`
       * with CONFLICT (§6.5). `bootstrap.last_command_id`, the ack ledger, is
       * untouched. `health` goes for the same reason `recreate`'s drain clears
       * it: `stop` leaves the last reading of a box that was then powered off,
       * and it must not sit green on the board while this one boots.
       */
      agent = await transition(
        agent,
        "bootstrapping",
        "instance started",
        { instance_id: instance.instance_id },
        { command: null, health: null },
      );
      await releaseLock(agent);
      // Set before the yield: a consumer that stops at the done event resumes
      // this generator with a `return`, which runs `finally` (see `create`).
      done = true;
      yield evt("done", 1, `${name} starting; hermeticd will report when it is ready`, nowIso());
    } catch (e) {
      failure = e;
      throw e;
    } finally {
      if (!done) await unwind(name, "start", owner, failure ?? abandoned(name, "start"));
    }
  }

  return { stop, start };
}
