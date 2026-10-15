/**
 * §6.5's converge step, shared by the two commands that ask a running box to
 * apply a configuration *now*: `plan.rollout`'s `apply` (`rollout.ts`) and
 * `upgrade --hermes V --now` (`update.ts`).
 *
 * ## Why it is a module of its own
 *
 * Both commands do the same two things to one agent once a fresh render has
 * been uploaded and stamped on the row, and the second one to arrive was about
 * to grow a copy of the first: put an `apply_request` on the row so the box's
 * heartbeat notices, and then poll the row until the box's own
 * `applied_config_hash` reaches the hash that was asked for. A copy would have
 * been two ideas of what "converged" means, drifting apart one bug fix at a
 * time. What differs between the two callers — which agents, what they render,
 * what they say about it — stays with the callers; this is only the part that
 * must not differ.
 *
 * ## What it is careful about
 *
 * - **The caller holds the lock.** `request` writes the row under the
 *   §4.4 TTL lock the caller took, and never take or release it themselves: the
 *   caller decides how a held lock is reported (rollout and `upgrade --all` skip
 *   it, a single `upgrade` throws), and the caller is the one that must give the
 *   lock back *before* `wait` — the wait is a read loop, and a second operator
 *   must not be blocked behind a box that is slow to answer.
 * - **Nothing acks.** "Done" is the box's own `applied_config_hash`, which the
 *   heartbeat already reports; see `rollout.ts` for why an ack field would have
 *   been worse. A box whose hermeticd predates converge support ignores the
 *   request, its hash never moves, and the caller reports it unconverged.
 * - **Counted looks, not a deadline.** See `waitForConverge`.
 *
 * ## The limit it inherits
 *
 * A converge applies the configuration the *row* names, rendered by this
 * checkout. Rows carry `hermes_version` but no `hermes_ref`, and every render
 * pins `BUILD_VERSIONS.hermes_ref` (`renderFor`, `agent-runtime.ts`), so an
 * in-place Hermes upgrade can only ever move a box toward the ref *this build*
 * pins — exactly the limit `recreate` has, and for the same reason. When the
 * row gains a ref of its own, both inherit the fix through the render.
 */
import { abortableSleep } from "../abort.ts";
import type { CoreContext } from "../context.ts";
import type { Agent, AgentStatus } from "../schema/index.ts";
import { memoryProviderIsService } from "../shared/memory-providers.ts";

/** How long one box gets to pick up a configuration-only request and report the new hash. */
export const CONVERGE_TIMEOUT_MS = 5 * 60_000;
/** How often the row is re-read while waiting. The box heartbeats every 30 s. */
export const CONVERGE_POLL_MS = 10_000;

/**
 * How long one box gets to converge onto a new Hermes version: twice a
 * rollout's budget, because the work is of a different size.
 *
 * A rollout's converge usually rewrites a few files and restarts units. A
 * converge that moves `hermes_version` also runs `ensureHermes`
 * (`packages/agentd/src/apply/hermes.ts`): it rebuilds the Hermes virtualenv
 * from the mirrored bundle before the units restart, and that install measured
 * about 140 s on a fresh box at first boot. Add the heartbeat tick that has to
 * notice the request (30 s) and the one that reports the result (30 s more),
 * and five minutes is uncomfortably close to a box doing its job slowly. Ten
 * leaves room for a cold package cache without letting a wedged box hold an
 * operator for ever — and a timeout here is a warning, not a failure.
 */
export const HERMES_CONVERGE_TIMEOUT_MS = 10 * 60_000;

/**
 * How long a rollout waits for one agent: `HERMES_CONVERGE_TIMEOUT_MS` when
 * its row names a memory provider that runs a server, `CONVERGE_TIMEOUT_MS`
 * otherwise.
 *
 * The first apply after `agent set --memory` onto a server provider installs
 * that server live (§6.2): honcho's apt packages, uv sync and initdb,
 * hindsight's pip install, openviking's embedding-model download, then a
 * readiness wait of up to a minute. That is the same order of work as a Hermes
 * upgrade, so it gets the same budget. The wait ends as soon as the box
 * reports, so the longer budget only lengthens a box that is not answering —
 * and an unconverged box is a warning, not a failure.
 */
export function rolloutConvergeTimeoutMs(agent: Pick<Agent, "memory">): number {
  const provider = agent.memory?.provider;
  return provider !== undefined && memoryProviderIsService(provider)
    ? HERMES_CONVERGE_TIMEOUT_MS
    : CONVERGE_TIMEOUT_MS;
}

/**
 * Statuses a converge can be asked of. A box that is not up cannot apply
 * anything, and saying so per agent is more useful than a plan that pretends
 * otherwise: `stopped` is a deliberate state an operator chose, `creating` and
 * `bootstrapping` are already applying *this* config on their own, and
 * `destroyed` has no box at all.
 */
export const CONVERGEABLE: readonly AgentStatus[] = ["ready", "degraded", "error"];

/**
 * Why this agent's status rules a converge out, or `null` when it does not.
 * The reason is the status itself — "stopped", "bootstrapping" — which is the
 * word an operator acts on, and the one both callers print after "skipped —".
 */
export function convergeDeferral(agent: Pick<Agent, "status">): string | null {
  return CONVERGEABLE.includes(agent.status) ? null : `${agent.status}`;
}

export interface ConvergeDeps {
  readonly ctx: CoreContext;
  /** How many milliseconds of polling a box gets before it is reported unconverged. */
  readonly timeoutMs: number;
  /** How long to sleep between looks at the row. */
  readonly pollMs: number;
}

export function createConverge(deps: ConvergeDeps) {
  const { ctx, timeoutMs, pollMs } = deps;
  const agents = ctx.backend.store.agents;

  /**
   * Ask the box to apply `hash`.
   *
   * Writes `apply_request` on the row — the only inbound channel a box has
   * (§5.1) — and records `converge requested: config <hash>` on the agent's
   * event log under `kind`, so `agent history` shows which command asked. The
   * caller must hold the agent's lock, must have decided already that the box
   * does not run `hash` (`applied_config_hash`), and must release the lock
   * before calling `waitForConverge`.
   */
  async function request(agent: Agent, hash: string, issuedBy: string, kind: string): Promise<Agent> {
    const next = await agents.update(agent.name, agent.version, {
      apply_request: {
        id: `${hash}-${ctx.backend.clock.now().getTime().toString(36)}`,
        config_hash: hash,
        issued_at: ctx.nowIso(),
        issued_by: issuedBy,
      },
    });
    await ctx.appendEvent(next.name, kind, `converge requested: config ${hash}`);
    return next;
  }

  /**
   * Poll the row until the box reports the config it was asked for.
   *
   * `configVerdict` (`skew.ts`) is not used here on purpose: it answers "is
   * this box's applied config the one the row names", and mid-rollout the row
   * can already name a *newer* one. The question here is narrower and exact —
   * did the hash this run asked for actually land.
   *
   * An abort ends the wait early and reads as `"timeout"`; the caller decides
   * whether that is an unconverged report or an `ABORTED` throw, by asking
   * `checkAbort` next.
   */
  async function waitForConverge(
    name: string,
    hash: string,
    signal?: AbortSignal,
  ): Promise<"converged" | "timeout"> {
    /**
     * Counted looks rather than a wall-clock deadline, and deliberately so: the
     * clock this module is given is the backend's, which fixture mode freezes so
     * that rendered snapshots and heartbeat ages stay deterministic. A deadline
     * read from a frozen clock never passes, which is a hang rather than a
     * timeout — the loop must be bounded by the thing it actually does.
     */
    const looks = Math.max(1, Math.ceil(timeoutMs / pollMs));
    for (let i = 0; i < looks; i += 1) {
      const row = await agents.get(name).catch(() => null);
      if (row?.applied_config_hash === hash) return "converged";
      if (signal?.aborted === true) return "timeout";
      await abortableSleep(pollMs, signal);
    }
    // One last look: the final sleep may be exactly what the box needed.
    const row = await agents.get(name).catch(() => null);
    return row?.applied_config_hash === hash ? "converged" : "timeout";
  }

  /**
   * The warning for a box that never reported `hash`, shared so a rollout and
   * an `upgrade --now` describe the same silence the same way: the request
   * stays on the row, an old hermeticd never takes it, and `agent history`
   * holds whatever the box did say.
   */
  function unconvergedMessage(name: string, hash: string): string {
    return (
      `${name} has not reported config ${hash} after ` +
      `${String(Math.round(timeoutMs / 60_000))}m — the request stays on its row, and a box ` +
      "running a hermeticd older than converge support will never take it (`hermetic artifacts push`); " +
      `\`hermetic agent history ${name}\` has what it said`
    );
  }

  return { request, waitForConverge, unconvergedMessage, timeoutMs, pollMs };
}
