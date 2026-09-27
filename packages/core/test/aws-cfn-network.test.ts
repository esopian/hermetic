/**
 * The AWS side of §5's re-network: the change set that states `Network` rather
 * than reusing it, the NAT probe, and the stack-outputs memo that has to be
 * dropped when any of them lands.
 *
 * These are the three things `MemoryBackend` cannot answer for. The parameter
 * list is a contract with CloudFormation — a `UsePreviousValue` for a parameter
 * the stack never had is rejected before anything runs — the NAT probe is two
 * EC2 reads whose *absence* must not read as health, and the memo is a bug that
 * only exists in the real backend: a portal that keeps launching agents into the
 * subnets a re-network moved away from.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  CloudFormationClient,
  CreateChangeSetCommand,
  DescribeStackEventsCommand,
  DescribeStackResourcesCommand,
  DescribeStacksCommand,
  ExecuteChangeSetCommand,
} from "@aws-sdk/client-cloudformation";
import type { StackStatus } from "@aws-sdk/client-cloudformation";
import {
  DescribeInstancesCommand,
  DescribeNetworkInterfacesCommand,
  DescribeRouteTablesCommand,
  DescribeSubnetsCommand,
  EC2Client,
  RunInstancesCommand,
} from "@aws-sdk/client-ec2";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { mockClient } from "aws-sdk-client-mock";
import { CfnFoundation } from "../src/aws/cfn.ts";
import { foundationTemplateBody } from "../src/aws/cfn-template.ts";
import { createAwsBackend } from "../src/aws/index.ts";
import { probeNat } from "../src/aws/ec2.ts";
import { callCount, inputsOf, installTestProfile, TEST_PROFILE } from "./aws-harness.ts";

const profile = installTestProfile();
afterAll(() => profile.restore());

const cfn = mockClient(CloudFormationClient);
const ec2 = mockClient(EC2Client);
const s3 = mockClient(S3Client);
const sts = mockClient(STSClient);
beforeEach(() => {
  cfn.reset();
  ec2.reset();
  s3.reset();
  sts.reset();
});

const ACCOUNT = "123456789012";
const FLEET_ID = "k7m2x9qa";
const STACK = `hermetic-${FLEET_ID}`;

function foundation(opts: Partial<ConstructorParameters<typeof CfnFoundation>[1]> = {}) {
  return new CfnFoundation(new CloudFormationClient({ region: "us-west-2" }), {
    fleetId: FLEET_ID,
    bedrockModelArns: ["arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude"],
    hermeticVersion: "0.4.1",
    pollIntervalMs: 1,
    ...opts,
  });
}

function stack(
  status: StackStatus = "CREATE_COMPLETE",
  outputs: Record<string, string> = { SubnetIds: "subnet-pub0,subnet-pub1" },
) {
  return {
    Stacks: [
      {
        StackId: `arn:aws:cloudformation:us-west-2:${ACCOUNT}:stack/${STACK}/abc`,
        StackName: STACK,
        StackStatus: status,
        CreationTime: new Date(),
        Parameters: [
          { ParameterKey: "FleetId", ParameterValue: FLEET_ID },
          { ParameterKey: "HermeticVersion", ParameterValue: "0.4.0" },
          { ParameterKey: "Network", ParameterValue: "public" },
          { ParameterKey: "BedrockModelArns", ParameterValue: "arn:x" },
        ],
        Tags: [
          { Key: "hermetic:fleet_id", Value: FLEET_ID },
          { Key: "hermetic:version", Value: "0.4.0" },
        ],
        Outputs: Object.entries(outputs).map(([OutputKey, OutputValue]) => ({
          OutputKey,
          OutputValue,
        })),
      },
    ],
  };
}

type ChangeSetInput = {
  StackName: string;
  ChangeSetName: string;
  ChangeSetType: string;
  TemplateBody: string;
  Capabilities: string[];
  Tags: Array<{ Key: string; Value: string }>;
  Parameters: Array<{ ParameterKey: string; ParameterValue?: string; UsePreviousValue?: boolean }>;
};

describe("createNetworkChangeSet", () => {
  test("states Network and the fresh AMI, and reuses only the two that were decided at init", async () => {
    cfn.on(DescribeStacksCommand).resolves(stack());
    cfn.on(CreateChangeSetCommand).resolves({ Id: "arn:changeset/net" });

    await foundation().createNetworkChangeSet({
      name: "cs-net",
      hermeticVersion: "0.5.0",
      network: "nat",
      fckNatAmiId: "ami-0fcknat",
    });

    const [input] = inputsOf<ChangeSetInput>(cfn, CreateChangeSetCommand);
    expect(input!.Parameters).toEqual([
      { ParameterKey: "HermeticVersion", ParameterValue: "0.5.0" },
      { ParameterKey: "Network", ParameterValue: "nat" },
      { ParameterKey: "FckNatAmiId", ParameterValue: "ami-0fcknat" },
      { ParameterKey: "FleetId", UsePreviousValue: true },
      { ParameterKey: "BedrockModelArns", UsePreviousValue: true },
    ]);
    // Everything else is the sibling's, from the helper the two share.
    expect(input!.ChangeSetType).toBe("UPDATE");
    expect(input!.TemplateBody).toBe(foundationTemplateBody());
    expect(input!.Capabilities).toEqual(["CAPABILITY_NAMED_IAM"]);
    const tags = Object.fromEntries(input!.Tags.map((t) => [t.Key, t.Value]));
    expect(tags["hermetic:fleet_id"]).toBe(FLEET_ID);
    expect(tags["hermetic:version"]).toBe("0.5.0");
  });

  /**
   * A move to `public` leaves the parameter alone entirely. `UsePreviousValue`
   * would be an error on a stack that never had it, and a value would pin an
   * AMI the `public` branch never reads.
   */
  test("a move to public names no FckNatAmiId at all", async () => {
    cfn.on(DescribeStacksCommand).resolves(stack());
    cfn.on(CreateChangeSetCommand).resolves({ Id: "id" });

    await foundation().createNetworkChangeSet({
      name: "cs-pub",
      hermeticVersion: "0.5.0",
      network: "public",
    });

    const [input] = inputsOf<ChangeSetInput>(cfn, CreateChangeSetCommand);
    expect(input!.Parameters.some((p) => p.ParameterKey === "FckNatAmiId")).toBe(false);
    expect(input!.Parameters).toContainEqual({
      ParameterKey: "Network",
      ParameterValue: "public",
    });
  });

  /**
   * The guarantee the sibling exists to keep: `foundation.update` can never
   * re-network a fleet, whatever it is passed, because it passes nothing.
   */
  test("the ordinary update still forces UsePreviousValue on Network", async () => {
    cfn.on(DescribeStacksCommand).resolves(stack());
    cfn.on(CreateChangeSetCommand).resolves({ Id: "id" });
    await foundation().createChangeSet({ name: "cs-upd", hermeticVersion: "0.5.0" });
    const [input] = inputsOf<ChangeSetInput>(cfn, CreateChangeSetCommand);
    expect(input!.Parameters).toContainEqual({ ParameterKey: "Network", UsePreviousValue: true });
  });
});

describe("resolveFckNatAmi", () => {
  test("a backend with no resolver refuses rather than guessing at an image", async () => {
    await expect(foundation().resolveFckNatAmi()).rejects.toThrow(/fck-nat AMI resolver/);
  });

  test("hands back what the resolver found", async () => {
    const found = await foundation({ resolveFckNatAmi: async () => "ami-0abc" }).resolveFckNatAmi();
    expect(found).toBe("ami-0abc");
  });
});

describe("describeNat", () => {
  function resources(ids: Record<string, string>) {
    return {
      StackResources: Object.entries(ids).map(([LogicalResourceId, PhysicalResourceId]) => ({
        LogicalResourceId,
        PhysicalResourceId,
        ResourceType: "AWS::EC2::Instance",
        ResourceStatus: "CREATE_COMPLETE" as const,
        Timestamp: new Date(),
      })),
    };
  }

  /**
   * A `public` stack has no `NatInstance` at all, so there is nothing to report
   * — and nothing must be invented. `null` is the *skip* a head renders as
   * unchecked; a health object with nulls in it would read as a failed probe.
   */
  test("a stack with no NatInstance answers null", async () => {
    cfn.on(DescribeStacksCommand).resolves(stack());
    cfn.on(DescribeStackResourcesCommand).resolves(resources({ Vpc: "vpc-1" }));
    expect(await foundation().describeNat()).toBeNull();
  });

  test("maps a healthy appliance: running instance, active route, the stack's egress ip", async () => {
    cfn.on(DescribeStacksCommand).resolves(stack("CREATE_COMPLETE", { NatEgressIp: "198.51.100.7" }));
    cfn
      .on(DescribeStackResourcesCommand)
      .resolves(resources({ NatInstance: "i-nat", PrivateRouteTable: "rtb-private" }));
    const health = await foundation({
      probeNat: async () => ({ instance_state: "running", route_state: "active" }),
    }).describeNat();
    expect(health).toEqual({
      instance_id: "i-nat",
      instance_state: "running",
      egress_ip: "198.51.100.7",
      route_state: "active",
    });
  });

  test("a blackholed route comes through as blackhole, not as a missing answer", async () => {
    cfn.on(DescribeStacksCommand).resolves(stack("CREATE_COMPLETE", { NatEgressIp: "198.51.100.7" }));
    cfn
      .on(DescribeStackResourcesCommand)
      .resolves(resources({ NatInstance: "i-nat", PrivateRouteTable: "rtb-private" }));
    const health = await foundation({
      probeNat: async () => ({ instance_state: "stopped", route_state: "blackhole" }),
    }).describeNat();
    expect(health?.instance_state).toBe("stopped");
    expect(health?.route_state).toBe("blackhole");
  });
});

describe("probeNat", () => {
  const ids = { instanceId: "i-nat", routeTableId: "rtb-private" };

  test("reads the instance state and the IPv4 default route's state", async () => {
    ec2.on(DescribeInstancesCommand).resolves({
      Reservations: [{ Instances: [{ InstanceId: "i-nat", State: { Name: "running" } }] }],
    });
    ec2.on(DescribeRouteTablesCommand).resolves({
      RouteTables: [
        {
          Routes: [
            // The v6 default goes through the egress-only gateway and cannot
            // blackhole this way; it must not be the one that is read.
            { DestinationIpv6CidrBlock: "::/0", State: "blackhole" },
            { DestinationCidrBlock: "0.0.0.0/0", State: "active" },
          ],
        },
      ],
    });
    expect(await probeNat(new EC2Client({ region: "us-west-2" }), ids)).toEqual({
      instance_state: "running",
      route_state: "active",
    });
  });

  test("a route pinned to a dead instance reads blackhole", async () => {
    ec2.on(DescribeInstancesCommand).resolves({
      Reservations: [{ Instances: [{ InstanceId: "i-nat", State: { Name: "terminated" } }] }],
    });
    ec2.on(DescribeRouteTablesCommand).resolves({
      RouteTables: [{ Routes: [{ DestinationCidrBlock: "0.0.0.0/0", State: "blackhole" }] }],
    });
    expect(await probeNat(new EC2Client({ region: "us-west-2" }), ids)).toEqual({
      instance_state: "terminated",
      route_state: "blackhole",
    });
  });

  /**
   * `doctor` is the command an operator runs *because* something is wrong. A
   * probe that threw when one of its two reads was denied would take the whole
   * report down; the unreadable half is `null`, which every reader shows as
   * unchecked rather than as healthy.
   */
  test("never throws: a denied read is null, not a failed doctor", async () => {
    ec2.on(DescribeInstancesCommand).rejects(new Error("UnauthorizedOperation"));
    ec2.on(DescribeRouteTablesCommand).rejects(new Error("UnauthorizedOperation"));
    expect(await probeNat(new EC2Client({ region: "us-west-2" }), ids)).toEqual({
      instance_state: null,
      route_state: null,
    });
  });
});

/**
 * The memo is what makes every per-agent call cost one `DescribeStacks` instead
 * of a dozen. It is also what made a long-running portal keep launching agents
 * into the subnets a re-network had moved away from: nothing dropped it.
 */
/**
 * `Ec2Compute` caches the AZ of the fleet's launch subnet, and a re-network
 * replaces that subnet with the other pair's. The cache is correct today only
 * because `PublicSubnet0` and `PrivateSubnet0` are rendered into the *same*
 * availability zone — an accident of the template, not a property anything
 * states. Both halves are pinned here: the template keeps the pairing, and the
 * cache is dropped anyway when the outputs move.
 */
/**
 * §5: what `nat` → `public` actually has to ask. CloudFormation cannot delete a
 * subnet that holds an ENI, and the agents table is not the list of what does —
 * an interface left by a create that lost its instance id, or by a box an
 * operator launched by hand, blocks the delete and appears in no row.
 */
describe("listNetworkInterfaces", () => {
  function compute() {
    sts.on(GetCallerIdentityCommand).resolves({
      Account: ACCOUNT,
      Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/hermetic-operator/evan`,
      UserId: "AIDA",
    });
    return createAwsBackend({
      profile: TEST_PROFILE,
      region: "us-west-2",
      expectedAccountId: ACCOUNT,
      fleetId: FLEET_ID,
      hermeticVersion: "0.4.1",
      stackPollIntervalMs: 1,
    }).compute;
  }

  test("filters on subnet id and follows every page", async () => {
    let page = 0;
    ec2.on(DescribeNetworkInterfacesCommand).callsFake(() => {
      page += 1;
      return page === 1
        ? {
            NetworkInterfaces: [
              {
                NetworkInterfaceId: "eni-1",
                SubnetId: "subnet-priv0",
                Attachment: { InstanceId: "i-1" },
                Description: "",
              },
            ],
            NextToken: "more",
          }
        : {
            NetworkInterfaces: [
              {
                NetworkInterfaceId: "eni-2",
                SubnetId: "subnet-priv1",
                Description: "VPC Endpoint Interface vpce-abc",
              },
            ],
          };
    });

    const found = await compute().listNetworkInterfaces(["subnet-priv0", "subnet-priv1"]);
    expect(found).toEqual([
      { id: "eni-1", subnet_id: "subnet-priv0", instance_id: "i-1", description: "" },
      {
        id: "eni-2",
        subnet_id: "subnet-priv1",
        // Attached to no instance: the case the refusal has to name by id.
        instance_id: null,
        description: "VPC Endpoint Interface vpce-abc",
      },
    ]);
    const filters = inputsOf<{ Filters: Array<{ Name: string; Values: string[] }> }>(
      ec2,
      DescribeNetworkInterfacesCommand,
    )[0]!.Filters;
    expect(filters).toEqual([{ Name: "subnet-id", Values: ["subnet-priv0", "subnet-priv1"] }]);
  });

  test("an empty subnet list is an empty answer, not a region-wide describe", async () => {
    expect(await compute().listNetworkInterfaces([])).toEqual([]);
    expect(callCount(ec2, DescribeNetworkInterfacesCommand)).toBe(0);
  });
});

describe("the subnet pairs' availability zones", () => {
  const template = (): {
    Resources: Record<string, { Properties: Record<string, unknown> }>;
  } => JSON.parse(foundationTemplateBody());

  test("subnet 0 of each pair asks for the same availability zone", () => {
    const r = template().Resources;
    expect(r["PrivateSubnet0"]!.Properties["AvailabilityZone"]).toEqual(
      r["PublicSubnet0"]!.Properties["AvailabilityZone"],
    );
  });

  test("and so does subnet 1", () => {
    const r = template().Resources;
    expect(r["PrivateSubnet1"]!.Properties["AvailabilityZone"]).toEqual(
      r["PublicSubnet1"]!.Properties["AvailabilityZone"],
    );
  });

  test("the two pairs are not in the same zone as each other", () => {
    // Otherwise a single-AZ outage takes the whole fleet, and the pairing above
    // would be trivially true for the wrong reason.
    const r = template().Resources;
    expect(r["PublicSubnet0"]!.Properties["AvailabilityZone"]).not.toEqual(
      r["PublicSubnet1"]!.Properties["AvailabilityZone"],
    );
  });
});

describe("the stack-outputs memo", () => {
  function backend() {
    sts.on(GetCallerIdentityCommand).resolves({
      Account: ACCOUNT,
      Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/hermetic-operator/evan`,
      UserId: "AIDA",
    });
    return createAwsBackend({
      profile: TEST_PROFILE,
      region: "us-west-2",
      expectedAccountId: ACCOUNT,
      fleetId: FLEET_ID,
      hermeticVersion: "0.4.1",
      // No test waits on a real CloudFormation poll.
      stackPollIntervalMs: 1,
    });
  }

  const OUTPUTS = {
    SubnetIds: "subnet-pub0,subnet-pub1",
    SecurityGroupId: "sg-1",
    InstanceProfileArn: "arn:aws:iam::123456789012:instance-profile/hermetic-agent",
  };

  /** A launch, which is what reads the memo: the subnet, the SG and the profile. */
  const SPEC = {
    name: "atlas",
    instance_type: "t4g.medium",
    ami_id: "ami-1",
    user_data: "#!/bin/sh",
    tags: { agent: "atlas" },
    network: "public" as const,
  };

  function wireLaunch() {
    ec2.on(DescribeSubnetsCommand).callsFake((input: { SubnetIds: string[] }) => ({
      Subnets: [{ SubnetId: input.SubnetIds[0], AvailabilityZone: "us-west-2a" }],
    }));
    ec2.on(RunInstancesCommand).resolves({
      Instances: [{ InstanceId: "i-1", State: { Name: "pending" } }],
    });
  }

  /** The subnet each `RunInstances` was sent with, in order. */
  function launchedSubnets(): Array<string | undefined> {
    return inputsOf<{
      SubnetId?: string;
      NetworkInterfaces?: Array<{ SubnetId?: string }>;
    }>(ec2, RunInstancesCommand).map((i) => i.SubnetId ?? i.NetworkInterfaces?.[0]?.SubnetId);
  }

  test("is read once for repeated calls", async () => {
    cfn.on(DescribeStacksCommand).resolves(stack("CREATE_COMPLETE", OUTPUTS));
    wireLaunch();
    const aws = backend();
    await aws.compute.runInstance(SPEC);
    await aws.compute.runInstance(SPEC);
    expect(callCount(cfn, DescribeStacksCommand)).toBe(1);
  });

  /**
   * §4.8: binding is not a read. It changes which stack `describeStack` answers
   * about, so a memo taken against the fleet that was bound before is about a
   * different foundation — different subnets, different tables, different
   * bucket — and answering from it would launch the next agent into another
   * fleet's VPC.
   */
  test("is dropped when the backend is bound to another fleet", async () => {
    cfn.on(DescribeStacksCommand).resolves(stack("CREATE_COMPLETE", OUTPUTS));
    wireLaunch();
    const aws = backend();

    await aws.compute.runInstance(SPEC);
    expect(callCount(cfn, DescribeStacksCommand)).toBe(1);

    aws.foundation.bindFleet("otherflt");
    await aws.compute.runInstance(SPEC);
    expect(callCount(cfn, DescribeStacksCommand)).toBe(2);
  });

  /**
   * The bucket name is the same `DescribeStacks`, resolved once for the life of
   * the backend. It cannot move under a re-network, but it certainly moves
   * under `bindFleet`: every fleet has its own bucket, and a stale name would
   * point an artifacts push — or the teardown's `emptyBucket` — at another
   * fleet's objects.
   */
  test("takes the bucket name with it, so the next push is this fleet's bucket", async () => {
    let bound = FLEET_ID;
    cfn
      .on(DescribeStacksCommand)
      .callsFake(() =>
        stack("CREATE_COMPLETE", { ...OUTPUTS, BucketName: `hermetic-${bound}-artifacts` }),
      );
    s3.on(PutObjectCommand).resolves({});
    const aws = backend();

    await aws.artifacts.putObject("releases/one", new Uint8Array([1]));
    await aws.artifacts.putObject("releases/two", new Uint8Array([2]));
    expect(callCount(cfn, DescribeStacksCommand)).toBe(1);

    bound = "otherflt";
    aws.foundation.bindFleet(bound);
    await aws.artifacts.putObject("releases/three", new Uint8Array([3]));

    expect(callCount(cfn, DescribeStacksCommand)).toBe(2);
    expect(inputsOf<{ Bucket?: string }>(s3, PutObjectCommand).map((i) => i.Bucket)).toEqual([
      `hermetic-${FLEET_ID}-artifacts`,
      `hermetic-${FLEET_ID}-artifacts`,
      "hermetic-otherflt-artifacts",
    ]);
  });

  test("is dropped when a change set executes, so the next launch sees the new subnets", async () => {
    /**
     * The stack answers with the public pair until `ExecuteChangeSet` is
     * accepted, and with the private pair after — which is exactly the moment a
     * memo taken before the execute becomes wrong.
     */
    let executed = false;
    cfn
      .on(DescribeStacksCommand)
      .callsFake(() =>
        executed
          ? stack("UPDATE_COMPLETE", { ...OUTPUTS, SubnetIds: "subnet-priv0,subnet-priv1" })
          : stack("CREATE_COMPLETE", OUTPUTS),
      );
    cfn.on(DescribeStackEventsCommand).resolves({ StackEvents: [] });
    cfn.on(ExecuteChangeSetCommand).callsFake(() => {
      executed = true;
      return {};
    });
    wireLaunch();

    const aws = backend();
    await aws.compute.runInstance(SPEC);
    const before = callCount(cfn, DescribeStacksCommand);

    await aws.foundation.executeChangeSet({ name: "cs-net" });
    await aws.compute.runInstance({ ...SPEC, network: "nat" });

    expect(callCount(cfn, DescribeStacksCommand)).toBeGreaterThan(before);
    expect(launchedSubnets()).toEqual(["subnet-pub0", "subnet-priv0"]);
  });

  /**
   * The AZ cache goes with it. `Ec2Compute` remembers the availability zone of
   * the subnet it last launched into, and `agent create --volume` compares a
   * volume's AZ against it before spending anything. Today's template puts both
   * subnet-0s in the same zone, so a stale value happens to be right — this
   * does not rely on that, and the describe count is what proves the cache was
   * dropped rather than believed.
   */
  test("and so is the availability zone remembered from the old launch subnet", async () => {
    let executed = false;
    cfn
      .on(DescribeStacksCommand)
      .callsFake(() =>
        executed
          ? stack("UPDATE_COMPLETE", { ...OUTPUTS, SubnetIds: "subnet-priv0,subnet-priv1" })
          : stack("CREATE_COMPLETE", OUTPUTS),
      );
    cfn.on(DescribeStackEventsCommand).resolves({ StackEvents: [] });
    cfn.on(ExecuteChangeSetCommand).callsFake(() => {
      executed = true;
      return {};
    });
    ec2.on(DescribeSubnetsCommand).callsFake((input: { SubnetIds: string[] }) => ({
      Subnets: [
        {
          SubnetId: input.SubnetIds[0],
          AvailabilityZone: input.SubnetIds[0] === "subnet-priv0" ? "us-west-2b" : "us-west-2a",
        },
      ],
    }));

    const aws = backend();
    expect(await aws.compute.launchAz()).toBe("us-west-2a");
    // Read twice: the second answer is the memo, not a second describe.
    expect(await aws.compute.launchAz()).toBe("us-west-2a");
    expect(callCount(ec2, DescribeSubnetsCommand)).toBe(1);

    await aws.foundation.executeChangeSet({ name: "cs-net" });
    expect(await aws.compute.launchAz()).toBe("us-west-2b");
    expect(callCount(ec2, DescribeSubnetsCommand)).toBe(2);
  });
});
