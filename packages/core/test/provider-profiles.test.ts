/**
 * §8.3's provider profiles: `providers.list/create/update/delete/models`, the
 * migration that gives an old fleet profiles, and the credential slot each
 * profile owns.
 *
 * The property this file exists for is the same one `shared-secrets.test.ts`
 * holds: **a key never comes back out.** A profile record carries a slug, a
 * catalog read carries models, and the one place a value is held — the write
 * into the slot — drops it inside the function that wrote it.
 */
import { describe, expect, test } from "bun:test";
import {
  FIXTURE_CONFIG,
  FIXTURE_PROFILE_IDS,
  MemoryBackend,
  SECRET_PLACEHOLDER,
  seedFixtureFleet,
} from "../src/backend/memory.ts";
import { sharedSecretPath as sharedSecretPathFor } from "../src/backend/constants.ts";
import { derivedProfileId, withProviderProfiles } from "../src/profiles/profile-migrate.ts";
import { LEGACY_BEDROCK_MODEL_IDS } from "../src/profiles/provider-profiles.ts";
import { defaultFleetSettings } from "../src/schema/index.ts";
import type { FleetSettings } from "../src/schema/index.ts";
import { HermeticError } from "../src/errors.ts";
import { testHermetic } from "./helpers.ts";

const sharedSecretPath = (slug: string): string => sharedSecretPathFor(FIXTURE_CONFIG.fleet_id, slug);

/** A fixture value that is still obviously a fixture (§11.3, the leak grep). */
const NEW_KEY = "sk-FIXTURE-PROFILE-ROTATED";

function core(backend: MemoryBackend) {
  return testHermetic({ backend, config: FIXTURE_CONFIG });
}

function fleet() {
  const backend = seedFixtureFleet(new MemoryBackend());
  return { backend, hermetic: core(backend) };
}

/**
 * A fleet whose `_fleet` carries the pre-profile settings and nothing else —
 * what every fleet written before §8.3 looks like. The fixture's own settings
 * already state their profiles, which is deliberate (see `memory-fixture.ts`),
 * so a test of the migration has to take them back off.
 */
function unmigrated(): MemoryBackend {
  const backend = seedFixtureFleet(new MemoryBackend());
  const { profiles: _profiles, default_profile: _default, ...rest } = backend.fleetItem!.settings!;
  backend.fleetItem = { ...backend.fleetItem!, settings: rest };
  return backend;
}

describe("providers.list", () => {
  test("every fixture profile, with its readiness stated rather than guessed", async () => {
    const { hermetic } = fleet();
    const { profiles, default_profile } = await hermetic.providers.list();
    expect(profiles.map((p) => p.name)).toEqual([
      "anthropic-main",
      "bedrock-role",
      "nous-lab",
      "openrouter-cheap",
      "vercel-gw",
    ]);
    expect(default_profile).toBe(FIXTURE_PROFILE_IDS.anthropic);

    const by = (name: string) => profiles.find((p) => p.name === name)!;
    expect(by("anthropic-main")).toMatchObject({
      ready: true,
      ready_reason: "key-set",
      is_default: true,
    });
    // The instance role: there is no slot, so there is nothing to be missing.
    expect(by("bedrock-role")).toMatchObject({ ready: true, ready_reason: "role", grant: "granted" });
    // A slot that exists and still holds the placeholder is declared, not filled.
    expect(by("nous-lab")).toMatchObject({ ready: false, ready_reason: "key-placeholder" });
    expect(by("vercel-gw")).toMatchObject({ ready: false, ready_reason: "disabled" });
  });

  test("no value from any slot is anywhere in the answer", async () => {
    const { hermetic } = fleet();
    const body = JSON.stringify(await hermetic.providers.list());
    expect(body).not.toInclude("sk-profile-FIXTURE");
    expect(body).not.toInclude("sk-nous-FIXTURE");
  });

  /**
   * An agent row with no `profile_id` — every row written before profiles
   * existed — belongs to whichever profile of its provider the fleet
   * designates. The fixture's Bedrock agents are the case that matters, since
   * `bedrock-role` is the only Bedrock profile.
   */
  test("rows with no profile_id are linked through the fleet's designation", async () => {
    const { hermetic } = fleet();
    const { profiles } = await hermetic.providers.list();
    const bedrock = profiles.find((p) => p.name === "bedrock-role")!;
    expect(bedrock.linked_agents).toContain("atlas");
    // `kestrel` runs on anthropic, which has exactly one profile.
    expect(profiles.find((p) => p.name === "anthropic-main")!.linked_agents).toEqual(["kestrel"]);
    // `corvid` is the fixture's profile-bound openrouter agent — linked by its
    // own `profile_id` rather than by the fleet's designation.
    expect(profiles.find((p) => p.name === "openrouter-cheap")!.linked_agents).toEqual(["corvid"]);
    // Nothing runs on the disabled profile.
    expect(profiles.find((p) => p.name === "vercel-gw")!.linked_agents).toEqual([]);
  });

  /**
   * A second Bedrock profile makes the designation ambiguous (the fleet default
   * is anthropic), but the unbound rows still run on the one they predate.
   * Unlinking them would show `bedrock-role` serving only `atlas` — and let it
   * be deleted out from under the rest.
   */
  test("a sibling profile does not unlink the rows the first one serves", async () => {
    const { hermetic } = fleet();
    const before = (await hermetic.providers.list()).profiles.find(
      (p) => p.name === "bedrock-role",
    )!.linked_agents;
    expect(before.length).toBeGreaterThan(1);
    const created = await hermetic.providers.create({ name: "qa-bedrock", provider: "bedrock" });
    expect(created.profile.linked_agents).toEqual([]);
    const { profiles } = await hermetic.providers.list();
    expect(profiles.find((p) => p.name === "bedrock-role")!.linked_agents).toEqual(before);
    expect(profiles.find((p) => p.name === "qa-bedrock")!.linked_agents).toEqual([]);
    await expect(
      hermetic.providers.delete({ profile: "bedrock-role", yes: true }),
    ).rejects.toMatchObject({ code: "PROFILE_IN_USE" });
  });

  test("a Bedrock model outside the grant reports the foundation update it needs", async () => {
    const { backend, hermetic } = fleet();
    await hermetic.providers.update({
      profile: FIXTURE_PROFILE_IDS.bedrock,
      model: "vendor.not-granted-v1:0",
    });
    const before = await hermetic.providers.list();
    const bedrock = before.profiles.find((p) => p.name === "bedrock-role")!;
    expect(bedrock.grant).toBe("needs_foundation_update");
    expect(bedrock.ready).toBe(false);
    expect(bedrock.ready_reason).toBe("grant-missing");

    // …and once `_fleet` records the wider grant, the same profile is ready.
    backend.fleetItem = {
      ...backend.fleetItem!,
      bedrock_model_ids: ["vendor.not-granted-v1:0"],
    };
    const after = await hermetic.providers.list();
    expect(after.profiles.find((p) => p.name === "bedrock-role")!.grant).toBe("granted");
  });

  /**
   * `bedrockModelArns` grants the foundation model *and* the `us.`-prefixed
   * inference profile for every id it is given, so the two spellings are one
   * grant and a profile that picked the second must not read as ungranted.
   */
  test("the region-prefixed inference profile counts as the grant on its bare id", async () => {
    const { hermetic } = fleet();
    const result = await hermetic.providers.update({
      profile: FIXTURE_PROFILE_IDS.bedrock,
      model: "us.zai.glm-4.7-flash",
    });
    expect(result.profile.grant).toBe("granted");
  });
});

/**
 * B2: the grant a fleet that has never recorded one holds is the list it was
 * *built* with, not the list this build would create today. The two differ by
 * exactly `zai.glm-4.7-flash`, which is also the Bedrock default — so reading
 * the current constant as history would report every pre-v10 fleet's default
 * Bedrock profile as ready on a role that cannot invoke it.
 */
describe("the Bedrock grant of a fleet that has recorded none", () => {
  function ungranted(): MemoryBackend {
    const backend = seedFixtureFleet(new MemoryBackend());
    const { bedrock_model_ids: _ids, ...rest } = backend.fleetItem!;
    backend.fleetItem = rest;
    return backend;
  }

  test("GLM reports needs_foundation_update, and the profile is not ready", async () => {
    const { profiles } = await core(ungranted()).providers.list();
    const bedrock = profiles.find((p) => p.name === "bedrock-role")!;
    expect(bedrock.model).toBe("zai.glm-4.7-flash");
    expect(bedrock.grant).toBe("needs_foundation_update");
    expect(bedrock.ready).toBe(false);
    expect(bedrock.ready_reason).toBe("grant-missing");
  });

  test("the fallback is the pre-GLM list, so what such a fleet does hold is granted", async () => {
    const backend = ungranted();
    const hermetic = core(backend);
    await hermetic.providers.update({
      profile: "bedrock-role",
      model: "anthropic.claude-sonnet-4-5-20250929-v1:0",
    });
    const { profiles, bedrock_model_ids } = await hermetic.providers.list();
    expect(profiles.find((p) => p.name === "bedrock-role")!.grant).toBe("granted");
    expect(bedrock_model_ids).toEqual([...LEGACY_BEDROCK_MODEL_IDS]);
    expect(bedrock_model_ids).not.toContain("zai.glm-4.7-flash");
  });

  /** The record, once `foundation.update` writes one, is what wins. */
  test("a recorded grant replaces the fallback entirely", async () => {
    const backend = ungranted();
    backend.fleetItem = { ...backend.fleetItem!, bedrock_model_ids: ["zai.glm-4.7-flash"] };
    const { profiles } = await core(backend).providers.list();
    expect(profiles.find((p) => p.name === "bedrock-role")!.grant).toBe("granted");
  });
});

describe("providers.create", () => {
  test("mints a profile, writes its key into the slot it owns, and answers with no key", async () => {
    const { backend, hermetic } = fleet();
    const result = await hermetic.providers.create({
      provider: "openai",
      name: "openai-main",
      api_key: NEW_KEY,
    });
    const id = result.profile.id;
    expect(result.profile).toMatchObject({
      name: "openai-main",
      provider: "openai",
      // Resolved from the catalog once and then owned by the fleet.
      model: "gpt-5.6-luna",
      enabled: true,
      revision: 1,
      ready: true,
      ready_reason: "key-set",
      credential: { kind: "secret", slug: `profile-${id}` },
    });
    expect(backend.params.get(sharedSecretPath(`profile-${id}`))).toBe(NEW_KEY);
    expect(JSON.stringify(result)).not.toInclude(NEW_KEY);
    // The slot is a declared fleet secret, so `secrets ls` can render it.
    expect(result.settings.secrets.map((s) => s.slug)).toContain(`profile-${id}`);
  });

  test("a profile with no key is created and is simply not ready", async () => {
    const { hermetic } = fleet();
    const result = await hermetic.providers.create({ provider: "vercel", name: "vercel-spare" });
    expect(result.profile.ready).toBe(false);
    expect(result.profile.ready_reason).toBe("key-missing");
  });

  test("a stated model wins over the catalog's", async () => {
    const { hermetic } = fleet();
    const result = await hermetic.providers.create({
      provider: "openai",
      name: "openai-mini",
      model: "gpt-5.6-mini",
    });
    expect(result.profile.model).toBe("gpt-5.6-mini");
  });

  test("a name another profile already answers to is refused, ignoring case", async () => {
    const { hermetic } = fleet();
    await expect(
      hermetic.providers.create({ provider: "openai", name: "anthropic-main" }),
    ).rejects.toMatchObject({ code: "NAME_TAKEN" });
    // The comparison is case-insensitive, and the schema refuses the spelling
    // that would have made two names look different in the first place.
    await expect(
      hermetic.providers.create({ provider: "openai", name: "Anthropic-Main" }),
    ).rejects.toThrow();
  });

  test("a role provider takes no key at all", async () => {
    const { hermetic } = fleet();
    await expect(
      hermetic.providers.create({ provider: "bedrock", name: "bedrock-two", api_key: NEW_KEY }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    const ok = await hermetic.providers.create({ provider: "bedrock", name: "bedrock-two" });
    expect(ok.profile.credential).toEqual({ kind: "role" });
  });

  test("--default makes it the fleet default in the same write", async () => {
    const { hermetic } = fleet();
    const result = await hermetic.providers.create({
      provider: "openai",
      name: "openai-default",
      default: true,
    });
    expect(result.profile.is_default).toBe(true);
    expect(result.settings.default_profile).toBe(result.profile.id);
  });

  test("a disabled profile cannot be made the default", async () => {
    const { hermetic } = fleet();
    await expect(
      hermetic.providers.create({
        provider: "openai",
        name: "openai-off",
        enabled: false,
        default: true,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  test("a stale expected_version is CONFLICT before anything is written", async () => {
    const { backend, hermetic } = fleet();
    const before = backend.params.size;
    await expect(
      hermetic.providers.create({
        provider: "openai",
        name: "openai-stale",
        api_key: NEW_KEY,
        expected_version: 99,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(backend.params.size).toBe(before);
  });

  /**
   * The credential is published before the record that names it, so a settings
   * write that never lands would otherwise leave a key in a slot nothing names.
   * The slot is removed instead — not blanked, because the id is minted and a
   * re-run draws a different one, so a placeholder would be an orphan.
   */
  test("a lost race removes the slot the create made", async () => {
    const { backend, hermetic } = fleet();
    const before = new Set(backend.params.keys());
    backend.store.fleet.putSettings = () => Promise.resolve(false);
    await expect(
      hermetic.providers.create({ provider: "openai", name: "openai-racy", api_key: NEW_KEY }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect([...backend.params.values()]).not.toContain(NEW_KEY);
    // Exactly the slots that were there before: no placeholder left behind.
    expect([...backend.params.keys()].sort()).toEqual([...before].sort());
  });

  /**
   * Any failure, not only a lost race. `LOCKED`, a throttled write and a
   * dropped connection all mean the record naming this slot was never stored,
   * and a key in a slot nothing names is the same problem however it happened.
   */
  test("a commit that fails for any other reason removes the slot too", async () => {
    const { backend, hermetic } = fleet();
    const before = new Set(backend.params.keys());
    backend.store.fleet.putSettings = () => {
      throw new HermeticError("LOCKED", "a foundation update holds the fleet lock");
    };
    await expect(
      hermetic.providers.create({ provider: "openai", name: "openai-locked", api_key: NEW_KEY }),
    ).rejects.toMatchObject({ code: "LOCKED" });
    expect([...backend.params.values()]).not.toContain(NEW_KEY);
    expect([...backend.params.keys()].sort()).toEqual([...before].sort());
  });

  test("an undo that itself fails is reported, naming the slot it left behind", async () => {
    const { backend, hermetic } = fleet();
    backend.store.fleet.putSettings = () => Promise.resolve(false);
    backend.secrets.delete = () => Promise.reject(new Error("AccessDenied"));
    const failure = await hermetic.providers
      .create({ provider: "openai", name: "openai-stuck", api_key: NEW_KEY })
      .catch((e: unknown) => e);
    expect(failure).toMatchObject({ code: "CONFLICT" });
    expect((failure as HermeticError).details?.["partial_write"]).toMatch(/^profile-/);
    expect((failure as HermeticError).message).not.toInclude(NEW_KEY);
  });
});

describe("providers.update", () => {
  test("every change bumps the revision and re-states the profile", async () => {
    const { hermetic } = fleet();
    const result = await hermetic.providers.update({
      profile: "openrouter-cheap",
      model: "z-ai/glm-5.2",
      name: "openrouter-main",
    });
    expect(result.profile).toMatchObject({
      id: FIXTURE_PROFILE_IDS.openrouter,
      name: "openrouter-main",
      model: "z-ai/glm-5.2",
      revision: 2,
      provider: "openrouter",
    });
  });

  /**
   * The fleet default is a pointer on `_fleet.settings`, not a field of the
   * profile. A bump here would mark every agent pinned to the profile
   * `update_available` for a change that reaches none of them.
   */
  test("making a profile the fleet default leaves its revision alone", async () => {
    const { hermetic } = fleet();
    const result = await hermetic.providers.update({ profile: "bedrock-role", default: true });
    expect(result.profile).toMatchObject({ is_default: true, revision: 2 });
    expect(result.settings.default_profile).toBe(FIXTURE_PROFILE_IDS.bedrock);
    const back = await hermetic.providers.update({ profile: "anthropic-main", default: true });
    expect(back.profile).toMatchObject({ is_default: true, revision: 1 });
    // …while a real edit in the same call still bumps it.
    const both = await hermetic.providers.update({
      profile: "bedrock-role",
      name: "bedrock-main",
      default: true,
    });
    expect(both.profile).toMatchObject({ is_default: true, revision: 3 });
  });

  test("the selector takes an id as readily as a name", async () => {
    const { hermetic } = fleet();
    const byId = await hermetic.providers.update({
      profile: FIXTURE_PROFILE_IDS.openrouter,
      model: "z-ai/glm-5.2",
    });
    expect(byId.profile.name).toBe("openrouter-cheap");
    await expect(hermetic.providers.update({ profile: "nothing", model: "x" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  test("rotating the key writes the same slot and says so without the value", async () => {
    const { backend, hermetic } = fleet();
    const result = await hermetic.providers.update({
      profile: "nous-lab",
      api_key: NEW_KEY,
    });
    const slug = `profile-${FIXTURE_PROFILE_IDS.nous}`;
    expect(result.profile.credential).toEqual({ kind: "secret", slug });
    expect(backend.params.get(sharedSecretPath(slug))).toBe(NEW_KEY);
    expect(result.profile.ready).toBe(true);
    expect(JSON.stringify(result)).not.toInclude(NEW_KEY);
    const events = await backend.store.events.query("_fleet");
    const detail = events.find((e) => e.action === "providers.update")?.detail ?? "";
    expect(detail).toContain("key rotated");
    expect(detail).not.toInclude(NEW_KEY);
  });

  /**
   * M2: a migrated profile points at a shared slug that predates profiles —
   * one other providers' settings entries may still name and `agents.create`
   * copies from. Rotating "this profile's key" there would silently re-key
   * everything else reading it.
   */
  test("a rotation into a slot the profile does not own is refused", async () => {
    const backend = unmigrated();
    const hermetic = core(backend);
    const before = backend.params.get(sharedSecretPath("nous-key"));
    const failure = await hermetic.providers
      .update({ profile: "nous", api_key: NEW_KEY })
      .catch((e: unknown) => e);
    expect(failure).toMatchObject({ code: "VALIDATION" });
    expect((failure as Error).message).toContain("nous-key");
    expect((failure as Error).message).toContain("secrets push _fleet --shared");
    // Nothing was written: the shared slot still holds what it held.
    expect(backend.params.get(sharedSecretPath("nous-key"))).toBe(before);
  });

  test("a profile that owns its slot rotates normally", async () => {
    const { backend, hermetic } = fleet();
    await hermetic.providers.update({ profile: "openrouter-cheap", api_key: NEW_KEY });
    expect(backend.params.get(sharedSecretPath(`profile-${FIXTURE_PROFILE_IDS.openrouter}`))).toBe(
      NEW_KEY,
    );
  });

  test("a role profile has no key to rotate", async () => {
    const { hermetic } = fleet();
    await expect(
      hermetic.providers.update({ profile: "bedrock-role", api_key: NEW_KEY }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  test("the fleet default may not be disabled", async () => {
    const { hermetic } = fleet();
    await expect(
      hermetic.providers.update({ profile: "anthropic-main", enabled: false }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  test("a disabled profile may not be made the default", async () => {
    const { hermetic } = fleet();
    await expect(
      hermetic.providers.update({ profile: "vercel-gw", default: true }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    // …but enabling it in the same command is allowed.
    const ok = await hermetic.providers.update({
      profile: "vercel-gw",
      enabled: true,
      default: true,
    });
    expect(ok.profile.is_default).toBe(true);
  });

  /**
   * A rotation commits *before* it writes the slot, precisely so a lost race
   * cannot destroy the key the running configuration is still using — and so
   * no previous key has to be held in a closure across the commit.
   */
  test("a rotation that loses the settings race leaves the previous key in place", async () => {
    const { backend, hermetic } = fleet();
    const slug = `profile-${FIXTURE_PROFILE_IDS.anthropic}`;
    const before = backend.params.get(sharedSecretPath(slug));
    backend.store.fleet.putSettings = () => Promise.resolve(false);
    await expect(
      hermetic.providers.update({ profile: "anthropic-main", api_key: NEW_KEY }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(backend.params.get(sharedSecretPath(slug))).toBe(before);
    expect([...backend.params.values()]).not.toContain(NEW_KEY);
  });

  test("a key write that fails after the commit says the old key is still in place", async () => {
    const { backend, hermetic } = fleet();
    backend.secrets.put = () => Promise.reject(new Error("AccessDenied"));
    const failure = await hermetic.providers
      .update({ profile: "anthropic-main", api_key: NEW_KEY })
      .catch((e: unknown) => e);
    expect(failure).toMatchObject({ code: "CONFLICT" });
    expect((failure as Error).message).toContain("previous key is still in place");
    expect((failure as Error).message).not.toInclude(NEW_KEY);
  });

  test("a stale expected_version is CONFLICT", async () => {
    const { hermetic } = fleet();
    await expect(
      hermetic.providers.update({ profile: "nous-lab", model: "x", expected_version: 99 }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("providers.delete", () => {
  test("refuses while agents still run on the profile", async () => {
    const { hermetic } = fleet();
    await expect(
      hermetic.providers.delete({ profile: "anthropic-main", yes: true }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    // …and once it is not the default either, the refusal is the agents.
    await hermetic.providers.update({ profile: "openrouter-cheap", default: true });
    await expect(
      hermetic.providers.delete({ profile: "anthropic-main", yes: true }),
    ).rejects.toMatchObject({ code: "PROFILE_IN_USE" });
  });

  /**
   * §8.3: a *staged* binding is a use of the profile.
   *
   * `corvid` runs on openrouter and is staged onto `vercel-gw`'s provider here,
   * so no agent's `profile_id` names the profile and the linked check is silent
   * on it. Deleting it anyway succeeds — and the `apply` the operator runs next
   * refuses with "profile no longer exists", on a row whose `pending` names
   * something nothing can show them. Two commands that each reported success.
   */
  test("refuses while an agent is staged onto it and not yet applied", async () => {
    const { backend, hermetic } = fleet();
    // Nothing *runs* on vercel-gw; stage one agent onto it.
    expect(
      (await hermetic.providers.list()).profiles.find((p) => p.name === "vercel-gw")!.linked_agents,
    ).toEqual([]);
    await hermetic.providers.update({ profile: "vercel-gw", enabled: true, api_key: NEW_KEY });
    await hermetic.agents.set({ name: "fathom", provider_profile: "vercel-gw" });

    await expect(hermetic.providers.delete({ profile: "vercel-gw", yes: true })).rejects.toMatchObject({
      code: "PROFILE_IN_USE",
    });
    // The profile is still there to be inspected and re-staged from.
    expect((await hermetic.providers.list()).profiles.map((p) => p.name)).toContain("vercel-gw");
    expect(backend.agents.get("fathom")!.pending).toBeTruthy();
  });

  /**
   * And the two sets are reported apart, because they are different facts: a
   * staged agent is still running on whatever it was bound to before, so
   * calling it linked would misreport what the profile is serving.
   */
  test("`linked_agents` is what runs on it; `pending_agents` is what is staged", async () => {
    const { hermetic } = fleet();
    await hermetic.providers.update({ profile: "vercel-gw", enabled: true, api_key: NEW_KEY });
    await hermetic.agents.set({ name: "fathom", provider_profile: "vercel-gw" });

    const { profiles } = await hermetic.providers.list();
    const vercel = profiles.find((p) => p.name === "vercel-gw")!;
    expect(vercel.linked_agents).toEqual([]);
    expect(vercel.pending_agents).toEqual(["fathom"]);
    // `corvid` is staged onto anthropic-main by the fixture, and *runs* on
    // openrouter-cheap: it appears under one heading on each profile.
    const anthropic = profiles.find((p) => p.name === "anthropic-main")!;
    const openrouter = profiles.find((p) => p.name === "openrouter-cheap")!;
    expect(anthropic.pending_agents).toContain("corvid");
    expect(anthropic.linked_agents).not.toContain("corvid");
    expect(openrouter.linked_agents).toContain("corvid");
  });

  test("refuses without the confirmation, whatever the head asked", async () => {
    const { hermetic } = fleet();
    await expect(hermetic.providers.delete({ profile: "vercel-gw" })).rejects.toMatchObject({
      code: "CONFIRMATION_REQUIRED",
    });
  });

  test("takes the slot it owns with it, and nothing else", async () => {
    const { backend, hermetic } = fleet();
    const slug = `profile-${FIXTURE_PROFILE_IDS.vercel}`;
    const result = await hermetic.providers.delete({ profile: "vercel-gw", yes: true });
    expect(result).toMatchObject({ id: FIXTURE_PROFILE_IDS.vercel, name: "vercel-gw", deleted: true });
    expect(backend.params.has(sharedSecretPath(slug))).toBe(false);
    expect(result.settings.secrets.map((s) => s.slug)).not.toContain(slug);
    // The hand-pushed shared slots are somebody else's.
    expect(backend.params.has(sharedSecretPath("nous-key"))).toBe(true);
  });

  /**
   * B1: the record goes first. A delete that removed the key and then lost the
   * settings write would leave a profile every head still lists, pointing at a
   * slot that no longer exists — and an `agents.create` in between would have
   * provisioned a box around a key that was already gone.
   */
  test("a lost settings race leaves the profile and its key both intact", async () => {
    const { backend, hermetic } = fleet();
    const slug = `profile-${FIXTURE_PROFILE_IDS.vercel}`;
    const before = backend.params.get(sharedSecretPath(slug));
    backend.store.fleet.putSettings = () => Promise.resolve(false);
    await expect(hermetic.providers.delete({ profile: "vercel-gw", yes: true })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(backend.params.get(sharedSecretPath(slug))).toBe(before);
    const { profiles } = await hermetic.providers.list();
    expect(profiles.map((p) => p.name)).toContain("vercel-gw");
  });

  /**
   * The sweep is past the point of no return, so it cannot fail the delete. A
   * slot it could not remove is a fleet secret nothing names, which is worth
   * saying — so the result says which one.
   */
  test("a sweep that fails is reported, not thrown", async () => {
    const { backend, hermetic } = fleet();
    backend.secrets.delete = () => Promise.reject(new Error("AccessDenied"));
    const result = await hermetic.providers.delete({ profile: "vercel-gw", yes: true });
    expect(result.deleted).toBe(true);
    expect(result.slot_not_deleted).toBe(`profile-${FIXTURE_PROFILE_IDS.vercel}`);
    const { profiles } = await hermetic.providers.list();
    expect(profiles.map((p) => p.name)).not.toContain("vercel-gw");
  });

  /**
   * A profile the migration produced points at a slot that predates profiles —
   * one an operator pushed by hand and other things may still read. Deleting
   * the profile is not permission to delete that.
   */
  test("a slot a migrated profile merely inherited is not one it owns", async () => {
    const backend = unmigrated();
    backend.params.set(sharedSecretPath("nous-key"), "sk-nous-FIXTURE-INHERITED");
    const hermetic = core(backend);
    const { secrets } = await hermetic.secrets.list();
    // The migrated `nous` profile points at `nous-key`, which predates profiles
    // and which other things may still read — so nothing claims to own it, and
    // `secrets rm` refuses it on the provider fan-out it always did.
    expect(secrets.find((s) => s.slug === "nous-key")?.owner).toBeUndefined();
    await expect(hermetic.secrets.delete({ slug: "nous-key", yes: true })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});

describe("providers.models", () => {
  test("a saved profile reads its own stored credential and pins its own model", async () => {
    const { hermetic } = fleet();
    const result = await hermetic.providers.models({ profile: "anthropic-main" });
    expect(result.provider).toBe("anthropic");
    expect(result.profile).toBe(FIXTURE_PROFILE_IDS.anthropic);
    expect(result.default_model).toBe("claude-sonnet-5");
    expect(result.models[0]?.id).toBe("claude-sonnet-5");
    // The fixture catalog carries one embedding model; it is not in the answer.
    expect(result.models.map((m) => m.id)).not.toContain("claude-embed-v1");
  });

  test("a profile whose slot is still the placeholder cannot be read", async () => {
    const { hermetic } = fleet();
    await expect(hermetic.providers.models({ profile: "nous-lab" })).rejects.toMatchObject({
      code: "PROVIDER_AUTH",
    });
  });

  test("a bare provider with a draft key pins the catalog's default", async () => {
    const { hermetic } = fleet();
    const result = await hermetic.providers.models({ provider: "openai", api_key: NEW_KEY });
    expect(result.default_model).toBe("gpt-5.6-luna");
    expect(result.models[0]?.id).toBe("gpt-5.6-luna");
    expect(result.profile).toBeUndefined();
    expect(JSON.stringify(result)).not.toInclude(NEW_KEY);
  });

  test("naming both a profile and a provider is a validation failure", async () => {
    const { hermetic } = fleet();
    await expect(
      hermetic.providers.models({ profile: "anthropic-main", provider: "openai" }),
    ).rejects.toThrow();
    await expect(hermetic.providers.models({})).rejects.toThrow();
    await expect(
      hermetic.providers.models({ profile: "anthropic-main", api_key: NEW_KEY }),
    ).rejects.toThrow();
  });

  test("Bedrock answers from the fleet's region with no credential at all", async () => {
    const { hermetic } = fleet();
    const result = await hermetic.providers.models({ profile: "bedrock-role" });
    expect(result.models.map((m) => m.id)).toContain("us.zai.glm-4.7-flash");
    // Stated by AWS as an image model.
    expect(result.models.map((m) => m.id)).not.toContain("amazon.nova-canvas-v1:0");
  });

  /** §8.3: a failed catalog read names the provider and never the credential. */
  test("a failure carries the provider and not the key", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    const hermetic = testHermetic({
      backend,
      config: FIXTURE_CONFIG,
      modelCatalog: { fetch: () => Promise.resolve(new Response("nope", { status: 401 })) },
    });
    const failure = await hermetic.providers
      .models({ provider: "openai", api_key: NEW_KEY })
      .catch((e: unknown) => e);
    expect(failure).toMatchObject({ code: "PROVIDER_AUTH", details: { provider: "openai" } });
    expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).not.toInclude(NEW_KEY);
  });
});

describe("the migration from the pre-profile provider settings", () => {
  const ACTOR = "arn:aws:sts::123456789012:assumed-role/hermetic-operator/evan";
  const NOW = "2026-07-20T09:00:00.000Z";

  function legacy(): FleetSettings {
    const base = defaultFleetSettings(
      { size: "medium", provider: "nous", volume_gib: 100, secrets: "none" },
      ACTOR,
      NOW,
    );
    return {
      ...base,
      providers: {
        ...base.providers,
        nous: { enabled: true, default_model: "deepseek-v4-flash-0731", secret: "nous-key" },
        openrouter: { enabled: false, default_model: "z-ai/glm-5.2" },
        anthropic: { enabled: true },
      },
      secrets: [{ slug: "nous-key", created_at: NOW, last_set_at: NOW }],
    };
  }

  test("a secret link, a model override and the fleet default each become a profile", () => {
    const migrated = withProviderProfiles(legacy(), "fxtr0001");
    const names = Object.values(migrated.profiles ?? {})
      .map((p) => p.name)
      .sort();
    // `nous` (the default, and a secret link), `openrouter` (a model override).
    // `anthropic` states nothing and is not the default, so it is not carried.
    expect(names).toEqual(["nous", "openrouter"]);

    const nous = migrated.profiles![derivedProfileId("fxtr0001", "nous")]!;
    expect(nous).toMatchObject({
      provider: "nous",
      // The override survives, exactly as written.
      model: "deepseek-v4-flash-0731",
      enabled: true,
      credential: { kind: "secret", slug: "nous-key" },
      created_by: ACTOR,
      created_at: NOW,
    });
    // The disabled state survives too.
    expect(migrated.profiles![derivedProfileId("fxtr0001", "openrouter")]!.enabled).toBe(false);
    expect(migrated.default_profile).toBe(derivedProfileId("fxtr0001", "nous"));
  });

  test("a provider with no override takes the catalog's model, not a blank", () => {
    const base = defaultFleetSettings(
      { size: "medium", provider: "bedrock", volume_gib: 100, secrets: "none" },
      ACTOR,
      NOW,
    );
    const migrated = withProviderProfiles(base, "fxtr0001");
    const bedrock = migrated.profiles![derivedProfileId("fxtr0001", "bedrock")]!;
    expect(bedrock.model).toBe("zai.glm-4.7-flash");
    expect(bedrock.credential).toEqual({ kind: "role" });
  });

  test("running it twice is a no-op, and the ids do not move", () => {
    const once = withProviderProfiles(legacy(), "fxtr0001");
    const twice = withProviderProfiles(once, "fxtr0001");
    expect(twice).toEqual(once);
    // A second *fresh* derivation agrees with the first: the ids are a function
    // of the fleet and the provider, not of the moment the read happened.
    expect(withProviderProfiles(legacy(), "fxtr0001")).toEqual(once);
  });

  test("two fleets do not derive the same profile id for the same provider", () => {
    expect(derivedProfileId("fxtr0001", "nous")).not.toBe(derivedProfileId("fxtr0002", "nous"));
    expect(derivedProfileId("fxtr0001", "nous")).toMatch(/^[0-9a-hjkmnp-tv-z]{8}$/);
  });

  test("settings that already carry profiles are returned untouched, even when empty", () => {
    const already: FleetSettings = { ...legacy(), profiles: {}, default_profile: null };
    expect(withProviderProfiles(already, "fxtr0001")).toBe(already);
  });

  /**
   * The migration runs on read (`settingsOf`), so a fleet whose `_fleet` has no
   * `settings` at all — every fleet created before they existed — answers with
   * profiles from the first call, without a write.
   */
  test("a fleet with no settings at all reads as one that has profiles", async () => {
    const backend = unmigrated();
    const { profiles, default_profile } = await core(backend).providers.list();
    // `_fleet.defaults.provider` is `bedrock`, and the fixture's pre-profile
    // settings also state a model override and a secret slug for `nous`. Both
    // are carried; the other four providers state nothing and are not.
    expect(profiles.map((p) => p.name)).toEqual(["bedrock", "nous"]);
    const bedrock = profiles.find((p) => p.name === "bedrock")!;
    expect(default_profile).toBe(bedrock.id);
    expect(bedrock.credential).toEqual({ kind: "role" });
    expect(profiles.find((p) => p.name === "nous")!.credential).toEqual({
      kind: "secret",
      slug: "nous-key",
    });
  });
});

describe("profile-owned slots in the shared secrets surface", () => {
  test("secrets ls names the profile that owns a slot", async () => {
    const { hermetic } = fleet();
    const { secrets } = await hermetic.secrets.list();
    const owned = secrets.find((s) => s.slug === `profile-${FIXTURE_PROFILE_IDS.anthropic}`)!;
    expect(owned.owner).toEqual({ profile: FIXTURE_PROFILE_IDS.anthropic, name: "anthropic-main" });
    // A hand-pushed slot a migrated profile merely reads is not "owned".
    expect(secrets.find((s) => s.slug === "nous-key")?.owner).toBeUndefined();
  });

  test("secrets rm refuses a profile's own slot and says which profile", async () => {
    const { hermetic } = fleet();
    const failure = await hermetic.secrets
      .delete({ slug: `profile-${FIXTURE_PROFILE_IDS.vercel}`, yes: true })
      .catch((e: unknown) => e);
    expect(failure).toMatchObject({ code: "VALIDATION" });
    expect((failure as Error).message).toContain("vercel-gw");
    expect((failure as Error).message).toContain("providers rm");
  });

  test("a slot a profile owns is never reported as an orphan", async () => {
    const backend = seedFixtureFleet(new MemoryBackend());
    // Drop the metadata but keep the parameter: without the profile this would
    // be an orphan, and with it the profile is the record that names it.
    const settings = backend.fleetItem!.settings!;
    backend.fleetItem = {
      ...backend.fleetItem!,
      settings: {
        ...settings,
        secrets: settings.secrets.filter((s) => !s.slug.startsWith("profile-")),
      },
    };
    const { secrets } = await core(backend).secrets.list();
    const owned = secrets.find((s) => s.slug === `profile-${FIXTURE_PROFILE_IDS.anthropic}`)!;
    expect(owned.orphan).toBeUndefined();
    expect(owned.owner?.name).toBe("anthropic-main");
  });

  test("a profile's slot is a real placeholder until a key is pushed", async () => {
    const { backend } = fleet();
    expect(backend.params.get(sharedSecretPath(`profile-${FIXTURE_PROFILE_IDS.nous}`))).toBe(
      SECRET_PLACEHOLDER,
    );
  });
});

/**
 * M3: the legacy per-provider surface is gone — `providers set` and
 * `settings set --provider` no longer exist — so the fleet default is named
 * where it lives, as a profile. The legacy `FleetSettings.providers` map is
 * still *read* (it is what the migration above turns into profiles), it is
 * simply no longer written.
 */
describe("the fleet default is a profile", () => {
  test("`settings set --default-profile` moves it, by name", async () => {
    const { hermetic } = fleet();
    await hermetic.settings.set({ default_profile: "openrouter-cheap" });
    const { default_profile, profiles } = await hermetic.providers.list();
    expect(default_profile).toBe(FIXTURE_PROFILE_IDS.openrouter);
    expect(profiles.find((p) => p.name === "openrouter-cheap")!.is_default).toBe(true);
    expect(profiles.find((p) => p.name === "anthropic-main")!.is_default).toBe(false);
  });

  test("`providers update --default` is the same write, addressed the same way", async () => {
    const { hermetic } = fleet();
    await hermetic.providers.update({ profile: FIXTURE_PROFILE_IDS.nous, default: true });
    expect((await hermetic.providers.list()).default_profile).toBe(FIXTURE_PROFILE_IDS.nous);
  });
});
