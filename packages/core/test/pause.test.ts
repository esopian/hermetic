import { describe, expect, test } from "bun:test";
import { HermeticError } from "../src/errors.ts";
import { FIXTURE_CONFIG, MemoryBackend, seedFixtureFleet } from "../src/backend/memory.ts";
import type { AgentStatus } from "../src/schema/index.ts";
import { drain, testHermetic } from "./helpers.ts";

function seeded() {
  const backend = seedFixtureFleet(new MemoryBackend());
  return { backend, hermetic: testHermetic({ backend, config: FIXTURE_CONFIG }) };
}

/** Put a row in `status` as an op that died partway would have left it. */
function park(backend: MemoryBackend, name: string, status: AgentStatus): void {
  const row = backend.agents.get(name)!;
  backend.agents.set(name, { ...row, status, version: row.version + 1 });
}

async function transitionsOf(backend: MemoryBackend, name: string): Promise<string[]> {
  return (await backend.store.events.query(name))
    .filter((e) => e.action === "transition")
    .map((e) => `${e.from_status}>${e.to_status}`);
}

describe("agents.pause / resume", () => {
  test("pause halts Hermes, stops the box and lands paused with paused_at", async () => {
    const { backend, hermetic } = seeded();
    const events = await drain(hermetic.agents.pause("atlas"));

    const agent = (await backend.store.agents.get("atlas"))!;
    expect(agent.status).toBe("paused");
    expect(agent.paused_at).toBeString();
    expect(agent.last_heartbeat ?? null).toBeNull();
    expect(agent.tailscale_ip ?? null).toBeNull();
    expect(agent.lock).toBeNull();
    expect(backend.instances.get(agent.resources.instance_id!)!.state).toBe("stopped");
    expect(events.some((e) => e.phase === "halt" && e.message.startsWith("halted "))).toBe(true);
    expect(events.at(-1)!.message).toBe("atlas paused; the data volume is untouched");
    expect(await transitionsOf(backend, "atlas")).toContain("pausing>paused");
  });

  test("a halt that fails is a warning, and the box is stopped anyway", async () => {
    const { backend, hermetic } = seeded();
    backend.rpc.powerHalt = async () => {
      throw new HermeticError("INTERNAL", "hermeticd on atlas did not answer");
    };
    const events = await drain(hermetic.agents.pause("atlas"));

    const warned = events.find((e) => e.phase === "halt" && e.level === "warn");
    expect(warned?.message).toContain("not halted cleanly");
    expect(backend.mutations).toContain("compute.stop");
    expect((await backend.store.agents.get("atlas"))!.status).toBe("paused");
  });

  test("pause re-enters a row left in pausing", async () => {
    const { backend, hermetic } = seeded();
    park(backend, "atlas", "pausing");
    await drain(hermetic.agents.pause("atlas"));
    expect((await backend.store.agents.get("atlas"))!.status).toBe("paused");
    expect(await transitionsOf(backend, "atlas")).toEqual(
      expect.not.arrayContaining(["pausing>pausing"]),
    );
  });

  test("resume clears paused_at and hands the row to the box at bootstrapping", async () => {
    const { backend, hermetic } = seeded();
    expect((await backend.store.agents.get("marrow"))!.paused_at).toBeString();
    const events = await drain(hermetic.agents.resume("marrow"));

    const agent = (await backend.store.agents.get("marrow"))!;
    expect(agent.status).toBe("bootstrapping");
    expect(agent.paused_at ?? null).toBeNull();
    expect(agent.lock).toBeNull();
    expect(events.at(-1)!.message).toBe("marrow resuming; hermeticd will report when it is ready");
    const moves = await transitionsOf(backend, "marrow");
    expect(moves).toContain("paused>resuming");
    expect(moves).toContain("resuming>bootstrapping");
  });

  test("resume re-enters a row left in resuming", async () => {
    const { backend, hermetic } = seeded();
    park(backend, "marrow", "resuming");
    await drain(hermetic.agents.resume("marrow"));
    expect((await backend.store.agents.get("marrow"))!.status).toBe("bootstrapping");
  });

  test("start and stop refuse a paused agent and name resume; resume refuses a stopped one", async () => {
    const { hermetic } = seeded();
    await expect(drain(hermetic.agents.start("marrow"))).rejects.toThrow(/agent resume marrow/);
    await expect(drain(hermetic.agents.stop("marrow"))).rejects.toThrow(/agent resume marrow/);
    await expect(drain(hermetic.agents.resume("juniper"))).rejects.toThrow(/agent start juniper/);
  });

  test("stop takes a row stuck in pausing through stopping, without a halt", async () => {
    const { backend, hermetic } = seeded();
    park(backend, "atlas", "pausing");
    const events = await drain(hermetic.agents.stop("atlas"));
    expect((await backend.store.agents.get("atlas"))!.status).toBe("stopped");
    expect(events.some((e) => e.phase === "halt")).toBe(false);
    expect(await transitionsOf(backend, "atlas")).toContain("pausing>stopping");
  });

  test("an abort during the halt leaves the row pausing and unlocked, and pause or stop finishes it", async () => {
    const { backend, hermetic } = seeded();
    const controller = new AbortController();
    // A halt that honours the signal, as the real RPC does, and never answers otherwise.
    backend.rpc.powerHalt = (_name: string, opts: { signal?: AbortSignal } = {}) =>
      new Promise((_resolve, reject) => {
        const fail = () => reject(new Error("aborted"));
        if (opts.signal?.aborted) fail();
        opts.signal?.addEventListener("abort", fail, { once: true });
      });

    let code: string | null = null;
    try {
      for await (const e of hermetic.agents.pause("atlas", { signal: controller.signal })) {
        if (e.phase === "halt") controller.abort();
      }
    } catch (e) {
      code = (e as HermeticError).code;
    }
    expect(code).toBe("ABORTED");
    expect(backend.mutations).not.toContain("compute.stop");
    const after = (await backend.store.agents.get("atlas"))!;
    expect(after.status).toBe("pausing");
    expect(after.lock).toBeNull();

    backend.rpc.powerHalt = async () => ({ halted: ["hermes-gateway.service"] });
    await drain(hermetic.agents.pause("atlas"));
    expect((await backend.store.agents.get("atlas"))!.status).toBe("paused");
  });

  test("an abort that lands as the halt succeeds still stops short of StopInstances", async () => {
    const { backend, hermetic } = seeded();
    const controller = new AbortController();
    backend.rpc.powerHalt = async () => {
      controller.abort();
      return { halted: ["hermes-gateway.service", "hermes-dashboard.service"] };
    };
    await expect(drain(hermetic.agents.pause("atlas", { signal: controller.signal }))).rejects.toThrow(
      /aborted during pause/,
    );
    expect(backend.mutations).not.toContain("compute.stop");
    const after = (await backend.store.agents.get("atlas"))!;
    expect(after.status).toBe("pausing");
    expect(after.lock).toBeNull();
  });

  test("an abort during the halt can be finished by stop instead", async () => {
    const { backend, hermetic } = seeded();
    const controller = new AbortController();
    backend.rpc.powerHalt = (_name: string, opts: { signal?: AbortSignal } = {}) =>
      new Promise((_resolve, reject) => {
        if (opts.signal?.aborted) reject(new Error("aborted"));
        opts.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    await expect(
      (async () => {
        for await (const e of hermetic.agents.pause("atlas", { signal: controller.signal })) {
          if (e.phase === "halt") controller.abort();
        }
      })(),
    ).rejects.toThrow(/aborted/);
    await drain(hermetic.agents.stop("atlas"));
    expect((await backend.store.agents.get("atlas"))!.status).toBe("stopped");
  });

  test("an abort while EC2 is stopping leaves the row pausing, and a second pause finishes", async () => {
    const { backend, hermetic } = seeded();
    const controller = new AbortController();
    let polls = 0;
    backend.compute.describeInstance = async (id: string) => {
      polls += 1;
      return { instance_id: id, state: polls === 1 ? "running" : "stopping", public_ip: null };
    };

    let err: HermeticError | null = null;
    try {
      for await (const e of hermetic.agents.pause("atlas", { signal: controller.signal })) {
        if (e.message.startsWith("waiting for")) controller.abort();
      }
    } catch (e) {
      err = e as HermeticError;
    }
    expect(err?.code).toBe("ABORTED");
    expect(err?.message).toBe("operation aborted during pause");
    expect(backend.mutations).toContain("compute.stop");
    const after = (await backend.store.agents.get("atlas"))!;
    expect(after.status).toBe("pausing");
    expect(after.lock).toBeNull();
    expect(after.paused_at ?? null).toBeNull();

    backend.compute.describeInstance = async (id: string) => ({
      instance_id: id,
      state: "stopped",
      public_ip: null,
    });
    await drain(hermetic.agents.pause("atlas"));
    const done = (await backend.store.agents.get("atlas"))!;
    expect(done.status).toBe("paused");
    expect(done.paused_at).toBeString();
  });

  test("reboot refuses paused; pause refuses stopped and error; resume refuses ready", async () => {
    const { backend, hermetic } = seeded();
    await expect(hermetic.agents.reboot({ name: "marrow" })).rejects.toThrow(
      /marrow is paused; use `hermetic agent resume marrow`/,
    );
    await expect(drain(hermetic.agents.pause("juniper"))).rejects.toThrow(
      /juniper is stopped; .*already off \(`hermetic agent start juniper`/,
    );
    park(backend, "atlas", "error");
    await expect(drain(hermetic.agents.pause("atlas"))).rejects.toThrow(
      /atlas is error; only a ready or degraded/,
    );
    await expect(drain(hermetic.agents.resume("granite"))).rejects.toThrow(
      /granite is ready; only a paused agent can be resumed/,
    );
  });

  test("a paused agent can be destroyed, and its volume deleted", async () => {
    const { backend, hermetic } = seeded();
    const volumeId = (await backend.store.agents.get("marrow"))!.resources.volume_id!;
    const plan = await hermetic.plan.destroy({ name: "marrow" });
    expect(plan.steps.find((s) => s.id === "volume")!.destructive).toBe(true);
    await drain(hermetic.apply({ plan, yes: true }));
    expect(backend.volumes.has(volumeId)).toBe(false);
    expect(await backend.store.agents.get("marrow")).toBeNull();
  });
});
