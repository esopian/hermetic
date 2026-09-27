import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  AttachVolumeCommand,
  CreateVolumeCommand,
  DescribeInstancesCommand,
  DescribeSecurityGroupRulesCommand,
  DescribeSubnetsCommand,
  DescribeVolumesCommand,
  EC2Client,
  DescribeImagesCommand,
  RunInstancesCommand,
} from "@aws-sdk/client-ec2";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { mockClient } from "aws-sdk-client-mock";
import { createAwsBackend } from "../src/aws/index.ts";
import { FOUNDATION_VERSION } from "../src/version.ts";
import { SECRET_PLACEHOLDER } from "../src/backend/constants.ts";
import { DEFAULT_ROOT_GIB, FLEET_MANIFEST_KEY, STACK_NAME } from "../src/schema/index.ts";
import type { LocalConfig } from "../src/schema/index.ts";
import { drain, testHermetic } from "./helpers.ts";
import { callCount, inputsOf, installTestProfile, TEST_PROFILE } from "./aws-harness.ts";

const profile = installTestProfile();
afterAll(() => profile.restore());

const ACCOUNT = "123456789012";
const FLEET_ID = "fxtr0001";
const ARN = "arn:aws:sts::123456789012:assumed-role/hermetic-operator/evan";
const HERMETICD_SHA = "a".repeat(64);
/** The value the mocked Tailscale API mints; nothing may echo it (§8.3). */
const MINTED_KEY = "tskey-auth-MOCKED-SECRET-VALUE";

/**
 * The fleet manifest the bucket already holds (§1): the release every boot
 * fetches, and where `create` reads the digest cloud-init verifies against.
 */
function fleetManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    fleet_id: FLEET_ID,
    region: "us-west-2",
    hermetic_version: "0.4.1",
    hermeticd: {
      version: "0.4.1",
      files: {
        hermeticd: { key: "artifacts/0.4.1/hermeticd", sha256: HERMETICD_SHA, size: 3 },
      },
    },
    resources: {
      bucket: "hermetic-123456789012-us-west-2",
      stack_id: `arn:aws:cloudformation:us-west-2:${ACCOUNT}:stack/${STACK_NAME}/abc`,
      agents_table: "hermetic-agents",
      events_table: "hermetic-events",
      param_prefix: "/hermes/",
      vpc_id: "vpc-abc",
      subnet_ids: ["subnet-aaa", "subnet-bbb"],
      security_group_id: "sg-sealed",
      instance_profile_arn: `arn:aws:iam::${ACCOUNT}:instance-profile/hermetic-agent`,
      role_arn: `arn:aws:iam::${ACCOUNT}:role/hermetic-agent`,
    },
    updated_at: "2026-07-20T09:00:00.000Z",
    updated_by: ARN,
    ...overrides,
  };
}

/** Pull the here-doc blob back out of the cloud-init script. */
function jsonFromScript(script: string): Record<string, string> {
  const body = /<<'HERMETIC_JSON'\n([\s\S]*?)\nHERMETIC_JSON/.exec(script)?.[1];
  expect(body).toBeDefined();
  return JSON.parse(body!) as Record<string, string>;
}

const CONFIG: LocalConfig = {
  schema_version: 1,
  name: "main",
  fleet_id: FLEET_ID,
  account_id: ACCOUNT,
  account_alias: "acme-dev",
  org_id: "o-fixture00",
  profile: TEST_PROFILE,
  region: "us-west-2",
  frozen_at: "2026-07-20T09:00:00.000Z",
  frozen_by: ARN,
};

const sts = mockClient(STSClient);
const cfn = mockClient(CloudFormationClient);
const ddb = mockClient(DynamoDBDocumentClient);
const ec2 = mockClient(EC2Client);
const s3 = mockClient(S3Client);
const ssm = mockClient(SSMClient);

/** Mutable reality the mocks read and write, so a second run sees the first. */
interface World {
  items: Map<string, Record<string, unknown>>;
  params: Map<string, string>;
  objects: Map<string, string>;
  volumes: Array<{
    VolumeId: string;
    Size: number;
    State: string;
    agent: string;
    Attachments?: Array<{ InstanceId: string; State: string }>;
  }>;
  instances: Array<{ InstanceId: string; State: { Name: string }; agent: string }>;
  sgRules: Array<Record<string, unknown>>;
}

let world: World;
let realFetch: typeof fetch;

function freshWorld(): World {
  return {
    items: new Map([
      [
        "_fleet",
        {
          // The table's partition key; the fleet's own name is `fleet_name`.
          name: "_fleet",
          fleet_id: FLEET_ID,
          fleet_name: "main",
          defaults: {
            size: "medium",
            provider: "bedrock",
            volume_gib: 100,
            browser: true,
            secrets: "none",
          },
          /**
           * The contract this build creates a fleet on. Stated rather than left
           * absent because the defaults above ask for a browser, and §7.3's gate
           * refuses that on anything below `BROWSER_FOUNDATION_VERSION` — an
           * absent stamp reads as version 0, which is a fleet `init` has not
           * touched since long before this world was written.
           */
          foundation_version: FOUNDATION_VERSION,
          ubuntu_release: "24.04",
          tailnet: "hermetic.ts.net",
          ami_id: "ami-0abc1234def567890",
          min_hermetic_version: "0.4.1",
          /**
           * §8.3: the grant `init` records, so the fleet's own Bedrock profile
           * is one an agent may be created on. A fleet that records none reads
           * as *not reconciled* and refuses the current default model, which is
           * the v10 state and is exercised in `bedrock-grants.test.ts`.
           */
          bedrock_model_ids: [
            "zai.glm-4.7-flash",
            "anthropic.claude-sonnet-4-5-20250929-v1:0",
            "anthropic.claude-haiku-4-5-20251001-v1:0",
            "anthropic.claude-opus-4-1-20250805-v1:0",
          ],
          region: "us-west-2",
          bucket: "hermetic-123456789012-us-west-2",
          stack_id: `arn:aws:cloudformation:us-west-2:${ACCOUNT}:stack/${STACK_NAME}/abc`,
          created_by: ARN,
          created_at: "2026-07-20T09:00:00.000Z",
        },
      ],
    ]),
    params: new Map([
      [`/hermetic/${FLEET_ID}/tailscale/oauth-secret`, "tskey-client-kABC123-oauthsecret"],
    ]),
    objects: new Map([
      ["artifacts/0.4.1/hermeticd", "ELF"],
      [FLEET_MANIFEST_KEY, JSON.stringify(fleetManifest())],
    ]),
    volumes: [],
    instances: [],
    sgRules: [],
  };
}

function wire(): void {
  sts.on(GetCallerIdentityCommand).resolves({ Account: ACCOUNT, Arn: ARN, UserId: "AIDA" });

  cfn.on(DescribeStacksCommand).callsFake(() => ({
    Stacks: [
      {
        StackId: `arn:aws:cloudformation:us-west-2:${ACCOUNT}:stack/${STACK_NAME}/abc`,
        StackName: STACK_NAME,
        StackStatus: "CREATE_COMPLETE",
        Tags: [{ Key: "hermetic:fleet_id", Value: FLEET_ID }],
        Outputs: [
          { OutputKey: "VpcId", OutputValue: "vpc-abc" },
          { OutputKey: "SubnetIds", OutputValue: "subnet-aaa,subnet-bbb" },
          { OutputKey: "SecurityGroupId", OutputValue: "sg-sealed" },
          {
            OutputKey: "InstanceProfileArn",
            OutputValue: `arn:aws:iam::${ACCOUNT}:instance-profile/hermetic-agent`,
          },
          { OutputKey: "RoleArn", OutputValue: `arn:aws:iam::${ACCOUNT}:role/hermetic-agent` },
          { OutputKey: "BucketName", OutputValue: "hermetic-123456789012-us-west-2" },
        ],
      },
    ],
  }));

  // ── DynamoDB ────────────────────────────────────────────────────────────
  ddb.on(GetCommand).callsFake((input: { Key: { name: string } }) => ({
    Item: world.items.get(input.Key.name),
  }));
  ddb
    .on(PutCommand)
    .callsFake(
      (input: {
        Item: Record<string, unknown>;
        ConditionExpression?: string;
        ExpressionAttributeValues?: Record<string, unknown>;
      }) => {
        const name = String(input.Item["name"]);
        const condition = input.ConditionExpression ?? "";
        /**
         * Two different conditional puts share this mock and they are not the same
         * question. `putIfAbsent` claims a *name* (`attribute_not_exists(#name)`);
         * a `_fleet` write claims the fleet *lock* (`attribute_not_exists(#lock)
         * OR …`), which an existing `_fleet` item passes perfectly well as long
         * as nobody's live lock is on it. Reading both as "refuse if the item
         * exists" made every `artifacts push` against this mock look like a fleet
         * somebody else was updating.
         */
        if (condition.includes("#lock")) {
          const stored = world.items.get(name) as { lock?: { owner: string; expires: string } | null };
          const held = stored?.lock ?? null;
          const owner = input.ExpressionAttributeValues?.[":owner"];
          const now = String(input.ExpressionAttributeValues?.[":now"] ?? "");
          if (held !== null && held.owner !== owner && held.expires >= now) {
            const e = new Error("The conditional request failed");
            e.name = "ConditionalCheckFailedException";
            throw e;
          }
        } else if (condition.includes("attribute_not_exists") && world.items.has(name)) {
          const e = new Error("The conditional request failed");
          e.name = "ConditionalCheckFailedException";
          throw e;
        }
        // The events table shares the mock; keep only agent rows addressable.
        if (input.Item["timestamp"] === undefined) world.items.set(name, { ...input.Item });
        return {};
      },
    );
  ddb
    .on(UpdateCommand)
    .callsFake(
      (input: {
        Key: { name: string };
        ExpressionAttributeNames: Record<string, string>;
        ExpressionAttributeValues: Record<string, unknown>;
        UpdateExpression: string;
      }) => {
        const current = world.items.get(input.Key.name);
        if (!current) {
          const e = new Error("gone");
          e.name = "ConditionalCheckFailedException";
          throw e;
        }
        if (current["version"] !== input.ExpressionAttributeValues[":expected"]) {
          const e = new Error("stale");
          e.name = "ConditionalCheckFailedException";
          (e as unknown as { Item: unknown }).Item = current;
          throw e;
        }
        const next: Record<string, unknown> = {
          ...current,
          version: input.ExpressionAttributeValues[":next"],
        };
        for (const [placeholder, attribute] of Object.entries(input.ExpressionAttributeNames)) {
          if (placeholder === "#name" || placeholder === "#version") continue;
          const value = input.ExpressionAttributeValues[placeholder.replace("#", ":")];
          if (value !== undefined) next[attribute] = value;
        }
        if (input.UpdateExpression.includes("REMOVE #ttl")) delete next["lock_expires"];
        world.items.set(input.Key.name, next);
        return { Attributes: next };
      },
    );
  ddb.on(ScanCommand).callsFake(() => ({ Items: [...world.items.values()] }));

  // ── SSM ─────────────────────────────────────────────────────────────────
  ssm.on(GetParameterCommand).callsFake((input: { Name: string }) => {
    const value = world.params.get(input.Name);
    if (value === undefined) {
      const e = new Error("not found");
      e.name = "ParameterNotFound";
      throw e;
    }
    return { Parameter: { Name: input.Name, Value: value } };
  });
  ssm.on(PutParameterCommand).callsFake((input: { Name: string; Value: string }) => {
    world.params.set(input.Name, input.Value);
    return { Version: 1 };
  });

  // ── S3 ──────────────────────────────────────────────────────────────────
  s3.on(HeadObjectCommand).callsFake((input: { Key: string }) => {
    if (!world.objects.has(input.Key)) {
      const e = new Error("not found");
      e.name = "NotFound";
      throw e;
    }
    return {};
  });
  s3.on(PutObjectCommand).callsFake((input: { Key: string; Body: Uint8Array }) => {
    world.objects.set(input.Key, new TextDecoder().decode(input.Body));
    return {};
  });
  s3.on(GetObjectCommand).callsFake((input: { Key: string }) => {
    const body = world.objects.get(input.Key);
    if (body === undefined) {
      const e = new Error("no such key");
      e.name = "NoSuchKey";
      throw e;
    }
    return { Body: { transformToString: async () => body } };
  });

  // ── EC2 ─────────────────────────────────────────────────────────────────
  ec2.on(DescribeSubnetsCommand).resolves({
    Subnets: [{ SubnetId: "subnet-aaa", AvailabilityZone: "us-west-2a" }],
  });
  ec2
    .on(DescribeVolumesCommand)
    .callsFake(
      (input: { VolumeIds?: string[]; Filters?: Array<{ Name: string; Values: string[] }> }) => {
        if (input.VolumeIds?.length) {
          return {
            Volumes: world.volumes.filter((v) => input.VolumeIds!.includes(v.VolumeId)),
          };
        }
        const wanted = input.Filters?.find((f) => f.Name === "tag:agent")?.Values[0];
        return { Volumes: world.volumes.filter((v) => v.agent === wanted) };
      },
    );
  ec2
    .on(CreateVolumeCommand)
    .callsFake(
      (input: {
        Size: number;
        TagSpecifications: Array<{ Tags: Array<{ Key: string; Value: string }> }>;
      }) => {
        const agent = input.TagSpecifications[0]!.Tags.find((t) => t.Key === "agent")!.Value;
        const volume = {
          VolumeId: `vol-${world.volumes.length + 1}`,
          Size: input.Size,
          State: "available",
          agent,
          Attachments: [] as Array<{ InstanceId: string; State: string }>,
        };
        world.volumes.push(volume);
        return volume;
      },
    );
  ec2
    .on(DescribeInstancesCommand)
    .callsFake(
      (input: { InstanceIds?: string[]; Filters?: Array<{ Name: string; Values: string[] }> }) => {
        if (input.InstanceIds?.length) {
          const found = world.instances.filter((i) => input.InstanceIds!.includes(i.InstanceId));
          // attachVolume waits for `running`; treat pending launches as already up
          // so unit tests do not spin the waiter.
          for (const i of found) i.State = { Name: "running" };
          return { Reservations: found.length ? [{ Instances: found }] : [] };
        }
        const wanted = input.Filters?.find((f) => f.Name === "tag:agent")?.Values[0];
        const found = world.instances.filter((i) => i.agent === wanted);
        return { Reservations: found.length ? [{ Instances: found }] : [] };
      },
    );
  // Canonical's arm64 image, as `DescribeImages` reports it: an 8 GiB root on
  // `/dev/sda1`, which is exactly the default `runInstance` now overrides.
  ec2.on(DescribeImagesCommand).callsFake(() => ({
    Images: [
      {
        ImageId: "ami-0abc1234def567890",
        RootDeviceName: "/dev/sda1",
        BlockDeviceMappings: [
          { DeviceName: "/dev/sda1", Ebs: { VolumeSize: 8, SnapshotId: "snap-root" } },
          { DeviceName: "/dev/sdb", VirtualName: "ephemeral0" },
        ],
      },
    ],
  }));
  ec2
    .on(RunInstancesCommand)
    .callsFake(
      (input: { TagSpecifications: Array<{ Tags: Array<{ Key: string; Value: string }> }> }) => {
        const agent = input.TagSpecifications[0]!.Tags.find((t) => t.Key === "agent")!.Value;
        const instance = {
          InstanceId: `i-${world.instances.length + 1}`,
          State: { Name: "pending" },
          agent,
        };
        world.instances.push(instance);
        return { Instances: [instance] };
      },
    );
  ec2.on(AttachVolumeCommand).callsFake((input: { InstanceId: string; VolumeId: string }) => {
    const volume = world.volumes.find((v) => v.VolumeId === input.VolumeId);
    if (volume) {
      volume.State = "in-use";
      volume.Attachments = [{ InstanceId: input.InstanceId, State: "attached" }];
    }
    return {};
  });
  ec2.on(DescribeSecurityGroupRulesCommand).callsFake(() => ({ SecurityGroupRules: world.sgRules }));

  // The Tailscale API is plain HTTP; `TailscaleClient` resolves `fetch` per call.
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "tsoauth-mocked", expires_in: 3600 }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/tailnet/-/keys")) {
      return new Response(JSON.stringify({ key: MINTED_KEY, id: "k123" }), {
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;
}

function hermeticOverAws() {
  const backend = createAwsBackend({
    profile: TEST_PROFILE,
    region: "us-west-2",
    expectedAccountId: ACCOUNT,
    // Every EC2 filter and tag is scoped by this (§5); `openHermetic` passes
    // the frozen config's fleet id for the same reason.
    fleetId: FLEET_ID,
    hermeticVersion: "0.4.1",
  });
  return testHermetic({ backend, config: CONFIG, fixture: false });
}

beforeEach(() => {
  realFetch ??= globalThis.fetch;
  for (const m of [sts, cfn, ddb, ec2, s3, ssm]) m.reset();
  world = freshWorld();
  wire();
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

/** §11.1: each lifecycle step against mocked AWS, then the same run twice. */
describe("agents.create against AwsBackend", () => {
  test("provisions everything and hands off", async () => {
    const events = await drain(hermeticOverAws().agents.create({ name: "atlas" }));
    expect(events.at(-1)?.progress).toBe(1);

    expect(callCount(ec2, CreateVolumeCommand)).toBe(1);
    expect(callCount(ec2, RunInstancesCommand)).toBe(1);
    expect(callCount(ec2, AttachVolumeCommand)).toBe(1);

    const row = world.items.get("atlas")!;
    expect(row["status"]).toBe("creating");
    expect(row["lock"]).toBeNull();
    expect((row["resources"] as { instance_id: string }).instance_id).toBe("i-1");
  });

  test("the launch resizes the root disk on the device the AMI calls its root", async () => {
    await drain(hermeticOverAws().agents.create({ name: "atlas" }));

    const [run] = inputsOf<{
      BlockDeviceMappings?: Array<{
        DeviceName: string;
        Ebs: { VolumeSize: number; VolumeType: string; DeleteOnTermination: boolean };
      }>;
    }>(ec2, RunInstancesCommand);

    // Exactly one mapping: the root disk. The data volume is its own
    // `CreateVolume` plus an attach, so that it can outlive the instance (§1),
    // and a second mapping here would be a disk nothing tags and nothing frees.
    expect(run!.BlockDeviceMappings).toEqual([
      {
        DeviceName: "/dev/sda1",
        Ebs: { VolumeSize: DEFAULT_ROOT_GIB, VolumeType: "gp3", DeleteOnTermination: true },
      },
    ]);
  });

  test("an AMI whose root is already larger than the floor is not shrunk", async () => {
    ec2.on(DescribeImagesCommand).callsFake(() => ({
      Images: [
        {
          ImageId: "ami-0abc1234def567890",
          RootDeviceName: "/dev/xvda",
          BlockDeviceMappings: [{ DeviceName: "/dev/xvda", Ebs: { VolumeSize: 64 } }],
        },
      ],
    }));
    await drain(hermeticOverAws().agents.create({ name: "atlas" }));

    const [run] = inputsOf<{
      BlockDeviceMappings?: Array<{
        DeviceName: string;
        Ebs: { VolumeSize: number; VolumeType: string; DeleteOnTermination: boolean };
      }>;
    }>(ec2, RunInstancesCommand);
    // EBS refuses a volume smaller than the snapshot behind it, so the constant
    // is a floor rather than a size. The device name is the image's, too.
    expect(run!.BlockDeviceMappings).toEqual([
      {
        DeviceName: "/dev/xvda",
        Ebs: { VolumeSize: 64, VolumeType: "gp3", DeleteOnTermination: true },
      },
    ]);
  });

  test("a describe the account will not answer launches anyway, on the AMI default", async () => {
    ec2.on(DescribeImagesCommand).rejects(new Error("UnauthorizedOperation"));
    const events = await drain(hermeticOverAws().agents.create({ name: "atlas" }));

    // A box with a small root disk beats no box: the mapping is dropped and the
    // launch keeps its historical shape.
    expect(events.at(-1)?.progress).toBe(1);
    const [run] = inputsOf<{ BlockDeviceMappings?: unknown }>(ec2, RunInstancesCommand);
    expect(run!.BlockDeviceMappings).toBeUndefined();
  });

  test("user-data carries the name, the bucket, the presigned URL and the sha", async () => {
    await drain(hermeticOverAws().agents.create({ name: "atlas" }));

    const [run] = inputsOf<{
      UserData: string;
      SubnetId: string;
      SecurityGroupIds: string[];
      IamInstanceProfile: { Arn: string };
    }>(ec2, RunInstancesCommand);
    const script = Buffer.from(run!.UserData, "base64").toString("utf8");
    const parsed = jsonFromScript(script);

    // The ten-line cloud-init wrapper of §6.3, with the blob as a here-doc.
    expect(script).toStartWith("#!/bin/bash");
    expect(script).toContain("sha256sum -c -");
    expect(script).toContain("exec /usr/local/bin/hermeticd bootstrap --install");

    // Five fields, and no more: the tables and the SSM prefix are the fleet
    // manifest's to say now, so user-data cannot go stale about them (§1). The
    // fifth is the hostname the box registers with the tailnet (§5).
    expect(Object.keys(parsed).sort()).toEqual([
      "bucket",
      "hermeticd_sha256",
      "hermeticd_url",
      "hostname",
      "name",
    ]);
    expect(parsed["name"]).toBe("atlas");
    // `<fleet id>-<agent>` since v4 (`cloudName`): a fleet's id cannot be
    // renamed, and this string becomes an OS hostname that is fixed at boot.
    expect(parsed["hostname"]).toBe(`${FLEET_ID}-atlas`);
    expect(parsed["hermeticd_url"]).toContain("artifacts/0.4.1/hermeticd");
    expect(parsed["hermeticd_url"]).toContain("X-Amz-Signature");
    // Read from the fleet manifest, never recomputed: core has no binary here.
    expect(parsed["hermeticd_sha256"]).toBe(HERMETICD_SHA);
    // hermeticd cannot read `_fleet` (LeadingKeys, §5.1), so it is told the bucket.
    expect(parsed["bucket"]).toBe("hermetic-123456789012-us-west-2");

    // It launches into the stack's subnet, security group and instance profile.
    expect(run!.SubnetId).toBe("subnet-aaa");
    expect(run!.SecurityGroupIds).toEqual(["sg-sealed"]);
    expect(run!.IamInstanceProfile.Arn).toContain("instance-profile/hermetic-agent");
  });

  /**
   * §5: the tables are named for the stack, and the stack for the fleet. Core
   * reads the names off the stack rather than rebuilding the convention, and
   * publishes them in the fleet manifest — the box cannot derive them, and
   * user-data no longer carries them.
   */
  test("the fleet's tables come from the stack's outputs, and go into the fleet manifest", async () => {
    cfn.on(DescribeStacksCommand).callsFake(() => ({
      Stacks: [
        {
          StackId: `arn:aws:cloudformation:us-west-2:${ACCOUNT}:stack/hermetic-${FLEET_ID}/abc`,
          StackName: `hermetic-${FLEET_ID}`,
          StackStatus: "CREATE_COMPLETE",
          Tags: [{ Key: "hermetic:fleet_id", Value: FLEET_ID }],
          Outputs: [
            { OutputKey: "VpcId", OutputValue: "vpc-abc" },
            { OutputKey: "SubnetIds", OutputValue: "subnet-aaa,subnet-bbb" },
            { OutputKey: "SecurityGroupId", OutputValue: "sg-sealed" },
            {
              OutputKey: "InstanceProfileArn",
              OutputValue: `arn:aws:iam::${ACCOUNT}:instance-profile/hermetic-agent`,
            },
            { OutputKey: "RoleArn", OutputValue: `arn:aws:iam::${ACCOUNT}:role/hermetic-agent` },
            { OutputKey: "BucketName", OutputValue: `hermetic-${FLEET_ID}-123456789012-us-west-2` },
            { OutputKey: "AgentsTable", OutputValue: `hermetic-${FLEET_ID}-agents` },
            { OutputKey: "EventsTable", OutputValue: `hermetic-${FLEET_ID}-events` },
          ],
        },
      ],
    }));
    world.items.set("_fleet", {
      ...(world.items.get("_fleet") as Record<string, unknown>),
      stack_id: `arn:aws:cloudformation:us-west-2:${ACCOUNT}:stack/hermetic-${FLEET_ID}/abc`,
    });

    const hermetic = hermeticOverAws();
    await drain(hermetic.agents.create({ name: "atlas" }));

    const reads = inputsOf<{ TableName: string }>(ddb, GetCommand);
    expect(reads.map((r) => r!.TableName)).toContain(`hermetic-${FLEET_ID}-agents`);
    expect(reads.map((r) => r!.TableName)).not.toContain("hermetic-agents");

    await hermetic.artifacts.push({ bytes: new TextEncoder().encode("ELF") });
    const manifest = JSON.parse(world.objects.get(FLEET_MANIFEST_KEY)!) as {
      resources: Record<string, unknown>;
    };
    expect(manifest.resources["agents_table"]).toBe(`hermetic-${FLEET_ID}-agents`);
    expect(manifest.resources["events_table"]).toBe(`hermetic-${FLEET_ID}-events`);
    expect(manifest.resources["param_prefix"]).toBe(`/hermes/${FLEET_ID}/`);
    expect(manifest.resources["security_group_id"]).toBe("sg-sealed");
  });

  test("a stack that predates the table outputs still resolves the pre-rename names", async () => {
    // The default wiring above is exactly that stack: named `hermetic`, with no
    // `AgentsTable` output. Nothing about it should have to change to keep working.
    const hermetic = hermeticOverAws();
    await drain(hermetic.agents.create({ name: "atlas" }));
    const reads = inputsOf<{ TableName: string }>(ddb, GetCommand);
    expect(reads.map((r) => r!.TableName)).toContain("hermetic-agents");

    await hermetic.artifacts.push({ bytes: new TextEncoder().encode("ELF") });
    const manifest = JSON.parse(world.objects.get(FLEET_MANIFEST_KEY)!) as {
      resources: Record<string, unknown>;
    };
    expect(manifest.resources["agents_table"]).toBe("hermetic-agents");
  });

  /** §6.3 and §8.3: user-data is readable by anything on the box. */
  test("user-data and every event carry no secret value", async () => {
    const events = await drain(
      hermeticOverAws().agents.create({ name: "atlas", secrets: "bitwarden" }),
    );

    const [run] = inputsOf<{ UserData: string }>(ec2, RunInstancesCommand);
    const userData = Buffer.from(run!.UserData, "base64").toString("utf8");

    for (const haystack of [userData, JSON.stringify(events)]) {
      expect(haystack).not.toInclude(MINTED_KEY);
      expect(haystack).not.toMatch(/tskey-[A-Za-z0-9-]+/);
      expect(haystack).not.toInclude("tsoauth-mocked");
      // The OAuth client secret in the fleet-wide slot never leaves SSM either.
      expect(haystack).not.toInclude("oauthsecret");
      // The flag name `--bws-token` may appear; a token value never may.
      expect(haystack).not.toMatch(/bws-token-\S/);
    }
    // Not vacuous: the key really did land in the slot.
    expect(world.params.get(`/hermes/${FLEET_ID}/atlas/ts-key`)).toBe(MINTED_KEY);
    expect(world.params.get(`/hermes/${FLEET_ID}/atlas/bws-token`)).toBe(SECRET_PLACEHOLDER);
  });

  test("a second run against the same reality issues zero mutating commands", async () => {
    await drain(hermeticOverAws().agents.create({ name: "atlas" }));

    for (const m of [ddb, ec2, s3, ssm]) m.resetHistory();
    const events = await drain(hermeticOverAws().agents.create({ name: "atlas" }));

    expect(events.at(-1)?.message).toContain("already exists");
    expect(callCount(ddb, PutCommand)).toBe(0);
    expect(callCount(ddb, UpdateCommand)).toBe(0);
    expect(callCount(ec2, CreateVolumeCommand)).toBe(0);
    expect(callCount(ec2, RunInstancesCommand)).toBe(0);
    expect(callCount(s3, PutObjectCommand)).toBe(0);
    expect(callCount(ssm, PutParameterCommand)).toBe(0);
  });

  test("resuming an interrupted create reuses the volume it already made", async () => {
    // Reality: the row was claimed and the volume exists, but nothing launched.
    world.volumes.push({
      VolumeId: "vol-existing",
      Size: 100,
      State: "available",
      agent: "atlas",
      Attachments: [],
    });
    await drain(hermeticOverAws().agents.create({ name: "atlas" }));

    expect(callCount(ec2, CreateVolumeCommand)).toBe(0);
    const [attach] = inputsOf<{ VolumeId: string }>(ec2, AttachVolumeCommand);
    expect(attach!.VolumeId).toBe("vol-existing");
  });

  test("a failed AttachVolume still leaves the instance id on the agent row", async () => {
    ec2.on(AttachVolumeCommand).rejects(new Error("VolumeInUse: vol still settling"));

    await expect(drain(hermeticOverAws().agents.create({ name: "atlas" }))).rejects.toThrow();

    expect(callCount(ec2, RunInstancesCommand)).toBe(1);
    const row = world.items.get("atlas")!;
    expect(row["instance_id"]).toBeString();
    expect((row["resources"] as { instance_id: string }).instance_id).toBe(String(row["instance_id"]));
  });

  /**
   * §4.5: every step checks reality before acting. An instance that exists but
   * was never recorded on the row — a laptop that died between `RunInstances`
   * and the handoff write — must be adopted, not duplicated.
   */
  test("an unrecorded instance is adopted rather than launched again", async () => {
    await drain(hermeticOverAws().agents.create({ name: "atlas" }));

    // Rewind the row to just before the handoff: resources unset, still creating.
    const row = world.items.get("atlas")!;
    world.items.set("atlas", {
      ...row,
      status: "creating",
      lock: null,
      instance_id: null,
      resources: { ssm_paths: [] },
    });

    for (const m of [ddb, ec2, s3, ssm]) m.resetHistory();
    const events = await drain(hermeticOverAws().agents.create({ name: "atlas" }));

    expect(events.some((e) => e.phase === "resume")).toBe(true);
    expect(events.some((e) => e.message.includes("found live instance"))).toBe(true);
    expect(callCount(ec2, RunInstancesCommand)).toBe(0);
    expect(callCount(ec2, CreateVolumeCommand)).toBe(0);
    // Reality is unchanged: one instance, one data volume.
    expect(world.instances).toHaveLength(1);
    expect(world.volumes).toHaveLength(1);
    expect((world.items.get("atlas")!["resources"] as { instance_id: string }).instance_id).toBe("i-1");
  });

  test("RunInstances tags the instance only, never a volume", async () => {
    await drain(hermeticOverAws().agents.create({ name: "atlas" }));
    const [run] = inputsOf<{
      TagSpecifications: Array<{ ResourceType: string; Tags: Array<{ Key: string; Value: string }> }>;
    }>(ec2, RunInstancesCommand);
    // Tagging the volume here would stamp `agent=atlas` on the *root* disk, and
    // `findVolumeByTag` could then return it.
    expect(run!.TagSpecifications.map((t) => t.ResourceType)).toEqual(["instance"]);

    const [volume] = inputsOf<{
      TagSpecifications: Array<{ Tags: Array<{ Key: string; Value: string }> }>;
    }>(ec2, CreateVolumeCommand);
    const tags = Object.fromEntries(volume!.TagSpecifications[0]!.Tags.map((t) => [t.Key, t.Value]));
    expect(tags["hermetic:role"]).toBe("data");
    expect(tags["agent"]).toBe("atlas");
    expect(tags["hermetic:fleet_id"]).toBe(FLEET_ID);
    // The console label carries the fleet prefix (§5).
    expect(tags["Name"]).toBe(`${FLEET_ID}-atlas-data`);
  });

  /**
   * The lookup must NOT filter on `hermetic:role=data`: a volume created before
   * that tag existed would be invisible, and create would provision a fresh
   * empty disk and orphan the agent's memory. Disambiguation happens in code —
   * see `aws-volumes.test.ts`. `attachVolume`'s DescribeVolumes-by-id is a
   * different call and is excluded here.
   */
  test("the data-volume lookup queries by agent and managed only", async () => {
    await drain(hermeticOverAws().agents.create({ name: "atlas" }));
    const filters = inputsOf<{
      Filters?: Array<{ Name: string; Values: string[] }>;
      VolumeIds?: string[];
    }>(ec2, DescribeVolumesCommand).filter((input) => input.Filters && !input.VolumeIds);
    expect(filters.length).toBeGreaterThan(0);
    for (const input of filters) {
      expect(input.Filters!.map((f) => f.Name)).toEqual([
        "tag:agent",
        "tag:hermetic:managed",
        // Scoped to this fleet: `agent=atlas` alone matches another fleet's
        // atlas, whose data volume this lookup must never return (§5).
        "tag:hermetic:fleet_id",
      ]);
    }
  });
});

/**
 * §6.2: public IP assignment is the fleet's decision, not the subnet's. EC2
 * refuses `AssociatePublicIpAddress` beside a top-level `SubnetId`, so saying it
 * moves the subnet and the security group into `NetworkInterfaces[0]`. A fleet
 * with no recorded mode keeps the old top-level shape and the old behaviour.
 */
describe("the launch's network placement", () => {
  /** The shape of a `RunInstances` input, with both placements optional. */
  type Placement = {
    SubnetId?: string;
    SecurityGroupIds?: string[];
    NetworkInterfaces?: Array<{
      DeviceIndex: number;
      SubnetId: string;
      Groups: string[];
      AssociatePublicIpAddress: boolean;
      Ipv6AddressCount?: number;
      Ipv6Addresses?: unknown[];
    }>;
  };

  async function launchWith(network: string | undefined): Promise<Placement> {
    if (network !== undefined) world.items.get("_fleet")!["network"] = network;
    await drain(hermeticOverAws().agents.create({ name: "atlas" }));
    const [run] = inputsOf<Placement>(ec2, RunInstancesCommand);
    return run!;
  }

  test("a nat fleet launches with no public IP", async () => {
    const run = await launchWith("nat");

    expect(run.SubnetId).toBeUndefined();
    expect(run.SecurityGroupIds).toBeUndefined();
    expect(run.NetworkInterfaces).toHaveLength(1);
    const nic = run.NetworkInterfaces![0]!;
    expect(nic.DeviceIndex).toBe(0);
    expect(nic.SubnetId).toBe("subnet-aaa");
    expect(nic.Groups).toEqual(["sg-sealed"]);
    expect(nic.AssociatePublicIpAddress).toBe(false);
  });

  test("a public fleet asks for the address explicitly", async () => {
    const run = await launchWith("public");

    expect(run.SubnetId).toBeUndefined();
    expect(run.NetworkInterfaces).toHaveLength(1);
    const nic = run.NetworkInterfaces![0]!;
    expect(nic.SubnetId).toBe("subnet-aaa");
    expect(nic.Groups).toEqual(["sg-sealed"]);
    expect(nic.AssociatePublicIpAddress).toBe(true);
  });

  /**
   * Naming either field would take the v6 address away from the subnet's
   * `AssignIpv6AddressOnCreation`, which is what hands it out in both modes.
   */
  test("neither mode names an IPv6 field", async () => {
    for (const mode of ["nat", "public"]) {
      ec2.resetHistory();
      world.items.delete("atlas");
      world.instances.length = 0;
      world.volumes.length = 0;
      const nic = (await launchWith(mode)).NetworkInterfaces![0]!;
      expect(nic.Ipv6AddressCount).toBeUndefined();
      expect(nic.Ipv6Addresses).toBeUndefined();
    }
  });

  /**
   * A fleet written before the field existed, and not yet back-filled by the
   * foundation migration: the launch keeps its historical top-level form and
   * goes on inheriting the subnet's `MapPublicIpOnLaunch`.
   */
  test("a fleet with no recorded mode keeps the top-level form", async () => {
    const run = await launchWith(undefined);

    expect(run.NetworkInterfaces).toBeUndefined();
    expect(run.SubnetId).toBe("subnet-aaa");
    expect(run.SecurityGroupIds).toEqual(["sg-sealed"]);
  });
});
