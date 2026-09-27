/**
 * The fixture's CloudFormation: the `foundation` port of `MemoryBackend`, split
 * out of `memory.ts` (AGENTS.md rule 5).
 */
import type { NatHealth, NetworkMode } from "../schema/index.ts";
import { stackNameFor, tablesFor } from "../schema/index.ts";
import { HermeticError } from "../errors.ts";
import type { Backend, ChangeSetInfo, StackInfo, StackSummary, StackProgress } from "./types.ts";

import { FLEET_ID_TAG } from "./constants.ts";

import { FIXTURE_NAT_EGRESS_IP } from "./fixture/memory-fixture.ts";

import type { MemoryBackend } from "./memory.ts";

/** The resources a fixture create "lands", in order; a subset of the real template's. */
const FIXTURE_STACK_RESOURCES: ReadonlyArray<readonly [string, string]> = [
  ["Vpc", "AWS::EC2::VPC"],
  ["InternetGateway", "AWS::EC2::InternetGateway"],
  ["PublicSubnet0", "AWS::EC2::Subnet"],
  ["PublicSubnet1", "AWS::EC2::Subnet"],
  ["AgentSecurityGroup", "AWS::EC2::SecurityGroup"],
  ["AgentRole", "AWS::IAM::Role"],
  ["Bucket", "AWS::S3::Bucket"],
  ["AgentsTable", "AWS::DynamoDB::Table"],
  ["EventsTable", "AWS::DynamoDB::Table"],
  ["SnapshotPolicy", "AWS::DLM::LifecyclePolicy"],
];

export function createMemoryFoundation(b: MemoryBackend): Backend["foundation"] {
  return {
    describeStack: async (): Promise<StackInfo | null> => (b.stack ? structuredClone(b.stack) : null),

    listStacks: async (): Promise<StackSummary[]> => {
      const all = [...(b.stack ? [b.stack] : []), ...[...b.parkedFleets.values()].map((f) => f.stack)];
      return all.map((s) => ({
        stack_name: s.stack_name,
        stack_id: s.stack_id,
        fleet_id: b.stackFleetId(s),
        status: s.status,
      }));
    },

    bindFleet: (fleetId: string): void => {
      if (b.stack && b.stackFleetId(b.stack) === fleetId) return;
      const target = b.parkedFleets.get(fleetId);
      if (!target) return;
      if (b.stack) {
        const current = b.stackFleetId(b.stack);
        if (current !== null) {
          b.parkedFleets.set(current, { stack: b.stack, item: b.fleetItem });
        }
      }
      b.parkedFleets.delete(fleetId);
      b.stack = target.stack;
      b.fleetItem = target.item;
    },
    createStack: async (params: {
      fleet_id: string;
      network: "public" | "nat";
      tags: Record<string, string>;
      signal?: AbortSignal;
      onProgress?: (progress: StackProgress) => void;
    }): Promise<StackInfo> => {
      // Same fleet: idempotent, as a re-run of `init --create` must be. A
      // *different* fleet is a second foundation in the same account (§4.8), so
      // the one that was live is parked rather than answered with.
      if (b.stack && b.stackFleetId(b.stack) === params.fleet_id) {
        return structuredClone(b.stack);
      }
      if (b.stack) {
        const current = b.stackFleetId(b.stack);
        if (current !== null) {
          b.parkedFleets.set(current, { stack: b.stack, item: b.fleetItem });
        }
        b.fleetItem = null;
      }
      b.record("foundation.createStack");
      // The same shape a real create narrates, so the wizard can be developed
      // against it. `slowStackMs` (dev:wizard's slow-stack knob, `OpenOptions.fixtureOptions`)
      // stretches it over real time to reproduce the silent-phase UX.
      if (params.onProgress) {
        const started = Date.now();
        const step = b.slowStackMs > 0 ? b.slowStackMs / (FIXTURE_STACK_RESOURCES.length * 2) : 0;
        const pause = () =>
          step > 0 ? new Promise<void>((r) => setTimeout(r, step)) : Promise.resolve();
        let n = 0;
        for (const [logical_id, resource_type] of FIXTURE_STACK_RESOURCES) {
          for (const status of ["CREATE_IN_PROGRESS", "CREATE_COMPLETE"] as const) {
            await pause();
            if (params.signal?.aborted) break;
            params.onProgress({
              status: "CREATE_IN_PROGRESS",
              elapsed_ms: Date.now() - started,
              events_available: true,
              events: [
                {
                  event_id: `fixture-${n++}`,
                  logical_id,
                  resource_type,
                  status,
                  reason: null,
                  at: new Date().toISOString(),
                },
              ],
            });
          }
        }
      }
      b.stack = {
        stack_id: `arn:aws:cloudformation:us-west-2:${b.accountId}:stack/${stackNameFor(params.fleet_id)}/fixture`,
        stack_name: stackNameFor(params.fleet_id),
        status: "CREATE_COMPLETE",
        tags: { ...params.tags, fleet_id: params.fleet_id, network: params.network },
        // The parameters a real `CreateStack` was given (§5). `Network` is the
        // authoritative record of the mode — `_fleet.network` is the cache — so
        // the fixture has to carry it here, not only as a tag.
        parameters: { FleetId: params.fleet_id, Network: params.network },
        // The output set the real template emits (§5). The fleet manifest's
        // `resources` is built from these and every field is required, so a
        // fixture that emitted fewer would not be a fleet `init` could publish.
        outputs: {
          Bucket: "hermetic-fixture-bucket",
          BucketName: "hermetic-fixture-bucket",
          AgentsTable: tablesFor(stackNameFor(params.fleet_id)).agents,
          EventsTable: tablesFor(stackNameFor(params.fleet_id)).events,
          AgentSecurityGroupId: "sg-fixture",
          SecurityGroupId: "sg-fixture",
          InstanceProfileArn: `arn:aws:iam::${b.accountId}:instance-profile/hermetic-agent`,
          RoleArn: `arn:aws:iam::${b.accountId}:role/hermetic-agent`,
          VpcId: "vpc-fixture",
          // The real template's `SubnetIds` output switches on the `IsNat`
          // condition, so the fixture's does too: a `nat` fleet reports its
          // private subnets, and anything reading subnets sees the mode.
          SubnetIds:
            params.network === "nat"
              ? "subnet-fixture-private0,subnet-fixture-private1"
              : "subnet-fixture0,subnet-fixture1",
          Network: params.network,
          // Only a `nat` stack emits one: a `public` fleet's agents each leave
          // from their own address, so there is no single egress IP to name.
          ...(params.network === "nat" ? { NatEgressIp: FIXTURE_NAT_EGRESS_IP } : {}),
        },
      };
      // §5: `NatEip`, the one stack resource that can outlive the stack. Only a
      // `nat` fleet has one, and it carries the template's tags — which is how
      // teardown finds it afterwards if the stack fails to take it (§4.6).
      if (params.network === "nat") b.allocateNatAddress(params.fleet_id);
      return structuredClone(b.stack);
    },
    deleteStack: async (): Promise<void> => {
      if (!b.stack) return;
      b.record("foundation.deleteStack");
      const fleetId = b.stackFleetId(b.stack);
      const mine = [...b.addresses].filter(([, a]) => a.tags[FLEET_ID_TAG] === fleetId);
      /**
       * What real CloudFormation does with an `AWS::EC2::EIP` it cannot
       * release: the stack ends `DELETE_FAILED` and *stays*, with everything
       * else in it still there, and `waitForStackDeleted` turns that status
       * into this error (`aws/cfn.ts`). It is the state that produces a
       * leftover address in the first place, so the fixture has to be able to
       * reach it — teardown's sweep is what names the address behind it (§4.6).
       */
      const stuck = mine.filter(([, a]) => a.association_id !== null);
      if (stuck.length > 0) {
        throw new HermeticError(
          "INTERNAL",
          `the ${b.stack.stack_name} stack finished in DELETE_FAILED: The following resource(s) failed to delete: [NatEip]`,
          { status: "DELETE_FAILED", addresses: stuck.map(([id]) => id) },
        );
      }
      /**
       * `retainAddressOnDeleteStack` models the documented way out of that
       * failure: `DeleteStack --retain-resources NatEip` takes the stack and
       * leaves the allocation, now unassociated because the NAT instance went
       * with the stack. That aftermath is the leftover `--purge` sweeps.
       */
      if (!b.retainAddressOnDeleteStack) for (const [id] of mine) b.addresses.delete(id);
      b.stack = null;
      /**
       * The `agents` table is *in* the stack (§5), so deleting the stack takes
       * every agent row and `_fleet` — which is a row in that same table — with
       * it. Modelling the stack alone left a fixture where a teardown that had
       * already deleted the foundation could still read its fleet, renew its
       * lock and scan its agents, so the retry path a real half-finished
       * teardown lands on could not be reached from a test at all.
       */
      b.tornDownFleetId = b.fleetItem?.fleet_id ?? fleetId;
      b.agents.clear();
      b.fleetItem = null;
    },
    createChangeSet: async (params: {
      name: string;
      hermeticVersion: string;
      bedrockModelArns?: readonly string[];
    }): Promise<{ name: string; id: string }> => {
      if (!b.stack) {
        throw new HermeticError("NOT_FOUND", "no foundation stack to update", {});
      }
      b.record("foundation.createChangeSet");
      /**
       * §8.3: the one parameter an update restates. Written onto the stack at
       * *change-set* time rather than at execute, because the in-memory stack
       * is the whole of this backend's CloudFormation and a test that reads the
       * parameter back is asking what the update decided.
       */
      if (params.bedrockModelArns !== undefined) {
        b.stack.parameters["BedrockModelArns"] = [...params.bedrockModelArns].join(",");
      }
      b.changeSets.set(params.name, {
        name: params.name,
        id: `arn:aws:cloudformation:us-west-2:${b.accountId}:changeSet/${params.name}/fixture`,
        status: b.changeSetStatus,
        statusReason: b.changeSetStatusReason,
        changes: structuredClone(b.changeSetChanges),
      });
      b.pendingHermeticVersion = params.hermeticVersion;
      return { name: params.name, id: `changeset-${params.name}` };
    },
    /**
     * §5's re-network. The same bookkeeping as the sibling above plus the two
     * values a re-network states rather than reuses; nothing about the stack
     * moves until the change set is executed.
     */
    createNetworkChangeSet: async (params: {
      name: string;
      hermeticVersion: string;
      network: NetworkMode;
      fckNatAmiId?: string;
    }): Promise<{ name: string; id: string }> => {
      if (!b.stack) {
        throw new HermeticError("NOT_FOUND", "no foundation stack to update", {});
      }
      b.record("foundation.createNetworkChangeSet");
      b.changeSets.set(params.name, {
        name: params.name,
        id: `arn:aws:cloudformation:us-west-2:${b.accountId}:changeSet/${params.name}/fixture`,
        status: b.changeSetStatus,
        statusReason: b.changeSetStatusReason,
        changes: structuredClone(b.changeSetChanges),
      });
      b.pendingHermeticVersion = params.hermeticVersion;
      b.pendingNetwork.set(params.name, {
        network: params.network,
        fckNatAmiId: params.fckNatAmiId ?? null,
      });
      return { name: params.name, id: `changeset-${params.name}` };
    },
    /** `fckNatAmiId = null` is a region with no image: the preflight refusal (§5). */
    resolveFckNatAmi: async (): Promise<string> => {
      b.record("foundation.resolveFckNatAmi");
      if (b.fckNatAmiId === null) {
        throw new HermeticError("NOT_FOUND", "no fck-nat-amzn2 image in us-west-2", {
          region: "us-west-2",
        });
      }
      return b.fckNatAmiId;
    },
    /**
     * §5: `null` on a `public` fleet, because there is no NAT appliance to
     * report on — which every reader must show as unchecked rather than as a
     * clean bill.
     */
    describeNat: async (): Promise<NatHealth | null> => {
      if (b.stack?.parameters["Network"] !== "nat") return null;
      return {
        instance_id: "i-fixturenat0000000",
        instance_state: b.natHealth.instance_state,
        egress_ip: b.stack.outputs["NatEgressIp"] ?? null,
        route_state: b.natHealth.route_state,
      };
    },
    describeChangeSet: async (name: string): Promise<ChangeSetInfo> => {
      const found = b.changeSets.get(name);
      if (!found) {
        throw new HermeticError("NOT_FOUND", `no change set ${name}`, { name });
      }
      return structuredClone(found);
    },
    executeChangeSet: async (params: {
      name: string;
      signal?: AbortSignal;
      onProgress?: (progress: StackProgress) => void;
    }): Promise<StackInfo> => {
      const found = b.changeSets.get(params.name);
      if (!found) {
        throw new HermeticError("NOT_FOUND", `no change set ${params.name}`, { name: params.name });
      }
      b.record("foundation.executeChangeSet");
      // The same narration a real update produces, one `UPDATE_COMPLETE` per
      // changed resource, so a head's progress UI can be developed against it.
      if (params.onProgress) {
        const started = Date.now();
        let n = 0;
        for (const change of found.changes) {
          if (params.signal?.aborted) break;
          params.onProgress({
            status: "UPDATE_IN_PROGRESS",
            elapsed_ms: Date.now() - started,
            events_available: true,
            events: [
              {
                event_id: `fixture-update-${n++}`,
                logical_id: change.logicalId,
                resource_type: change.resourceType,
                status: "UPDATE_COMPLETE",
                reason: null,
                at: b.now().toISOString(),
              },
            ],
          });
        }
      }
      b.changeSets.delete(params.name);
      if (b.stack) {
        /**
         * A re-network moves the stack's `Network` parameter and everything
         * derived from it: which subnets `SubnetIds` names, and whether there
         * is an egress IP at all. The fixture does the same, because the whole
         * point of `network.status` after an apply is that it reads the *stack*
         * rather than the cache, and a fixture whose stack never moved would
         * let a broken re-network pass (§5).
         */
        const pending = b.pendingNetwork.get(params.name) ?? null;
        const network = pending?.network ?? null;
        b.stack = {
          ...b.stack,
          status: "UPDATE_COMPLETE",
          tags: {
            ...b.stack.tags,
            ...(b.pendingHermeticVersion ? { hermetic_version: b.pendingHermeticVersion } : {}),
            ...(network ? { network } : {}),
          },
          parameters: {
            ...b.stack.parameters,
            ...(network ? { Network: network } : {}),
            ...(pending?.fckNatAmiId ? { FckNatAmiId: pending.fckNatAmiId } : {}),
          },
          outputs: {
            ...b.stack.outputs,
            ...(network
              ? {
                  Network: network,
                  SubnetIds:
                    network === "nat"
                      ? "subnet-fixture-private0,subnet-fixture-private1"
                      : "subnet-fixture0,subnet-fixture1",
                }
              : {}),
          },
        };
        if (network === "nat") b.stack.outputs["NatEgressIp"] = FIXTURE_NAT_EGRESS_IP;
        else if (network === "public") delete b.stack.outputs["NatEgressIp"];
      }
      // Whether or not there was a stack to move: an executed change set is
      // spent, and leaving its parameters armed would apply them to the next.
      b.pendingNetwork.delete(params.name);
      return structuredClone(b.stack as StackInfo);
    },
    deleteChangeSet: async (name: string): Promise<void> => {
      if (!b.changeSets.has(name)) return;
      b.record("foundation.deleteChangeSet");
      b.changeSets.delete(name);
      /**
       * A change set that is deleted rather than executed changes nothing — so
       * the network it would have set goes with it, and only it: deleting a
       * plan's throwaway change set must not disarm the one an `apply` is about
       * to execute (§5).
       */
      b.pendingNetwork.delete(name);
    },
  };
}
