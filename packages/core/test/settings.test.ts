/**
 * The fleet's shared settings (§4.6): the schema, the synthesized answer for a
 * fleet that has none, the conditional write, and the refusals that keep the
 * fleet's default profile honest.
 *
 * The property this file exists for is the one the design rests on: **a
 * settings write cannot lose.** Two operators composing against the same
 * version means one of them is told to re-read, not that the second silently
 * wins; and a `foundation update` holding the fleet lock is `LOCKED` rather
 * than a write that lands and is stamped over a moment later.
 */
import { describe, expect, test } from "bun:test";
import {
  FIXTURE_CONFIG,
  FIXTURE_PROFILE_IDS,
  MemoryBackend,
  seedFixtureAgents,
  seedFixtureFoundation,
} from "../src/backend/memory.ts";
import {
  FleetSettings as FleetSettingsSchema,
  FleetItem as FleetItemSchema,
  PROVIDERS_LIST,
  defaultFleetSettings,
  providerDefaultModel,
} from "../src/schema/index.ts";
import type { FleetItem } from "../src/schema/index.ts";
import { FOUNDATION_VERSION } from "../src/version.ts";
import { FOUNDATION_MIGRATIONS, migrationsBetween } from "../src/fleet/foundation-migrations.ts";
import { HermeticError } from "../src/errors.ts";
import { drain, testHermetic } from "./helpers.ts";
import type { HermeticDeps } from "../src/hermetic.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function core(backend: MemoryBackend, deps: Partial<HermeticDeps> = {}) {
  return testHermetic({ backend, config: FIXTURE_CONFIG, ...deps });
}

/** A fixture fleet with a foundation and settings already on `_fleet`. */
function withSettings(): MemoryBackend {
  return seedFixtureFoundation(new MemoryBackend());
}

/** The same fleet as it was before shared settings existed: no `settings` at all. */
function withoutSettings(): MemoryBackend {
  const backend = seedFixtureFoundation(new MemoryBackend());
  const { settings: _dropped, ...rest } = backend.fleetItem as FleetItem;
  backend.fleetItem = rest;
  return backend;
}

async function codeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof HermeticError ? e.code : `not-a-HermeticError:${String(e)}`;
  }
}

describe("the schema", () => {
  test("defaultFleetSettings covers every provider in the catalog", () => {
    const settings = defaultFleetSettings(
      { size: "medium", provider: "bedrock", volume_gib: 100, secrets: "none" },
      "arn:aws:iam::123456789012:user/ops",
      NOW,
    );
    expect(Object.keys(settings.providers).sort()).toEqual([...PROVIDERS_LIST].sort());
    // No override anywhere: the catalog stays the fallback, so a provider whose
    // default model moves in a later release reaches a fleet that never said
    // otherwise.
    expect(Object.values(settings.providers).every((p) => p.default_model === undefined)).toBe(true);
    expect(settings.version).toBe(1);
    expect(settings.secrets).toEqual([]);
  });

  /**
   * The reason `providers` is a `partialRecord`: `Provider` is an enum that will
   * grow, and an exhaustive record would turn every `_fleet` written before the
   * new member into an item that cannot be read at all.
   */
  test("a settings object missing a provider entry still parses", () => {
    const settings = defaultFleetSettings(
      { size: "medium", provider: "bedrock", volume_gib: 100, secrets: "none" },
      "ops",
      NOW,
    );
    const { nous: _dropped, ...providers } = settings.providers;
    const parsed = FleetSettingsSchema.parse({ ...settings, providers });
    expect(parsed.providers["nous"]).toBeUndefined();
    // And an absent entry reads as the ordinary case, not as "disabled".
    expect(providerDefaultModel(parsed, "nous")).toBe("deepseek/deepseek-v4.1-flash");
  });

  test("it round-trips, and a fleet item with no settings still parses", () => {
    const settings = defaultFleetSettings(
      { size: "large", provider: "nous", volume_gib: 200, secrets: "bitwarden" },
      "ops",
      NOW,
    );
    expect(FleetSettingsSchema.parse(structuredClone(settings))).toEqual(settings);
    const { settings: _dropped, ...bare } = withSettings().fleetItem as FleetItem;
    expect(FleetItemSchema.parse(bare).settings).toBeUndefined();
  });

  test("providerDefaultModel prefers the fleet's override over the catalog's", () => {
    const base = defaultFleetSettings(
      { size: "medium", provider: "nous", volume_gib: 100, secrets: "none" },
      "ops",
      NOW,
    );
    expect(providerDefaultModel(base, "nous")).toBe("deepseek/deepseek-v4.1-flash");
    const overridden = {
      ...base,
      providers: { ...base.providers, nous: { enabled: true, default_model: "hermes-4" } },
    };
    expect(providerDefaultModel(overridden, "nous")).toBe("hermes-4");
  });
});

describe("settings.get", () => {
  test("a fleet that has settings reports them as persisted", async () => {
    const result = await core(withSettings()).settings.get();
    expect(result.persisted).toBe(true);
    expect(result.settings.version).toBe(1);
    expect(result.settings.defaults.provider).toBe("bedrock");
    // The catalog rides along so a head can render "override, else catalog"
    // without a second call.
    expect(Object.keys(result.catalog).sort()).toEqual([...PROVIDERS_LIST].sort());
  });

  test("a fleet that has none is answered, not refused, and says so", async () => {
    const backend = withoutSettings();
    const result = await core(backend).settings.get();
    expect(result.persisted).toBe(false);
    // Synthesized from `_fleet.defaults`, which is what that fleet's settings
    // *are* — the migration will write exactly this.
    expect(result.settings.defaults).toEqual(backend.fleetItem!.defaults);
    expect(result.settings.updated_by).toBe(backend.fleetItem!.created_by);
    expect(result.settings.version).toBe(1);
    // Reading did not write.
    expect(backend.fleetItem!.settings).toBeUndefined();
  });
});

describe("settings.set", () => {
  test("persists, increments the version, and mirrors defaults onto _fleet", async () => {
    const backend = withSettings();
    const result = await core(backend).settings.set({ defaults: { size: "large" } });
    expect(result.settings.version).toBe(2);
    expect(result.settings.defaults.size).toBe("large");
    // Untouched fields survive a patch.
    expect(result.settings.defaults.volume_gib).toBe(100);
    expect(backend.fleetItem!.settings?.defaults.size).toBe("large");
    // §10: the lifecycle reads `_fleet.defaults`, so the two must agree.
    expect(backend.fleetItem!.defaults).toEqual(result.settings.defaults);
    expect(backend.mutations).toContain("store.fleet.putSettings");
  });

  test("the first write on a fleet with no settings starts at version 1", async () => {
    const backend = withoutSettings();
    const result = await core(backend).settings.set({ defaults: { size: "large" } });
    expect(result.persisted).toBe(true);
    expect(result.settings.version).toBe(1);
    expect(backend.fleetItem!.settings?.defaults.size).toBe("large");
  });

  test("agent_defaults are set, patched and cleared", async () => {
    const backend = withSettings();
    const hermetic = core(backend);
    await hermetic.settings.set({ agent_defaults: { model: "claude-sonnet-5" } });
    expect(backend.fleetItem!.settings?.agent_defaults?.model).toBe("claude-sonnet-5");
    const cleared = await hermetic.settings.set({ agent_defaults: null });
    // Absent, not present-and-empty: an empty object would read as "the fleet
    // states these settings" to `splitHermesSettings`.
    expect(cleared.settings.agent_defaults).toBeUndefined();
    expect(backend.fleetItem!.settings?.agent_defaults).toBeUndefined();
  });

  /**
   * The property `settings set --approvals off` rests on: a stated Hermes
   * default is a *patch* on what the fleet already holds. A replacement would
   * make one flag on the command line silently drop the model somebody set
   * last week.
   */
  test("a stated agent default merges onto the fleet's, it does not replace them", async () => {
    const backend = withSettings();
    const hermetic = core(backend);
    await hermetic.settings.set({
      agent_defaults: { model: "claude-sonnet-5", terminal_backend: "docker" },
    });

    const merged = await hermetic.settings.set({ agent_defaults: { approvals_mode: "off" } });
    for (const settings of [merged.settings, backend.fleetItem!.settings!]) {
      expect(settings.agent_defaults).toEqual({
        model: "claude-sonnet-5",
        terminal_backend: "docker",
        approvals_mode: "off",
      });
    }
  });

  test("a key that is stated again is overwritten, not merged with itself", async () => {
    const backend = withSettings();
    const hermetic = core(backend);
    await hermetic.settings.set({ agent_defaults: { model: "claude-sonnet-5", max_turns: 200 } });
    const result = await hermetic.settings.set({ agent_defaults: { model: "claude-opus-5" } });
    expect(result.settings.agent_defaults).toEqual({ model: "claude-opus-5", max_turns: 200 });
    expect(backend.fleetItem!.settings?.agent_defaults?.model).toBe("claude-opus-5");
  });

  test("`null` on one key clears that key and leaves its neighbours alone", async () => {
    const backend = withSettings();
    const hermetic = core(backend);
    await hermetic.settings.set({
      agent_defaults: { model: "claude-sonnet-5", max_turns: 200, reasoning_effort: "high" },
    });
    const result = await hermetic.settings.set({ agent_defaults: { model: null } });
    expect(result.settings.agent_defaults).toEqual({ max_turns: 200, reasoning_effort: "high" });
    expect(backend.fleetItem!.settings?.agent_defaults).toEqual({
      max_turns: 200,
      reasoning_effort: "high",
    });
  });

  test("clearing the last key per-key leaves agent_defaults absent, not empty", async () => {
    const backend = withSettings();
    const hermetic = core(backend);
    await hermetic.settings.set({ agent_defaults: { model: "claude-sonnet-5" } });
    const result = await hermetic.settings.set({ agent_defaults: { model: null } });
    expect(result.settings.agent_defaults).toBeUndefined();
    expect(backend.fleetItem!.settings?.agent_defaults).toBeUndefined();
    expect(backend.fleetItem!.settings).not.toHaveProperty("agent_defaults");
    // …and the run log says "cleared", which is what actually happened.
    const events = await backend.store.events.query("_fleet");
    expect(events.some((e) => e.detail?.includes("agent_defaults cleared → v3") === true)).toBe(true);
  });

  test("a write that names nothing is a schema refusal, not a version bump", async () => {
    const backend = withSettings();
    expect(await codeOf(() => core(backend).settings.set({}))).toBeTruthy();
    expect(backend.fleetItem!.settings?.version).toBe(1);
  });

  /**
   * §8.3: the fleet default is a *profile*, named by id or by name, and
   * `_fleet.defaults.provider` is no longer settable at all — a create with no
   * flags resolves the profile, so a bare provider default would be a second
   * answer to the same question.
   */
  test("--default-profile designates a profile by name", async () => {
    const backend = withSettings();
    const result = await core(backend).settings.set({ default_profile: "openrouter-cheap" });
    expect(result.settings.default_profile).toBe(FIXTURE_PROFILE_IDS.openrouter);
    expect(backend.fleetItem!.settings?.default_profile).toBe(FIXTURE_PROFILE_IDS.openrouter);
  });

  test("the id is accepted too, and is what the name resolves to", async () => {
    const backend = withSettings();
    const result = await core(backend).settings.set({
      default_profile: FIXTURE_PROFILE_IDS.nous,
    });
    expect(result.settings.default_profile).toBe(FIXTURE_PROFILE_IDS.nous);
  });

  test("a profile the fleet does not have is NOT_FOUND", async () => {
    const backend = withSettings();
    expect(await codeOf(() => core(backend).settings.set({ default_profile: "nope" }))).toBe(
      "NOT_FOUND",
    );
    expect(backend.fleetItem!.settings?.version).toBe(1);
  });

  test("making a disabled profile the fleet default is refused", async () => {
    const backend = withSettings();
    // `vercel-gw` is the fixture's disabled profile.
    expect(await codeOf(() => core(backend).settings.set({ default_profile: "vercel-gw" }))).toBe(
      "VALIDATION",
    );
    expect(backend.fleetItem!.settings?.version).toBe(1);
  });

  test("the write is recorded against `_fleet` by name, never by value", async () => {
    const backend = withSettings();
    await core(backend).settings.set({ default_profile: "nous-lab" });
    const events = await backend.store.events.query("_fleet");
    expect(events[0]?.action).toBe("settings.set");
    expect(events[0]?.detail).toContain("nous-lab");
  });
});

describe("two writers, one _fleet", () => {
  test("both compose against version 1; the second is told to re-read", async () => {
    const backend = withSettings();
    const hermetic = core(backend);
    // Two operators, each holding the settings as they read them.
    const first = await hermetic.settings.get();
    const second = await hermetic.settings.get();
    expect(first.settings.version).toBe(second.settings.version);

    await hermetic.settings.set({
      defaults: { size: "large" },
      expected_version: first.settings.version,
    });
    expect(
      await codeOf(() =>
        hermetic.settings.set({
          defaults: { size: "small" },
          expected_version: second.settings.version,
        }),
      ),
    ).toBe("CONFLICT");
    // The loser wrote nothing.
    expect(backend.fleetItem!.settings?.defaults.size).toBe("large");
    expect(backend.fleetItem!.settings?.version).toBe(2);
  });

  test("the store refuses a stale write even when nobody named a version", async () => {
    const backend = withSettings();
    const settings = backend.fleetItem!.settings!;
    // A write composed against v1 arriving after somebody else moved it to v2.
    backend.fleetItem = {
      ...backend.fleetItem!,
      settings: { ...settings, version: 2 },
    };
    expect(
      await backend.store.fleet.putSettings({ ...settings, version: 2 }, 1, backend.clock.now()),
    ).toBe(false);
  });

  test("a live fleet lock is LOCKED, not a write that the stamp would drop", async () => {
    const backend = withSettings();
    backend.fleetItem = {
      ...backend.fleetItem!,
      lock: {
        owner: "someone-else",
        // Against the backend's own fixed clock, not the wall clock.
        expires: new Date(backend.clock.now().getTime() + 60_000).toISOString(),
      },
    };
    expect(await codeOf(() => core(backend).settings.set({ defaults: { size: "large" } }))).toBe(
      "LOCKED",
    );
    expect(backend.fleetItem!.settings?.version).toBe(1);
  });

  test("an expired lock is not a lock", async () => {
    const backend = withSettings();
    backend.fleetItem = {
      ...backend.fleetItem!,
      lock: {
        owner: "someone-who-died",
        expires: new Date(backend.clock.now().getTime() - 60_000).toISOString(),
      },
    };
    const result = await core(backend).settings.set({ defaults: { size: "large" } });
    expect(result.settings.version).toBe(2);
  });
});

describe("the v2 foundation migration", () => {
  test("it is the only entry between v1 and v2, and this build is past it", () => {
    // v2 is history now — v3 scoped the SSM namespace by fleet id — so what
    // this pins is that a fleet on v1 still gets exactly this one migration,
    // and that the build's own version has not fallen behind the list.
    expect(FOUNDATION_VERSION).toBeGreaterThanOrEqual(2);
    expect(migrationsBetween(1, 2).map((m) => m.version)).toEqual([2]);
  });

  test("it seeds settings, and running it twice changes nothing", async () => {
    const backend = withoutSettings();
    const migration = FOUNDATION_MIGRATIONS.find((m) => m.version === 2)!;
    const fleet = backend.fleetItem!;
    const deps = { backend, fleet, actor: "ops", nowIso: () => NOW, notes: [] };
    await migration.remote?.(deps);
    const first = structuredClone(fleet.settings);
    expect(first?.version).toBe(1);
    expect(Object.keys(first!.providers).sort()).toEqual([...PROVIDERS_LIST].sort());

    await migration.remote?.({
      ...deps,
      actor: "somebody-else",
      nowIso: () => "2030-01-01T00:00:00.000Z",
    });
    expect(fleet.settings).toEqual(first!);
  });

  test("foundation.update ends with settings on _fleet and the version stamped", async () => {
    const backend = seedFixtureAgents(seedFixtureFoundation(new MemoryBackend()));
    // A fleet as it stood before either existed: no version, no settings.
    const {
      foundation_version: _v,
      foundation_template_sha256: _s,
      settings: _settings,
      ...rest
    } = backend.fleetItem as FleetItem;
    backend.fleetItem = { ...rest, min_hermetic_version: "0.4.0" };

    await drain(
      core(backend, {
        foundation: { changeSetPollMs: 0, rolloutPollMs: 1, heartbeatMs: 60_000 },
      }).foundation.update({ yes: true }),
    );

    const fleet = backend.fleetItem!;
    expect(fleet.foundation_version).toBe(FOUNDATION_VERSION);
    // The stamp is the last write and rewrites the whole item, so this is the
    // assertion that the migration's patch survived it (`runMigrations` returns
    // the item the stamp is handed).
    expect(fleet.settings?.version).toBe(1);
    expect(fleet.settings?.defaults).toEqual(fleet.defaults);
    expect(fleet.lock).toBeNull();

    // And the surface agrees: nothing is synthesized any more.
    const result = await core(backend).settings.get();
    expect(result.persisted).toBe(true);
  });

  /**
   * The lock-take is a whole-item Put, and there are several awaits between the
   * read it was composed from and the write. A settings write that lands in
   * that window used to be reverted with no error anywhere — the update simply
   * wrote back the `_fleet` it had read first.
   */
  test("a settings write racing the lock-take is not reverted by it", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const hermetic = core(backend, {
      foundation: { changeSetPollMs: 0, rolloutPollMs: 1, heartbeatMs: 60_000 },
    });
    const {
      foundation_version: _v,
      foundation_template_sha256: _s,
      ...rest
    } = backend.fleetItem as FleetItem;
    backend.fleetItem = { ...rest, min_hermetic_version: "0.4.0" };

    // The agent scan sits inside the window, so this is that window.
    const scan = backend.store.agents.scan.bind(backend.store.agents);
    let raced = false;
    backend.store.agents.scan = async () => {
      if (!raced) {
        raced = true;
        await core(backend).settings.set({ defaults: { size: "xlarge" } });
      }
      return scan();
    };

    await drain(hermetic.foundation.update({ yes: true }));
    expect(raced).toBe(true);
    expect(backend.fleetItem!.settings?.defaults.size).toBe("xlarge");
    expect(backend.fleetItem!.defaults.size).toBe("xlarge");
    expect(backend.fleetItem!.foundation_version).toBe(FOUNDATION_VERSION);
  });

  test("an update over a fleet that already set settings keeps them", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    await core(backend).settings.set({ defaults: { size: "large" } });
    const {
      foundation_version: _v,
      foundation_template_sha256: _s,
      ...rest
    } = backend.fleetItem as FleetItem;
    backend.fleetItem = { ...rest, min_hermetic_version: "0.4.0" };

    await drain(
      core(backend, {
        foundation: { changeSetPollMs: 0, rolloutPollMs: 1, heartbeatMs: 60_000 },
      }).foundation.update({ yes: true }),
    );

    // The operator's write, not the migration's default.
    expect(backend.fleetItem!.settings?.version).toBe(2);
    expect(backend.fleetItem!.settings?.defaults.size).toBe("large");
  });
});
