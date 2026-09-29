import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { DynamoDBDocumentClient, GetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import {
  DynamoDBClient,
  DescribeContinuousBackupsCommand,
  DescribeTableCommand,
} from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { IAMClient, ListAccountAliasesCommand } from "@aws-sdk/client-iam";
import { DescribeOrganizationCommand, OrganizationsClient } from "@aws-sdk/client-organizations";
import { mockClient } from "aws-sdk-client-mock";
import { openForInit } from "../src/open.ts";
import { openLocalDb, readConfig, recordRun, writeConfig } from "../src/local/db/index.ts";
import {
  FIXTURE_CONFIG,
  MemoryBackend,
  fixtureConfigFor,
  seedFixtureFoundation,
  createFixtureAccount,
} from "../src/backend/memory.ts";
import {
  FLEET_ID_TAG,
  tailscaleOauthClientIdPath,
  tailscaleOauthSecretPath,
} from "../src/backend/constants.ts";
import { HermeticError } from "../src/errors.ts";
import { HERMETICD_ENV } from "../src/release/artifacts.ts";
import { BUILD_VERSIONS } from "../src/hermetic.ts";
import type { LocalConfig } from "../src/schema/index.ts";
import { isFleetId } from "../src/fleet/fleet-id.ts";
import {
  OFFLINE_BROWSER_MIRROR,
  OFFLINE_HERMES_MIRROR,
  OK_TAILSCALE,
  drain,
  installTestStages,
  testHermetic,
} from "./helpers.ts";
import { installTestProfile, TEST_PROFILE } from "./aws-harness.ts";

/**
 * §4.8: these walk `init --create`, so the account they describe has no fleets
 * in it yet. The fixture directory is process-global and seeded with
 * `main`/`staging` for the *populated* fixture account, and an unnamed create
 * against that one is correctly refused — so each of these says which account
 * it is in rather than inheriting whichever ran last.
 */
const SCRATCH = tmpdir();

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(SCRATCH, "hermetic-init-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

async function codeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof HermeticError ? e.code : `not-a-HermeticError:${String(e)}`;
  }
}

/**
 * §4.7: the pre-init instance exists so the head can draw a profile picker. It
 * must not be able to freeze anything — a home is bound to one account for the
 * rest of its life, and that binding may only come from credentials that were
 * actually resolved.
 */
/**
 * §3.6: a real-mode `init` locates `hermeticd` before it creates anything and
 * would otherwise compile one from this checkout. Point it at a stand-in with a
 * matching version stamp; the S3 mock swallows the push.
 */
const HERMETICD_STANDIN_DIR = mkdtempSync(join(tmpdir(), "hermetic-hermeticd-"));
const HERMETICD_STANDIN = join(HERMETICD_STANDIN_DIR, "hermeticd");
const previousHermeticdEnv = process.env[HERMETICD_ENV];
/** A release is a binary *and* its stages; both are stand-ins here. */
const stages = installTestStages();
beforeAll(() => {
  writeFileSync(HERMETICD_STANDIN, "not a real binary");
  writeFileSync(`${HERMETICD_STANDIN}.version`, `${BUILD_VERSIONS.hermeticd}\n`);
  process.env[HERMETICD_ENV] = HERMETICD_STANDIN;
});
afterAll(() => {
  if (previousHermeticdEnv === undefined) delete process.env[HERMETICD_ENV];
  else process.env[HERMETICD_ENV] = previousHermeticdEnv;
  rmSync(HERMETICD_STANDIN_DIR, { recursive: true, force: true });
  stages.restore();
});

describe("the pre-init session", () => {
  test("init on it cannot write a config row and cannot reach AWS", async () => {
    const session = await openForInit({
      // The real reader runs `git` in this repository; no test may depend on
      // whether its author has uncommitted work (§3.6).
      git: () => null,
      home,
      preflight: { localTailscale: OK_TAILSCALE },
      hermesMirror: OFFLINE_HERMES_MIRROR,
      browserMirror: OFFLINE_BROWSER_MIRROR,
    });
    const code = await codeOf(() =>
      drain(session.hermetic.init({ profile: "totally-made-up", account_id_typed: "123456789012" })),
    );
    session.close();

    expect(code).toBe("NOT_INITIALIZED");

    const local = openLocalDb({ home });
    // Nothing was frozen: the database is exactly as `init` found it.
    expect(readConfig(local.db)).toBeNull();
    local.close();
  });

  test("every backend-backed method refuses before a profile is chosen", async () => {
    const session = await openForInit({
      // The real reader runs `git` in this repository; no test may depend on
      // whether its author has uncommitted work (§3.6).
      git: () => null,
      home,
      preflight: { localTailscale: OK_TAILSCALE },
      hermesMirror: OFFLINE_HERMES_MIRROR,
      browserMirror: OFFLINE_BROWSER_MIRROR,
    });
    expect(await codeOf(() => session.hermetic.agents.list())).toBe("NOT_INITIALIZED");
    expect(await codeOf(() => session.hermetic.doctor())).toBe("NOT_INITIALIZED");
    expect(await codeOf(() => session.hermetic.config.show())).toBe("NOT_INITIALIZED");
    session.close();
  });

  test("only the pre-init helpers are callable, and they need real support wired", async () => {
    const session = await openForInit({
      // The real reader runs `git` in this repository; no test may depend on
      // whether its author has uncommitted work (§3.6).
      git: () => null,
      home,
      preflight: { localTailscale: OK_TAILSCALE },
      hermesMirror: OFFLINE_HERMES_MIRROR,
      browserMirror: OFFLINE_BROWSER_MIRROR,
    });
    // Wired by `openForInit` to the real shared-ini loader, so this reads the
    // machine's own `~/.aws/config` rather than refusing.
    expect(session.hermetic.init.listProfiles).toBeFunction();
    expect(session.hermetic.init.resolveIdentity).toBeFunction();
    expect(session.existingConfig).toBeNull();
    session.close();
  });

  test("it reports a corrupt database rather than hiding it", async () => {
    await Bun.write(join(home, "hermetic.db"), "not a database\n".repeat(50));
    const session = await openForInit({
      // The real reader runs `git` in this repository; no test may depend on
      // whether its author has uncommitted work (§3.6).
      git: () => null,
      home,
      preflight: { localTailscale: OK_TAILSCALE },
      hermesMirror: OFFLINE_HERMES_MIRROR,
      browserMirror: OFFLINE_BROWSER_MIRROR,
    });
    expect(session.corruptedTo).toContain("hermetic.db.corrupt-");
    session.close();
  });

  test("an already-frozen home is surfaced for the head to show", async () => {
    const local = openLocalDb({ home });
    writeConfig(local.db, FIXTURE_CONFIG);
    local.close();

    const session = await openForInit({
      // The real reader runs `git` in this repository; no test may depend on
      // whether its author has uncommitted work (§3.6).
      git: () => null,
      home,
      preflight: { localTailscale: OK_TAILSCALE },
      hermesMirror: OFFLINE_HERMES_MIRROR,
      browserMirror: OFFLINE_BROWSER_MIRROR,
    });
    expect(session.existingConfig).toEqual(FIXTURE_CONFIG);
    session.close();
  });

  /**
   * A laptop that has never run `init` — exactly what `hermetic-portal` boots
   * into — must not gain a `hermetic.db` (or even the `HERMETIC_HOME`
   * directory) just from being asked "is this initialized?". `openForInit`
   * used to open (and migrate) the database eagerly regardless.
   */
  test("an uninitialized home is left untouched until something writes to it", async () => {
    expect(existsSync(home)).toBe(true); // the temp dir itself, made by mkdtempSync
    expect(readdirSync(home)).toEqual([]);

    const session = await openForInit({
      // The real reader runs `git` in this repository; no test may depend on
      // whether its author has uncommitted work (§3.6).
      git: () => null,
      home,
      preflight: { localTailscale: OK_TAILSCALE },
      hermesMirror: OFFLINE_HERMES_MIRROR,
      browserMirror: OFFLINE_BROWSER_MIRROR,
    });
    expect(session.existingConfig).toBeNull();
    expect(session.corruptedTo).toBeNull();
    // Merely opening the pre-init session touched nothing on disk.
    expect(readdirSync(home)).toEqual([]);
    session.close();
    expect(readdirSync(home)).toEqual([]);
  });
});

/** The freeze itself: §4.7 steps 3 and 5, and §4.6's "one home, one account". */
describe("init freezing the local config", () => {
  function store() {
    const written: LocalConfig[] = [];
    let archived = 0;
    return {
      written,
      archivedCalls: () => archived,
      configStore: {
        write: async (c: LocalConfig) => void written.push(c),
        archiveRuns: async () => void (archived += 1),
      },
    };
  }

  test("refuses to freeze without the twelve typed digits", async () => {
    const backend = new MemoryBackend();
    const s = store();
    const hermetic = testHermetic({ backend, config: null, configStore: s.configStore });
    const code = await codeOf(() =>
      drain(hermetic.init({ create: true, region: "us-west-2", profile: "acme-dev" })),
    );
    expect(code).toBe("CONFIRMATION_REQUIRED");
    expect(s.written).toEqual([]);
  });

  test("freezes on the create branch once the digits match", async () => {
    const backend = new MemoryBackend();
    const s = store();
    const hermetic = testHermetic({ backend, config: null, configStore: s.configStore });
    await drain(
      hermetic.init({
        create: true,
        region: "us-west-2",
        profile: "acme-dev",
        account_id_typed: "123456789012",
        tailnet: "acme.ts.net",
        tailscale_oauth_secret: "tskey-client-FIXTURE",
      }),
    );
    expect(s.written).toHaveLength(1);
    expect(s.written[0]).toMatchObject({
      account_id: "123456789012",
      profile: "acme-dev",
      region: "us-west-2",
      schema_version: 1,
    });
    expect(s.written[0]!.fleet_id).toBe(backend.fleetItem!.fleet_id);

    // The freshly minted id is well-formed, and stamped identically on the
    // stack tag, the `_fleet` item, and the frozen local config.
    const mintedId = s.written[0]!.fleet_id;
    expect(isFleetId(mintedId)).toBe(true);
    expect(backend.stack?.tags["fleet_id"]).toBe(mintedId);
    expect(backend.fleetItem!.fleet_id).toBe(mintedId);

    // Both halves of the OAuth client are recorded: the secret in its slot,
    // the id (parsed from the secret, never asked for) in its own slot and on
    // `_fleet`, where any operator can read which client to rotate or revoke.
    for (const path of [tailscaleOauthSecretPath(mintedId), tailscaleOauthClientIdPath(mintedId)]) {
      expect(await backend.secrets.exists(path), path).toBe(true);
      expect(await backend.secrets.isPlaceholder(path), path).toBe(false);
    }
    expect(backend.fleetItem!.tailscale_oauth_client_id).toBe("FIXTURE");
  });

  /**
   * §5: `init --create` is the one place the `public` default is legitimately
   * applied, and the mode it decided is cached on `_fleet` so no later read has
   * to guess. The stack parameter stays the truth — the same value is on both.
   */
  test("the network mode is stamped on _fleet at create", async () => {
    for (const network of ["public", "nat"] as const) {
      // Each pass is its own empty account: a create into a directory that
      // already holds a fleet is refused without a `--name` (§4.8).
      const backend = new MemoryBackend();
      const s = store();
      const hermetic = testHermetic({ backend, config: null, configStore: s.configStore });
      await drain(
        hermetic.init({
          create: true,
          network,
          region: "us-west-2",
          profile: "acme-dev",
          account_id_typed: "123456789012",
          tailnet: "acme.ts.net",
          tailscale_oauth_secret: "tskey-client-FIXTURE",
        }),
      );
      expect(backend.fleetItem!.network, network).toBe(network);
      expect(backend.stack!.parameters["Network"], network).toBe(network);
    }
  });

  test("omitting --network creates a public fleet, and says so on _fleet", async () => {
    const backend = new MemoryBackend();
    const s = store();
    const hermetic = testHermetic({ backend, config: null, configStore: s.configStore });
    await drain(
      hermetic.init({
        create: true,
        region: "us-west-2",
        profile: "acme-dev",
        account_id_typed: "123456789012",
        tailnet: "acme.ts.net",
        tailscale_oauth_secret: "tskey-client-FIXTURE",
      }),
    );
    expect(backend.fleetItem!.network).toBe("public");
  });

  test("attaching to the same fleet re-freezes without a --reset", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const s = store();
    const hermetic = testHermetic({
      backend,
      config: FIXTURE_CONFIG,
      configStore: s.configStore,
    });
    await drain(hermetic.init({ attach: true, profile: FIXTURE_CONFIG.profile }));
    expect(s.written).toHaveLength(1);
    expect(s.written[0]!.fleet_id).toBe(FIXTURE_CONFIG.fleet_id);
  });

  /** Silently overwriting the frozen row would undo the whole guard (§4.7). */
  test("refuses to re-target a frozen home without --reset --yes", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const s = store();
    const elsewhere: LocalConfig = {
      ...FIXTURE_CONFIG,
      account_id: "999999999999",
      fleet_id: "11111111-1111-4111-8111-111111111111",
    };
    const hermetic = testHermetic({ backend, config: elsewhere, configStore: s.configStore });

    const code = await codeOf(() =>
      drain(hermetic.init({ attach: true, account_id_typed: "123456789012", profile: "acme-dev" })),
    );
    expect(code).toBe("CONFIRMATION_REQUIRED");
    expect(s.written).toEqual([]);
  });

  test("--reset --yes re-targets and archives the run log", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const s = store();
    const elsewhere: LocalConfig = {
      ...FIXTURE_CONFIG,
      account_id: "999999999999",
      fleet_id: "11111111-1111-4111-8111-111111111111",
    };
    const hermetic = testHermetic({ backend, config: elsewhere, configStore: s.configStore });

    await drain(
      hermetic.init({
        attach: true,
        reset: true,
        yes: true,
        account_id_typed: "123456789012",
        profile: "acme-dev",
      }),
    );
    expect(s.archivedCalls()).toBe(1);
    expect(s.written).toHaveLength(1);
    expect(s.written[0]!.account_id).toBe("123456789012");
  });

  /** The identity is re-read through the guarded client immediately before the write. */
  test("credentials that move mid-init freeze nothing", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const s = store();
    const hermetic = testHermetic({
      backend,
      config: null,
      configStore: s.configStore,
      actor: "arn:aws:iam::123456789012:user/e",
    });

    let calls = 0;
    const real = backend.identity.callerIdentity;
    backend.identity.callerIdentity = async () => {
      calls += 1;
      const id = await real();
      return calls === 1 ? id : { ...id, account_id: "999999999999" };
    };

    const code = await codeOf(() =>
      drain(hermetic.init({ attach: true, account_id_typed: "123456789012", profile: "acme-dev" })),
    );
    expect(code).toBe("ACCOUNT_MISMATCH");
    expect(s.written).toEqual([]);
  });

  /**
   * §4.6: attach joins this laptop to a fleet. It is not a rename, and it never
   * has been one an operator asked for by accident: the label belongs to the
   * account's directory and is changed by `hermetic fleet alias` alone.
   */
  test("attach leaves the directory's display alias exactly as it found it", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend({ directory: "seeded" }));
    const s = store();
    const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG, configStore: s.configStore });

    await drain(hermetic.init({ attach: true, profile: FIXTURE_CONFIG.profile }));

    const entries = await backend.directory.list();
    expect(entries.find((e) => e.fleet_id === FIXTURE_CONFIG.fleet_id)!.name).toBe("main");
    // And the local row caches what the directory says, keyed by the fleet id.
    expect(s.written.at(-1)!.name).toBe("main");
    expect(s.written.at(-1)!.fleet_id).toBe(FIXTURE_CONFIG.fleet_id);
  });

  /**
   * §6.1: `_fleet.fleet_name` is legacy cloud-name provenance — the name a v3
   * node's hostname was built from — and nothing about an alias may touch it.
   * Rewriting it would make those nodes look like another fleet's.
   */
  test("attach does not rewrite _fleet.fleet_name", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend({ directory: "seeded" }));
    backend.fleetItem = { ...backend.fleetItem!, fleet_name: "ancient" };
    const s = store();
    const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG, configStore: s.configStore });

    await drain(hermetic.init({ attach: true, profile: FIXTURE_CONFIG.profile }));
    expect(backend.fleetItem!.fleet_name).toBe("ancient");
  });

  /**
   * §4.6: a fleet the directory has never heard of is registered with **no**
   * alias. `init` has no business inventing a label — an aliasless fleet
   * displays as its own id everywhere, which is what the operator typed.
   */
  test("a legacy attach into an empty directory registers the fleet with no alias", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const s = store();
    const hermetic = testHermetic({ backend, config: null, configStore: s.configStore });

    await drain(hermetic.init({ attach: true, account_id_typed: "123456789012", profile: "acme-dev" }));
    const listed = await backend.directory.list();
    expect(listed.map((e) => e.fleet_id)).toEqual([FIXTURE_CONFIG.fleet_id]);
    expect(listed[0]!.name).toBeNull();
    expect(s.written.at(-1)!.name).toBeNull();
    expect(s.written.at(-1)!.fleet_id).toBe(FIXTURE_CONFIG.fleet_id);
  });

  /**
   * The repair path (§4.6). A foundation that is genuinely in this account but
   * missing from the directory — created before the directory existed, or in an
   * account whose table was deleted — is still attachable by the id stamped on
   * its own stack, and the attach registers it. Resolving `--fleet` only
   * through the directory would refuse exactly the fleets that need repairing.
   */
  test("--fleet <id> attaches to a foundation the directory has never heard of", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const s = store();
    const hermetic = testHermetic({ backend, config: null, configStore: s.configStore });

    await drain(
      hermetic.init({
        attach: true,
        fleet: FIXTURE_CONFIG.fleet_id,
        account_id_typed: "123456789012",
        profile: "acme-dev",
      }),
    );
    expect(s.written.at(-1)!.fleet_id).toBe(FIXTURE_CONFIG.fleet_id);
    expect((await backend.directory.list())[0]!.name).toBeNull();
  });

  /**
   * §4.7: a torn-down fleet keeps its alias reserved so the label cannot
   * silently start meaning a different fleet — so it must not *select* one
   * either. `--fleet staging` against a torn-down `staging` is a miss.
   */
  test("--fleet naming a torn-down fleet's alias selects nothing", async () => {
    const account = createFixtureAccount("seeded");
    const stagingId = fixtureConfigFor("staging").fleet_id;
    const staging = account.entries.get(stagingId)!;
    account.entries.set(stagingId, {
      ...staging,
      status: "torn_down",
      torn_down_at: staging.updated_at,
    });

    const backend = seedFixtureFoundation(new MemoryBackend({ account }));
    const s = store();
    const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG, configStore: s.configStore });

    const code = await codeOf(() =>
      drain(hermetic.init({ attach: true, fleet: "staging", profile: FIXTURE_CONFIG.profile })),
    );
    expect(code).toBe("NOT_FOUND");
    expect(s.written).toEqual([]);
  });

  /**
   * `--fleet` is a selector, never a label being minted (§4.6). A token nothing
   * in the account answers to is a refusal rather than a quiet attach to
   * whatever single foundation happens to be live.
   */
  test("--fleet naming nothing in this account is NOT_FOUND, not a silent attach", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend({ directory: "seeded" }));
    const s = store();
    const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG, configStore: s.configStore });

    const code = await codeOf(() =>
      drain(hermetic.init({ attach: true, fleet: "nowhere", profile: FIXTURE_CONFIG.profile })),
    );
    expect(code).toBe("NOT_FOUND");
    expect(s.written).toEqual([]);
  });

  /** §4.6: creating a fleet and labelling it are two commands, and this is the refusal. */
  test("--create --name is refused and names the command that sets an alias", async () => {
    const backend = new MemoryBackend();
    const s = store();
    const hermetic = testHermetic({ backend, config: null, configStore: s.configStore });

    const e = await drain(hermetic.init({ create: true, name: "prod", profile: "acme-dev" })).catch(
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(HermeticError);
    expect((e as HermeticError).code).toBe("VALIDATION");
    expect((e as Error).message).toContain("hermetic fleet alias <fleet-id> <alias>");
  });

  test("with no config store, init freezes nothing and needs no typed digits", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const hermetic = testHermetic({ backend, config: null });
    const events = await drain(hermetic.init({ attach: true }));
    expect(events.at(-1)?.progress).toBe(1);
  });
});

/**
 * The gate must be computed from the *effective* decision, not from the flags.
 * A home whose foundation was torn down still has a frozen config, so `auto`
 * there is a **create** — and deciding that from `mode` alone let the stack, the
 * `_fleet` item, the artifacts and the tailscale secret all be written before
 * `freeze()` refused, leaving an orphan foundation nobody's config pointed at.
 */
/**
 * F4: `DeleteStack` leaves the stack in `DELETE_IN_PROGRESS` for minutes, and a
 * `DELETE_FAILED` one lingers indefinitely. Either way the foundation is not
 * attachable — its VPC, tables and bucket are on their way out — and it is not
 * creatable either, because CloudFormation still owns the one stack name.
 */
describe("a foundation being deleted is neither branch of init", () => {
  function store() {
    const written: LocalConfig[] = [];
    return {
      written,
      configStore: { write: async (c: LocalConfig) => void written.push(c) },
    };
  }

  function deletingFoundation(status: "DELETE_IN_PROGRESS" | "DELETE_FAILED") {
    const backend = seedFixtureFoundation(new MemoryBackend());
    backend.stack = { ...backend.stack!, status };
    backend.resetMutations();
    return backend;
  }

  for (const status of ["DELETE_IN_PROGRESS", "DELETE_FAILED"] as const) {
    test(`auto mode on a ${status} stack is CONFLICT, not an attach`, async () => {
      const backend = deletingFoundation(status);
      const s = store();
      const hermetic = testHermetic({
        backend,
        config: null,
        configStore: s.configStore,
      });

      const code = await codeOf(() =>
        drain(
          hermetic.init({
            account_id_typed: FIXTURE_CONFIG.account_id,
            profile: FIXTURE_CONFIG.profile,
          }),
        ),
      );
      expect(code).toBe("CONFLICT");
      // Neither branch ran: nothing frozen, no stack created, no _fleet written.
      expect(s.written).toEqual([]);
      // §4.8: `directory.ensure` runs before any stack work and is idempotent —
      // it is the only thing a refused `init` touches.
      expect(backend.mutations).toEqual([]);
    });
  }

  test("the error says to wait and retry", async () => {
    const backend = deletingFoundation("DELETE_IN_PROGRESS");
    const hermetic = testHermetic({ backend, config: null, configStore: store().configStore });
    let error: HermeticError | null = null;
    try {
      await drain(
        hermetic.init({
          account_id_typed: FIXTURE_CONFIG.account_id,
          profile: FIXTURE_CONFIG.profile,
        }),
      );
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error!.message).toContain("being deleted; wait and retry");
    expect(error!.details!["stack_status"]).toBe("DELETE_IN_PROGRESS");
  });

  test("--attach refuses too rather than binding to a dying fleet", async () => {
    const backend = deletingFoundation("DELETE_IN_PROGRESS");
    const s = store();
    const hermetic = testHermetic({ backend, config: null, configStore: s.configStore });
    const code = await codeOf(() =>
      drain(
        hermetic.init({
          attach: true,
          account_id_typed: FIXTURE_CONFIG.account_id,
          profile: FIXTURE_CONFIG.profile,
        }),
      ),
    );
    expect(code).toBe("CONFLICT");
    expect(s.written).toEqual([]);
  });

  test("--create refuses too rather than racing CloudFormation for the name", async () => {
    const backend = deletingFoundation("DELETE_FAILED");
    const s = store();
    const hermetic = testHermetic({ backend, config: null, configStore: s.configStore });
    const code = await codeOf(() =>
      drain(
        hermetic.init({
          create: true,
          account_id_typed: FIXTURE_CONFIG.account_id,
          profile: FIXTURE_CONFIG.profile,
          tailnet: "acme.ts.net",
          tailscale_oauth_secret: "tskey-client-FIXTURE",
        }),
      ),
    );
    expect(code).toBe("CONFLICT");
    expect(s.written).toEqual([]);
    expect(backend.mutations).toEqual([]);
  });

  /** A healthy foundation still attaches: the refusal is about these states only. */
  test("a CREATE_COMPLETE stack still attaches", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const s = store();
    const hermetic = testHermetic({ backend, config: null, configStore: s.configStore });
    await drain(
      hermetic.init({
        account_id_typed: FIXTURE_CONFIG.account_id,
        profile: FIXTURE_CONFIG.profile,
      }),
    );
    expect(s.written).toHaveLength(1);
  });
});

describe("the typed-id gate stands before the first mutation", () => {
  function store() {
    const written: LocalConfig[] = [];
    return {
      written,
      configStore: { write: async (c: LocalConfig) => void written.push(c) },
    };
  }

  test("a frozen home with no stack refuses before creating anything", async () => {
    // Post-teardown reality: config still frozen, foundation gone.
    const backend = new MemoryBackend();
    const s = store();
    const hermetic = testHermetic({
      backend,
      config: FIXTURE_CONFIG,
      configStore: s.configStore,
    });

    const code = await codeOf(() =>
      drain(hermetic.init({ region: "us-west-2", profile: FIXTURE_CONFIG.profile })),
    );

    expect(code).toBe("CONFIRMATION_REQUIRED");
    // Nothing was created, pushed or written — the whole point.
    expect(backend.mutations).toEqual([]);
    expect(backend.stack).toBeNull();
    expect(backend.fleetItem).toBeNull();
    expect(backend.params.size).toBe(0);
    expect(backend.objects.size).toBe(0);
    expect(s.written).toEqual([]);
  });

  test("the refusal says the decision was a create", async () => {
    const backend = new MemoryBackend();
    const s = store();
    const hermetic = testHermetic({
      backend,
      config: FIXTURE_CONFIG,
      configStore: s.configStore,
    });
    let error: HermeticError | null = null;
    try {
      await drain(hermetic.init({ profile: FIXTURE_CONFIG.profile }));
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error!.details).toMatchObject({ decision: "create" });
    expect(error!.message).toContain("creates a new foundation");
  });

  test("the same home with the stack present attaches with no typed id", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const s = store();
    const hermetic = testHermetic({
      backend,
      config: FIXTURE_CONFIG,
      configStore: s.configStore,
    });
    const events = await drain(hermetic.init({ profile: FIXTURE_CONFIG.profile }));
    expect(events.some((e) => e.phase === "attach")).toBe(true);
    expect(s.written).toHaveLength(1);
  });

  test("with the digits supplied, the same post-teardown home creates cleanly", async () => {
    const backend = new MemoryBackend();
    const s = store();
    const hermetic = testHermetic({
      backend,
      config: FIXTURE_CONFIG,
      configStore: s.configStore,
    });
    const code = await codeOf(() =>
      drain(
        hermetic.init({
          region: "us-west-2",
          profile: FIXTURE_CONFIG.profile,
          account_id_typed: "123456789012",
          tailnet: "acme.ts.net",
          reset: true,
          yes: true,
        }),
      ),
    );
    expect(code).toBeNull();
    expect(backend.stack).not.toBeNull();
    expect(s.written).toHaveLength(1);
  });

  test("a fresh home still needs the digits even when attaching", async () => {
    const backend = seedFixtureFoundation(new MemoryBackend());
    const s = store();
    const hermetic = testHermetic({ backend, config: null, configStore: s.configStore });
    expect(await codeOf(() => drain(hermetic.init({ attach: true, profile: "acme-dev" })))).toBe(
      "CONFIRMATION_REQUIRED",
    );
    expect(backend.mutations).toEqual([]);
  });

  /**
   * §4.8 sits under the same rule as everything else `init` does: creating the
   * account's directory table is a mutation, so it happens on the far side of
   * the gate. A refused `init` may *look* at the directory — that is how it can
   * say what the account already holds — and may not make one.
   */
  test("a refused init reads the directory and does not create it", async () => {
    const backend = new MemoryBackend();
    const s = store();
    const hermetic = testHermetic({
      backend,
      config: FIXTURE_CONFIG,
      configStore: s.configStore,
    });

    const events: string[] = [];
    const code = await codeOf(async () => {
      for await (const e of hermetic.init({ region: "us-west-2", profile: FIXTURE_CONFIG.profile })) {
        if (e.phase === "directory") events.push(e.message);
      }
    });

    expect(code).toBe("CONFIRMATION_REQUIRED");
    // The look happened and is reported; the making did not.
    expect(events).toHaveLength(1);
    expect(events[0]).toContain("fleet directory");
    expect(backend.mutations).not.toContain("directory.ensure");
    expect(backend.mutations).toEqual([]);
  });

  test("with the digits typed, the directory is ensured before the stack is created", async () => {
    const backend = new MemoryBackend();
    const s = store();
    const hermetic = testHermetic({
      backend,
      config: FIXTURE_CONFIG,
      configStore: s.configStore,
    });
    const code = await codeOf(() =>
      drain(
        hermetic.init({
          region: "us-west-2",
          profile: FIXTURE_CONFIG.profile,
          account_id_typed: "123456789012",
          tailnet: "acme.ts.net",
          reset: true,
          yes: true,
        }),
      ),
    );
    expect(code).toBeNull();

    // Order, not just presence: a fleet that could not be registered is a fleet
    // that should not have been created, so the table comes first.
    const ensured = backend.mutations.indexOf("directory.ensure");
    const created = backend.mutations.indexOf("foundation.createStack");
    const registered = backend.mutations.indexOf("directory.register");
    expect(ensured).toBeGreaterThanOrEqual(0);
    expect(ensured).toBeLessThan(created);
    // …and the entry itself is written after the stack it describes exists.
    expect(registered).toBeGreaterThan(created);
  });
});

/**
 * The bug: `bind()` in `open.ts` used to construct the real-mode instance with
 * `config: null`, so `existingConfig` inside `init()` was always null and the
 * `retargets` check in `freeze()` never fired on the path both the CLI and the
 * server actually use — a home already frozen to one account would silently
 * re-freeze to another. This exercises that exact path: `openForInit` (real
 * mode) → `bind()` → `init`, against a mocked AWS SDK.
 */
describe("the retarget guard on the real bind() path", () => {
  const testProfile = installTestProfile();
  afterAll(() => testProfile.restore());

  const sts = mockClient(STSClient);
  const cfn = mockClient(CloudFormationClient);
  const ddb = mockClient(DynamoDBDocumentClient);
  /**
   * §4.8: the account-global directory table, which `init` reads before it does
   * anything else. It is a plain `DynamoDBClient` in a second region, so it
   * needs its own mock — without one these tests would reach the network, which
   * §11 forbids.
   */
  const dynamo = mockClient(DynamoDBClient);
  const s3 = mockClient(S3Client);
  const iam = mockClient(IAMClient);
  const orgs = mockClient(OrganizationsClient);

  const OLD_ACCOUNT = "999999999999";
  const NEW_ACCOUNT = "123456789012";
  const OLD_FLEET = "0dxxxxx1";
  const NEW_FLEET = "newxxxx2";
  const STACK_ID = "arn:aws:cloudformation:us-west-2:123456789012:stack/hermetic/abc";
  const ARN = "arn:aws:iam::123456789012:user/e";

  const elsewhere: LocalConfig = {
    schema_version: 1,
    name: OLD_FLEET,
    fleet_id: OLD_FLEET,
    account_id: OLD_ACCOUNT,
    account_alias: null,
    org_id: null,
    profile: TEST_PROFILE,
    region: "us-west-2",
    frozen_at: "2026-01-01T00:00:00.000Z",
    frozen_by: "arn:aws:iam::999999999999:user/old",
  };

  beforeEach(() => {
    sts.reset();
    cfn.reset();
    ddb.reset();
    s3.reset();
    iam.reset();
    orgs.reset();

    sts.on(GetCallerIdentityCommand).resolves({ Account: NEW_ACCOUNT, Arn: ARN });
    iam.on(ListAccountAliasesCommand).resolves({ AccountAliases: [] });
    orgs.on(DescribeOrganizationCommand).rejects(new Error("AccessDeniedException"));
    cfn.on(DescribeStacksCommand).resolves({
      Stacks: [
        {
          StackId: STACK_ID,
          StackName: "hermetic",
          StackStatus: "CREATE_COMPLETE",
          CreationTime: new Date("2026-01-01T00:00:00.000Z"),
          Tags: [{ Key: FLEET_ID_TAG, Value: NEW_FLEET }],
          Outputs: [
            { OutputKey: "BucketName", OutputValue: "hermetic-123456789012-us-west-2" },
            { OutputKey: "AgentsTable", OutputValue: "hermetic-agents" },
            { OutputKey: "EventsTable", OutputValue: "hermetic-events" },
            { OutputKey: "VpcId", OutputValue: "vpc-abc" },
            { OutputKey: "SubnetIds", OutputValue: "subnet-aaa,subnet-bbb" },
            { OutputKey: "SecurityGroupId", OutputValue: "sg-sealed" },
            {
              OutputKey: "InstanceProfileArn",
              OutputValue: `arn:aws:iam::123456789012:instance-profile/hermetic-agent`,
            },
            { OutputKey: "RoleArn", OutputValue: "arn:aws:iam::123456789012:role/hermetic-agent" },
          ],
        },
      ],
    });
    ddb.on(GetCommand).resolves({
      Item: {
        name: "_fleet",
        fleet_id: NEW_FLEET,
        defaults: {
          size: "medium",
          provider: "bedrock",
          volume_gib: 100,
          secrets: "none",
        },
        ubuntu_release: "24.04",
        ami_id: "ami-0123456789abcdef0",
        min_hermetic_version: "0.4.1",
        tailnet: "acme.ts.net",
        region: "us-west-2",
        bucket: "hermetic-123456789012-us-west-2",
        stack_id: STACK_ID,
        created_by: ARN,
        created_at: "2026-01-01T00:00:00.000Z",
      },
    });
    /**
     * A bucket that holds whatever this run has already put in it, and nothing
     * else. `pushRelease` confirms every object of a release generation is
     * really there before the fleet manifest is allowed to name it, so a HEAD
     * that always says "not found" would make every push in this file fail —
     * and a HEAD that always said "found" would make that check untestable.
     */
    const put = new Set<string>();
    s3.on(PutObjectCommand).callsFake((input: { Key?: string }) => {
      if (typeof input.Key === "string") put.add(input.Key);
      return {};
    });
    s3.on(HeadObjectCommand).callsFake((input: { Key?: string }) => {
      if (typeof input.Key === "string" && put.has(input.Key)) return {};
      throw Object.assign(new Error("not found"), { name: "NotFound" });
    });
    // No fleet manifest yet: `init` will publish one, and the mock swallows it.
    s3.on(GetObjectCommand).rejects(Object.assign(new Error("no such key"), { name: "NoSuchKey" }));
    dynamo.reset();
    dynamo.on(DescribeTableCommand).resolves({
      Table: {
        TableName: "hermetic-directory",
        TableStatus: "ACTIVE",
        ItemCount: 0,
        BillingModeSummary: { BillingMode: "PAY_PER_REQUEST" },
        DeletionProtectionEnabled: true,
      },
    });
    dynamo.on(DescribeContinuousBackupsCommand).resolves({
      ContinuousBackupsDescription: {
        ContinuousBackupsStatus: "ENABLED",
        PointInTimeRecoveryDescription: {
          PointInTimeRecoveryStatus: "ENABLED",
          RecoveryPeriodInDays: 7,
        },
      },
    });
    // An account whose directory is there and empty: this fleet is registered
    // by the attach itself.
    ddb.on(ScanCommand).resolves({ Items: [] });
  });

  // Each of these runs a real init session end to end over mocked AWS. That
  // takes one to two seconds on CI, close enough to bun's 5s default that a
  // loaded runner times it out, so they get the same 30s the app suites use.
  test("without --reset --yes, a retarget through a real session is refused and writes nothing", async () => {
    const home = mkdtempSync(join(SCRATCH, "hermetic-retarget-"));
    try {
      const local = openLocalDb({ home });
      writeConfig(local.db, elsewhere);
      local.close();

      const session = await openForInit({
        // The real reader runs `git` in this repository; no test may depend on
        // whether its author has uncommitted work (§3.6).
        git: () => null,
        home,
        preflight: { localTailscale: OK_TAILSCALE },
        hermesMirror: OFFLINE_HERMES_MIRROR,
        browserMirror: OFFLINE_BROWSER_MIRROR,
      });
      expect(session.existingConfig).toEqual(elsewhere);

      const bound = session.bind({
        profile: TEST_PROFILE,
        region: "us-west-2",
        accountId: NEW_ACCOUNT,
      });
      const code = await codeOf(() =>
        drain(bound.init({ attach: true, profile: TEST_PROFILE, account_id_typed: NEW_ACCOUNT })),
      );
      expect(code).toBe("CONFIRMATION_REQUIRED");
      session.close();

      const reopened = openLocalDb({ home });
      // Zero mutations: the frozen row is exactly what it was before.
      expect(readConfig(reopened.db)).toEqual(elsewhere);
      reopened.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test("--reset --yes re-targets the real home and archives the run log", async () => {
    const home = mkdtempSync(join(SCRATCH, "hermetic-retarget-"));
    try {
      const local = openLocalDb({ home });
      writeConfig(local.db, elsewhere);
      recordRun(local.db, { command: "agents ps" });
      local.close();

      const session = await openForInit({
        // The real reader runs `git` in this repository; no test may depend on
        // whether its author has uncommitted work (§3.6).
        git: () => null,
        home,
        preflight: { localTailscale: OK_TAILSCALE },
        hermesMirror: OFFLINE_HERMES_MIRROR,
        browserMirror: OFFLINE_BROWSER_MIRROR,
      });
      const bound = session.bind({
        profile: TEST_PROFILE,
        region: "us-west-2",
        accountId: NEW_ACCOUNT,
      });
      await drain(
        bound.init({
          attach: true,
          reset: true,
          yes: true,
          profile: TEST_PROFILE,
          account_id_typed: NEW_ACCOUNT,
        }),
      );
      session.close();

      const reopened = openLocalDb({ home });
      const config = readConfig(reopened.db);
      expect(config?.account_id).toBe(NEW_ACCOUNT);
      expect(config?.fleet_id).toBe(NEW_FLEET);
      const archived = (
        reopened.db.query(`SELECT COUNT(*) AS n FROM runs_archive`).get() as { n: number }
      ).n;
      expect(archived).toBe(1);
      reopened.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  /**
   * The other half of the laziness fix: a from-scratch home stays untouched
   * right up until `init` actually writes a config, at which point
   * `hermetic.db` exists exactly as it would from the eager path.
   */
  test("an uninitialized home gains hermetic.db only once init completes", async () => {
    const home = mkdtempSync(join(SCRATCH, "hermetic-retarget-"));
    try {
      expect(readdirSync(home)).toEqual([]);

      const session = await openForInit({
        // The real reader runs `git` in this repository; no test may depend on
        // whether its author has uncommitted work (§3.6).
        git: () => null,
        home,
        preflight: { localTailscale: OK_TAILSCALE },
        hermesMirror: OFFLINE_HERMES_MIRROR,
        browserMirror: OFFLINE_BROWSER_MIRROR,
      });
      expect(session.existingConfig).toBeNull();
      expect(readdirSync(home)).toEqual([]);

      const bound = session.bind({
        profile: TEST_PROFILE,
        region: "us-west-2",
        accountId: NEW_ACCOUNT,
      });
      await drain(bound.init({ attach: true, profile: TEST_PROFILE, account_id_typed: NEW_ACCOUNT }));
      session.close();

      expect(existsSync(join(home, "hermetic.db"))).toBe(true);
      const reopened = openLocalDb({ home });
      expect(readConfig(reopened.db)?.account_id).toBe(NEW_ACCOUNT);
      reopened.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * §4.8: an account may hold several fleets, and `init` is where the second one
 * comes from. This used to be impossible — `describeStack` on a backend with no
 * fleet id falls back to "the single live hermetic stack", so a second
 * `--create` found the *first* fleet's stack and refused with CONFLICT.
 */
describe("a second fleet in the same account", () => {
  /** A local `fleets` table, in memory: what the real one does, without a file. */
  function homeStore() {
    const rows: LocalConfig[] = [];
    let deflt: string | null = null;
    return {
      rows,
      get default(): string | null {
        return deflt;
      },
      store: {
        // Keyed by `fleet_id`, exactly as SQLite is since §4.6: the alias is a
        // cached label on the row and never its key.
        write: async (config: LocalConfig): Promise<void> => {
          const at = rows.findIndex((r) => r.fleet_id === config.fleet_id);
          if (at === -1) rows.push(config);
          else rows[at] = config;
        },
        read: async (fleetId?: string): Promise<LocalConfig | null> =>
          rows.find((r) => r.fleet_id === (fleetId ?? deflt)) ?? null,
        list: async (): Promise<LocalConfig[]> => [...rows],
        defaultFleet: async (): Promise<string | null> => deflt,
        setDefaultFleet: async (fleetId: string | null): Promise<void> => {
          deflt = fleetId;
        },
      },
    };
  }

  const CREATE = {
    region: "us-west-2",
    profile: "acme-dev",
    tailnet: "acme.ts.net",
    account_id_typed: "123456789012",
  } as const;

  async function twoFleets() {
    const backend = new MemoryBackend();
    const home = homeStore();
    const first = testHermetic({ backend, config: null, configStore: home.store });
    await drain(first.init({ ...CREATE, create: true }));

    const second = testHermetic({
      backend,
      config: home.rows[0] ?? null,
      configStore: home.store,
    });
    await drain(second.init({ ...CREATE, create: true }));
    return { backend, home };
  }

  /**
   * §4.6: a create mints an id and no label. Two unlabelled fleets in one
   * account is therefore the *normal* state, not an edge case — which is the
   * whole reason identity moved off the name.
   */
  test("`init --create` twice builds two distinct, unlabelled fleets", async () => {
    const { backend, home } = await twoFleets();

    expect(home.rows.map((r) => r.name)).toEqual([null, null]);
    const [main, second] = home.rows;
    expect(main!.fleet_id).not.toBe(second!.fleet_id);
    expect(isFleetId(second!.fleet_id)).toBe(true);
    // Both in the same account: §4.6 is untouched by §4.8.
    expect(second!.account_id).toBe(main!.account_id);

    // Both are in the account's directory, and the account has two stacks.
    const registered = await backend.directory.list();
    expect(registered.every((e) => e.name === null)).toBe(true);
    expect(registered.map((e) => e.fleet_id).sort()).toEqual([main!.fleet_id, second!.fleet_id].sort());
    const stacks = await backend.foundation.listStacks();
    expect(stacks.map((s) => s.fleet_id).sort()).toEqual([main!.fleet_id, second!.fleet_id].sort());

    // The default is still the first fleet, by id: adding one does not
    // re-point every bare command at it. That is `hermetic fleet use`.
    expect(home.default).toBe(main!.fleet_id);
  });

  test("`init --attach --fleet <id>` binds that stack, not whichever was live", async () => {
    const { backend, home } = await twoFleets();
    const mainId = home.rows[0]!.fleet_id;
    // The backend is standing in front of the second fleet — the one just created.
    expect((await backend.foundation.describeStack())!.tags["fleet_id"]).not.toBe(mainId);

    const fresh = homeStore();
    const hermetic = testHermetic({ backend, config: null, configStore: fresh.store });
    const events = await drain(hermetic.init({ ...CREATE, attach: true, fleet: mainId }));

    expect(events.some((e) => e.phase === "attach")).toBe(true);
    expect(fresh.rows).toHaveLength(1);
    expect(fresh.rows[0]!.fleet_id).toBe(mainId);
    // The backend really moved: later reads are about the first fleet.
    expect((await backend.foundation.describeStack())!.tags["fleet_id"]).toBe(mainId);
  });

  /** And the alias addresses it too, once one has been assigned (§4.6). */
  test("`init --attach --fleet <alias>` binds the fleet that alias belongs to", async () => {
    const { backend, home } = await twoFleets();
    const mainId = home.rows[0]!.fleet_id;
    const labeller = testHermetic({ backend, config: home.rows[0]!, configStore: home.store });
    await labeller.fleets.alias({ fleet: mainId, alias: "prod" });

    const fresh = homeStore();
    const hermetic = testHermetic({ backend, config: null, configStore: fresh.store });
    await drain(hermetic.init({ ...CREATE, attach: true, fleet: "prod" }));

    expect(fresh.rows[0]!.fleet_id).toBe(mainId);
    // Attach never relabels: the alias is still `prod`, and the row caches it.
    expect(fresh.rows[0]!.name).toBe("prod");
  });

  test("`init --attach` with two fleets and no --fleet refuses rather than guessing", async () => {
    const { backend } = await twoFleets();
    const fresh = homeStore();
    const hermetic = testHermetic({ backend, config: null, configStore: fresh.store });

    let error: HermeticError | null = null;
    try {
      await drain(hermetic.init({ ...CREATE, attach: true }));
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error?.code).toBe("CONFLICT");
    expect(error?.message).toContain("several fleets here");
    expect(fresh.rows).toEqual([]);
  });

  /**
   * §4.7: an alias is unique across the account, and the reservation is a
   * conditional write rather than a convention — so the second fleet to ask
   * for a label is refused and keeps the one it had.
   */
  test("an alias another fleet already holds is NAME_TAKEN", async () => {
    const { backend, home } = await twoFleets();
    const hermetic = testHermetic({ backend, config: home.rows[0]!, configStore: home.store });
    await hermetic.fleets.alias({ fleet: home.rows[0]!.fleet_id, alias: "prod" });

    const other = testHermetic({ backend, config: home.rows[1]!, configStore: home.store });
    let error: HermeticError | null = null;
    try {
      await other.fleets.alias({ fleet: home.rows[1]!.fleet_id, alias: "prod" });
    } catch (e) {
      error = e as HermeticError;
    }
    expect(error?.code).toBe("NAME_TAKEN");
    const listed = await backend.directory.list();
    expect(listed.filter((e) => e.name === "prod").map((e) => e.fleet_id)).toEqual([
      home.rows[0]!.fleet_id,
    ]);
  });
});
