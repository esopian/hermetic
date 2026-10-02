/**
 * `rollbackCreate` on its own (`src/rollback.ts`), the way `attach.test.ts`
 * drives the attach waiter: fakes rather than a fleet, so the paths a fixture
 * cannot reach are testable — a step that throws, a volume EC2 has not detached
 * yet, an instance that is already gone, and the difference between a run that
 * claimed the row and one that resumed somebody else's.
 *
 * The integration side (a real `agents.create` failing with the flag set) lives
 * in `create.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import {
  rollbackCreate,
  type CreateLedger,
  type RollbackDeps,
  type RollbackOutcome,
} from "../src/agents/rollback.ts";
import { HermeticError } from "../src/errors.ts";
import type { InstanceRef, VolumeDetail, VolumeStatus } from "../src/backend/types.ts";
import type { Agent, OpEvent } from "../src/schema/index.ts";

const NAME = "atlas";
const OWNER = "arn:aws:iam::123456789012:user/ops#run-1";
/** Whoever took the row while this run was busy losing it. */
const OTHER = "arn:aws:iam::123456789012:user/other#run-2";

/**
 * Only the fields the ownership check reads — the lock, and `resources` for
 * telling a handed-off row from an abandoned one; the rest of an `Agent` is not
 * this module's business, which is why `RollbackDeps` asks for `get` alone.
 */
function rowOwnedBy(owner: string | null, handedOff = false): Agent {
  return {
    name: NAME,
    status: "creating",
    lock: owner === null ? null : { owner, expires: "2999-01-01T00:00:00.000Z" },
    resources: handedOff
      ? { ssm_paths: ["/hermes/atlas/ts-key"], config_key: "config/atlas/abc.tgz" }
      : { ssm_paths: [] },
  } as unknown as Agent;
}

interface Fake {
  instances: Map<string, InstanceRef>;
  /**
   * The `agent`/`role=data` tags each volume carries, for the adopted-volume
   * restore. Kept beside `volumes` rather than inside it because the attach
   * waiter reads the narrow `VolumeStatus` and this is the inventory half.
   */
  tags: Map<string, { agent: string | null; role_data: boolean }>;
  /** The agent rows the ownership check reads. */
  rows: Map<string, Agent>;
  volumes: Map<string, VolumeStatus>;
  /** Destructive calls only — the "did it touch anything" ledger. */
  calls: string[];
  /** Lock re-takes, kept apart from `calls`: taking a lock destroys nothing. */
  reclaims: string[];
  deletedRows: string[];
  events: Array<{ name: string; action: string; detail?: string }>;
  /** Prefixes the fakes pretend to hold, so the counts in events are real. */
  params: string[];
  objects: string[];
  /** Step name → the error that step should throw once it is reached. */
  breaks: Map<string, Error>;
  /** Fired on each `describeVolume`, so a test can abort mid-wait. */
  onDescribeVolume: (() => void) | null;
}

function world(): Fake {
  return {
    instances: new Map(),
    tags: new Map(),
    rows: new Map([[NAME, rowOwnedBy(OWNER)]]),
    volumes: new Map(),
    calls: [],
    reclaims: [],
    deletedRows: [],
    events: [],
    params: [],
    objects: [],
    breaks: new Map(),
    onDescribeVolume: null,
  };
}

function boom(w: Fake, step: string) {
  const e = w.breaks.get(step);
  if (e) throw e;
}

function depsOf(w: Fake): RollbackDeps {
  const compute = {
    describeInstance: async (id: string): Promise<InstanceRef | null> => w.instances.get(id) ?? null,
    describeVolume: async (id: string): Promise<VolumeStatus | null> => {
      w.onDescribeVolume?.();
      return w.volumes.get(id) ?? null;
    },
    terminate: async (id: string): Promise<void> => {
      boom(w, "terminate");
      w.calls.push(`terminate:${id}`);
      const inst = w.instances.get(id);
      if (inst) w.instances.set(id, { ...inst, state: "terminated" });
      for (const [vid, vol] of w.volumes) {
        if (vol.attachments.some((a) => a.instance_id === id)) {
          w.volumes.set(vid, { ...vol, state: "available", attachments: [] });
        }
      }
    },
    deleteVolume: async (id: string): Promise<void> => {
      boom(w, "deleteVolume");
      w.calls.push(`deleteVolume:${id}`);
      w.volumes.delete(id);
    },
    listVolumes: async (): Promise<VolumeDetail[]> =>
      [...w.volumes.values()].map((v) => {
        const tag = w.tags.get(v.volume_id) ?? { agent: null, role_data: false };
        return {
          ...v,
          availability_zone: "us-west-2a",
          created_at: null,
          agent: tag.agent,
          former_agent: null,
          managed: true,
          role_data: tag.role_data,
          tags: {},
        };
      }),
    retagVolume: async (
      id: string,
      agent: string | null,
      opts: { roleData?: boolean; name?: string | null } = {},
    ): Promise<void> => {
      boom(w, "retagVolume");
      const roleData = opts.roleData ?? true;
      w.calls.push(
        `retag:${id}:${agent ?? "(none)"}:${roleData ? "data" : "no-role"}:${opts.name === undefined ? "(derived)" : (opts.name ?? "(none)")}`,
      );
      w.tags.set(id, { agent, role_data: roleData });
    },
  };
  return {
    compute,
    secrets: {
      deleteByPrefix: async (prefix: string): Promise<string[]> => {
        boom(w, "secrets");
        w.calls.push(`secrets:${prefix}`);
        const hits = w.params.filter((p) => p.startsWith(prefix));
        w.params = w.params.filter((p) => !p.startsWith(prefix));
        return hits;
      },
    },
    artifacts: {
      deleteByPrefix: async (prefix: string): Promise<string[]> => {
        boom(w, "config");
        w.calls.push(`config:${prefix}`);
        const hits = w.objects.filter((k) => k.startsWith(prefix));
        w.objects = w.objects.filter((k) => !k.startsWith(prefix));
        return hits;
      },
    },
    store: {
      agents: {
        get: async (name: string): Promise<Agent | null> => {
          boom(w, "get");
          return w.rows.get(name) ?? null;
        },
        delete: async (name: string): Promise<void> => {
          boom(w, "row");
          w.calls.push(`row:${name}`);
          w.deletedRows.push(name);
        },
      },
    },
    reclaim: async (latest) => {
      boom(w, "reclaim");
      w.reclaims.push(latest.name);
      return latest;
    },
    attachDeps: () => ({
      compute: {
        ...compute,
        // Part of `AttachDeps`, but a rollback only ever waits for a detach:
        // an attach from here would be putting the disk back on.
        attachVolume: async (): Promise<void> => {
          throw new HermeticError("INTERNAL", "a rollback never attaches", {});
        },
      },
      pollMs: 0,
      progressMs: 0,
    }),
    heartbeat: async () => {
      // The renewal the detach wait makes on every poll. A `boom` here is a
      // lock this run could not hold on to, which is not the same thing as a
      // step that failed.
      boom(w, "heartbeat");
      w.calls.push("heartbeat");
    },
    evt: (phase, progress, message, at, level, kind): OpEvent => ({
      phase,
      progress,
      message,
      at,
      ...(level ? { level } : {}),
      ...(kind ? { kind } : {}),
    }),
    nowIso: () => "2026-09-03T00:00:00.000Z",
    appendEvent: async (name: string, action: string, detail?: string) => {
      boom(w, "events");
      w.events.push({ name, action, ...(detail === undefined ? {} : { detail }) });
    },
    agentPrefix: (name: string) => `/hermes/${name}/`,
    configPrefix: (name: string) => `config/${name}/`,
  };
}

async function run(
  w: Fake,
  ledger: CreateLedger,
  opts: { progress?: number; name?: string; owner?: string; signal?: AbortSignal } = {},
): Promise<{ events: OpEvent[]; outcome: Awaited<ReturnType<typeof drainOutcome>> }> {
  const events: OpEvent[] = [];
  const outcome = await drainOutcome(
    rollbackCreate(depsOf(w), opts.name ?? NAME, ledger, opts.owner ?? OWNER, opts.progress ?? 0.8, {
      ...(opts.signal ? { signal: opts.signal } : {}),
    }),
    events,
  );
  return { events, outcome };
}

async function drainOutcome(gen: AsyncGenerator<OpEvent, RollbackOutcome>, into: OpEvent[]) {
  for (;;) {
    const next = await gen.next();
    if (next.done) return next.value;
    into.push(next.value);
  }
}

const FULL: CreateLedger = { claimed: true, volumeId: "vol-1", instanceId: "i-1", retag: null };

/** `FULL`, plus the `--volume` adoption whose tag rewrite has to be put back. */
const ADOPTED: CreateLedger = {
  ...FULL,
  retag: { volumeId: "vol-2", agent: "bravo", roleData: true, name: null },
};

function running(id = "i-1"): InstanceRef {
  return { instance_id: id, state: "running", public_ip: "203.0.113.10" };
}

function heldVolume(id = "vol-1", by = "i-1"): VolumeStatus {
  return {
    volume_id: id,
    size_gib: 100,
    state: "in-use",
    attachments: [{ instance_id: by, state: "attached" }],
  };
}

describe("rollbackCreate", () => {
  test("a ledger that made nothing touches nothing and says so once", async () => {
    const w = world();
    const { events, outcome } = await run(w, {
      claimed: false,
      volumeId: null,
      instanceId: null,
      retag: null,
    });

    expect(w.calls).toEqual([]);
    // Nothing to undo means no reclaim either: the empty-ledger check runs
    // before the ownership gate, so a rollback with nothing to do takes no
    // lock write and bumps no version.
    expect(w.reclaims).toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0]?.message).toContain("created nothing");
    expect(outcome).toEqual({ complete: true, undone: [], failed: [], ownership_lost: false });
  });

  /**
   * The gate. `create`'s handoff commits the row with `lock: null` and *then*
   * writes its history line: a throw on that write lands in the catch with a
   * full ledger, and without this check a throttled events table would destroy
   * a finished agent.
   */
  test("a row that has been handed off is not this run's, and is not touched", async () => {
    const w = world();
    // Unlocked *and* fully provisioned: the create succeeded and something
    // after the handoff threw.
    w.rows.set(NAME, rowOwnedBy(null, true));
    w.instances.set("i-1", running());
    w.volumes.set("vol-1", heldVolume());

    const { events, outcome } = await run(w, FULL);

    expect(w.calls).toEqual([]);
    expect(w.reclaims).toEqual([]);
    expect(w.deletedRows).toEqual([]);
    expect(outcome).toEqual({
      complete: false,
      undone: [],
      failed: ["ownership"],
      ownership_lost: true,
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.level).toBe("warn");
    expect(events[0]?.message).toContain("finished provisioning before this failure");
  });

  test("an unlocked row that never finished is not this run's either", async () => {
    const w = world();
    w.rows.set(NAME, rowOwnedBy(null));

    const { events, outcome } = await run(w, FULL);

    expect(w.calls).toEqual([]);
    expect(outcome.failed).toEqual(["ownership"]);
    expect(events[0]?.message).toContain("no longer locked by this run");
  });

  /**
   * The half that actually holds. A read proves only what was true a moment
   * ago, and nothing renews the lock between it and the unconditional deletes;
   * `reclaim` is version-conditional, so a row that changed hands in that gap
   * says so here rather than being deleted.
   */
  test("a reclaim that loses the version race stops the unwind", async () => {
    const w = world();
    w.instances.set("i-1", running());
    w.volumes.set("vol-1", heldVolume());
    w.params = ["/hermes/atlas/ts-key"];
    w.objects = ["config/atlas/abc.tgz"];
    w.breaks.set("reclaim", new HermeticError("CONFLICT", "version moved", {}));

    const { events, outcome } = await run(w, FULL);

    expect(w.calls).toEqual([]);
    expect(w.deletedRows).toEqual([]);
    expect(w.params).toEqual(["/hermes/atlas/ts-key"]);
    expect(w.objects).toEqual(["config/atlas/abc.tgz"]);
    expect(outcome).toEqual({
      complete: false,
      undone: [],
      failed: ["ownership"],
      ownership_lost: true,
    });
    expect(events[0]?.message).toContain("could not confirm");
  });

  test("a reclaim that succeeds is what lets the unwind proceed", async () => {
    const w = world();

    const { outcome } = await run(w, { claimed: true, volumeId: null, instanceId: null, retag: null });

    // Once at the gate and once before each of the three steps this ledger
    // reaches — config, secrets, row. Ownership is re-proved at every step
    // boundary, not assumed to hold for the length of the unwind.
    expect(w.reclaims).toEqual([NAME, NAME, NAME, NAME]);
    expect(outcome.complete).toBe(true);
    expect(outcome.ownership_lost).toBe(false);
  });

  test("a row another operator has taken over is not touched either", async () => {
    const w = world();
    // A stalled run loses its lock silently — `renewLock` returns rather than
    // throwing — so the row simply belongs to somebody else by now.
    w.rows.set(NAME, rowOwnedBy("arn:aws:iam::123456789012:user/other#run-2"));
    w.instances.set("i-1", running());
    w.volumes.set("vol-1", heldVolume());
    w.params = ["/hermes/atlas/ts-key"];

    const { outcome } = await run(w, FULL);

    expect(w.calls).toEqual([]);
    expect(w.params).toEqual(["/hermes/atlas/ts-key"]);
    expect(outcome.failed).toEqual(["ownership"]);
  });

  test("a row that is already gone is not this run's", async () => {
    const w = world();
    w.rows.delete(NAME);

    const { outcome } = await run(w, FULL);

    expect(w.calls).toEqual([]);
    expect(outcome.failed).toEqual(["ownership"]);
  });

  test("a read that fails is not permission to delete", async () => {
    const w = world();
    w.breaks.set("get", new HermeticError("INTERNAL", "Scan throttled", {}));

    const { outcome } = await run(w, FULL);

    expect(w.calls).toEqual([]);
    expect(outcome.failed).toEqual(["ownership"]);
  });

  /**
   * The gap the ownership gate alone never covered. The detach wait is
   * unbounded, and the only thing holding the row through it is the heartbeat:
   * a renewal that fails means the TTL lapsed and somebody else's `create` or
   * `destroy` may already have the row. Before this, that arrived as an
   * ordinary step failure — "rollback step volume failed (CONFLICT); continuing
   * with the rest" — and the unwind went on to retag the volume and delete the
   * config and the SSM slots the *new* owner needs.
   */
  test("a lock lost inside the detach wait ends the unwind where it stands", async () => {
    const w = world();
    w.instances.set("i-1", running());
    w.volumes.set("vol-1", heldVolume());
    w.volumes.set("vol-2", { ...heldVolume("vol-2", "i-1"), state: "available", attachments: [] });
    w.tags.set("vol-2", { agent: NAME, role_data: true });
    w.params = ["/hermes/atlas/ts-key", "/hermes/atlas/provider-key"];
    w.objects = ["config/atlas/abc.tgz"];
    w.breaks.set("heartbeat", new HermeticError("CONFLICT", "renewLock lost the version race", {}));

    const { events, outcome } = await run(w, ADOPTED);

    // The terminate happened while the lock was still this run's. Nothing after
    // it did.
    expect(w.calls).toEqual(["terminate:i-1"]);
    expect(w.tags.get("vol-2")).toEqual({ agent: NAME, role_data: true });
    expect(w.params).toEqual(["/hermes/atlas/ts-key", "/hermes/atlas/provider-key"]);
    expect(w.objects).toEqual(["config/atlas/abc.tgz"]);
    expect(w.deletedRows).toEqual([]);

    expect(outcome.ownership_lost).toBe(true);
    expect(outcome.complete).toBe(false);
    expect(outcome.failed).toContain("ownership");
    // Not a step failure: the volume step is not blamed for a lock it could not
    // renew.
    expect(outcome.failed).not.toContain("volume");

    const stop = events.at(-1);
    expect(stop?.level).toBe("warn");
    expect(stop?.message).toContain("rollback stopped before the volume tag restore step");
    expect(stop?.message).toContain("could not be renewed");
    expect(stop?.message).toContain("(CONFLICT)");
  });

  /**
   * The same loss arriving between two steps rather than inside one: the
   * instance is terminated and the volume deleted, and by the time the config
   * prefix is next another operator holds the row. Every step boundary re-reads
   * the row for exactly this.
   */
  test("a takeover between the volume step and the config step stops the unwind", async () => {
    const w = world();
    w.instances.set("i-1", running());
    w.volumes.set("vol-1", heldVolume());
    w.params = ["/hermes/atlas/ts-key"];
    w.objects = ["config/atlas/abc.tgz"];
    // Fired from inside the detach wait, so the row has changed hands by the
    // time the volume step returns.
    w.onDescribeVolume = () => {
      w.rows.set(NAME, rowOwnedBy(OTHER));
    };

    const { events, outcome } = await run(w, FULL);

    expect(w.calls.filter((c) => c !== "heartbeat")).toEqual(["terminate:i-1", "deleteVolume:vol-1"]);
    expect(w.params).toEqual(["/hermes/atlas/ts-key"]);
    expect(w.objects).toEqual(["config/atlas/abc.tgz"]);
    expect(w.deletedRows).toEqual([]);

    expect(outcome.ownership_lost).toBe(true);
    expect(outcome.complete).toBe(false);
    expect(outcome.failed).toContain("ownership");

    const stop = events.at(-1);
    expect(stop?.message).toContain("rollback stopped before the config delete step");
    // Named, so the operator knows whose run to ask about (§8.3: an identity,
    // not a secret).
    expect(stop?.message).toContain(OTHER);
  });

  /**
   * The lock this run let lapse is not the lock it holds. Nobody has taken the
   * row yet in this one — the read still names this owner — and the unwind
   * refuses anyway, because an expired lock is one any other operator may take
   * between the read and the delete.
   */
  test("an expired lock is not ownership, even when nobody has taken it", async () => {
    const w = world();
    w.rows.set(NAME, {
      ...rowOwnedBy(OWNER),
      lock: { owner: OWNER, expires: "2020-01-01T00:00:00.000Z" },
    } as Agent);
    w.instances.set("i-1", running());
    w.volumes.set("vol-1", heldVolume());

    const { events, outcome } = await run(w, FULL);

    expect(w.calls).toEqual([]);
    expect(w.reclaims).toEqual([]);
    expect(outcome.ownership_lost).toBe(true);
    expect(events[0]?.message).toContain("expired at 2020-01-01T00:00:00.000Z");
  });

  test("a fresh claim unwinds instance, volume, config, secrets and row in that order", async () => {
    const w = world();
    w.instances.set("i-1", running());
    w.volumes.set("vol-1", heldVolume());
    w.params = ["/hermes/atlas/ts-key", "/hermes/atlas/provider-key"];
    w.objects = ["config/atlas/abc.tgz"];

    const { events, outcome } = await run(w, FULL);

    expect(w.calls.filter((c) => c !== "heartbeat")).toEqual([
      "terminate:i-1",
      "deleteVolume:vol-1",
      "config:config/atlas/",
      "secrets:/hermes/atlas/",
      "row:atlas",
    ]);
    expect(outcome.complete).toBe(true);
    expect(outcome.ownership_lost).toBe(false);
    expect(outcome.undone).toEqual(["instance", "volume", "config", "secrets", "row"]);
    expect(w.deletedRows).toEqual(["atlas"]);
    // One at the gate, then one before each of the three steps that remove
    // something a newer owner would need: config, secrets, row.
    expect(w.reclaims).toHaveLength(4);
    // The row's own history keeps the fact that it was unwound (§6.6).
    expect(w.events).toEqual([
      { name: "atlas", action: "rollback", detail: "row deleted; nothing this create made remains" },
    ]);

    const text = JSON.stringify(events);
    expect(text).toContain("removed 2 SSM parameter(s)");
    expect(text).toContain("removed 1 config object(s)");
    expect(events.every((e) => e.phase === "rollback")).toBe(true);
    expect(events.every((e) => e.progress === 0.8)).toBe(true);
  });

  test("the volume step waits for the terminate's detach before deleting", async () => {
    const w = world();
    w.instances.set("i-1", running());
    // Still attached to a dying instance: the ordinary case a bare DeleteVolume
    // is refused in. `terminate` above frees it, so this settles on the first
    // poll — the point is that the delete comes after the wait.
    w.volumes.set("vol-1", heldVolume());

    const { outcome } = await run(w, FULL);

    expect(outcome.failed).toEqual([]);
    expect(w.volumes.has("vol-1")).toBe(false);
  });

  test("an instance that is already gone is not terminated again", async () => {
    const w = world();
    w.instances.set("i-1", { instance_id: "i-1", state: "terminated", public_ip: null });
    w.volumes.set("vol-1", { ...heldVolume(), state: "available", attachments: [] });

    const { events, outcome } = await run(w, FULL);

    expect(w.calls).not.toContain("terminate:i-1");
    // Nothing was undone: the box was already on its way out before we looked.
    expect(outcome.undone).not.toContain("instance");
    expect(outcome.failed).toEqual([]);
    expect(JSON.stringify(events)).toContain("already terminated");
  });

  test("a resumed run keeps the row, the secrets and the config it did not make", async () => {
    const w = world();
    w.instances.set("i-9", running("i-9"));
    w.params = ["/hermes/atlas/provider-key"];
    w.objects = ["config/atlas/abc.tgz"];

    const { events, outcome } = await run(w, {
      claimed: false,
      volumeId: null,
      instanceId: "i-9",
      retag: null,
    });

    expect(w.calls.filter((c) => c !== "heartbeat")).toEqual(["terminate:i-9"]);
    expect(w.deletedRows).toEqual([]);
    expect(w.params).toEqual(["/hermes/atlas/provider-key"]);
    expect(w.objects).toEqual(["config/atlas/abc.tgz"]);
    expect(outcome.complete).toBe(true);
    expect(JSON.stringify(events)).toContain("resumed it rather than creating it");
  });

  test("a step that throws is named by code, the rest still run, and the row survives", async () => {
    const w = world();
    w.instances.set("i-1", running());
    w.volumes.set("vol-1", heldVolume());
    w.params = ["/hermes/atlas/ts-key"];
    w.breaks.set("deleteVolume", new HermeticError("CONFLICT", "DeleteVolume refused", {}));

    const { events, outcome } = await run(w, FULL);

    expect(outcome.complete).toBe(false);
    expect(outcome.failed).toEqual(["volume"]);
    // A step that failed is not a lock that was lost — the same `CONFLICT` code
    // means different things from the store and from EC2, and only the first
    // one ends the unwind.
    expect(outcome.ownership_lost).toBe(false);
    // Config and secrets still ran; the row did not.
    expect(outcome.undone).toEqual(["instance", "config", "secrets"]);
    expect(w.deletedRows).toEqual([]);

    const warn = events.find((e) => e.message.includes("rollback step volume failed"));
    expect(warn?.level).toBe("warn");
    expect(warn?.message).toContain("(CONFLICT)");
    // The code, never the free text of the error (§8.3).
    expect(JSON.stringify(events)).not.toContain("DeleteVolume refused");
    expect(JSON.stringify(events)).toContain("hermetic agent destroy atlas --yes");
  });

  test("an unclassified throw is reported as INTERNAL, not as its message", async () => {
    const w = world();
    w.instances.set("i-1", running());
    // A bare `Error`, not a `HermeticError`: the fallback branch of `codeOf`.
    w.breaks.set("terminate", new Error("boom"));

    const { events } = await run(w, { claimed: true, volumeId: null, instanceId: "i-1", retag: null });

    expect(JSON.stringify(events)).toContain("rollback step instance failed (INTERNAL)");
    expect(JSON.stringify(events)).not.toContain("boom");
  });

  test("a row delete that fails leaves the outcome incomplete rather than throwing", async () => {
    const w = world();
    w.breaks.set("row", new HermeticError("CONFLICT", "row moved", {}));

    const { events, outcome } = await run(w, {
      claimed: true,
      volumeId: null,
      instanceId: null,
      retag: null,
    });

    expect(outcome.complete).toBe(false);
    expect(outcome.failed).toEqual(["row"]);
    expect(JSON.stringify(events)).toContain("rollback step row failed (CONFLICT)");
  });

  /**
   * The unwind's own exit, and its limit. `create` never starts a rollback from
   * an abort, so this is the operator stopping one that is already running —
   * which has to be possible, because the detach wait is unbounded and an
   * instance stuck in `shutting-down` would otherwise trap it forever. Stopping
   * ends the *unwind*, not just the step: going on to delete the agent's SSM
   * slots after the operator pressed stop would be the opposite of what was
   * asked.
   */
  test("an abort during the volume step ends the whole unwind, not just the step", async () => {
    const w = world();
    w.instances.set("i-1", running());
    // The disk is held by a *different* instance that never finishes dying, so
    // the wait would never end on its own.
    w.instances.set("i-2", { instance_id: "i-2", state: "shutting-down", public_ip: null });
    w.volumes.set("vol-1", heldVolume("vol-1", "i-2"));
    w.params = ["/hermes/atlas/ts-key", "/hermes/atlas/provider-key"];
    w.objects = ["config/atlas/abc.tgz"];
    const controller = new AbortController();
    // Stop pressed once the detach wait is already polling.
    w.onDescribeVolume = () => controller.abort();

    const { events, outcome } = await run(w, FULL, { signal: controller.signal });

    expect(outcome.complete).toBe(false);
    expect(outcome.failed).toContain("volume");
    expect(outcome.failed).toContain("interrupted");
    // The step before the wait had already finished…
    expect(w.calls).toContain("terminate:i-1");
    // …but nothing after the interrupted step ran.
    expect(outcome.undone).not.toContain("config");
    expect(outcome.undone).not.toContain("secrets");
    expect(w.params).toEqual(["/hermes/atlas/ts-key", "/hermes/atlas/provider-key"]);
    expect(w.objects).toEqual(["config/atlas/abc.tgz"]);
    expect(w.deletedRows).toEqual([]);
    expect(JSON.stringify(events)).toContain("rollback step volume failed (ABORTED)");
    expect(JSON.stringify(events)).toContain("rollback interrupted");
  });

  test("an abort before the first step does nothing at all", async () => {
    const w = world();
    w.instances.set("i-1", running());
    w.volumes.set("vol-1", heldVolume());
    w.params = ["/hermes/atlas/ts-key"];
    const controller = new AbortController();
    controller.abort();

    const { events, outcome } = await run(w, FULL, { signal: controller.signal });

    expect(w.calls).toEqual([]);
    expect(w.params).toEqual(["/hermes/atlas/ts-key"]);
    expect(outcome).toEqual({
      complete: false,
      undone: [],
      failed: ["interrupted"],
      ownership_lost: false,
    });
    expect(events.at(-1)?.message).toContain("rollback interrupted");
  });

  test("a history write that fails does not turn a deleted row into a failed step", async () => {
    const w = world();
    w.breaks.set("events", new HermeticError("INTERNAL", "PutItem throttled", {}));

    const { events, outcome } = await run(w, {
      claimed: true,
      volumeId: null,
      instanceId: null,
      retag: null,
    });

    // The row is gone, so the operator must not be told to go and destroy it.
    expect(w.deletedRows).toEqual([NAME]);
    expect(outcome.complete).toBe(true);
    expect(outcome.undone).toContain("row");
    expect(outcome.failed).toEqual([]);
    expect(JSON.stringify(events)).not.toContain("rollback step row failed");
  });

  /**
   * The adopted-volume half of "only what this run changed". The volume was
   * never this run's to delete — it holds an earlier agent's memory — but the
   * `agent` tag pointing at this run's name *is* this run's doing, and a
   * `create bravo --volume vol-X` that failed used to leave `vol-X` tagged
   * `agent=bravo` with no bravo anywhere, so the next `create bravo` silently
   * inherited somebody else's disk.
   */
  test("an adopted volume's agent tag is put back, and the volume itself is untouched", async () => {
    const w = world();
    w.volumes.set("vol-x", { volume_id: "vol-x", size_gib: 100, state: "available", attachments: [] });
    w.tags.set("vol-x", { agent: NAME, role_data: true });

    const { outcome } = await run(w, {
      claimed: true,
      volumeId: null,
      instanceId: null,
      retag: { volumeId: "vol-x", agent: "oriole", roleData: false, name: null },
    });

    expect(w.tags.get("vol-x")).toEqual({ agent: "oriole", role_data: false });
    expect(outcome.undone).toContain("volume_tag");
    // The disk itself is somebody's memory and is never deleted here.
    expect(w.calls.some((c) => c.startsWith("deleteVolume"))).toBe(false);
    expect(w.volumes.has("vol-x")).toBe(true);
  });

  test("a volume with no agent tag before the adoption goes back to having none", async () => {
    const w = world();
    w.volumes.set("vol-x", { volume_id: "vol-x", size_gib: 100, state: "available", attachments: [] });
    w.tags.set("vol-x", { agent: NAME, role_data: true });

    await run(w, {
      claimed: true,
      volumeId: null,
      instanceId: null,
      retag: { volumeId: "vol-x", agent: null, roleData: false, name: null },
    });

    expect(w.tags.get("vol-x")).toEqual({ agent: null, role_data: false });
  });

  test("a tag that now names somebody else is left exactly as it is", async () => {
    const w = world();
    w.volumes.set("vol-x", { volume_id: "vol-x", size_gib: 100, state: "available", attachments: [] });
    // A third party retagged it after this run did: their decision is the
    // later one, and putting our predecessor's name back would be a guess (§1).
    w.tags.set("vol-x", { agent: "somebody-else", role_data: true });

    const { events, outcome } = await run(w, {
      claimed: true,
      volumeId: null,
      instanceId: null,
      retag: { volumeId: "vol-x", agent: "oriole", roleData: true, name: null },
    });

    expect(w.tags.get("vol-x")).toEqual({ agent: "somebody-else", role_data: true });
    expect(outcome.undone).not.toContain("volume_tag");
    expect(JSON.stringify(events)).toContain("leaving it as it is");
  });

  test("a retag that fails is a named step, and the rest of the unwind still runs", async () => {
    const w = world();
    w.volumes.set("vol-x", { volume_id: "vol-x", size_gib: 100, state: "available", attachments: [] });
    w.tags.set("vol-x", { agent: NAME, role_data: true });
    w.params = ["/hermes/atlas/ts-key"];
    w.breaks.set("retagVolume", new HermeticError("INTERNAL", "CreateTags throttled", {}));

    const { events, outcome } = await run(w, {
      claimed: true,
      volumeId: null,
      instanceId: null,
      retag: { volumeId: "vol-x", agent: "oriole", roleData: true, name: null },
    });

    expect(outcome.failed).toContain("volume_tag");
    expect(outcome.complete).toBe(false);
    // The row survives an incomplete unwind: it is the only thing left naming
    // what is still out there.
    expect(w.deletedRows).toEqual([]);
    expect(w.params).toEqual([]);
    expect(JSON.stringify(events)).toContain("rollback step volume_tag failed (INTERNAL)");
  });

  test("the detach wait renews the lock while it waits", async () => {
    const w = world();
    w.volumes.set("vol-1", { ...heldVolume(), state: "available", attachments: [] });

    await run(w, { claimed: false, volumeId: "vol-1", instanceId: null, retag: null });

    expect(w.calls).toContain("heartbeat");
  });
});
