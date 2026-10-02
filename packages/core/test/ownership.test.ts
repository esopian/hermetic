/**
 * §6.7: an agent row is writable by the box it describes, so the instance and
 * volume ids on it are a hint rather than proof. These tests poison a row with
 * a resource that belongs to somebody else and check that `destroy` and
 * `recreate` refuse before they touch anything — the resource, and the row.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { DescribeInstancesCommand, DescribeVolumesCommand, EC2Client } from "@aws-sdk/client-ec2";
import { SSMClient } from "@aws-sdk/client-ssm";
import { mockClient } from "aws-sdk-client-mock";
import { Ec2Compute } from "../src/aws/ec2.ts";
import { FIXTURE_CONFIG, MemoryBackend, seedFixtureFleet } from "../src/backend/memory.ts";
import type { HermeticError } from "../src/errors.ts";
import { drain, testHermetic } from "./helpers.ts";
import { installTestProfile } from "./aws-harness.ts";

const profile = installTestProfile();
afterAll(() => profile.restore());

/** The fleet the fixture is bound to; `OTHER_FLEET` is the one next door. */
const TEST_FLEET_ID = "fxtr0001";
const OTHER_FLEET = "othr0002";

function seeded() {
  const backend = seedFixtureFleet(new MemoryBackend());
  return { backend, hermetic: testHermetic({ backend, config: FIXTURE_CONFIG }) };
}

/** A live box in the fleet next door, which this fleet must never terminate. */
function seedForeignInstance(backend: MemoryBackend, id = "i-foreign"): string {
  backend.instances.set(id, {
    instance_id: id,
    state: "running",
    public_ip: "198.51.100.7",
    agent: "someone-elses",
    fleet_id: OTHER_FLEET,
  });
  return id;
}

/** A data volume in the fleet next door, holding somebody else's memory (§1). */
function seedForeignVolume(backend: MemoryBackend, id = "vol-foreign"): string {
  backend.volumes.set(id, {
    volume_id: id,
    size_gib: 200,
    state: "available",
    agent: "someone-elses",
    role: "data",
    fleet_id: OTHER_FLEET,
  });
  return id;
}

/** Put `ids` on the agent row the way a compromised box's `UpdateItem` would. */
async function poison(
  backend: MemoryBackend,
  name: string,
  ids: { instance_id?: string; volume_id?: string },
): Promise<void> {
  const row = (await backend.store.agents.get(name))!;
  await backend.store.agents.update(name, row.version, {
    resources: { ...row.resources, ...ids },
  });
}

async function codeOf(run: Promise<unknown>): Promise<string | null> {
  try {
    await run;
    return null;
  } catch (e) {
    return (e as HermeticError).code;
  }
}

describe("destroy refuses a resource the row does not own", () => {
  test("a redirected instance id is refused and nothing moves", async () => {
    const { backend, hermetic } = seeded();
    const foreign = seedForeignInstance(backend);
    const before = (await backend.store.agents.get("atlas"))!;
    await poison(backend, "atlas", { instance_id: foreign });
    backend.resetMutations();

    const code = await codeOf(drain(hermetic.agents.destroy({ name: "atlas", yes: true })));

    expect(code).toBe("RESOURCE_NOT_OWNED");
    expect(backend.instances.get(foreign)!.state).toBe("running");
    const after = (await backend.store.agents.get("atlas"))!;
    expect(after.status).toBe(before.status);
    expect(after.lock).toBeNull();
    expect(backend.mutations).not.toContain("compute.terminate");
  });

  test("the message names the resource, the expected owner and the tags found", async () => {
    const { backend, hermetic } = seeded();
    const foreign = seedForeignInstance(backend);
    await poison(backend, "atlas", { instance_id: foreign });

    let error: HermeticError | null = null;
    try {
      await drain(hermetic.agents.destroy({ name: "atlas", yes: true }));
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error?.message).toContain(foreign);
    expect(error?.message).toContain("atlas");
    expect(error?.message).toContain(TEST_FLEET_ID);
    expect(error?.message).toContain(`hermetic:fleet_id=${OTHER_FLEET}`);
  });

  /**
   * The same poisoning through the plan/apply path, because that is the one the
   * portal takes: a plan computed from the row carries the row's ids too.
   */
  test("plan.destroy + apply refuses the same redirected id", async () => {
    const { backend, hermetic } = seeded();
    const foreign = seedForeignInstance(backend);
    await poison(backend, "atlas", { instance_id: foreign });

    const plan = await hermetic.plan.destroy({ name: "atlas" });
    const code = await codeOf(drain(hermetic.apply({ plan, yes: true })));

    expect(code).toBe("RESOURCE_NOT_OWNED");
    expect(backend.instances.get(foreign)!.state).toBe("running");
    expect((await backend.store.agents.get("atlas"))!.status).toBe("ready");
  });

  /**
   * `--delete-volume` is the irreversible half. The check runs before the
   * terminate, not beside the delete, so a poisoned volume id costs the agent
   * nothing at all — its own box is still running when the refusal lands.
   */
  test("a redirected volume id is refused before anything is terminated", async () => {
    const { backend, hermetic } = seeded();
    const foreign = seedForeignVolume(backend);
    const before = (await backend.store.agents.get("granite"))!;
    await poison(backend, "granite", { volume_id: foreign });
    backend.resetMutations();

    const code = await codeOf(drain(hermetic.agents.destroy({ name: "granite", yes: true })));

    expect(code).toBe("RESOURCE_NOT_OWNED");
    expect(backend.volumes.has(foreign)).toBe(true);
    expect(backend.mutations).not.toContain("compute.deleteVolume");
    expect(backend.mutations).not.toContain("compute.terminate");
    const after = (await backend.store.agents.get("granite"))!;
    expect(after.status).toBe(before.status);
    expect(after.lock).toBeNull();
  });

  /** A root disk carries the agent's own tags; only the data volume may be deleted. */
  test("the instance's root disk is refused even though it is tagged for the agent", async () => {
    const { backend, hermetic } = seeded();
    const root = "vol-root";
    backend.volumes.set(root, {
      volume_id: root,
      size_gib: 30,
      state: "in-use",
      agent: "granite",
      role: "root",
      fleet_id: TEST_FLEET_ID,
    });
    await poison(backend, "granite", { volume_id: root });

    const code = await codeOf(drain(hermetic.agents.destroy({ name: "granite", yes: true })));

    expect(code).toBe("RESOURCE_NOT_OWNED");
    expect(backend.volumes.has(root)).toBe(true);
  });

  /** The ordinary destroy is unchanged: its own ids pass the check. */
  test("an untampered row still destroys", async () => {
    const { backend, hermetic } = seeded();
    const volumeId = (await backend.store.agents.get("corvid"))!.resources.volume_id!;
    await drain(hermetic.agents.destroy({ name: "corvid", yes: true }));
    expect(await backend.store.agents.get("corvid")).toBeNull();
    expect(backend.volumes.has(volumeId)).toBe(false);
  });
});

describe("recreate refuses a resource the row does not own", () => {
  test("a redirected instance id is refused and the row keeps its status", async () => {
    const { backend, hermetic } = seeded();
    const foreign = seedForeignInstance(backend);
    const before = (await backend.store.agents.get("atlas"))!;
    await poison(backend, "atlas", { instance_id: foreign });
    backend.resetMutations();

    const code = await codeOf(drain(hermetic.agents.recreate({ name: "atlas", yes: true })));

    expect(code).toBe("RESOURCE_NOT_OWNED");
    expect(backend.instances.get(foreign)!.state).toBe("running");
    const after = (await backend.store.agents.get("atlas"))!;
    expect(after.status).toBe(before.status);
    expect(after.lock).toBeNull();
    expect(backend.mutations).not.toContain("compute.runInstance");
  });
});

/**
 * The real implementation's half. `DescribeInstances`/`DescribeVolumes` return
 * the tags; everything the refusal knows comes off them.
 */
describe("Ec2Compute ownership lookups", () => {
  const ec2 = mockClient(EC2Client);
  const ssm = mockClient(SSMClient);

  beforeEach(() => {
    ec2.reset();
    ssm.reset();
  });

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

  const owner = { fleet_id: TEST_FLEET_ID, agent: "atlas" };

  const ownedInstanceTags = [
    { Key: "hermetic:managed", Value: "true" },
    { Key: "agent", Value: "atlas" },
    { Key: "hermetic:fleet_id", Value: TEST_FLEET_ID },
  ];

  test("describeOwnedInstance returns the ref when the tags match", async () => {
    ec2.on(DescribeInstancesCommand).resolves({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: "i-1",
              State: { Name: "running" },
              PublicIpAddress: "203.0.113.4",
              SubnetId: "subnet-aaa",
              Tags: ownedInstanceTags,
            },
          ],
        },
      ],
    });
    expect(await compute().describeOwnedInstance("i-1", owner)).toEqual({
      instance_id: "i-1",
      state: "running",
      public_ip: "203.0.113.4",
      subnet_id: "subnet-aaa",
    });
  });

  test("describeOwnedInstance is null for an instance EC2 no longer has", async () => {
    ec2.on(DescribeInstancesCommand).resolves({ Reservations: [] });
    expect(await compute().describeOwnedInstance("i-gone", owner)).toBeNull();
  });

  test("describeOwnedInstance refuses another fleet's instance", async () => {
    ec2.on(DescribeInstancesCommand).resolves({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: "i-2",
              State: { Name: "running" },
              Tags: [
                { Key: "hermetic:managed", Value: "true" },
                { Key: "agent", Value: "atlas" },
                { Key: "hermetic:fleet_id", Value: OTHER_FLEET },
              ],
            },
          ],
        },
      ],
    });
    expect(await codeOf(compute().describeOwnedInstance("i-2", owner))).toBe("RESOURCE_NOT_OWNED");
  });

  test("describeOwnedInstance refuses an instance hermetic never tagged", async () => {
    ec2.on(DescribeInstancesCommand).resolves({
      Reservations: [{ Instances: [{ InstanceId: "i-3", State: { Name: "running" }, Tags: [] }] }],
    });
    expect(await codeOf(compute().describeOwnedInstance("i-3", owner))).toBe("RESOURCE_NOT_OWNED");
  });

  test("describeOwnedVolume returns the status when the tags match", async () => {
    ec2.on(DescribeVolumesCommand).resolves({
      Volumes: [
        {
          VolumeId: "vol-1",
          Size: 100,
          State: "available",
          Attachments: [],
          Tags: [
            { Key: "hermetic:managed", Value: "true" },
            { Key: "agent", Value: "atlas" },
            { Key: "hermetic:fleet_id", Value: TEST_FLEET_ID },
            { Key: "hermetic:role", Value: "data" },
          ],
        },
      ],
    });
    expect(await compute().describeOwnedVolume("vol-1", owner)).toEqual({
      volume_id: "vol-1",
      size_gib: 100,
      state: "available",
      attachments: [],
    });
  });

  /** A volume from before `hermetic:role` existed is still the agent's data disk. */
  test("describeOwnedVolume accepts a volume with no role tag", async () => {
    ec2.on(DescribeVolumesCommand).resolves({
      Volumes: [
        {
          VolumeId: "vol-old",
          Size: 100,
          State: "available",
          Tags: [
            { Key: "hermetic:managed", Value: "true" },
            { Key: "agent", Value: "atlas" },
            { Key: "hermetic:fleet_id", Value: TEST_FLEET_ID },
          ],
        },
      ],
    });
    expect((await compute().describeOwnedVolume("vol-old", owner))?.volume_id).toBe("vol-old");
  });

  test("describeOwnedVolume is null for a volume EC2 no longer has", async () => {
    ec2.on(DescribeVolumesCommand).resolves({ Volumes: [] });
    expect(await compute().describeOwnedVolume("vol-gone", owner)).toBeNull();
  });

  test("describeOwnedVolume refuses another agent's volume", async () => {
    ec2.on(DescribeVolumesCommand).resolves({
      Volumes: [
        {
          VolumeId: "vol-2",
          Size: 100,
          State: "available",
          Tags: [
            { Key: "hermetic:managed", Value: "true" },
            { Key: "agent", Value: "corvid" },
            { Key: "hermetic:fleet_id", Value: TEST_FLEET_ID },
            { Key: "hermetic:role", Value: "data" },
          ],
        },
      ],
    });
    expect(await codeOf(compute().describeOwnedVolume("vol-2", owner))).toBe("RESOURCE_NOT_OWNED");
  });

  test("describeOwnedVolume refuses a root disk carrying the agent's tags", async () => {
    ec2.on(DescribeVolumesCommand).resolves({
      Volumes: [
        {
          VolumeId: "vol-root",
          Size: 30,
          State: "in-use",
          Tags: [
            { Key: "hermetic:managed", Value: "true" },
            { Key: "agent", Value: "atlas" },
            { Key: "hermetic:fleet_id", Value: TEST_FLEET_ID },
            { Key: "hermetic:role", Value: "root" },
          ],
        },
      ],
    });
    expect(await codeOf(compute().describeOwnedVolume("vol-root", owner))).toBe("RESOURCE_NOT_OWNED");
  });
});
