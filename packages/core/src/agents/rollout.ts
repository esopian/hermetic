/**
 * `plan.rollout` and its `apply` (§6.5): re-render every agent's configuration
 * and make the boxes actually run it.
 *
 * ## Why this exists
 *
 * Until now a configuration change reached a box exactly two ways: `agent
 * rerun`, which requires the box to be in `error`, or a `recreate`, which
 * rebuilds it. `agent set` said so in as many words — "it takes effect on the
 * next rerun or recreate" — and for a single agent that is a fair trade. For a
 * change in the *renderer* it is not: a new default in `render.ts` reaches a
 * twelve-agent fleet only as twelve manual acts, so in practice it does not
 * reach it at all, and the fleet drifts from the build that manages it.
 *
 * The spec said "there is no converge" twice, and meant it: nothing on a `ready`
 * box was listening. This is that decision revisited rather than smuggled — a
 * converge that happens **when an operator asks for one**, never on a timer,
 * never as a side effect of an unrelated command. The nightly loop still moves
 * only hermeticd and its stages; a configuration still never changes underneath
 * an agent on a schedule.
 *
 * ## How it reaches a box
 *
 * The row is the only inbound channel a box has (§5.1: hermeticd's DynamoDB
 * access is `LeadingKeys`-scoped to its own row), so the request goes on the
 * row and `serve` reads it on the heartbeat tick it already runs — the same
 * shape §6.6's `update_request` uses, for the same reason.
 *
 * Nothing acks. "Done" is the box's own `applied_config_hash` reaching the
 * `config_hash` the row names, which the heartbeat already reports and
 * `configVerdict` (`skew.ts`) already interprets. That choice is what makes an
 * old `serve` safe: one that has never heard of `apply_request` ignores it, its
 * applied hash never moves, and this reports it as **not converged** — never as
 * done. A rollout that quietly counted an unreachable box as finished would be
 * worse than one that cannot reach it.
 *
 * ## What it does not do
 *
 * It does not change status. An agent that fails to apply stays `ready` with a
 * stale `applied_config_hash`, which `agent ps` and the UI already draw as
 * `drifted`, and the failure itself lands on the agent's event log where
 * `agent history` shows it. Moving a serving agent to `error` because a config
 * did not land would be reporting the wrong thing about a box that is still
 * answering.
 */
import { HermeticError } from "../errors.ts";
import { describePending, pendingApplied } from "../profiles/profile-binding.ts";
import { abortableSleep, checkAbort } from "../abort.ts";
import { evt } from "../events.ts";
import type { CoreContext } from "../context.ts";

import type { Agent, FleetItem, OpEvent, Plan, PlanRolloutInput } from "../schema/index.ts";
import { configVerdict } from "../fleet/skew.ts";

/** How long one box gets to pick up a request and report the new hash. */
export const CONVERGE_TIMEOUT_MS = 5 * 60_000;
/** How often the row is re-read while waiting. The box heartbeats every 30 s. */
export const CONVERGE_POLL_MS = 10_000;

/**
 * Statuses a converge can be asked of. A box that is not up cannot apply
 * anything, and saying so per agent is more useful than a plan that pretends
 * otherwise: `stopped` is a deliberate state an operator chose, `creating` and
 * `bootstrapping` are already applying *this* config on their own, and
 * `destroyed` has no box at all.
 */
const CONVERGEABLE: readonly Agent["status"][] = ["ready", "degraded", "error"];

export interface RolloutDeps {
  readonly ctx: CoreContext;
  /**
   * §8.3: turn a staged provider change on this row into the running one —
   * snapshot the credential, rewrite the binding, clear `pending` — and hand
   * back the row as it now stands. A row with nothing staged is returned
   * unchanged, so the rollout calls it unconditionally rather than deciding for
   * itself what a pending change means.
   *
   * It is a dependency rather than code here because it writes *credentials*:
   * the rollout's job is to make boxes run what the fleet says, and knowing how
   * a key gets from a profile into an instance slot is not part of it.
   */
  readonly applyPending: (agent: Agent) => Promise<Agent>;
  /** How long a converge waits for a box to report, and how often it looks; tests shrink both. */
  readonly convergeTimeoutMs?: number;
  readonly convergePollMs?: number;
}

/** What a rollout would do to one agent — the plan's row, and `apply`'s. */
export interface RolloutTarget {
  readonly name: string;
  readonly from: string | null;
  readonly to: string;
  /** `null` when it will be converged; otherwise why it will not be. */
  readonly deferred: string | null;
  /**
   * §8.3: the provider change this rollout would *perform* on the way past, in
   * one line, or `null`. A converge that also moves an agent onto another
   * credential is not the same act as one that re-applies the same document,
   * and the plan is where an operator finds that out.
   */
  readonly pending: string | null;
}

export function createRollout(deps: RolloutDeps) {
  const { ctx } = deps;
  const agents = ctx.backend.store.agents;
  const now = () => ctx.backend.clock.now().getTime();
  const timeoutMs = deps.convergeTimeoutMs ?? CONVERGE_TIMEOUT_MS;
  const pollMs = deps.convergePollMs ?? CONVERGE_POLL_MS;

  /**
   * What each agent would converge to, without writing anything.
   *
   * The render is pure and `ensureConfig` uploads only a key that is not there
   * (`hermetic.ts`), so the *plan* deliberately does not call it: a plan is a
   * question, and answering it must not leave objects in the bucket for a
   * rollout the operator then declines. The hash is therefore computed, not
   * uploaded — `apply` does the upload.
   */
  async function targets(
    input: PlanRolloutInput,
    fleet: FleetItem,
    hashFor: (agent: Agent, fleet: FleetItem) => string,
  ): Promise<RolloutTarget[]> {
    const all = await agents.scan();
    const wanted = input.agents === undefined ? null : new Set(input.agents);
    if (wanted) {
      const known = new Set(all.map((a) => a.name));
      const missing = [...wanted].filter((n) => !known.has(n));
      if (missing.length > 0) {
        throw new HermeticError("NOT_FOUND", `no such agent: ${missing.join(", ")}`, { missing });
      }
    }
    const chosen = all.filter((a) => (wanted ? wanted.has(a.name) : true));

    return chosen.map((agent) => {
      /**
       * §8.3: the hash a *staged* row converges to is the one its pending
       * binding renders, not the one its current binding does — `apply`
       * rewrites the binding first and renders afterwards. A plan that named
       * today's hash would promise one thing and the apply would record
       * another, which is the plan being wrong about the only number it exists
       * to state.
       */
      const to = hashFor(pendingApplied(agent), fleet);
      const from = agent.applied_config_hash ?? null;
      return {
        name: agent.name,
        from,
        to,
        deferred: deferralFor(agent, to),
        pending: describePending(agent),
      };
    });
  }

  /**
   * Why an agent will not be converged, or `null`. Ordered by what an operator
   * can do about it: a state they chose, then a state that is already doing
   * this, then a lock somebody else holds, then "nothing to do".
   */
  function deferralFor(agent: Agent, to: string): string | null {
    if (!CONVERGEABLE.includes(agent.status)) return `${agent.status}`;
    if (agent.lock) return "locked by another operator";
    /**
     * A staged provider change is work even when the hashes already agree: the
     * credential has not been copied, the binding has not moved, and the
     * re-render that follows will produce a *different* hash. Calling that
     * "already current" would make `apply` skip the one agent it was run for.
     */
    if (agent.pending !== null && agent.pending !== undefined) return null;
    if (agent.applied_config_hash === to && agent.config_hash === to) return "already current";
    return null;
  }

  /**
   * `plan.rollout`: a document an operator reads before anything is written.
   *
   * Every agent gets a step, including the ones that will be skipped — "which
   * boxes will this touch" is the question the plan exists to answer, and an
   * agent silently missing from the list answers it wrongly.
   */
  async function plan(
    input: PlanRolloutInput,
    hashFor: (agent: Agent, fleet: FleetItem) => string,
    summary: Plan["summary"],
  ): Promise<Plan> {
    const { fleet } = await ctx.guardFleet();
    const list = await targets(input, fleet, hashFor);
    const converging = list.filter((t) => t.deferred === null);

    const steps = list.map((t) => ({
      id: t.name,
      description:
        t.deferred === null
          ? `${t.name}: apply ${t.to}${t.from === null ? "" : ` (was ${t.from})`}` +
            (t.pending === null ? "" : `, and ${t.pending}`)
          : `${t.name}: skipped — ${t.deferred}${t.pending === null ? "" : ` (${t.pending} stays staged)`}`,
      // A converge writes configuration; it destroys nothing and cannot lose a
      // volume or a row. The confirmation it needs is about blast radius, not
      // about deletion, and the step list is what carries that.
      destructive: false,
    }));

    const warnings: string[] = [];
    if (converging.length === 0) {
      warnings.push("nothing to converge: every agent named is already current, or cannot apply");
    } else {
      warnings.push(
        `${converging.length} agent(s) will apply a new configuration immediately, ` +
          `${input.concurrency === undefined || input.concurrency === 1 ? "one at a time" : `${String(input.concurrency)} at a time`}; ` +
          "a box that does not report the new config within " +
          `${String(Math.round(timeoutMs / 60_000))} minute(s) is reported unconverged, not failed`,
      );
    }

    return {
      kind: "rollout",
      target: fleet.fleet_id,
      /**
       * Carried so `apply` executes the plan that was read rather than today's
       * defaults: a plan made for one agent must never converge twelve.
       */
      options: {
        ...(input.agents === undefined ? {} : { rollout_agents: [...input.agents] }),
        ...(input.concurrency === undefined ? {} : { rollout_concurrency: input.concurrency }),
      },
      steps,
      warnings,
      ...(summary ? { summary } : {}),
    };
  }

  /**
   * Execute it. Serial by default, for the reason `upgrade --all` is serial
   * (§6.5) and then some: this one takes effect on the box immediately, so a
   * render that breaks an agent breaks the first agent and stops, with every
   * agent after it untouched.
   */
  async function* run(
    input: PlanRolloutInput,
    opts: { signal?: AbortSignal } = {},
  ): AsyncIterable<OpEvent> {
    const { fleet } = await ctx.guardFleet();
    const owner = await ctx.actor();
    const at = () => ctx.nowIso();

    const all = await agents.scan();
    const wanted = input.agents === undefined ? null : new Set(input.agents);
    const chosen = all.filter((a) => (wanted ? wanted.has(a.name) : true));

    yield evt("plan", 0.02, `rollout across ${chosen.length} agent(s)`, at());

    let converged = 0;
    let deferred = 0;
    let unconverged = 0;
    const total = Math.max(1, chosen.length);

    for (const [index, target] of chosen.entries()) {
      checkAbort(opts.signal, "rollout");
      const progress = 0.02 + (0.96 * (index + 1)) / total;
      const fresh = await agents.get(target.name);
      if (!fresh) continue;

      // Re-derived here rather than trusted from the plan: a row can move
      // between reading a plan and applying it, and a converge onto a stale
      // decision is exactly what the re-read prevents.
      const early = deferralFor(fresh, fresh.config_hash ?? "");
      if (early !== null && early !== "already current") {
        yield evt(`${fresh.name}:skipped`, progress, `${fresh.name} skipped — ${early}`, at(), "warn");
        deferred += 1;
        continue;
      }

      let agent: Agent;
      try {
        agent = await ctx.acquireLock(fresh, owner);
      } catch (e) {
        // Another operator's work in progress is not this run's failure.
        if (e instanceof HermeticError && e.code === "LOCKED") {
          yield evt(
            `${fresh.name}:skipped`,
            progress,
            `${fresh.name} is locked by another operator; skipped`,
            at(),
            "warn",
          );
          deferred += 1;
          continue;
        }
        throw e;
      }

      let wanted_hash: string;
      try {
        /**
         * §8.3, and **before** the render: a staged provider change is what the
         * next document says, so rendering first would upload the old one and
         * then have to do it again. `applyPending` copies the credential into
         * the slot the new binding names, rewrites the row and clears
         * `pending`; a row with nothing staged comes back untouched.
         *
         * A failure here leaves the previous binding exactly as it was — the
         * credential write is idempotent, the bundle is uploaded before
         * anything commits, and the row write that moves the binding is the
         * same one that states the hash it renders — so the agent goes on
         * running what it was running and the change stays staged for the next
         * apply. The `ensureConfig` below therefore finds the object already
         * there and the row already agreeing, for a row that had something
         * staged; it is what renders the first time for a row that did not.
         */
        const staged = describePending(agent);
        /**
         * Before the commit, not after it: the document the new binding renders
         * may need a hermeticd capability this fleet has not published, and
         * `ensureConfig` below would find that out only once the credential had
         * been copied, the binding rewritten and `pending` cleared — leaving a
         * row bound to a slot no box reads and nothing staged to retry. Asking
         * first costs one pure render and refuses with the change still staged.
         */
        if (staged !== null) await ctx.assertCanApply(pendingApplied(agent), fleet);
        agent = await deps.applyPending(agent);
        if (staged !== null) {
          await ctx.appendEvent(agent.name, "rollout", `applied staged change: ${staged}`);
          yield evt(`${agent.name}:bound`, progress, `${agent.name}: ${staged}`, at());
        }
        const rendered = await ctx.ensureConfig(agent, fleet);
        wanted_hash = rendered.config_hash;
        if (agent.config_hash !== rendered.config_hash) {
          agent = await agents.update(agent.name, agent.version, {
            config_hash: rendered.config_hash,
            resources: { ...agent.resources, config_key: rendered.key },
          });
        }
        if (agent.applied_config_hash === wanted_hash) {
          yield evt(
            `${agent.name}:current`,
            progress,
            `${agent.name} already runs config ${wanted_hash}`,
            at(),
          );
          deferred += 1;
          continue;
        }
        agent = await agents.update(agent.name, agent.version, {
          apply_request: {
            id: `${wanted_hash}-${now().toString(36)}`,
            config_hash: wanted_hash,
            issued_at: at(),
            issued_by: owner,
          },
        });
        await ctx.appendEvent(agent.name, "rollout", `converge requested: config ${wanted_hash}`);
      } finally {
        const latest = await agents.get(agent!.name);
        if (latest?.lock?.owner === owner) await ctx.releaseLock(latest);
      }

      yield evt(
        `${agent.name}:requested`,
        progress,
        `${agent.name} asked to apply ${wanted_hash}`,
        at(),
      );

      /**
       * Wait for the box's own account of itself. The lock is released first —
       * this is a *read* loop, exactly as `create`'s handoff watch is, so an
       * operator can abort it, and a second operator is not blocked behind a
       * box that is slow to answer.
       */
      const outcome = await waitForConverge(agent.name, wanted_hash, opts.signal);
      if (outcome === "converged") {
        converged += 1;
        yield evt(`${agent.name}:done`, progress, `${agent.name} is running ${wanted_hash}`, at());
      } else {
        unconverged += 1;
        yield evt(
          `${agent.name}:unconverged`,
          progress,
          `${agent.name} has not reported config ${wanted_hash} after ` +
            `${String(Math.round(timeoutMs / 60_000))}m — the request stays on its row, and a box ` +
            "running a hermeticd older than converge support will never take it (`hermetic artifacts push`); " +
            `\`hermetic agent history ${agent.name}\` has what it said`,
          at(),
          "warn",
        );
      }
    }

    const tally = `${String(converged)} converged, ${String(deferred)} skipped, ${String(unconverged)} unconverged`;
    yield evt("done", 1, `rollout finished: ${tally}`, at(), unconverged > 0 ? "warn" : undefined);
  }

  /**
   * Poll the row until the box reports the config it was asked for.
   *
   * `configVerdict` is not used here on purpose: it answers "is this box's
   * applied config the one the row names", and mid-rollout the row can already
   * name a *newer* one. The question here is narrower and exact — did the hash
   * this run asked for actually land.
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

  return { plan, run, targets, deferralFor, configVerdict };
}
