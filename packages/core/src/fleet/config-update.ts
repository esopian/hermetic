/**
 * The config half of "update the fleet" (§6.5, §6.6): `artifacts push` and
 * `foundation update` both end by converging every agent whose re-rendered
 * configuration changed, so an operator has one thing to run rather than a
 * push followed by a `plan rollout` they have to know about.
 *
 * It is the manual rollout (`agents/rollout.ts`) run over the agents that
 * changed — the same lock, staged-provider step, upload, request and wait — so
 * there is one idea of what converging an agent means. What is its own is the
 * choice of agents, which is stricter than the manual rollout's: an operator
 * running `plan rollout` named the boxes and read the plan, while this runs as
 * the tail of a release push, so anything it cannot do safely it defers with a
 * warning instead (`updateDeferral`). An agent whose config did not change is
 * skipped without a word, and its box is not touched — re-applying the same
 * bundle restarts nothing, but asking a hundred boxes to do nothing is noise.
 *
 * `plan.foundation` lists the same changes (`configChanges`), so the plan and
 * the phase cannot disagree about which agents move.
 */
import type { CoreContext } from "../context.ts";
import { HermeticError } from "../errors.ts";
import { evt } from "../events.ts";
import { describePending, pendingApplied } from "../profiles/profile-binding.ts";
import { readFleetManifest } from "../release/artifacts-manifest.ts";
import { diffAppliedConfig } from "../agents/config-diff.ts";
import { convergeDeferral } from "../agents/converge.ts";
import { createRollout, type RolloutDeps } from "../agents/rollout.ts";
import type {
  Agent,
  BuildIdentity,
  ConfigChange,
  FleetItem,
  FleetManifest,
  OpEvent,
} from "../schema/index.ts";
import { compareBuild } from "./build-order.ts";

export type ConfigUpdateDeps = RolloutDeps;

type Release = FleetManifest["hermeticd"] | null;

/**
 * Why the fleet update will not converge this agent, or `null`. Each one is a
 * warning on the op, never a failure: the release is published either way, and
 * every reason here is something converging would get wrong.
 */
export function updateDeferral(
  agent: Agent,
  needs: readonly string[],
  appliedRequires: readonly string[] | null,
  release: Release,
  opts: { hermesVersion: string; nowMs: number; pushing: boolean },
): string | null {
  const down = convergeDeferral(agent);
  if (down !== null) return down;
  if (agent.lock && Date.parse(agent.lock.expires) > opts.nowMs) return "locked by another operator";
  if (!agent.applied_config_hash) return "no applied config reported";
  /**
   * Every render pins this build's Hermes ref (`renderFor`), so converging a
   * row held on another version would install a Hermes nobody asked for — or
   * fail the box's version cross-check. Moving the pin is its own command.
   */
  if (agent.hermes_version !== opts.hermesVersion) {
    return `held on Hermes ${agent.hermes_version}, and this build renders ${opts.hermesVersion}; \`hermetic upgrade --hermes ${opts.hermesVersion} ${agent.name}\` moves it`;
  }
  if (needs.length === 0) return null;
  const has = release?.capabilities;
  // A plan made before the update's own push is about the release that push
  // publishes, which is this build's and so implements everything it renders.
  const missing = has === undefined || opts.pushing ? [] : needs.filter((c) => !has.includes(c));
  if (missing.length > 0) {
    return `needs ${missing.join(", ")}, which the published hermeticd (${release?.version ?? "unknown"}) does not implement; run \`hermetic artifacts push\``;
  }
  // The box proved it can: it applied a bundle needing as much, or it reports
  // running the published binary, which says it implements all of it.
  if (appliedRequires !== null && needs.every((c) => appliedRequires.includes(c))) return null;
  const sha = release?.files["hermeticd"]?.sha256;
  if (has !== undefined && sha !== undefined && agent.running_hermeticd_sha256 === sha) return null;
  const unproven = needs.filter((c) => !(appliedRequires ?? []).includes(c));
  return `its hermeticd has not reported support for ${unproven.join(", ")}; it converges once it runs the published release`;
}

/**
 * Every agent this build would change, with its diff and, for the ones it will
 * not converge, why. Unchanged agents are left out. Never fails on a bucket
 * read: an unreadable bundle or manifest is a `note` or an unknown release.
 */
export async function configChanges(
  ctx: CoreContext,
  fleet: FleetItem,
  opts: { pushing?: boolean } = {},
): Promise<ConfigChange[]> {
  const release = (await readFleetManifest(ctx.backend.artifacts).catch(() => null))?.hermeticd ?? null;
  const nowMs = ctx.backend.clock.now().getTime();
  const rows = (await ctx.backend.store.agents.scan()).filter((a) => a.status !== "destroyed");
  const changes = await Promise.all(
    rows.map(async (agent): Promise<ConfigChange | null> => {
      const next = ctx.renderFor(pendingApplied(agent), fleet.region, fleet.tailnet);
      const from = agent.applied_config_hash ?? null;
      const pending = describePending(agent);
      if (from === next.config_hash && pending === null) return null;
      const diff = await diffAppliedConfig(ctx.backend.artifacts, agent.name, from, next.manifest);
      return {
        name: agent.name,
        from,
        to: next.config_hash,
        deferred: updateDeferral(agent, next.manifest.requires ?? [], diff.appliedRequires, release, {
          hermesVersion: ctx.hermesVersion,
          nowMs,
          pushing: opts.pushing === true,
        }),
        pending,
        files: diff.files,
        manifest: diff.manifest,
        note: diff.note,
      };
    }),
  );
  return changes.filter((c): c is ConfigChange => c !== null);
}

/**
 * The phase itself, run after the release is published and after the `_fleet`
 * lock is given back: converging takes each agent's lock, which refuses while
 * the fleet's is held (`assertFleetUnlocked`), even by this op.
 *
 * `publishedBefore` is `_fleet.published_by` as it stood before this op's own
 * push: a build older than that must not push its older render over a newer
 * one's, so it skips the phase with one warning.
 */
export async function* configUpdate(
  deps: ConfigUpdateDeps,
  opts: {
    phase: string;
    progress: readonly [number, number];
    publishedBefore: BuildIdentity | null | undefined;
    /** `false` (`--no-rollout`): ask no box. */
    rollout?: boolean | undefined;
    signal?: AbortSignal | undefined;
  },
): AsyncGenerator<OpEvent, void> {
  const { ctx } = deps;
  const [lo, hi] = opts.progress;
  const at = () => ctx.nowIso();
  if (opts.rollout === false) {
    yield evt(opts.phase, hi, "--no-rollout: no agent's config was converged", at());
    return;
  }
  if (compareBuild(ctx.buildIdentity(), opts.publishedBefore) === "older") {
    yield evt(
      opts.phase,
      hi,
      "this build is older than the one that last published to this fleet, so it converges no agent's config; update hermetic",
      at(),
      "warn",
    );
    return;
  }
  try {
    const { fleet } = await ctx.guardFleet();
    const changes = await configChanges(ctx, fleet);
    for (const c of changes.filter((c) => c.deferred !== null)) {
      yield evt(opts.phase, lo, `${c.name}: config not converged — ${c.deferred ?? ""}`, at(), "warn");
    }
    const names = changes.filter((c) => c.deferred === null).map((c) => c.name);
    if (names.length === 0) {
      yield evt(opts.phase, hi, "no agent's config needs converging", at());
      return;
    }
    yield evt(
      opts.phase,
      lo,
      `converging ${names.length} agent(s) whose config changed: ${names.join(", ")}`,
      at(),
    );
    /**
     * One rollout per agent, so one agent's failure — a staged change the
     * published release cannot carry, a write that lost a race — is that
     * agent's warning and the rest still converge. The rollout's own `plan` and
     * `done` events are per call here, so the tally is this phase's.
     */
    const rollout = createRollout(deps);
    const tally = { converged: 0, skipped: 0, unconverged: 0, failed: 0 };
    for (const [index, name] of names.entries()) {
      const from = lo + ((hi - lo) * index) / names.length;
      const span = (hi - lo) / names.length;
      try {
        for await (const e of rollout.run({ agents: [name] }, { signal: opts.signal })) {
          if (e.phase === "plan" || e.phase === "done") continue;
          if (e.phase.endsWith(":done")) tally.converged += 1;
          else if (e.phase.endsWith(":unconverged")) tally.unconverged += 1;
          else if (e.phase.endsWith(":skipped") || e.phase.endsWith(":current")) tally.skipped += 1;
          yield { ...e, phase: opts.phase, progress: from + span * e.progress };
        }
      } catch (e) {
        if (e instanceof HermeticError && e.code === "ABORTED") throw e;
        tally.failed += 1;
        yield evt(
          opts.phase,
          from + span,
          `${name}: config not converged — ${e instanceof Error ? e.message : String(e)}; \`hermetic plan rollout\` retries it`,
          at(),
          "warn",
        );
      }
    }
    const { converged, skipped, unconverged, failed } = tally;
    yield evt(
      opts.phase,
      hi,
      `config update finished: ${String(converged)} converged, ${String(skipped)} skipped, ${String(unconverged)} unconverged, ${String(failed)} failed`,
      at(),
      unconverged + failed > 0 ? "warn" : undefined,
    );
  } catch (e) {
    if (e instanceof HermeticError && e.code === "ABORTED") throw e;
    // The release is published whatever happens here (`followRelease`'s rule).
    yield evt(
      opts.phase,
      hi,
      `the config update stopped: ${e instanceof Error ? e.message : String(e)}; \`hermetic plan rollout\` retries it`,
      at(),
      "warn",
    );
  }
}
