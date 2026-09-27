/**
 * The §4.7 preflight gate inside `init`.
 *
 * Tailscale is the only way in and it is required (§1), so a foundation created
 * from a machine that is not on a tailnet is a fleet its own operator cannot
 * reach — and nothing about the CloudFormation stack, the `_fleet` item or the
 * frozen config says so. The gate stands in core rather than in a head because
 * the CLI and the browser wizard are both in front of it, and neither can be
 * the only one that checks.
 *
 * The other half of the same change: the tailnet is *detected* rather than
 * typed, which removed the one free-text field in the wizard that nothing
 * validated and whose typo only surfaced on a booted box.
 */
import { describe, expect, test } from "bun:test";
import { createHermetic } from "../src/hermetic.ts";
import { FIXTURE_CONFIG, MemoryBackend, seedFixtureFoundation } from "../src/backend/memory.ts";
import { HermeticError } from "../src/errors.ts";
import type { LocalConfig, TailscalePreflight } from "../src/schema/index.ts";
import { TAILSCALE_ADMIN_DNS_URL, TAILSCALE_DOWNLOAD_URL } from "../src/fleet/preflight.ts";
import { POLICY_RETAINED_NOTICE } from "../src/fleet/policy.ts";
import { drain, OK_OAUTH, OK_TAILSCALE, testHermetic } from "./helpers.ts";

/**
 * §4.8: these walk `init --create`, so the account they describe has no fleets
 * in it yet. The fixture directory is process-global and seeded with
 * `main`/`staging` for the *populated* fixture account, and an unnamed create
 * against that one is correctly refused — so each of these says which account
 * it is in rather than inheriting whichever ran last.
 */
const LOGGED_OUT: TailscalePreflight = {
  ok: false,
  installed: true,
  running: false,
  backend_state: "NeedsLogin",
  tailnet: null,
  cert_domains: [],
  hostname: null,
  addresses: [],
  binary: "tailscale",
  problem: "tailscale is installed but not logged in; run `tailscale up`",
};

function store() {
  const written: LocalConfig[] = [];
  return {
    written,
    configStore: { write: async (c: LocalConfig) => void written.push(c) },
  };
}

function on(preflight: TailscalePreflight, backend = new MemoryBackend()) {
  const s = store();
  const hermetic = createHermetic({
    fixture: true,
    backend,
    config: null,
    configStore: s.configStore,
    localTailscale: async () => preflight,
    verifyTailscaleOauth: OK_OAUTH,
  });
  return { backend, hermetic, written: s.written };
}

const CREATE = {
  create: true,
  region: "us-west-2",
  profile: "acme-dev",
  account_id_typed: "123456789012",
} as const;

async function codeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof HermeticError ? e.code : `not-a-HermeticError:${String(e)}`;
  }
}

describe("creating a foundation from a machine that is not on a tailnet", () => {
  test("is refused, and nothing is created or frozen", async () => {
    const { backend, hermetic, written } = on(LOGGED_OUT);
    const code = await codeOf(() => drain(hermetic.init(CREATE)));

    expect(code).toBe("TAILSCALE_UNAVAILABLE");
    // The gate stands before the first mutation: no stack, no `_fleet`, no config.
    expect(backend.stack).toBeNull();
    expect(backend.fleetItem).toBeNull();
    expect(written).toEqual([]);
  });

  test("the message says what to do, and carries the daemon state", async () => {
    const { hermetic } = on(LOGGED_OUT);
    try {
      await drain(hermetic.init(CREATE));
      expect.unreachable();
    } catch (e) {
      const err = e as HermeticError;
      expect(err.message).toContain("not logged in");
      expect(err.message).toContain("--skip-tailscale-check");
      expect(err.details).toMatchObject({
        installed: true,
        running: false,
        backend_state: "NeedsLogin",
      });
    }
  });

  /**
   * No binary at all is the same refusal with a different first step: there is
   * nothing to bring up, so the answer is the download page. A logged-out
   * machine already has Tailscale, and pointing it at a download is noise.
   */
  test("a machine with no tailscale installed is sent to the download page", async () => {
    const { hermetic } = on({
      ...LOGGED_OUT,
      installed: false,
      problem: "no `tailscale` binary found on this machine",
    });
    try {
      await drain(hermetic.init(CREATE));
      expect.unreachable();
    } catch (e) {
      const err = e as HermeticError;
      expect(err.code).toBe("TAILSCALE_UNAVAILABLE");
      expect(err.message).toContain(TAILSCALE_DOWNLOAD_URL);
      expect(err.details).toMatchObject({ installed: false, download_url: TAILSCALE_DOWNLOAD_URL });
    }
  });

  /**
   * The sibling refusal, and the one that cost twenty minutes to discover: a
   * healthy laptop on a healthy tailnet whose HTTPS Certificates toggle is off.
   * Every agent's apply ends in `tailscale serve --https=443`, which fails on
   * the box long after the foundation exists — so the gate reads it here, off
   * the same `tailscale status --json` it already reads for the suffix.
   */
  test("a tailnet with HTTPS certificates off is refused before anything is created", async () => {
    const { backend, hermetic, written } = on({
      ...(await OK_TAILSCALE()),
      ok: false,
      cert_domains: [],
      problem: `tailscale is running but this tailnet has HTTPS certificates disabled; enable HTTPS Certificates at ${TAILSCALE_ADMIN_DNS_URL}`,
    });
    try {
      await drain(hermetic.init(CREATE));
      expect.unreachable();
    } catch (e) {
      const err = e as HermeticError;
      expect(err.code).toBe("TAILSCALE_UNAVAILABLE");
      expect(err.message).toContain("HTTPS certificates");
      expect(err.message).toContain(TAILSCALE_ADMIN_DNS_URL);
      // Installed and running, so the download page is not the next step.
      expect(err.message).not.toContain(TAILSCALE_DOWNLOAD_URL);
    }
    expect(backend.stack).toBeNull();
    expect(backend.fleetItem).toBeNull();
    expect(written).toEqual([]);
  });

  test("an installed-but-logged-out machine is not sent to the download page", async () => {
    const { hermetic } = on(LOGGED_OUT);
    try {
      await drain(hermetic.init(CREATE));
      expect.unreachable();
    } catch (e) {
      const err = e as HermeticError;
      expect(err.message).not.toContain(TAILSCALE_DOWNLOAD_URL);
      expect(err.details).not.toHaveProperty("download_url");
    }
  });

  /**
   * The headless escape hatch. The fleet it produces is real and reachable —
   * just not from here — so it is allowed, and the op says so.
   */
  test("--skip-tailscale-check creates anyway, with an explicit tailnet and a warning", async () => {
    const { backend, hermetic, written } = on(LOGGED_OUT);
    const events = await drain(
      hermetic.init({ ...CREATE, skip_tailscale_check: true, tailnet: "acme.ts.net" }),
    );

    expect(backend.fleetItem?.tailnet).toBe("acme.ts.net");
    expect(written).toHaveLength(1);
    const warned = events.find((e) => e.phase === "preflight");
    expect(warned?.level).toBe("warn");
    expect(warned?.message).toContain("not logged in");
  });

  /**
   * Skipping the check does not invent a tailnet: without a daemon to detect
   * one and without `--tailnet`, there is nothing to stamp on `_fleet`.
   */
  test("--skip-tailscale-check with no tailnet still refuses, because nothing knows it", async () => {
    const { backend, hermetic } = on(LOGGED_OUT);
    expect(await codeOf(() => drain(hermetic.init({ ...CREATE, skip_tailscale_check: true })))).toBe(
      "CONFIRMATION_REQUIRED",
    );
    expect(backend.stack).toBeNull();
  });
});

describe("the tailnet is detected, not asked for", () => {
  test("a create with no tailnet stamps the one this machine is on", async () => {
    const { backend, hermetic } = on(await OK_TAILSCALE());
    const events = await drain(hermetic.init(CREATE));

    expect(backend.fleetItem?.tailnet).toBe("acme.ts.net");
    const preflight = events.find((e) => e.phase === "preflight");
    expect(preflight?.level).not.toBe("warn");
    expect(preflight?.message).toContain("acme.ts.net");
    expect(preflight?.message).toContain("test-laptop");
  });

  /**
   * An operator who typed `--tailnet` said something deliberate; core reports
   * the disagreement and does the thing they asked for (§3.2 rule 1).
   */
  test("an explicit tailnet overrides the detected one, and the disagreement is warned about", async () => {
    const { backend, hermetic } = on(await OK_TAILSCALE());
    const events = await drain(hermetic.init({ ...CREATE, tailnet: "other.ts.net" }));

    expect(backend.fleetItem?.tailnet).toBe("other.ts.net");
    const warned = events.filter((e) => e.phase === "preflight" && e.level === "warn");
    expect(warned).toHaveLength(1);
    expect(warned[0]?.message).toContain("other.ts.net");
    expect(warned[0]?.message).toContain("acme.ts.net");
  });

  test("an explicit tailnet that agrees with the machine warns about nothing", async () => {
    const { hermetic } = on(await OK_TAILSCALE());
    const events = await drain(hermetic.init({ ...CREATE, tailnet: "acme.ts.net" }));
    expect(events.filter((e) => e.phase === "preflight" && e.level === "warn")).toEqual([]);
  });
});

/**
 * Attach is the new-machine, corrupt-state and new-teammate path — the one
 * an operator reaches for when something is already wrong. Refusing it would
 * strand exactly the person who needs it, so it reports and proceeds.
 */
describe("attaching from a machine that is not on the tailnet", () => {
  function attachable(preflight: TailscalePreflight) {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const s = store();
    return {
      backend,
      written: s.written,
      hermetic: createHermetic({
        fixture: true,
        backend,
        config: FIXTURE_CONFIG,
        configStore: s.configStore,
        localTailscale: async () => preflight,
      }),
    };
  }

  test("still attaches, and warns", async () => {
    const { hermetic, written } = attachable(LOGGED_OUT);
    const events = await drain(hermetic.init({ attach: true, profile: FIXTURE_CONFIG.profile }));

    expect(written).toHaveLength(1);
    expect(events.some((e) => e.phase === "attach")).toBe(true);
    const warned = events.find((e) => e.phase === "preflight");
    expect(warned?.level).toBe("warn");
  });

  /** On the wrong tailnet is its own failure, and a quieter one to walk into. */
  test("a healthy machine on a different tailnet than the fleet is warned about", async () => {
    const { hermetic } = attachable({ ...(await OK_TAILSCALE()), tailnet: "somewhere-else.ts.net" });
    const events = await drain(hermetic.init({ attach: true, profile: FIXTURE_CONFIG.profile }));

    const warned = events.find((e) => e.phase === "preflight");
    expect(warned?.level).toBe("warn");
    expect(warned?.message).toContain("somewhere-else.ts.net");
  });

  test("a machine on the fleet's own tailnet says nothing", async () => {
    const { backend } = attachable(await OK_TAILSCALE());
    const fleetTailnet = backend.fleetItem?.tailnet;
    const { hermetic } = attachable({ ...(await OK_TAILSCALE()), tailnet: fleetTailnet ?? null });
    const events = await drain(hermetic.init({ attach: true, profile: FIXTURE_CONFIG.profile }));
    expect(events.filter((e) => e.phase === "preflight")).toEqual([]);
  });
});

/**
 * The OAuth client's *second* scope. `devices:core` is what `doctor`'s device
 * drift and the stale-device cleanup at recreate/destroy need, but a fleet whose
 * client carries only `auth_keys` must keep working — every fleet created before
 * hermetic asked for it has one, and Tailscale cannot add a scope to a client
 * that exists. So `init` says it and carries on.
 */
describe("an OAuth client that mints but cannot list devices", () => {
  const SECRET = "tskey-client-FIXTURE-OAUTH";

  function creating(check: Awaited<ReturnType<typeof OK_OAUTH>>) {
    const s = store();
    const hermetic = createHermetic({
      fixture: true,
      backend: new MemoryBackend(),
      config: null,
      configStore: s.configStore,
      localTailscale: OK_TAILSCALE,
      verifyTailscaleOauth: async () => check,
    });
    return hermetic;
  }

  test("creates the fleet and warns, naming the scope and the fix", async () => {
    const hermetic = creating({
      ok: true,
      authenticated: true,
      can_mint: true,
      can_list_devices: false,
      policy_scope: "none",
      revoked: true,
      problem:
        "the client can mint keys but lacks devices:core read/write: stale devices will not be cleaned and doctor cannot check drift; create a client with both scopes and run hermetic secrets push _fleet --tailscale-oauth",
    });
    const events = await drain(hermetic.init({ ...CREATE, tailscale_oauth_secret: SECRET }));

    // The fleet is created: the missing scope is not a gate.
    expect(events.at(-1)?.phase).toBe("done");
    const warnings = events.filter((e) => e.level === "warn").map((e) => e.message);
    expect(warnings.some((m) => m.includes("devices:core"))).toBe(true);
    expect(warnings.some((m) => m.includes("secrets push _fleet --tailscale-oauth"))).toBe(true);
    // And the client is still reported as able to do the job that gates agents.
    expect(events.some((e) => e.message.includes("can mint tag:hermetic keys"))).toBe(true);
  });

  test("a client with every scope says so, and warns about nothing", async () => {
    const hermetic = creating(await OK_OAUTH());
    const events = await drain(hermetic.init({ ...CREATE, tailscale_oauth_secret: SECRET }));
    expect(
      events.some((e) =>
        e.message.includes("can mint tag:hermetic keys, list devices and edit the policy file"),
      ),
    ).toBe(true);
    expect(
      events.filter((e) => e.level === "warn").some((e) => e.message.includes("devices:core")),
    ).toBe(false);
  });

  /**
   * §4.7: with `policy_file` on the client, `init` writes hermetic's own three
   * entries rather than printing them and hoping. The `tagOwners` block is left
   * alone — the operator pasted that line before the client could be created at
   * all, and a second entry for one tag is invalid.
   */
  test("init writes hermetic's entries into the tailnet policy", async () => {
    const backend = new MemoryBackend();
    const before = backend.policyText;
    const hermetic = createHermetic({
      fixture: true,
      backend,
      config: null,
      configStore: store().configStore,
      localTailscale: OK_TAILSCALE,
      verifyTailscaleOauth: OK_OAUTH,
    });
    const events = await drain(hermetic.init({ ...CREATE, tailscale_oauth_secret: SECRET }));
    const policy = events.find((e) => e.phase === "policy")!;
    expect(policy.message).toContain("hermetic entries written (ssh, acls)");
    expect(policy.message).toContain("tagOwners left as you pasted it");
    expect(backend.policyText).not.toBe(before);
    expect(backend.policyText).toContain("hermetic:managed begin");
    // Every byte that was not hermetic's comes back unchanged.
    expect(backend.policyText).toContain("// Reviewed by the platform team");
  });

  /**
   * §5.2: the policy phase is the *last* thing `init --create` does.
   *
   * It used to run right after the OAuth secret landed in SSM, which put it in
   * front of the `_fleet` item, `ensureRelease` and the config freeze — so an
   * init that failed at any of those left hermetic's blocks in the operator's
   * policy file and no frozen config, which means no `hermetic policy` to show
   * them and no `hermetic teardown` to take them out. Ordering is the whole
   * fix, so ordering is what is asserted.
   */
  test("the policy is written after the fleet item and the freeze, last before done", async () => {
    const backend = new MemoryBackend();
    const s = store();
    const hermetic = createHermetic({
      fixture: true,
      backend,
      config: null,
      configStore: s.configStore,
      localTailscale: OK_TAILSCALE,
      verifyTailscaleOauth: OK_OAUTH,
    });
    const events = await drain(hermetic.init({ ...CREATE, tailscale_oauth_secret: SECRET }));

    const phases = events.map((e) => e.phase);
    expect(phases.at(-1)).toBe("done");
    expect(phases.at(-2)).toBe("policy");
    expect(phases.indexOf("policy")).toBeGreaterThan(phases.lastIndexOf("ready"));
    // And in the backend, after the row that names the fleet the blocks are for.
    expect(backend.mutations.indexOf("tailscale.setPolicy")).toBeGreaterThan(
      backend.mutations.indexOf("store.fleet.put"),
    );
    // The config is frozen by the time the policy is touched, which is what
    // makes the two commands that clean up after it reachable.
    expect(s.written.length).toBe(1);
  });

  /**
   * The other half of that promise, and it is deliberately not symmetry: what
   * `init` puts in, `teardown` leaves (§5.2). The tailnet is shared and outlives
   * any one foundation, so the entries stay and the operator is told so in the
   * same words the plan and the receipt use.
   */
  test("teardown right after init leaves the blocks init wrote", async () => {
    const backend = new MemoryBackend();
    const before = backend.policyText;
    const s = store();
    const hermetic = createHermetic({
      fixture: true,
      backend,
      config: null,
      configStore: s.configStore,
      localTailscale: OK_TAILSCALE,
      verifyTailscaleOauth: OK_OAUTH,
    });
    await drain(hermetic.init({ ...CREATE, tailscale_oauth_secret: SECRET }));
    expect(backend.policyText).toContain("hermetic:managed begin");
    expect(backend.policyText).not.toBe(before);
    const written = backend.policyText;
    backend.resetMutations();

    const frozen = s.written.at(-1)!;
    const events = await drain(testHermetic({ backend, config: frozen }).teardown({ yes: true }));
    expect(events.at(-1)!.phase).toBe("done");
    // Byte for byte what `init` left: hermetic's blocks and the operator's own
    // lines alike, with no write attempted at all.
    expect(backend.policyText).toBe(written);
    expect(backend.mutations).not.toContain("tailscale.setPolicy");
    expect(events.find((e) => e.phase === "tailscale")!.message).toBe(POLICY_RETAINED_NOTICE);
  });

  /** `--skip-policy` is for a policy file deployed from git. */
  test("--skip-policy leaves the tailnet policy untouched, and says so", async () => {
    const backend = new MemoryBackend();
    const before = backend.policyText;
    const hermetic = createHermetic({
      fixture: true,
      backend,
      config: null,
      configStore: store().configStore,
      localTailscale: OK_TAILSCALE,
      verifyTailscaleOauth: OK_OAUTH,
    });
    const events = await drain(
      hermetic.init({ ...CREATE, tailscale_oauth_secret: SECRET, skip_policy: true }),
    );
    const policy = events.find((e) => e.phase === "policy")!;
    expect(policy.level).toBe("warn");
    expect(policy.message).toContain("--skip-policy");
    expect(backend.policyText).toBe(before);
  });

  /** No `policy_file` scope: a warning and the manual fallback, never a failure. */
  test("a client that cannot write the policy warns and carries on", async () => {
    const backend = new MemoryBackend();
    backend.policyScope = "none";
    const hermetic = createHermetic({
      fixture: true,
      backend,
      config: null,
      configStore: store().configStore,
      localTailscale: OK_TAILSCALE,
      verifyTailscaleOauth: OK_OAUTH,
    });
    const events = await drain(hermetic.init({ ...CREATE, tailscale_oauth_secret: SECRET }));
    expect(events.at(-1)?.phase).toBe("done");
    const policy = events.find((e) => e.phase === "policy")!;
    expect(policy.level).toBe("warn");
    expect(policy.message).toContain("hermetic policy");
  });
});
