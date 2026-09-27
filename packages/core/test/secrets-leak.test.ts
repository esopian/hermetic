import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  redactCreateInput,
  redactInitInput,
  redactProvidersCreateInput,
  redactProvidersModelsInput,
  redactProvidersUpdateInput,
  redactSecretsPushInput,
} from "../src/hermetic.ts";
import { HermeticError } from "../src/errors.ts";
import {
  FIXTURE_BWS_TOKEN,
  FIXTURE_CONFIG,
  FIXTURE_PROFILE_IDS,
  FIXTURE_PROFILE_KEY,
  FIXTURE_SHARED_NOUS_KEY,
  FIXTURE_TS_KEY,
  MemoryBackend,
  seedFixtureFleet,
  seedFixtureFoundation,
} from "../src/backend/memory.ts";
import { openForInit } from "../src/open.ts";
import type { HermeticDeps } from "../src/hermetic.ts";
import { drain, testHermetic } from "./helpers.ts";
import { NO_DEVICES_SCOPE_NOTE } from "../src/fleet/preflight.ts";
import type { ErrorCode, TailscaleOauthCheck } from "../src/schema/index.ts";
import { FLEET_KEY } from "../src/schema/index.ts";

/**
 * §4.8: these walk `init --create`, so the account they describe has no fleets
 * in it yet. The fixture directory is process-global and seeded with
 * `main`/`staging` for the *populated* fixture account, and an unnamed create
 * against that one is correctly refused — so each of these says which account
 * it is in rather than inheriting whichever ran last.
 */
/**
 * §8.3 and §11.3: nothing is logged, echoed, or written to disk. Every event
 * stream and every event-log row a full lifecycle produces is grepped for the
 * fixture secret values.
 */
/** The tailnet OAuth client secret arrives as a *field of an init request*. */
const FIXTURE_OAUTH = "tskey-client-FIXTURE-OAUTH";
/** So does a provider API key: `agents.create` carries it (§8.1). */
const FIXTURE_PROVIDER_KEY = "sk-or-v1-FIXTURE-PROVIDER-KEY";
/** And a *shared* one arrives on `secrets push _fleet --shared` (§8.3). */
const FIXTURE_SHARED_KEY = "sk-or-v1-FIXTURE-SHARED-KEY";

const SECRETS = [
  FIXTURE_TS_KEY,
  FIXTURE_BWS_TOKEN,
  "tskey-auth-FIXTURE-SECRET",
  FIXTURE_OAUTH,
  FIXTURE_PROVIDER_KEY,
  FIXTURE_SHARED_KEY,
  // The value the fixture fleet's own shared slot already holds: every read of
  // that slot — `secrets ls`, `secrets verify`, the meta on `_fleet` — is
  // grepped for it too.
  FIXTURE_SHARED_NOUS_KEY,
  // And the value behind the fixture's provider profile slots (§8.3): every
  // read of a profile — `providers ls`, `providers models`, a failed catalog
  // fetch — is grepped for it too.
  FIXTURE_PROFILE_KEY,
];

/**
 * Every slug the fixture fleet declares: the two hand-pushed shared slots and
 * the four the keyed provider profiles own (§8.3), in the order `settings.secrets`
 * holds them (sorted by slug).
 */
const FIXTURE_SLUGS: readonly string[] = [
  "nous-key",
  "openrouter-key",
  ...(["anthropic", "openrouter", "nous", "vercel"] as const).map(
    (p) => `profile-${FIXTURE_PROFILE_IDS[p]}`,
  ),
].sort();

function assertClean(haystack: string) {
  for (const secret of SECRETS) {
    expect(haystack).not.toInclude(secret);
  }
  // Nor any tailscale key at all, whatever its value.
  expect(haystack).not.toMatch(/tskey-[A-Za-z0-9-]+/);
}

/**
 * A fleet with a profile whose credential *is* the fixture's shared slot — the
 * shape `profile-migrate.ts` produces for a fleet that named a shared secret
 * before profiles existed. It is the only shape a `--shared` rekey still has
 * anything to say about, and the one path that moves a secret between slots
 * with nobody typing it.
 */
function fleetWithSharedProfile(): MemoryBackend {
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
  return backend;
}

describe("secrets never leak", () => {
  test("a full create of a bitwarden agent leaks nothing", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG });

    const events = await drain(
      hermetic.agents.create({ name: "research-1", secrets: "bitwarden", provider: "anthropic" }),
    );
    expect(events.length).toBeGreaterThan(3);
    assertClean(JSON.stringify(events));

    const history = await backend.store.events.query("research-1");
    expect(history.length).toBeGreaterThan(0);
    assertClean(JSON.stringify(history));

    // The secret really is in the slot — the test above is not vacuous.
    expect(backend.params.get("/hermes/fxtr0001/research-1/ts-key")).toInclude(FIXTURE_TS_KEY);
  });

  test("secrets.push never echoes the value", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG });
    await drain(hermetic.agents.create({ name: "research-1", secrets: "bitwarden" }));
    backend.resetMutations();

    const result = await hermetic.secrets.push({
      name: "research-1",
      bws_token: true,
      value: FIXTURE_BWS_TOKEN,
    });
    expect(result.path).toBe("/hermes/fxtr0001/research-1/bws-token");
    assertClean(JSON.stringify(result));
    assertClean(JSON.stringify(await backend.store.events.query("research-1")));
    expect(backend.params.get("/hermes/fxtr0001/research-1/bws-token")).toBe(FIXTURE_BWS_TOKEN);
  });

  /**
   * The fleet-level slot (§8.3). Four surfaces could leak it — the result, the
   * `_fleet` event log, the list, and the per-agent rekey events — so all four
   * are grepped, and the slot is read back directly to prove the test is not
   * passing because nothing was written.
   */
  test("a shared push, its rekey and every read of it leak nothing", async () => {
    const backend = fleetWithSharedProfile();
    const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG });
    await drain(hermetic.agents.create({ name: "orbit", provider_profile: "nous-shared" }));

    const result = await hermetic.secrets.push({
      name: "_fleet",
      shared: "nous-key",
      label: "Nous Portal",
      value: FIXTURE_SHARED_KEY,
      rekey: "all",
    });
    expect(result.rekeyed).toEqual(["orbit"]);
    assertClean(JSON.stringify(result));
    assertClean(JSON.stringify(await backend.store.events.query("_fleet")));
    assertClean(JSON.stringify(await backend.store.events.query("orbit")));
    assertClean(JSON.stringify(await hermetic.secrets.list()));
    assertClean(JSON.stringify(await hermetic.secrets.verify({ name: "orbit" })));
    assertClean(JSON.stringify(await hermetic.secrets.verify({ name: "_fleet" })));
    assertClean(JSON.stringify(await hermetic.settings.get()));

    // Not vacuous: the value really is in both slots.
    expect(backend.params.get("/hermetic/fxtr0001/secrets/nous-key")).toBe(FIXTURE_SHARED_KEY);
    expect(backend.params.get("/hermes/fxtr0001/orbit/provider-key-nousshrd-r1")).toBe(
      FIXTURE_SHARED_KEY,
    );
  });

  /**
   * The copy `agents.create` makes when the fleet already holds the key (§8.3).
   * It is the one path that moves a secret *between* slots with nobody typing
   * it, so every surface that could name what it moved is grepped: the event
   * stream, the agent's history, the row itself and the read that renders it.
   */
  test("a create that snapshots the profile's key leaks nothing", async () => {
    const backend = fleetWithSharedProfile();
    const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG });

    const events = await drain(
      hermetic.agents.create({ name: "orbit", provider_profile: "nous-shared" }),
    );
    assertClean(JSON.stringify(events));
    assertClean(JSON.stringify(await backend.store.events.query("orbit")));
    assertClean(JSON.stringify(await backend.store.agents.get("orbit")));
    assertClean(JSON.stringify(await hermetic.agents.get("orbit")));
    assertClean(JSON.stringify(await hermetic.agents.history({ name: "orbit" })));

    // Not vacuous: the profile's value really was copied into the agent's own
    // revision slot, and the profile — not the value — is what the stream says.
    expect(backend.params.get("/hermes/fxtr0001/orbit/provider-key-nousshrd-r1")).toBe(
      FIXTURE_SHARED_NOUS_KEY,
    );
    expect(JSON.stringify(events)).toInclude("copied from provider profile nous-shared");
  });

  test("redactSecretsPushInput is what a head records about a push", () => {
    const redacted = redactSecretsPushInput({
      name: "_fleet",
      shared: "nous-key",
      value: FIXTURE_SHARED_KEY,
    });
    expect(redacted.value).toBe("(redacted)");
    // Which slot was written is the whole reason the record is worth keeping.
    expect(redacted.shared).toBe("nous-key");
    assertClean(JSON.stringify(redacted));
    expect(redactSecretsPushInput({ name: "atlas", provider_key: true })).toEqual({
      name: "atlas",
      provider_key: true,
    });
  });

  /**
   * §8.3: a key on a create is refused, and the refusal itself is a surface
   * that could carry it — the message, the details, and whatever a head records
   * about the input. All three are grepped.
   */
  test("a provider key given at create is refused without ever being echoed", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG });

    let thrown: unknown;
    try {
      await drain(
        hermetic.agents.create({
          name: "research-1",
          provider: "openrouter",
          api_key: FIXTURE_PROVIDER_KEY,
        }),
      );
    } catch (e) {
      thrown = e;
    }
    expect((thrown as HermeticError).code).toBe("VALIDATION");
    assertClean(String((thrown as HermeticError).message));
    assertClean(JSON.stringify((thrown as HermeticError).details ?? {}));
    assertClean(
      JSON.stringify(
        redactCreateInput({
          name: "research-1",
          provider: "openrouter",
          api_key: FIXTURE_PROVIDER_KEY,
        }),
      ),
    );
    // Not vacuous: nothing was created and no slot was written.
    expect(await backend.store.agents.get("research-1")).toBeNull();
    expect(backend.params.has("/hermes/fxtr0001/research-1/provider-key")).toBe(false);
  });

  /**
   * The key the profile holds reaches the agent's own revision slot and no
   * other surface — the path that replaced the one above.
   */
  test("a profile's key reaches the agent's revision slot and nothing else", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG });

    const events = await drain(
      hermetic.agents.create({ name: "research-1", provider_profile: "openrouter-cheap" }),
    );
    assertClean(JSON.stringify(events));
    assertClean(JSON.stringify(await backend.store.agents.get("research-1")));
    assertClean(JSON.stringify(await backend.store.events.query("research-1")));

    // Again, not vacuous: the value really did land in the slot.
    expect(backend.params.get("/hermes/fxtr0001/research-1/provider-key-rtr00002-r1")).toBe(
      FIXTURE_PROFILE_KEY,
    );
  });

  test("redactCreateInput is what a head records in the runs log", () => {
    const redacted = redactCreateInput({
      name: "research-1",
      provider: "nous",
      api_key: FIXTURE_PROVIDER_KEY,
    });
    expect(redacted.api_key).toBe("(redacted)");
    expect(redacted.provider).toBe("nous");
    assertClean(JSON.stringify(redacted));
    // An input with no key is left exactly as it was.
    expect(redactCreateInput({ name: "research-1" })).toEqual({ name: "research-1" });
  });

  /**
   * The same guarantee for the one call whose entire purpose is to carry a
   * secret. All three tiers of §8.1 arrive in the same `value` field — provider
   * key, `bws` token, the fleet's Tailscale OAuth client secret — and the flags
   * beside it are what a `runs` entry is allowed to keep: which slot was
   * written, never what went into it.
   */
  test("redactSecretsPushInput keeps the slot and drops the value", () => {
    for (const input of [
      { name: "research-1", provider_key: true, value: FIXTURE_PROVIDER_KEY },
      { name: "research-1", bws_token: true, value: FIXTURE_BWS_TOKEN },
      { name: FLEET_KEY, tailscale_oauth: true, value: FIXTURE_OAUTH },
    ]) {
      const redacted = redactSecretsPushInput(input);
      expect(redacted.value).toBe("(redacted)");
      expect(redacted.name).toBe(input.name);
      assertClean(JSON.stringify(redacted));
    }
    // `--from-bitwarden` carries no value at all, and is left exactly as it was.
    expect(redactSecretsPushInput({ name: "research-1", from_bitwarden: true })).toEqual({
      name: "research-1",
      from_bitwarden: true,
    });
  });

  test("a recreate mints a fresh key and still leaks nothing", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG });
    await drain(hermetic.agents.create({ name: "atlas" }));
    const events = await drain(hermetic.agents.recreate({ name: "atlas", yes: true }));
    assertClean(JSON.stringify(events));
    assertClean(JSON.stringify(await backend.store.events.query("atlas")));
  });

  test("user-data carries a bucket, a URL and a digest, never a value (§6.3)", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG });
    let captured = "";
    const realRun = backend.compute.runInstance;
    backend.compute.runInstance = async (spec) => {
      captured = spec.user_data;
      return realRun(spec);
    };
    await drain(hermetic.agents.create({ name: "atlas" }));
    // Four fields; everything else the box needs is in the fleet manifest (§1).
    expect(captured).toInclude("hermetic-fixture-bucket");
    expect(captured).toInclude("hermeticd_sha256");
    assertClean(captured);
  });
});

/**
 * §8.3 again, on the failure path. An error message is output too: it reaches
 * the operator's terminal, the run log, and the server's SSE stream, so a
 * failing SSM or Tailscale call must not carry the value it was handling.
 */
describe("thrown errors never carry a secret", () => {
  test("a failing SSM write does not echo the value it was writing", async () => {
    const { SsmSecrets } = await import("../src/aws/ssm.ts");
    const boom = {
      send: async () => {
        const e = new Error(
          `ParameterLimitExceeded while writing Value=${FIXTURE_BWS_TOKEN} to /hermes/fxtr0001/atlas/bws-token`,
        );
        e.name = "ParameterLimitExceeded";
        throw e;
      },
    };
    const secrets = new SsmSecrets(boom as never);

    let error: HermeticError | null = null;
    try {
      await secrets.put("/hermes/fxtr0001/atlas/bws-token", FIXTURE_BWS_TOKEN);
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error).not.toBeNull();
    // The AWS message is the one thing that could smuggle it through, so the
    // wrapper names the slot and keeps the provider's prose out.
    assertClean(JSON.stringify({ message: error!.message, details: error!.details }));
    expect(error!.message).toInclude("/hermes/fxtr0001/atlas/bws-token");
  });

  test("a rejected tailscale credential does not echo the OAuth secret", async () => {
    const { TailscaleClient } = await import("../src/aws/tailscale.ts");
    const { tailscaleOauthSecretPath } = await import("../src/backend/constants.ts");
    const OAUTH = "tskey-client-kABC123-FIXTURE-SECRET";
    const slot = tailscaleOauthSecretPath(FIXTURE_CONFIG.fleet_id);

    const client = new TailscaleClient(
      {
        reveal: async (p: string) => (p === slot ? OAUTH : null),
        isPlaceholder: async () => false,
      } as never,
      {
        fleetId: () => FIXTURE_CONFIG.fleet_id,
        // A real 4xx body echoes the form it was sent.
        fetch: async () => new Response(`invalid client_secret=${OAUTH}`, { status: 401 }),
      },
    );

    let error: HermeticError | null = null;
    try {
      await client.mintAuthKey("atlas");
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error).not.toBeNull();
    assertClean(JSON.stringify({ message: error!.message, details: error!.details }));
  });

  test("a rejected auth-key mint does not echo the minted key", async () => {
    const { TailscaleClient } = await import("../src/aws/tailscale.ts");
    const { tailscaleOauthSecretPath } = await import("../src/backend/constants.ts");
    const slot = tailscaleOauthSecretPath(FIXTURE_CONFIG.fleet_id);

    const client = new TailscaleClient(
      {
        reveal: async (p: string) => (p === slot ? "tskey-client-kABC123-oauth" : null),
        isPlaceholder: async () => false,
      } as never,
      {
        fleetId: () => FIXTURE_CONFIG.fleet_id,
        fetch: async (url: string) =>
          url.endsWith("/oauth/token")
            ? new Response(JSON.stringify({ access_token: "tsoauth", expires_in: 3600 }))
            : new Response(`refused: tskey-auth-LEAKED-SECRET already exists`, { status: 409 }),
      },
    );

    let error: HermeticError | null = null;
    try {
      await client.mintAuthKey("atlas");
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error).not.toBeNull();
    assertClean(JSON.stringify({ message: error!.message, details: error!.details }));
  });

  /**
   * Run once resume-forward and once with `--rollback-on-failure`: the rollback
   * yields a second round of events, after the slots have been written and
   * while they are being deleted, which is exactly where a step that named what
   * it removed rather than how many would leak (`rollback.ts`).
   */
  for (const rollback_on_failure of [false, true]) {
    const suffix = rollback_on_failure ? " (rolled back)" : "";
    test(`a create that fails mid-flight leaks nothing through the throw${suffix}`, async () => {
      const backend = seedFixtureFoundation(new MemoryBackend());
      const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG });
      backend.compute.runInstance = async () => {
        throw new HermeticError("INTERNAL", `RunInstances failed for ${FIXTURE_TS_KEY}-atlas`, {
          user_data: `{"key":"${FIXTURE_TS_KEY}"}`,
        });
      };

      const seen: unknown[] = [];
      let error: HermeticError | null = null;
      try {
        for await (const e of hermetic.agents.create({
          name: "atlas",
          // §8.3: no key on the request. The credential comes from the profile
          // and is snapshotted into the agent's own slot before this fails, so
          // the failure still runs with a real secret in play.
          provider_profile: "openrouter-cheap",
          rollback_on_failure,
        })) {
          seen.push(e);
        }
      } catch (e) {
        error = e as HermeticError;
      }
      // The backend itself leaked; the point is that everything core *produced*
      // — the event stream and the event log — did not.
      expect(error).not.toBeNull();
      expect(seen.length).toBeGreaterThan(0);
      // A silently dropped flag would make the rolled-back case a duplicate of
      // the other one, and it would pass: prove the unwind actually ran.
      expect(backend.mutations.includes("store.agents.delete")).toBe(rollback_on_failure);
      const row = await backend.store.agents.get("atlas");
      if (rollback_on_failure) expect(row).toBeNull();
      else expect(row).not.toBeNull();
      assertClean(JSON.stringify(seen));
      assertClean(JSON.stringify(await backend.store.events.query("atlas")));
    });
  }
});

/**
 * §8.3, on the one secret that arrives as a *field of a request*. Everything
 * else is minted or pushed; `init --create` takes the tailnet OAuth client
 * secret as an argument, which puts it in reach of the event stream, the event
 * log, a validation error, and the head's `runs` log.
 */
describe("the tailscale OAuth secret never escapes init", () => {
  const INIT_INPUT = {
    create: true,
    profile: "acme-dev",
    region: "us-west-2",
    account_id_typed: "123456789012",
    tailnet: "acme.ts.net",
    tailscale_oauth_secret: FIXTURE_OAUTH,
  } as const;

  test("a successful create leaks it through neither events nor the event log", async () => {
    const backend = new MemoryBackend();
    const hermetic = testHermetic({ backend, config: null });

    const events = await drain(hermetic.init(INIT_INPUT));
    expect(events.some((e) => e.phase === "tailscale")).toBe(true);
    assertClean(JSON.stringify(events));
    assertClean(JSON.stringify(backend.events));

    // Not vacuous: the value really did reach its SSM slot — the fleet-scoped
    // one, under the id this init minted (§8.2).
    const minted = backend.fleetItem!.fleet_id;
    expect(backend.params.get(`/hermetic/${minted}/tailscale/oauth-secret`)).toBe(FIXTURE_OAUTH);
  });

  test("a validation failure reports which fields were wrong, not their values", async () => {
    const backend = new MemoryBackend();
    const hermetic = testHermetic({ backend, config: null });

    let error: HermeticError | null = null;
    try {
      // `tailnet` is too short, so the whole input is rejected — with the secret
      // sitting right beside it in the object Zod was handed.
      await drain(hermetic.init({ ...INIT_INPUT, tailnet: "x" }));
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error!.code).toBe("VALIDATION");
    assertClean(JSON.stringify({ message: error!.message, details: error!.details }));
    expect(JSON.stringify(error!.details)).toContain("tailnet");
  });

  test("a mistyped account id refuses without echoing the secret", async () => {
    const backend = new MemoryBackend();
    const hermetic = testHermetic({ backend, config: null });
    let error: HermeticError | null = null;
    try {
      await drain(hermetic.init({ ...INIT_INPUT, account_id_typed: "000000000000" }));
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error!.code).toBe("CONFIRMATION_REQUIRED");
    assertClean(JSON.stringify({ message: error!.message, details: error!.details }));
  });

  test("redactInitInput is what a head records in the runs log", () => {
    const redacted = redactInitInput(INIT_INPUT);
    assertClean(JSON.stringify(redacted));
    expect(redacted.tailscale_oauth_secret).toBe("(redacted)");
    // Everything else survives, so the log still says what was run.
    expect(redacted.profile).toBe("acme-dev");
    expect(redacted.tailnet).toBe("acme.ts.net");
    expect(redacted.account_id_typed).toBe("123456789012");
  });

  test("redactInitInput leaves an input with no secret alone", () => {
    const redacted = redactInitInput({ attach: true, profile: "acme-dev" });
    expect("tailscale_oauth_secret" in redacted).toBe(false);
    expect(redacted.profile).toBe("acme-dev");
  });

  test("the fixture wizard's create leaks it no further either", async () => {
    // Its own home: `init` freezes a config row, and no other test in the
    // process should have to care that this one ran.
    const session = await openForInit({
      fixture: true,
      home: mkdtempSync(join(tmpdir(), "hermetic-secrets-leak-")),
    });
    const events = await drain(
      session.hermetic.init({
        profile: "acme-dev",
        region: "us-west-2",
        account_id_typed: "123456789012",
        tailnet: "acme.ts.net",
        tailscale_oauth_secret: FIXTURE_OAUTH,
      }),
    );
    assertClean(JSON.stringify(events));
    // `bind()` rebuilds against what init just froze — the same step the server
    // takes after the wizard finishes.
    const bound = session.bind({
      profile: "acme-dev",
      region: "us-west-2",
      accountId: "123456789012",
    });
    assertClean(JSON.stringify(await bound.config.show()));
    assertClean(JSON.stringify(await bound.agents.history({ name: "atlas" })));
    session.close();
  });
});

/**
 * §8.3: the slots that are not an agent's. They are reached by the reserved
 * name `_fleet`, which every other command refuses, so the interesting
 * assertions are about which combinations of name and flag are legal at all.
 */
describe("the fleet-wide slots", () => {
  function fleetHermetic() {
    const backend = seedFixtureFoundation(new MemoryBackend());
    return { backend, hermetic: testHermetic({ backend, config: FIXTURE_CONFIG }) };
  }

  test("verify reports both halves of the OAuth client, without an agent row", async () => {
    const { hermetic } = fleetHermetic();
    const report = await hermetic.secrets.verify({ name: "_fleet" });
    expect(report.name).toBe("_fleet");
    // The secret, then its companion id — "the secret is set but the id slot is
    // empty" is a real state a hand-rotated fleet reaches and is invisible
    // unless both are listed — then every shared slot the fleet has declared,
    // which is the other thing `_fleet` owns (§8.3).
    expect(report.slots.map((s) => s.path)).toEqual([
      "/hermetic/fxtr0001/tailscale/oauth-secret",
      "/hermetic/fxtr0001/tailscale/oauth-client-id",
      ...FIXTURE_SLUGS.map((slug) => `/hermetic/fxtr0001/secrets/${slug}`),
    ]);
    // Neither half of the OAuth client is stored on a bare fixture foundation;
    // the shared slots are, and one of them is still a placeholder — which is
    // what makes the fleet report as incomplete either way.
    expect(report.slots.filter((s) => s.exists).map((s) => s.path)).toEqual(
      FIXTURE_SLUGS.map((slug) => `/hermetic/fxtr0001/secrets/${slug}`),
    );
    expect(report.ok).toBe(false);
  });

  test("`_fleet` has only its own slot, and no agent has it", async () => {
    const { hermetic } = fleetHermetic();
    await expect(
      hermetic.secrets.push({ name: "_fleet", bws_token: true, value: FIXTURE_BWS_TOKEN }),
    ).rejects.toThrow(/--tailscale-oauth or --shared/);
    await expect(
      hermetic.secrets.push({ name: "atlas", tailscale_oauth: true, value: FIXTURE_OAUTH }),
    ).rejects.toThrow(/fleet-wide slot/);
    // Two slot-selecting flags is still one push too many, the fleet flag
    // included.
    await expect(
      hermetic.secrets.push({
        name: "_fleet",
        provider_key: true,
        tailscale_oauth: true,
        value: FIXTURE_OAUTH,
      }),
    ).rejects.toThrow(/one at a time/);
  });
});

/**
 * §5/§8.3: rotating the fleet's Tailscale OAuth client. It exists because
 * Tailscale cannot add a scope to an existing client — going from `auth_keys`
 * alone to `auth_keys` + `devices:core` means a *new* client — so this is the
 * one command that moves a fleet onto one, and the credential it moves is the
 * one every agent's join depends on.
 */
describe("rotating the fleet's Tailscale OAuth client", () => {
  const NEW_SECRET = "tskey-client-FIXTURE2-FIXTUREROTATED";

  function fleetWith(verify: TailscaleOauthCheck) {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const hermetic = testHermetic({
      backend,
      config: FIXTURE_CONFIG,
      verifyTailscaleOauth: async () => verify,
    });
    return { backend, hermetic };
  }

  const BOTH_SCOPES: TailscaleOauthCheck = {
    ok: true,
    authenticated: true,
    can_mint: true,
    can_list_devices: true,
    policy_scope: "write",
    revoked: true,
    problem: null,
  };

  test("stores both halves, updates _fleet, and never echoes the secret", async () => {
    const { backend, hermetic } = fleetWith(BOTH_SCOPES);
    const result = await hermetic.secrets.push({
      name: "_fleet",
      tailscale_oauth: true,
      value: NEW_SECRET,
    });

    expect(result.path).toBe("/hermetic/fxtr0001/tailscale/oauth-secret");
    // No note: this client has both scopes.
    expect(result.note).toBeUndefined();
    expect(backend.params.get("/hermetic/fxtr0001/tailscale/oauth-secret")).toBe(NEW_SECRET);
    // The id is parsed out of the secret, never asked for — and it lands in
    // both places `init` puts it, so `config`/Settings can name the client.
    expect(backend.params.get("/hermetic/fxtr0001/tailscale/oauth-client-id")).toBe("FIXTURE2");
    expect((await backend.store.fleet.get())?.tailscale_oauth_client_id).toBe("FIXTURE2");

    const history = await backend.store.events.query("_fleet");
    expect(history.some((e) => e.action === "secrets.push")).toBe(true);
    // The id is not a secret and is useful in the log; the secret is neither.
    expect(JSON.stringify(history)).toInclude("FIXTURE2");
    expect(JSON.stringify(history)).not.toInclude(NEW_SECRET);
    expect(JSON.stringify(result)).not.toInclude(NEW_SECRET);
  });

  /**
   * The refusal this verification exists for. A client that cannot mint breaks
   * every future `agents.create`, and storing it would only move the discovery
   * to a booted box twenty minutes later.
   */
  test("a client that cannot mint is refused and nothing is written", async () => {
    const { backend, hermetic } = fleetWith({
      ok: false,
      authenticated: true,
      can_mint: false,
      can_list_devices: false,
      policy_scope: "none",
      revoked: false,
      problem: "Tailscale refused to mint a tag:hermetic key (HTTP 403)",
    });
    backend.resetMutations();
    const err = await hermetic.secrets
      .push({ name: "_fleet", tailscale_oauth: true, value: NEW_SECRET })
      .catch((e: unknown) => e as HermeticError);

    expect((err as HermeticError).code).toBe("TAILSCALE_UNAVAILABLE");
    expect((err as HermeticError).message).toContain("403");
    expect(backend.params.has("/hermetic/fxtr0001/tailscale/oauth-secret")).toBe(false);
    expect(backend.mutations).not.toContain("secrets.ensureSlot");
    expect((await backend.store.fleet.get())?.tailscale_oauth_client_id).not.toBe("FIXTURE2");
  });

  /**
   * The other half of the decision: a mint-only client is exactly what every
   * fleet created before `devices:core` carries, so it is stored, and the note
   * is what the head prints.
   */
  test("a mint-only client is stored, with the note the head prints", async () => {
    const { backend, hermetic } = fleetWith({
      ok: true,
      authenticated: true,
      can_mint: true,
      can_list_devices: false,
      policy_scope: "none",
      revoked: true,
      problem: NO_DEVICES_SCOPE_NOTE,
    });
    const result = await hermetic.secrets.push({
      name: "_fleet",
      tailscale_oauth: true,
      value: NEW_SECRET,
    });
    expect(backend.params.get("/hermetic/fxtr0001/tailscale/oauth-secret")).toBe(NEW_SECRET);
    expect(result.note).toContain("devices:core");
    expect(result.note).toContain("hermetic secrets push _fleet --tailscale-oauth");
  });

  test("a value that is not an OAuth client secret is refused before verification", async () => {
    let verified = false;
    const backend = seedFixtureFoundation(new MemoryBackend());
    const hermetic = testHermetic({
      backend,
      config: FIXTURE_CONFIG,
      verifyTailscaleOauth: async () => {
        verified = true;
        return BOTH_SCOPES;
      },
    });
    const err = await hermetic.secrets
      .push({ name: "_fleet", tailscale_oauth: true, value: "FIXTURE-not-a-client" })
      .catch((e: unknown) => e as HermeticError);
    expect((err as HermeticError).code).toBe("VALIDATION");
    expect(verified).toBe(false);
    expect(backend.params.has("/hermetic/fxtr0001/tailscale/oauth-secret")).toBe(false);
  });

  test("verify sees the rotated slots", async () => {
    const { hermetic } = fleetWith(BOTH_SCOPES);
    await hermetic.secrets.push({ name: "_fleet", tailscale_oauth: true, value: NEW_SECRET });
    const report = await hermetic.secrets.verify({ name: "_fleet" });
    const oauth = report.slots.filter((s) => s.path.startsWith("/hermetic/fxtr0001/tailscale/"));
    expect(oauth).toHaveLength(2);
    expect(oauth.every((s) => s.exists && !s.placeholder)).toBe(true);
    /**
     * `ok` is about what the fleet *depends on*. The fixture also declares a
     * shared slot nobody has filled and no provider names — worth saying, but
     * not a failure, or `secrets verify` would be permanently red on any fleet
     * that ever made room for a key in advance. So the rotation makes the fleet
     * ok, and the empty slot is a warning beside it.
     */
    expect(report.slots.filter((s) => s.placeholder).map((s) => s.path)).toEqual([
      "/hermetic/fxtr0001/secrets/openrouter-key",
      `/hermetic/fxtr0001/secrets/profile-${FIXTURE_PROFILE_IDS.nous}`,
    ]);
    expect(report.ok).toBe(true);
    expect(report.warnings).toEqual([
      "shared slot openrouter-key is declared but empty; no provider names it",
      `shared slot profile-${FIXTURE_PROFILE_IDS.nous} is declared but empty; no provider names it`,
    ]);
  });
});

/**
 * §8.3's provider profiles: the two surfaces that *hold* a key — a create that
 * stores one and a catalog read that presents one — and the three ways a
 * catalog read fails.
 *
 * The comment above `SECRETS` used to claim this coverage while nothing here
 * exercised it. Each test below drives the real method with a sentinel value
 * and greps every channel a value could survive on: the result, the error's
 * message, the error's `details`, the `_fleet` event log, and the settings
 * object the method answers with.
 */
describe("secrets never leak · provider profiles", () => {
  /** Distinct sentinels, so a test cannot pass on somebody else's redaction. */
  const DRAFT_KEY = "sk-FIXTURE-DRAFT-PROFILE-KEY";
  const STORED_KEY = "sk-FIXTURE-STORED-PROFILE-KEY";

  function profileFleet(catalog?: NonNullable<HermeticDeps["modelCatalog"]>) {
    const backend = seedFixtureFleet(new MemoryBackend());
    const hermetic = testHermetic({
      backend,
      config: FIXTURE_CONFIG,
      ...(catalog === undefined ? {} : { modelCatalog: catalog }),
    });
    return { backend, hermetic };
  }

  /** Everything a caller, an operator or a log could see about one call. */
  async function everythingSeen(backend: MemoryBackend, call: () => Promise<unknown>): Promise<string> {
    let result: unknown;
    let failure: unknown;
    try {
      result = await call();
    } catch (e) {
      failure = e;
    }
    const events = await backend.store.events.query(FLEET_KEY);
    const thrown =
      failure === undefined
        ? ""
        : [
            (failure as Error).message,
            (failure as Error).stack ?? "",
            JSON.stringify((failure as HermeticError).details ?? {}),
            JSON.stringify(failure, Object.getOwnPropertyNames(failure)),
          ].join(" ");
    return [JSON.stringify(result ?? null), JSON.stringify(events), thrown].join(" ");
  }

  test("a create that stores a key answers, and records, only the slug", async () => {
    const { backend, hermetic } = profileFleet();
    const seen = await everythingSeen(backend, () =>
      hermetic.providers.create({ provider: "openai", name: "leak-openai", api_key: STORED_KEY }),
    );
    expect(seen).not.toInclude(STORED_KEY);
    assertClean(seen);
    // The key really was stored — the assertion above is not passing because
    // nothing happened.
    expect([...backend.params.values()]).toContain(STORED_KEY);
  });

  test("a rotation records that a key moved, never the key", async () => {
    const { backend, hermetic } = profileFleet();
    const seen = await everythingSeen(backend, () =>
      hermetic.providers.update({ profile: "openrouter-cheap", api_key: STORED_KEY }),
    );
    expect(seen).toInclude("key rotated");
    expect(seen).not.toInclude(STORED_KEY);
    assertClean(seen);
  });

  test("a successful catalog read never echoes the draft key back", async () => {
    const { backend, hermetic } = profileFleet();
    const seen = await everythingSeen(backend, () =>
      hermetic.providers.models({ provider: "openai", api_key: DRAFT_KEY }),
    );
    expect(seen).toInclude("gpt-5.6-luna");
    expect(seen).not.toInclude(DRAFT_KEY);
  });

  /**
   * The failure paths are the ones that matter most: a provider that refuses a
   * credential often echoes it back in its own error body, and an unhandled
   * `fetch` rejection carries the request in its message on some runtimes.
   */
  test.each([
    [
      "401, with the key echoed in the provider's own body",
      (): Response =>
        new Response(JSON.stringify({ error: { message: `bad key ${DRAFT_KEY}` } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      "PROVIDER_AUTH" as ErrorCode,
    ],
    [
      "500, with the key echoed in the provider's own body",
      (): Response => new Response(`upstream failed for ${DRAFT_KEY}`, { status: 500 }),
      "PROVIDER_UNREACHABLE" as ErrorCode,
    ],
    [
      "a body that is not a catalog at all",
      (): Response =>
        new Response(`<html>${DRAFT_KEY}</html>`, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      "PROVIDER_MALFORMED" as ErrorCode,
    ],
  ])("a catalog read that fails with %s carries no key", async (_why, respond, code) => {
    const { backend, hermetic } = profileFleet({ fetch: () => Promise.resolve(respond()) });
    let failure: unknown;
    const seen = await everythingSeen(backend, async () => {
      try {
        return await hermetic.providers.models({ provider: "openai", api_key: DRAFT_KEY });
      } catch (e) {
        failure = e;
        throw e;
      }
    });
    expect((failure as HermeticError).code).toBe(code);
    expect(seen).not.toInclude(DRAFT_KEY);
    assertClean(seen);
  });

  /** The transport itself failing: the rejection's own message is what travels. */
  test("a catalog read whose transport rejects carries no key", async () => {
    const { backend, hermetic } = profileFleet({
      fetch: () => Promise.reject(new Error(`connect ECONNREFUSED while sending ${DRAFT_KEY}`)),
    });
    const seen = await everythingSeen(backend, () =>
      hermetic.providers.models({ provider: "openai", api_key: DRAFT_KEY }),
    );
    expect(seen).not.toInclude(DRAFT_KEY);
  });

  /**
   * The *stored* credential is read out of SSM to make the request, so a read
   * for a saved profile has a real key in hand for the length of the call. It
   * must not reach the answer either.
   */
  test("a catalog read for a saved profile never returns the stored key", async () => {
    const { backend, hermetic } = profileFleet();
    const seen = await everythingSeen(backend, () =>
      hermetic.providers.models({ profile: "anthropic-main" }),
    );
    expect(seen).toInclude("claude-sonnet-5");
    assertClean(seen);
  });

  test("listing profiles never returns the value behind any slot", async () => {
    const { backend, hermetic } = profileFleet();
    const seen = await everythingSeen(backend, () => hermetic.providers.list());
    expect(seen).toInclude("anthropic-main");
    assertClean(seen);
  });

  /** The redaction helpers the heads record with, on the shapes that carry a key. */
  test("the redactions a head records with drop the key rather than shortening it", () => {
    expect(redactProvidersCreateInput({ provider: "openai", name: "x", api_key: DRAFT_KEY })).toEqual({
      provider: "openai",
      name: "x",
      api_key: "(redacted)",
    });
    expect(redactProvidersUpdateInput({ profile: "x", api_key: DRAFT_KEY })).toEqual({
      profile: "x",
      api_key: "(redacted)",
    });
    expect(redactProvidersModelsInput({ provider: "openai", api_key: DRAFT_KEY })).toEqual({
      provider: "openai",
      api_key: "(redacted)",
    });
    // An input with no key keeps its shape, rather than gaining a field.
    expect(redactProvidersModelsInput({ profile: "anthropic-main" })).toEqual({
      profile: "anthropic-main",
    });
  });
});
