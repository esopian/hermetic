/**
 * §6.5: `upgrade --hermes V --now`, the in-place half of a Hermes upgrade.
 *
 * Without `--now` an upgrade moves the pin, re-renders and uploads, and stops:
 * the box goes on running the Hermes it has. With it, the same converge request
 * `plan rollout` writes goes on the row, and the run waits for the box's own
 * report. The properties held here are the ones that make that safe to run
 * across a fleet: a box that cannot apply is skipped with the pin still landed,
 * a box that stays silent is a warning rather than a thrown run, and the two
 * shapes `--now` cannot mean are refused before anything is written.
 */
import { describe, expect, test } from "bun:test";
import { FIXTURE_CONFIG, MemoryBackend, seedFixtureFleet } from "../src/backend/memory.ts";
import { HermeticError } from "../src/errors.ts";
import { drain, testHermetic } from "./helpers.ts";
import type { Agent, OpEvent } from "../src/schema/index.ts";

/** A pin no fixture agent runs, so every render moves the hash. */
const NEXT = "0.99.0";

function fleet(options: { convergeTimeoutMs?: number } = {}) {
  const backend = seedFixtureFleet(new MemoryBackend({ directory: "seeded" }));
  const hermetic = testHermetic({
    backend,
    config: FIXTURE_CONFIG,
    rollout: { convergeTimeoutMs: options.convergeTimeoutMs ?? 50, convergePollMs: 1 },
  });
  return { backend, hermetic };
}

/**
 * Every box answers as soon as it is asked: the row write that carries an
 * `apply_request` lands already reporting the hash it names. The same trick the
 * rollout tests use, so the two commands are held to the same box.
 */
function boxesAnswer(backend: MemoryBackend): void {
  const original = backend.agents.set.bind(backend.agents);
  backend.agents.set = ((name: string, row: Agent) => {
    const applied =
      row.apply_request && row.applied_config_hash !== row.apply_request.config_hash
        ? ({ ...row, applied_config_hash: row.apply_request.config_hash } as Agent)
        : row;
    return original(name, applied);
  }) as typeof backend.agents.set;
}

const messages = (events: OpEvent[]): string => events.map((e) => e.message).join("\n");

describe("upgrade --hermes V --now", () => {
  test("asks the box to apply the new config, and reports it running", async () => {
    const { backend, hermetic } = fleet();
    boxesAnswer(backend);
    const before = backend.agents.get("atlas")!;

    const events = await drain(hermetic.upgrade({ name: "atlas", hermes: NEXT, now: true }));

    const row = backend.agents.get("atlas")!;
    expect(row.hermes_version).toBe(NEXT);
    expect(row.config_hash).not.toBe(before.config_hash);
    expect(row.apply_request?.config_hash).toBe(row.config_hash ?? "");
    expect(row.applied_config_hash).toBe(row.config_hash ?? null);
    // The lock was given back before the wait, and stays given back.
    expect(row.lock ?? null).toBeNull();

    const said = messages(events);
    expect(said).toContain(`atlas asked to apply ${row.config_hash}`);
    expect(said).toContain(`atlas is running hermes ${NEXT}`);
    expect(events.at(-1)?.message).toBe(
      `pinned 1 agent(s) to hermes ${NEXT}: 1 converged, 0 skipped, 0 unconverged`,
    );
    expect(events.at(-1)?.level).toBeUndefined();
    // The agent's own history says which command asked.
    const history = await backend.store.events.query("atlas");
    expect(
      history.some(
        (e) => e.action === "upgrade" && e.detail === `converge requested: config ${row.config_hash}`,
      ),
    ).toBe(true);
  });

  test("a box that never reports is unconverged — a warning, not a thrown run", async () => {
    const { backend, hermetic } = fleet({ convergeTimeoutMs: 5 });

    const events = await drain(hermetic.upgrade({ name: "atlas", hermes: NEXT, now: true }));

    const said = messages(events);
    expect(said).toContain("has not reported config");
    expect(said).toContain("hermetic artifacts push");
    expect(events.at(-1)?.message).toContain("0 converged, 0 skipped, 1 unconverged");
    expect(events.at(-1)?.level).toBe("warn");
    // The request stays on the row: the box may still take it.
    expect(backend.agents.get("atlas")?.apply_request).toBeTruthy();
    expect(backend.agents.get("atlas")?.hermes_version).toBe(NEXT);
  });

  test("--all skips a box that is not up, and its pin still lands", async () => {
    const { backend, hermetic } = fleet();
    boxesAnswer(backend);
    expect(backend.agents.get("juniper")?.status).toBe("stopped");

    const events = await drain(hermetic.upgrade({ all: true, hermes: NEXT, now: true }));

    const juniper = backend.agents.get("juniper")!;
    expect(juniper.hermes_version).toBe(NEXT);
    expect(juniper.apply_request ?? null).toBeNull();
    const skipped = events.find((e) => e.phase === "juniper:skipped");
    expect(skipped?.level).toBe("warn");
    expect(skipped?.message).toContain("juniper not converged — stopped");
    // …and the agents after it were still asked.
    expect(backend.agents.get("lumen")?.apply_request).toBeTruthy();

    const live = [...backend.agents.values()].filter((a) => a.name !== "_fleet");
    const down = live.filter((a) => !["ready", "degraded", "error"].includes(a.status));
    expect(down.length).toBeGreaterThan(0);
    expect(events.at(-1)?.message).toBe(
      `pinned ${String(live.length)} agent(s) to hermes ${NEXT}: ` +
        `${String(live.length - down.length)} converged, ${String(down.length)} skipped, 0 unconverged`,
    );
    expect(events.at(-1)?.level).toBe("warn");
  });

  test("with --hermeticd it is refused VALIDATION before anything is written", async () => {
    const { backend, hermetic } = fleet();
    const manifest = backend.objects.get("manifest.json");
    backend.resetMutations();

    const thrown = await drain(
      hermetic.upgrade({ all: true, hermes: NEXT, hermeticd: "9.9.9", now: true }),
    ).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(HermeticError);
    expect((thrown as HermeticError).code).toBe("VALIDATION");
    expect(backend.mutations).toEqual([]);
    expect(backend.objects.get("manifest.json")).toEqual(manifest);
    expect(backend.agents.get("atlas")?.hermes_version).not.toBe(NEXT);
  });

  test("without --hermes it is refused by the schema", async () => {
    const { backend, hermetic } = fleet();
    backend.resetMutations();
    await expect(drain(hermetic.upgrade({ hermeticd: "9.9.9", now: true }))).rejects.toThrow(
      /--now .*needs --hermes/,
    );
    expect(backend.mutations).toEqual([]);
  });
});

describe("upgrade --hermes V without --now", () => {
  test("writes no converge request, and says how to land it", async () => {
    const { backend, hermetic } = fleet();

    const events = await drain(hermetic.upgrade({ name: "atlas", hermes: NEXT }));

    const row = backend.agents.get("atlas")!;
    expect(row.hermes_version).toBe(NEXT);
    expect(row.apply_request ?? null).toBeNull();
    const render = events.find((e) => e.phase === "atlas:render")!;
    expect(render.message).toContain("takes effect on the next recreate");
    expect(render.message).toContain(`\`hermetic upgrade atlas --hermes ${NEXT} --now\``);
    expect(render.message).toContain("`hermetic plan rollout --agent atlas`");
    expect(events.at(-1)?.message).toBe(
      `pinned 1 agent(s) to hermes ${NEXT}; each takes it on its next recreate, ` +
        `or now with \`hermetic upgrade atlas --hermes ${NEXT} --now\``,
    );
  });
});

/**
 * Fixture mode's fake box (`simulateConverge`): opt-in, so a plain
 * `MemoryBackend` stays the box that never answers — which the unconverged test
 * above, and the rollout suite's, rely on.
 */
describe("the fixture's box answering a converge", () => {
  test("answers when switched on, as the real daemon reports it", async () => {
    const { backend, hermetic } = fleet({ convergeTimeoutMs: 2_000 });
    backend.simulateConverge = true;
    backend.rerunDelayMs = 1;

    const events = await drain(hermetic.upgrade({ name: "atlas", hermes: NEXT, now: true }));

    const row = backend.agents.get("atlas")!;
    expect(row.applied_config_hash).toBe(row.config_hash ?? null);
    expect(row.running_hermes_version).toBe(NEXT);
    expect(messages(events)).toContain(`atlas is running hermes ${NEXT}`);
    const history = await backend.store.events.query("atlas");
    expect(history.some((e) => e.action === "apply" && e.actor === "hermeticd/atlas")).toBe(true);
  });

  test("is off by default", () => {
    expect(new MemoryBackend().simulateConverge).toBe(false);
  });
});
