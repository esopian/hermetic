import {
  type CloudFormationClient,
  CreateChangeSetCommand,
  CreateStackCommand,
  DeleteChangeSetCommand,
  DeleteStackCommand,
  DescribeChangeSetCommand,
  DescribeStackEventsCommand,
  DescribeStackResourcesCommand,
  DescribeStacksCommand,
  ExecuteChangeSetCommand,
} from "@aws-sdk/client-cloudformation";
import { STACK_NAME, isHermeticStackName, isStackDeleting, stackNameFor } from "../schema/fleet.ts";
import { FLEET_ID_TAG, VERSION_TAG } from "../backend/constants.ts";
import type { NatHealth } from "../schema/index.ts";
import type {
  ChangeSetChange,
  ChangeSetInfo,
  FoundationApi,
  StackInfo,
  StackProgress,
  StackResourceEvent,
  StackSummary,
} from "../backend/types.ts";
import { HermeticError } from "../errors.ts";
import { asHermeticError } from "./client.ts";
import {
  NAT_INSTANCE_LOGICAL_ID,
  PRIVATE_ROUTE_TABLE_LOGICAL_ID,
  foundationTemplateBody,
} from "./cfn-template.ts";

/**
 * Every hermetic stack in this account and region, whatever it is called: the
 * name is `hermetic-<fleet_id>` now and was plain `hermetic` before, so the tag
 * is the only handle that spans both. `DELETE_COMPLETE` stacks are skipped —
 * CloudFormation keeps them listed for 90 days and they own nothing.
 *
 * `DescribeStacks` rather than `ListStacks` because only the former carries the
 * tags; both page the same way.
 */
export async function listHermeticStacks(cfn: CloudFormationClient): Promise<StackInfo[]> {
  const found: StackInfo[] = [];
  let token: string | undefined;
  for (;;) {
    const out = await cfn.send(new DescribeStacksCommand(token ? { NextToken: token } : {}));
    for (const stack of out.Stacks ?? []) {
      if (!stack.StackId) continue;
      if (stack.StackStatus === "DELETE_COMPLETE") continue;
      const info = normalizeStack(stack);
      // `hermetic:fleet_id` is hermetic's own tag; the name shape catches a
      // stack whose tags an operator has since edited away.
      if (info.tags[FLEET_ID_TAG] === undefined && !isHermeticStackName(info.stack_name)) continue;
      found.push(info);
    }
    token = out.NextToken;
    if (!token) break;
  }
  return found;
}

/** CloudFormation states that mean the stack is finished, one way or another. */
const TERMINAL = /_(COMPLETE|FAILED)$/;

/**
 * A resource that actually failed, as opposed to the dozens CloudFormation
 * marks "Resource creation cancelled" once one of them has.
 */
function isResourceFailure(e: StackResourceEvent): boolean {
  return e.status.endsWith("_FAILED") && !/creation cancelled/i.test(e.reason ?? "");
}
const HEALTHY = new Set([
  "CREATE_COMPLETE",
  "UPDATE_COMPLETE",
  "UPDATE_ROLLBACK_COMPLETE",
  "IMPORT_COMPLETE",
]);

/**
 * The same set as `HEALTHY`, minus the one state that means the opposite of
 * what it says when you were *updating*: `UPDATE_ROLLBACK_COMPLETE` is a stack
 * that is healthy and unchanged, which is a fine outcome for anyone asking "is
 * this foundation usable" and a failure for the caller who just executed a
 * change set against it (§6.6 step 3).
 */
const HEALTHY_AFTER_UPDATE = new Set(["CREATE_COMPLETE", "UPDATE_COMPLETE", "IMPORT_COMPLETE"]);

/**
 * A stack as it stood at one instant, for the one question `StackInfo` cannot
 * answer: has this stack changed since I looked, given that its *status* may be
 * identical either way.
 */
interface StackSnapshot {
  status: string;
  last_updated_ms: number | null;
}

/** `Replacement` as CloudFormation spells it; anything else is read as unset. */
function replacementOf(value: string | undefined): ChangeSetChange["replacement"] {
  return value === "True" || value === "False" || value === "Conditional" ? value : null;
}

export interface CfnFoundationOptions {
  /**
   * The fleet this backend is bound to, when there is one. It names the stack —
   * `hermetic-<fleet_id>` — and so, through `${AWS::StackName}`, every resource
   * in it. Absent only for a backend built before `init` has minted an id.
   */
  fleetId?: string;
  /** Model ARNs the agent role may invoke, resolved for the region (§5.1). */
  bedrockModelArns: string[];
  /** fck-nat arm64 AMI, looked up by name; only read when `network = "nat"`. */
  resolveFckNatAmi?: () => Promise<string>;
  /**
   * The EC2 half of `describeNat`. CloudFormation knows which instance and
   * which route table the stack made; only EC2 knows whether the instance is
   * running and whether the default route still resolves — and this class holds
   * no EC2 client. Injected rather than constructed here for the reason every
   * other client in this package is: `aws.client()` is the one door (§4.7).
   */
  probeNat?: (ids: {
    instanceId: string;
    routeTableId: string;
  }) => Promise<{ instance_state: string | null; route_state: NatHealth["route_state"] }>;
  hermeticVersion: string;
  /** Poll interval of both waiters; tests shorten it. */
  pollIntervalMs?: number;
  /** How long `deleteStack` waits before giving up. ~20 minutes by default. */
  deleteTimeoutMs?: number;
}

/** CloudFormation deletes take minutes, and a VPC with an ENI in it takes more. */
const DELETE_TIMEOUT_MS = 20 * 60_000;

/**
 * CloudFormation is the one declarative piece (§5): six static resource groups,
 * created once, with `DescribeStacks` answering "is the foundation healthy" in
 * one call. There is no state file to own and no binary to install.
 */
export class CfnFoundation implements FoundationApi {
  constructor(
    private readonly cfn: CloudFormationClient,
    private readonly opts: CfnFoundationOptions,
  ) {}

  /**
   * The stack this fleet's resources live in, resolved once and remembered. A
   * fleet-scoped name is a single `DescribeStacks`; the tag scan behind it is
   * what still finds a foundation created before the rename, whose stack is
   * called plain `hermetic`.
   */
  private resolvedName: string | null = null;

  /**
   * The fleet `init` chose, when it chose one (§4.8). It overrides the id this
   * backend was constructed with — which, on the `init` path, is no id at all —
   * so that a home holding several fleets can be pointed at the right stack
   * without rebuilding the backend around it.
   */
  private boundFleetId: string | null = null;

  /**
   * The fleet this foundation talks to: whatever `bindFleet` was told, else
   * whatever the backend was built with. Public because it is also the id every
   * EC2 tag filter and SSM path in the backend is scoped by, and `init` binds
   * it *after* the backend exists — so `createAwsBackend` reads it from here
   * rather than keeping a second copy that could disagree.
   */
  fleetId(): string | undefined {
    return this.boundFleetId ?? this.opts.fleetId;
  }

  private expectedName(): string {
    const id = this.fleetId();
    return id ? stackNameFor(id) : STACK_NAME;
  }

  bindFleet(fleetId: string): void {
    if (this.boundFleetId === fleetId) return;
    this.boundFleetId = fleetId;
    // Whatever discovery landed on before is not necessarily this fleet's.
    this.resolvedName = null;
  }

  /**
   * §4.8: every hermetic stack in the account that has not finished deleting, so
   * `init` can see the whole picture before it decides. `listHermeticStacks`
   * already knows what makes a stack hermetic's — its tag, or failing that its
   * name — and stacks mid-delete are *kept* in the answer with their status:
   * "one is being deleted" is a thing `init` has to refuse on (§4.7), not a
   * thing it should be unable to see.
   */
  async listStacks(): Promise<StackSummary[]> {
    let stacks: StackInfo[];
    try {
      stacks = await listHermeticStacks(this.cfn);
    } catch (e) {
      if (/does not exist/i.test(e instanceof Error ? e.message : "")) return [];
      throw asHermeticError(e, "could not list the hermetic stacks in this account");
    }
    return stacks.map((s) => ({
      stack_name: s.stack_name,
      stack_id: s.stack_id,
      fleet_id: s.tags[FLEET_ID_TAG] ?? s.tags["fleet_id"] ?? null,
      status: s.status,
    }));
  }

  private async describeByName(name: string): Promise<StackInfo | null> {
    try {
      const out = await this.cfn.send(new DescribeStacksCommand({ StackName: name }));
      const stack = out.Stacks?.[0];
      if (!stack?.StackId) return null;
      return normalizeStack(stack);
    } catch (e) {
      // CloudFormation reports "does not exist" as a validation error, not a 404.
      if (/does not exist/i.test(e instanceof Error ? e.message : "")) return null;
      throw asHermeticError(e, `could not describe the ${name} stack`);
    }
  }

  async describeStack(): Promise<StackInfo | null> {
    const first = this.resolvedName ?? this.expectedName();
    const found = await this.describeByName(first);
    if (found) {
      this.resolvedName = found.stack_name;
      return found;
    }
    // Nothing under the name this fleet id implies. Before concluding there is
    // no foundation, look for one by tag: that finds a pre-rename stack called
    // plain `hermetic`, and — for a backend not yet bound to a fleet, which is
    // what `init` holds while it decides — the one foundation already there.
    if (this.resolvedName !== null) return null;
    const discovered = await this.discover();
    if (discovered) this.resolvedName = discovered.stack_name;
    return discovered;
  }

  /**
   * This fleet's stack, whatever it is called. Bound to a fleet, that is an
   * exact tag match and nothing else will do. Unbound, §4.7's "one foundation
   * per account and region" is the assumption, so the single live hermetic
   * stack is the answer.
   */
  private async discover(): Promise<StackInfo | null> {
    let stacks: StackInfo[];
    try {
      stacks = await listHermeticStacks(this.cfn);
    } catch (e) {
      // A list has no name to be missing, but a mock (and some SDK error paths)
      // can still answer this way; "nothing there" is the honest reading, and
      // any other failure still surfaces.
      if (/does not exist/i.test(e instanceof Error ? e.message : "")) return null;
      throw e;
    }
    const fleetId = this.fleetId();
    if (fleetId !== undefined) {
      return (
        stacks.find((s) => s.tags[FLEET_ID_TAG] === fleetId || s.tags["fleet_id"] === fleetId) ?? null
      );
    }
    const live = stacks.filter((s) => !isStackDeleting(s.status));
    return (live.length > 0 ? live : stacks)[0] ?? null;
  }

  /**
   * The name a `DeleteStack`/`DescribeStackEvents` call has to use: whatever the
   * last `describeStack` resolved, or the name this fleet id implies. Never a
   * lookup of its own — every caller has already described the stack (the fleet
   * guard, or `createStack` itself), and a delete must not turn one API failure
   * into a differently-worded one.
   */
  private stackName(): string {
    return this.resolvedName ?? this.expectedName();
  }

  async createStack(params: {
    fleet_id: string;
    network: "public" | "nat";
    tags: Record<string, string>;
    signal?: AbortSignal;
    onProgress?: (progress: StackProgress) => void;
  }): Promise<StackInfo> {
    const parameters: Array<{ ParameterKey: string; ParameterValue: string }> = [
      { ParameterKey: "FleetId", ParameterValue: params.fleet_id },
      { ParameterKey: "HermeticVersion", ParameterValue: this.opts.hermeticVersion },
      { ParameterKey: "Network", ParameterValue: params.network },
      { ParameterKey: "BedrockModelArns", ParameterValue: this.opts.bedrockModelArns.join(",") },
    ];
    if (params.network === "nat") {
      if (!this.opts.resolveFckNatAmi) {
        throw new HermeticError("UNSUPPORTED", "no fck-nat AMI resolver was configured", {});
      }
      parameters.push({
        ParameterKey: "FckNatAmiId",
        ParameterValue: await this.opts.resolveFckNatAmi(),
      });
    }

    const name = stackNameFor(params.fleet_id);
    this.resolvedName = name;
    try {
      await this.cfn.send(
        new CreateStackCommand({
          StackName: name,
          TemplateBody: foundationTemplateBody(),
          // One named IAM role and its instance profile (§5.1).
          Capabilities: ["CAPABILITY_NAMED_IAM"],
          OnFailure: "ROLLBACK",
          EnableTerminationProtection: false,
          Parameters: parameters,
          Tags: [
            { Key: FLEET_ID_TAG, Value: params.fleet_id },
            { Key: VERSION_TAG, Value: this.opts.hermeticVersion },
            ...Object.entries(params.tags).map(([Key, Value]) => ({ Key, Value })),
          ],
        }),
      );
    } catch (e) {
      throw asHermeticError(e, `could not create the ${name} stack`);
    }

    return this.waitForStack(params.signal, params.onProgress);
  }

  /**
   * CloudFormation's own waiters do not take an `AbortSignal`, and every long
   * operation in hermetic must (§3.2 rule 2), so this polls. Each poll also
   * reads `DescribeStackEvents` so the caller can narrate resources as they
   * land — and so a failure names the resource that failed and why. The
   * stack-level reason is only ever "one or more resources failed"; the cause
   * lives on the first `*_FAILED` resource event.
   */
  private async waitForStack(
    signal?: AbortSignal,
    onProgress?: (progress: StackProgress) => void,
    healthy: ReadonlySet<string> = HEALTHY,
    gate: StackSnapshot | null = null,
  ): Promise<StackInfo> {
    const interval = this.opts.pollIntervalMs ?? 5000;
    const started = Date.now();
    const seen = new Set<string>();
    const failures: StackResourceEvent[] = [];
    let eventsAvailable = true;
    /**
     * With no snapshot there is nothing to move off, so the first terminal
     * status is the answer (the create path, where the stack did not exist a
     * moment ago). With one, the wait is not over until the stack has visibly
     * left it.
     */
    let moved = gate === null;
    for (;;) {
      if (signal?.aborted) {
        throw new HermeticError(
          "ABORTED",
          `stopped waiting for ${this.stackName()}; the stack is still being ${healthy === HEALTHY ? "created" : "updated"} in AWS`,
          { stack: this.stackName() },
        );
      }
      const stack = await this.describeStack();
      let fresh: StackResourceEvent[] = [];
      if (
        eventsAvailable &&
        (onProgress || !stack || !TERMINAL.test(stack.status) || !healthy.has(stack.status))
      ) {
        try {
          fresh = await this.newStackEvents(seen);
        } catch {
          // Missing `cloudformation:DescribeStackEvents`, most likely. The
          // wait still works; it just cannot say which resource it is on.
          eventsAvailable = false;
        }
      }
      for (const e of fresh) {
        if (isResourceFailure(e)) failures.push(e);
      }
      onProgress?.({
        status: stack?.status ?? "PENDING",
        elapsed_ms: Date.now() - started,
        events: fresh,
        events_available: eventsAvailable,
      });
      if (stack && !moved) {
        // Two ways to know the update has begun, and both are needed: the
        // status leaving the snapshot catches the common case, and a changed
        // `LastUpdatedTime` catches an update so short that no poll ever saw
        // `UPDATE_IN_PROGRESS`.
        if (stack.status !== gate!.status) moved = true;
        else {
          const now_ = await this.snapshot();
          if (now_ !== null && now_.last_updated_ms !== gate!.last_updated_ms) moved = true;
        }
      }
      if (stack && moved && TERMINAL.test(stack.status)) {
        if (!healthy.has(stack.status)) {
          const culprit = failures[0];
          throw new HermeticError(
            healthy === HEALTHY ? "INTERNAL" : "FOUNDATION_UPDATE_FAILED",
            `the ${stack.stack_name} stack finished in ${stack.status}${
              culprit
                ? `: ${culprit.logical_id} (${culprit.resource_type}) ${culprit.status}: ${culprit.reason ?? "CloudFormation gave no reason"}`
                : eventsAvailable
                  ? ""
                  : " (grant cloudformation:DescribeStackEvents to see which resource failed)"
            }`,
            {
              status: stack.status,
              stack_id: stack.stack_id,
              ...(culprit
                ? {
                    failed_resource: culprit.logical_id,
                    failed_type: culprit.resource_type,
                    reason: culprit.reason,
                  }
                : {}),
              failures: failures.map((f) => `${f.logical_id}: ${f.reason ?? f.status}`),
            },
          );
        }
        return stack;
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  /**
   * Resource events not yet in `seen`, oldest first. The API pages newest
   * first, so paging stops at the first already-seen event.
   */
  private async newStackEvents(seen: Set<string>): Promise<StackResourceEvent[]> {
    const fresh: StackResourceEvent[] = [];
    let token: string | undefined;
    paging: for (;;) {
      const name = this.stackName();
      const out = await this.cfn.send(
        new DescribeStackEventsCommand({ StackName: name, ...(token ? { NextToken: token } : {}) }),
      );
      for (const e of out.StackEvents ?? []) {
        if (!e.EventId) continue;
        if (seen.has(e.EventId)) break paging;
        seen.add(e.EventId);
        // The stack's own transitions are not a resource landing.
        if (e.LogicalResourceId === name || e.ResourceType === "AWS::CloudFormation::Stack") continue;
        fresh.push({
          event_id: e.EventId,
          logical_id: e.LogicalResourceId ?? "?",
          resource_type: e.ResourceType ?? "?",
          status: e.ResourceStatus ?? "?",
          reason: e.ResourceStatusReason ?? null,
          at: (e.Timestamp ?? new Date()).toISOString(),
        });
      }
      token = out.NextToken;
      if (!token) break;
    }
    return fresh.reverse();
  }

  /**
   * §6.6 step 3: `CreateChangeSet` of type `UPDATE` against this build's
   * template. `FleetId` and `Network` were decided at `init` and keep their
   * previous values, so an update can never silently repoint the fleet or
   * re-network it. `FckNatAmiId` is passed `UsePreviousValue` only when the
   * stack actually has it: CloudFormation rejects a previous-value reference to
   * a parameter that was never set, which is every `public` fleet.
   *
   * `BedrockModelArns` is the one parameter an update may restate (§8.3, v10):
   * the grant follows the fleet's provider profiles and agents, so the caller
   * computes it and states it. Omitted, it keeps its previous value exactly as
   * it always did.
   */
  async createChangeSet(params: {
    name: string;
    hermeticVersion: string;
    bedrockModelArns?: readonly string[];
  }): Promise<{ name: string; id: string }> {
    const stack = await this.requireStack();
    const usePrevious = ["FleetId", "Network"];
    if (params.bedrockModelArns === undefined) usePrevious.push("BedrockModelArns");
    if (await this.hasParameter("FckNatAmiId")) usePrevious.push("FckNatAmiId");
    return this.changeSet(stack, params.name, params.hermeticVersion, [
      ...usePrevious.map((ParameterKey) => ({ ParameterKey, UsePreviousValue: true })),
      ...(params.bedrockModelArns === undefined
        ? []
        : [
            {
              ParameterKey: "BedrockModelArns",
              ParameterValue: [...params.bedrockModelArns].join(","),
            },
          ]),
    ]);
  }

  /**
   * §5's re-network. `Network` is stated rather than reused — that is the whole
   * difference from the method above, and why it is a separate method: the
   * guarantee that a foundation update cannot re-network a fleet is worth more
   * than the one call site this saves.
   *
   * `FckNatAmiId` is stated when the caller resolved one (target `nat`) and
   * simply omitted otherwise, which leaves it at the template default. It is
   * *not* passed `UsePreviousValue` on a move to `public`: the parameter is
   * unused in that branch, and a previous-value reference to a parameter the
   * stack never had is an error CloudFormation raises before it does anything.
   */
  async createNetworkChangeSet(params: {
    name: string;
    hermeticVersion: string;
    network: "public" | "nat";
    fckNatAmiId?: string;
  }): Promise<{ name: string; id: string }> {
    const stack = await this.requireStack();
    return this.changeSet(stack, params.name, params.hermeticVersion, [
      { ParameterKey: "Network", ParameterValue: params.network },
      ...(params.fckNatAmiId === undefined
        ? []
        : [{ ParameterKey: "FckNatAmiId", ParameterValue: params.fckNatAmiId }]),
      { ParameterKey: "FleetId", UsePreviousValue: true },
      { ParameterKey: "BedrockModelArns", UsePreviousValue: true },
    ]);
  }

  /** The stack this backend is bound to, or the refusal every update starts with. */
  private async requireStack(): Promise<StackInfo> {
    const stack = await this.describeStack();
    if (!stack) {
      throw new HermeticError("NOT_FOUND", `no ${this.stackName()} stack to update`, {
        stack: this.stackName(),
      });
    }
    return stack;
  }

  /**
   * Everything the two change sets agree about: this build's template body, the
   * IAM capability, the tag set, and `HermeticVersion`. Shared so that a fix to
   * the tag argument below lands on both — the two differ only in what they say
   * about `Network`, and nothing else about them should be allowed to diverge.
   */
  private async changeSet(
    stack: StackInfo,
    name: string,
    hermeticVersion: string,
    parameters: Array<{ ParameterKey: string; ParameterValue?: string; UsePreviousValue?: boolean }>,
  ): Promise<{ name: string; id: string }> {
    /**
     * Tags are **not** carried over by an update: `UpdateStack` (and so
     * `ExecuteChangeSet`) replaces the stack's tag set wholesale with whatever
     * the request names, and a request that names none strips every one. That
     * would take `hermetic:fleet_id` off the stack — which is the tag
     * `guardFleet` reads on *every* subsequent call, and the one
     * `listHermeticStacks` finds a foundation by — so a successful foundation
     * update would end with the fleet unreachable by its own tooling.
     *
     * hermetic's own two are re-asserted at their current values; everything
     * else the stack carries (an operator's cost-centre tag, a `network` tag
     * from `init`) is passed straight back through.
     */
    const fleetId = stack.tags[FLEET_ID_TAG] ?? stack.tags["fleet_id"] ?? this.opts.fleetId;
    const ours: Record<string, string> = {
      ...(fleetId === undefined ? {} : { [FLEET_ID_TAG]: fleetId }),
      [VERSION_TAG]: hermeticVersion,
    };
    const tags = Object.entries({ ...stack.tags, ...ours })
      // `normalizeStack` mirrors the two prefixed tags under bare aliases for
      // core's guards to read; sending the aliases back would put tags on the
      // stack that CloudFormation never had.
      .filter(([Key]) => Key !== "fleet_id" && Key !== "hermetic_version")
      .map(([Key, Value]) => ({ Key, Value }));
    try {
      const out = await this.cfn.send(
        new CreateChangeSetCommand({
          StackName: stack.stack_name,
          ChangeSetName: name,
          ChangeSetType: "UPDATE",
          TemplateBody: foundationTemplateBody(),
          Capabilities: ["CAPABILITY_NAMED_IAM"],
          Tags: tags,
          Parameters: [
            { ParameterKey: "HermeticVersion", ParameterValue: hermeticVersion },
            ...parameters,
          ],
        }),
      );
      return { name, id: out.Id ?? name };
    } catch (e) {
      throw asHermeticError(e, `could not create a change set on the ${stack.stack_name} stack`);
    }
  }

  /**
   * Today's fck-nat arm64 AMI. The resolver is optional on the options object
   * because a backend built for a `public` fleet never needs one; asking for it
   * without one wired is a configuration mistake, not a missing image, so the
   * two failures say different things.
   */
  async resolveFckNatAmi(): Promise<string> {
    if (!this.opts.resolveFckNatAmi) {
      throw new HermeticError("UNSUPPORTED", "no fck-nat AMI resolver was configured", {});
    }
    return this.opts.resolveFckNatAmi();
  }

  /**
   * §5: the NAT appliance, or `null` on a stack that has none.
   *
   * `null` is returned for every `public` fleet — `DescribeStackResources` finds
   * no `NatInstance`, because the resource is gated on the `IsNat` condition —
   * and for a `nat` stack whose resources cannot be read. Both are "nothing to
   * report", which a head must show as *unchecked* rather than as healthy; the
   * distinction from a real answer is what `DoctorReport.network.checked_nat`
   * carries.
   */
  async describeNat(): Promise<NatHealth | null> {
    const stack = await this.describeStack();
    if (!stack) return null;
    let instanceId: string | null = null;
    let routeTableId: string | null = null;
    try {
      const out = await this.cfn.send(
        new DescribeStackResourcesCommand({ StackName: stack.stack_name }),
      );
      for (const r of out.StackResources ?? []) {
        if (r.LogicalResourceId === NAT_INSTANCE_LOGICAL_ID) instanceId = r.PhysicalResourceId ?? null;
        if (r.LogicalResourceId === PRIVATE_ROUTE_TABLE_LOGICAL_ID) {
          routeTableId = r.PhysicalResourceId ?? null;
        }
      }
    } catch {
      // A stack whose resources we may not list is one we cannot report on.
      return null;
    }
    if (instanceId === null) return null;
    const egress_ip = stack.outputs["NatEgressIp"] ?? null;
    if (routeTableId === null || !this.opts.probeNat) {
      // The instance exists and the route could not be looked at. Said as two
      // nulls rather than as a guess: a blackholed route reported `active` is
      // the one lie this check exists to prevent.
      return { instance_id: instanceId, instance_state: null, egress_ip, route_state: null };
    }
    const probed = await this.opts.probeNat({ instanceId, routeTableId });
    return {
      instance_id: instanceId,
      instance_state: probed.instance_state,
      egress_ip,
      route_state: probed.route_state,
    };
  }

  /** Which parameters the live stack carries, so `UsePreviousValue` is only asked for real ones. */
  private async hasParameter(key: string): Promise<boolean> {
    try {
      const found = await this.describeStack();
      return found !== null && key in found.parameters;
    } catch {
      // A stack we cannot read the parameters of is one we do not ask to reuse
      // them: omitting an optional parameter leaves it at its template default.
      return false;
    }
  }

  async describeChangeSet(name: string): Promise<ChangeSetInfo> {
    const changes: ChangeSetChange[] = [];
    let token: string | undefined;
    let status = "UNKNOWN";
    let statusReason: string | null = null;
    let id = name;
    try {
      for (;;) {
        const out = await this.cfn.send(
          new DescribeChangeSetCommand({
            ChangeSetName: name,
            StackName: this.stackName(),
            ...(token ? { NextToken: token } : {}),
          }),
        );
        status = out.Status ?? "UNKNOWN";
        statusReason = out.StatusReason ?? null;
        id = out.ChangeSetId ?? name;
        for (const change of out.Changes ?? []) {
          const rc = change.ResourceChange;
          if (!rc) continue;
          changes.push({
            logicalId: rc.LogicalResourceId ?? "?",
            resourceType: rc.ResourceType ?? "?",
            action: rc.Action ?? "?",
            replacement: replacementOf(rc.Replacement),
          });
        }
        token = out.NextToken;
        if (!token) break;
      }
    } catch (e) {
      throw asHermeticError(e, `could not describe the ${name} change set`);
    }
    return { name, id, status, statusReason, changes };
  }

  /**
   * `ExecuteChangeSet` and then the same narrated wait a create gets — except
   * that `UPDATE_ROLLBACK_COMPLETE` is a failure here, because it means
   * CloudFormation put the stack back the way it was.
   */
  async executeChangeSet(params: {
    name: string;
    signal?: AbortSignal;
    onProgress?: (progress: StackProgress) => void;
  }): Promise<StackInfo> {
    const stackName = this.stackName();
    /**
     * The snapshot is taken *before* the execute, and it is what makes the wait
     * correct. `ExecuteChangeSet` returns the moment CloudFormation accepts the
     * request, and the very next `DescribeStacks` usually still reports the
     * stack exactly as it was — `CREATE_COMPLETE`, which is both terminal and
     * healthy. Without this gate the waiter returned immediately and the
     * artifacts, migrate and stamp phases all ran against a stack that was
     * still updating, or already rolling back.
     */
    const before = await this.snapshot();
    try {
      await this.cfn.send(
        new ExecuteChangeSetCommand({ ChangeSetName: params.name, StackName: stackName }),
      );
    } catch (e) {
      throw asHermeticError(e, `could not execute the ${params.name} change set`);
    }
    return this.waitForStack(params.signal, params.onProgress, HEALTHY_AFTER_UPDATE, before);
  }

  /**
   * The stack's status and its `LastUpdatedTime`, as raw as CloudFormation
   * gives them. `StackInfo` deliberately does not carry the timestamp — nothing
   * else in hermetic has a use for it — and this is the one caller that needs
   * to tell "the same terminal state as a moment ago" from "a new one".
   */
  private async snapshot(): Promise<StackSnapshot | null> {
    try {
      const out = await this.cfn.send(new DescribeStacksCommand({ StackName: this.stackName() }));
      const stack = out.Stacks?.[0];
      if (!stack) return null;
      return {
        status: stack.StackStatus ?? "UNKNOWN",
        last_updated_ms: stack.LastUpdatedTime?.getTime() ?? null,
      };
    } catch {
      // No snapshot means no gate: the wait falls back to "the first terminal
      // status wins", which is what it did before and is never *less* correct
      // than refusing to wait at all.
      return null;
    }
  }

  /** Idempotent: CloudFormation accepts a delete of a change set that is already gone. */
  async deleteChangeSet(name: string): Promise<void> {
    try {
      await this.cfn.send(
        new DeleteChangeSetCommand({ ChangeSetName: name, StackName: this.stackName() }),
      );
    } catch (e) {
      if (/does not exist|ChangeSetNotFound/i.test(e instanceof Error ? e.message : "")) return;
      throw asHermeticError(e, `could not delete the ${name} change set`);
    }
  }

  /**
   * `hermetic teardown` is `DeleteStack` (§5). The caller has already guarded.
   *
   * `DeleteStack` is asynchronous: it returns as soon as CloudFormation accepts
   * the request, with the VPC, the tables and the bucket all still there. Every
   * phase teardown runs after this one assumed they were gone — and an `init`
   * straight afterwards would find a `DELETE_IN_PROGRESS` stack and attach to
   * it — so this waits for the deletion to actually finish.
   */
  async deleteStack(opts: { signal?: AbortSignal } = {}): Promise<void> {
    const name = this.stackName();
    try {
      await this.cfn.send(new DeleteStackCommand({ StackName: name }));
    } catch (e) {
      throw asHermeticError(e, `could not delete the ${name} stack`);
    }
    await this.waitForStackDeleted(opts.signal, name);
  }

  /**
   * Polls `DescribeStacks` until the stack is gone. "Gone" has two spellings:
   * CloudFormation reports a deleted stack as a `does not exist` validation
   * error once it has been reaped, and as `DELETE_COMPLETE` until then — both
   * are success. `DELETE_FAILED` is not, and it carries the reason (a bucket
   * that refilled, an ENI CloudFormation cannot detach), which is the one piece
   * of information that makes the failure actionable.
   */
  private async waitForStackDeleted(signal?: AbortSignal, name: string = STACK_NAME): Promise<void> {
    const interval = this.opts.pollIntervalMs ?? 5000;
    const deadline = Date.now() + (this.opts.deleteTimeoutMs ?? DELETE_TIMEOUT_MS);
    for (;;) {
      if (signal?.aborted) {
        throw new HermeticError(
          "ABORTED",
          `stopped waiting for ${name}; the stack is still being deleted in AWS`,
          { stack: name },
        );
      }

      let stack: { StackStatus?: string; StackStatusReason?: string; StackId?: string } | undefined;
      try {
        const out = await this.cfn.send(new DescribeStacksCommand({ StackName: name }));
        stack = out.Stacks?.[0];
      } catch (e) {
        if (/does not exist/i.test(e instanceof Error ? e.message : "")) return;
        throw asHermeticError(e, `could not watch the ${name} stack being deleted`);
      }
      if (!stack) return;

      const status = stack.StackStatus ?? "UNKNOWN";
      if (status === "DELETE_COMPLETE") return;
      if (status === "DELETE_FAILED") {
        throw new HermeticError(
          "INTERNAL",
          `the ${name} stack finished in DELETE_FAILED: ${stack.StackStatusReason ?? "CloudFormation gave no reason"}`,
          {
            status,
            ...(stack.StackStatusReason === undefined ? {} : { reason: stack.StackStatusReason }),
            ...(stack.StackId === undefined ? {} : { stack_id: stack.StackId }),
          },
        );
      }
      if (Date.now() >= deadline) {
        throw new HermeticError(
          "INTERNAL",
          `the ${name} stack was still ${status} after ${Math.round((this.opts.deleteTimeoutMs ?? DELETE_TIMEOUT_MS) / 60_000)} minutes; it is still being deleted in AWS`,
          { status, stack: name },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
}

/** Flatten CloudFormation's array-of-pairs shape into the records core reads. */
export function normalizeStack(stack: {
  StackId?: string;
  StackName?: string;
  StackStatus?: string;
  Tags?: Array<{ Key?: string; Value?: string }>;
  Outputs?: Array<{ OutputKey?: string; OutputValue?: string }>;
  Parameters?: Array<{ ParameterKey?: string; ParameterValue?: string }>;
}): StackInfo {
  const tags: Record<string, string> = {};
  for (const tag of stack.Tags ?? []) {
    if (tag.Key && tag.Value !== undefined) tags[tag.Key] = tag.Value;
  }
  // `hermetic:fleet_id` is the tag on the stack; core's guards read `fleet_id`,
  // so both spellings are present and always agree.
  if (tags[FLEET_ID_TAG] !== undefined) tags["fleet_id"] ??= tags[FLEET_ID_TAG];
  if (tags[VERSION_TAG] !== undefined) tags["hermetic_version"] ??= tags[VERSION_TAG];

  const outputs: Record<string, string> = {};
  for (const out of stack.Outputs ?? []) {
    if (out.OutputKey && out.OutputValue !== undefined) outputs[out.OutputKey] = out.OutputValue;
  }
  // The parameters the live stack carries. `Network` is here and nowhere else
  // authoritative (§5); `hasParameter` and the v6 migration both read it.
  const parameters: Record<string, string> = {};
  for (const param of stack.Parameters ?? []) {
    if (param.ParameterKey && param.ParameterValue !== undefined) {
      parameters[param.ParameterKey] = param.ParameterValue;
    }
  }

  return {
    stack_id: stack.StackId ?? "",
    stack_name: stack.StackName ?? STACK_NAME,
    status: stack.StackStatus ?? "UNKNOWN",
    tags,
    outputs,
    parameters,
  };
}
