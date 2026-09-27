/**
 * §5's fleet network mode: which side of a NAT the fleet's agents live on, and
 * how a fleet moves between the two after `init`.
 *
 * Three things in one module, the same shape `policy.ts` has: a read
 * (`network.status`), a dry run (`plan.network`) and the `apply` case that
 * executes it. Its own module rather than another function in `hermetic.ts`
 * per AGENTS.md rule 5, taking an explicit `NetworkDeps` rather than sharing
 * that file's closure.
 *
 * Two facts shape everything below.
 *
 * **CloudFormation owns the answer.** The stack's `Network` parameter decides
 * which subnets exist and which of them `SubnetIds` names; `_fleet.network` is
 * a cache heads read without spending a `DescribeStacks`. So `status` reports
 * both and says whether they agree, and `plan`/`apply` take the *stack* as
 * current. A stale cache is a wrong answer in a report, never a wrong subnet.
 *
 * **EC2 cannot move a running instance between subnets.** A mode switch
 * therefore strands every agent the fleet already has: they keep working, on
 * the subnets they were launched into, until somebody recreates them. This op
 * reports that drift by name and does not act on it — mass-recreating a fleet
 * inside a network change is far more blast radius than one confirmation can
 * carry. `doctor` keeps saying it until
 * the operator has driven `agent recreate`.
 *
 * The one direction that is refused outright is `nat` → `public` while agents
 * still sit in private subnets. CloudFormation cannot delete a subnet that
 * holds an ENI, so the change set would roll back mid-flight and leave the
 * fleet with half a NAT and a default route pointing at nothing — an egress
 * outage produced by an operation whose whole purpose was to remove the NAT.
 */
import { randomUUID } from "node:crypto";
import { createArchive } from "../agents/archive.ts";
import { readFleetManifest, writeFleetManifest } from "../release/artifacts.ts";
import type { StackInfo } from "../backend/types.ts";
import type { CoreContext } from "../context.ts";
import { HermeticError } from "../errors.ts";
import { evt } from "../events.ts";
import { checkAbort } from "../abort.ts";
import { LOCK_TTL_MS, createFleetLock, expectationOf, fleetLockKeeper } from "./fleet-lock.ts";
import {
  changeSetName as buildChangeSetName,
  runChangeSet,
  type StackChangeDeps,
} from "./stack-change.ts";
import {
  FLEET_KEY,
  type Agent,
  type FleetItem,
  type NetworkAgentPlacement,
  type NetworkMode,
  type NetworkReport,
  type Plan,
  type PlanNetworkInput,
  type PlanStep,
  type PlanSummary,
} from "../schema/index.ts";
import { PlanNetworkInput as PlanNetworkInputSchema } from "../schema/index.ts";

/** The phase boundaries, so `plan` and `apply` agree about where the bar is. */
const PHASE = {
  preflight: [0, 0.1],
  archive: [0.1, 0.35],
  stack: [0.35, 0.85],
  stamp: [0.85, 0.95],
  drift: [0.95, 0.99],
} as const;

/**
 * §6.4, said on every move to `nat`. Not a warning about a mistake — it is the
 * documented consequence of the mode — but it falls on exactly the paths an
 * operator uses most (`tailscale ssh`, log streams, noVNC frames), so it is
 * said before the change rather than discovered after it.
 */
const DERP_NOTE =
  "in `nat` mode the agents have no public address, so every Tailscale session to them — ssh, log streams, the dashboard — traverses a DERP relay instead of connecting directly (§6.4). That is by design, and it is slower.";

/**
 * What §5's re-network needs beyond the shared context: the local half of the
 * archive it takes first, and the change-set timings a test shortens.
 */
export interface NetworkDeps {
  ctx: CoreContext;
  archiveDir?: string | undefined;
  archiveLocalDb?: ((path: string) => void) | undefined;
  changeSetPollMs?: number | undefined;
  changeSetTimeoutMs?: number | undefined;
  heartbeatMs?: number | undefined;
}

/** The stack's `Network` parameter, or `null` when it carries none we recognise. */
function stackMode(stack: StackInfo | null): NetworkMode | null {
  const raw = stack?.parameters["Network"];
  return raw === "public" || raw === "nat" ? raw : null;
}

/** The stack's current `SubnetIds` output — where the next agent would launch. */
function subnetsOf(stack: StackInfo | null): string[] {
  return (stack?.outputs["SubnetIds"] ?? "").split(",").filter((s) => s.length > 0);
}

/**
 * How many `DescribeInstances` calls a placement read has in flight at once.
 *
 * `network.status` is behind an HTTP GET and `doctor` calls it too, so a fleet
 * of fifty agents must not be fifty serial round trips. Bounded rather than
 * unbounded: EC2 throttles `DescribeInstances` per account, and a fleet-sized
 * burst from a `doctor` run would be answered with `RequestLimitExceeded`.
 */
const DESCRIBE_CONCURRENCY = 8;

/**
 * `Promise.all` with a ceiling, preserving input order. Small enough to keep
 * beside its one caller; if a second operation needs it, it moves out.
 */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      const item = items[index];
      if (index >= items.length || item === undefined) return;
      out[index] = await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export function createNetwork(deps: NetworkDeps) {
  const { appendEvent, backend, guardAccount, nowIso } = deps.ctx;
  const now = () => backend.clock.now();

  const { archive } = createArchive({
    backend,
    nowIso,
    ...(deps.archiveDir !== undefined ? { archiveDir: deps.archiveDir } : {}),
    ...(deps.archiveLocalDb !== undefined ? { archiveLocalDb: deps.archiveLocalDb } : {}),
  });

  /**
   * The same `_fleet` lock `foundation.update` takes, from the module they
   * share (`fleet-lock.ts`). Taking it is what makes a re-network exclusive
   * with an update and with every agent operation: both rewrite the ground the
   * other is standing on.
   */
  const fleetLock = createFleetLock({
    backend,
    lockTtlMs: LOCK_TTL_MS,
    now,
    rerun: "`hermetic plan network --to <mode>` and `hermetic apply`",
  });

  const stackDeps: StackChangeDeps = {
    backend,
    nowIso,
    ...(deps.changeSetPollMs !== undefined ? { changeSetPollMs: deps.changeSetPollMs } : {}),
    ...(deps.changeSetTimeoutMs !== undefined ? { changeSetTimeoutMs: deps.changeSetTimeoutMs } : {}),
    ...(deps.heartbeatMs !== undefined ? { heartbeatMs: deps.heartbeatMs } : {}),
  };

  /** §4.8: which fleet this plan belongs to, so `apply` can refuse it elsewhere. */
  function fleetSummary(stack: StackInfo | null): PlanSummary {
    const config = deps.ctx.requireConfig();
    return {
      account_id: config.account_id,
      region: config.region,
      fleet_id: config.fleet_id,
      stack_id: stack?.stack_id ?? null,
    };
  }

  /** Every agent that still exists, whatever state it is in. */
  async function liveAgents(): Promise<Agent[]> {
    return (await backend.store.agents.scan()).filter((a) => a.status !== "destroyed");
  }

  /**
   * Where each agent's instance actually is, against where the fleet launches
   * today. An agent with no instance is `unknown` rather than `drifted`: there
   * is nothing in the wrong subnet, so there is nothing to recreate.
   */
  async function placements(agents: readonly Agent[], current: readonly string[]) {
    return mapLimit(agents, DESCRIBE_CONCURRENCY, async (agent): Promise<NetworkAgentPlacement> => {
      if (agent.instance_id === null || agent.instance_id === undefined) {
        return { name: agent.name, instance_id: null, subnet_id: null, placement: "unknown" };
      }
      const instance = await backend.compute.describeInstance(agent.instance_id);
      const subnet = instance?.subnet_id ?? null;
      return {
        name: agent.name,
        instance_id: agent.instance_id,
        subnet_id: subnet,
        placement: subnet === null ? "unknown" : current.includes(subnet) ? "matches" : "drifted",
      };
    });
  }

  /**
   * §5, §9: which mode the fleet is in, whether the record agrees with
   * CloudFormation, and which agents are no longer where the fleet launches.
   * A pure read — nothing here writes, and the NAT probe never throws.
   */
  async function status(): Promise<NetworkReport> {
    await guardAccount();
    const fleet = await backend.store.fleet.get();
    const stack = await backend.foundation.describeStack();
    const observed = stackMode(stack);
    const subnet_ids = subnetsOf(stack);
    const agents = await placements(await liveAgents(), subnet_ids);
    /**
     * Only asked of a `nat` stack. On a `public` one there is no NAT appliance,
     * and `null` here is the *skip* a head must render as unchecked rather than
     * as a clean bill (§9) — the same distinction the device list draws.
     */
    const nat = observed === "nat" ? await backend.foundation.describeNat() : null;
    const mode = fleet?.network ?? null;
    return {
      mode,
      stack_mode: observed,
      consistent: mode !== null && mode === observed,
      subnet_ids,
      egress_ip: observed === "nat" ? (stack?.outputs["NatEgressIp"] ?? nat?.egress_ip ?? null) : null,
      nat,
      agents,
      drifted: agents.filter((a) => a.placement === "drifted").length,
    };
  }

  /**
   * Every agent a mode switch would leave behind: one with a live instance.
   *
   * All of them, whatever subnet they are in now. A switch changes the launch
   * pair wholesale, so an instance that matches today will not match after, and
   * one that already drifted stays drifted. Only an agent with no instance at
   * all comes through a re-network already in the new mode.
   */
  function withInstances(report: NetworkReport): string[] {
    return report.agents.filter((a) => a.instance_id !== null).map((a) => a.name);
  }

  /**
   * Everything that makes a move to `public` impossible: every network
   * interface sitting in the subnets the stack is about to delete.
   *
   * CloudFormation cannot delete a subnet that still holds an ENI, so a `nat` →
   * `public` change set against a fleet with live private-subnet interfaces does
   * not fail cleanly — it gets part-way, rolls back, and leaves the NAT
   * half-removed with `PrivateDefaultRoute` pointing at whatever survived.
   *
   * Asked of EC2 rather than of the agents table, because the agents table is
   * not the list CloudFormation will run into. An interface left behind by a
   * create that launched a box and then failed before it could write the id
   * down, an instance an operator started by hand, a row that is mid-create and
   * has no `instance_id` yet — none of them appear as an agent with a placement,
   * and every one of them blocks the delete. The blockers that *can* be tied
   * back to an agent are named as that agent, because "destroy atlas" is the
   * action; the rest are named by interface id, because there is nothing else
   * to call them.
   *
   * Only the stack's *current* launch pair is examined: an instance stranded
   * somewhere else by an earlier switch sits in a subnet this change does not
   * touch, and must not be made to block it.
   *
   * Checked at plan time, and again at apply time with the fleet lock held:
   * the two happen at different moments and an agent can be created in between.
   */
  async function blockers(report: NetworkReport): Promise<string[]> {
    const interfaces = await backend.compute.listNetworkInterfaces(report.subnet_ids);
    if (interfaces.length === 0) return [];
    const agentOf = new Map<string, string>();
    for (const a of report.agents) {
      if (a.instance_id !== null) agentOf.set(a.instance_id, a.name);
    }
    const named = new Set<string>();
    for (const eni of interfaces) {
      const agent = eni.instance_id === null ? undefined : agentOf.get(eni.instance_id);
      named.add(
        agent ??
          `untracked network interface ${eni.id}${eni.description ? ` (${eni.description})` : ""}`,
      );
    }
    return [...named].sort();
  }

  /** The refusal both `plan` and `apply` raise when the fleet is already there. */
  function sameModeError(to: NetworkMode): HermeticError {
    return new HermeticError(
      "CONFLICT",
      `this fleet is already in \`${to}\` mode; there is nothing for a re-network to do`,
      { to },
    );
  }

  /**
   * `nat` → `public` with something still in the private subnets. `AGENTS_EXIST`
   * rather than `CONFLICT` because it is the same fact that code always means:
   * something is in the way, and destroying or recreating it is the answer —
   * even when what is in the way is an interface no agent row claims.
   */
  function agentsInTheWayError(names: readonly string[]): HermeticError {
    return new HermeticError(
      "AGENTS_EXIST",
      `CloudFormation cannot delete the private subnets while ${names.join(", ")} still ${names.length === 1 ? "holds a network interface" : "hold network interfaces"} in them — the change set would roll back part-way and leave the fleet without egress. Destroy or recreate the agents named (\`hermetic agent destroy\`) and delete anything else listed, then re-network.`,
      { agents: [...names] },
    );
  }

  /**
   * §3.2 rule 3: the dry run. It reads the same three sources `apply` will —
   * the stack, the `_fleet` item and every agent's instance — and writes
   * nothing. The one destructive step is the stack update: it replaces the
   * fleet's routing, and every agent's egress address changes with it.
   */
  async function plan(input: PlanNetworkInput): Promise<Plan> {
    const parsed = PlanNetworkInputSchema.parse(input);
    const { fleet, stack } = await deps.ctx.guardFleet();
    const report = await status();
    /**
     * The stack, not the cache. `_fleet.network` may be absent (a fleet created
     * before the field existed) or stale, and neither is a reason to refuse to
     * describe a change — but neither is a source of truth either. A
     * disagreement becomes a warning, which is the whole of its consequence
     * here.
     */
    const current = report.stack_mode;
    if (current === null) {
      throw new HermeticError(
        "CONFLICT",
        `the ${stack.stack_name} stack carries no \`Network\` parameter, so hermetic cannot tell which mode this fleet is in; run \`hermetic foundation update\` to bring it onto a template that records one`,
        { stack: stack.stack_name },
      );
    }
    if (parsed.to === current) throw sameModeError(parsed.to);

    if (parsed.to === "public") {
      const blocking = await blockers(report);
      if (blocking.length > 0) throw agentsInTheWayError(blocking);
    }
    const placed = withInstances(report);

    const warnings: string[] = [];
    if (!report.consistent) {
      warnings.push(
        report.mode === null
          ? `the ${FLEET_KEY} item records no network mode; the stack says \`${current}\`, and this apply writes the cache back into agreement`
          : `the ${FLEET_KEY} item records \`${report.mode}\` but the stack says \`${current}\`; the stack is authoritative and this apply writes the cache back into agreement`,
      );
    }
    if (placed.length > 0) {
      warnings.push(
        `EC2 cannot move a running instance between subnets, so ${placed.join(", ")} will keep running on the ${current} subnets after this apply and will not be in \`${parsed.to}\` mode until each is recreated (\`hermetic agent recreate <name>\`). Nothing breaks in the meantime; they are simply not the fleet they belong to.`,
      );
    }
    if (parsed.to === "nat") warnings.push(DERP_NOTE);
    warnings.push(
      `re-networking is the most destructive operation short of teardown: it replaces the fleet's routing, and a change set that fails part-way can leave the fleet without egress until CloudFormation finishes rolling back. The archive step below is not optional.`,
    );

    const steps: PlanStep[] = [
      {
        id: "preflight",
        description:
          parsed.to === "nat"
            ? `take the ${FLEET_KEY} lock and resolve today's fck-nat arm64 AMI; every agent operation refuses with LOCKED while the lock is held`
            : `take the ${FLEET_KEY} lock; every agent operation refuses with LOCKED while it is held`,
        destructive: false,
      },
      {
        id: "archive",
        description: `archive the fleet — the manifest, every config object, the ${FLEET_KEY} item, ${report.agents.length} agent row(s), their events and the SSM parameter names — before anything changes, replacing the one previous archive`,
        destructive: false,
      },
      {
        id: "stack",
        description: `update the foundation stack with Network=${parsed.to}: replace the fleet's routing, so every agent's egress changes${parsed.to === "nat" ? " to the NAT appliance's elastic IP" : " to each box's own public address"}`,
        destructive: true,
      },
      {
        id: "stamp",
        description: `record \`${parsed.to}\` on the ${FLEET_KEY} item and republish the fleet manifest, so the boxes and the heads read the new mode`,
        destructive: false,
      },
      {
        id: "drift",
        description:
          placed.length === 0
            ? "no agent has an instance, so nothing is left behind"
            : `report ${placed.length} agent(s) left on the ${current} subnets: ${placed.join(", ")}. They are not recreated — that is yours to drive.`,
        destructive: false,
      },
    ];

    return {
      kind: "network",
      // The fleet, like every plan whose subject is the fleet rather than one
      // agent. `plan.foundation` names the same target for the same reason.
      target: fleet.fleet_id,
      // Carried as data, never re-derived: `apply` must execute the move the
      // operator read, not the one today's fleet would suggest (§3.2 rule 3).
      options: { network: parsed.to },
      steps,
      warnings,
      summary: fleetSummary(stack),
    };
  }

  /**
   * Execute a `plan.network`. The choreography is `foundation.update`'s, minus
   * the release and the migrations: lock, archive, change set, stamp — with the
   * stamp as the commit point, so a failure anywhere before it leaves the fleet
   * exactly where it was and the op re-runnable (§6.6).
   */
  async function* apply(planned: Plan, opts: { signal?: AbortSignal; opId?: string } = {}) {
    const to = planned.options.network;
    if (to !== "public" && to !== "nat") {
      throw new HermeticError(
        "VALIDATION",
        "this plan carries no target network mode; run `hermetic plan network --to <public|nat>` again",
        { kind: planned.kind },
      );
    }
    const owner = `${await deps.ctx.actor()}#${opts.opId ?? randomUUID()}`;

    // ── preflight ───────────────────────────────────────────────────────────
    yield evt(
      "preflight",
      PHASE.preflight[0],
      "checking the account, the fleet and every agent's placement",
      nowIso(),
      undefined,
      "start",
    );
    const { fleet: found, stack: guarded } = await deps.ctx.guardFleet();
    const report = await status();
    const from = report.stack_mode;
    if (from === null) {
      throw new HermeticError(
        "CONFLICT",
        `the ${guarded.stack_name} stack carries no \`Network\` parameter, so hermetic cannot tell which mode this fleet is in`,
        { stack: guarded.stack_name },
      );
    }
    /**
     * Re-checked here, not trusted from the plan: a plan is a document made at
     * one moment and applied at another, and another operator may have done
     * this already. Both refusals are the plan's own, repeated against reality.
     */
    if (to === from) throw sameModeError(to);
    if (to === "public") {
      const blocking = await blockers(report);
      if (blocking.length > 0) throw agentsInTheWayError(blocking);
    }
    const placed = withInstances(report);

    if (fleetLock.isLive(found, owner)) {
      throw new HermeticError(
        "LOCKED",
        `another fleet-wide operation is already running (locked by ${found.lock?.owner ?? "another operator"} until ${found.lock?.expires})`,
        { owner: found.lock?.owner ?? null, expires: found.lock?.expires ?? null },
      );
    }

    /**
     * Resolved before anything is archived or changed. A
     * region with no published fck-nat image is a refusal, and it has to be one
     * *here* — resolved inside the stack phase it would abort a re-network with
     * the archive already written and the lock already taken.
     */
    let ami: string | undefined;
    if (to === "nat") {
      ami = await backend.foundation.resolveFckNatAmi();
    }

    /**
     * Take the lock, then read, for the reason `foundation.update` does: the
     * lock is taken by writing the `lock` attribute alone and reverts nothing,
     * but the stamp below replaces the whole item and states the revision it
     * was composed against — and only a read taken with the lock already held
     * is a revision nothing else can move.
     */
    if (!(await fleetLock.acquire(owner))) {
      throw new HermeticError(
        "LOCKED",
        `another operator took the ${FLEET_KEY} lock first; try again once their operation finishes`,
        {},
      );
    }
    let current: FleetItem = fleetLock.withLock((await backend.store.fleet.get()) ?? found, owner);
    /** The revision the stamp below is written against, for the reason `foundation.update` keeps one. */
    const at = expectationOf(current);
    let released = false;
    const keepLock = fleetLockKeeper(
      fleetLock,
      LOCK_TTL_MS,
      () => current,
      (next) => {
        current = next;
      },
      owner,
    );

    try {
      /**
       * The `nat` → `public` refusal, asked again now that the door is shut.
       *
       * The check above ran against a `status()` taken before the lock was taken,
       * and an `agents.create` that passed `assertFleetUnlocked` in that window
       * has an ENI in the private subnets by now. Only this reading means
       * anything: nothing can launch into those subnets while this op holds the
       * fleet lock, so what EC2 reports here is what the change set will meet.
       * A `no` is a refusal, not a failure — nothing has been archived or
       * changed yet, and the `finally` below puts the lock back.
       *
       * `foundation.update` repeats its own agent scan here for the same reason.
       */
      if (to === "public") {
        const racing = await blockers(await status());
        if (racing.length > 0) throw agentsInTheWayError(racing);
      }

      yield evt(
        "preflight",
        PHASE.preflight[1],
        `network ${from} → ${to}${ami ? ` (fck-nat AMI ${ami})` : ""}; took the ${FLEET_KEY} lock`,
        nowIso(),
        undefined,
        "done",
      );

      // ── archive ───────────────────────────────────────────────────────────
      checkAbort(opts.signal, "archive");
      current = await fleetLock.renew(current, owner);
      yield* archive({
        fleetId: current.fleet_id,
        version: current.foundation_version ?? 0,
        actor: await deps.ctx.actor(),
        from: PHASE.archive[0],
        to: PHASE.archive[1],
        heartbeat: keepLock,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });

      // ── stack ─────────────────────────────────────────────────────────────
      checkAbort(opts.signal, "stack");
      current = await fleetLock.renew(current, owner);
      const name = buildChangeSetName(`network-${to}`, nowIso, randomUUID().slice(0, 8));
      const stack = yield* runChangeSet(stackDeps, {
        guarded,
        name,
        create: () =>
          backend.foundation.createNetworkChangeSet({
            name,
            hermeticVersion: deps.ctx.hermeticdVersion,
            network: to,
            ...(ami === undefined ? {} : { fckNatAmiId: ami }),
          }),
        phase: "stack",
        errorCode: "NETWORK_UPDATE_FAILED",
        from: PHASE.stack[0],
        to: PHASE.stack[1],
        verb: "re-networking",
        keepLock,
        ...(opts.signal ? { signal: opts.signal } : {}),
        // A stack that is already in the target mode with a cache that said
        // otherwise: nothing to change, and the stamp below still fixes it.
        noChangesMessage: `the stack is already in \`${to}\` mode; no CloudFormation change`,
      });

      // ── stamp ─────────────────────────────────────────────────────────────
      /**
       * Deliberately *not* preceded by a `checkAbort`. The change set has
       * already executed by the time control reaches here: the stack is in the
       * new mode, its `SubnetIds` are the other pair, and refusing to stamp
       * would leave `_fleet.network` claiming a mode the fleet is no longer in —
       * an abort that produced exactly the drift this op exists to remove.
       * The stamp is the commit point, so from the execute onwards the op runs
       * to the end and an operator who pressed Ctrl-C waits the last seconds
       * out. Everything *before* the execute is still abortable and still
       * leaves the fleet where it was.
       */
      current = await fleetLock.writeLocked(
        { ...fleetLock.withLock(current, owner), network: to },
        owner,
        "recording the new network mode",
        at,
      );
      yield evt(
        "stamp",
        PHASE.stamp[0],
        `${FLEET_KEY} now records network \`${to}\``,
        nowIso(),
        undefined,
        "start",
      );
      /**
       * The manifest is how a *box* learns its own mode without an AWS call
       * (§5), and its `resources.subnet_ids` come from the stack outputs this
       * update just moved — so republishing is not cosmetic. Written after the
       * `_fleet` stamp, like every other publish, so the pointer never names a
       * state the item does not yet claim (§1).
       */
      const manifest = await republish(current, stack);
      yield evt(
        "stamp",
        PHASE.stamp[1],
        `the fleet manifest names network \`${to}\` and subnets ${manifest.resources.subnet_ids.join(", ")}`,
        nowIso(),
        undefined,
        "done",
      );

      // ── drift ─────────────────────────────────────────────────────────────
      /**
       * One event per agent left behind, at `warn`, because this is the half of
       * a re-network hermetic deliberately does not finish. `doctor` says the
       * same thing on every run until each box has been recreated.
       */
      if (placed.length === 0) {
        yield evt("drift", PHASE.drift[1], "no agent was left on the old subnets", nowIso());
      } else {
        for (const agent of placed) {
          yield evt(
            "drift",
            PHASE.drift[1],
            `${agent} is still on the ${from} subnets; run \`hermetic agent recreate ${agent}\` to move it into \`${to}\` mode`,
            nowIso(),
            "warn",
          );
        }
      }

      await appendEvent(
        FLEET_KEY,
        "network.apply",
        `network ${from} → ${to}${placed.length > 0 ? `; ${placed.length} agent(s) left on the old subnets: ${placed.join(", ")}` : ""}`,
      );
      current = await fleetLock.release(current, owner);
      released = true;
      yield evt(
        "done",
        1,
        `the fleet is in \`${to}\` mode${placed.length > 0 ? `; ${placed.length} agent(s) still need \`hermetic agent recreate\`` : ""}`,
        nowIso(),
      );
    } finally {
      if (!released) {
        // Best effort, and silent: the error on its way out is the one worth
        // reading, and a lock left behind expires on its own (§4.4).
        try {
          const latest = await backend.store.fleet.get();
          if (latest?.lock?.owner === owner) await fleetLock.release(latest, owner);
        } catch {
          /* the caller's error is the one that matters */
        }
      }
    }
  }

  /**
   * Rewrite `manifest.json` from the fleet and the stack as they now stand.
   * Not a release push: no version moved, so the `hermeticd` block is carried
   * over from the published manifest verbatim rather than re-derived — a
   * re-network must not quietly repoint the fleet at this checkout's build.
   */
  async function republish(fleet: FleetItem, stack: StackInfo) {
    const published = await readFleetManifest(backend.artifacts);
    if (published === null) {
      throw new HermeticError(
        "NOT_FOUND",
        "this fleet has no published manifest to rewrite; run `hermetic artifacts push` and re-apply",
        { fleet_id: fleet.fleet_id },
      );
    }
    const actor = await deps.ctx.actor();
    return writeFleetManifest(backend.artifacts, {
      fleet,
      stack,
      hermeticd: published.hermeticd,
      updatedBy: actor,
      updatedAt: nowIso(),
      ...(published.foundation === undefined ? {} : { foundation: published.foundation }),
      /**
       * The mirrors, carried over for the same reason `hermeticd` above is: a
       * re-network moves routing and has nothing to say about where a box gets
       * its Hermes or its browser, but this call rewrites the whole manifest —
       * so not naming them would delete them (§3.6, §7.3).
       */
      ...(published.hermes === undefined ? {} : { hermes: published.hermes }),
      ...(published.browser === undefined ? {} : { browser: published.browser }),
    });
  }

  return { status, plan, apply };
}
