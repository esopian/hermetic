/**
 * §6.5: the fleet's hermeticd auto-update switch, end to end on the laptop
 * side — the manifest carrying it, `settings.set` republishing it, and the two
 * commands that publish a release (`artifacts.push`, `upgrade --hermeticd`)
 * deciding from it whether to ask every running box to take the release now.
 *
 * The rollout itself — the conditional row write, the heartbeat baselines and
 * the three outcomes — is held by `foundation.test.ts` through the wrapper
 * `foundation.update` keeps; here it is exercised directly only for what the
 * new callers add to it (no lock to renew, a caller-named version and phase).
 */
import { describe, expect, test } from "bun:test";
import {
  FIXTURE_CONFIG,
  FIXTURE_HERMETICD_VERSION,
  MemoryBackend,
  seedFixtureFleet,
} from "../src/backend/memory.ts";
import {
  fleetManifestFrom,
  pointFleetAt,
  readFleetManifest,
  recordHermesMirror,
} from "../src/release/artifacts.ts";
import {
  FLEET_MANIFEST_KEY,
  defaultFleetSettings,
  type Agent,
  type FleetItem,
  type OpEvent,
} from "../src/schema/index.ts";
import {
  followRelease,
  releaseChange,
  rolloutHermeticd,
  type ReleaseIdentity,
} from "../src/fleet/hermeticd-rollout.ts";
import type { HermeticDeps } from "../src/hermetic.ts";
import { drain, settle, testContext, testHermetic } from "./helpers.ts";

const FAST: NonNullable<HermeticDeps["foundation"]> = {
  changeSetPollMs: 0,
  rolloutPollMs: 1,
  heartbeatMs: 60_000,
};

function fleet() {
  const backend = seedFixtureFleet(new MemoryBackend({ directory: "seeded" }));
  const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG, foundation: FAST });
  return { backend, hermetic };
}

/** Set the switch on `_fleet` directly, as another laptop's `settings set` would have. */
function setSwitch(backend: MemoryBackend, value: boolean | undefined): void {
  const item = backend.fleetItem!;
  const settings =
    item.settings ?? defaultFleetSettings(item.defaults, item.created_by, item.created_at);
  const { auto_update_hermeticd: _drop, ...rest } = settings;
  backend.fleetItem = {
    ...item,
    settings: value === undefined ? rest : { ...rest, auto_update_hermeticd: value },
  };
}

async function manifestSwitch(backend: MemoryBackend): Promise<boolean | undefined> {
  return (await readFleetManifest(backend.artifacts))?.auto_update_hermeticd;
}

/** Every live row's current `update_request` id, to tell which rows a run asked. */
function requestIds(backend: MemoryBackend): Map<string, string | undefined> {
  const out = new Map<string, string | undefined>();
  for (const a of backend.agents.values()) {
    if (a.name !== "_fleet") out.set(a.name, a.update_request?.id);
  }
  return out;
}

/** The rows whose `update_request` changed since `before`. */
function askedSince(backend: MemoryBackend, before: Map<string, string | undefined>): string[] {
  return [...backend.agents.values()]
    .filter((a) => a.name !== "_fleet" && a.update_request?.id !== before.get(a.name))
    .map((a) => a.name)
    .sort();
}

/** The rows a rollout targets in the seeded fleet. */
function upRows(backend: MemoryBackend): string[] {
  return [...backend.agents.values()]
    .filter((a) => a.name !== "_fleet" && ["ready", "degraded"].includes(a.status) && a.instance_id)
    .map((a) => a.name)
    .sort();
}

const said = (events: OpEvent[]): string => events.map((e) => e.message).join("\n");

// ─── the manifest carries the switch ─────────────────────────────────────────

describe("the fleet manifest carries auto_update_hermeticd from the row", () => {
  test("fleetManifestFrom: absent reads as on, off is written as off", async () => {
    const { backend } = fleet();
    const hermeticd = (await readFleetManifest(backend.artifacts))!.hermeticd;
    const build = (item: FleetItem) =>
      fleetManifestFrom({
        fleet: item,
        stack: backend.stack,
        hermeticd,
        updatedBy: "test",
        updatedAt: "2026-10-12T00:00:00.000Z",
      });
    setSwitch(backend, undefined);
    expect(build(backend.fleetItem!).auto_update_hermeticd).toBe(true);
    setSwitch(backend, false);
    expect(build(backend.fleetItem!).auto_update_hermeticd).toBe(false);
    // A `_fleet` with no settings at all is a fleet that predates them: on.
    const { settings: _s, ...bare } = backend.fleetItem!;
    expect(build(bare).auto_update_hermeticd).toBe(true);
  });

  for (const value of [false, undefined] as const) {
    const expected = value ?? true;
    test(`artifacts.push (publishRelease) writes ${String(expected)} for a row saying ${String(value)}`, async () => {
      const { backend, hermetic } = fleet();
      setSwitch(backend, value);
      await settle(hermetic.artifacts.push({ version: "9.9.9", rollout: false }));
      expect(await manifestSwitch(backend)).toBe(expected);
    });

    test(`upgrade --hermeticd (pointFleetAt) writes ${String(expected)} for a row saying ${String(value)}`, async () => {
      const { backend } = fleet();
      const hermeticd = (await readFleetManifest(backend.artifacts))!.hermeticd;
      setSwitch(backend, value);
      // The caller's copy says the opposite: the row re-read under the lock wins.
      const stale = { ...backend.fleetItem!, settings: undefined };
      const moved = await pointFleetAt(backend.artifacts, backend.store.fleet, {
        fleet: stale,
        stack: backend.stack,
        hermeticd,
        owner: "test",
        ttlMs: 60_000,
        now: () => backend.now(),
        updatedBy: "test",
        updatedAt: "2026-10-12T00:00:00.000Z",
      });
      expect(await manifestSwitch(backend)).toBe(expected);
      expect(moved.previous?.version).toBe(hermeticd.version);
    });

    test(`upgrade --hermes (recordHermesMirror) writes ${String(expected)} for a row saying ${String(value)}`, async () => {
      const { backend } = fleet();
      setSwitch(backend, value);
      const recorded = await recordHermesMirror(backend.artifacts, backend.store.fleet, {
        fleet: backend.fleetItem!,
        stack: backend.stack,
        hermes: {},
        owner: "test",
        ttlMs: 60_000,
        now: () => backend.now(),
        updatedBy: "test",
        updatedAt: "2026-10-12T00:00:00.000Z",
      });
      expect(recorded).toBe(true);
      expect(await manifestSwitch(backend)).toBe(expected);
    });

    test(`foundation.update (pushAndPrune) writes ${String(expected)} for a row saying ${String(value)}`, async () => {
      const { backend, hermetic } = fleet();
      // An older fleet, so the update has a release to push.
      const { foundation_version: _v, foundation_template_sha256: _t, ...rest } = backend.fleetItem!;
      backend.fleetItem = { ...rest, min_hermetic_version: "0.4.0" };
      setSwitch(backend, value);
      await drain(hermetic.foundation.update({ yes: true }));
      expect(await manifestSwitch(backend)).toBe(expected);
    });
  }
});

// ─── settings.set republishes it ─────────────────────────────────────────────

describe("settings.set auto_update_hermeticd", () => {
  test("switching it off republishes the manifest with only the switch moved", async () => {
    const { backend, hermetic } = fleet();
    const before = (await readFleetManifest(backend.artifacts))!;
    expect(before.auto_update_hermeticd ?? true).toBe(true);

    const result = await hermetic.settings.set({ auto_update_hermeticd: false });

    expect(result.settings.auto_update_hermeticd).toBe(false);
    expect(result.warning).toBeUndefined();
    const after = (await readFleetManifest(backend.artifacts))!;
    expect(after.auto_update_hermeticd).toBe(false);
    expect(after.hermeticd).toEqual(before.hermeticd);
    expect(after.foundation).toEqual(before.foundation);
    expect(after.hermes).toEqual(before.hermes);
    expect(after.browser).toEqual(before.browser);
    const history = await backend.store.events.query("_fleet");
    expect(history.some((e) => e.detail?.includes("auto_update_hermeticd off") === true)).toBe(true);
    expect(
      history.some(
        (e) =>
          e.action === "settings.auto_update_hermeticd" &&
          e.detail?.includes("the fleet manifest now says so") === true,
      ),
    ).toBe(true);
    // And back on.
    await hermetic.settings.set({ auto_update_hermeticd: true });
    expect(await manifestSwitch(backend)).toBe(true);
  });

  test("stating what the fleet already has writes nothing to the bucket", async () => {
    const { backend, hermetic } = fleet();
    setSwitch(backend, undefined);
    const manifest = backend.objects.get(FLEET_MANIFEST_KEY);
    backend.resetMutations();
    await hermetic.settings.set({ auto_update_hermeticd: true });
    expect(backend.mutations.filter((m) => m.startsWith("artifacts."))).toEqual([]);
    expect(backend.objects.get(FLEET_MANIFEST_KEY)).toEqual(manifest);
  });

  test("a fleet with no published manifest saves the setting and writes none", async () => {
    const { backend, hermetic } = fleet();
    backend.objects.delete(FLEET_MANIFEST_KEY);
    const result = await hermetic.settings.set({ auto_update_hermeticd: false });
    expect(result.warning).toBeUndefined();
    expect(result.settings.auto_update_hermeticd).toBe(false);
    expect(backend.objects.has(FLEET_MANIFEST_KEY)).toBe(false);
  });

  test("a manifest that cannot be republished is a warning, never a failed write", async () => {
    const { backend, hermetic } = fleet();
    // A refused manifest: its binary key sits outside its own release.
    const manifest = (await readFleetManifest(backend.artifacts))!;
    manifest.hermeticd.files["hermeticd"]!.key = "config/atlas/bundle.tar.gz";
    backend.objects.set(FLEET_MANIFEST_KEY, new TextEncoder().encode(JSON.stringify(manifest)));

    const result = await hermetic.settings.set({ auto_update_hermeticd: false });

    expect(backend.fleetItem!.settings!.auto_update_hermeticd).toBe(false);
    expect(result.warning).toContain("saved as off");
    expect(result.warning).toContain("MANIFEST_REFUSED");
    expect(result.warning).toContain("hermetic artifacts push");
  });
});

// ─── artifacts.push: the decision ────────────────────────────────────────────

describe("artifacts.push rolls a changed release out per the fleet's switch", () => {
  test("on (the default) and changed: every up box is asked", async () => {
    const { backend, hermetic } = fleet();
    const before = requestIds(backend);
    const events = await drain(hermetic.artifacts.push({ version: "9.9.9" }));
    expect(askedSince(backend, before)).toEqual(upRows(backend));
    expect(upRows(backend).length).toBeGreaterThan(0);
    for (const name of upRows(backend)) {
      expect(backend.agents.get(name)!.update_request!.hermeticd_version).toBe("9.9.9");
    }
    expect(said(events)).toContain(
      `asking ${upRows(backend).length} agent(s) to take hermeticd 9.9.9 now`,
    );
    expect(events.at(-1)).toMatchObject({ phase: "done", progress: 1 });
  });

  test("off: nobody is asked, and the line names the nightly slot and --now", async () => {
    const { backend, hermetic } = fleet();
    setSwitch(backend, false);
    const before = requestIds(backend);
    const events = await drain(hermetic.artifacts.push({ version: "9.9.9" }));
    expect(askedSince(backend, before)).toEqual([]);
    expect(said(events)).toContain("nightly update check");
    // The remedy asks for what is published; it does not push again.
    expect(said(events)).toContain("hermetic upgrade --hermeticd 9.9.9 --now");
  });

  test("off with --now: every up box is asked anyway", async () => {
    const { backend, hermetic } = fleet();
    setSwitch(backend, false);
    const before = requestIds(backend);
    await drain(hermetic.artifacts.push({ version: "9.9.9", now: true }));
    expect(askedSince(backend, before)).toEqual(upRows(backend));
  });

  test("on with --no-rollout: nobody is asked", async () => {
    const { backend, hermetic } = fleet();
    const before = requestIds(backend);
    const events = await drain(hermetic.artifacts.push({ version: "9.9.9", rollout: false }));
    expect(askedSince(backend, before)).toEqual([]);
    expect(said(events)).toContain("--no-rollout");
  });

  test("an unchanged release has nothing to roll out, unless --now", async () => {
    const { backend, hermetic } = fleet();
    // The seeded release, republished byte for byte: the same generation.
    const before = requestIds(backend);
    const events = await drain(hermetic.artifacts.push({ version: FIXTURE_HERMETICD_VERSION }));
    expect(askedSince(backend, before)).toEqual([]);
    expect(said(events)).toContain("the release is unchanged; nothing to roll out");

    await drain(hermetic.artifacts.push({ version: FIXTURE_HERMETICD_VERSION, now: true }));
    expect(askedSince(backend, before)).toEqual(upRows(backend));
  });

  test("--now and --no-rollout together are refused before anything is written", async () => {
    const { backend, hermetic } = fleet();
    backend.resetMutations();
    await expect(
      drain(hermetic.artifacts.push({ version: "9.9.9", now: true, rollout: false })),
    ).rejects.toThrow(/contradict/);
    expect(backend.mutations).toEqual([]);
  });

  test("a row under a live agent lock is deferred, and its holder's release still lands", async () => {
    const { backend, hermetic } = fleet();
    const name = upRows(backend)[0]!;
    // An operation in flight on a row that still reads `ready` — a `set`, a
    // `rerun` — holding the §4.4 lock.
    const owner = "arn:aws:iam::123456789012:user/other#op-1";
    const held = await backend.store.agents.update(name, backend.agents.get(name)!.version, {
      lock: { owner, expires: new Date(backend.now().getTime() + 60_000).toISOString() },
    });
    const before = requestIds(backend);

    const events = await drain(hermetic.artifacts.push({ version: "9.9.9" }));

    expect(askedSince(backend, before)).not.toContain(name);
    expect(askedSince(backend, before).length).toBeGreaterThan(0);
    expect(said(events)).toContain(`${name} (locked by ${owner})`);
    // The holder's own conditional write, at the version it took the lock at,
    // is not refused: the rollout did not move the row under it.
    const released = await backend.store.agents.update(name, held.version, { lock: null });
    expect(released.lock).toBeNull();
  });

  test("the fleet lock is given back before any box is asked", async () => {
    const { backend, hermetic } = fleet();
    backend.resetMutations();
    await drain(hermetic.artifacts.push({ version: "9.9.9" }));
    const unlock = backend.mutations.indexOf("store.fleet.unlockFleet");
    const firstAsk = backend.mutations.indexOf("store.agents.update");
    expect(unlock).toBeGreaterThan(-1);
    expect(firstAsk).toBeGreaterThan(unlock);
  });
});

// ─── upgrade --hermeticd: the same decision ──────────────────────────────────

describe("upgrade --hermeticd rolls the release out per the fleet's switch", () => {
  async function withSecondRelease() {
    const { backend, hermetic } = fleet();
    // A second release in the bucket, then the pointer back on the first.
    await settle(hermetic.artifacts.push({ version: "9.9.9", rollout: false }));
    await drain(hermetic.upgrade({ all: true, hermeticd: FIXTURE_HERMETICD_VERSION, rollout: false }));
    return { backend, hermetic };
  }

  test("on: the pointer moves and every up box is asked", async () => {
    const { backend, hermetic } = await withSecondRelease();
    const before = requestIds(backend);
    const events = await drain(hermetic.upgrade({ all: true, hermeticd: "9.9.9" }));
    expect((await readFleetManifest(backend.artifacts))!.hermeticd.version).toBe("9.9.9");
    expect(askedSince(backend, before)).toEqual(upRows(backend));
    expect(said(events)).not.toContain("nightly update");
    expect(events.at(-1)).toMatchObject({ phase: "done", progress: 1 });
  });

  test("off: the pointer moves and nobody is asked", async () => {
    const { backend, hermetic } = await withSecondRelease();
    setSwitch(backend, false);
    const before = requestIds(backend);
    const events = await drain(hermetic.upgrade({ all: true, hermeticd: "9.9.9" }));
    expect(askedSince(backend, before)).toEqual([]);
    expect(said(events)).toContain("hermetic upgrade --hermeticd 9.9.9 --now");
  });

  test("off with --now: every up box is asked", async () => {
    const { backend, hermetic } = await withSecondRelease();
    setSwitch(backend, false);
    const before = requestIds(backend);
    await drain(hermetic.upgrade({ all: true, hermeticd: "9.9.9", now: true }));
    expect(askedSince(backend, before)).toEqual(upRows(backend));
    for (const name of upRows(backend)) {
      expect(backend.agents.get(name)!.update_request!.hermeticd_version).toBe("9.9.9");
    }
  });
});

// ─── the decision and the rollout, directly ──────────────────────────────────

describe("releaseChange", () => {
  const A: ReleaseIdentity = { version: "1.0.0", generation: "a".repeat(16), sha256: "1".repeat(64) };
  test("tells a stage-only change from a binary one", () => {
    expect(releaseChange({ before: A, after: A })).toEqual({ release: false, binary: false });
    expect(releaseChange({ before: A, after: { ...A, generation: "b".repeat(16) } })).toEqual({
      release: true,
      binary: false,
    });
    expect(releaseChange({ before: A, after: { ...A, sha256: "2".repeat(64) } })).toEqual({
      release: true,
      binary: true,
    });
    expect(releaseChange({ before: null, after: A })).toEqual({ release: true, binary: true });
  });
});

describe("followRelease / rolloutHermeticd", () => {
  const A: ReleaseIdentity = { version: "1.0.0", generation: "a".repeat(16), sha256: "1".repeat(64) };

  test("a stage-only change asks every box and does not wait", async () => {
    const { backend } = fleet();
    const before = requestIds(backend);
    const started = Date.now();
    const events = await drain(
      followRelease(
        { ctx: testContext(backend), waitMs: 60_000, pollMs: 1 },
        {
          move: { before: A, after: { ...A, generation: "b".repeat(16) } },
          options: {},
          autoUpdate: true,
          phase: "rollout",
          progress: [0.5, 0.9],
          nowCommand: "hermetic artifacts push --now",
        },
      ),
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(askedSince(backend, before)).toEqual(upRows(backend));
    expect(said(events)).toContain("only the bootstrap stages moved");
    expect(said(events)).toContain("not waiting for them to land");
  });

  test("an unchanged release asked for with --now is watched, not called stages-only", async () => {
    const { backend } = fleet();
    const before = requestIds(backend);
    const events = await drain(
      followRelease(
        { ctx: testContext(backend), waitMs: 20, pollMs: 1 },
        {
          move: { before: A, after: A },
          options: { now: true },
          autoUpdate: true,
          phase: "rollout",
          progress: [0.5, 0.9],
          nowCommand: "hermetic upgrade --hermeticd 1.0.0 --now",
        },
      ),
    );
    expect(askedSince(backend, before)).toEqual(upRows(backend));
    expect(said(events)).toContain(
      "the release is unchanged; asking every box to take hermeticd 1.0.0 now",
    );
    expect(said(events)).not.toContain("only the bootstrap stages moved");
    // It waited and watched: nobody reported the digest, so the verdict is a
    // straggler line rather than "not waiting".
    expect(said(events)).not.toContain("not waiting for them to land");
    expect(events.at(-1)!.level).toBe("warn");
  });

  test("watches a box land on the binary digest, with no lock to renew", async () => {
    const { backend } = fleet();
    const target = upRows(backend)[0]!;
    // Leave exactly one target, so the rollout's verdict is about it alone.
    for (const name of upRows(backend).slice(1)) {
      backend.agents.set(name, { ...backend.agents.get(name)!, status: "stopped" } as Agent);
    }
    const sha = "f".repeat(64);
    const landing = setInterval(() => {
      const row = backend.agents.get(target)!;
      if (!row.update_request) return;
      clearInterval(landing);
      backend.agents.set(target, {
        ...row,
        running_hermeticd_sha256: sha,
        last_heartbeat: new Date(
          Date.parse(row.last_heartbeat ?? "2026-01-01T00:00:00Z") + 1_000,
        ).toISOString(),
      });
    }, 1);
    try {
      const events = await drain(
        rolloutHermeticd(
          { ctx: testContext(backend), waitMs: 5_000, pollMs: 1 },
          {
            targetSha256: sha,
            version: "9.9.9",
            phase: "rollout",
            progress: [0.6, 0.99],
            autoUpdate: true,
          },
        ),
      );
      expect(events.at(-1)!.message).toBe("every agent that was up is running hermeticd 9.9.9");
      expect(events.at(-1)!.level).toBeUndefined();
      expect(events.every((e) => e.phase === "rollout")).toBe(true);
    } finally {
      clearInterval(landing);
    }
  });

  test("a straggler on a fleet with auto-update off is told the nightly check", async () => {
    const { backend } = fleet();
    const events = await drain(
      rolloutHermeticd(
        { ctx: testContext(backend), waitMs: 20, pollMs: 1 },
        {
          targetSha256: "e".repeat(64),
          version: "9.9.9",
          phase: "rollout",
          progress: [0.6, 0.99],
          autoUpdate: false,
        },
      ),
    );
    const last = events.at(-1)!;
    expect(last.level).toBe("warn");
    expect(last.message).toContain("its nightly update check");
  });

  test("an abort mid-wait is a failure, not a quiet success", async () => {
    const { backend } = fleet();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const thrown = await drain(
      followRelease(
        { ctx: testContext(backend), waitMs: 60_000, pollMs: 1 },
        {
          move: { before: A, after: { ...A, sha256: "2".repeat(64) } },
          options: {},
          autoUpdate: true,
          phase: "rollout",
          progress: [0.5, 0.9],
          nowCommand: "hermetic artifacts push --now",
          signal: controller.signal,
        },
      ),
    ).catch((e: unknown) => e);
    expect((thrown as { code?: string }).code).toBe("ABORTED");
  });
});
