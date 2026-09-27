/**
 * The unbounded data-volume attach (`src/attach.ts`).
 *
 * These are the paths a fixture cannot show, because the fixture's instances
 * boot instantly and its volumes are never held by anyone: an instance that
 * takes its time, a volume the previous instance has not let go of yet, EC2
 * refusing an attach it will accept a second later, and the three ways this can
 * genuinely fail. Nothing here sleeps for real — `pollMs` is a tick.
 */
import { describe, expect, test } from "bun:test";
import {
  ATTACH_BACKOFF_CAP_MS,
  attachAgentVolume,
  INSTANCE_VISIBILITY_GRACE_MS,
  waitVolumeReleased,
} from "../src/agents/attach.ts";
import type { VolumeRelease } from "../src/agents/attach.ts";
import { HermeticError } from "../src/errors.ts";
import type { InstanceRef, VolumeStatus } from "../src/backend/types.ts";
import type { OpEvent } from "../src/schema/index.ts";

interface Fake {
  instances: Map<string, InstanceRef>;
  volumes: Map<string, VolumeStatus>;
  attaches: Array<[string, string]>;
  describes: number;
  /** Replaces the next `attachVolume` outcome; used to inject a refusal. */
  attachFails: HermeticError[];
  /** The same, for the two reads: EC2 throttles those as readily as a write. */
  instanceFails: HermeticError[];
  volumeFails: HermeticError[];
}

function world(): Fake {
  return {
    instances: new Map(),
    volumes: new Map(),
    attaches: [],
    describes: 0,
    attachFails: [],
    instanceFails: [],
    volumeFails: [],
  };
}

function computeOf(w: Fake) {
  return {
    describeInstance: async (id: string): Promise<InstanceRef | null> => {
      w.describes += 1;
      const failure = w.instanceFails.shift();
      if (failure) throw failure;
      return w.instances.get(id) ?? null;
    },
    describeVolume: async (id: string): Promise<VolumeStatus | null> => {
      const failure = w.volumeFails.shift();
      if (failure) throw failure;
      return w.volumes.get(id) ?? null;
    },
    attachVolume: async (instanceId: string, volumeId: string): Promise<void> => {
      const failure = w.attachFails.shift();
      if (failure) throw failure;
      w.attaches.push([instanceId, volumeId]);
      const vol = w.volumes.get(volumeId);
      if (vol) {
        w.volumes.set(volumeId, {
          ...vol,
          state: "in-use",
          attachments: [{ instance_id: instanceId, state: "attached" }],
        });
      }
    },
  };
}

function run(w: Fake, instanceId = "i-1", volumeId = "vol-1"): Promise<OpEvent[]> {
  return (async () => {
    const out: OpEvent[] = [];
    for await (const e of attachAgentVolume(
      { compute: computeOf(w), pollMs: 0, progressMs: 0 },
      instanceId,
      volumeId,
    )) {
      out.push(e);
    }
    return out;
  })();
}

function running(id = "i-1"): InstanceRef {
  return { instance_id: id, state: "running", public_ip: null };
}

function freeVolume(id = "vol-1"): VolumeStatus {
  return { volume_id: id, size_gib: 100, state: "available", attachments: [] };
}

/**
 * A clock the test moves by hand, so a two-minute grace is instant and the
 * assertions about it are exact rather than timing-dependent.
 */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_700_000_000_000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** Run the attach against a fake clock that ages five seconds per poll. */
async function runTicking(
  w: Fake,
  c: ReturnType<typeof clock>,
  beforeEachPoll?: () => void,
): Promise<OpEvent[]> {
  const compute = computeOf(w);
  const describeInstance = compute.describeInstance;
  compute.describeInstance = async (id: string) => {
    c.advance(5_000);
    beforeEachPoll?.();
    return describeInstance(id);
  };
  const out: OpEvent[] = [];
  for await (const e of attachAgentVolume(
    { compute, pollMs: 0, progressMs: 0, now: c.now },
    "i-1",
    "vol-1",
  )) {
    out.push(e);
  }
  return out;
}

describe("attachAgentVolume", () => {
  test("attaches a free volume to a running instance", async () => {
    const w = world();
    w.instances.set("i-1", running());
    w.volumes.set("vol-1", freeVolume());

    const events = await run(w);

    expect(w.attaches).toEqual([["i-1", "vol-1"]]);
    expect(events.at(-1)?.kind).toBe("done");
    expect(events.at(-1)?.message).toContain("attached to i-1");
  });

  test("a volume already on this instance is success, and attaches nothing", async () => {
    const w = world();
    w.instances.set("i-1", running());
    w.volumes.set("vol-1", {
      ...freeVolume(),
      state: "in-use",
      attachments: [{ instance_id: "i-1", state: "attached" }],
    });

    const events = await run(w);

    // The whole point of resuming: a crash after AttachVolume must cost one
    // describe, not a second attach.
    expect(w.attaches).toEqual([]);
    expect(events.at(-1)?.kind).toBe("done");
  });

  /** The timeout that used to fail a create at three minutes. */
  test("waits for a pending instance however many polls it takes", async () => {
    const w = world();
    w.volumes.set("vol-1", freeVolume());
    w.instances.set("i-1", { instance_id: "i-1", state: "pending", public_ip: null });
    let polls = 0;
    const compute = computeOf(w);
    const describeInstance = compute.describeInstance;
    compute.describeInstance = async (id: string) => {
      polls += 1;
      // Two hundred polls is well past the old 180s deadline.
      if (polls > 200) w.instances.set("i-1", running());
      return describeInstance(id);
    };

    const out: OpEvent[] = [];
    for await (const e of attachAgentVolume({ compute, pollMs: 0, progressMs: 0 }, "i-1", "vol-1")) {
      out.push(e);
    }

    expect(w.attaches).toEqual([["i-1", "vol-1"]]);
    expect(polls).toBeGreaterThan(200);
    expect(out.some((e) => e.message.includes("still booting"))).toBe(true);
  });

  test("waits for a terminated holder to release the volume, then attaches", async () => {
    const w = world();
    w.instances.set("i-1", running());
    w.instances.set("i-old", { instance_id: "i-old", state: "shutting-down", public_ip: null });
    w.volumes.set("vol-1", {
      ...freeVolume(),
      state: "in-use",
      attachments: [{ instance_id: "i-old", state: "attached" }],
    });
    let looks = 0;
    const compute = computeOf(w);
    const describeVolume = compute.describeVolume;
    compute.describeVolume = async (id: string) => {
      looks += 1;
      if (looks > 3) w.volumes.set("vol-1", freeVolume());
      return describeVolume(id);
    };

    const out: OpEvent[] = [];
    for await (const e of attachAgentVolume({ compute, pollMs: 0, progressMs: 0 }, "i-1", "vol-1")) {
      out.push(e);
    }

    expect(w.attaches).toEqual([["i-1", "vol-1"]]);
    expect(out.some((e) => e.message.includes("release volume vol-1"))).toBe(true);
  });

  test("a volume held by a live instance is a conflict, not something to wait for", async () => {
    const w = world();
    w.instances.set("i-1", running());
    w.instances.set("i-2", running("i-2"));
    w.volumes.set("vol-1", {
      ...freeVolume(),
      state: "in-use",
      attachments: [{ instance_id: "i-2", state: "attached" }],
    });

    const err = (await run(w).catch((e: unknown) => e)) as HermeticError;
    expect(err).toBeInstanceOf(HermeticError);
    expect(err.code).toBe("CONFLICT");
    expect(err.details?.["attached_to"]).toBe("i-2");
    expect(w.attaches).toEqual([]);
  });

  test("a terminated instance fails fast rather than waiting for a boot that will not happen", async () => {
    const w = world();
    w.instances.set("i-1", { instance_id: "i-1", state: "terminated", public_ip: null });
    w.volumes.set("vol-1", freeVolume());

    const err = (await run(w).catch((e: unknown) => e)) as HermeticError;
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toContain("terminated");
  });

  /**
   * The race that killed a real create: `RunInstances` had returned the id and
   * the box was booting fine, but the first `DescribeInstances` still answered
   * `InvalidInstanceID.NotFound` — which `aws/ec2.ts` maps to `null` — and the
   * attach called it gone.
   */
  test("an id DescribeInstances has not caught up with yet is waited on, not called gone", async () => {
    const w = world();
    w.volumes.set("vol-1", freeVolume());
    const c = clock();

    const out = await runTicking(w, c, () => {
      // Invisible for three polls, then EC2 admits it exists.
      if (w.describes >= 3) w.instances.set("i-1", running());
    });

    expect(w.attaches).toEqual([["i-1", "vol-1"]]);
    expect(w.describes).toBeGreaterThanOrEqual(4);
    expect(out.some((e) => e.message.includes("not visible"))).toBe(true);
  });

  test("an instance EC2 has forgotten is the same answer, but only once the grace is up", async () => {
    const w = world();
    w.volumes.set("vol-1", freeVolume());
    const c = clock();
    const started = c.now();

    const err = (await runTicking(w, c).catch((e: unknown) => e)) as HermeticError;

    expect(err).toBeInstanceOf(HermeticError);
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toContain("is gone and cannot take the data volume");
    // It gave EC2 its two minutes rather than believing the first poll.
    expect(c.now() - started).toBeGreaterThanOrEqual(INSTANCE_VISIBILITY_GRACE_MS);
    expect(w.describes).toBeGreaterThan(1);
  });

  test("an id that has been seen and then vanishes is gone at once, with no grace", async () => {
    const w = world();
    w.instances.set("i-1", running());
    // A volume EC2 is still making keeps the loop alive for a second poll.
    w.volumes.set("vol-1", { ...freeVolume(), state: "creating" });
    const c = clock();
    const started = c.now();

    const err = (await runTicking(w, c, () => {
      // Confirmed running once; now EC2 loses it for real.
      if (w.describes >= 1) w.instances.delete("i-1");
    }).catch((e: unknown) => e)) as HermeticError;

    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toContain("is gone and cannot take the data volume");
    // Second poll, not the twenty-fourth: the grace is for ids never seen.
    expect(w.describes).toBe(2);
    expect(c.now() - started).toBeLessThan(INSTANCE_VISIBILITY_GRACE_MS);
  });

  /** A stopped instance never reaches `running` on its own; waiting for it is a wasted deadline. */
  test("a stopped instance fails fast", async () => {
    const w = world();
    w.instances.set("i-1", { instance_id: "i-1", state: "stopped", public_ip: null });
    w.volumes.set("vol-1", freeVolume());

    const err = (await run(w).catch((e: unknown) => e)) as HermeticError;
    expect(err.code).toBe("CONFLICT");
    expect(err.message).toContain("will not reach running");
    // One look, not a deadline's worth.
    expect(w.describes).toBe(1);
  });

  test("a missing volume is NOT_FOUND", async () => {
    const w = world();
    w.instances.set("i-1", running());

    const err = (await run(w).catch((e: unknown) => e)) as HermeticError;
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toContain("vol-1");
  });

  test("AttachVolume refused as IncorrectState is retried; anything else is not", async () => {
    const w = world();
    w.instances.set("i-1", running());
    w.volumes.set("vol-1", freeVolume());
    w.attachFails.push(
      new HermeticError("INTERNAL", "vol-1 is not 'available'", { aws_error: "IncorrectState" }),
    );

    const events = await run(w);
    expect(w.attaches).toEqual([["i-1", "vol-1"]]);
    expect(events.some((e) => e.level === "warn" && e.message.includes("IncorrectState"))).toBe(true);

    const w2 = world();
    w2.instances.set("i-1", running());
    w2.volumes.set("vol-1", freeVolume());
    w2.attachFails.push(new HermeticError("INTERNAL", "no", { aws_error: "InvalidParameterValue" }));
    await expect(run(w2)).rejects.toThrow("no");
  });

  /**
   * The reads are as throttleable as the write, and until they were guarded a
   * single `RequestLimitExceeded` on one `DescribeInstances` escaped the whole
   * unbounded wait and failed the create — which, with
   * `--rollback-on-failure`, terminated a healthy instance that was booting
   * perfectly well because EC2 was busy for one second.
   */
  test("a throttled DescribeInstances is retried, not thrown", async () => {
    const w = world();
    w.instances.set("i-1", running());
    w.volumes.set("vol-1", freeVolume());
    w.instanceFails.push(
      new HermeticError("INTERNAL", "Request limit exceeded", { aws_error: "RequestLimitExceeded" }),
    );

    const events = await run(w);
    expect(w.attaches).toEqual([["i-1", "vol-1"]]);
    expect(
      events.some((e) => e.level === "warn" && e.message.includes("DescribeInstances was refused")),
    ).toBe(true);
  });

  test("a throttled DescribeVolumes is retried, not thrown", async () => {
    const w = world();
    w.instances.set("i-1", running());
    w.volumes.set("vol-1", freeVolume());
    w.volumeFails.push(
      new HermeticError("INTERNAL", "slow down", { aws_error: "ThrottlingException" }),
    );

    const events = await run(w);
    expect(w.attaches).toEqual([["i-1", "vol-1"]]);
    expect(
      events.some((e) => e.level === "warn" && e.message.includes("DescribeVolumes was refused")),
    ).toBe(true);
  });

  test("a read that fails for a reason AWS did not name is still fatal", async () => {
    const w = world();
    w.instances.set("i-1", running());
    w.volumes.set("vol-1", freeVolume());
    w.instanceFails.push(new HermeticError("INTERNAL", "AuthFailure", { aws_error: "AuthFailure" }));
    await expect(run(w)).rejects.toThrow("AuthFailure");
  });

  /**
   * A poll is a question about a world that changes on its own, and five
   * seconds is the right rhythm for it. A transient refusal is AWS saying it
   * has too much on, and asking again at the same rate adds to the problem — so
   * the delay doubles, jittered, up to `ATTACH_BACKOFF_CAP_MS`.
   */
  test("consecutive refusals back off exponentially, jittered, up to the cap", async () => {
    const w = world();
    w.instances.set("i-1", running());
    w.volumes.set("vol-1", freeVolume());
    for (let i = 0; i < 12; i += 1) {
      w.attachFails.push(new HermeticError("INTERNAL", "busy", { aws_error: "RequestLimitExceeded" }));
    }
    const slept: number[] = [];
    const realSleep = globalThis.setTimeout;
    // The wait's only sleep is a `setTimeout`; recording it is how the shape of
    // the backoff is observed without any test taking real time.
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void, ms?: number) => {
      slept.push(ms ?? 0);
      return realSleep(fn, 0);
    }) as typeof setTimeout;
    try {
      await (async () => {
        for await (const _ of attachAgentVolume(
          // A real cadence, so the doubling is in milliseconds a human would
          // recognise; nothing actually waits, because the timer is stubbed.
          { compute: computeOf(w), pollMs: 5_000, progressMs: 0, random: () => 1 },
          "i-1",
          "vol-1",
        )) {
          /* drain */
        }
      })();
    } finally {
      (globalThis as { setTimeout: typeof setTimeout }).setTimeout = realSleep;
    }

    expect(w.attaches).toEqual([["i-1", "vol-1"]]);
    // 5s, 10s, 20s … and never more than the cap, however long AWS stays busy.
    expect(slept.slice(0, 4)).toEqual([5_000, 10_000, 20_000, 40_000]);
    expect(Math.max(...slept)).toBe(ATTACH_BACKOFF_CAP_MS);
    // Jitter is real: half the delay is guaranteed and half is random, so the
    // same sequence with a different source is uniformly shorter.
    expect(slept.length).toBe(12);
  });

  test("the jitter halves the delay at the bottom of its range", async () => {
    const w = world();
    w.instances.set("i-1", running());
    w.volumes.set("vol-1", freeVolume());
    w.attachFails.push(new HermeticError("INTERNAL", "busy", { aws_error: "RequestLimitExceeded" }));
    const slept: number[] = [];
    const realSleep = globalThis.setTimeout;
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((fn: () => void, ms?: number) => {
      slept.push(ms ?? 0);
      return realSleep(fn, 0);
    }) as typeof setTimeout;
    try {
      await (async () => {
        for await (const _ of attachAgentVolume(
          { compute: computeOf(w), pollMs: 5_000, progressMs: 0, random: () => 0 },
          "i-1",
          "vol-1",
        )) {
          /* drain */
        }
      })();
    } finally {
      (globalThis as { setTimeout: typeof setTimeout }).setTimeout = realSleep;
    }
    expect(slept).toEqual([2_500]);
  });

  test("aborting stops the wait and says both resources still exist", async () => {
    const w = world();
    w.instances.set("i-1", { instance_id: "i-1", state: "pending", public_ip: null });
    w.volumes.set("vol-1", freeVolume());
    const controller = new AbortController();

    const err = await (async () => {
      try {
        for await (const e of attachAgentVolume(
          { compute: computeOf(w), pollMs: 0, progressMs: 0 },
          "i-1",
          "vol-1",
          { signal: controller.signal },
        )) {
          if (e.message.includes("still booting")) controller.abort();
        }
        return null;
      } catch (e) {
        return e as HermeticError;
      }
    })();

    expect(err?.code).toBe("ABORTED");
    expect(err?.message).toContain("still exist in AWS");
  });

  test("the heartbeat runs on every poll, so a long wait can renew a TTL lock", async () => {
    const w = world();
    w.instances.set("i-1", { instance_id: "i-1", state: "pending", public_ip: null });
    w.volumes.set("vol-1", freeVolume());
    let beats = 0;
    const compute = computeOf(w);
    const describeInstance = compute.describeInstance;
    compute.describeInstance = async (id: string) => {
      if (beats >= 5) w.instances.set("i-1", running());
      return describeInstance(id);
    };

    for await (const _ of attachAgentVolume({ compute, pollMs: 0, progressMs: 0 }, "i-1", "vol-1", {
      heartbeat: async () => {
        beats += 1;
      },
    })) {
      void _;
    }

    expect(beats).toBeGreaterThanOrEqual(5);
    expect(w.attaches).toEqual([["i-1", "vol-1"]]);
  });
});

/**
 * The unbounded detach wait (`waitVolumeReleased`), which is the other half of
 * the same problem. `TerminateInstances` returns as soon as EC2 accepts it and
 * the volume detaches seconds later, so `destroy --delete-volume` used to send
 * `DeleteVolume` into that window and be refused with `VolumeInUse` — dying at
 * the volume step with the instance already terminated and stranding the agent
 * in `destroying`.
 */
function release(w: Fake, volumeId = "vol-1"): Promise<{ events: OpEvent[]; outcome: VolumeRelease }> {
  return (async () => {
    const events: OpEvent[] = [];
    const gen = waitVolumeReleased({ compute: computeOf(w), pollMs: 0, progressMs: 0 }, volumeId);
    for (;;) {
      const step = await gen.next();
      if (step.done) return { events, outcome: step.value };
      events.push(step.value);
    }
  })();
}

function heldBy(instanceId: string, id = "vol-1", state = "attached"): VolumeStatus {
  return {
    volume_id: id,
    size_gib: 100,
    state: "in-use",
    attachments: [{ instance_id: instanceId, state }],
  };
}

function terminated(id: string): InstanceRef {
  return { instance_id: id, state: "terminated", public_ip: null };
}

describe("waitVolumeReleased", () => {
  test("a volume attached to nothing is already free, and says nothing about it", async () => {
    const w = world();
    w.volumes.set("vol-1", freeVolume());

    const { events, outcome } = await release(w);

    expect(outcome).toBe("free");
    // No wait happened, so there is nothing worth putting in the op stream.
    expect(events).toEqual([]);
  });

  test("a volume that no longer exists is gone, not an error", async () => {
    // `destroy` is re-run to finish an interrupted one (§4.5); the second run
    // must not die on the volume the first run already deleted.
    const { events, outcome } = await release(world());
    expect(outcome).toBe("gone");
    expect(events).toEqual([]);
  });

  /**
   * The detach wait is as throttleable as the attach, and it is the wait
   * `destroy` and the `--rollback-on-failure` unwind both stand on: a throw
   * here strands an agent mid-destroy with its instance already terminated and
   * its secrets already gone.
   */
  test("a throttled DescribeVolumes keeps the detach wait polling", async () => {
    const w = world();
    w.volumes.set("vol-1", freeVolume());
    w.volumeFails.push(
      new HermeticError("INTERNAL", "slow down", { aws_error: "RequestLimitExceeded" }),
    );

    const { events, outcome } = await release(w);

    expect(outcome).toBe("free");
    expect(
      events.some((e) => e.level === "warn" && e.message.includes("DescribeVolumes was refused")),
    ).toBe(true);
  });

  /**
   * And a refusal while asking whether a holder is alive restarts the pass
   * rather than skipping the holder: "we could not find out" is not "it is
   * dying", and only the second is safe to walk past — walking past it would
   * report a volume as free while a live instance still had it.
   */
  test("a throttled DescribeInstances about a holder does not read as a dying holder", async () => {
    const w = world();
    w.instances.set("i-1", terminated("i-1"));
    w.volumes.set("vol-1", heldBy("i-1"));
    w.instanceFails.push(new HermeticError("INTERNAL", "busy", { aws_error: "Throttling" }));
    let polls = 0;
    const compute = {
      ...computeOf(w),
      describeVolume: async (id: string): Promise<VolumeStatus | null> => {
        polls += 1;
        return polls >= 3 ? freeVolume(id) : (w.volumes.get(id) ?? null);
      },
    };

    const events: OpEvent[] = [];
    const gen = waitVolumeReleased({ compute, pollMs: 0, progressMs: 0 }, "vol-1");
    let outcome: VolumeRelease | undefined;
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        outcome = step.value;
        break;
      }
      events.push(step.value);
    }

    expect(outcome).toBe("free");
    expect(
      events.some((e) => e.level === "warn" && e.message.includes("DescribeInstances was refused")),
    ).toBe(true);
  });

  test("a holder EC2 will not answer about at all is still not walked past", async () => {
    const w = world();
    w.instances.set("i-1", { instance_id: "i-1", state: "running", public_ip: null });
    w.volumes.set("vol-1", heldBy("i-1"));
    // One refusal, then the truth: the volume belongs to a live box.
    w.instanceFails.push(new HermeticError("INTERNAL", "busy", { aws_error: "Throttling" }));

    await expect(release(w)).rejects.toThrow("still attached to i-1");
  });

  test("a volume already being deleted is gone", async () => {
    const w = world();
    w.volumes.set("vol-1", { volume_id: "vol-1", size_gib: 100, state: "deleting", attachments: [] });
    expect((await release(w)).outcome).toBe("gone");
  });

  test("waits for a terminating instance to let the volume go", async () => {
    // The exact failure that stranded the agent: terminate has been accepted,
    // the instance is shutting down, and the volume is still attached.
    const w = world();
    w.instances.set("i-1", { instance_id: "i-1", state: "shutting-down", public_ip: null });
    w.volumes.set("vol-1", heldBy("i-1"));

    let polls = 0;
    const compute = {
      ...computeOf(w),
      describeVolume: async (id: string): Promise<VolumeStatus | null> => {
        polls += 1;
        // EC2 lets go on the third look, the way it does in reality.
        if (polls >= 3) return freeVolume(id);
        return w.volumes.get(id) ?? null;
      },
    };

    const events: OpEvent[] = [];
    const gen = waitVolumeReleased({ compute, pollMs: 0, progressMs: 0 }, "vol-1");
    let outcome: VolumeRelease | undefined;
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        outcome = step.value;
        break;
      }
      events.push(step.value);
    }

    expect(outcome).toBe("free");
    expect(polls).toBe(3);
    expect(events.some((e) => e.message.includes("waiting for i-1 to release"))).toBe(true);
    // Having waited, it says so when the wait ends.
    expect(events.at(-1)?.kind).toBe("done");
    expect(events.at(-1)?.message).toContain("detached");
  });

  test("a detaching attachment still counts as held", async () => {
    const w = world();
    w.instances.set("i-1", terminated("i-1"));
    w.volumes.set("vol-1", heldBy("i-1", "vol-1", "detaching"));

    let polls = 0;
    const compute = {
      ...computeOf(w),
      describeVolume: async (id: string): Promise<VolumeStatus | null> => {
        polls += 1;
        return polls >= 2 ? freeVolume(id) : (w.volumes.get(id) ?? null);
      },
    };
    const gen = waitVolumeReleased({ compute, pollMs: 0, progressMs: 0 }, "vol-1");
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        expect(step.value).toBe("free");
        break;
      }
    }
    expect(polls).toBe(2);
  });

  test("a holder that is still alive is a conflict, not something to wait for", async () => {
    // §1: guessing which disk holds an agent's memory is not allowed. A live
    // holder will never let go on its own, so waiting would hang forever.
    const w = world();
    w.instances.set("i-2", running("i-2"));
    w.volumes.set("vol-1", heldBy("i-2"));

    let error: HermeticError | null = null;
    try {
      await release(w);
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error?.code).toBe("CONFLICT");
    expect(error?.message).toContain("i-2");
  });

  test("a holder EC2 has forgotten is treated as dying, not as a live holder", async () => {
    const w = world();
    w.volumes.set("vol-1", heldBy("i-gone"));

    let polls = 0;
    const compute = {
      ...computeOf(w),
      describeVolume: async (id: string): Promise<VolumeStatus | null> => {
        polls += 1;
        return polls >= 2 ? freeVolume(id) : (w.volumes.get(id) ?? null);
      },
    };
    const gen = waitVolumeReleased({ compute, pollMs: 0, progressMs: 0 }, "vol-1");
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        expect(step.value).toBe("free");
        break;
      }
    }
  });

  test("an abort stops the wait and says both things still exist", async () => {
    const w = world();
    w.instances.set("i-1", terminated("i-1"));
    w.volumes.set("vol-1", heldBy("i-1"));
    const control = new AbortController();
    control.abort();

    let error: HermeticError | null = null;
    try {
      const gen = waitVolumeReleased({ compute: computeOf(w), pollMs: 0, progressMs: 0 }, "vol-1", {
        signal: control.signal,
      });
      for (;;) if ((await gen.next()).done) break;
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error?.code).toBe("ABORTED");
    expect(error?.message).toContain("still exists");
  });

  test("renews the caller's lock on every poll", async () => {
    // An unbounded wait that lets its TTL lock lapse would let a second
    // operator start on top of a destroy that is still running (§4.4).
    const w = world();
    w.instances.set("i-1", terminated("i-1"));
    w.volumes.set("vol-1", heldBy("i-1"));

    let polls = 0;
    const compute = {
      ...computeOf(w),
      describeVolume: async (id: string): Promise<VolumeStatus | null> => {
        polls += 1;
        return polls >= 3 ? freeVolume(id) : (w.volumes.get(id) ?? null);
      },
    };
    let beats = 0;
    const gen = waitVolumeReleased({ compute, pollMs: 0, progressMs: 0 }, "vol-1", {
      heartbeat: async () => {
        beats += 1;
      },
    });
    for (;;) if ((await gen.next()).done) break;
    expect(beats).toBe(polls);
  });
});
