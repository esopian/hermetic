/**
 * §6.5: an operation that would render a new config for a row pinned to a
 * Hermes with no known upstream ref (`hermesRefFor`) is refused before it
 * writes anything. The render would name that version with this build's ref,
 * and the box refuses it — after a recreate had already replaced the instance.
 * A row on a version with a known ref renders its own (`hermes-old-pin.test.ts`).
 *
 * "Nothing written" is the MemoryBackend's own mutation log: every row, event,
 * bucket, parameter, EC2 and tailnet write records itself there.
 */
import { describe, expect, test } from "bun:test";
import { BUILD_VERSIONS } from "../src/build-versions.ts";
import { isHermeticError } from "../src/errors.ts";
import { FIXTURE_CONFIG, MemoryBackend, seedFixtureFleet } from "../src/backend/memory.ts";
import { drain, freshFleet, testHermetic } from "./helpers.ts";

const PIN = BUILD_VERSIONS.hermes;
/** `ready`, healthy, on an older Hermes in the fixture. */
const HELD = "granite";

function seeded() {
  const backend = seedFixtureFleet(new MemoryBackend());
  return {
    backend,
    hermetic: testHermetic({
      backend,
      config: FIXTURE_CONFIG,
      rollout: { convergeTimeoutMs: 2_000, convergePollMs: 1 },
    }),
  };
}

async function refusal(run: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await run();
  } catch (e) {
    if (isHermeticError(e)) return { code: e.code, message: e.message };
    throw e;
  }
  throw new Error("expected a refusal");
}

function expectUpgradeRequired(got: { code: string; message: string }, name: string): void {
  expect(got.code).toBe("HERMES_UPGRADE_REQUIRED");
  expect(got.message).toContain(`hermetic upgrade --hermes ${PIN} ${name} --now`);
}

describe("a row held on another Hermes than this build's", () => {
  test("the fixture seeds one, so the tests below mean something", async () => {
    const { hermetic } = seeded();
    expect((await hermetic.agents.get(HELD)).hermes_version).not.toBe(PIN);
  });

  test("agent set of a harmless setting is refused and writes nothing", async () => {
    const { backend, hermetic } = seeded();
    const before = backend.agents.get(HELD)!;
    backend.resetMutations();
    expectUpgradeRequired(
      await refusal(() => hermetic.agents.set({ name: HELD, hermes: { max_turns: 42 } })),
      HELD,
    );
    expect(backend.mutations).toEqual([]);
    expect(backend.agents.get(HELD)).toEqual(before);
  });

  test("a provider-profile change is refused at set, and nothing is staged", async () => {
    const { backend, hermetic } = seeded();
    backend.resetMutations();
    expectUpgradeRequired(
      await refusal(() => hermetic.agents.set({ name: "kestrel", refresh_profile: true })),
      "kestrel",
    );
    expect(backend.mutations).toEqual([]);
    expect(backend.agents.get("kestrel")!.pending ?? null).toBeNull();
  });

  test("a memory-provider switch is refused and writes nothing", async () => {
    const { backend, hermetic } = seeded();
    backend.resetMutations();
    expectUpgradeRequired(
      await refusal(() => hermetic.agents.set({ name: HELD, memory_provider: "hindsight" })),
      HELD,
    );
    expect(backend.mutations).toEqual([]);
  });

  test("plan recreate is refused at the plan", async () => {
    const { backend, hermetic } = seeded();
    backend.resetMutations();
    expectUpgradeRequired(await refusal(() => hermetic.plan.recreate({ name: HELD })), HELD);
    expect(backend.mutations).toEqual([]);
  });

  test("agent recreate is refused before the old instance is touched", async () => {
    const { backend, hermetic } = seeded();
    const before = backend.agents.get(HELD)!;
    backend.resetMutations();
    expectUpgradeRequired(
      await refusal(() => drain(hermetic.agents.recreate({ name: HELD, yes: true }))),
      HELD,
    );
    expect(backend.mutations).toEqual([]);
    expect(backend.agents.get(HELD)).toEqual(before);
  });

  test("a create an older build left half-done is refused on resume", async () => {
    const { backend, hermetic } = freshFleet();
    const controller = new AbortController();
    await expect(
      (async () => {
        for await (const e of hermetic.agents.create({ name: "newt" }, { signal: controller.signal })) {
          if (e.phase === "volume") controller.abort();
        }
      })(),
    ).rejects.toThrow();
    const partial = backend.agents.get("newt")!;
    expect(partial.status).toBe("creating");
    // What a build pinned to a Hermes with no known ref claimed the name with.
    backend.agents.set("newt", { ...partial, hermes_version: "0.21.0" });

    backend.resetMutations();
    expectUpgradeRequired(await refusal(() => drain(hermetic.agents.create({ name: "newt" }))), "newt");
    expect(backend.mutations).toEqual([]);
  });

  test("plan rollout still defers it rather than refusing", async () => {
    const { hermetic } = seeded();
    const plan = await hermetic.plan.rollout({ agents: [HELD] });
    expect(plan.steps[0]!.description).toContain("held on Hermes");
  });

  test("upgrade to this build's pin with --now moves it, and set works after", async () => {
    const { backend, hermetic } = seeded();
    backend.simulateConverge = true;
    backend.rerunDelayMs = 1;
    await drain(hermetic.upgrade({ name: HELD, hermes: PIN, now: true, force: true }));
    expect((await hermetic.agents.get(HELD)).hermes_version).toBe(PIN);
    expect(backend.agents.get(HELD)!.running_hermes_version).toBe(PIN);
    const next = await hermetic.agents.set({ name: HELD, hermes: { max_turns: 42 } });
    expect(next.hermes?.max_turns).toBe(42);
  });
});

describe("a row on this build's pin", () => {
  test("set is unaffected", async () => {
    const { hermetic } = seeded();
    expect((await hermetic.agents.get("ibis")).hermes_version).toBe(PIN);
    const next = await hermetic.agents.set({ name: "ibis", hermes: { max_turns: 42 } });
    expect(next.hermes?.max_turns).toBe(42);
  });

  test("set cannot move it off the pin: moving Hermes is upgrade's job", async () => {
    const { backend, hermetic } = seeded();
    backend.resetMutations();
    const got = await refusal(() => hermetic.agents.set({ name: "ibis", hermes_version: "0.21.5" }));
    expect(got.code).toBe("HERMES_UPGRADE_REQUIRED");
    expect(got.message).toContain("`agent set` does not move Hermes");
    expect(got.message).toContain("nothing was changed");
    expect(got.message).toContain("`hermetic upgrade --hermes 0.21.5 ibis --now`");
    expect(backend.mutations).toEqual([]);
  });
});
