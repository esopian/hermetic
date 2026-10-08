import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  DeleteSnapshotCommand,
  DescribeAddressesCommand,
  DescribeSnapshotsCommand,
  DescribeVolumesCommand,
  EC2Client,
  ReleaseAddressCommand,
} from "@aws-sdk/client-ec2";
import { SSMClient } from "@aws-sdk/client-ssm";
import { mockClient } from "aws-sdk-client-mock";
import { Ec2Compute } from "../src/aws/ec2.ts";
import { DATA_SNAPSHOT_TAG, FLEET_ID_TAG, ROLE_TAG } from "../src/backend/constants.ts";
import { callCount, inputsOf, installTestProfile } from "./aws-harness.ts";

const profile = installTestProfile();
afterAll(() => profile.restore());

const ec2 = mockClient(EC2Client);
const ssm = mockClient(SSMClient);

beforeEach(() => {
  ec2.reset();
  ssm.reset();
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

type Filters = { Filters?: Array<{ Name?: string; Values?: string[] }>; OwnerIds?: string[] };

/**
 * §6.6 keeps a data volume by default, so `teardown --delete-volumes` is the
 * only thing that can ever find the ones no agent row names any more. The
 * managed tag is the whole of its handle on them.
 */
describe("listManagedVolumes", () => {
  test("selects on the managed and fleet tags, and reads the agent tag off each volume", async () => {
    ec2.on(DescribeVolumesCommand).resolves({
      Volumes: [
        {
          VolumeId: "vol-one",
          Size: 100,
          State: "available",
          Tags: [
            { Key: "hermetic:managed", Value: "true" },
            { Key: "agent", Value: "atlas" },
          ],
        },
        {
          VolumeId: "vol-untagged",
          Size: 200,
          State: "available",
          Tags: [{ Key: "hermetic:managed", Value: "true" }],
        },
      ],
    });

    expect(await compute().listManagedVolumes()).toEqual([
      {
        volume_id: "vol-one",
        size_gib: 100,
        agent: "atlas",
        former_agent: null,
        state: "available",
        created_at: null,
      },
      {
        volume_id: "vol-untagged",
        size_gib: 200,
        agent: null,
        former_agent: null,
        state: "available",
        created_at: null,
      },
    ]);

    const [input] = inputsOf<Filters>(ec2, DescribeVolumesCommand);
    expect(input!.Filters).toEqual([
      { Name: "tag:hermetic:managed", Values: ["true"] },
      // Scoped to this fleet: another fleet's data volumes are not this
      // teardown's to find, let alone to delete (§5).
      { Name: "tag:hermetic:fleet_id", Values: [TEST_FLEET_ID] },
    ]);
    // Not narrowed to role=data: a volume from before that tag existed is still
    // hermetic's, and teardown must be able to see it.
    expect(input!.Filters?.some((f) => f.Name === "tag:hermetic:role")).toBe(false);
  });

  test("a volume already going away is not reported", async () => {
    ec2.on(DescribeVolumesCommand).resolves({
      Volumes: [
        { VolumeId: "vol-live", Size: 100, State: "available", Tags: [] },
        { VolumeId: "vol-going", Size: 100, State: "deleting", Tags: [] },
        { VolumeId: "vol-gone", Size: 100, State: "deleted", Tags: [] },
      ],
    });
    expect((await compute().listManagedVolumes()).map((v) => v.volume_id)).toEqual(["vol-live"]);
  });

  test("pages through NextToken", async () => {
    ec2
      .on(DescribeVolumesCommand)
      .resolvesOnce({
        Volumes: [{ VolumeId: "vol-1", Size: 100, State: "available" }],
        NextToken: "page2",
      })
      .resolvesOnce({ Volumes: [{ VolumeId: "vol-2", Size: 100, State: "available" }] });

    expect((await compute().listManagedVolumes()).map((v) => v.volume_id)).toEqual(["vol-1", "vol-2"]);
    expect(callCount(ec2, DescribeVolumesCommand)).toBe(2);
  });
});

/** §7.1: the DLM policy copies the volume's tags, so `hermetic:role=data` is the mark. */
describe("listSnapshots", () => {
  test("scopes to this account and to the tag it was asked for", async () => {
    ec2.on(DescribeSnapshotsCommand).resolves({
      Snapshots: [
        {
          SnapshotId: "snap-1",
          VolumeId: "vol-one",
          VolumeSize: 100,
          StartTime: new Date("2026-08-31T05:00:00.000Z"),
        },
      ],
    });

    expect(await compute().listSnapshots(DATA_SNAPSHOT_TAG)).toEqual([
      {
        snapshot_id: "snap-1",
        volume_id: "vol-one",
        size_gib: 100,
        started_at: "2026-08-31T05:00:00.000Z",
      },
    ]);

    const [input] = inputsOf<Filters>(ec2, DescribeSnapshotsCommand);
    // Without OwnerIds this would return the public snapshot catalogue.
    expect(input!.OwnerIds).toEqual(["self"]);
    expect(input!.Filters).toEqual([
      { Name: "tag:hermetic:role", Values: ["data"] },
      // Every fleet's DLM policy tags its snapshots `hermetic:role=data`, so
      // the selector alone matches the account's — and `--delete-snapshots`
      // deletes what this returns (§5).
      { Name: "tag:hermetic:fleet_id", Values: [TEST_FLEET_ID] },
    ]);
  });

  test("fills in what a half-described snapshot omits rather than dropping it", async () => {
    ec2.on(DescribeSnapshotsCommand).resolves({ Snapshots: [{ SnapshotId: "snap-bare" }] });
    expect(await compute().listSnapshots(DATA_SNAPSHOT_TAG)).toEqual([
      {
        snapshot_id: "snap-bare",
        volume_id: "(unknown)",
        size_gib: 0,
        started_at: "1970-01-01T00:00:00.000Z",
      },
    ]);
  });

  test("pages through NextToken", async () => {
    ec2
      .on(DescribeSnapshotsCommand)
      .resolvesOnce({ Snapshots: [{ SnapshotId: "snap-1" }], NextToken: "page2" })
      .resolvesOnce({ Snapshots: [{ SnapshotId: "snap-2" }] });

    expect((await compute().listSnapshots(DATA_SNAPSHOT_TAG)).map((s) => s.snapshot_id)).toEqual([
      "snap-1",
      "snap-2",
    ]);
  });
});

describe("deleteSnapshot", () => {
  test("deletes exactly the snapshot it is given", async () => {
    ec2.on(DeleteSnapshotCommand).resolves({});
    await compute().deleteSnapshot("snap-1");
    expect(inputsOf(ec2, DeleteSnapshotCommand)).toEqual([{ SnapshotId: "snap-1" }]);
  });

  test("an AWS failure surfaces as a typed HermeticError", async () => {
    ec2.on(DeleteSnapshotCommand).rejects(new Error("InvalidSnapshot.InUse"));
    await expect(compute().deleteSnapshot("snap-1")).rejects.toThrow(/snap-1/);
  });
});

/**
 * §4.6: the `NatEip` a `nat` foundation owns is the one stack resource that can
 * outlive the stack — `DeleteStack` deletes the allocation only once its
 * association has released. The sweep that finds it afterwards is the only
 * thing that ever names it, so the filter it sends is worth pinning.
 */
describe("listAddresses", () => {
  test("selects on the fleet tag and reads the association off each address", async () => {
    ec2.on(DescribeAddressesCommand).resolves({
      Addresses: [
        {
          AllocationId: "eipalloc-free",
          PublicIp: "203.0.113.10",
          Tags: [{ Key: FLEET_ID_TAG, Value: TEST_FLEET_ID }],
        },
        {
          AllocationId: "eipalloc-stuck",
          PublicIp: "203.0.113.11",
          AssociationId: "eipassoc-1",
          InstanceId: "i-natbox",
          Tags: [
            { Key: FLEET_ID_TAG, Value: TEST_FLEET_ID },
            { Key: "Name", Value: "hermetic-fxtr0001-nat" },
          ],
        },
      ],
    });

    expect(await compute().listAddresses({ key: FLEET_ID_TAG, value: TEST_FLEET_ID })).toEqual([
      {
        allocation_id: "eipalloc-free",
        public_ip: "203.0.113.10",
        association_id: null,
        instance_id: null,
        tags: { [FLEET_ID_TAG]: TEST_FLEET_ID },
      },
      {
        allocation_id: "eipalloc-stuck",
        public_ip: "203.0.113.11",
        association_id: "eipassoc-1",
        instance_id: "i-natbox",
        tags: { [FLEET_ID_TAG]: TEST_FLEET_ID, Name: "hermetic-fxtr0001-nat" },
      },
    ]);

    const [input] = inputsOf<Filters>(ec2, DescribeAddressesCommand);
    /**
     * The caller's selector *and* this class's fleet clause, the way
     * `listSnapshots` does it — scoping is not something a caller's tag is
     * trusted to have got right, because what comes back is what `--purge`
     * releases. Here the two clauses are the same one twice, which EC2 ANDs to
     * the same answer.
     */
    expect(input!.Filters).toEqual([
      { Name: `tag:${FLEET_ID_TAG}`, Values: [TEST_FLEET_ID] },
      { Name: `tag:${FLEET_ID_TAG}`, Values: [TEST_FLEET_ID] },
    ]);
  });

  test("a selector that is not the fleet tag is scoped to this fleet as well", async () => {
    ec2.on(DescribeAddressesCommand).resolves({ Addresses: [] });
    await compute().listAddresses({ key: ROLE_TAG, value: "nat" });
    const [input] = inputsOf<Filters>(ec2, DescribeAddressesCommand);
    expect(input!.Filters).toEqual([
      { Name: `tag:${ROLE_TAG}`, Values: ["nat"] },
      { Name: `tag:${FLEET_ID_TAG}`, Values: [TEST_FLEET_ID] },
    ]);
  });
});

describe("releaseAddress", () => {
  test("releases exactly the allocation it is given", async () => {
    ec2.on(ReleaseAddressCommand).resolves({});
    await compute().releaseAddress("eipalloc-free");
    expect(inputsOf(ec2, ReleaseAddressCommand)).toEqual([{ AllocationId: "eipalloc-free" }]);
  });

  /**
   * Freeing an attached address needs a `DisassociateAddress` against whatever
   * holds it, which teardown will not do blindly — so EC2's refusal is passed
   * through as a typed error rather than worked around.
   */
  test("an address still in use surfaces as a typed HermeticError, not a disassociate", async () => {
    ec2.on(ReleaseAddressCommand).rejects(new Error("InvalidIPAddress.InUse"));
    await expect(compute().releaseAddress("eipalloc-stuck")).rejects.toThrow(/eipalloc-stuck/);
    expect(callCount(ec2, ReleaseAddressCommand)).toBe(1);
  });

  /**
   * `DescribeAddresses` is a few seconds stale either side of
   * `DELETE_COMPLETE`, so the ordinary race is an allocation CloudFormation has
   * already reaped. Already gone is released, not a failure to go and look for.
   */
  for (const code of ["InvalidAllocationID.NotFound", "InvalidAddress.NotFound"]) {
    test(`${code} counts as released rather than as a failure`, async () => {
      const notFound = Object.assign(new Error("does not exist"), { name: code });
      ec2.on(ReleaseAddressCommand).rejects(notFound);
      expect(await compute().releaseAddress("eipalloc-gone")).toBeUndefined();
    });
  }
});
