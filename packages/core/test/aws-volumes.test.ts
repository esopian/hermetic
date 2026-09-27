import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  CreateTagsCommand,
  CreateVolumeCommand,
  DeleteTagsCommand,
  DescribeSubnetsCommand,
  DescribeVolumesCommand,
  EC2Client,
} from "@aws-sdk/client-ec2";
import { SSMClient } from "@aws-sdk/client-ssm";
import { mockClient } from "aws-sdk-client-mock";
import { Ec2Compute } from "../src/aws/ec2.ts";
import type { HermeticError } from "../src/errors.ts";
import { callCount, inputsOf, installTestProfile } from "./aws-harness.ts";

const profile = installTestProfile();
afterAll(() => profile.restore());

const ec2 = mockClient(EC2Client);
const ssm = mockClient(SSMClient);

beforeEach(() => {
  ec2.reset();
  ssm.reset();
  ec2.on(DescribeSubnetsCommand).resolves({
    Subnets: [{ SubnetId: "subnet-aaa", AvailabilityZone: "us-west-2a" }],
  });
});

/** The fleet every filter and tag in these tests is scoped by (§5). */
const TEST_FLEET_ID = "fxtr0001";

function compute() {
  return new Ec2Compute(
    new EC2Client({ region: "us-west-2" }),
    new SSMClient({ region: "us-west-2" }),
    "us-west-2",
    async () => ({
      subnet_ids: ["subnet-aaa"],
      security_group_id: "sg-sealed",
      instance_profile_arn: "arn:aws:iam::123456789012:instance-profile/hermetic-agent",
    }),
    () => TEST_FLEET_ID,
  );
}

const DATA_TAG = { Key: "hermetic:role", Value: "data" };

/**
 * §1: instances are disposable, volumes are precious. Attaching the wrong disk —
 * or provisioning a fresh empty one because the real one was invisible — is the
 * worst thing hermetic can do, so the lookup is wide and the tie-break refuses.
 */
describe("findVolumeByTag", () => {
  test("returns null when the agent has no managed volume", async () => {
    ec2.on(DescribeVolumesCommand).resolves({ Volumes: [] });
    expect(await compute().findVolumeByTag("atlas")).toBeNull();
  });

  test("does not filter on the role tag, so a pre-tag volume stays visible", async () => {
    ec2.on(DescribeVolumesCommand).resolves({
      Volumes: [{ VolumeId: "vol-old", Size: 100, State: "available", Tags: [] }],
    });
    ec2.on(CreateTagsCommand).resolves({});

    const found = await compute().findVolumeByTag("atlas");
    expect(found).toMatchObject({ volume_id: "vol-old", size_gib: 100 });

    // The query itself must not mention the role tag: a volume created before
    // that tag existed would otherwise be invisible, and create would provision
    // a fresh empty disk and orphan the agent's memory.
    const [query] = inputsOf<{ Filters: Array<{ Name: string }> }>(ec2, DescribeVolumesCommand);
    expect(query!.Filters.map((f) => f.Name)).toEqual([
      "tag:agent",
      "tag:hermetic:managed",
      // The fleet clause is not optional: `agent=atlas` matches another fleet's
      // atlas too, and its data volume is the thing this lookup must never
      // return (§5).
      "tag:hermetic:fleet_id",
    ]);
  });

  test("labels an adopted volume so the next lookup and the DLM policy see it", async () => {
    ec2.on(DescribeVolumesCommand).resolves({
      Volumes: [{ VolumeId: "vol-old", Size: 100, State: "available", Tags: [] }],
    });
    ec2.on(CreateTagsCommand).resolves({});

    await compute().findVolumeByTag("atlas");
    const [tags] = inputsOf<{ Resources: string[]; Tags: Array<{ Key: string; Value: string }> }>(
      ec2,
      CreateTagsCommand,
    );
    expect(tags!.Resources).toEqual(["vol-old"]);
    expect(tags!.Tags).toEqual([DATA_TAG]);
  });

  test("a failed opportunistic tagging does not lose the volume", async () => {
    ec2.on(DescribeVolumesCommand).resolves({
      Volumes: [{ VolumeId: "vol-old", Size: 100, State: "available", Tags: [] }],
    });
    ec2.on(CreateTagsCommand).rejects(new Error("UnauthorizedOperation"));
    expect(await compute().findVolumeByTag("atlas")).toMatchObject({ volume_id: "vol-old" });
  });

  test("an already-tagged single volume is used without re-tagging", async () => {
    ec2.on(DescribeVolumesCommand).resolves({
      Volumes: [{ VolumeId: "vol-data", Size: 100, State: "available", Tags: [DATA_TAG] }],
    });
    expect(await compute().findVolumeByTag("atlas")).toMatchObject({ volume_id: "vol-data" });
    expect(callCount(ec2, CreateTagsCommand)).toBe(0);
  });

  test("with several volumes the role=data one wins over the root disk", async () => {
    ec2.on(DescribeVolumesCommand).resolves({
      Volumes: [
        { VolumeId: "vol-root", Size: 16, State: "in-use", Tags: [] },
        { VolumeId: "vol-data", Size: 100, State: "in-use", Tags: [DATA_TAG] },
      ],
    });
    expect(await compute().findVolumeByTag("atlas")).toMatchObject({
      volume_id: "vol-data",
      size_gib: 100,
    });
  });

  test("several volumes and none tagged is a refusal, never a guess", async () => {
    ec2.on(DescribeVolumesCommand).resolves({
      Volumes: [
        { VolumeId: "vol-a", Size: 100, State: "available", Tags: [] },
        { VolumeId: "vol-b", Size: 16, State: "in-use", Tags: [] },
      ],
    });
    let error: HermeticError | null = null;
    try {
      await compute().findVolumeByTag("atlas");
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error!.code).toBe("CONFLICT");
    expect(error!.details!["volume_ids"]).toEqual(["vol-a", "vol-b"]);
    expect(error!.message).toContain("will not guess");
    // Nothing was tagged on the way out, either.
    expect(callCount(ec2, CreateTagsCommand)).toBe(0);
  });

  test("two volumes both tagged role=data is also a refusal", async () => {
    ec2.on(DescribeVolumesCommand).resolves({
      Volumes: [
        { VolumeId: "vol-a", Size: 100, State: "available", Tags: [DATA_TAG] },
        { VolumeId: "vol-b", Size: 100, State: "available", Tags: [DATA_TAG] },
      ],
    });
    let error: HermeticError | null = null;
    try {
      await compute().findVolumeByTag("atlas");
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error!.code).toBe("CONFLICT");
    expect(error!.details!["data_volume_ids"]).toEqual(["vol-a", "vol-b"]);
  });

  test("a volume being deleted is not a candidate", async () => {
    ec2.on(DescribeVolumesCommand).resolves({
      Volumes: [
        { VolumeId: "vol-gone", Size: 100, State: "deleting", Tags: [DATA_TAG] },
        { VolumeId: "vol-data", Size: 100, State: "available", Tags: [DATA_TAG] },
      ],
    });
    expect(await compute().findVolumeByTag("atlas")).toMatchObject({ volume_id: "vol-data" });
  });
});

describe("createVolume", () => {
  test("tags the new volume as the data disk", async () => {
    ec2.on(CreateVolumeCommand).resolves({ VolumeId: "vol-new", Size: 100, State: "creating" });
    await compute().createVolume("atlas", 100);
    const [input] = inputsOf<{
      VolumeType: string;
      Encrypted: boolean;
      TagSpecifications: Array<{ Tags: Array<{ Key: string; Value: string }> }>;
    }>(ec2, CreateVolumeCommand);
    expect(input!.VolumeType).toBe("gp3");
    expect(input!.Encrypted).toBe(true);
    expect(input!.TagSpecifications[0]!.Tags).toContainEqual(DATA_TAG);
  });
});

/**
 * `agent create --volume` rewrites a volume's ownership tags, and
 * `--rollback-on-failure` has to be able to put them back *exactly* — including
 * the cases the forward path never produces: no agent tag at all, no
 * `role=data`, and an operator's own `Name` that hermetic overwrote on the way
 * in. A restore that deleted that `Name` would leave the account worse than the
 * failed create found it.
 */
describe("retagVolume", () => {
  test("the forward path sets the ownership tags in one call and deletes nothing", async () => {
    ec2.on(CreateTagsCommand).resolves({});
    await compute().retagVolume("vol-1", "bravo", { name: "main-bravo-data" });

    const [input] = inputsOf<{ Tags: Array<{ Key: string; Value: string }> }>(ec2, CreateTagsCommand);
    expect(input!.Tags).toContainEqual({ Key: "agent", Value: "bravo" });
    expect(input!.Tags).toContainEqual(DATA_TAG);
    expect(input!.Tags).toContainEqual({ Key: "hermetic:fleet_id", Value: TEST_FLEET_ID });
    // The display name is the caller's to state: only it knows the fleet's name.
    expect(input!.Tags).toContainEqual({ Key: "Name", Value: "main-bravo-data" });
    expect(callCount(ec2, DeleteTagsCommand)).toBe(0);
  });

  test("an unstated Name is left alone rather than derived", async () => {
    ec2.on(CreateTagsCommand).resolves({});
    ec2.on(DeleteTagsCommand).resolves({});
    await compute().retagVolume("vol-1", "bravo");

    const [set] = inputsOf<{ Tags: Array<{ Key: string; Value: string }> }>(ec2, CreateTagsCommand);
    expect(set!.Tags.map((t) => t.Key)).not.toContain("Name");
    expect(callCount(ec2, DeleteTagsCommand)).toBe(0);
  });

  test("a restore to no agent removes the agent tag and keeps the Name it was given", async () => {
    ec2.on(CreateTagsCommand).resolves({});
    ec2.on(DeleteTagsCommand).resolves({});
    await compute().retagVolume("vol-1", null, { roleData: false, name: "the-operators-disk" });

    const [set] = inputsOf<{ Tags: Array<{ Key: string; Value: string }> }>(ec2, CreateTagsCommand);
    // The operator's own label goes back on rather than being deleted with the
    // ownership tags this run wrote.
    expect(set!.Tags).toContainEqual({ Key: "Name", Value: "the-operators-disk" });
    expect(set!.Tags.map((t) => t.Key)).not.toContain("agent");

    const [removed] = inputsOf<{ Tags: Array<{ Key: string }> }>(ec2, DeleteTagsCommand);
    expect(removed!.Tags.map((t) => t.Key).sort()).toEqual(["agent", "hermetic:role"]);
  });

  test("a volume that carried no Name before has none put back", async () => {
    ec2.on(CreateTagsCommand).resolves({});
    ec2.on(DeleteTagsCommand).resolves({});
    await compute().retagVolume("vol-1", "oriole", { name: null });

    const [set] = inputsOf<{ Tags: Array<{ Key: string; Value: string }> }>(ec2, CreateTagsCommand);
    expect(set!.Tags.map((t) => t.Key)).not.toContain("Name");
    const [removed] = inputsOf<{ Tags: Array<{ Key: string }> }>(ec2, DeleteTagsCommand);
    expect(removed!.Tags.map((t) => t.Key)).toEqual(["Name"]);
  });
});
