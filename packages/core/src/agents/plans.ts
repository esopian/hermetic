/**
 * `plan.destroy`, `plan.recreate`, `plan.teardown` (§6.6, §9): what each
 * destructive command *would* do, enumerated in execution order so a head can
 * show it and the operator can decide. Nothing here mutates — every count is a
 * read against reality rather than a guess from the agent rows — and `apply`
 * reads the typed `options` back rather than the prose (§3.2 rule 3).
 *
 * They live outside `hermetic.ts` for the reason `doctor.ts` and `init.ts` do:
 * they are pure reads with a dependency list they can be handed, and the
 * lifecycle module is at its size limit (AGENTS.md rule 5).
 */
import {
  EIP_MONTHLY_COST,
  fleetHasNatAddress,
  PlanTeardownInput as PlanTeardownInputSchema,
  stackNameFor,
  tablesFor,
} from "../schema/index.ts";
import type {
  Plan,
  PlanDestroyInput,
  PlanRecreateInput,
  PlanStep,
  PlanSummary,
  PlanTeardownInput,
} from "../schema/index.ts";
import { validateName } from "../shared/naming.ts";
import type { ExpectedResources } from "./plan-expectations.ts";
import { HermeticError } from "../errors.ts";
import { legacyParamPrefixes, listLegacyParams, readFleetScope } from "../fleet/legacy-params.ts";
import { POLICY_RETAINED_NOTICE } from "../fleet/policy.ts";
import type { CoreContext } from "../context.ts";
import {
  AGENT_PARAM_ROOT,
  FLEET_ID_TAG,
  HERMETIC_PARAM_ROOT,
  agentParamPrefix,
  DATA_SNAPSHOT_TAG,
  hermeticParamPrefix,
  MANAGED_TAG,
  MANAGED_TAG_VALUE,
  ROLE_DATA,
  ROLE_TAG,
} from "../backend/constants.ts";

/** The three dry runs need nothing beyond the shared context. */
export interface PlanDeps {
  ctx: CoreContext;
}

export function createPlans(deps: PlanDeps) {
  const { agentPrefix, backend, configPrefix, getAgent, guardAccount, requireConfig } = deps.ctx;

  /**
   * §4.8: which fleet a plan is about. Every plan carries it, including the two
   * that name an agent — an agent name is only unique *within* a fleet, so
   * `destroy atlas` planned on one fleet and applied to another would destroy a
   * different box with the same name, which is the exact accident a home that
   * can hold several fleets makes possible.
   *
   * The stack is not read for it: these plans have no other reason to spend a
   * `DescribeStacks`, and `fleet_id` is what `apply` compares.
   */
  function fleetSummary(stackId: string | null = null): PlanSummary {
    const config = requireConfig();
    return {
      account_id: config.account_id,
      region: config.region,
      fleet_id: config.fleet_id,
      stack_id: stackId,
    };
  }

  async function destroy(input: PlanDestroyInput): Promise<Plan> {
    validateName(input.name);
    await guardAccount();
    const agent = await getAgent(input.name);
    const volumeId = agent.resources.volume_id ?? agent.volume_id;
    const steps = [
      {
        id: "terminate",
        description: `terminate instance ${agent.resources.instance_id ?? agent.instance_id ?? "(none)"}`,
        destructive: true,
      },
      {
        /**
         * Between the terminate and the SSM sweep, which is where `destroy`
         * runs it (§6.7): destructive because a tailnet device record is a
         * thing of the operator's that this removes, even though AWS never
         * billed for it.
         */
        id: "tailnet",
        description: `remove the tailnet device(s) named ${agent.name} (skipped with a warning when the OAuth client lacks devices:core)`,
        destructive: true,
      },
      {
        id: "secrets",
        description: `delete SSM parameters under ${agentPrefix(agent.name)}`,
        destructive: true,
      },
      {
        id: "config",
        description: `delete S3 objects under ${configPrefix(agent.name)}`,
        destructive: true,
      },
      input.delete_volume
        ? { id: "volume", description: `delete data volume ${volumeId ?? "(none)"}`, destructive: true }
        : { id: "volume", description: `keep data volume ${volumeId ?? "(none)"}`, destructive: false },
      { id: "record", description: "mark the agent record destroyed", destructive: false },
    ];
    const warnings: string[] = [];
    if (input.delete_volume) {
      warnings.push("the data volume holds this agent's memory, episode log and skill library");
    }
    if (agent.status === "destroyed") warnings.push(`${agent.name} is already destroyed`);
    warnings.push("events are never deleted; this agent's history survives");
    return {
      kind: "destroy",
      target: agent.name,
      /**
       * Carried as data: `apply` must not have to read the prose back (§3.2 r3)
       * — and it must be able to tell that the row it is about to destroy is
       * still the row this plan describes (`PlanOptions.agent_version`).
       */
      options: {
        delete_volume: input.delete_volume === true,
        agent_version: agent.version,
        instance_id: agent.resources.instance_id ?? agent.instance_id ?? null,
        volume_id: volumeId ?? null,
      },
      steps,
      warnings,
      // §4.8: which fleet this plan is about, so `apply` can refuse it in another.
      summary: fleetSummary(),
    };
  }

  /** §6.5: a from-scratch rebuild — new instance, same volume. */
  async function recreate(input: PlanRecreateInput): Promise<Plan> {
    validateName(input.name);
    await guardAccount();
    const agent = await getAgent(input.name);
    const volumeId = agent.resources.volume_id ?? agent.volume_id;
    return {
      kind: "recreate",
      target: agent.name,
      // The same staleness contract `plan.destroy` carries: a recreate that
      // terminates whatever instance the row names now, having shown the
      // operator the one it named then, is the same surprise.
      options: {
        agent_version: agent.version,
        instance_id: agent.resources.instance_id ?? agent.instance_id ?? null,
        volume_id: volumeId ?? null,
      },
      steps: [
        {
          id: "terminate",
          description: `terminate instance ${agent.resources.instance_id ?? agent.instance_id ?? "(none)"}`,
          destructive: true,
        },
        {
          /**
           * Before the mint, not after: the replacement is admitted as
           * `<name>` only if nothing else in the tailnet still holds the name
           * at the moment it joins (§6.5).
           */
          id: "tailnet",
          description: `remove the tailnet device(s) named ${agent.name} (skipped with a warning when the OAuth client lacks devices:core)`,
          destructive: true,
        },
        {
          id: "secrets",
          description: `mint a fresh single-use tailscale auth key for ${agent.name}`,
          destructive: false,
        },
        {
          id: "launch",
          description: `launch a new ${agent.instance_type} from ami ${agent.region} pinned image`,
          destructive: false,
        },
        {
          id: "volume",
          description: `reattach data volume ${volumeId ?? "(none)"}`,
          destructive: false,
        },
      ],
      warnings: [
        "memory, episode log and skill library survive: they were never on the root volume",
        ...(volumeId ? [] : [`${agent.name} has no data volume recorded; one will be created`]),
      ],
      summary: fleetSummary(),
    };
  }

  /**
   * §9: what `teardown` is about to do, enumerated in execution order so the
   * head can show it and the operator can decide. Nothing here mutates — every
   * count is a read against reality rather than a guess from the agent rows.
   */
  async function teardown(input: PlanTeardownInput = {}): Promise<Plan> {
    const parsed = PlanTeardownInputSchema.parse(input);
    const config = requireConfig();
    await guardAccount();
    // A plan for the *retry* of a partial teardown has to be plannable: the
    // tables may already have gone with the stack (§4.2).
    const scanned = await deps.ctx.scanAgents();
    const agents = scanned.agents.filter((a) => a.status !== "destroyed");
    const stack = await backend.foundation.describeStack();
    const fleet = scanned.table_gone ? null : await backend.store.fleet.get();
    // The stack CloudFormation actually has, when it is still there; otherwise
    // the name this fleet id implies, which is what a retry will look for.
    const stackName = stack?.stack_name ?? stackNameFor(config.fleet_id);
    const tables = tablesFor(stackName);

    const steps: PlanStep[] = [
      {
        /**
         * The lock comes first because the check is only true for as long as it
         * holds: §4.4, and the reason the step names both halves.
         */
        id: "agents_check",
        description: "take the fleet-wide lock, then refuse if any non-destroyed agent exists",
        destructive: false,
      },
      {
        id: "bucket",
        description:
          "empty the versioned fleet bucket: every object version and delete marker, or DeleteStack fails on BucketNotEmpty",
        destructive: true,
      },
      {
        id: "stack",
        description: `DeleteStack ${stackName}: the VPC and its subnets, the sealed agent security group, the tag-scoped agent role and instance profile, the versioned S3 bucket, the ${tables.agents} and ${tables.events} DynamoDB tables, and the DLM snapshot policy with its role — every one of them named for the stack, so nothing outlives it under a name another fleet could want`,
        destructive: true,
      },
    ];
    /**
     * §4.6, immediately after the stack because that is where teardown sweeps:
     * an `AWS::EC2::EIP` is the one thing the stack owns that `DeleteStack` can
     * leave behind, and `--purge` *releases* what it finds. A release is
     * irreversible — the address goes back to AWS's pool — and its blast radius
     * reaches outside the account altogether, into whatever allow-list an
     * upstream wrote against it, so it is a step of its own rather than a
     * clause in the SSM one and it is named before the operator confirms.
     *
     * Only a `nat` fleet has one; a `public` fleet's agents each have their own
     * address and the stack allocates none.
     */
    const natFleet = fleetHasNatAddress(stack?.parameters["Network"], fleet?.network);
    /** ` (203.0.113.7)`, when the stack still reports it. */
    const natAddress = stack?.outputs["NatEgressIp"] ? ` (${stack.outputs["NatEgressIp"]})` : "";
    if (natFleet) {
      steps.push({
        id: "addresses",
        description: parsed.purge
          ? `release the fleet's NAT Elastic IP${natAddress} if it outlived the stack, and any other allocation tagged ${FLEET_ID_TAG}=${config.fleet_id}`
          : `report any Elastic IP tagged ${FLEET_ID_TAG}=${config.fleet_id} that outlived the stack; \`--purge\` would release it`,
        destructive: parsed.purge,
      });
    }
    /**
     * §4.8, immediately after the addresses, because that is where teardown
     * runs it. The entry is *kept* and marked `torn_down`: it costs nothing, it
     * is the account's record that this fleet existed, and its display alias
     * stays reserved with it — a label that vanished from the index would look
     * free, and could then be assigned to a different fleet (§4.7).
     */
    steps.push({
      id: "directory",
      description: `mark ${config.name ? `${config.fleet_id} ("${config.name}")` : config.fleet_id} torn_down in the account's fleet directory; the entry is kept as the record that this fleet existed, and its alias stays reserved`,
      destructive: false,
    });
    /**
     * Between the stack and the SSM purge, because that is where teardown says
     * it. A step that changes nothing still earns its place in the list: the
     * phases the operator watches are exactly the steps they confirmed, and
     * "the tailnet policy is left alone" is a decision worth seeing before the
     * account is emptied rather than a silence to infer from (§5.2).
     */
    steps.push({
      id: "tailscale",
      description: POLICY_RETAINED_NOTICE,
      destructive: false,
    });

    const warnings: string[] = [];
    // §4.4: what the first step takes, said out loud. Anyone else pointed at
    // this fleet is refused for the duration, and "the duration" has an end
    // even if this laptop dies halfway through.
    warnings.push(
      "the fleet is locked for the duration: no creates, destroys or foundation updates from any laptop until this teardown finishes, or its lock expires ten minutes after the laptop running it stops",
    );
    if (scanned.table_gone) {
      warnings.push(
        `the ${tables.agents} table no longer exists, so this is the retry of a teardown that got as far as deleting the stack; the agent check will pass by default`,
      );
    }
    if (agents.length > 0) {
      warnings.push(
        `${agents.length} agent(s) still exist (${agents.map((a) => a.name).join(", ")}); teardown will refuse`,
      );
    }

    /**
     * This fleet's own two prefixes, plus — only when the directory *proves*
     * this is the account's one live fleet — the pre-v3 leftovers the v3
     * migration copied from and deliberately kept (§6.6).
     *
     * `legacy-params.ts` decides both halves and `teardown.ts` calls exactly
     * the same functions, because a plan that promised a different set from
     * the apply would be worse than no plan: this is the one destructive step
     * whose blast radius reaches outside the fleet. Never a root — the roots
     * hold every other fleet's scoped parameters now, and `deleteByPrefix` is
     * recursive.
     */
    const scope = await readFleetScope(backend, config.fleet_id);
    const legacy = scope.sole
      ? legacyParamPrefixes(
          /**
           * Every row, destroyed included — `scanned.agents`, not the `agents`
           * the refusal check uses, which filters them out. A destroyed row is
           * kept for ever (§4.3) and its name is the only record that
           * `/hermes/<name>/` was this fleet's, so filtering it here would make
           * the plan promise a smaller set than `teardown` deletes.
           */
          scanned.agents.map((a) => a.name),
          scope,
        )
      : { prefixes: [] as string[], skipped: [] as string[] };
    const prefixes = [
      hermeticParamPrefix(config.fleet_id),
      agentParamPrefix(config.fleet_id),
      ...legacy.prefixes,
    ];
    const purgeScope = prefixes.join(" and ");
    if (parsed.purge) {
      const params = await listLegacyParams(backend.secrets, prefixes);
      steps.push({
        id: "ssm",
        description: `delete ${params.length} SSM parameter(s) under ${purgeScope}`,
        destructive: true,
      });
      if (natFleet) {
        warnings.push(
          `releasing the NAT Elastic IP${natAddress} is permanent: the address goes back to AWS's pool, cannot be got back, and every upstream allow-list naming it stops working — \`--no-purge\` keeps it, at about ${EIP_MONTHLY_COST} a month`,
        );
      }
    } else {
      warnings.push(
        `SSM parameters under ${purgeScope} are kept; they are not in the stack and nothing else will remove them`,
      );
      if (natFleet) {
        warnings.push(
          `the fleet's NAT Elastic IP${natAddress} is kept if the stack leaves it behind, at about ${EIP_MONTHLY_COST} a month; \`--purge\` would release it`,
        );
      }
    }
    /**
     * Said whether or not `--purge` was asked for: an operator deciding whether
     * to pass it needs to know that the pre-v3 copies are *not* in scope, and
     * why — an unreadable directory and a second live fleet are different
     * problems with different fixes.
     */
    if (!scope.sole) {
      warnings.push(
        `pre-v3 SSM parameters under ${HERMETIC_PARAM_ROOT} and ${AGENT_PARAM_ROOT} are not in scope for --purge: ${scope.reason ?? "this is not the account's only fleet"}`,
      );
    }
    for (const name of legacy.skipped) {
      warnings.push(
        `${AGENT_PARAM_ROOT}${name}/ is not in scope for --purge: "${name}" is also a fleet id in this account's directory, so those parameters may not be this fleet's`,
      );
    }

    if (parsed.delete_snapshots) {
      const snapshots = await backend.compute.listSnapshots(DATA_SNAPSHOT_TAG);
      const gib = snapshots.reduce((sum, s) => sum + s.size_gib, 0);
      steps.push({
        id: "snapshots",
        description: `delete ${snapshots.length} DLM snapshot(s) tagged ${ROLE_TAG}=${ROLE_DATA} (${gib} GiB total)`,
        destructive: true,
      });
      if (snapshots.length > 0) {
        warnings.push(
          "the snapshots are the last copy of what the agents learned once their volumes are gone",
        );
      }
    } else {
      warnings.push(
        `EBS snapshots tagged ${ROLE_TAG}=${ROLE_DATA} are kept and keep costing; deleting the stack removes the policy that made them, not the snapshots`,
      );
    }

    if (parsed.delete_volumes) {
      const volumes = await backend.compute.listManagedVolumes();
      const gib = volumes.reduce((sum, v) => sum + v.size_gib, 0);
      steps.push({
        id: "volumes",
        description: `delete ${volumes.length} leftover volume(s) tagged ${MANAGED_TAG}=${MANAGED_TAG_VALUE} (${gib} GiB): ${volumes.map((v) => v.volume_id).join(", ") || "(none)"}`,
        destructive: true,
      });
      if (volumes.length > 0) {
        warnings.push(
          `every agent's memory, episode log and skill library lives on those volumes and is lost: ${volumes
            .map((v) => `${v.volume_id} (${v.agent ?? "no agent tag"}, ${v.size_gib} GiB)`)
            .join(", ")}`,
        );
      }
    } else {
      warnings.push(
        `EBS volumes tagged ${MANAGED_TAG}=${MANAGED_TAG_VALUE} are kept: they hold what the agents learned, and \`destroy\` keeps them by default (§6.6)`,
      );
    }

    if (parsed.reset_local) {
      steps.push({
        id: "local",
        description:
          "archive the local runs log and remove the frozen config row, returning this home to uninitialized",
        destructive: true,
      });
    } else {
      warnings.push("the local config row is kept, so this home still points at the deleted fleet");
    }

    // What no flag can remove: hermetic has no credential that reaches it (§4.7).
    warnings.push(
      "not removed by any flag, and yours to do by hand: the Tailscale OAuth client (there is no API for it) and any devices still on the tailnet",
    );
    // Not a warning about a risk — a warning about an assumption an operator
    // may be carrying. The entries went in on `init`; nothing here takes them
    // out, and `--purge` does not change that (§5.2).
    warnings.push(POLICY_RETAINED_NOTICE);
    warnings.push(`the S3 bucket, both DynamoDB tables and the VPC go with the ${stackName} stack`);

    return {
      kind: "teardown",
      target: `${stackName} · ${config.account_id} · ${config.region}`,
      // Carried as data: `apply` must not have to read the prose back (§3.2 r3).
      options: {
        purge: parsed.purge,
        delete_snapshots: parsed.delete_snapshots,
        delete_volumes: parsed.delete_volumes,
        reset_local: parsed.reset_local,
      },
      steps,
      warnings,
      summary: fleetSummary(stack?.stack_id ?? fleet?.stack_id ?? null),
    };
  }

  /**
   * The staleness check `apply` makes before it executes either of the two
   * plans that name an agent — the same idea `plan.policy` carries an ETag for
   * (§3.2 rule 3, §4.7). A plan is a document: it is produced, read, confirmed
   * and only then applied, and in that gap a `recreate` can put the agent on a
   * different instance and a different volume. Applying the old plan then
   * destroys resources the operator never saw.
   *
   * **What is compared is the resources, not the row version.** The version was
   * the obvious witness and it is the wrong one: hermeticd bumps it from the
   * box on every `ready → degraded` and back (`packages/agentd/src/heartbeat.ts`
   * writes the row through the same conditional update every operator write
   * uses), so a *flapping* agent — precisely the agent somebody is planning to
   * destroy — would refuse every plan with a `PLAN_STALE` naming nothing that
   * moved. The ids are what the plan actually promised: "terminate i-abc",
   * "delete vol-xyz". If both still hold, the document is still true whatever
   * the row's version says; if either has moved, the refusal can say which,
   * which is the whole point of refusing.
   *
   * The version is still *carried*, and is still required: a plan without one
   * predates this build, so nothing in it can be checked at all. That refusal is
   * the same answer `policy.apply` gives a plan with no ETag.
   *
   * What it *returns* is that same promise in the shape the operation can check
   * again for itself. This check is made outside the agent's lock — it has to
   * be, since the operation takes that lock — so it is a check with a gap after
   * it, and a `recreate` landing in the gap moves the very ids just compared.
   * Handing the expectations on rather than a `void` is what lets `destroy` ask
   * once more with the lock held (§6.7), from one source both times.
   */
  async function assertCurrent(plan: Plan): Promise<ExpectedResources> {
    if (plan.options.agent_version === undefined) {
      throw new HermeticError(
        "VALIDATION",
        `this ${plan.kind} plan predates the current build of hermetic and names no version of the ${plan.target} row, so nothing in it can be checked; run \`hermetic plan ${plan.kind} ${plan.target}\` again`,
        { kind: plan.kind, target: plan.target },
      );
    }
    const agent = await getAgent(validateName(plan.target));
    const instanceId = agent.resources.instance_id ?? agent.instance_id ?? null;
    const volumeId = agent.resources.volume_id ?? agent.volume_id ?? null;
    const moved: string[] = [];
    if (plan.options.instance_id !== undefined && plan.options.instance_id !== instanceId) {
      moved.push(
        `the plan named instance ${plan.options.instance_id ?? "(none)"} and the row now names ${instanceId ?? "(none)"}`,
      );
    }
    if (plan.options.volume_id !== undefined && plan.options.volume_id !== volumeId) {
      moved.push(
        `the plan named data volume ${plan.options.volume_id ?? "(none)"} and the row now names ${volumeId ?? "(none)"}`,
      );
    }
    if (moved.length === 0) {
      return {
        ...(plan.options.instance_id === undefined ? {} : { instance_id: plan.options.instance_id }),
        ...(plan.options.volume_id === undefined ? {} : { volume_id: plan.options.volume_id }),
        agent_version: plan.options.agent_version,
      };
    }
    throw new HermeticError(
      "PLAN_STALE",
      `${agent.name} moved since this plan was made — ${moved.join("; ")}; run \`hermetic plan ${plan.kind} ${agent.name}\` again and read it before applying`,
      {
        name: agent.name,
        kind: plan.kind,
        moved,
        planned_version: plan.options.agent_version,
        observed_version: agent.version,
        planned_instance_id: plan.options.instance_id ?? null,
        observed_instance_id: instanceId,
        planned_volume_id: plan.options.volume_id ?? null,
        observed_volume_id: volumeId,
      },
    );
  }

  return { destroy, recreate, teardown, assertCurrent };
}
