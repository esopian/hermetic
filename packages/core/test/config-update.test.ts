/**
 * "Update the fleet" as one thing (§6.5, §6.6): `artifacts push` and
 * `foundation update` end by converging every agent whose re-rendered config
 * changed, and the plans say per agent what changes.
 *
 * The properties held here are about restraint again: only changed agents are
 * asked, everything that cannot be converged safely is deferred with a warning
 * rather than failing the push, and an older build never pushes its render over
 * a newer one's.
 */
import { describe, expect, test } from "bun:test";
import { FIXTURE_CONFIG, MemoryBackend, seedFixtureFleet } from "../src/backend/memory.ts";
import { BUILD_VERSIONS } from "../src/build-versions.ts";
import { tarGz } from "../src/release/tar.ts";
import { pendingApplied } from "../src/profiles/profile-binding.ts";
import { HERMETIC_VERSION } from "../src/version.ts";
import type { GitBuildInfo } from "../src/release/git.ts";
import type { Agent, AgentConfig, OpEvent } from "../src/schema/index.ts";
import { drain, testContext, testHermetic } from "./helpers.ts";

const CLEAN_TREE: GitBuildInfo = { build_number: 500, commit: "abc1234", dirty: false };

function fleet(git: () => GitBuildInfo | null = () => null) {
  const backend = seedFixtureFleet(new MemoryBackend({ directory: "seeded" }));
  // The fake box answers an `apply_request` a tick after it is written.
  backend.simulateConverge = true;
  backend.rerunDelayMs = 1;
  const hermetic = testHermetic({
    backend,
    config: FIXTURE_CONFIG,
    git,
    rollout: { convergeTimeoutMs: 200, convergePollMs: 2 },
  });
  const ctx = testContext(backend);
  const { region, tailnet } = backend.fleetItem!;
  const render = (row: Agent) => ctx.renderFor(pendingApplied(row), region, tailnet);
  /**
   * Every live agent made current — on this build's Hermes, its applied hash
   * the one this build renders, nothing staged — so a test changes exactly the
   * agents it names.
   */
  for (const row of [...backend.agents.values()]) {
    if (row.status === "destroyed") continue;
    const current = { ...row, hermes_version: BUILD_VERSIONS.hermes, pending: null } as Agent;
    const hash = render(current).config_hash;
    backend.agents.set(row.name, { ...current, config_hash: hash, applied_config_hash: hash });
  }
  /**
   * Make `name`'s box report a bundle this build would change: one file
   * removed, one rewritten, one extra, and an extra command — packed as a real
   * bundle at `config/<name>/<hash>.tgz`, where the plan reads it back.
   */
  function stale(name: string): string {
    const row = backend.agents.get(name)!;
    const next = render(row).manifest;
    const [dropped, rewritten, ...rest] = next.files;
    const applied: AgentConfig = {
      ...next,
      files: [
        { ...rewritten!, content: `${rewritten!.content}# old\n` },
        ...rest,
        { path: "/etc/hermes/retired.conf", mode: "0644", content: "x" },
      ],
      commands: [...next.commands, "echo old"],
    };
    const hash = `applied${name}`.padEnd(16, "0").slice(0, 16);
    backend.objects.set(
      `config/${name}/${hash}.tgz`,
      tarGz([{ path: "manifest.json", mode: "0644", content: JSON.stringify(applied) }]),
    );
    backend.agents.set(name, { ...row, config_hash: hash, applied_config_hash: hash });
    return [dropped!.path, rewritten!.path, "/etc/hermes/retired.conf"].sort().join("|");
  }
  return { backend, hermetic, stale, render };
}

const ready = (backend: MemoryBackend): string[] =>
  [...backend.agents.values()]
    .filter((a) => a.status === "ready" && a.last_heartbeat)
    .map((a) => a.name)
    .sort();
const asked = (backend: MemoryBackend): string[] =>
  [...backend.agents.values()]
    .filter((a) => a.apply_request)
    .map((a) => a.name)
    .sort();
const config = (events: OpEvent[]) => events.filter((e) => e.phase === "config");

describe("artifacts push converges every changed agent", () => {
  test("only changed agents are asked; the others are untouched", async () => {
    const { backend, hermetic, stale, render } = fleet();
    const [a, b] = ready(backend);
    stale(a!);
    const events = await drain(hermetic.artifacts.push({}));
    expect(asked(backend)).toEqual([a!]);
    const row = backend.agents.get(a!)!;
    expect(row.applied_config_hash).toBe(render(row).config_hash);
    expect(backend.agents.get(b!)!.apply_request ?? null).toBeNull();
    expect(config(events).some((e) => e.message.includes("1 converged"))).toBe(true);
    // One terminal `done`, the op's own, last.
    expect(events.filter((e) => e.phase === "done")).toHaveLength(1);
    expect(events.at(-1)!.phase).toBe("done");
  });

  test("stopped, locked, Hermes-held, incapable and unreported agents are deferred, never failed", async () => {
    const { backend, hermetic, stale } = fleet();
    const [stopped, locked, held, incapable, unreported, fine] = ready(backend);
    for (const n of [stopped, locked, held, incapable, fine]) stale(n!);
    const set = (n: string, patch: Partial<Agent>) =>
      backend.agents.set(n, { ...backend.agents.get(n)!, ...patch } as Agent);
    set(stopped!, { status: "stopped" });
    set(locked!, { lock: { owner: "someone", expires: "2999-01-01T00:00:00.000Z" } });
    set(held!, { hermes_version: "0.14.2" });
    set(unreported!, { applied_config_hash: null });
    // A box that never applied a bundle needing anything, and does not report
    // the published binary: nothing says it can apply what this build renders.
    const bundle = `config/${incapable!}/${backend.agents.get(incapable!)!.applied_config_hash!}.tgz`;
    backend.objects.set(bundle, new Uint8Array([1, 2, 3]));
    set(incapable!, { running_hermeticd_sha256: null });

    const events = await drain(hermetic.artifacts.push({}));
    const warned = (n: string) =>
      config(events).find((e) => e.level === "warn" && e.message.startsWith(`${n}:`))?.message ?? "";
    expect(warned(stopped!)).toContain("stopped");
    expect(warned(locked!)).toContain("locked");
    expect(warned(held!)).toContain("hermetic upgrade --hermes");
    expect(warned(incapable!)).toContain("has not reported support");
    expect(warned(unreported!)).toContain("no applied config reported");
    expect(asked(backend)).toEqual([fine!]);
    expect(events.at(-1)!.phase).toBe("done");
  });

  test("`--no-rollout` asks no box for a config either", async () => {
    const { backend, hermetic, stale } = fleet();
    stale(ready(backend)[0]!);
    const events = await drain(hermetic.artifacts.push({ rollout: false }));
    expect(asked(backend)).toEqual([]);
    expect(config(events).map((e) => e.message)).toEqual([
      "--no-rollout: no agent's config was converged",
    ]);
  });

  test("an older build than the fleet's publisher skips the phase and leaves the record alone", async () => {
    const { backend, hermetic, stale } = fleet(() => CLEAN_TREE);
    stale(ready(backend)[0]!);
    backend.fleetItem = {
      ...backend.fleetItem!,
      published_by: { hermetic_version: HERMETIC_VERSION, build_number: 900 },
    };
    const events = await drain(hermetic.artifacts.push({}));
    expect(asked(backend)).toEqual([]);
    expect(config(events)).toHaveLength(1);
    expect(config(events)[0]!.level).toBe("warn");
    expect(config(events)[0]!.message).toContain("older");
    // Moving it back would let this build's next push read as `same`.
    expect(backend.fleetItem!.published_by).toEqual({
      hermetic_version: HERMETIC_VERSION,
      build_number: 900,
    });
  });

  test("one agent's failure is its own warning; the rest still converge", async () => {
    const { backend, hermetic, stale } = fleet();
    const [a, b] = ready(backend);
    stale(a!);
    stale(b!);
    const update = backend.store.agents.update.bind(backend.store.agents);
    backend.store.agents.update = (name, version, patch, ...rest) => {
      if (name === a && patch.apply_request) throw new Error("boom");
      return update(name, version, patch, ...rest);
    };
    const events = await drain(hermetic.artifacts.push({}));
    const warn = config(events).find((e) => e.message.startsWith(`${a!}: config not converged`));
    expect(warn?.message).toContain("boom");
    expect(asked(backend)).toEqual([b!]);
    expect(config(events).at(-1)!.message).toContain("1 converged");
    expect(config(events).at(-1)!.message).toContain("1 failed");
    expect(events.at(-1)!.phase).toBe("done");
  });

  test("a push of this build's bundle writes published_by; an explicit version does not", async () => {
    const { backend, hermetic } = fleet(() => CLEAN_TREE);
    const { published_by: _seeded, ...unrecorded } = backend.fleetItem!;
    backend.fleetItem = unrecorded;
    await drain(hermetic.artifacts.push({ version: "9.9.9", rollout: false }));
    expect(backend.fleetItem!.published_by).toBeUndefined();
    await drain(hermetic.artifacts.push({ rollout: false }));
    expect(backend.fleetItem!.published_by).toEqual({
      hermetic_version: HERMETIC_VERSION,
      build_number: 500,
    });
  });
});

describe("the plans say per agent what changes", () => {
  test("plan.rollout lists changed paths and manifest fields, and every agent", async () => {
    const { backend, hermetic, stale } = fleet();
    const [a] = ready(backend);
    const paths = stale(a!);
    const plan = await hermetic.plan.rollout({});
    const change = plan.config_changes!.find((c) => c.name === a)!;
    expect(change.deferred).toBeNull();
    expect(change.files!.join("|")).toBe(paths);
    expect(change.manifest).toEqual(["commands"]);
    expect(plan.steps.find((s) => s.id === a)!.description).toContain("3 file(s) changed");
    const others = plan.config_changes!.filter((c) => c.name !== a && c.deferred === "already current");
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((c) => c.files?.length === 0)).toBe(true);
  });

  test("an expired lock holds nothing, in the plan as in the update", async () => {
    const { backend, hermetic, stale } = fleet();
    const [a] = ready(backend);
    stale(a!);
    const lapsed = { owner: "someone", expires: "2000-01-01T00:00:00.000Z" };
    backend.agents.set(a!, { ...backend.agents.get(a!)!, lock: lapsed });
    const plan = await hermetic.plan.rollout({});
    expect(plan.config_changes!.find((c) => c.name === a)!.deferred).toBeNull();
    const update = await hermetic.plan.foundation();
    expect(update.config_changes!.find((c) => c.name === a)!.deferred).toBeNull();
  });

  test("a missing applied bundle is a note, never a throw", async () => {
    const { backend, hermetic, stale } = fleet();
    const [a] = ready(backend);
    stale(a!);
    backend.objects.delete(`config/${a!}/${backend.agents.get(a!)!.applied_config_hash!}.tgz`);
    const plan = await hermetic.plan.rollout({});
    const change = plan.config_changes!.find((c) => c.name === a)!;
    expect(change.files).toBeNull();
    expect(change.note).toBe("applied bundle unavailable");
  });

  test("plan.foundation lists only changed agents, with deferrals and staged changes", async () => {
    const { backend, hermetic, stale } = fleet();
    const [a, b, c] = ready(backend);
    stale(a!);
    stale(b!);
    backend.agents.set(b!, { ...backend.agents.get(b!)!, status: "stopped" });
    // §8.3: corvid's seeded staged provider change, put back on a ready row.
    const seeded = seedFixtureFleet(new MemoryBackend({ directory: "seeded" })).agents.get("corvid")!;
    expect(seeded.pending).toBeTruthy();
    backend.agents.set(c!, { ...backend.agents.get(c!)!, pending: seeded.pending } as Agent);

    const plan = await hermetic.plan.foundation();
    const names = plan.config_changes!.map((x) => x.name).sort();
    expect(names).toEqual([a!, b!, c!].sort());
    expect(plan.config_changes!.find((x) => x.name === b)!.deferred).toBe("stopped");
    expect(plan.config_changes!.find((x) => x.name === c)!.pending).not.toBeNull();
    expect(plan.steps.map((s) => s.id)).toContain("config");
  });
});

describe("an older build converges nothing", () => {
  const newer = { hermetic_version: HERMETIC_VERSION, build_number: 900 };

  test("plan.foundation defers every change with the older-build reason", async () => {
    const { backend, hermetic, stale } = fleet(() => CLEAN_TREE);
    stale(ready(backend)[0]!);
    backend.fleetItem = { ...backend.fleetItem!, published_by: newer };
    const plan = await hermetic.plan.foundation();
    expect(plan.config_changes!.length).toBeGreaterThan(0);
    expect(plan.config_changes!.every((c) => c.deferred?.includes("older") === true)).toBe(true);
  });

  test("foundation update keeps the newer publisher on record", async () => {
    const { backend, hermetic, stale } = fleet(() => CLEAN_TREE);
    stale(ready(backend)[0]!);
    backend.fleetItem = { ...backend.fleetItem!, published_by: newer };
    await drain(hermetic.foundation.update({ yes: true }));
    expect(asked(backend)).toEqual([]);
    expect(backend.fleetItem!.published_by).toEqual(newer);
  });
});

describe("foundation update ends with the config phase", () => {
  test("after the fleet lock is released, converging the changed agent", async () => {
    const { backend, hermetic, stale } = fleet();
    const [a] = ready(backend);
    stale(a!);
    const events = await drain(hermetic.foundation.update({ yes: true }));
    expect(asked(backend)).toEqual([a!]);
    expect(config(events).some((e) => e.message.includes("1 converged"))).toBe(true);
    expect(events.at(-1)!.phase).toBe("done");
    expect(backend.fleetItem!.lock ?? null).toBeNull();
    expect(backend.fleetItem!.published_by?.hermetic_version).toBe(HERMETIC_VERSION);
  });
});
