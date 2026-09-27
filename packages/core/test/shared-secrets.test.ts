/**
 * §8.2/§8.3's fleet-level shared secrets: `secrets push _fleet --shared`,
 * `secrets ls`, `secrets rm`, and the stale-copy half of `secrets verify`.
 *
 * The property this file exists for is the one the whole feature rests on: **a
 * value never comes back out.** Every read here is metadata, and the one
 * comparison that touches two values (`verify`) answers with a boolean. The
 * second property is the one the design chose deliberately — a shared slot is
 * *copied* into an agent, so rotating it does not reach live agents unless
 * `--rekey` says so, and `verify` is what makes that visible instead of silent.
 */
import { describe, expect, test } from "bun:test";
import {
  FIXTURE_CONFIG,
  FIXTURE_PROFILE_IDS,
  FIXTURE_SHARED_NOUS_KEY,
  MemoryBackend,
  SECRET_PLACEHOLDER,
  seedFixtureFleet,
  seedFixtureFoundation,
} from "../src/backend/memory.ts";
import { sharedSecretPath as sharedSecretPathFor } from "../src/backend/constants.ts";

/**
 * Every slug the fixture fleet declares: the two hand-pushed shared slots and
 * the four the keyed provider profiles own (§8.3).
 */
const FIXTURE_SLUGS: readonly string[] = [
  "nous-key",
  "openrouter-key",
  ...(["anthropic", "openrouter", "nous", "vercel"] as const).map(
    (p) => `profile-${FIXTURE_PROFILE_IDS[p]}`,
  ),
];

/** Every shared slot is scoped by the fleet id since v3 (§8.2). */
const sharedSecretPath = (slug: string): string => sharedSecretPathFor(FIXTURE_CONFIG.fleet_id, slug);
import type { Agent } from "../src/schema/index.ts";
import { HermeticError } from "../src/errors.ts";
import { drain, OK_OAUTH, testHermetic } from "./helpers.ts";
import type { HermeticDeps } from "../src/hermetic.ts";

/** A fixture value that is still obviously a fixture (§11.3, the leak grep). */
const NEW_KEY = "sk-nous-FIXTURE-ROTATED-KEY";

function core(backend: MemoryBackend, deps: Partial<HermeticDeps> = {}) {
  return testHermetic({ backend, config: FIXTURE_CONFIG, ...deps });
}

async function codeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof HermeticError ? e.code : `not-a-HermeticError:${String(e)}`;
  }
}

/** The same, for the refusals whose *wording* is the point and not only the code. */
async function errorOf(fn: () => Promise<unknown>): Promise<HermeticError> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof HermeticError) return e;
    throw e;
  }
  throw new Error("expected a HermeticError, and the call succeeded");
}

describe("secrets push _fleet --shared", () => {
  test("writes the slot, records the slug, and returns neither the value nor a label", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const result = await core(backend).secrets.push({
      name: "_fleet",
      shared: "openrouter-key",
      value: NEW_KEY,
    });
    expect(result.path).toBe("/hermetic/fxtr0001/secrets/openrouter-key");
    expect(JSON.stringify(result)).not.toInclude(NEW_KEY);
    expect(backend.params.get("/hermetic/fxtr0001/secrets/openrouter-key")).toBe(NEW_KEY);

    const meta = backend.fleetItem!.settings!.secrets.find((s) => s.slug === "openrouter-key");
    // The label the slot already had survives a push that states none: pushing
    // a new value is not a way to lose the slot's name.
    expect(meta).toMatchObject({ label: "OpenRouter" });
    expect(meta!.created_at).toBe(FIXTURE_CONFIG.frozen_at);
    expect(meta!.last_set_at).not.toBe(FIXTURE_CONFIG.frozen_at);

    const events = await backend.store.events.query("_fleet");
    const pushed = events.find((e) => e.action === "secrets.push");
    expect(pushed!.detail).toInclude("openrouter-key");
    expect(JSON.stringify(events)).not.toInclude(NEW_KEY);
  });

  test("a slug nothing has declared is created, with the label it was given", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    await core(backend).secrets.push({
      name: "_fleet",
      shared: "anthropic-key",
      label: "Anthropic (billing)",
      value: NEW_KEY,
    });
    const meta = backend.fleetItem!.settings!.secrets.find((s) => s.slug === "anthropic-key");
    expect(meta).toMatchObject({ slug: "anthropic-key", label: "Anthropic (billing)" });
    expect(meta!.created_at).toBe(meta!.last_set_at);
  });

  /**
   * The slug is concatenated into an SSM path, so its shape is the only thing
   * standing between an operator's typo and a write outside `/hermetic/fxtr0001/secrets/`.
   */
  test("the slug shape is a refusal, not an escape", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const hermetic = core(backend);
    for (const slug of [
      "../tailscale/oauth-secret",
      "a/b",
      "UPPER",
      "-leading-hyphen",
      "_fleet",
      "",
      "x".repeat(32),
    ]) {
      await expect(
        hermetic.secrets.push({ name: "_fleet", shared: slug, value: NEW_KEY }),
      ).rejects.toThrow();
    }
    expect(
      [...backend.params.keys()].filter((k) => !k.startsWith("/hermetic/fxtr0001/secrets/")),
    ).toEqual([]);
  });

  test("a shared push is a fleet slot: an agent name is refused, and so are two flags", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const hermetic = core(backend);
    await expect(
      hermetic.secrets.push({ name: "atlas", shared: "nous-key", value: NEW_KEY }),
    ).rejects.toThrow(/fleet-wide/);
    await expect(
      hermetic.secrets.push({
        name: "_fleet",
        shared: "nous-key",
        tailscale_oauth: true,
        value: NEW_KEY,
      }),
    ).rejects.toThrow(/one at a time/);
    // `--label` and `--rekey` are shared-only: they mean nothing on any other slot.
    await expect(
      hermetic.secrets.push({ name: "atlas", provider_key: true, label: "x", value: NEW_KEY }),
    ).rejects.toThrow(/--label/);
    await expect(
      hermetic.secrets.push({ name: "atlas", provider_key: true, rekey: "all", value: NEW_KEY }),
    ).rejects.toThrow(/--rekey/);
  });

  /**
   * The half-landed race. The value goes in before the metadata that names it —
   * the other order would leave `_fleet` claiming a slot that was never filled —
   * so a lost race leaves a written slot and an unrecorded entry. The message
   * has to say that, or the operator re-runs believing nothing happened and
   * cannot tell why the re-key never ran.
   */
  test("a lost race says which half landed", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const real = backend.store.fleet.putSettings.bind(backend.store.fleet);
    backend.store.fleet.putSettings = async () => false;
    let error: HermeticError | null = null;
    try {
      await core(backend).secrets.push({
        name: "_fleet",
        shared: "nous-key",
        value: NEW_KEY,
        rekey: "all",
      });
    } catch (e) {
      error = e as HermeticError;
    } finally {
      backend.store.fleet.putSettings = real;
    }
    expect(error!.code).toBe("CONFLICT");
    expect(error!.message).toInclude("nous-key was written");
    expect(error!.message).toInclude("re-run the same push");
    // The slot really did land; the entry and the re-key did not.
    expect(backend.params.get("/hermetic/fxtr0001/secrets/nous-key")).toBe(NEW_KEY);
    expect(backend.fleetItem!.settings!.secrets.find((x) => x.slug === "nous-key")!.last_set_at).toBe(
      FIXTURE_CONFIG.frozen_at,
    );
  });

  test("a foundation update holding the fleet lock is LOCKED", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    backend.fleetItem = {
      ...backend.fleetItem!,
      lock: {
        owner: "someone-else",
        expires: new Date(backend.clock.now().getTime() + 60_000).toISOString(),
      },
    };
    expect(
      await codeOf(() =>
        core(backend).secrets.push({ name: "_fleet", shared: "nous-key", value: NEW_KEY }),
      ),
    ).toBe("LOCKED");
    expect(backend.params.get("/hermetic/fxtr0001/secrets/nous-key")).toBe(FIXTURE_SHARED_NOUS_KEY);
  });
});

describe("secrets push --rekey", () => {
  /**
   * An agent bound to a profile whose credential *is* the fixture's shared slot
   * (§8.3) — the shape `profile-migrate.ts` produces for a fleet that named a
   * shared secret before profiles existed, and the only shape a `--shared`
   * rekey has anything to say about. A profile that owns its own slot is
   * rotated through `providers set --api-key-stdin` instead.
   */
  async function withNousAgent() {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const settings = backend.fleetItem!.settings!;
    settings.profiles = {
      ...settings.profiles,
      nousshrd: {
        id: "nousshrd",
        name: "nous-shared",
        provider: "nous",
        model: "deepseek-v4-flash-0731",
        enabled: true,
        revision: 1,
        credential: { kind: "secret", slug: "nous-key" },
        created_at: FIXTURE_CONFIG.frozen_at,
        created_by: FIXTURE_CONFIG.frozen_by,
        updated_at: FIXTURE_CONFIG.frozen_at,
        updated_by: FIXTURE_CONFIG.frozen_by,
      },
    };
    const hermetic = core(backend);
    await drain(hermetic.agents.create({ name: "orbit", provider_profile: "nous-shared" }));
    return { backend, hermetic };
  }

  test("`all` re-copies into every agent whose provider reads the slot", async () => {
    const { backend, hermetic } = await withNousAgent();
    const result = await hermetic.secrets.push({
      name: "_fleet",
      shared: "nous-key",
      value: NEW_KEY,
      rekey: "all",
    });
    expect(result.rekeyed).toEqual(["orbit"]);
    expect(backend.params.get("/hermes/fxtr0001/orbit/provider-key-nousshrd-r1")).toBe(NEW_KEY);
    const events = await backend.store.events.query("orbit");
    expect(events.some((e) => e.detail?.includes("rekeyed from shared slot nous-key"))).toBe(true);
    expect(JSON.stringify(events)).not.toInclude(NEW_KEY);
  });

  test("without --rekey, a live agent keeps the value it was created with", async () => {
    const { backend, hermetic } = await withNousAgent();
    const result = await hermetic.secrets.push({
      name: "_fleet",
      shared: "nous-key",
      value: NEW_KEY,
    });
    expect(result.rekeyed).toEqual([]);
    expect(backend.params.get("/hermes/fxtr0001/orbit/provider-key-nousshrd-r1")).toBe(
      FIXTURE_SHARED_NOUS_KEY,
    );
  });

  /**
   * Refused *before* the slot is written, because a list naming an agent that
   * does not read this slot is a mistake, and half-applying it would leave the
   * fleet rotated and the operator told it failed.
   */
  test("an agent whose provider does not read the slot is refused, and nothing is written", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const before = backend.params.get("/hermetic/fxtr0001/secrets/nous-key");
    expect(
      await codeOf(() =>
        core(backend).secrets.push({
          name: "_fleet",
          shared: "nous-key",
          value: NEW_KEY,
          rekey: ["atlas"],
        }),
      ),
    ).toBe("VALIDATION");
    expect(backend.params.get("/hermetic/fxtr0001/secrets/nous-key")).toBe(before);
  });

  /**
   * `destroy` sweeps `/hermes/<name>/` (§6.6). A rekey that treated a destroyed
   * row as a target would put a live provider key back into an account for a
   * box that no longer exists — recreating the very slot the sweep deleted.
   */
  test("`all` skips a destroyed agent rather than re-creating the slot destroy swept", async () => {
    const { backend, hermetic } = await withNousAgent();
    await drain(hermetic.agents.destroy({ name: "orbit", yes: true }));
    expect(backend.params.has("/hermes/fxtr0001/orbit/provider-key-nousshrd-r1")).toBe(false);

    const result = await hermetic.secrets.push({
      name: "_fleet",
      shared: "nous-key",
      value: NEW_KEY,
      rekey: "all",
    });
    expect(result.rekeyed).toEqual([]);
    expect(backend.params.has("/hermes/fxtr0001/orbit/provider-key-nousshrd-r1")).toBe(false);
  });

  test("naming a destroyed agent is refused, not silently honoured", async () => {
    const { backend, hermetic } = await withNousAgent();
    await drain(hermetic.agents.destroy({ name: "orbit", yes: true }));
    let error: HermeticError | null = null;
    try {
      await hermetic.secrets.push({
        name: "_fleet",
        shared: "nous-key",
        value: NEW_KEY,
        rekey: ["orbit"],
      });
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error!.code).toBe("VALIDATION");
    expect(error!.message).toInclude("orbit is destroyed");
    expect(error!.details!["status"]).toBe("destroyed");
    // Refused before anything: neither the fleet slot nor the swept agent slot moved.
    expect(backend.params.get("/hermetic/fxtr0001/secrets/nous-key")).toBe(FIXTURE_SHARED_NOUS_KEY);
    expect(backend.params.has("/hermes/fxtr0001/orbit/provider-key-nousshrd-r1")).toBe(false);
  });

  test("an agent that does not exist is NOT_FOUND, and nothing is written", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const before = backend.params.get("/hermetic/fxtr0001/secrets/nous-key");
    expect(
      await codeOf(() =>
        core(backend).secrets.push({
          name: "_fleet",
          shared: "nous-key",
          value: NEW_KEY,
          rekey: ["nosuchagent"],
        }),
      ),
    ).toBe("NOT_FOUND");
    expect(backend.params.get("/hermetic/fxtr0001/secrets/nous-key")).toBe(before);
  });
});

describe("secrets.list", () => {
  test("names every slot, its state and its readers — and no value", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const { secrets } = await core(backend).secrets.list();
    const bySlug = new Map(secrets.map((s) => [s.slug, s]));

    expect(bySlug.get("nous-key")).toMatchObject({
      label: "Nous Portal",
      exists: true,
      placeholder: false,
      used_by: ["nous"],
    });
    // Declared, never filled: the state a provider naming it would fall over on.
    expect(bySlug.get("openrouter-key")).toMatchObject({
      exists: true,
      placeholder: true,
      used_by: [],
    });
    expect(JSON.stringify(secrets)).not.toInclude(FIXTURE_SHARED_NOUS_KEY);
  });

  test("a parameter no settings entry names is listed as an orphan", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    backend.params.set(sharedSecretPath("forgotten-key"), "sk-FIXTURE-FORGOTTEN");
    const { secrets } = await core(backend).secrets.list();
    const orphan = secrets.find((s) => s.slug === "forgotten-key");
    expect(orphan).toMatchObject({ orphan: true, exists: true, used_by: [] });
    expect(orphan!.label).toBeUndefined();
  });

  /**
   * `SsmSecrets.list` is recursive, so a parameter one level deeper arrives
   * with a slash in its name — a slug no `SecretSlug` can spell and `secrets
   * rm` could never address. Listing it would offer the operator a row nothing
   * can act on.
   */
  test("a nested parameter under the prefix is not one of ours", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    backend.params.set("/hermetic/fxtr0001/secrets/vendor/sub-key", "sk-FIXTURE-NESTED");
    const { secrets } = await core(backend).secrets.list();
    // The four `profile-*` slots the fixture's provider profiles own are listed
    // too; the nested one is the only slug missing from the answer.
    expect(secrets.map((s) => s.slug)).toEqual([...FIXTURE_SLUGS].sort());
  });

  test("a slug with no parameter behind it reads as missing rather than set", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    backend.params.delete(sharedSecretPath("nous-key"));
    const { secrets } = await core(backend).secrets.list();
    expect(secrets.find((s) => s.slug === "nous-key")).toMatchObject({
      exists: false,
      placeholder: false,
    });
  });
});

describe("secrets.delete", () => {
  /**
   * The state a migrated fleet is in (§8.3): the `nous` profile's credential is
   * the shared slug that predates profiles, so `nous-key` is pointed at by both
   * a profile and the pre-profile `settings.providers.nous.secret` — and owned
   * by neither, because `providers create` did not mint it.
   */
  function migratedNousProfile(backend: MemoryBackend): void {
    const settings = backend.fleetItem!.settings!;
    const id = FIXTURE_PROFILE_IDS.nous;
    backend.fleetItem = {
      ...backend.fleetItem!,
      settings: {
        ...settings,
        profiles: {
          ...settings.profiles,
          [id]: { ...settings.profiles![id]!, credential: { kind: "secret", slug: "nous-key" } },
        },
      },
    };
  }

  /**
   * `marrow` is the fixture's pre-profile row on a keyed provider: no
   * `profile_id`, so its key is resolved through
   * `settings.providers.nous.secret` — the one reader `nous-key` has. `over`
   * is how a test takes that reader away.
   */
  function legacyNousAgent(backend: MemoryBackend, over: Partial<Agent> = {}): void {
    const marrow = backend.agents.get("marrow")!;
    expect(marrow.profile_id).toBeUndefined();
    expect(marrow.provider).toBe("nous");
    if (Object.keys(over).length > 0) backend.agents.set("marrow", { ...marrow, ...over });
  }

  test("refuses while an unbound agent still reads the slug through the legacy map", async () => {
    // Only the pre-profile pointer names `nous-key` here; the profile keeps its
    // own slot, so the reader is the one thing standing between slug and delete.
    const backend = seedFixtureFleet(new MemoryBackend());
    legacyNousAgent(backend);
    let error: HermeticError | null = null;
    try {
      await core(backend).secrets.delete({ slug: "nous-key", yes: true });
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error!.code).toBe("CONFLICT");
    // The agent, not the provider: recreating or re-binding `ember` is the work
    // this refusal is asking for, and "nous" names nothing an operator can act on.
    expect(error!.message).toInclude("marrow");
    expect(error!.details).toMatchObject({ used_by: ["marrow"] });
    expect(backend.params.has("/hermetic/fxtr0001/secrets/nous-key")).toBe(true);
    expect(backend.fleetItem!.settings!.providers.nous!.secret).toBe("nous-key");
  });

  /**
   * The bug this pair exists for: §8.3 removed `providers set --no-secret`, the
   * only command that could clear a pre-profile pointer, so refusing on the
   * pointer itself left a migrated fleet with a slot nothing reads and nothing
   * can free. The refusal is about readers; the stale pointer goes with the
   * slot.
   */
  test("refuses while a profile inherited the slug from the legacy map, naming the profile", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    migratedNousProfile(backend);
    legacyNousAgent(backend, { status: "destroyed" });
    let error: HermeticError | null = null;
    try {
      await core(backend).secrets.delete({ slug: "nous-key", yes: true });
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error!.code).toBe("CONFLICT");
    // `providers update` cannot move an inherited credential onto a slot of its
    // own, so the profile reads this slug for as long as it exists: the way out
    // is `providers rm`, or a rotation in place, and the message says both.
    expect(error!.message).toInclude("nous");
    expect(error!.message).toInclude("providers rm");
    expect(error!.message).toInclude("secrets push _fleet --shared nous-key");
    expect(error!.details).toMatchObject({ profiles: [FIXTURE_PROFILE_IDS.nous] });
    expect(backend.params.has("/hermetic/fxtr0001/secrets/nous-key")).toBe(true);
    expect(backend.fleetItem!.settings!.providers.nous!.secret).toBe("nous-key");
  });

  for (const [what, over] of [
    ["destroyed", { status: "destroyed" } as Partial<Agent>],
    ["bound to a profile", { profile_id: FIXTURE_PROFILE_IDS.nous } as Partial<Agent>],
  ] as const) {
    test(`succeeds when the only legacy row is ${what}, and scrubs the pointer with it`, async () => {
      // The fixture's `nous` profile keeps its own slot here: only the legacy
      // pointer names `nous-key`, and it is the pointer this pair is about.
      const backend = seedFixtureFleet(new MemoryBackend());
      legacyNousAgent(backend, over);
      const version = backend.fleetItem!.settings!.version;

      const result = await core(backend).secrets.delete({ slug: "nous-key", yes: true });
      expect(result).toEqual({ slug: "nous-key", deleted: true });
      expect(backend.params.has("/hermetic/fxtr0001/secrets/nous-key")).toBe(false);

      const settings = backend.fleetItem!.settings!;
      expect(settings.providers.nous!.secret).toBeUndefined();
      // The pointer, and nothing else about the entry.
      expect(settings.providers.nous).toMatchObject({
        enabled: true,
        default_model: "deepseek-v4-flash-0731",
      });
      expect(settings.secrets.map((s) => s.slug)).toEqual(
        [...FIXTURE_SLUGS].filter((slug) => slug !== "nous-key").sort(),
      );
      expect(settings.version).toBe(version + 1);
      const events = await backend.store.events.query("_fleet");
      expect(events.some((e) => e.action === "secrets.delete")).toBe(true);
    });
  }

  /** The fleet that never had a pre-profile pointer: the map is left alone. */
  test("succeeds once no provider entry names it", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const hermetic = core(backend);
    const settings = backend.fleetItem!.settings!;
    const { secret: _dropped, ...nous } = settings.providers.nous!;
    backend.fleetItem = {
      ...backend.fleetItem!,
      settings: { ...settings, providers: { ...settings.providers, nous } },
    };
    const version = settings.version;
    const result = await hermetic.secrets.delete({ slug: "nous-key", yes: true });
    expect(result).toEqual({ slug: "nous-key", deleted: true });
    expect(backend.params.has("/hermetic/fxtr0001/secrets/nous-key")).toBe(false);
    expect(backend.fleetItem!.settings!.providers).toEqual({ ...settings.providers, nous });
    expect(backend.fleetItem!.settings!.version).toBe(version + 1);
    expect(backend.fleetItem!.settings!.secrets.map((s) => s.slug)).toEqual(
      [...FIXTURE_SLUGS].filter((slug) => slug !== "nous-key").sort(),
    );
    const events = await backend.store.events.query("_fleet");
    expect(events.some((e) => e.action === "secrets.delete")).toBe(true);
  });

  test("core refuses without the confirmation, whatever the head asked", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    expect(await codeOf(() => core(backend).secrets.delete({ slug: "openrouter-key" }))).toBe(
      "CONFIRMATION_REQUIRED",
    );
    expect(backend.params.has("/hermetic/fxtr0001/secrets/openrouter-key")).toBe(true);
  });

  test("a slug that is neither declared nor stored is NOT_FOUND", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    expect(await codeOf(() => core(backend).secrets.delete({ slug: "never-existed", yes: true }))).toBe(
      "NOT_FOUND",
    );
  });

  /**
   * The ceremony is for a delete that would otherwise go through. A slug that
   * never existed, or one a provider still reads, is refusable without the
   * operator typing anything — so it is refused first.
   */
  test("a typo is NOT_FOUND without demanding a confirmation for nothing", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    expect(await codeOf(() => core(backend).secrets.delete({ slug: "typo-slug" }))).toBe("NOT_FOUND");
  });

  test("a slug an unbound agent still reads is CONFLICT before the confirmation", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    legacyNousAgent(backend);
    expect(await codeOf(() => core(backend).secrets.delete({ slug: "nous-key" }))).toBe("CONFLICT");
  });

  /**
   * The state that had no way out (§8.3): a pre-profile pointer with no
   * `settings.secrets` entry — nothing wrote one before §8.2 — whose parameter
   * an operator has since deleted by hand.
   *
   * `meta === undefined && !exists` reads as "never existed", but the pointer
   * is right there, and this is the only command that can scrub it: §8.3
   * retired `providers set --no-secret`. A `NOT_FOUND` therefore left the fleet
   * naming a slot forever, reported by every head and freeable by nothing. The
   * delete is admitted on the pointer alone; there is simply no parameter to
   * remove.
   */
  test("a pointer whose entry and parameter are both gone is still freeable", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    legacyNousAgent(backend, { status: "destroyed" });
    const settings = backend.fleetItem!.settings!;
    backend.fleetItem = {
      ...backend.fleetItem!,
      // No metadata entry, the shape a pre-§8.2 fleet is in…
      settings: { ...settings, secrets: settings.secrets.filter((x) => x.slug !== "nous-key") },
    };
    // …and no parameter either, deleted in the console.
    backend.params.delete("/hermetic/fxtr0001/secrets/nous-key");
    expect(backend.fleetItem!.settings!.providers.nous!.secret).toBe("nous-key");
    const version = backend.fleetItem!.settings!.version;

    const result = await core(backend).secrets.delete({ slug: "nous-key", yes: true });

    expect(result).toEqual({ slug: "nous-key", deleted: true });
    // The pointer is gone, which was the whole point, and the rest of the
    // provider entry is untouched.
    const after = backend.fleetItem!.settings!;
    expect(after.providers.nous!.secret).toBeUndefined();
    expect(after.providers.nous).toMatchObject({ enabled: true });
    expect(after.version).toBe(version + 1);
  });

  /**
   * And the refusals still apply to it: a pointer an agent actually reads is a
   * `CONFLICT`, not a free delete. Admitting the delete is about the pointer
   * having no reader, never about the parameter being absent.
   */
  test("a pointer with no parameter is still refused while an agent reads it", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    legacyNousAgent(backend);
    const settings = backend.fleetItem!.settings!;
    backend.fleetItem = {
      ...backend.fleetItem!,
      settings: { ...settings, secrets: settings.secrets.filter((x) => x.slug !== "nous-key") },
    };
    backend.params.delete("/hermetic/fxtr0001/secrets/nous-key");

    expect(await codeOf(() => core(backend).secrets.delete({ slug: "nous-key", yes: true }))).toBe(
      "CONFLICT",
    );
    expect(backend.fleetItem!.settings!.providers.nous!.secret).toBe("nous-key");
  });

  test("an orphan parameter can be deleted without any settings to rewrite", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    backend.params.set(sharedSecretPath("forgotten-key"), "sk-FIXTURE-FORGOTTEN");
    const version = backend.fleetItem!.settings!.version;
    await core(backend).secrets.delete({ slug: "forgotten-key", yes: true });
    expect(backend.params.has("/hermetic/fxtr0001/secrets/forgotten-key")).toBe(false);
    expect(backend.fleetItem!.settings!.version).toBe(version);
  });
});

/**
 * §8.3's stale-copy report. The agent's own slot is a *copy* of the fleet's, so
 * "is this box holding the current key" is a question nothing else in hermetic
 * can answer — and it is answered by comparing digests, so no value moves.
 */
describe("secrets.verify · the shared copy", () => {
  /** The migrated shape: a profile whose credential is the fleet's shared slot. */
  async function withNousAgent() {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const settings = backend.fleetItem!.settings!;
    settings.profiles = {
      ...settings.profiles,
      nousshrd: {
        id: "nousshrd",
        name: "nous-shared",
        provider: "nous",
        model: "deepseek-v4-flash-0731",
        enabled: true,
        revision: 1,
        credential: { kind: "secret", slug: "nous-key" },
        created_at: FIXTURE_CONFIG.frozen_at,
        created_by: FIXTURE_CONFIG.frozen_by,
        updated_at: FIXTURE_CONFIG.frozen_at,
        updated_by: FIXTURE_CONFIG.frozen_by,
      },
    };
    const hermetic = core(backend);
    await drain(hermetic.agents.create({ name: "orbit", provider_profile: "nous-shared" }));
    return { backend, hermetic };
  }

  test("an agent holding the fleet's value reports current", async () => {
    const { hermetic } = await withNousAgent();
    const report = await hermetic.secrets.verify({ name: "orbit" });
    expect(report.shared).toEqual({ slug: "nous-key", current: true });
    expect(JSON.stringify(report)).not.toInclude(FIXTURE_SHARED_NOUS_KEY);
  });

  test("a rotation without --rekey leaves the agent stale, and says so", async () => {
    const { hermetic } = await withNousAgent();
    await hermetic.secrets.push({ name: "_fleet", shared: "nous-key", value: NEW_KEY });
    expect((await hermetic.secrets.verify({ name: "orbit" })).shared).toEqual({
      slug: "nous-key",
      current: false,
    });
    await hermetic.secrets.push({
      name: "_fleet",
      shared: "nous-key",
      value: NEW_KEY,
      rekey: ["orbit"],
    });
    expect((await hermetic.secrets.verify({ name: "orbit" })).shared).toEqual({
      slug: "nous-key",
      current: true,
    });
  });

  test("an empty slot on either side is `null`, not `false`", async () => {
    const { backend, hermetic } = await withNousAgent();
    backend.params.set(sharedSecretPath("nous-key"), SECRET_PLACEHOLDER);
    expect((await hermetic.secrets.verify({ name: "orbit" })).shared).toEqual({
      slug: "nous-key",
      current: null,
    });
  });

  /**
   * §8.3: the slug is the *bound profile's*, not whatever the pre-profile map
   * still says about the provider.
   *
   * `kestrel` runs on `anthropic-main`, whose credential is the slot that
   * profile owns, and the fixture's legacy `providers` map names no anthropic
   * slug at all. Answered from the map, this agent has no shared source and the
   * stale-copy report is simply absent — which reads as "nothing to check" for
   * an agent whose key is a copy of a shared slot like any other.
   */
  test("the slug compared is the bound profile's, not the pre-profile map's", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    expect(backend.fleetItem!.settings!.providers.anthropic?.secret).toBeUndefined();
    expect((await core(backend).secrets.verify({ name: "kestrel" })).shared).toEqual({
      slug: `profile-${FIXTURE_PROFILE_IDS.anthropic}`,
      current: true,
    });
  });

  test("an agent whose binding names no shared slot has nothing to report", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    // A row bound to a profile that has since been deleted: there is no
    // credential to compare against, and inventing one from the provider map
    // is the guess this report must not make.
    const kestrel = backend.agents.get("kestrel")!;
    backend.agents.set("kestrel", { ...kestrel, profile_id: "gonegone" });
    expect((await core(backend).secrets.verify({ name: "kestrel" })).shared).toBeUndefined();
  });
});

/**
 * §8.3: **who reads a shared slug** is a question about bindings, not about
 * providers.
 *
 * Before profiles there was one slot per provider, so "every agent on this
 * provider" and "every agent that reads this slot" were the same set. Two
 * profiles on one provider — the ordinary case now — make them different sets,
 * and a `--rekey` that asked the old question writes the new key into the slots
 * of agents that read a *different* profile's credential, while the agents that
 * actually read the rotated one are passed over. Both halves are silent.
 */
describe("secrets push --rekey · who reads a slug", () => {
  const ALT_SLUG = "anthropic-alt-key";
  const ALT_KEY = "sk-ant-FIXTURE-ALT";

  /**
   * A second anthropic profile with a slot of its own, and an agent on it. The
   * fixture already has `kestrel` on `anthropic-main`, so the fleet ends up
   * with two agents on one provider reading two different shared slots.
   */
  async function withSecondAnthropicProfile() {
    const backend = seedFixtureFleet(new MemoryBackend());
    const settings = backend.fleetItem!.settings!;
    settings.profiles = {
      ...settings.profiles,
      antalt00: {
        id: "antalt00",
        name: "anthropic-alt",
        provider: "anthropic",
        model: "claude-sonnet-5",
        enabled: true,
        revision: 1,
        credential: { kind: "secret", slug: ALT_SLUG },
        created_at: FIXTURE_CONFIG.frozen_at,
        created_by: FIXTURE_CONFIG.frozen_by,
        updated_at: FIXTURE_CONFIG.frozen_at,
        updated_by: FIXTURE_CONFIG.frozen_by,
      },
    };
    backend.params.set(sharedSecretPath(ALT_SLUG), ALT_KEY);
    const hermetic = core(backend);
    await drain(hermetic.agents.create({ name: "kite", provider_profile: "anthropic-alt" }));
    return { backend, hermetic };
  }

  const slotOf = (agent: string, slot: string) => `/hermes/fxtr0001/${agent}/${slot}`;
  const kestrelSlot = slotOf("kestrel", `provider-key-${FIXTURE_PROFILE_IDS.anthropic}-r1`);
  const kiteSlot = slotOf("kite", "provider-key-antalt00-r1");

  test("`--rekey all` re-keys the agents bound to the slug's profile, and only those", async () => {
    const { backend, hermetic } = await withSecondAnthropicProfile();
    const result = await hermetic.secrets.push({
      name: "_fleet",
      shared: `profile-${FIXTURE_PROFILE_IDS.anthropic}`,
      value: NEW_KEY,
      rekey: "all",
    });
    expect(result.rekeyed).toEqual(["kestrel"]);
    expect(backend.params.get(kestrelSlot)).toBe(NEW_KEY);
    // The other anthropic agent reads the other profile's slot, which this
    // rotation is not about.
    expect(backend.params.get(kiteSlot)).toBe(ALT_KEY);
  });

  test("rotating the second profile's slug reaches its agent and not the first's", async () => {
    const { backend, hermetic } = await withSecondAnthropicProfile();
    const before = backend.params.get(kestrelSlot);
    const result = await hermetic.secrets.push({
      name: "_fleet",
      shared: ALT_SLUG,
      value: NEW_KEY,
      rekey: "all",
    });
    expect(result.rekeyed).toEqual(["kite"]);
    expect(backend.params.get(kiteSlot)).toBe(NEW_KEY);
    expect(backend.params.get(kestrelSlot)).toBe(before);
  });

  test("naming an agent that reads the slug through its profile is allowed", async () => {
    const { backend, hermetic } = await withSecondAnthropicProfile();
    const result = await hermetic.secrets.push({
      name: "_fleet",
      shared: `profile-${FIXTURE_PROFILE_IDS.anthropic}`,
      value: NEW_KEY,
      rekey: ["kestrel"],
    });
    expect(result.rekeyed).toEqual(["kestrel"]);
    expect(backend.params.get(kestrelSlot)).toBe(NEW_KEY);
  });

  test("naming an agent bound to another profile on the same provider is refused", async () => {
    const { backend, hermetic } = await withSecondAnthropicProfile();
    const before = backend.params.get(kiteSlot);
    expect(
      await codeOf(() =>
        hermetic.secrets.push({
          name: "_fleet",
          shared: `profile-${FIXTURE_PROFILE_IDS.anthropic}`,
          value: NEW_KEY,
          rekey: ["kite"],
        }),
      ),
    ).toBe("VALIDATION");
    expect(backend.params.get(kiteSlot)).toBe(before);
  });

  /**
   * The legacy half, unchanged: a row the migration left unbound resolves its
   * key through the pre-profile map, so it is a reader of `nous-key` — and a
   * row bound to a nous *profile* is not, however much the map still says
   * "nous reads nous-key".
   */
  test("a legacy slug re-keys the unbound rows and leaves a profile-bound one alone", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    backend.params.set(
      sharedSecretPath(`profile-${FIXTURE_PROFILE_IDS.nous}`),
      "sk-nous-FIXTURE-PROFILE",
    );
    const hermetic = core(backend);
    await drain(hermetic.agents.create({ name: "pike", provider_profile: "nous-lab" }));
    const pikeSlot = `/hermes/fxtr0001/pike/provider-key-${FIXTURE_PROFILE_IDS.nous}-r1`;
    const before = backend.params.get(pikeSlot);

    const result = await hermetic.secrets.push({
      name: "_fleet",
      shared: "nous-key",
      value: NEW_KEY,
      rekey: "all",
    });

    expect(result.rekeyed).toEqual(["marrow"]);
    expect(backend.params.get("/hermes/fxtr0001/marrow/provider-key")).toBe(NEW_KEY);
    expect(backend.params.get(pikeSlot)).toBe(before);
  });
});

/**
 * The §8.2 verdict on `_fleet`. It is about what the fleet *depends on*: the
 * OAuth pair always, and a shared slot only once a provider names it. Anything
 * else empty is a warning, because a check that goes red for a slot nobody uses
 * is a check an operator learns to ignore.
 */
describe("secrets.verify _fleet · what counts as ok", () => {
  /** The fixture's OAuth halves, which nothing seeds. */
  function withOauth(backend: MemoryBackend): MemoryBackend {
    backend.params.set("/hermetic/fxtr0001/tailscale/oauth-secret", "tskey-client-FIXTURE1-FIXTURE");
    backend.params.set("/hermetic/fxtr0001/tailscale/oauth-client-id", "kFIXTURE1");
    return backend;
  }

  test("an unnamed empty slot is a warning, not a failure", async () => {
    const backend = withOauth(seedFixtureFleet(new MemoryBackend()));
    const report = await core(backend).secrets.verify({ name: "_fleet" });
    expect(report.ok).toBe(true);
    // `openrouter-key` and the profile slot nobody has filled: both are slots
    // an operator declared and has not filled, which is a warning rather than a
    // failure until something names them (§8.3).
    expect(report.warnings).toEqual([
      "shared slot openrouter-key is declared but empty; no provider names it",
      `shared slot profile-${FIXTURE_PROFILE_IDS.nous} is declared but empty; no provider names it`,
    ]);
  });

  test("an empty slot a provider names fails, and is not merely warned about", async () => {
    const backend = withOauth(seedFixtureFleet(new MemoryBackend()));
    backend.params.set(sharedSecretPath("nous-key"), SECRET_PLACEHOLDER);
    const report = await core(backend).secrets.verify({ name: "_fleet" });
    expect(report.ok).toBe(false);
    // `nous` reads it, so it is a dependency rather than an aspiration.
    expect(report.warnings ?? []).not.toContain(
      "shared slot nous-key is declared but empty; no provider names it",
    );
  });

  test("a missing OAuth half still fails whatever the shared slots say", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    expect((await core(backend).secrets.verify({ name: "_fleet" })).ok).toBe(false);
  });
});

/**
 * §4.4/§8.2: the OAuth rotation's write onto `_fleet`.
 *
 * This is the write H11 named. The command reads `_fleet` at the top, then goes
 * out to Tailscale to verify the client before it stores anything — a network
 * round trip — and only then records the id. Writing the copy it has been
 * holding all that time back whole would revert whatever landed while it
 * waited, which on a shared fleet is a `settings.set`, a profile write or a
 * Bedrock grant.
 */
describe("secrets push _fleet --tailscale-oauth records the client id", () => {
  const OAUTH_SECRET = "tskey-client-FIXTURETWO-FIXTURE-OAUTH-SECRET";
  const OAUTH_CLIENT_ID = "FIXTURETWO";

  /**
   * The interleave, driven at the one instant it is real: a `settings.set`
   * lands while this push is out at api.tailscale.com. The push must record the
   * id *and* leave the settings where the other writer left them.
   */
  test("a settings write that lands during verification survives the push", async () => {
    const backend = seedFixtureFoundation(seedFixtureFleet(new MemoryBackend()));
    const before = (await backend.store.fleet.get())!;
    const hermetic = core(backend, {
      verifyTailscaleOauth: async () => {
        await core(backend).settings.set({ defaults: { size: "large" } });
        return OK_OAUTH();
      },
    });

    await hermetic.secrets.push({ name: "_fleet", tailscale_oauth: true, value: OAUTH_SECRET });

    const after = (await backend.store.fleet.get())!;
    expect(after.tailscale_oauth_client_id).toBe(OAUTH_CLIENT_ID);
    // The whole-item write reverted this; the patch cannot, because it never
    // names `settings` at all.
    expect(after.settings!.version).toBe(before.settings!.version + 1);
    expect(after.settings!.defaults.size).toBe("large");
    // And the patch moved the item's own counter, so a replacement composed
    // before it is refused rather than applied over the top.
    expect(after.version).toBe((before.version ?? 0) + 1);
  });

  /**
   * The other half of the same rule. A fleet-wide operation holds the lock so
   * that the fleet's metadata stops moving; its commit point states the
   * revision it was composed against, so a metadata write landing underneath it
   * would cost it that commit point. Refusing the cheap half is the bargain,
   * and it costs nothing: the secret is already in its slot, so re-running the
   * push once the update finishes writes nothing twice.
   */
  test("a live fleet lock refuses the id, and says the secret was stored", async () => {
    const backend = seedFixtureFoundation(seedFixtureFleet(new MemoryBackend()));
    const stored = (await backend.store.fleet.get())!;
    backend.fleetItem = {
      ...stored,
      lock: {
        owner: "arn:aws:iam::000000000000:user/you#run-2 foundation.update",
        expires: new Date(backend.clock.now().getTime() + 60_000).toISOString(),
      },
    };

    const hermetic = core(backend);
    const refused = await errorOf(() =>
      hermetic.secrets.push({ name: "_fleet", tailscale_oauth: true, value: OAUTH_SECRET }),
    );
    expect(refused.code).toBe("LOCKED");
    // Who holds it and what they are doing, so this is a wait an operator can
    // time rather than a fleet that is mysteriously busy.
    expect(refused.message).toContain("foundation.update is in progress");
    expect(refused.message).toContain("arn:aws:iam::000000000000:user/you#run-2 foundation.update");

    // Refused on the row, stored in the slot: both halves are what the message
    // promises, and the re-run after the update is what makes them agree.
    expect((await backend.store.fleet.get())!.tailscale_oauth_client_id).not.toBe(OAUTH_CLIENT_ID);
    expect(backend.params.get(`/hermetic/${FIXTURE_CONFIG.fleet_id}/tailscale/oauth-secret`)).toBe(
      OAUTH_SECRET,
    );
  });

  /**
   * The refusal used to be one code for three different situations, all worded
   * as a lock somebody was holding. Two of them are not: a `_fleet` that is not
   * there is a broken fleet and `hermetic doctor`'s business, and a refusal with
   * no live lock behind it is an ordinary re-run. Telling an operator to wait
   * for an operation that is not running is the worst of the three.
   */
  test("a missing _fleet is NOT_FOUND and a refusal with nobody holding the lock is CONFLICT", async () => {
    // `guardFleet` reads `_fleet` at the top of the command, so the row has to
    // go while the push is out at api.tailscale.com — which is exactly the
    // window this write has always had, and the reason it re-reads at all.
    const gone = seedFixtureFoundation(seedFixtureFleet(new MemoryBackend()));
    const missing = await errorOf(() =>
      core(gone, {
        verifyTailscaleOauth: async () => {
          gone.fleetItem = null;
          return OK_OAUTH();
        },
      }).secrets.push({ name: "_fleet", tailscale_oauth: true, value: OAUTH_SECRET }),
    );
    expect(missing.code).toBe("NOT_FOUND");
    expect(missing.message).toContain("doctor");

    // The row is there and unlocked, and the write is refused anyway — the
    // window in which a lock lapses between the failed write and the re-read.
    const moved = seedFixtureFoundation(seedFixtureFleet(new MemoryBackend()));
    moved.store.fleet.updateFleet = async () => null;
    const conflict = await errorOf(() =>
      core(moved).secrets.push({ name: "_fleet", tailscale_oauth: true, value: OAUTH_SECRET }),
    );
    expect(conflict.code).toBe("CONFLICT");
    expect(conflict.message).toContain("the secret was stored");
  });
});
