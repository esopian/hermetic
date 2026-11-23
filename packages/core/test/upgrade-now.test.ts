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
import { BUILD_VERSIONS } from "../src/build-versions.ts";
import { FIXTURE_CONFIG, MemoryBackend, seedFixtureFleet } from "../src/backend/memory.ts";
import { FIXTURE_HERMETICD_VERSION } from "../src/backend/fixture/memory-fixture.ts";
import { drain, onBuildHermes, settle, testHermetic } from "./helpers.ts";
import type { Agent, OpEvent } from "../src/schema/index.ts";
import type { BoxBusy } from "../src/agents/upgrade-idle.ts";

/** A pin no fixture agent runs, so every render moves the hash. */
const NEXT = "0.99.0";

function fleet(options: { convergeTimeoutMs?: number; boxBusy?: BoxBusy } = {}) {
  const backend = seedFixtureFleet(new MemoryBackend({ directory: "seeded" }));
  const hermetic = testHermetic({
    backend,
    config: FIXTURE_CONFIG,
    rollout: {
      convergeTimeoutMs: options.convergeTimeoutMs ?? 50,
      convergePollMs: 1,
      idleTimeoutMs: 5,
      idlePollMs: 1,
      ...(options.boxBusy === undefined ? {} : { boxBusy: options.boxBusy }),
    },
  });
  return { backend, hermetic };
}

/**
 * Every box fails the converge it is asked for with hermeticd's `code`, as
 * `runConvergeLoop` reports it: `apply_failure` on the row, naming the request.
 */
function boxesFail(backend: MemoryBackend, code: string): void {
  const original = backend.agents.set.bind(backend.agents);
  backend.agents.set = ((name: string, row: Agent) => {
    const req = row.apply_request;
    const failed =
      req && row.apply_failure?.request_id !== req.id
        ? ({
            ...row,
            apply_failure: {
              request_id: req.id,
              config_hash: req.config_hash,
              code,
              at: "2026-11-15T00:00:00.000Z",
            },
          } as Agent)
        : row;
    return original(name, failed);
  }) as typeof backend.agents.set;
}

/** The fields an upgrade publishes, to compare a row against what it was. */
const pin = (row: Agent) => ({
  hermes_version: row.hermes_version,
  config_hash: row.config_hash ?? null,
  config_key: row.resources.config_key,
});

/**
 * Every box answers as soon as it is asked: the row write that carries an
 * `apply_request` lands already reporting the hash it names. The same trick the
 * rollout tests use, so the two commands are held to the same box.
 */
function boxesAnswer(backend: MemoryBackend): void {
  const original = backend.agents.set.bind(backend.agents);
  backend.agents.set = ((name: string, row: Agent) => {
    // …and, like a real box, then reports running the Hermes its row pins.
    const applied =
      row.apply_request && row.applied_config_hash !== row.apply_request.config_hash
        ? ({
            ...row,
            applied_config_hash: row.apply_request.config_hash,
            running_hermes_version: row.hermes_version,
          } as Agent)
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

  /**
   * Every per-agent event used to carry `(index + 1) / n`, so a one-agent run
   * read 1.0 from the moment the config was uploaded — and the drawer's bar sat
   * at 100% through the minute and a half the box takes to restart Hermes
   * (real mode, 2026-10-12). Only the run's own `done` may say 1, the bar
   * never moves backwards, and the wait says what it is waiting for.
   */
  test("progress stays below 1 until the run's done, and never moves backwards", async () => {
    const { backend, hermetic } = fleet();
    boxesAnswer(backend);

    for (const input of [{ name: "atlas" }, { all: true }] as const) {
      const events = await drain(hermetic.upgrade({ ...input, hermes: NEXT, now: true }));
      const last = events.at(-1);
      expect(last?.phase).toBe("done");
      expect(last?.progress).toBe(1);
      const before = events.slice(0, -1);
      for (const e of before) expect(e.progress).toBeLessThan(1);
      const steps = events.map((e) => e.progress);
      expect(steps).toEqual([...steps].sort((a, b) => a - b));
    }

    const events = await drain(hermetic.upgrade({ name: "atlas", hermes: "0.99.1", now: true }));
    const waiting = events.find((e) => e.phase === "atlas:requested");
    expect(waiting?.message).toContain("waiting for the box to restart Hermes on 0.99.1");
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

  test("--all records only the pin of a stopped box never asked to converge, and goes on", async () => {
    const { backend, hermetic } = fleet();
    boxesAnswer(backend);
    const stopped = backend.agents.get("juniper")!;
    expect(stopped.status).toBe("stopped");
    expect(stopped.applied_config_hash ?? null).toBeNull();
    expect(stopped.apply_request ?? null).toBeNull();

    const events = await drain(hermetic.upgrade({ all: true, hermes: NEXT, now: true }));

    // With no request ever asked of it, its box holds its own config's Hermes or nothing.
    const juniper = backend.agents.get("juniper")!;
    expect(pin(juniper)).toEqual({ ...pin(stopped), hermes_version: NEXT });
    expect(juniper.apply_request ?? null).toBeNull();
    const skipped = events.find((e) => e.phase === "juniper:skipped");
    expect(skipped?.level).toBe("warn");
    expect(skipped?.message).toContain("juniper is not up (stopped), so nothing was applied");
    expect(skipped?.message).toContain("`hermetic plan recreate juniper`");
    // …and the agents after it were still asked.
    expect(backend.agents.get("lumen")?.apply_request).toBeTruthy();

    // heron is up but its gateway never answers the idle probe, so it is left
    // as it was rather than stopped blind (D4).
    expect(backend.agents.get("heron")?.hermes_version).not.toBe(NEXT);
    expect(events.find((e) => e.phase === "heron:refused")?.level).toBe("warn");
    // kestrel's box reports another Hermes than its applied config pins, so
    // there is no honest pin to put back: refused before the wait (C4).
    expect(events.find((e) => e.phase === "kestrel:refused")?.message).toContain(
      "its box runs Hermes 0.20.0, but the config it last applied pins 0.21.0",
    );

    const live = [...backend.agents.values()].filter((a) => a.name !== "_fleet");
    const down = live.filter((a) => !["ready", "degraded", "error"].includes(a.status));
    expect(down.length).toBeGreaterThan(0);
    // Every fixture row that is not up was stopped or paused and never asked to converge: pin only.
    const converged = live.length - down.length - 2;
    expect(events.at(-1)?.message).toBe(
      `pinned ${String(converged + down.length)} agent(s) to hermes ${NEXT}: ` +
        `${String(converged)} converged, ${String(down.length)} skipped, 0 unconverged; ` +
        "2 refused and left as they were",
    );
    expect(events.at(-1)?.level).toBe("warn");
  });

  test("--all waits for idle on a box that came up after the run started", async () => {
    const probed: string[] = [];
    const { backend, hermetic } = fleet({
      boxBusy: async (agent) => {
        probed.push(agent.name);
        // While atlas is waited on, juniper comes back up and reports its box.
        const juniper = backend.agents.get("juniper")!;
        if (agent.name === "atlas" && juniper.status === "stopped") {
          backend.agents.set("juniper", {
            ...juniper,
            status: "ready",
            applied_config_hash: juniper.config_hash ?? null,
            running_hermes_version: juniper.hermes_version,
          } as Agent);
        }
        return false;
      },
    });
    boxesAnswer(backend);

    const events = await drain(hermetic.upgrade({ all: true, hermes: NEXT, now: true }));

    expect(probed).toContain("juniper");
    expect(events.find((e) => e.phase === "juniper:done")?.message).toContain(
      `juniper is running hermes ${NEXT}`,
    );
  });

  test("--all refuses an armed row on its own and pins the rest; one agent alone still fails", async () => {
    const { backend, hermetic } = fleet();
    // atlas armed: an `--now` its box never answered.
    await drain(hermetic.upgrade({ name: "atlas", hermes: NEXT, now: true, force: true }));
    const armed = backend.agents.get("atlas")!;
    expect(armed.config_hash).not.toBe(armed.applied_config_hash ?? null);
    const THIRD = "0.98.0";

    const events = await drain(hermetic.upgrade({ all: true, hermes: THIRD }));

    expect(pin(backend.agents.get("atlas")!)).toEqual(pin(armed));
    const atlas = events.find((e) => e.phase === "atlas:refused");
    expect(atlas?.level).toBe("warn");
    expect(atlas?.message).toContain(
      `finish it with \`hermetic upgrade --hermes ${NEXT} atlas --now\``,
    );
    // An agent after it was still pinned.
    expect(backend.agents.get("lumen")!.hermes_version).toBe(THIRD);
    expect(events.at(-1)?.message).toContain("refused and left as they were");
    expect(events.at(-1)?.level).toBe("warn");

    let code: string | null = null;
    try {
      await drain(hermetic.upgrade({ name: "atlas", hermes: THIRD }));
    } catch (e) {
      code = (e as { code?: string }).code ?? null;
    }
    expect(code).toBe("HERMES_UPGRADE_REQUIRED");
    expect(pin(backend.agents.get("atlas")!)).toEqual(pin(armed));
  });

  test("beside --hermeticd it also asks every running box to take the release", async () => {
    const { backend, hermetic } = fleet();
    boxesAnswer(backend);
    // The fixture bucket's release is the only one, so republish it under a
    // new version: a new pointer the boxes can be asked to take.
    await settle(hermetic.artifacts.push({ version: "9.9.9", rollout: false }));
    await drain(hermetic.upgrade({ all: true, hermeticd: FIXTURE_HERMETICD_VERSION, rollout: false }));

    const events = await drain(
      hermetic.upgrade({ all: true, hermes: NEXT, hermeticd: "9.9.9", now: true }),
    );

    expect(backend.agents.get("atlas")?.update_request?.hermeticd_version).toBe("9.9.9");
    expect(backend.agents.get("atlas")?.hermes_version).toBe(NEXT);
    expect(backend.agents.get("atlas")?.apply_request).toBeTruthy();
    expect(events.some((e) => e.phase === "rollout" && e.kind === "start")).toBe(true);
  });

  test("`--no-rollout` without --hermeticd is refused by the schema", async () => {
    const { backend, hermetic } = fleet();
    backend.resetMutations();
    await expect(
      drain(hermetic.upgrade({ name: "atlas", hermes: NEXT, rollout: false })),
    ).rejects.toThrow(/need --hermeticd/);
    expect(backend.mutations).toEqual([]);
  });

  test("`--now` with `--no-rollout` is refused by the schema", async () => {
    const { backend, hermetic } = fleet();
    backend.resetMutations();
    await expect(
      drain(hermetic.upgrade({ hermeticd: "9.9.9", now: true, rollout: false })),
    ).rejects.toThrow(/contradict/);
    expect(backend.mutations).toEqual([]);
  });
});

/**
 * D4 and W13: the box is waited on until idle before the pin is published, and
 * a failure the box reports before it touched Hermes puts the old pin back.
 */
describe("upgrade --hermes V --now: the idle wait and the box's failure report", () => {
  test("a box that stays busy is left exactly as it was", async () => {
    const { backend, hermetic } = fleet({ boxBusy: async () => true });
    const before = backend.agents.get("atlas")!;

    const events = await drain(hermetic.upgrade({ name: "atlas", hermes: NEXT, now: true }));

    const row = backend.agents.get("atlas")!;
    expect(pin(row)).toEqual(pin(before));
    expect(row.apply_request ?? null).toBeNull();
    expect(row.lock ?? null).toBeNull();
    expect(events.find((e) => e.phase === "atlas:idle")?.message).toContain("has a session running");
    const refused = events.find((e) => e.phase === "atlas:refused");
    expect(refused?.level).toBe("warn");
    expect(refused?.message).toContain("nothing was changed");
    expect(refused?.message).toContain("--force");
    expect(events.at(-1)?.message).toBe(
      `pinned 0 agent(s) to hermes ${NEXT}: 0 converged, 0 skipped, 0 unconverged; ` +
        "1 refused and left as they were",
    );
    expect(events.at(-1)?.level).toBe("warn");
  });

  test("a box that cannot be asked is waited on like a busy one", async () => {
    const { backend, hermetic } = fleet({ boxBusy: async () => null });
    const before = backend.agents.get("atlas")!;

    const events = await drain(hermetic.upgrade({ name: "atlas", hermes: NEXT, now: true }));

    expect(pin(backend.agents.get("atlas")!)).toEqual(pin(before));
    expect(events.find((e) => e.phase === "atlas:idle")?.message).toContain("did not say");
  });

  test("a box that goes idle is upgraded", async () => {
    const answers = [true, true, false];
    const { backend, hermetic } = fleet({ boxBusy: async () => answers.shift() ?? false });
    boxesAnswer(backend);

    const events = await drain(hermetic.upgrade({ name: "atlas", hermes: NEXT, now: true }));

    expect(answers).toEqual([]);
    expect(backend.agents.get("atlas")?.hermes_version).toBe(NEXT);
    // Said once while it waited, not once per look.
    expect(events.filter((e) => e.phase === "atlas:idle")).toHaveLength(1);
    expect(messages(events)).toContain(`atlas is running hermes ${NEXT}`);
  });

  test("--force does not ask", async () => {
    let asked = 0;
    const { backend, hermetic } = fleet({
      boxBusy: async () => {
        asked += 1;
        return true;
      },
    });
    boxesAnswer(backend);

    await drain(hermetic.upgrade({ name: "atlas", hermes: NEXT, now: true, force: true }));

    expect(asked).toBe(0);
    expect(backend.agents.get("atlas")?.hermes_version).toBe(NEXT);
  });

  test("--force without --hermes --now is refused by the schema", async () => {
    const { hermetic } = fleet();
    await expect(drain(hermetic.upgrade({ name: "atlas", hermes: NEXT, force: true }))).rejects.toThrow(
      /--force/,
    );
  });

  for (const code of [
    "HERMES_UNITS_ACTIVE",
    "HERMES_BACKUP_FAILED",
    "HERMES_RESTORE_REFUSED",
    "HERMES_SWAP_ABORTED",
  ]) {
    test(`a failure before the checkout was touched (${code}) puts the old pin back`, async () => {
      const { backend, hermetic } = fleet({ convergeTimeoutMs: 2_000 });
      boxesFail(backend, code);
      const before = backend.agents.get("atlas")!;

      const events = await drain(hermetic.upgrade({ name: "atlas", hermes: NEXT, now: true }));

      const row = backend.agents.get("atlas")!;
      expect(pin(row)).toEqual(pin(before));
      expect(row.lock ?? null).toBeNull();
      const refused = events.find((e) => e.phase === "atlas:refused");
      expect(refused?.level).toBe("warn");
      expect(refused?.message).toContain(code);
      expect(refused?.message).toContain(`pin is back to ${before.hermes_version}`);
      expect(events.at(-1)?.message).toContain("1 refused");
      const history = await backend.store.events.query("atlas");
      expect(history.some((e) => e.action === "upgrade" && e.detail?.includes(code))).toBe(true);
    });
  }

  test("an upgrade the box rolled back puts the old pin back, then fails the run", async () => {
    const { backend, hermetic } = fleet({ convergeTimeoutMs: 2_000 });
    boxesFail(backend, "HERMES_UPGRADE_ROLLED_BACK");
    const before = backend.agents.get("atlas")!;
    const events: OpEvent[] = [];

    let thrown: unknown = null;
    try {
      for await (const e of hermetic.upgrade({ name: "atlas", hermes: NEXT, now: true }))
        events.push(e);
    } catch (e) {
      thrown = e;
    }

    const error = thrown as { code?: string; message?: string } | null;
    expect(error?.code).toBe("HERMES_UPGRADE_ROLLED_BACK");
    expect(error?.message).toContain(
      `atlas rolled back and is running hermes ${before.hermes_version}`,
    );
    expect(error?.message).toContain(`the upgrade to ${NEXT} failed on the box`);
    const row = backend.agents.get("atlas")!;
    expect(pin(row)).toEqual(pin(before));
    expect(row.lock ?? null).toBeNull();
    const failed = events.find((e) => e.phase === "atlas:failed");
    expect(failed?.level).toBe("error");
    expect(events.at(-1)).toBe(failed);
    // A box with no previous config runs the old Hermes on the new pin's files:
    // it is asked to converge on the restored config, which it does not refuse.
    expect(row.apply_request?.config_hash).toBe(before.config_hash ?? "");
    expect(row.apply_request?.upgrade_from).toBeUndefined();
  });

  test("--all stops at the agent that rolled back: those before converged, those after untouched", async () => {
    const { backend, hermetic } = fleet({ convergeTimeoutMs: 2_000 });
    const order = (await backend.store.agents.scan())
      .filter((a) => a.status !== "destroyed")
      .map((a) => a.name);
    const [first, second, ...rest] = order;
    expect(rest.length).toBeGreaterThan(0);
    const original = backend.agents.set.bind(backend.agents);
    // The second agent rolls back; every other box answers, as `boxesAnswer` does.
    backend.agents.set = ((name: string, row: Agent) => {
      const req = row.apply_request;
      if (!req || row.applied_config_hash === req.config_hash) return original(name, row);
      if (name !== second) return original(name, { ...row, applied_config_hash: req.config_hash });
      if (row.apply_failure?.request_id === req.id) return original(name, row);
      return original(name, {
        ...row,
        apply_failure: {
          request_id: req.id,
          config_hash: req.config_hash,
          code: "HERMES_UPGRADE_ROLLED_BACK",
          at: "2026-11-15T00:00:00.000Z",
        },
      });
    }) as typeof backend.agents.set;
    const secondBefore = backend.agents.get(second!)!;
    const restBefore = rest.map((name) => pin(backend.agents.get(name)!));

    let thrown: unknown = null;
    try {
      await drain(hermetic.upgrade({ all: true, hermes: NEXT, now: true, force: true }));
    } catch (e) {
      thrown = e;
    }

    const error = thrown as { code?: string; message?: string; details?: { not_attempted?: string[] } };
    expect(error.code).toBe("HERMES_UPGRADE_ROLLED_BACK");
    expect(error.message).toContain(`${second} rolled back`);
    expect(error.message).toContain(`not attempted: ${rest.join(", ")}`);
    expect(error.details?.not_attempted).toEqual(rest);
    const firstRow = backend.agents.get(first!)!;
    expect(firstRow.hermes_version).toBe(NEXT);
    expect(firstRow.applied_config_hash).toBe(firstRow.config_hash ?? null);
    expect(pin(backend.agents.get(second!)!)).toEqual(pin(secondBefore));
    expect(rest.map((name) => pin(backend.agents.get(name)!))).toEqual(restBefore);
  });

  test("--all still stops at a rollback when another operation holds that agent's lock", async () => {
    const { backend, hermetic } = fleet({ convergeTimeoutMs: 2_000 });
    const order = (await backend.store.agents.scan())
      .filter((a) => a.status !== "destroyed")
      .map((a) => a.name);
    const [, second, third, ...rest] = order;
    const original = backend.agents.set.bind(backend.agents);
    // The second box rolls back, and another operation takes its lock in the
    // same breath — after this run released it for the wait.
    backend.agents.set = ((name: string, row: Agent) => {
      const req = row.apply_request;
      if (!req || row.applied_config_hash === req.config_hash) return original(name, row);
      if (name !== second) return original(name, { ...row, applied_config_hash: req.config_hash });
      if (row.apply_failure?.request_id === req.id || row.lock) return original(name, row);
      return original(name, {
        ...row,
        lock: { owner: "someone-else", expires: "2099-01-01T00:00:00.000Z" },
        apply_failure: {
          request_id: req.id,
          config_hash: req.config_hash,
          code: "HERMES_UPGRADE_ROLLED_BACK",
          at: "2026-11-15T00:00:00.000Z",
        },
      });
    }) as typeof backend.agents.set;
    const after = [third!, ...rest];
    const afterBefore = after.map((name) => pin(backend.agents.get(name)!));

    let thrown: unknown = null;
    try {
      await drain(hermetic.upgrade({ all: true, hermes: NEXT, now: true, force: true }));
    } catch (e) {
      thrown = e;
    }

    const error = thrown as { code?: string; message?: string; details?: { not_attempted?: string[] } };
    expect(error.code).toBe("HERMES_UPGRADE_ROLLED_BACK");
    expect(error.message).toContain(`${second} rolled back`);
    expect(error.message).toContain("its pin could not be restored yet");
    expect(error.details?.not_attempted).toEqual(after);
    expect(after.map((name) => pin(backend.agents.get(name)!))).toEqual(afterBefore);
    // Left as the other operation holds it, for the next writer to reconcile.
    const secondRow = backend.agents.get(second!)!;
    expect(secondRow.lock?.owner).toBe("someone-else");
    expect(secondRow.hermes_version).toBe(NEXT);
  });

  test("--now after a pin-only upgrade names the Hermes the box runs, and a rollback restores it", async () => {
    const { backend, hermetic } = fleet({ convergeTimeoutMs: 2_000 });
    const atlas = backend.agents.get("atlas")!;
    await drain(hermetic.upgrade({ name: "atlas", hermes: NEXT }));
    const pinned = backend.agents.get("atlas")!;
    expect(pinned.hermes_version).toBe(NEXT);
    expect(pin(pinned).config_hash).toBe(pin(atlas).config_hash);
    boxesFail(backend, "HERMES_UPGRADE_ROLLED_BACK");
    const asked: Agent["apply_request"][] = [];
    const set = backend.agents.set.bind(backend.agents);
    backend.agents.set = ((name: string, row: Agent) => {
      if (row.apply_request?.upgrade_from) asked.push(row.apply_request);
      return set(name, row);
    }) as typeof backend.agents.set;

    let thrown: unknown = null;
    await drain(hermetic.upgrade({ name: "atlas", hermes: "0.99.1", now: true })).catch(
      (e: unknown) => {
        thrown = e;
      },
    );
    expect((thrown as { code?: string } | null)?.code).toBe("HERMES_UPGRADE_ROLLED_BACK");

    const row = backend.agents.get("atlas")!;
    // `upgrade_from` is what the box runs, not the pin it never installed…
    expect(asked[0]?.upgrade_from).toEqual({
      hermes_version: atlas.running_hermes_version!,
      config_hash: atlas.applied_config_hash!,
      config_key: atlas.resources.config_key!,
    });
    // …so the row goes back to naming it.
    expect(pin(row)).toEqual(pin(atlas));
    expect(row.lock ?? null).toBeNull();
  });

  test("a box reporting another Hermes than its applied config pins is refused before anything", async () => {
    let probed = false;
    const { backend, hermetic } = fleet({
      boxBusy: async () => {
        probed = true;
        return false;
      },
    });
    const atlas = backend.agents.get("atlas")!;
    // A swap that passed its gate and failed a later step: the new Hermes runs,
    // and the applied config still names the old one.
    backend.agents.set("atlas", { ...atlas, running_hermes_version: "0.99.2" } as Agent);
    const before = backend.agents.get("atlas")!;
    backend.resetMutations();

    const events = await drain(hermetic.upgrade({ name: "atlas", hermes: NEXT, now: true }));

    const refused = events.find((e) => e.phase === "atlas:refused");
    expect(refused?.message).toContain(
      `its box runs Hermes 0.99.2, but the config it last applied pins ${atlas.hermes_version}`,
    );
    expect(refused?.message).toContain("`hermetic plan rollout --agent atlas`");
    expect(probed).toBe(false);
    expect(backend.agents.get("atlas")).toEqual(before);
    expect(backend.mutations).toEqual([]);
  });

  test("a row on this build's pin with an unapplied config is told to converge it first", async () => {
    const { backend, hermetic } = fleet({ convergeTimeoutMs: 2_000 });
    const atlas = backend.agents.get("atlas")!;
    expect(atlas.hermes_version).toBe(BUILD_VERSIONS.hermes);
    await backend.agents.set("atlas", { ...atlas, applied_config_hash: "unapplied" } as Agent);
    boxesFail(backend, "HERMES_UPGRADE_ROLLED_BACK");

    const events = await drain(hermetic.upgrade({ name: "atlas", hermes: "0.99.1", now: true }));

    const refused = events.find((e) => e.phase === "atlas:refused");
    expect(refused?.message).toContain(
      "converge it first with `hermetic plan rollout --agent atlas`, and nothing was changed",
    );
    expect(refused?.message).not.toContain("pin without --now");
  });

  for (const code of ["HERMES_ROLLBACK_FAILED", "HERMES_RESTORE_FAILED"])
    test(`a failed undo (${code}) keeps the new pin, says Hermes is down, and fails the run`, async () => {
      const { backend, hermetic } = fleet({ convergeTimeoutMs: 2_000 });
      const original = backend.agents.set.bind(backend.agents);
      // atlas fails its rollback; every other box answers, as `boxesAnswer` does.
      backend.agents.set = ((name: string, row: Agent) => {
        const req = row.apply_request;
        if (!req || row.applied_config_hash === req.config_hash) return original(name, row);
        if (name !== "atlas") return original(name, { ...row, applied_config_hash: req.config_hash });
        if (row.apply_failure?.request_id === req.id) return original(name, row);
        return original(name, {
          ...row,
          apply_failure: {
            request_id: req.id,
            config_hash: req.config_hash,
            code,
            at: "2026-11-15T00:00:00.000Z",
          },
        });
      }) as typeof backend.agents.set;
      const events: OpEvent[] = [];

      let thrown: unknown = null;
      try {
        for await (const e of hermetic.upgrade({ all: true, hermes: NEXT, now: true, force: true })) {
          events.push(e);
        }
      } catch (e) {
        thrown = e;
      }

      expect((thrown as { code?: string } | null)?.code).toBe("HERMES_UPGRADE_FAILED");
      expect(backend.agents.get("atlas")?.hermes_version).toBe(NEXT);
      const failed = events.find((e) => e.phase === "atlas:failed");
      expect(failed?.level).toBe("error");
      expect(failed?.message).toContain("Hermes is down");
      expect(failed?.message).toContain(code);
      expect(failed?.message).toContain("hermetic agent history atlas");
      // `--all` stopped at atlas: nothing after it, and no closing tally.
      expect(events.at(-1)).toBe(failed);
      const order = (await backend.store.agents.scan()).map((a) => a.name);
      const rest = order.slice(order.indexOf("atlas") + 1);
      expect(rest.length).toBeGreaterThan(0);
      for (const name of rest) expect(backend.agents.get(name)?.hermes_version).not.toBe(NEXT);
    });

  test("the laptop stopped waiting, the box later rolled back: the next rollout restores the old pin and converges it", async () => {
    const { backend, hermetic } = fleet({ convergeTimeoutMs: 5 });
    const before = backend.agents.get("atlas")!;

    const first = await drain(hermetic.upgrade({ name: "atlas", hermes: NEXT, now: true }));
    expect(first.some((e) => e.phase === "atlas:unconverged")).toBe(true);
    const pinned = backend.agents.get("atlas")!;
    const req = pinned.apply_request!;
    expect(pinned.hermes_version).toBe(NEXT);
    expect(req.upgrade_from).toEqual({
      hermes_version: before.hermes_version,
      config_hash: before.config_hash ?? null,
      config_key: before.resources.config_key,
    });

    // The box answers long after: it rolled back and runs the old Hermes.
    backend.agents.set("atlas", {
      ...pinned,
      apply_failure: {
        request_id: req.id,
        config_hash: req.config_hash,
        code: "HERMES_UPGRADE_ROLLED_BACK",
        at: "2026-11-15T00:40:00.000Z",
      },
    });

    const plan = await hermetic.plan.rollout({ agents: ["atlas"] });
    const events = await drain(hermetic.apply({ plan, yes: true }));

    const row = backend.agents.get("atlas")!;
    expect(pin(row)).toEqual(pin(before));
    // Never the refused version again: one request, for the restored config,
    // so a box that dropped its applied config re-renders for the old Hermes.
    expect(row.apply_request?.id).not.toBe(req.id);
    expect(row.apply_request?.config_hash).toBe(before.config_hash ?? "");
    expect(row.apply_request?.upgrade_from).toBeUndefined();
    expect(events.some((e) => e.phase === "atlas:requested")).toBe(false);
    const history = await backend.store.events.query("atlas");
    expect(
      history.some((e) => e.action === "upgrade" && e.detail?.includes("HERMES_UPGRADE_ROLLED_BACK")),
    ).toBe(true);
  });

  test("the next upgrade settles a late rollback first, so it starts from the Hermes the box runs", async () => {
    const { backend, hermetic } = fleet({ convergeTimeoutMs: 5 });
    const before = backend.agents.get("atlas")!;
    await drain(hermetic.upgrade({ name: "atlas", hermes: NEXT, now: true }));
    const pinned = backend.agents.get("atlas")!;
    backend.agents.set("atlas", {
      ...pinned,
      apply_failure: {
        request_id: pinned.apply_request!.id,
        config_hash: pinned.apply_request!.config_hash,
        code: "HERMES_UPGRADE_ROLLED_BACK",
        at: "2026-11-15T00:40:00.000Z",
      },
    });

    await drain(hermetic.upgrade({ name: "atlas", hermes: "0.99.1", now: true }));

    expect(backend.agents.get("atlas")?.apply_request?.upgrade_from?.hermes_version).toBe(
      before.hermes_version,
    );
  });

  test("a failure after the swap began keeps the new pin", async () => {
    const { backend, hermetic } = fleet({ convergeTimeoutMs: 2_000 });
    boxesFail(backend, "COMMAND_FAILED");

    const events = await drain(hermetic.upgrade({ name: "atlas", hermes: NEXT, now: true }));

    const row = backend.agents.get("atlas")!;
    expect(row.hermes_version).toBe(NEXT);
    const failed = events.find((e) => e.phase === "atlas:failed");
    expect(failed?.level).toBe("warn");
    expect(failed?.message).toContain("COMMAND_FAILED");
    expect(failed?.message).toContain("repairs forward");
    expect(events.at(-1)?.message).toBe(
      `pinned 1 agent(s) to hermes ${NEXT}: 0 converged, 0 skipped, 1 unconverged`,
    );
  });

  test("a failure report for an older request is not this one's", async () => {
    const { backend, hermetic } = fleet({ convergeTimeoutMs: 5 });
    const row = backend.agents.get("atlas")!;
    backend.agents.set("atlas", {
      ...row,
      apply_failure: {
        request_id: "old",
        config_hash: "0000",
        code: "HERMES_BACKUP_FAILED",
        at: "2026-11-01T00:00:00.000Z",
      },
    });

    const events = await drain(hermetic.upgrade({ name: "atlas", hermes: NEXT, now: true }));

    expect(backend.agents.get("atlas")?.hermes_version).toBe(NEXT);
    expect(events.some((e) => e.phase === "atlas:unconverged")).toBe(true);
  });
});

/** A rollout reads the box's failure report for its own request (§6.5). */
describe("plan rollout: the box's failure report", () => {
  test("a failed converge is reported with its code, not as a silent box", async () => {
    const { backend, hermetic } = fleet({ convergeTimeoutMs: 2_000 });
    onBuildHermes(backend);
    // Work for the rollout: a pin to another Hermes would now be deferred as held.
    backend.agents.set("atlas", {
      ...backend.agents.get("atlas")!,
      applied_config_hash: "0000000000000000",
    });
    boxesFail(backend, "COMMAND_FAILED");

    const plan = await hermetic.plan.rollout({ agents: ["atlas"] });
    const events = await drain(hermetic.apply({ plan, yes: true }));

    const failed = events.find((e) => e.phase === "atlas:failed");
    expect(failed?.level).toBe("warn");
    expect(failed?.message).toContain("COMMAND_FAILED");
    expect(messages(events)).not.toContain("has not reported config");
    expect(events.at(-1)?.message).toContain("0 converged, 0 skipped, 1 unconverged");
  });

  test("Hermes left down on the box stops the rollout", async () => {
    const { backend, hermetic } = fleet({ convergeTimeoutMs: 2_000 });
    onBuildHermes(backend);
    // Work for the rollout: a pin to another Hermes would now be deferred as held.
    backend.agents.set("atlas", {
      ...backend.agents.get("atlas")!,
      applied_config_hash: "0000000000000000",
    });
    boxesFail(backend, "HERMES_ROLLBACK_FAILED");

    const plan = await hermetic.plan.rollout({ agents: ["atlas"] });
    const events: OpEvent[] = [];
    let thrown: unknown = null;
    try {
      for await (const e of hermetic.apply({ plan, yes: true })) events.push(e);
    } catch (e) {
      thrown = e;
    }

    expect((thrown as { code?: string } | null)?.code).toBe("HERMES_UPGRADE_FAILED");
    const failed = events.find((e) => e.phase === "atlas:failed");
    expect(failed?.level).toBe("error");
    expect(failed?.message).toContain("Hermes is down");
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
    // A rollout defers a pin its box does not run, so it is not offered as a way to land one.
    expect(render.message).not.toContain("plan rollout");
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
