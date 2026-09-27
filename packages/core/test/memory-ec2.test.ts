/**
 * `MemoryBackend` refusing what EC2 refuses.
 *
 * The double is what most of core's tests run against, so a precondition EC2
 * enforces and the double does not is a test that is green here and red on a
 * real account. Every case below asserts both halves of the answer
 * `Ec2Compute` would have given: the `HermeticError` code its `asHermeticError`
 * wrapper produces, and the EC2 error name in `details.aws_error` — which is
 * the half core actually branches on (`attach.ts` retries `IncorrectState` and
 * `VolumeInUse`, and gives up on everything else).
 */
import { describe, expect, test } from "bun:test";
import { HermeticError } from "../src/errors.ts";
import { MemoryBackend } from "../src/backend/memory.ts";

const INSTANCE = "i-0000000000000001";
const OTHER_INSTANCE = "i-0000000000000002";
const VOLUME = "vol-0000000000000001";

/** A backend holding one instance and one free volume, both in the launch AZ. */
function world(opts: { instance?: string; volume?: string; volumeAz?: string } = {}) {
  const backend = new MemoryBackend();
  backend.instances.set(INSTANCE, {
    instance_id: INSTANCE,
    state: opts.instance ?? "running",
    public_ip: null,
    agent: "atlas",
  });
  backend.volumes.set(VOLUME, {
    volume_id: VOLUME,
    size_gib: 100,
    state: opts.volume ?? "available",
    agent: "atlas",
    role: "data",
    attached_to: null,
    ...(opts.volumeAz === undefined ? {} : { az: opts.volumeAz }),
  });
  return backend;
}

/**
 * The refusal, as the two fields a caller reads. Anything that did *not* throw
 * fails here rather than silently reporting no refusal.
 */
async function refusal(p: Promise<unknown>): Promise<{ code: string; aws: unknown }> {
  try {
    await p;
    return { code: "(no refusal)", aws: null };
  } catch (e) {
    if (!(e instanceof HermeticError)) throw e;
    return { code: e.code, aws: e.details?.["aws_error"] ?? null };
  }
}

describe("MemoryBackend.compute.attachVolume", () => {
  test("a volume EC2 has never heard of is InvalidVolume.NotFound", async () => {
    const backend = world();
    expect(await refusal(backend.compute.attachVolume(INSTANCE, "vol-0000000000000999"))).toEqual({
      code: "INTERNAL",
      aws: "InvalidVolume.NotFound",
    });
  });

  test("an instance EC2 has never heard of is InvalidInstanceID.NotFound", async () => {
    const backend = world();
    expect(await refusal(backend.compute.attachVolume("i-0000000000000999", VOLUME))).toEqual({
      code: "INTERNAL",
      aws: "InvalidInstanceID.NotFound",
    });
  });

  test("a volume already attached elsewhere is VolumeInUse", async () => {
    const backend = world();
    backend.instances.set(OTHER_INSTANCE, {
      instance_id: OTHER_INSTANCE,
      state: "running",
      public_ip: null,
      agent: "juniper",
    });
    await backend.compute.attachVolume(OTHER_INSTANCE, VOLUME);
    expect(await refusal(backend.compute.attachVolume(INSTANCE, VOLUME))).toEqual({
      code: "INTERNAL",
      aws: "VolumeInUse",
    });
    // And it is still where it was: a refused attach moves nothing.
    expect(backend.volumes.get(VOLUME)?.attached_to).toBe(OTHER_INSTANCE);
  });

  test("attaching a volume to the instance that already holds it is VolumeInUse too", async () => {
    const backend = world();
    await backend.compute.attachVolume(INSTANCE, VOLUME);
    expect(await refusal(backend.compute.attachVolume(INSTANCE, VOLUME))).toEqual({
      code: "INTERNAL",
      aws: "VolumeInUse",
    });
  });

  test("a volume that is not yet available is IncorrectState", async () => {
    const backend = world({ volume: "creating" });
    expect(await refusal(backend.compute.attachVolume(INSTANCE, VOLUME))).toEqual({
      code: "INTERNAL",
      aws: "IncorrectState",
    });
  });

  test.each(["pending", "stopping", "shutting-down", "terminated"])(
    "an instance that is %s is IncorrectState",
    async (state) => {
      const backend = world({ instance: state });
      expect(await refusal(backend.compute.attachVolume(INSTANCE, VOLUME))).toEqual({
        code: "INTERNAL",
        aws: "IncorrectState",
      });
    },
  );

  /**
   * The other direction of the same contract: EC2 attaches to a stopped
   * instance, so a double that refused one would fail a test a real account
   * passes. `agent create --volume` on a box that has not been started is
   * exactly that shape.
   */
  test("a stopped instance is accepted, as EC2 accepts one", async () => {
    const backend = world({ instance: "stopped" });
    await backend.compute.attachVolume(INSTANCE, VOLUME);
    expect(backend.volumes.get(VOLUME)?.attached_to).toBe(INSTANCE);
    expect(backend.volumes.get(VOLUME)?.state).toBe("in-use");
  });

  test("a volume in another availability zone is InvalidVolume.ZoneMismatch", async () => {
    const backend = world({ volumeAz: "us-west-2c" });
    expect(await refusal(backend.compute.attachVolume(INSTANCE, VOLUME))).toEqual({
      code: "INTERNAL",
      aws: "InvalidVolume.ZoneMismatch",
    });
  });

  test("a refused attach is not recorded as a mutation", async () => {
    const backend = world({ instance: "terminated" });
    await refusal(backend.compute.attachVolume(INSTANCE, VOLUME));
    expect(backend.mutations).not.toContain("compute.attachVolume");
  });
});

describe("MemoryBackend.compute.deleteVolume", () => {
  test("a volume still attached is VolumeInUse, and nothing is deleted", async () => {
    const backend = world();
    await backend.compute.attachVolume(INSTANCE, VOLUME);
    expect(await refusal(backend.compute.deleteVolume(VOLUME))).toEqual({
      code: "INTERNAL",
      aws: "VolumeInUse",
    });
    expect(backend.volumes.has(VOLUME)).toBe(true);
    expect(backend.mutations).not.toContain("compute.deleteVolume");
  });

  /**
   * The route `destroy` takes: terminate detaches, and only then is the disk
   * deletable. A double that had let the delete through before the terminate
   * would have hidden the `waitVolumeReleased` wait §6.6 needs.
   */
  test("the same volume deletes once the instance holding it is terminated", async () => {
    const backend = world();
    await backend.compute.attachVolume(INSTANCE, VOLUME);
    await backend.compute.terminate(INSTANCE);
    await backend.compute.deleteVolume(VOLUME);
    expect(backend.volumes.has(VOLUME)).toBe(false);
  });

  test("a volume EC2 has already forgotten is success, not a refusal", async () => {
    const backend = world();
    await backend.compute.deleteVolume("vol-0000000000000999");
    expect(backend.mutations).not.toContain("compute.deleteVolume");
  });
});

describe("MemoryBackend.compute.terminate", () => {
  /** `Ec2Compute.terminate` swallows `InvalidInstanceID.NotFound`: gone is the goal. */
  test("an instance EC2 has already forgotten is success", async () => {
    const backend = world();
    await backend.compute.terminate("i-0000000000000999");
    expect(backend.mutations).not.toContain("compute.terminate");
  });
});

describe("MemoryBackend.compute.start", () => {
  test("an instance EC2 has never heard of is InvalidInstanceID.NotFound", async () => {
    const backend = world();
    expect(await refusal(backend.compute.start("i-0000000000000999"))).toEqual({
      code: "INTERNAL",
      aws: "InvalidInstanceID.NotFound",
    });
  });

  test.each(["terminated", "stopping", "shutting-down"])(
    "starting a %s instance is IncorrectInstanceState",
    async (state) => {
      const backend = world({ instance: state });
      expect(await refusal(backend.compute.start(INSTANCE))).toEqual({
        code: "INTERNAL",
        aws: "IncorrectInstanceState",
      });
      // The refusal is the whole answer: a terminated box does not come back.
      expect(backend.instances.get(INSTANCE)?.state).toBe(state);
    },
  );

  test("a stopped instance starts", async () => {
    const backend = world({ instance: "stopped" });
    expect((await backend.compute.start(INSTANCE)).state).toBe("pending");
  });
});

describe("MemoryBackend.compute.stop", () => {
  test("an instance EC2 has never heard of is InvalidInstanceID.NotFound", async () => {
    const backend = world();
    expect(await refusal(backend.compute.stop("i-0000000000000999"))).toEqual({
      code: "INTERNAL",
      aws: "InvalidInstanceID.NotFound",
    });
  });

  test.each(["terminated", "shutting-down"])(
    "stopping a %s instance is IncorrectInstanceState",
    async (state) => {
      const backend = world({ instance: state });
      expect(await refusal(backend.compute.stop(INSTANCE))).toEqual({
        code: "INTERNAL",
        aws: "IncorrectInstanceState",
      });
      expect(backend.instances.get(INSTANCE)?.state).toBe(state);
    },
  );

  test("stopping an already stopped instance is success, as StopInstances is", async () => {
    const backend = world({ instance: "stopped" });
    await backend.compute.stop(INSTANCE);
    expect(backend.instances.get(INSTANCE)?.state).toBe("stopped");
  });
});

describe("MemoryBackend.compute.reboot", () => {
  test("an instance EC2 has never heard of is InvalidInstanceID.NotFound", async () => {
    const backend = world();
    expect(await refusal(backend.compute.reboot("i-0000000000000999"))).toEqual({
      code: "INTERNAL",
      aws: "InvalidInstanceID.NotFound",
    });
  });

  test.each(["stopped", "pending", "terminated"])(
    "rebooting a %s instance is IncorrectInstanceState",
    async (state) => {
      const backend = world({ instance: state });
      expect(await refusal(backend.compute.reboot(INSTANCE))).toEqual({
        code: "INTERNAL",
        aws: "IncorrectInstanceState",
      });
      expect(backend.mutations).not.toContain("compute.reboot");
    },
  );

  test("a running instance reboots and stays exactly where it was", async () => {
    const backend = world();
    await backend.compute.attachVolume(INSTANCE, VOLUME);
    await backend.compute.reboot(INSTANCE);
    expect(backend.instances.get(INSTANCE)?.state).toBe("running");
    expect(backend.volumes.get(VOLUME)?.attached_to).toBe(INSTANCE);
    expect(backend.mutations).toContain("compute.reboot");
  });
});
