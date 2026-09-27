/**
 * The helpers every operation of the SDK shares: the account and fleet guards
 * (§4.7), the TTL locks and their heartbeats (§4.4), the §4.3 status
 * transitions, the agent-manifest render `create`/`recreate`/`apply` all go
 * through (§6.4), and the read path the heads paint from (§4.5).
 *
 * `createAgentRuntime` returns them as one closure over the backend, and
 * `hermetic.ts` destructures it once and hands the pieces to every `create*`
 * module's explicit deps object. Nothing here is a public method; it is the
 * substrate the modules are built on, pulled out of `hermetic.ts` so the SDK
 * assembly stays an assembly (AGENTS.md rule 5).
 */
import { readFleetManifest } from "../release/artifacts.ts";
import { LOCK_TTL_MS, lockActivity, lockOperation } from "../fleet/fleet-lock.ts";
import type {
  Agent,
  AgentConfig,
  AgentEvent,
  AgentStatus,
  AgentView,
  FleetItem,
  FleetSettings,
  LocalConfig,
} from "../schema/index.ts";
import { FLEET_KEY, agentBrowserViews, stackNameFor } from "../schema/index.ts";
import { HermeticError, isHermeticError, isMissingTable } from "../errors.ts";
import {
  assertTransition,
  deriveDisplayStatus,
  heartbeatAgeMs,
  isLockLive,
  isReentry,
} from "./state.ts";
import { credentialSlotOf, profileUpdateAvailable } from "../profiles/profile-binding.ts";
import { FOUNDATION_VERSION } from "../version.ts";
import type { AttachDeps } from "./attach.ts";
import { HANDOFF_POLL_MS, type HandoffDeps } from "./handoff.ts";
import { abortableSleep } from "../abort.ts";
import { renderAgentConfig } from "../render/render.ts";
import type { Backend, StackInfo } from "../backend/types.ts";
import { agentParamPrefix } from "../backend/constants.ts";
import { BUILD_VERSIONS } from "../build-versions.ts";

/**
 * What a run *built* — the half of a transition's patch that is written even
 * when another run moved the status first (`transition`/`adopt`). `lock` and
 * `status` are excluded by type: the re-lock and the asserted status are the
 * one thing a caller must not be able to override through this door.
 */
export type TransitionFacts = Omit<Partial<Agent>, "lock" | "status">;
/**
 * How stale a held lock may get before a long wait pushes its expiry out again.
 * A third of the TTL: often enough that a wait of any length keeps the lock,
 * rare enough that an unbounded attach wait is not a write per poll (§4.4).
 */
const LOCK_RENEW_MS = LOCK_TTL_MS / 3;

/** The slice of `HermeticDeps` the shared helpers read (`hermetic.ts`). */
export interface AgentRuntimeDeps {
  backend: Backend;
  /** `null` before `init` — every guard then fails NOT_INITIALIZED. */
  config: LocalConfig | null;
  /** Overrides the actor ARN from STS; only tests should pass this. */
  actor?: string | undefined;
  /** `attach.ts`'s poll and progress cadence; tests shrink both. */
  attach?: { pollMs?: number; progressMs?: number } | undefined;
  /** The post-handoff watch's budget and poll (`handoff.ts`); off by default. */
  handoff?: { budgetMs?: number; pollMs?: number } | undefined;
}

export type AgentRuntime = ReturnType<typeof createAgentRuntime>;

export function createAgentRuntime(deps: AgentRuntimeDeps) {
  const { backend } = deps;

  let cachedActor: string | null = deps.actor ?? null;
  let accountGuarded = false;

  const nowIso = () => backend.clock.now().toISOString();

  function requireConfig(): LocalConfig {
    if (!deps.config) {
      throw new HermeticError(
        "NOT_INITIALIZED",
        "this hermetic home has no frozen config; run `hermetic init` first",
      );
    }
    return deps.config;
  }

  async function actor(): Promise<string> {
    if (cachedActor === null) cachedActor = (await backend.identity.callerIdentity()).arn;
    return cachedActor;
  }

  /**
   * One STS call per process, compared against the frozen account (§4.7). This is
   * the guard that makes deploying into the wrong account a typed error.
   */
  async function guardAccount(): Promise<void> {
    if (accountGuarded) return;
    const config = requireConfig();
    const id = await backend.identity.callerIdentity();
    if (id.account_id !== config.account_id) {
      throw new HermeticError(
        "ACCOUNT_MISMATCH",
        `credentials resolve to account ${id.account_id} but this home is frozen to ${config.account_id}`,
        { observed: id.account_id, frozen: config.account_id },
      );
    }
    cachedActor = deps.actor ?? id.arn;
    accountGuarded = true;
  }

  /** Additionally required before any mutating command (§4.7). */
  async function guardFleet(): Promise<{ config: LocalConfig; fleet: FleetItem; stack: StackInfo }> {
    await guardAccount();
    const config = requireConfig();
    const stack = await backend.foundation.describeStack();
    if (!stack) {
      throw new HermeticError(
        "FLEET_MISMATCH",
        `no foundation stack for fleet ${config.fleet_id} in ${config.region} (expected ${stackNameFor(config.fleet_id)})`,
        { region: config.region },
      );
    }
    if (stack.tags["fleet_id"] !== config.fleet_id) {
      throw new HermeticError(
        "FLEET_MISMATCH",
        "the foundation stack belongs to a different fleet than this home",
        { stack_tag: stack.tags["fleet_id"] ?? null, local: config.fleet_id },
      );
    }
    const fleet = await backend.store.fleet.get();
    if (!fleet) {
      throw new HermeticError("FLEET_MISMATCH", `the ${FLEET_KEY} item is missing`, {});
    }
    if (fleet.fleet_id !== config.fleet_id) {
      throw new HermeticError(
        "FLEET_MISMATCH",
        `the ${FLEET_KEY} item belongs to a different fleet than this home`,
        { fleet_item: fleet.fleet_id, local: config.fleet_id },
      );
    }
    // §6.6: this is the door every *mutating* command comes through, and a
    // build behind the fleet's foundation contract must not write. `init
    // --attach` and `foundation.update` already refused, which covered the two
    // commands that apply a template; it left the ordinary writes, and those
    // are the ones that quietly undo remote state a newer contract added —
    // `FleetItem` is non-strict, so a build that has never heard of an
    // attribute drops it and writes the item back without it. Reads keep
    // answering (`foundation.status` guards the account only): its `blocked`
    // skew is the screen that explains this refusal.
    const known = fleet.foundation_version ?? 0;
    if (known > FOUNDATION_VERSION) {
      throw new HermeticError(
        "FOUNDATION_NEWER",
        `fleet ${fleet.fleet_id} is on foundation v${known} but this build of hermetic only knows v${FOUNDATION_VERSION}; upgrade hermetic before changing anything in this fleet`,
        { fleet: known, tool: FOUNDATION_VERSION },
      );
    }
    // Handed back, not re-fetched: the fleet manifest's `resources` are built
    // from these outputs, and a second `DescribeStacks` could answer `null`
    // where this one answered a stack (§4.7).
    return { config, fleet, stack };
  }

  async function appendEvent(
    name: string,
    action: string,
    detail?: string,
    from?: AgentStatus | null,
    to?: AgentStatus | null,
  ): Promise<void> {
    const event: AgentEvent = {
      name,
      timestamp: nowIso(),
      actor: await actor(),
      action,
      from_status: from ?? null,
      to_status: to ?? null,
      detail: detail ?? null,
    };
    await backend.store.events.append(event);
  }

  async function getAgent(name: string): Promise<Agent> {
    const found = await backend.store.agents.get(name);
    if (!found) throw new HermeticError("NOT_FOUND", `no such agent: ${name}`, { name });
    return found;
  }

  /**
   * The row plus what only this process can derive from it.
   *
   * `settings` is optional because three callers have no fleet item to hand —
   * `doctor`'s inventory, the op-event views — and the honest answer for them
   * is "not computed" rather than a guessed `false`. `update_available` is
   * absent there, which every head already renders as nothing to show.
   */
  function view(agent: Agent, settings?: FleetSettings): AgentView {
    const now = backend.clock.now();
    return {
      ...agent,
      display_status: deriveDisplayStatus(agent, now),
      heartbeat_age_ms: heartbeatAgeMs(agent, now),
      browsers: agentBrowserViews(),
      ...(settings === undefined ? {} : { update_available: profileUpdateAvailable(settings, agent) }),
    };
  }

  /** §4.4, for the agent-scoped lock: `isLockLive` with this closure's clock. */
  function lockHeldByOther(agent: Agent, owner: string): boolean {
    return isLockLive(agent.lock, owner, backend.clock.now().getTime());
  }

  /**
   * `scan`, for the three callers that must survive the table having been
   * deleted already: `teardown`'s `agents_check`, `plan.teardown`, and `doctor`.
   * Every other read of the fleet wants the throw — a missing table anywhere
   * else is a broken foundation, not an empty one.
   */
  async function scanAgentsAllowingMissingTable(): Promise<{
    agents: Agent[];
    table_gone: boolean;
  }> {
    try {
      return { agents: await backend.store.agents.scan(), table_gone: false };
    } catch (e) {
      if (isMissingTable(e)) return { agents: [], table_gone: true };
      throw e;
    }
  }

  /**
   * `attach.ts` needs three EC2 calls and a clock, not the whole backend, so
   * that its unit tests can be three fakes rather than a fleet.
   */
  function attachDeps(): AttachDeps {
    return {
      compute: backend.compute,
      now: () => backend.clock.now().getTime(),
      pollMs: deps.attach?.pollMs,
      progressMs: deps.attach?.progressMs,
    };
  }

  /**
   * The post-handoff watch reads the row and sleeps, and needs nothing else —
   * in particular no lock and no write path, which is the property that makes
   * it safe to leave running while anyone else acts on the same agent.
   */
  function handoffDeps(): HandoffDeps {
    return {
      getAgent: (name: string) => backend.store.agents.get(name),
      now: () => backend.clock.now().getTime(),
      budgetMs: deps.handoff?.budgetMs ?? 0,
      pollMs: deps.handoff?.pollMs ?? HANDOFF_POLL_MS,
      sleep: abortableSleep,
    };
  }

  /**
   * The `heartbeat` an unbounded wait calls on every poll. It renews the TTL
   * lock only once the lock is a third of its life old — a wait long enough to
   * matter keeps the lock, and a wait that finishes quickly writes nothing.
   */
  function lockKeeper(get: () => Agent, set: (a: Agent) => void, owner: string): () => Promise<void> {
    let renewed = backend.clock.now().getTime();
    return async () => {
      const at = backend.clock.now().getTime();
      if (at - renewed < LOCK_RENEW_MS) return;
      renewed = at;
      set(await renewLock(get(), owner));
    };
  }

  /**
   * §6.6: a foundation update rewrites the stack, the release and every agent
   * row, so nothing per-agent may *start* while its fleet-wide lock is live. It
   * costs one extra `_fleet` read, taken on the paths that were about to write
   * anyway — every `acquireLock`, and `create`'s claim, which writes a row with
   * its lock already on it and so never reaches `acquireLock`.
   *
   * Reads are deliberately unaffected: an operator watching a fleet through an
   * update is exactly who needs to be able to look at it.
   *
   * `owner` is the one exception, and it is not for agent operations: §8.3's
   * profile writes take this same lock for themselves and then go on writing
   * through doors that check it, so they pass their own owner and are not
   * refused by their own lock. Every agent-op caller omits it and is blocked by
   * a live lock whoever holds it.
   */
  async function assertFleetUnlocked(name?: string, owner?: string): Promise<void> {
    const lock = (await backend.store.fleet.get())?.lock;
    // No owner passed: a fleet-wide lock blocks *everyone*, including whoever
    // took it — an agent op is never a re-entry into a foundation update.
    if (!isLockLive(lock, owner, backend.clock.now().getTime())) return;
    throw new HermeticError(
      "LOCKED",
      // What the holder is doing, from the owner string, so an agent op refused
      // during a profile rotation says so rather than blaming a foundation
      // update that is not running (`fleet-lock.ts`) — and what happens next,
      // which is not the same sentence for all of them. A profile write or a
      // foundation update ends and the fleet is there afterwards; a teardown
      // ends and there is nothing left to operate on, so telling an operator to
      // wait for it would be telling them to wait for their own fleet to go.
      `${lockActivity(lock.owner)} (${FLEET_KEY} locked by ${lock.owner} until ${lock.expires}); ${
        lockOperation(lock.owner) === "teardown"
          ? "this fleet is being torn down, so agent operations will not resume"
          : "agent operations resume when it finishes"
      }`,
      {
        ...(name === undefined ? {} : { name }),
        owner: lock.owner,
        expires: lock.expires,
        scope: "fleet",
      },
    );
  }

  async function acquireLock(agent: Agent, owner: string): Promise<Agent> {
    await assertFleetUnlocked(agent.name);
    if (lockHeldByOther(agent, owner)) {
      throw new HermeticError(
        "LOCKED",
        `agent ${agent.name} is locked by ${agent.lock?.owner ?? "another operator"}`,
        { name: agent.name, owner: agent.lock?.owner ?? null, expires: agent.lock?.expires ?? null },
      );
    }
    return backend.store.agents.update(agent.name, agent.version, {
      lock: {
        owner,
        expires: new Date(backend.clock.now().getTime() + LOCK_TTL_MS).toISOString(),
      },
    });
  }

  /**
   * A lock is a TTL lock (§4.4): it expires on its own if the operator's laptop
   * dies. That only works if a *live* operation keeps pushing the expiry out —
   * otherwise a create slower than the TTL would silently unlock itself while
   * still running, and a second operator could start over on top of it.
   */
  async function renewLock(agent: Agent, owner: string): Promise<Agent> {
    if (agent.lock?.owner !== owner) return agent;
    return backend.store.agents.update(agent.name, agent.version, {
      lock: {
        owner,
        expires: new Date(backend.clock.now().getTime() + LOCK_TTL_MS).toISOString(),
      },
    });
  }

  async function releaseLock(agent: Agent): Promise<Agent> {
    if (!agent.lock) return agent;
    return backend.store.agents.update(agent.name, agent.version, { lock: null });
  }

  /**
   * What every lifecycle op does when it throws: drop the lock this attempt
   * took, and write down what happened.
   *
   * The row is deliberately *not* rolled back to some earlier status. §4.5 makes
   * the agent record the account of what exists in AWS, and a `destroy` that got
   * as far as terminating the instance really is part-destroyed — moving it back
   * to `ready` would be a lie, and moving it to `error` would lose which
   * operation was in flight. It stays where it is and is re-runnable, which is
   * what `isReentry` bought.
   *
   * The event is the piece that was missing. A failed op used to leave nothing
   * on the agent's history at all, so once the browser was closed the only
   * record of *why* an agent was stranded was a line in `~/.hermetic/portal.log`.
   * `agent history` now names the operation and its error code.
   *
   * The error's *message* is deliberately not stored. It is the one part of an
   * error that is unclassified free text straight from an AWS SDK response, and
   * §8.3 does not allow that on disk: a backend that interpolates a secret into
   * a failure would otherwise have it copied into an event store that is never
   * pruned (§6.6). The code is the classified half and is enough to name the
   * failing step; the full message still reaches the op stream and the portal
   * log, which is where it already lived.
   *
   * `record: false` keeps the lock half and drops the event, for the one caller
   * that needs it: an op abandoned *after* it committed. `create` commits at the
   * handoff and only watches after it, so a browser tab closed during that watch
   * used to leave a permanent `create failed (ABORTED)` on the history of an
   * agent that had been created perfectly well. The lock release stays
   * unconditional — a no-op when there is nothing to release, and the only safe
   * answer when there is.
   */
  async function unwind(
    name: string,
    method: string,
    owner: string,
    e: unknown,
    opts: { record?: boolean } = {},
  ): Promise<void> {
    try {
      const latest = await backend.store.agents.get(name);
      if (latest?.lock?.owner === owner) await releaseLock(latest);
      if (opts.record === false) return;
      await appendEvent(
        name,
        "failed",
        `${method} failed (${isHermeticError(e) ? e.code : "INTERNAL"})`,
      );
    } catch {
      // Never let the cleanup's own failure replace the error being reported:
      // the caller is about to rethrow `e`, which is the one worth reading.
    }
  }

  /**
   * Take the store's row as this run's picture of the agent, and carry on.
   *
   * Reached when our conditional write is refused and the row turns out to
   * already be where we were going: our copy was stale, not our request wrong.
   * This run's pending `extra` is deliberately *not* applied, because it
   * describes the world this run was leaving and somebody else has already left
   * it. A `destroy` that raced another `destroy` which already deleted the
   * volume would otherwise write its own `volume_id` back over the row and leave
   * it naming a volume that no longer exists.
   *
   * `facts` are written, because they are not a picture of the old world but a
   * record of what this run built — the instance it launched, the config it
   * uploaded, the stale command it cleared — and those are true no matter who
   * moved the status. Dropping them is how a raced `recreate` used to leave the
   * row pointing at the previous boot's config and carrying an unacked `command`
   * that the new box would then act on (§4.2).
   *
   * The other thing adoption writes is the lock, re-taken in our name against
   * `latest.version`. The operation is not over — it continues from whichever
   * step is still undone — and it must continue *locked*, or its heartbeat
   * renewals and its final `releaseLock` are silent no-ops and a second
   * operator walks straight in (§4.4). Expiry is honoured through the same
   * `lockHeldByOther` every other path uses: a dead run's expired lock is free,
   * which is the canonical wedge this whole mechanism exists to clear, while a
   * live foreign lock refuses — adopting that would be the takeover §4.4 exists
   * to prevent. A caller holding no lock of its own has no business adopting at
   * all.
   *
   * Every refusal rethrows the original CONFLICT, including a failed re-read: a
   * transient read error must not replace the classified error the caller is
   * owed.
   */
  async function adopt(
    agent: Agent,
    to: AgentStatus,
    conflict: HermeticError,
    facts: TransitionFacts,
  ): Promise<Agent> {
    let latest: Agent | null;
    try {
      latest = await backend.store.agents.get(agent.name);
    } catch {
      throw conflict;
    }
    if (!latest || latest.status !== to) throw conflict;
    const owner = agent.lock?.owner;
    if (!owner) throw conflict;
    if (lockHeldByOther(latest, owner)) throw conflict;
    // A CONFLICT here is a genuine race — the row is moving right now — and
    // propagates as itself.
    // The re-lock is the point of this write, so it is spread last and the
    // type forbids `lock`/`status` in `facts`: neither may be overridden here.
    return backend.store.agents.update(latest.name, latest.version, {
      ...facts,
      lock: {
        owner,
        expires: new Date(backend.clock.now().getTime() + LOCK_TTL_MS).toISOString(),
      },
    });
  }

  /** Transitions are conditional updates on the current status (§4.3). */
  async function transition(
    agent: Agent,
    to: AgentStatus,
    detail: string,
    extra: Partial<Agent> = {},
    facts: TransitionFacts = {},
  ): Promise<Agent> {
    /**
     * Being asked to move to the status the row already holds means our picture
     * of it was stale, not that the request was wrong. Such a re-entry skips the
     * §4.3 assert (there are no self-edges there, and adding some to make
     * retries work would make the table mean less — `isReentry`, `state.ts`) and
     * writes no history event, because nothing moved. Without it, a `destroy`
     * that died after the instance was terminated could never be re-run:
     * `destroying → destroying` threw `INVALID_TRANSITION` before it reached the
     * step that actually needed finishing.
     *
     * The write itself is the same either way, and so is the answer to its being
     * refused: if the store has already reached `to`, we adopt it (see `adopt`)
     * and continue rather than failing. Both branches go through that, because a
     * retry's row can be stale in the version as easily as in the status.
     *
     * The patch is split in two because the two halves survive a race
     * differently. `extra` is the world this run is *leaving* — the instance it
     * just terminated, the heartbeat and metrics of a box that is gone — and it
     * is dropped on adoption, because whoever moved the status already left that
     * world and their account of it is the current one. `facts` are what this
     * run *built* — the instance it launched, the config it uploaded, the stale
     * command it cleared — and they are written either way, because they are
     * true regardless of who moved the status. Where the two name the same
     * field, `facts` win.
     */
    const reentry = isReentry(agent.status, to);
    if (!reentry) assertTransition(agent.status, to);

    let next: Agent;
    try {
      next = await backend.store.agents.update(agent.name, agent.version, {
        ...extra,
        ...facts,
        status: to,
      });
    } catch (e) {
      if (!isHermeticError(e) || e.code !== "CONFLICT") throw e;
      // No history event: nothing *this run* moved.
      return adopt(agent, to, e, facts);
    }
    if (!reentry) await appendEvent(agent.name, "transition", detail, agent.status, to);
    return next;
  }

  /** The fleet every SSM path is scoped by (§8.2); the frozen config is its source. */
  const fleetId = (): string => requireConfig().fleet_id;
  const agentPrefix = (name: string) => `${agentParamPrefix(fleetId())}${name}/`;
  const configPrefix = (name: string) => `config/${name}/`;

  /** True once `create` has launched the instance and handed off (§6.2 step 8). */
  function isHandedOff(agent: Agent): boolean {
    return (
      agent.resources.instance_id !== undefined &&
      agent.resources.volume_id !== undefined &&
      agent.resources.config_key !== undefined &&
      agent.resources.ssm_paths.length > 0 &&
      !agent.lock
    );
  }

  /**
   * No fleet identifier goes in. The render is what lands on the box, and the
   * only thing that ever wanted the fleet was `TailscaleServe.hostname` — which
   * is not emitted (`schema/manifest.ts`), because a field nothing reads has no
   * business in `config_hash`, where it would re-render and restart every agent
   * whenever it changed.
   */
  function renderFor(agent: Agent, region: string, tailnet: string) {
    return renderAgentConfig({
      tailnet,
      name: agent.name,
      size: agent.size,
      instance_type: agent.instance_type,
      provider: agent.provider,
      secrets_mode: agent.secrets_mode,
      hermes_version: agent.hermes_version,
      // The row pins a version, not a ref: there is no `hermes_ref` column, so
      // this build's ref is the only one available. It is the right answer for
      // an agent on the current pin and the wrong one for a row deliberately
      // held back — the apply's version cross-check is what catches that rather
      // than letting the box install a version nobody asked for.
      //
      // It is also why `upgrade --hermes` mirrors this ref and never has an
      // unknown one to refuse (§3.6): there is one ref in the whole render.
      // TODO(evan): give the agent row a `hermes_ref` so an older pin renders.
      hermes_ref: BUILD_VERSIONS.hermes_ref,
      // Same story for the browser build: one pin per checkout (§7.3).
      chrome_ref: BUILD_VERSIONS.chrome_ref,
      hermes: agent.hermes,
      // The fleet's answers as they stood when this agent was created, pinned
      // on the row so a later `settings set` cannot re-render every agent
      // (`resolveCreateDefaults`). Absent on older rows, which then render the
      // catalog default they were always rendering.
      seed: agent.seed,
      /**
       * The slot hermeticd reads this agent's provider key from (§8.3). Taken
       * from the row rather than derived from the profile, because the row is
       * what the *running* configuration was bound to — a profile that has been
       * rotated since must not move a manifest nobody has applied yet.
       */
      provider_key_ref: credentialSlotOf(agent),
      region,
    });
  }

  /**
   * Refuse to render a configuration the fleet's *published* hermeticd could not
   * apply.
   *
   * `assertCapable` on the box is the other half of this and cannot be the only
   * half: it fires when a box applies, which is the right moment for a running
   * agent and no moment at all for `agent create` — there is no box yet, and by
   * the time one exists and refuses, an instance is running and billing. The
   * fleet manifest records what the release implements (`capabilities`), so the
   * laptop can answer the same question before anything is created.
   *
   * Three states, and only one of them refuses:
   *
   * - the release **says** what it implements and is missing something this
   *   config needs → refuse, naming `artifacts push`;
   * - the release says nothing (`capabilities` absent: a manifest written before
   *   the field, or by `upgrade --hermeticd <ver>` pointing at a release another
   *   laptop pushed) → *cannot tell*, and a guess would refuse every fleet that
   *   has not been re-pushed since this landed. The box's own refusal is still
   *   there, and `releaseDrift` still warns at create;
   * - the manifest cannot be read at all → not this guard's problem. `create`
   *   fails on the release read a moment later with a better message.
   */
  async function assertReleaseCanApply(manifest: AgentConfig): Promise<void> {
    const needs = manifest.requires ?? [];
    if (needs.length === 0) return;
    const published = (await readFleetManifest(backend.artifacts).catch(() => null))?.hermeticd;
    const has = published?.capabilities;
    if (!has) return;
    const missing = needs.filter((c: string) => !has.includes(c));
    if (missing.length === 0) return;
    throw new HermeticError(
      "HERMETICD_UNAVAILABLE",
      `this hermetic renders a configuration that needs ${missing.join(", ")}, which the hermeticd ` +
        `this fleet publishes (${published.version}) does not implement; run \`hermetic artifacts push\` ` +
        "to publish this checkout's release first",
      { missing, published: published.version, capabilities: [...has] },
    );
  }

  /**
   * The same refusal as `ensureConfig`'s, asked of a row without uploading
   * anything (§8.3).
   *
   * Staging a provider change and applying one both need the answer *before*
   * they write: `agents.set` so the operator learns at `set` that this fleet's
   * published hermeticd cannot read the slot the new binding would name, and
   * the rollout so it learns before the commit that moves the binding. The
   * render is pure, so both can ask as often as they like.
   */
  async function assertCanApply(agent: Agent, fleet: FleetItem): Promise<void> {
    await assertReleaseCanApply(renderFor(agent, fleet.region, fleet.tailnet).manifest);
  }

  /**
   * Push the rendered config tarball if reality does not already match — the
   * idempotency rule of §4.5, applied to step 5 of §6.2.
   */
  async function ensureConfig(agent: Agent, fleet: FleetItem) {
    const rendered = renderFor(agent, fleet.region, fleet.tailnet);
    await assertReleaseCanApply(rendered.manifest);
    if (!(await backend.artifacts.exists(rendered.key))) {
      await backend.artifacts.putObject(rendered.key, rendered.tarball, "application/gzip");
    }
    return rendered;
  }

  /**
   * The sealing invariant (§5, §11.3): no inbound rules, ever. Anything that
   * puts a *new instance* behind the shared security group checks it first —
   * `create` and `recreate` both, because a recreate is a fresh boot into the
   * same group and a rule added since the original create would seal nothing.
   */
  async function assertSealed(what: string): Promise<void> {
    const inbound = await backend.compute.describeSecurityGroupInbound();
    if (inbound.length > 0) {
      throw new HermeticError(
        "SG_INBOUND_RULE",
        `the agent security group has ${inbound.length} inbound rule(s); hermetic refuses to ${what} behind a non-sealed group`,
        { rules: inbound },
      );
    }
  }

  return {
    nowIso,
    requireConfig,
    actor,
    /**
     * The one write to the cached ARN: `init` is the call that first learns
     * the caller's identity, and everything after it reuses that.
     */
    setActor: (arn: string) => {
      cachedActor = arn;
    },
    guardAccount,
    guardFleet,
    appendEvent,
    getAgent,
    view,
    lockHeldByOther,
    scanAgentsAllowingMissingTable,
    attachDeps,
    handoffDeps,
    lockKeeper,
    assertFleetUnlocked,
    acquireLock,
    renewLock,
    releaseLock,
    unwind,
    transition,
    fleetId,
    agentPrefix,
    configPrefix,
    isHandedOff,
    renderFor,
    assertReleaseCanApply,
    assertCanApply,
    ensureConfig,
    assertSealed,
  };
}
