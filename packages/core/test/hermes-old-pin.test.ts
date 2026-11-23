/**
 * §6.5: a fleet whose agents run an older Hermes than this build's pin stays
 * safe and manageable. Every render pins the row's own ref (`hermesRefFor`),
 * so an agent on 0.21.5 is managed on 0.21.5; the only thing that changes the
 * Hermes a box runs is an explicit `upgrade --hermes V --now`.
 *
 * - I1: publishing new artifacts to such a fleet converges nothing.
 * - I2: no automatic path, nor `plan rollout`, starts a Hermes change.
 * - I3: an old-pin agent takes `set`, a rollout and a recreate on its own Hermes.
 * - I5: every `upgrade` refusal comes before any write.
 * - C1/C2: a pin moved without `--now` changes nothing but the pin, and `set`
 *   refuses to arm it.
 */
import { describe, expect, test } from "bun:test";
import { BUILD_VERSIONS } from "../src/build-versions.ts";
import { FIXTURE_CONFIG, MemoryBackend, seedFixtureFleet } from "../src/backend/memory.ts";
import { renderAgentRow } from "../src/agents/agent-runtime.ts";
import { rolledBackFrom } from "../src/agents/converge.ts";
import { configManifestOf } from "../src/release/tar.ts";
import { HermeticError, isHermeticError } from "../src/errors.ts";
import { hermesRefFor, hermesTagVersion } from "../src/shared/hermes.ts";
import type { Agent, AgentConfig, OpEvent } from "../src/schema/index.ts";
import { drain, onBuildHermes, testHermetic } from "./helpers.ts";

const OLD = "0.21.5";
const OLD_REF = "v2026.9.24";
const PIN = BUILD_VERSIONS.hermes;

function fleet() {
  const backend = seedFixtureFleet(new MemoryBackend({ directory: "seeded" }));
  onBuildHermes(backend);
  const hermetic = testHermetic({
    backend,
    config: FIXTURE_CONFIG,
    rollout: { convergeTimeoutMs: 5, convergePollMs: 1, idleTimeoutMs: 5, idlePollMs: 1 },
  });
  return { backend, hermetic };
}

/** `name` as a 0.21.5 build left it: its own render uploaded, applied, and running. */
function onOldHermes(backend: MemoryBackend, name: string): Agent {
  const { region, tailnet } = backend.fleetItem!;
  const row = { ...backend.agents.get(name)!, hermes_version: OLD };
  const { config_hash, key, tarball } = renderAgentRow(row, region, tailnet);
  backend.objects.set(key, tarball);
  const next = {
    ...row,
    config_hash,
    applied_config_hash: config_hash,
    running_hermes_version: OLD,
    resources: { ...row.resources, config_key: key },
  } as Agent;
  backend.agents.set(name, next);
  return next;
}

/** The manifest of the config a row names, read back out of the bucket. */
function manifestOf(backend: MemoryBackend, row: Agent): AgentConfig {
  return configManifestOf(backend.objects.get(row.resources.config_key!) ?? null) as AgentConfig;
}

async function codeOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (e) {
    return isHermeticError(e) ? e.code : String(e);
  }
}

describe("hermesRefFor", () => {
  test.each([
    ["0.23.1", "v0.23.1"],
    ["0.21.6", "v0.21.6"],
    ["0.99.0", "v0.99.0"],
    ["1.2.0", "v1.2.0"],
    ["0.21.5", OLD_REF],
    ["0.21.4", null],
    ["0.21.0", null],
    ["0.14.2", null],
    ["0.23.1-rc1", null],
    ["v0.23.1", null],
    ["", null],
  ])("%p -> %p", (version, ref) => {
    expect(hermesRefFor(version)).toBe(ref);
  });

  test("is the inverse of hermesTagVersion for every SemVer ref, and this build's pin has one", () => {
    for (const v of ["0.21.6", "0.23.1", "1.0.0"]) expect(hermesTagVersion(hermesRefFor(v)!)).toBe(v);
    expect(hermesRefFor(BUILD_VERSIONS.hermes)).toBe(BUILD_VERSIONS.hermes_ref);
  });
});

describe("hermesRefFor's ref on a 0.21.5 row", () => {
  test("renders its own ref, and asks nothing of the 0.22 install path", () => {
    const { backend } = fleet();
    const row = onOldHermes(backend, "atlas");
    const m = manifestOf(backend, row);
    expect([m.hermes_version, m.hermes_ref]).toEqual([OLD, OLD_REF]);
    expect(m.requires ?? []).not.toContain("hermes-0.22-install");
  });
});

describe("I1: a push to a fleet on an older Hermes changes nothing but hermeticd", () => {
  test("artifacts push and foundation update converge no old-pin agent, and keep its bundle", async () => {
    const { backend, hermetic } = fleet();
    const names = ["atlas", "ibis", "lumen"];
    for (const n of names) {
      // What the 0.21.5 build uploaded: its own render, which this build's differs from.
      const row = onOldHermes(backend, n);
      const older = `config/${n}/0ld0ld0ld0ld0ld0.tgz`;
      backend.objects.set(older, backend.objects.get(row.resources.config_key!)!);
      backend.agents.set(n, {
        ...row,
        config_hash: "0ld0ld0ld0ld0ld0",
        applied_config_hash: "0ld0ld0ld0ld0ld0",
        resources: { ...row.resources, config_key: older },
      } as Agent);
    }
    const before = names.map((n) => backend.agents.get(n)!);

    const pushed = await drain(hermetic.artifacts.push({}));
    await drain(hermetic.foundation.update({ yes: true }));

    for (const row of before) {
      const after = backend.agents.get(row.name)!;
      expect(after.hermes_version).toBe(OLD);
      expect(after.config_hash).toBe(row.config_hash!);
      expect(after.resources.config_key).toBe(row.resources.config_key!);
      expect(after.apply_request ?? null).toEqual(row.apply_request ?? null);
      expect(backend.objects.has(row.resources.config_key!)).toBe(true);
      expect(
        pushed.some((e) =>
          e.message.startsWith(`${row.name}: config not converged — held on Hermes ${OLD}`),
        ),
      ).toBe(true);
    }
  });
});

describe("I2: no automatic path starts a Hermes change", () => {
  /** Pinned to this build's Hermes without `--now`, on a box still running 0.21.5. */
  async function pendingPin(running: string | null) {
    const f = fleet();
    onOldHermes(f.backend, "atlas");
    await drain(f.hermetic.upgrade({ name: "atlas", hermes: PIN }));
    const row = f.backend.agents.get("atlas")!;
    f.backend.agents.set("atlas", { ...row, running_hermes_version: running } as Agent);
    return { ...f, row: f.backend.agents.get("atlas")! };
  }

  for (const running of [OLD, null]) {
    test(`push, foundation update and plan rollout defer it (box reports ${String(running)})`, async () => {
      const { backend, hermetic, row } = await pendingPin(running);
      const pushed = await drain(hermetic.artifacts.push({}));
      await drain(hermetic.foundation.update({ yes: true }));
      const plan = await hermetic.plan.rollout({ agents: ["atlas"] });
      await drain(hermetic.apply({ plan, yes: true }));

      const after = backend.agents.get("atlas")!;
      expect(after.apply_request ?? null).toEqual(row.apply_request ?? null);
      expect(after.config_hash).toBe(row.config_hash!);
      const why = `\`hermetic upgrade --hermes ${PIN} atlas --now\` installs it`;
      expect(plan.steps[0]!.description).toContain(why);
      expect(pushed.some((e) => e.message.includes(why))).toBe(true);
      // An unreported box is judged by the config it last applied, which pins 0.21.5.
      expect(plan.steps[0]!.description).toContain(`its box runs ${OLD}`);
    });
  }

  test("a box that has not reported and whose applied config cannot be read still defers", async () => {
    const { backend, hermetic, row } = await pendingPin(null);
    backend.objects.delete(row.resources.config_key!);
    const plan = await hermetic.plan.rollout({ agents: ["atlas"] });
    await drain(hermetic.apply({ plan, yes: true }));
    expect(plan.steps[0]!.description).toContain("has not reported which Hermes it runs yet");
    expect(backend.agents.get("atlas")!.apply_request ?? null).toEqual(row.apply_request ?? null);
  });

  test("a box that has not reported but applied a config on its pin is converged", async () => {
    const { backend, hermetic } = fleet();
    const row = onOldHermes(backend, "atlas");
    backend.agents.set("atlas", { ...row, running_hermes_version: null } as Agent);
    await hermetic.agents.set({ name: "atlas", hermes: { max_turns: 42 } });
    const plan = await hermetic.plan.rollout({ agents: ["atlas"] });
    expect(plan.steps[0]!.description).not.toContain("skipped");
    await drain(hermetic.apply({ plan, yes: true }));
    const after = backend.agents.get("atlas")!;
    expect(after.hermes_version).toBe(OLD);
    expect(after.apply_request?.config_hash).toBe(after.config_hash!);
    expect(after.apply_request?.upgrade_from).toBeUndefined();
    expect(manifestOf(backend, after).hermes_version).toBe(OLD);
  });

  test("foundation status does not offer a row whose box has not reported", async () => {
    const { backend, hermetic } = fleet();
    const row = backend.agents.get("atlas")!;
    backend.agents.set("atlas", {
      ...row,
      hermes_version: PIN,
      running_hermes_version: null,
      config_hash: "old",
      applied_config_hash: "old",
    } as Agent);
    const status = await hermetic.foundation.status();
    expect(status.agents.find((a) => a.name === "atlas")?.config).not.toBe("update");
    // The same row with a report on its pin is offered: the filter is what held it.
    backend.agents.set("atlas", { ...backend.agents.get("atlas")!, running_hermes_version: PIN });
    const reported = await hermetic.foundation.status();
    expect(reported.agents.find((a) => a.name === "atlas")?.config).toBe("update");
  });

  test("foundation status does not offer it as an update, so the app starts no push for it", async () => {
    const { hermetic } = await pendingPin(OLD);
    const status = await hermetic.foundation.status();
    expect(status.agents.find((a) => a.name === "atlas")?.config).not.toBe("update");
  });
});

describe("I3: an old-pin agent is managed on its own Hermes", () => {
  test("set re-renders on its own ref, and a rollout converges it with no swap", async () => {
    const { backend, hermetic } = fleet();
    onOldHermes(backend, "atlas");
    await hermetic.agents.set({ name: "atlas", hermes: { max_turns: 42 } });
    const row = backend.agents.get("atlas")!;
    expect(row.hermes_version).toBe(OLD);
    expect(manifestOf(backend, row).hermes_ref).toBe(OLD_REF);

    const plan = await hermetic.plan.rollout({ agents: ["atlas"] });
    expect(plan.steps[0]!.description).not.toContain("skipped");
    await drain(hermetic.apply({ plan, yes: true }));
    const after = backend.agents.get("atlas")!;
    expect(after.apply_request?.config_hash).toBe(row.config_hash!);
    expect(after.apply_request?.upgrade_from).toBeUndefined();
    expect(after.hermes_version).toBe(OLD);
  });

  test("plan recreate and recreate keep it on its version", async () => {
    const { backend, hermetic } = fleet();
    onOldHermes(backend, "atlas");
    await hermetic.plan.recreate({ name: "atlas" });
    await drain(hermetic.agents.recreate({ name: "atlas", yes: true }));
    const row = backend.agents.get("atlas")!;
    expect(row.hermes_version).toBe(OLD);
    expect(manifestOf(backend, row).hermes_ref).toBe(OLD_REF);
  });

  test("stop, start and rerun leave its pin and config alone", async () => {
    const { backend, hermetic } = fleet();
    const before = onOldHermes(backend, "atlas");
    await drain(hermetic.agents.stop("atlas"));
    await drain(hermetic.agents.start("atlas"));
    backend.agents.set("atlas", { ...backend.agents.get("atlas")!, status: "error" } as Agent);
    await hermetic.agents.rerun({ name: "atlas" });
    const after = backend.agents.get("atlas")!;
    expect([after.hermes_version, after.config_hash]).toEqual([OLD, before.config_hash!]);
  });
});

describe("C1/C2: a pin moved without --now", () => {
  test("writes the pin and nothing else: no render, no upload, no request", async () => {
    const { backend, hermetic } = fleet();
    const before = onOldHermes(backend, "atlas");
    const objects = [...backend.objects.keys()];
    await drain(hermetic.upgrade({ name: "atlas", hermes: PIN }));
    const after = backend.agents.get("atlas")!;
    expect(after.hermes_version).toBe(PIN);
    expect(after.config_hash).toBe(before.config_hash!);
    expect(after.resources.config_key).toBe(before.resources.config_key!);
    expect(after.apply_request ?? null).toEqual(before.apply_request ?? null);
    expect([...backend.objects.keys()].filter((k) => k.startsWith("config/"))).toEqual(
      objects.filter((k) => k.startsWith("config/")),
    );
    // A boot or rerun resumes toward the row's config, which still pins 0.21.5.
    await drain(hermetic.agents.stop("atlas"));
    await drain(hermetic.agents.start("atlas"));
    expect(backend.agents.get("atlas")!.config_hash).toBe(before.config_hash!);
  });

  for (const running of [OLD, null]) {
    test(`set refuses to arm it and writes nothing (box reports ${String(running)})`, async () => {
      const { backend, hermetic } = fleet();
      onOldHermes(backend, "atlas");
      await drain(hermetic.upgrade({ name: "atlas", hermes: PIN }));
      backend.agents.set("atlas", {
        ...backend.agents.get("atlas")!,
        running_hermes_version: running,
      } as Agent);
      const before = backend.agents.get("atlas")!;
      backend.resetMutations();
      let message = "";
      try {
        await hermetic.agents.set({ name: "atlas", hermes: { max_turns: 42 } });
      } catch (e) {
        expect(isHermeticError(e) && e.code).toBe("HERMES_UPGRADE_REQUIRED");
        message = (e as Error).message;
      }
      expect(message).toContain(`\`hermetic upgrade --hermes ${PIN} atlas --now\``);
      expect(message).toContain("`hermetic plan recreate atlas`");
      expect(message).toContain(`\`hermetic upgrade --hermes ${OLD} atlas\``);
      expect(backend.mutations).toEqual([]);
      expect(backend.agents.get("atlas")).toEqual(before);
    });
  }

  test("pinning back to what the box runs leaves the row clean, and set works", async () => {
    const { backend, hermetic } = fleet();
    const before = onOldHermes(backend, "atlas");
    await drain(hermetic.upgrade({ name: "atlas", hermes: PIN }));
    await drain(hermetic.upgrade({ name: "atlas", hermes: OLD }));
    const back = backend.agents.get("atlas")!;
    expect([back.hermes_version, back.config_hash]).toEqual([OLD, before.config_hash!]);
    const next = await hermetic.agents.set({ name: "atlas", hermes: { max_turns: 42 } });
    expect(next.hermes?.max_turns).toBe(42);
  });

  test("--now after it lands the pin, naming the Hermes the box runs as upgrade_from", async () => {
    const { backend, hermetic } = fleet();
    const before = onOldHermes(backend, "atlas");
    await drain(hermetic.upgrade({ name: "atlas", hermes: PIN }));
    await drain(hermetic.upgrade({ name: "atlas", hermes: PIN, now: true, force: true }));
    const row = backend.agents.get("atlas")!;
    expect(row.apply_request?.upgrade_from).toEqual({
      hermes_version: OLD,
      config_hash: before.config_hash!,
      config_key: before.resources.config_key!,
    });
    expect(manifestOf(backend, row).hermes_ref).toBe(BUILD_VERSIONS.hermes_ref);
  });
});

describe("C3: a config naming a Hermes its box does not run is only an explicit --now", () => {
  const THIRD = "0.99.0";
  /** What a refused upgrade must leave as it was; the lock it took and gave back moves only `version`. */
  const published = (row: Agent | undefined) => ({
    hermes_version: row?.hermes_version,
    config_hash: row?.config_hash ?? null,
    config_key: row?.resources.config_key,
    apply_request: row?.apply_request ?? null,
    lock: row?.lock ?? null,
  });
  const configKeys = (backend: MemoryBackend) =>
    [...backend.objects.keys()].filter((k) => k.startsWith("config/")).sort();

  /** An `upgrade --now` to this build's pin that the box never answered: the row is armed. */
  async function armed() {
    const f = fleet();
    const old = onOldHermes(f.backend, "atlas");
    await drain(f.hermetic.upgrade({ name: "atlas", hermes: PIN, now: true, force: true }));
    const row = f.backend.agents.get("atlas")!;
    expect(row.config_hash).not.toBe(old.config_hash!);
    expect(row.applied_config_hash).toBe(old.config_hash!);
    expect(manifestOf(f.backend, row).hermes_version).toBe(PIN);
    return { ...f, old, row };
  }

  /** Runs `upgrade` and returns the refusal's message, failing if it was not refused. */
  async function refusal(run: AsyncIterable<OpEvent>): Promise<string> {
    try {
      await drain(run);
    } catch (e) {
      expect(isHermeticError(e) && e.code).toBe("HERMES_UPGRADE_REQUIRED");
      return (e as Error).message;
    }
    throw new Error("not refused");
  }

  test("--now on a box that is not up but whose Hermes is known records the pin only", async () => {
    const { backend, hermetic } = fleet();
    const old = onOldHermes(backend, "atlas");
    // `stopping` keeps what the box reported; only a finished stop clears it.
    backend.agents.set("atlas", { ...old, status: "stopping" } as Agent);
    const objects = configKeys(backend);
    const events = await drain(hermetic.upgrade({ name: "atlas", hermes: PIN, now: true }));
    const after = backend.agents.get("atlas")!;
    expect(after.hermes_version).toBe(PIN);
    expect(after.config_hash).toBe(old.config_hash!);
    expect(after.resources.config_key).toBe(old.resources.config_key!);
    expect(after.apply_request ?? null).toEqual(old.apply_request ?? null);
    expect(configKeys(backend)).toEqual(objects);
    const skipped = events.find((e) => e.phase === "atlas:skipped");
    expect(skipped?.message).toContain("atlas is not up (stopping), so nothing was applied");
    expect(skipped?.message).toContain("`hermetic plan recreate atlas`");
  });

  test("a clean stopped row never asked to converge takes a pin ahead; start boots its own config", async () => {
    const { backend, hermetic } = fleet();
    const old = onOldHermes(backend, "atlas");
    expect(old.apply_request ?? null).toBeNull();
    await drain(hermetic.agents.stop("atlas"));
    expect(backend.agents.get("atlas")!.applied_config_hash ?? null).toBeNull();
    const objects = configKeys(backend);
    for (const now of [false, true]) {
      const events = await drain(hermetic.upgrade({ name: "atlas", hermes: PIN, now }));
      const after = backend.agents.get("atlas")!;
      expect(after.hermes_version).toBe(PIN);
      expect(after.config_hash).toBe(old.config_hash!);
      expect(after.resources.config_key).toBe(old.resources.config_key!);
      expect(after.apply_request ?? null).toBeNull();
      expect(configKeys(backend)).toEqual(objects);
      if (now) {
        const skipped = events.find((e) => e.phase === "atlas:skipped")?.message ?? "";
        expect(skipped).toContain("atlas is not up (stopped), so nothing was applied");
        expect(skipped).toContain("`hermetic plan recreate atlas`");
      }
    }
    await drain(hermetic.agents.start("atlas"));
    const started = backend.agents.get("atlas")!;
    expect(started.config_hash).toBe(old.config_hash!);
    expect(manifestOf(backend, started).hermes_version).toBe(OLD);
  });

  /**
   * An upgrade by recreate whose fresh box failed its first start: the row
   * names the new Hermes, the box applied and reported nothing, and no
   * converge was ever asked of it. Status `error` is the box's own report.
   */
  async function failedRecreate() {
    const f = fleet();
    onOldHermes(f.backend, "atlas");
    await drain(f.hermetic.upgrade({ name: "atlas", hermes: PIN }));
    await drain(
      f.hermetic.apply({ plan: await f.hermetic.plan.recreate({ name: "atlas" }), yes: true }),
    );
    const fresh = (await f.backend.store.agents.get("atlas"))!;
    await f.backend.store.agents.update("atlas", fresh.version, { status: "error" });
    const row = f.backend.agents.get("atlas")!;
    expect(manifestOf(f.backend, row).hermes_version).toBe(PIN);
    expect(row.applied_config_hash ?? null).toBeNull();
    expect(row.running_hermes_version ?? null).toBeNull();
    expect(row.apply_request ?? null).toBeNull();
    return { ...f, row };
  }

  test("a recreate whose new Hermes fails to start is pinned back and recreated on the old one", async () => {
    const { backend, hermetic, row } = await failedRecreate();
    await drain(hermetic.upgrade({ name: "atlas", hermes: OLD }));
    const pinned = backend.agents.get("atlas")!;
    expect(pinned.hermes_version).toBe(OLD);
    expect(pinned.config_hash).toBe(row.config_hash!);
    expect(pinned.resources.config_key).toBe(row.resources.config_key!);

    await drain(hermetic.apply({ plan: await hermetic.plan.recreate({ name: "atlas" }), yes: true }));
    const back = backend.agents.get("atlas")!;
    expect(back.hermes_version).toBe(OLD);
    expect(manifestOf(backend, back).hermes_ref).toBe(OLD_REF);
  });

  test("--now on that failed row refuses before any write and names rerun and recreate", async () => {
    const { backend, hermetic, row } = await failedRecreate();
    backend.resetMutations();
    const events = await drain(
      hermetic.upgrade({ name: "atlas", hermes: OLD, now: true, force: true }),
    );
    const refused = events.find((e) => e.phase === "atlas:refused")?.message ?? "";
    expect(refused).toContain("its box has never applied a config");
    expect(refused).toContain("`hermetic plan recreate atlas`");
    // The exit that does not retry the version that failed to start.
    expect(refused).toContain(
      "or pin another Hermes with `hermetic upgrade --hermes <version> atlas` (no `--now`) and then " +
        "`hermetic plan recreate atlas`",
    );
    expect(backend.mutations).toEqual([]);
    expect(backend.agents.get("atlas")).toEqual(row);
  });

  test("R1: an armed row, stopped, refuses a pin back with and without --now; start keeps it whole", async () => {
    const { backend, hermetic } = await armed();
    await drain(hermetic.agents.stop("atlas"));
    const before = backend.agents.get("atlas")!;
    expect(before.running_hermes_version ?? null).toBeNull();
    const objects = configKeys(backend);
    for (const now of [false, true]) {
      const message = await refusal(hermetic.upgrade({ name: "atlas", hermes: OLD, now }));
      expect(message).toContain(
        "atlas is not up (stopped), so hermetic cannot tell which Hermes its box holds",
      );
      expect(published(backend.agents.get("atlas"))).toEqual(published(before));
      expect(configKeys(backend)).toEqual(objects);
    }
    await drain(hermetic.agents.start("atlas"));
    const row = backend.agents.get("atlas")!;
    expect(row.hermes_version).toBe(PIN);
    expect(manifestOf(backend, row).hermes_version).toBe(row.hermes_version);
  });

  test("an armed row refuses a pin-only write to a third version, and writes nothing", async () => {
    const { backend, hermetic, row } = await armed();
    const objects = configKeys(backend);
    for (const now of [false, true]) {
      // `stopping` is not up and keeps what the box reported, so the row reads as armed.
      if (now) backend.agents.set("atlas", { ...row, status: "stopping" } as Agent);
      const before = backend.agents.get("atlas")!;
      let message = "";
      try {
        await drain(hermetic.upgrade({ name: "atlas", hermes: THIRD, now }));
      } catch (e) {
        expect(isHermeticError(e) && e.code).toBe("HERMES_UPGRADE_REQUIRED");
        message = (e as Error).message;
      }
      expect(message).toContain(`finish it with \`hermetic upgrade --hermes ${PIN} atlas --now\``);
      expect(message).toContain(`cancel it with \`hermetic upgrade --hermes ${OLD} atlas --now\``);
      expect(published(backend.agents.get("atlas"))).toEqual(published(before));
      expect(configKeys(backend)).toEqual(objects);
    }
  });

  test("an armed row whose config cannot be read refuses a pin-only write", async () => {
    const { backend, hermetic, row } = await armed();
    backend.objects.delete(row.resources.config_key!);
    const before = backend.agents.get("atlas")!;
    expect(await codeOf(() => drain(hermetic.upgrade({ name: "atlas", hermes: THIRD })))).toBe(
      "HERMES_UPGRADE_REQUIRED",
    );
    expect(published(backend.agents.get("atlas"))).toEqual(published(before));
  });

  test("set on an armed row names the --now exits", async () => {
    const { hermetic } = await armed();
    let message = "";
    try {
      await hermetic.agents.set({ name: "atlas", hermes: { max_turns: 42 } });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain(`finish it with \`hermetic upgrade --hermes ${PIN} atlas --now\``);
    expect(message).toContain(`cancel it with \`hermetic upgrade --hermes ${OLD} atlas --now\``);
  });

  test("the cancel exit re-renders at the running version and disarms the row", async () => {
    const { backend, hermetic, old } = await armed();
    const events = await drain(
      hermetic.upgrade({ name: "atlas", hermes: OLD, now: true, force: true }),
    );
    const after = backend.agents.get("atlas")!;
    expect(after.hermes_version).toBe(OLD);
    expect(manifestOf(backend, after).hermes_version).toBe(OLD);
    expect(after.config_hash).toBe(old.config_hash!);
    expect(after.applied_config_hash).toBe(after.config_hash!);
    expect(events.find((e) => e.phase === "atlas:done")).toBeTruthy();
    // Disarmed: a pin-only write is plain again.
    await drain(hermetic.upgrade({ name: "atlas", hermes: THIRD }));
    expect(backend.agents.get("atlas")!.config_hash).toBe(old.config_hash!);
  });

  test("set refuses when the row's config cannot be read, and writes nothing", async () => {
    const { backend, hermetic } = fleet();
    onOldHermes(backend, "atlas");
    await drain(hermetic.upgrade({ name: "atlas", hermes: PIN }));
    await drain(hermetic.agents.stop("atlas"));
    const before = backend.agents.get("atlas")!;
    expect(before.running_hermes_version ?? null).toBeNull();
    backend.artifacts.getObject = async () => {
      throw new HermeticError("FORBIDDEN", "the bucket refused");
    };
    backend.resetMutations();
    expect(await codeOf(() => hermetic.agents.set({ name: "atlas", hermes: { max_turns: 42 } }))).toBe(
      "FORBIDDEN",
    );
    expect(backend.mutations).toEqual([]);
    expect(backend.agents.get("atlas")).toEqual(before);
  });

  test("recreate of a row whose box rolled back installs the Hermes the box kept", async () => {
    const { backend, hermetic } = fleet();
    const old = onOldHermes(backend, "atlas");
    const { region, tailnet } = backend.fleetItem!;
    const next = renderAgentRow({ ...old, hermes_version: PIN }, region, tailnet);
    backend.objects.set(next.key, next.tarball);
    const id = `${next.config_hash}-rb`;
    backend.agents.set("atlas", {
      ...old,
      hermes_version: PIN,
      config_hash: next.config_hash,
      resources: { ...old.resources, config_key: next.key },
      apply_request: {
        id,
        config_hash: next.config_hash,
        issued_at: "2026-11-15T00:00:00.000Z",
        issued_by: "test",
        upgrade_from: {
          hermes_version: OLD,
          config_hash: old.config_hash!,
          config_key: old.resources.config_key!,
        },
      },
      apply_failure: {
        request_id: id,
        config_hash: next.config_hash,
        code: "HERMES_UPGRADE_ROLLED_BACK",
        at: "2026-11-15T00:00:00.000Z",
      },
    } as Agent);
    await drain(hermetic.agents.recreate({ name: "atlas", yes: true }));
    const row = backend.agents.get("atlas")!;
    expect(row.hermes_version).toBe(OLD);
    expect(manifestOf(backend, row).hermes_ref).toBe(OLD_REF);
  });

  test("R2: set on a stopped row whose box rolled back renders on the Hermes the box kept", async () => {
    const { backend, hermetic, row } = await armed();
    // The box answered after the laptop stopped waiting: it rolled back to 0.21.5.
    backend.agents.set("atlas", {
      ...row,
      apply_failure: {
        request_id: row.apply_request!.id,
        config_hash: row.config_hash!,
        code: "HERMES_UPGRADE_ROLLED_BACK",
        at: "2026-11-15T00:00:00.000Z",
      },
    } as Agent);
    await drain(hermetic.agents.stop("atlas"));
    await hermetic.agents.set({ name: "atlas", hermes: { max_turns: 42 } });
    const after = backend.agents.get("atlas")!;
    expect(after.hermes_version).toBe(OLD);
    expect(manifestOf(backend, after).hermes_version).toBe(OLD);
    expect(after.hermes?.max_turns).toBe(42);
    expect(after.lock ?? null).toBeNull();
    // What a start hands the box is the config the row names: 0.21.5, not the refused pin.
    await drain(hermetic.agents.start("atlas"));
    const started = backend.agents.get("atlas")!;
    expect(started.hermes_version).toBe(OLD);
    expect(manifestOf(backend, started).hermes_version).toBe(OLD);
  });
});

describe("I5: upgrade refuses before it writes anything", () => {
  test("a version with no known ref, before either half of the command", async () => {
    const { backend, hermetic } = fleet();
    backend.resetMutations();
    expect(
      await codeOf(() => drain(hermetic.upgrade({ all: true, hermeticd: "0.5.0", hermes: "0.21.0" }))),
    ).toBe("VALIDATION");
    expect(backend.mutations).toEqual([]);
  });

  for (const now of [true, false]) {
    test(`a published hermeticd that cannot install the target names artifacts push (now: ${String(now)})`, async () => {
      let probed = false;
      const backend = seedFixtureFleet(new MemoryBackend({ directory: "seeded" }));
      onBuildHermes(backend);
      const hermetic = testHermetic({
        backend,
        config: FIXTURE_CONFIG,
        rollout: {
          convergeTimeoutMs: 5,
          convergePollMs: 1,
          boxBusy: async () => {
            probed = true;
            return false;
          },
        },
      });
      onOldHermes(backend, "atlas");
      const manifest = JSON.parse(new TextDecoder().decode(backend.objects.get("manifest.json")!)) as {
        hermeticd: Record<string, unknown>;
      };
      manifest.hermeticd = { ...manifest.hermeticd, capabilities: ["managed-env", "browser-stack"] };
      backend.objects.set("manifest.json", new TextEncoder().encode(JSON.stringify(manifest)));
      const before = backend.agents.get("atlas")!;

      let message = "";
      try {
        await drain(hermetic.upgrade({ name: "atlas", hermes: PIN, now }));
      } catch (e) {
        expect(isHermeticError(e) && e.code).toBe("HERMETICD_UNAVAILABLE");
        message = (e as Error).message;
      }
      expect(message).toContain("hermetic artifacts push");
      expect(probed).toBe(false);
      expect(backend.agents.get("atlas")).toEqual(before);
    });
  }

  test("a request write whose event append failed is treated as asked, not undone", async () => {
    const { backend, hermetic } = fleet();
    onOldHermes(backend, "atlas");
    const append = backend.store.events.append.bind(backend.store.events);
    backend.store.events.append = (event, ...rest) => {
      if (event.action === "upgrade" && event.detail?.startsWith("converge requested")) {
        throw new Error("the log refused");
      }
      return append(event, ...rest);
    };
    const events = await drain(
      hermetic.upgrade({ name: "atlas", hermes: PIN, now: true, force: true }),
    );
    const row = backend.agents.get("atlas")!;
    expect(row.hermes_version).toBe(PIN);
    expect(row.apply_request?.upgrade_from?.hermes_version).toBe(OLD);
    expect(events.some((e) => e.phase === "atlas:requested")).toBe(true);
  });

  /** Runs `--now` on atlas until the event `phase`, then stops iterating, as a cancelled consumer does. */
  async function abandonAt(phase: string) {
    const { backend, hermetic } = fleet();
    const before = onOldHermes(backend, "atlas");
    const run = hermetic
      .upgrade({ name: "atlas", hermes: PIN, now: true, force: true })
      [Symbol.asyncIterator]();
    for (let next = await run.next(); !next.done; next = await run.next()) {
      if (next.value.phase === phase) break;
    }
    await run.return?.(undefined);
    return { backend, before, row: backend.agents.get("atlas")! };
  }

  test("a run abandoned between the row write and the request puts the row back", async () => {
    const { before, row } = await abandonAt("atlas:render");
    expect(row.hermes_version).toBe(OLD);
    expect(row.config_hash).toBe(before.config_hash!);
    expect(row.resources.config_key).toBe(before.resources.config_key!);
    expect(row.apply_request ?? null).toBeNull();
    expect(row.lock ?? null).toBeNull();
  });

  test("a run abandoned after the request leaves the row to the box", async () => {
    const { before, row } = await abandonAt("atlas:requested");
    expect(row.hermes_version).toBe(PIN);
    expect(row.config_hash).not.toBe(before.config_hash);
    expect(row.apply_request?.upgrade_from?.hermes_version).toBe(OLD);
  });
});

describe("T1: a request the box refused does not outlive the reconcile that answered it", () => {
  /** atlas on 0.21.5, asked for this build's pin with `--now`, refused before the box touched Hermes. */
  async function refused() {
    const { backend, hermetic } = fleet();
    const old = onOldHermes(backend, "atlas");
    await drain(hermetic.upgrade({ name: "atlas", hermes: PIN, now: true, force: true }));
    const asked = backend.agents.get("atlas")!;
    const req = asked.apply_request!;
    backend.agents.set("atlas", {
      ...asked,
      apply_failure: {
        request_id: req.id,
        config_hash: req.config_hash,
        code: "HERMES_UNITS_ACTIVE",
        at: "2026-11-15T00:00:00.000Z",
      },
    } as Agent);
    return { backend, hermetic, old, refusedHash: req.config_hash };
  }

  /** The replacement box comes up on the config its row names. */
  function boxReports(backend: MemoryBackend): Agent {
    const row = backend.agents.get("atlas")!;
    const next = {
      ...row,
      status: "ready",
      applied_config_hash: row.config_hash,
      running_hermes_version: manifestOf(backend, row).hermes_version,
    } as Agent;
    backend.agents.set("atlas", next);
    return next;
  }

  function expectOnPin(backend: MemoryBackend): void {
    const row = backend.agents.get("atlas")!;
    expect(row.hermes_version).toBe(PIN);
    expect(manifestOf(backend, row).hermes_version).toBe(PIN);
  }

  test("pin, recreate, then rollout, set, pin-only and a second recreate all keep the new pin", async () => {
    const { backend, hermetic, refusedHash } = await refused();
    // The documented exit: the pin only (which reconciles first), then a recreate.
    await drain(hermetic.upgrade({ name: "atlas", hermes: PIN }));
    await drain(hermetic.apply({ plan: await hermetic.plan.recreate({ name: "atlas" }), yes: true }));
    const fresh = backend.agents.get("atlas")!;
    // The render is deterministic: the fresh box is handed the refused request's hash.
    expect(fresh.config_hash).toBe(refusedHash);
    expect(fresh.apply_request ?? null).toBeNull();
    expect(fresh.apply_failure ?? null).toBeNull();
    expect(rolledBackFrom(fresh)).toBeNull();
    expectOnPin(backend);

    boxReports(backend);
    await drain(
      hermetic.apply({ plan: await hermetic.plan.rollout({ agents: ["atlas"] }), yes: true }),
    );
    expectOnPin(backend);
    await hermetic.agents.set({ name: "atlas", hermes: { max_turns: 42 } });
    expectOnPin(backend);
    boxReports(backend);
    await drain(hermetic.upgrade({ name: "atlas", hermes: PIN }));
    expectOnPin(backend);
    await drain(hermetic.agents.recreate({ name: "atlas", yes: true }));
    expectOnPin(backend);
  });

  test("a request whose config the box has applied is not read as rolled back", async () => {
    const { backend } = await refused();
    const row = backend.agents.get("atlas")!;
    expect(rolledBackFrom(row)?.hermes_version).toBe(OLD);
    expect(rolledBackFrom({ ...row, applied_config_hash: row.config_hash } as Agent)).toBeNull();
  });

  test("a second --now after the reconcile carries its own request, and a later reconcile leaves it", async () => {
    const { backend, hermetic, refusedHash } = await refused();
    await drain(hermetic.upgrade({ name: "atlas", hermes: PIN }));
    const settled = backend.agents.get("atlas")!;
    const stale = settled.apply_request!.id;
    expect(settled.hermes_version).toBe(PIN);
    await drain(hermetic.upgrade({ name: "atlas", hermes: PIN, now: true, force: true }));
    // In flight: the same hash is asked again, under a request the old failure does not name.
    const asked = backend.agents.get("atlas")!;
    expect(asked.config_hash).toBe(refusedHash);
    expect(asked.apply_request!.id).not.toBe(stale);
    expect(rolledBackFrom(asked)).toBeNull();
    await hermetic.agents.set({ name: "atlas", hermes: { max_turns: 42 } }).catch(() => undefined);
    expect(backend.agents.get("atlas")!.hermes_version).toBe(PIN);
  });
});

describe("T2/T3/T4: upgrade refusals say what they did", () => {
  test("a box that never applied a config names rerun and recreate from rollout and --now", async () => {
    const { backend, hermetic } = fleet();
    const atlas = backend.agents.get("atlas")!;
    backend.agents.set("atlas", {
      ...atlas,
      status: "error",
      applied_config_hash: null,
      running_hermes_version: null,
    } as Agent);
    const plan = await hermetic.plan.rollout({ agents: ["atlas"] });
    const events = await drain(
      hermetic.upgrade({ name: "atlas", hermes: PIN, now: true, force: true }),
    );
    const refusedNow = events.find((e) => e.phase === "atlas:refused")?.message ?? "";
    for (const said of [plan.steps[0]!.description, refusedNow]) {
      expect(said).toContain("`hermetic agent rerun atlas`");
      expect(said).toContain("`hermetic plan recreate atlas`");
      expect(said).not.toContain("--now` installs it");
      expect(said).not.toContain("plan rollout");
    }
  });

  test("a pin-only write refused after a reconcile says the reconcile happened", async () => {
    const { backend, hermetic } = fleet();
    onOldHermes(backend, "atlas");
    await drain(hermetic.upgrade({ name: "atlas", hermes: PIN, now: true, force: true }));
    const asked = backend.agents.get("atlas")!;
    // Refused before touching Hermes, then stopped: a stop clears both reports.
    backend.agents.set("atlas", {
      ...asked,
      status: "stopped",
      applied_config_hash: null,
      running_hermes_version: null,
      apply_failure: {
        request_id: asked.apply_request!.id,
        config_hash: asked.config_hash!,
        code: "HERMES_UNITS_ACTIVE",
        at: "2026-11-15T00:00:00.000Z",
      },
    } as Agent);
    let message = "";
    try {
      await drain(hermetic.upgrade({ name: "atlas", hermes: PIN }));
    } catch (e) {
      expect(isHermeticError(e) && e.code).toBe("HERMES_UPGRADE_REQUIRED");
      message = (e as Error).message;
    }
    expect(message).toContain(`was reconciled back to Hermes ${OLD}, and the pin was not moved`);
    expect(message).not.toContain("Nothing was changed");
    expect(backend.agents.get("atlas")!.hermes_version).toBe(OLD);
  });

  test("--now on a pinned-ahead row whose applied bundle cannot be read refuses before any write", async () => {
    const { backend, hermetic } = fleet();
    const old = onOldHermes(backend, "atlas");
    await drain(hermetic.upgrade({ name: "atlas", hermes: PIN }));
    backend.agents.set("atlas", {
      ...backend.agents.get("atlas")!,
      running_hermes_version: null,
    } as Agent);
    backend.objects.delete(old.resources.config_key!);
    const before = backend.agents.get("atlas")!;
    backend.resetMutations();
    expect(
      await codeOf(() =>
        drain(hermetic.upgrade({ name: "atlas", hermes: PIN, now: true, force: true })),
      ),
    ).toBe("HERMES_UPGRADE_REQUIRED");
    expect(backend.mutations).toEqual([]);
    expect(backend.agents.get("atlas")).toEqual(before);
  });

  test("--all --now refuses that row alone and goes on to the rest", async () => {
    const { backend, hermetic } = fleet();
    const old = onOldHermes(backend, "atlas");
    await drain(hermetic.upgrade({ name: "atlas", hermes: PIN }));
    backend.objects.delete(old.resources.config_key!);
    const events = await drain(hermetic.upgrade({ all: true, hermes: PIN, now: true, force: true }));
    const refused = events.find((e) => e.phase === "atlas:refused")?.message ?? "";
    expect(refused).toContain("so which Hermes it installs is unknown; `hermetic plan recreate atlas`");
    expect(refused).not.toContain("Nothing was changed");
    expect(events.some((e) => e.phase !== "atlas:refused" && e.phase.endsWith(":done"))).toBe(true);
    expect(events.at(-1)?.phase).toBe("done");
  });

  test("a --now refused after a reconcile says the reconcile happened", async () => {
    const { backend, hermetic } = fleet();
    onOldHermes(backend, "atlas");
    await drain(hermetic.upgrade({ name: "atlas", hermes: PIN, now: true, force: true }));
    const asked = backend.agents.get("atlas")!;
    backend.agents.set("atlas", {
      ...asked,
      status: "stopped",
      apply_failure: {
        request_id: asked.apply_request!.id,
        config_hash: asked.config_hash!,
        code: "HERMES_UNITS_ACTIVE",
        at: "2026-11-15T00:00:00.000Z",
      },
    } as Agent);
    // The box comes up between the agent's re-read (after the listing) and its lock, so it was not waited on.
    const get = backend.store.agents.get.bind(backend.store.agents);
    let reads = 0;
    backend.store.agents.get = async (name, ...rest) => {
      const row = await get(name, ...rest);
      if (name === "atlas" && ++reads === 2) {
        backend.agents.set("atlas", { ...row!, status: "ready" } as Agent);
      }
      return row;
    };
    const events = await drain(hermetic.upgrade({ name: "atlas", hermes: PIN, now: true }));
    const refused = events.find((e) => e.phase === "atlas:refused")?.message ?? "";
    expect(refused).toContain("it came up while this run was starting");
    expect(refused).toContain(`was reconciled back to Hermes ${OLD}, and the pin was not moved`);
    expect(refused).not.toContain("nothing was changed");
  });
});
