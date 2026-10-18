/**
 * The observation's cached box address (`chat-observe-address.ts`, §9.2): the
 * fleet guard (five minutes) and the agent row (one) are trusted on the
 * observation's own reads, the listen check never is, and a failure re-guards.
 */
import { describe, expect, test } from "bun:test";
import {
  OBSERVE_ADDRESS_TTL_MS,
  OBSERVE_GUARD_TTL_MS,
  createObserveAddressCache,
} from "../src/chat/chat-observe-address.ts";
import type { ObserveAddressDeps } from "../src/chat/chat-observe-address.ts";
import { createChat } from "../src/chat/chat.ts";
import { MemoryInstanceListeningStore } from "../src/chat/instance-listening.ts";
import { createFixtureChatActivity, fixtureChatClient } from "../src/backend/fixture/fixture-chat.ts";
import { FIXTURE_CONFIG, MemoryBackend, seedFixtureFleet } from "../src/backend/memory.ts";
import type { StackInfo } from "../src/backend/types.ts";
import type { HermesChatClient } from "../src/chat/hermes/hermes-chat-types.ts";
import type { BoxAddress } from "../src/chat/hermes/hermes-chat.ts";
import type { ChatObserveEvent, FleetItem } from "../src/schema/index.ts";
import { HermeticError } from "../src/errors.ts";

const backend = seedFixtureFleet(new MemoryBackend());
const agents = await backend.store.agents.scan();
const seeded = await backend.store.fleet.get();
if (seeded === null) throw new Error("the fixture seed writes a fleet item");
const fleet: FleetItem = seeded;

const boxOf = (instance: string, fleetId = fleet.fleet_id): BoxAddress => ({
  instance,
  baseUrl: `https://${instance}.example.ts.net/`,
  fleet_id: fleetId,
});

function cacheRig(over: Partial<ObserveAddressDeps> = {}) {
  let now = 0;
  let guards = 0;
  let locates = 0;
  const listening = new Set(["atlas", "corvid"]);
  let local: string | null = fleet.fleet_id;
  let guardFailure: Error | null = null;
  const cache = createObserveAddressCache({
    guard: () => {
      guards += 1;
      return guardFailure ? Promise.reject(guardFailure) : Promise.resolve(fleet);
    },
    locate: (f, instance) => {
      locates += 1;
      if (!listening.has(instance))
        return Promise.reject(new HermeticError("VALIDATION", `${instance}: not listening`));
      return Promise.resolve(boxOf(instance, f.fleet_id));
    },
    requireListening: (_fleet, instance) => {
      if (!listening.has(instance)) throw new HermeticError("VALIDATION", `${instance}: not listening`);
    },
    fleet: () => local,
    clock: () => now,
    ...over,
  });
  return {
    cache,
    listening,
    guards: () => guards,
    locates: () => locates,
    advance: (ms: number) => {
      now += ms;
    },
    setLocal: (id: string | null) => {
      local = id;
    },
    failGuard: (error: Error | null) => {
      guardFailure = error;
    },
  };
}

describe("observe address cache", () => {
  test("hits within the TTL: one guard and one row read for many lookups", async () => {
    const r = cacheRig();
    for (let i = 0; i < 10; i++) expect(await r.cache.get("atlas")).toEqual(boxOf("atlas"));
    expect(r.guards()).toBe(1);
    expect(r.locates()).toBe(1);
  });

  test("the guard is shared across instances", async () => {
    const r = cacheRig();
    await r.cache.get("atlas");
    await r.cache.get("corvid");
    expect(r.guards()).toBe(1);
    expect(r.locates()).toBe(2);
  });

  test("an expired address re-reads the row and keeps the guard", async () => {
    const r = cacheRig();
    await r.cache.get("atlas");
    r.advance(OBSERVE_ADDRESS_TTL_MS - 1);
    await r.cache.get("atlas");
    expect(r.locates()).toBe(1);
    r.advance(1);
    await r.cache.get("atlas");
    expect(r.locates()).toBe(2);
    expect(r.guards()).toBe(1);
  });

  test("an expired guard runs the guard again", async () => {
    const r = cacheRig();
    await r.cache.get("atlas");
    for (let t = 0; t < OBSERVE_GUARD_TTL_MS; t += OBSERVE_ADDRESS_TTL_MS / 2) {
      r.advance(OBSERVE_ADDRESS_TTL_MS / 2);
      await r.cache.get("atlas");
    }
    expect(r.guards()).toBe(2);
  });

  test("a mismatch after the guard expires fires", async () => {
    const r = cacheRig();
    await r.cache.get("atlas");
    r.failGuard(new HermeticError("FLEET_MISMATCH", "the stack belongs to another fleet"));
    // Inside both TTLs the cached proof stands.
    await r.cache.get("atlas");
    r.advance(OBSERVE_GUARD_TTL_MS);
    await expect(r.cache.get("atlas")).rejects.toMatchObject({ code: "FLEET_MISMATCH" });
  });

  test("a cold cache still guards: a mismatch fires", async () => {
    const r = cacheRig();
    r.failGuard(new HermeticError("FLEET_MISMATCH", "the stack belongs to another fleet"));
    await expect(r.cache.get("atlas")).rejects.toMatchObject({ code: "FLEET_MISMATCH" });
  });

  test("an invalidated cache still guards: a mismatch after a failure fires", async () => {
    const r = cacheRig();
    await r.cache.get("atlas");
    await expect(
      r.cache.read("atlas", () => Promise.reject(new HermeticError("CHAT_UNREACHABLE", "down"))),
    ).rejects.toBeDefined();
    r.failGuard(new HermeticError("ACCOUNT_MISMATCH", "another account"));
    await expect(r.cache.get("atlas")).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
  });

  test("the listen check runs on every hit", async () => {
    const r = cacheRig();
    await r.cache.get("atlas");
    r.listening.delete("atlas");
    await expect(r.cache.get("atlas")).rejects.toMatchObject({ code: "VALIDATION" });
    // And the entry went with it: listening again re-guards.
    r.listening.add("atlas");
    await r.cache.get("atlas");
    expect(r.guards()).toBe(2);
  });

  test("a read through a cached address that fails is retried once, freshly guarded", async () => {
    const r = cacheRig();
    await r.cache.get("atlas");
    let attempts = 0;
    const answer = await r.cache.read("atlas", (box) => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new HermeticError("CHAT_UNREACHABLE", "the old box is gone"))
        : Promise.resolve(box.instance);
    });
    expect(answer).toBe("atlas");
    expect(attempts).toBe(2);
    expect(r.guards()).toBe(2);
  });

  test("a busy gateway through a cached address is not retried, but drops the entry", async () => {
    const r = cacheRig();
    await r.cache.get("atlas");
    let attempts = 0;
    await expect(
      r.cache.read("atlas", () => {
        attempts += 1;
        return Promise.reject(new HermeticError("CHAT_NO_SLOT", "every slot is busy"));
      }),
    ).rejects.toMatchObject({ code: "CHAT_NO_SLOT" });
    expect(attempts).toBe(1);
    await r.cache.get("atlas");
    expect(r.guards()).toBe(2);
  });

  test("a read through a fresh address that fails is not retried, and drops the entry", async () => {
    const r = cacheRig();
    let attempts = 0;
    await expect(
      r.cache.read("atlas", () => {
        attempts += 1;
        return Promise.reject(new HermeticError("CHAT_UNREACHABLE", "down"));
      }),
    ).rejects.toMatchObject({ code: "CHAT_UNREACHABLE" });
    expect(attempts).toBe(1);
    await r.cache.get("atlas");
    expect(r.guards()).toBe(2);
  });

  test("an aborted read is not retried", async () => {
    const r = cacheRig();
    await r.cache.get("atlas");
    const controller = new AbortController();
    controller.abort();
    let attempts = 0;
    await expect(
      r.cache.read(
        "atlas",
        () => {
          attempts += 1;
          return Promise.reject(new HermeticError("ABORTED", "stopped"));
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "ABORTED" });
    expect(attempts).toBe(1);
    // An abort is this laptop hanging up, not news about the box.
    await r.cache.get("atlas");
    expect(r.guards()).toBe(1);
  });

  test("a different local fleet clears the cache", async () => {
    const r = cacheRig();
    await r.cache.get("atlas");
    r.setLocal("sg7k2m4p");
    await r.cache.get("atlas");
    expect(r.guards()).toBe(2);
  });
});

/* ── through `createChat`: the observation's reads ─────────────────────────── */

function chatRig() {
  let guards = 0;
  let rows = 0;
  const instanceListening = new MemoryInstanceListeningStore();
  for (const agent of agents) instanceListening.set(fleet.fleet_id, agent.name, true);
  const full = fixtureChatClient({ activity: createFixtureChatActivity() });
  // Poll only: no hint stream and no busy probe, so the loop reads on `pollMs`.
  const { observe: _observe, busy: _busy, ...base } = full;
  let histories = 0;
  const hermes = {
    ...base,
    history: (...args: Parameters<HermesChatClient["history"]>) => {
      histories += 1;
      return base.history(...args);
    },
  };
  let mismatch = false;
  let now = 0;
  const chat = createChat({
    instanceListening,
    fleet: () => fleet.fleet_id,
    guardFleet: () => {
      guards += 1;
      if (mismatch)
        return Promise.reject(
          new HermeticError("FLEET_MISMATCH", "the stack belongs to another fleet"),
        );
      return Promise.resolve({
        config: FIXTURE_CONFIG,
        fleet,
        stack: {
          stack_id: "arn:aws:cloudformation:us-east-1:111122223333:stack/hermetic/1",
          stack_name: "hermetic",
          status: "CREATE_COMPLETE",
          tags: {},
          outputs: {},
          parameters: {},
        } satisfies StackInfo,
      });
    },
    getAgent: (name) => {
      rows += 1;
      const found = agents.find((a) => a.name === name);
      if (!found) return Promise.reject(new HermeticError("NOT_FOUND", name));
      return Promise.resolve(found);
    },
    listAgents: () => Promise.resolve(agents),
    now: () => "2026-10-17T09:00:00.000Z",
    hermes: hermes as HermesChatClient,
    observeTuning: { pollMs: 5, clock: () => now },
  });
  const events: ChatObserveEvent[] = [];
  const controller = new AbortController();
  const done = (async () => {
    for await (const event of chat.observe(
      { instance: "atlas", bot: "default" },
      { signal: controller.signal },
    )) {
      events.push(event);
    }
  })();
  return {
    chat,
    instanceListening,
    events,
    done,
    guards: () => guards,
    rows: () => rows,
    mismatch: () => {
      mismatch = true;
    },
    advance: (ms: number) => {
      now += ms;
    },
    stop: async () => {
      controller.abort();
      await done;
    },
    histories: () => histories,
  };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("chat.observe through the cached address", () => {
  test("many reconciles cost one fleet guard and one row read", async () => {
    const r = chatRig();
    await pause(200);
    await r.stop();
    expect(r.events[0]?.type).toBe("snapshot");
    expect(r.histories()).toBeGreaterThan(5);
    expect(r.guards()).toBe(1);
    expect(r.rows()).toBe(1);
  });

  test("unlistening ends the observation on its next read", async () => {
    const r = chatRig();
    await pause(30);
    // Written to the store directly rather than through `chat.listen`, which
    // also aborts this process's leases: this is the read path's own check,
    // the one that catches a preference changed by another process.
    r.instanceListening.set(fleet.fleet_id, "atlas", false);
    await Promise.race([r.done, pause(1_000)]);
    const last = r.events.at(-1);
    expect(last).toMatchObject({ type: "error", code: "VALIDATION" });
    await r.stop();
  });

  test("a fleet mismatch once the guard expires ends the observation", async () => {
    const r = chatRig();
    await pause(30);
    r.mismatch();
    // Cached: reads go on.
    await pause(30);
    expect(r.events.some((e) => e.type === "error")).toBe(false);
    r.advance(OBSERVE_GUARD_TTL_MS);
    await Promise.race([r.done, pause(1_000)]);
    expect(r.events.at(-1)).toMatchObject({ type: "error", code: "FLEET_MISMATCH" });
    await r.stop();
  });

  test("the public history read still guards every time", async () => {
    const r = chatRig();
    await r.stop();
    const before = r.guards();
    await r.chat.history({ instance: "atlas", bot: "default" });
    await r.chat.history({ instance: "atlas", bot: "default" });
    expect(r.guards()).toBe(before + 2);
  });
});
