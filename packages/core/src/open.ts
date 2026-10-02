import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import {
  FIXTURE_BUILD_NUMBER,
  FIXTURE_LOCAL_BUILD,
  FIXTURE_COMMIT,
  FIXTURE_CONFIG,
  FIXTURE_FLEETS,
  FIXTURE_TAILNET,
  FIXTURE_UNSAFE_CHANGES,
  MemoryBackend,
  createFixtureAccount,
  fixtureBackend,
  fixtureConfigFor,
  resetFixtureAccount,
  seedFixtureAgents,
  seedFixtureFleet,
  type FixtureAccount,
} from "./backend/memory.ts";
import { seedFixtureNotifications } from "./backend/fixture/fixture-notifications.ts";
import type { Backend, ComputeApi, DirectoryApi } from "./backend/types.ts";
import { localBuild, resolveHermeticd, type HermeticdCandidate } from "./release/artifacts.ts";
import { HANDOFF_WATCH_MS } from "./agents/handoff.ts";
import { HEARTBEAT_INTERVAL_MS, UNREACHABLE_INTERVALS } from "./agents/state.ts";
import { join } from "node:path";
import { HermeticError } from "./errors.ts";
import { fixtureBedrockCatalog, fixtureModelFetch } from "./profiles/model-catalog.ts";
import {
  createHermetic,
  type ConfigStore,
  type TeardownStore,
  type Hermetic,
  type HermeticDeps,
  type InitSupport,
  BUILD_VERSIONS,
} from "./hermetic.ts";
import type { HermesMirrorFn } from "./release/hermes-mirror.ts";
import type { BrowserMirrorFn } from "./release/browser-mirror.ts";
import { createAwsBackend } from "./aws/index.ts";
import { resolveIdentity } from "./aws/identity.ts";
import { describeFoundation } from "./aws/probe.ts";
import { detectEnvCredentialOverrides } from "./aws/env.ts";
import {
  SqliteRunStore,
  SqliteTeardownStore,
  archiveRuns,
  clearConfig,
  dbPath,
  defaultFleet,
  directoryRegion,
  hermeticHome,
  listConfigs,
  openLocalDb,
  openMemoryDb,
  openTeardownStore,
  openRunStore,
  SqliteChatFenceStore,
  SqliteLocalChatSessions,
  SqliteInstanceListeningStore,
  SqliteNotificationStore,
  SqlitePresetStore,
  readConfig,
  setDefaultFleet,
  setDirectoryRegion,
  writeConfig,
  type LocalDb,
} from "./local/db/index.ts";
import { resolveFleetId } from "./fleet/fleet-select.ts";
import { DEFAULT_DIRECTORY_REGION } from "./schema/directory.ts";
import { listAwsProfiles } from "./local/profiles.ts";
import { NO_FOUNDATION } from "./schema/index.ts";
import type { TeardownsListInput } from "./schema/index.ts";
import type {
  AwsProfileInfo,
  FoundationSummary,
  LocalConfig,
  ResolvedIdentity,
} from "./schema/index.ts";

/**
 * How long a real-mode `foundation.update` waits for every agent that was up to
 * report the new hermeticd (§6.6 step 6). Long enough for a box to notice its
 * row on the next heartbeat and swap the binary; a straggler past it is a
 * warning, never a failure, because the nightly check picks it up anyway.
 */
export const FOUNDATION_ROLLOUT_WAIT_MS = 10 * 60_000;

/**
 * The fixture's knobs (§3.5). Core reads no environment for any of these: a
 * head reads its fixture variables once, at its edge, and passes what it
 * found. Every one defaults to the fixture the suite runs against —
 * instant, up to date, safe, a fresh populated account.
 */
export interface FixtureOptions {
  /**
   * The fake account the session stands in (§4.8). A portal passes one so a
   * backend rebuilt per fleet switch keeps the same fleet list; absent, each
   * open gets a fresh populated account of its own.
   */
  account?: FixtureAccount | undefined;
  /**
   * Seed the fleet a foundation update has something to do to — no
   * `foundation_version`, an older release, pre-v3 names and paths.
   */
  outdated?: boolean | undefined;
  /** Stretch the fixture's `createStack` over this many ms, with resource events. */
  slowStackMs?: number | undefined;
  /** Milliseconds between streamed chat frames. */
  chatDelayMs?: number | undefined;
  /** Chat frames to hand over before the turn "loses its socket"; 0 never does. */
  chatCutAfter?: number | undefined;
  /** Make the fixture's change set replace the agents table, so `FOUNDATION_UNSAFE` fires. */
  foundationUnsafe?: boolean | undefined;
}

export interface OpenOptions {
  /** In-memory seeded fleet, no AWS. `HERMETIC_FIXTURE=1` or `--fixture`. */
  fixture?: boolean;
  /** Fixture knobs; read only when `fixture` is true. */
  fixtureOptions?: FixtureOptions | undefined;
  /**
   * Which frozen fleet to open (§4.8): `--fleet <name>`, or the portal's active
   * fleet. Absent, the selection rule decides — `HERMETIC_FLEET`, then the
   * recorded default, then the only fleet there is, then `FLEET_REQUIRED`.
   */
  fleet?: string | undefined;
  /**
   * Where the account-global directory table lives. Absent, the chain is
   * `HERMETIC_DIRECTORY_REGION`, then what `init` persisted, then `us-east-1`.
   */
  directoryRegion?: string | undefined;
  /**
   * Overrides the §4.7 Tailscale preflight — only tests should pass this, for
   * the same reason `HermeticDeps.actor` exists: the real probe spawns a binary
   * and reaches api.tailscale.com, and a suite that walks `init` must do
   * neither. Production leaves it unset and gets the real probes.
   */
  preflight?: Pick<HermeticDeps, "localTailscale" | "verifyTailscaleOauth">;
  /**
   * Overrides the §3.6 clean-tree reading, on the same terms as `preflight`
   * above and for the same reason: the real one runs `git` in whatever checkout
   * this process was started from, which a test must never depend on. Real mode
   * takes the real reader unless this says otherwise; fixture mode never reads
   * a checkout at all.
   */
  git?: HermeticDeps["git"];
  /**
   * Overrides §3.6's Hermes mirror — again, only tests should pass this, and
   * for the same reason: the real mirror spawns `git` and clones github.com,
   * and a suite that walks a real-mode `init` must do neither (§11). Production
   * leaves it unset and gets the real mirror.
   */
  hermesMirror?: HermesMirrorFn;
  /**
   * Overrides §7.3's browser mirror, for the same reason: the real one downloads
   * ~190 MB of Chrome for Testing from cdn.playwright.dev, which no suite may do
   * (§11). Production leaves it unset and gets the real mirror.
   */
  browserMirror?: BrowserMirrorFn;
  /** Overrides `HERMETIC_HOME` (default `~/.hermetic`). */
  home?: string;
  /** Path of the compiled `hermeticd` this build ships (§3.6). */
  hermeticdPath?: string | undefined;
  hermeticdVersion?: string | undefined;
}

/**
 * Fixture mode must not spawn a `tailscale` binary or reach api.tailscale.com
 * any more than it may construct an AWS client: `--fixture` is for UI work and
 * demos on a laptop that may have neither. So the §4.7 preflight is canned —
 * a healthy machine on the fixture fleet's own tailnet, and an OAuth client
 * that mints — and the wizard walks its create branch offline.
 */
/**
 * §6.6's advisory upstream-Hermes check, canned. Fixture mode may not reach
 * api.github.com any more than it may reach AWS or api.tailscale.com, and the
 * interesting state to develop against is the one with something to say — so
 * the fixture upstream is always one release ahead of what this build pins.
 *
 * A *tag*, not a version: Hermes Agent's releases are tagged by date
 * (`v2026.8.31`) while its `pyproject` carries a semver, and the check compares
 * tag to tag (`schema/foundation.ts`). A fixture that answered `v0.22.0` would
 * be answering in a vocabulary upstream does not use.
 *
 * Derived from the pin rather than written down beside it: a literal here is
 * only "ahead" until the next `hermes_ref` bump moves the pin past it, and the
 * failure that produces is a fixture that silently says "up to date" for the
 * one state this canned answer exists to show.
 */
function fixtureLatestHermesTag(pinned: string): string {
  const [y, m, d] = pinned.replace(/^v/, "").split(".").map(Number);
  if (!y || !m || !d) return pinned;
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return `v${next.getUTCFullYear()}.${next.getUTCMonth() + 1}.${next.getUTCDate()}`;
}

const FIXTURE_HERMES_FETCH: NonNullable<
  NonNullable<HermeticDeps["foundation"]>["hermesFetch"]
> = async () => Response.json({ tag_name: fixtureLatestHermesTag(BUILD_VERSIONS.hermes_ref) });

const FIXTURE_PREFLIGHT: Pick<HermeticDeps, "localTailscale" | "verifyTailscaleOauth"> = {
  localTailscale: async () => ({
    ok: true,
    installed: true,
    running: true,
    backend_state: "Running",
    tailnet: FIXTURE_TAILNET,
    // HTTPS Certificates on: the fixture tailnet serves, like a real one must.
    cert_domains: [`fixture-laptop.${FIXTURE_TAILNET}`],
    hostname: "fixture-laptop",
    addresses: ["100.64.0.1"],
    binary: "tailscale",
    problem: null,
  }),
  verifyTailscaleOauth: async () => ({
    ok: true,
    authenticated: true,
    can_mint: true,
    // The fixture client carries both scopes, like one created today: a fixture
    // that quietly lacked `devices:core` would make the wizard's yellow note the
    // default thing anyone developing against it ever sees.
    can_list_devices: true,
    // And `policy_file`, so `--fixture` walks the path where hermetic manages
    // its own entries in the tailnet policy (§4.7) rather than the one where it
    // prints a snippet and hopes.
    policy_scope: "write",
    revoked: true,
    problem: null,
  }),
};

/**
 * The same rule for `agents.probe`'s dashboard layer (§9): fixture mode may no
 * more open a socket to `https://<name>.<tailnet>/` than it may construct an
 * AWS client. So the laptop-side fetch is canned against the fixture backend,
 * and canned to agree with its own `/healthz` fake — an agent whose heartbeat
 * is fresh serves, and the one whose heartbeat is twenty minutes stale
 * (`lumen`) does not. That agreement is the point: a fixture where every layer
 * always passed would make `agent probe` look like a command that only ever
 * says "fine", which is the opposite of what it is for.
 */
function fixtureProbe(backend: MemoryBackend): NonNullable<HermeticDeps["probe"]> {
  return {
    fetch: async (input: string): Promise<Response> => {
      /**
       * `https://<fleet id>-<agent>.<tailnet>/` — the first host label is the
       * agent's *cloud* name since v4 (`cloudName`), and the row is keyed by
       * the agent name, so the fleet prefix comes off before the lookup.
       */
      const label = new URL(input).hostname.split(".")[0] ?? "";
      const fleetId = backend.fleetItem?.fleet_id;
      const name = fleetId && label.startsWith(`${fleetId}-`) ? label.slice(fleetId.length + 1) : label;
      const heartbeat = backend.agents.get(name)?.last_heartbeat;
      const stale =
        !heartbeat ||
        backend.now().getTime() - Date.parse(heartbeat) > HEARTBEAT_INTERVAL_MS * UNREACHABLE_INTERVALS;
      if (stale) {
        throw new TypeError(`Unable to connect. Is the computer able to access ${input}?`);
      }
      return new Response("", { status: 200 });
    },
  };
}

/**
 * §3.6: real mode finds `hermeticd` itself (env, sibling binary, or a source
 * build) so `init` and `artifacts push` never depend on an operator locating
 * `dist/hermeticd`. Fixture mode never calls this.
 */
function hermeticdResolver(opts: OpenOptions): () => Promise<HermeticdCandidate | null> {
  const version = opts.hermeticdVersion ?? BUILD_VERSIONS.hermeticd;
  return () => resolveHermeticd({ version });
}

/**
 * The same three places, asked only *which build* they hold — never asked to
 * make one. `create` and `rerun` call this on every run to compare against the
 * build the fleet's release was pushed from (§3.6), so it must cost a few file
 * reads and nothing more. Fixture mode never calls it.
 */
function localBuildResolver(opts: OpenOptions): () => string | null {
  const version = opts.hermeticdVersion ?? BUILD_VERSIONS.hermeticd;
  return () => localBuild({ version });
}

/**
 * The one entrypoint every head uses to obtain a configured core instance.
 * Heads never construct backends themselves.
 */
export async function openHermetic(opts: OpenOptions = {}): Promise<Hermetic> {
  const fixture = opts.fixture ?? process.env["HERMETIC_FIXTURE"] === "1";
  if (fixture) {
    /**
     * The fleet is fake; the *local* database is not — but it must not be the
     * real one either. `runs`, `pending_ops` and now the `fleets` table all
     * record what *this laptop* did (§4.6), so a fixture session gets its own
     * `hermetic-fixture.db`: otherwise `hermetic runs --fixture` would list
     * rows from every fixture session ever run, mixed into the log a real
     * session relies on — and `fleet use --fixture` would rewrite the default
     * of a real home. It is still a real file (not `:memory:`) so the switch
     * survives a restart, exactly as it does in real mode.
     */
    const local = openFixtureLocalDb(opts.home);
    seedFixtureFleets(local);
    const fleetId = fixtureFleetId(local, opts);
    const knobs = opts.fixtureOptions ?? {};
    const { backend, config } = fixtureBackend({
      fleet: fleetId,
      account: knobs.account,
      outdated: knobs.outdated,
    });
    backend.slowStackMs = knobs.slowStackMs ?? 0;
    if (knobs.foundationUnsafe === true) backend.changeSetChanges = [...FIXTURE_UNSAFE_CHANGES];
    const { runs } = openRunStore(opts.home, { fixture: true });
    const { teardowns } = openTeardownStore(opts.home, { fixture: true });
    /**
     * The inbox is this laptop's, not the fleet's (§4.9), so it lives
     * in the same fixture database everything else local does — never the real
     * `hermetic.db`. Seeded on the first open only, so an `ack` in the portal
     * survives the next `bun run dev:fixture`.
     */
    const notifications = new SqliteNotificationStore(local.db);
    seedFixtureNotifications(notifications, fleetId);
    // `fixture` is explicit, never inferred from the backend's type: core
    // defaults it to false, so omitting it here would push a stand-in binary.
    return createHermetic({
      fixture: true,
      fixtureChat: { delayMs: knobs.chatDelayMs, cutAfter: knobs.chatCutAfter },
      backend,
      config,
      runs,
      teardowns,
      notifications,
      // Fixture mode gets a real local record, in the fixture database: a
      // session the operator sends into from `bun run dev:fixture` should stop
      // warning there too, and it is the same code path either way.
      localSessions: new SqliteLocalChatSessions(local.db),
      chatFence: new SqliteChatFenceStore(local.db),
      instanceListening: new SqliteInstanceListeningStore(local.db),
      // §4.6's create presets: a laptop preference, so the fixture database's.
      presets: new SqlitePresetStore(local.db),
      configStore: configStoreFor(local),
      ...FIXTURE_PREFLIGHT,
      /**
       * Canned, like the preflight above and the Hermes mirror beside it.
       *
       * Fixture mode was reading the *real* checkout here, so the update
       * drawer's release line carried whoever's actual `rev-list --count` and
       * commit sha: two developers running the same fixture saw different
       * numbers, and what the comparison demonstrated depended on how many
       * commits they happened to have. Fixture mode does not depend on the
       * machine it runs on — that is the whole point of it.
       *
       * `dirty: false` because §3.6's clean-tree refusal must never fire here:
       * `bun run dev:fixture` on a working tree is the single most common thing
       * anyone does in this repository, and it publishes stand-in bytes to an
       * in-memory bucket that nobody will ever need to rebuild.
       */
      git: () => ({
        build_number: FIXTURE_BUILD_NUMBER,
        commit: FIXTURE_COMMIT,
        dirty: false,
      }),
      // Canned for the same reason, and deliberately unequal to the fingerprint
      // the fixture fleet published: the drawer then opens on "the binary
      // changed", which is the state the whole line was built to show.
      localBuild: () => FIXTURE_LOCAL_BUILD,
      foundation: { hermesFetch: FIXTURE_HERMES_FETCH },
      /**
       * §8.3's model discovery, canned like the Hermes mirror above it. Fixture
       * mode may not open a socket and may not construct an AWS client, so both
       * halves are supplied: a `fetch` that answers each provider's endpoint
       * with that provider's own wire shape, and a Bedrock catalog that reaches
       * no region. The real parsers still run over both.
       */
      modelCatalog: { fetch: fixtureModelFetch, bedrock: fixtureBedrockCatalog },
      probe: fixtureProbe(backend),
    });
  }

  const local = openLocalDb({ home: opts.home });
  const frozen = listConfigs(local.db);
  if (frozen.length === 0) {
    // §4.6: hermetic refuses to run without a frozen fleet row. Deleting the
    // file, or a file that would not open, both land here and both are fixed
    // by `init`.
    local.close();
    throw new HermeticError(
      "NOT_INITIALIZED",
      `this hermetic home has no frozen config; run \`hermetic init\``,
      { home: local.home, ...(local.corruptedTo ? { corrupted_to: local.corruptedTo } : {}) },
    );
  }
  /**
   * §4.8: *which* of them. The rule is one chain and it lives in one pure
   * module, so the portal, the CLI and this all refuse in the same words —
   * and the refusal happens before an AWS client is built, because a
   * `FLEET_REQUIRED` that first resolved credentials would be a refusal that
   * took two seconds and touched an account.
   */
  const fleetId = resolveFleetId({
    explicit: opts.fleet,
    env: process.env["HERMETIC_FLEET"] ?? null,
    defaultFleet: defaultFleet(local.db),
    fleets: frozen.map((c) => ({ name: c.name, fleet_id: c.fleet_id })),
  });
  const config = frozen.find((c) => c.fleet_id === fleetId) as LocalConfig;

  return createHermetic({
    backend: createAwsBackend({
      profile: config.profile,
      region: config.region,
      expectedAccountId: config.account_id,
      // Names the stack, and through `${AWS::StackName}` every resource in it.
      fleetId: config.fleet_id,
      directoryRegion: resolveDirectoryRegion(opts, local.db),
      hermeticVersion: opts.hermeticdVersion,
    }),
    config,
    runs: new SqliteRunStore(local.db),
    teardowns: new SqliteTeardownStore(local.db),
    /** §4.9: the operator's inbox, in the same file as `runs`. */
    notifications: new SqliteNotificationStore(local.db),
    /** Likewise local, and for a sharper reason: see `LocalChatSessions`. */
    localSessions: new SqliteLocalChatSessions(local.db),
    /** The fence the portal and the CLI share; see `chat-fence.ts`. */
    chatFence: new SqliteChatFenceStore(local.db),
    instanceListening: new SqliteInstanceListeningStore(local.db),
    /** §4.6: this laptop's create presets, one `prefs` row. */
    presets: new SqlitePresetStore(local.db),
    configStore: configStoreFor(local),
    initSupport: { listProfiles: listAwsProfiles, resolveIdentity, describeFoundation },
    ...opts.preflight,
    git: opts.git,
    ...(opts.hermesMirror === undefined ? {} : { hermesMirror: opts.hermesMirror }),
    ...(opts.browserMirror === undefined ? {} : { browserMirror: opts.browserMirror }),
    fixture: false,
    // Real mode is the only place there is a real box to wait for, so it is the
    // only place `create` watches for hermeticd's first report (`handoff.ts`).
    handoff: { budgetMs: HANDOFF_WATCH_MS },
    /**
     * §6.6. Real mode is the only place with a laptop to archive onto and real
     * boxes to wait for: the recovery archive goes beside the database it copies,
     * and `rollout` gives the fleet ten minutes to report the new hermeticd
     * before it says who is still behind. Fixtures and tests leave both out,
     * which is what makes their archive remote-only and their rollout instant.
     */
    foundation: {
      archiveDir: join(local.home, "archive"),
      archiveLocalDb: (path: string) => local.archiveTo(path),
      localDb: local.db,
      rolloutWaitMs: FOUNDATION_ROLLOUT_WAIT_MS,
    },
    /**
     * §3.6: the bare Hermes mirror lives beside the local database, like the
     * recovery archive above. Real mode is the only mode that has one — fixture
     * mode is canned and never spawns git.
     */
    mirrorDir: join(local.home, "mirror"),
    resolveHermeticd: hermeticdResolver(opts),
    localBuild: localBuildResolver(opts),
    hermeticdPath: opts.hermeticdPath,
    hermeticdVersion: opts.hermeticdVersion,
  });
}

function configStoreFor(local: LocalDb): ConfigStore {
  return {
    write: async (config: LocalConfig): Promise<void> => {
      writeConfig(local.db, config);
    },
    archiveRuns: async (): Promise<void> => {
      archiveRuns(local.db);
    },
    // `teardown --reset-local`: the foundation is gone, so the row that pointed
    // at it must go too, or the next command guards against a dead fleet (§4.6).
    // One fleet's row — the others in this home are still real.
    clear: async (name?: string): Promise<void> => {
      clearConfig(local.db, name);
    },
    list: async (): Promise<LocalConfig[]> => listConfigs(local.db),
    read: async (name?: string): Promise<LocalConfig | null> => readConfig(local.db, name),
    defaultFleet: async (): Promise<string | null> => defaultFleet(local.db),
    setDefaultFleet: async (name: string | null): Promise<void> => {
      setDefaultFleet(local.db, name);
    },
    directoryRegion: async (): Promise<string | null> => directoryRegion(local.db),
    setDirectoryRegion: async (region: string): Promise<void> => {
      setDirectoryRegion(local.db, region);
    },
  };
}

/**
 * §4.8: `--directory-region` (or the portal's), then `HERMETIC_DIRECTORY_REGION`,
 * then what `init` persisted here, then `us-east-1`. One table per account, so
 * the answer only has to be given once.
 */
function resolveDirectoryRegion(opts: OpenOptions, db: Database | null): string {
  return (
    opts.directoryRegion ??
    process.env["HERMETIC_DIRECTORY_REGION"] ??
    (db ? directoryRegion(db) : null) ??
    DEFAULT_DIRECTORY_REGION
  );
}

/**
 * Fixture mode's own local database, degrading to memory when the home cannot
 * be opened at all — the same bargain `openRunStore` makes (§4.6): a broken
 * home costs the run log and the recorded default, never the fleet.
 */
function openFixtureLocalDb(home?: string): LocalDb {
  try {
    return openLocalDb({ home, fixture: true });
  } catch {
    return openMemoryDb();
  }
}

/**
 * The fixture fleets, frozen into the fixture database so `fleet ls`,
 * `fleet use` and `--fleet staging` all behave in `--fixture` exactly as they
 * do against a real account. Idempotent, and it never touches a *default* the
 * operator has already chosen.
 */
function seedFixtureFleets(local: LocalDb): void {
  try {
    // Only on the *first* open of a fixture home. After that the rows are the
    // home's, and rewriting them would undo a `fleet use` or a teardown.
    if (listConfigs(local.db).length > 0) return;
    for (const name of FIXTURE_FLEETS) writeConfig(local.db, fixtureConfigFor(name));
    /**
     * And the default with them — but only here, on that first open. Writing it
     * whenever the pref happens to be absent made `FLEET_REQUIRED` unreachable
     * in fixture mode: `setDefaultFleet(null)` would be silently undone by the
     * next open, and the CLI's refusal and the portal's fleet picker are both
     * things that have to be reachable to be developed against.
     */
    setDefaultFleet(local.db, fixtureConfigFor(FIXTURE_FLEETS[0]).fleet_id);
  } catch {
    /* a home that cannot be written still gets a working fixture fleet */
  }
}

/**
 * Which fixture fleet `--fixture` opens, by `fleet_id`. The same chain as real
 * mode, over the two fleets the fixture directory holds; an unknown token is
 * `NOT_FOUND` rather than a silent fall back to the first one, because a demo
 * that quietly showed the wrong fleet is the bug this whole feature exists to
 * prevent.
 */
function fixtureFleetId(local: LocalDb, opts: OpenOptions): string {
  const asked = opts.fleet ?? process.env["HERMETIC_FLEET"] ?? null;
  /**
   * The same selection rule real mode runs, over the rows this fixture home
   * holds — and run even when `--fleet` said something, so a fixture resolves a
   * display alias to its `fleet_id` exactly as real mode does (§4.6). It
   * really can end
   * in `FLEET_REQUIRED`: a fixture home whose default was cleared is exactly
   * the state the portal's picker exists for, and a fixture that could not
   * reach it would be a fixture the picker could not be developed against.
   */
  const rows = listConfigs(local.db);
  // Nothing frozen yet (a home whose database could not be written). Answer in
  // the same currency as every other branch: a `fleet_id`, not a label (§4.6).
  if (rows.length === 0) {
    return asked !== null && asked !== "" ? asked : fixtureConfigFor(FIXTURE_FLEETS[0]).fleet_id;
  }
  return resolveFleetId({
    ...(asked !== null ? { explicit: asked } : {}),
    defaultFleet: defaultFleet(local.db),
    fleets: rows.map((r) => ({ name: r.name, fleet_id: r.fleet_id })),
  });
}

export interface InitSession {
  home: string;
  db: Database;
  /** The frozen row, when this home already has one (`init --reset`, `--attach`). */
  existingConfig: LocalConfig | null;
  /** Set when an unreadable `hermetic.db` was renamed aside on open (§4.7 step 5). */
  corruptedTo: string | null;
  /**
   * Credential environment variables that are set. `aws.client()` ignores them,
   * so the head prints this as a warning before anything else (§4.7).
   */
  envOverrides: string[];
  /**
   * A core instance with no config row: every method except `init` (and its two
   * pre-init helpers) fails `NOT_INITIALIZED`, which is exactly what the
   * interactive flow needs.
   */
  hermetic: Hermetic;
  /**
   * Rebuild the core instance once the operator has chosen a profile, a region
   * and confirmed the twelve digits — `init` itself then runs against real
   * credentials for that account.
   */
  bind(input: { profile: string; region: string; accountId: string }): Hermetic;
  /**
   * Reopen the core instance from what `init` just froze — the way a head would
   * see it after restarting the process, without needing to know the
   * profile/region/account that `bind` needed. Real mode reopens the actual
   * home through `openHermetic`; fixture mode returns an instance over the same
   * in-memory backend and config store the wizard just wrote to, so the posted
   * `region`/`tailnet` and the seeded fixture agents are visible through it.
   */
  reopen(): Promise<Hermetic>;
  close(): void;
}

/**
 * Every `ComputeApi` method, so the refuse-everything backend below covers all
 * of them. `_computeMethodsAreComplete` fails to compile the moment a method is
 * added to the interface and not to this list — without it a new method is
 * `undefined` before `init`, and the operator gets `x is not a function` where
 * they should get `NOT_INITIALIZED`.
 */
const COMPUTE_METHODS = [
  "findVolumeByTag",
  "createVolume",
  "deleteVolume",
  "listInstancesByTag",
  "listNetworkInterfaces",
  "runInstance",
  "describeInstance",
  "describeOwnedInstance",
  "describeInstanceStatus",
  "consoleOutput",
  "describeVolume",
  "describeOwnedVolume",
  "attachVolume",
  "terminate",
  "stop",
  "start",
  "reboot",
  "describeSecurityGroupInbound",
  "resolveUbuntuAmi",
  "listManagedInstances",
  "listManagedVolumes",
  "listVolumes",
  "listUnscopedManaged",
  "tagFleetId",
  "launchAz",
  "retagVolume",
  "listSnapshots",
  "deleteSnapshot",
  "listAddresses",
  "releaseAddress",
] as const satisfies readonly (keyof ComputeApi)[];

const _computeMethodsAreComplete: Exclude<
  keyof ComputeApi,
  (typeof COMPUTE_METHODS)[number]
> extends never
  ? true
  : never = true;
void _computeMethodsAreComplete;

/**
 * A `Backend` whose every method refuses. Before the operator has chosen a
 * profile there is nothing to point `aws.client()` at, and a fixture backend
 * standing in for one would be worse than nothing: `init` would happily read the
 * fixture's identity and freeze it into the operator's real database. The only
 * things callable on the pre-init instance are `init.listProfiles` and
 * `init.resolveIdentity`, which do not go through the backend at all.
 */
function notInitializedBackend(): Backend {
  const refuse = (path: string) => () => {
    throw new HermeticError(
      "NOT_INITIALIZED",
      `no AWS target is chosen yet; pick a profile and resolve its identity before calling ${path}`,
      { method: path },
    );
  };
  const group = <T extends object>(prefix: string, keys: readonly (keyof T & string)[]): T =>
    Object.fromEntries(keys.map((k) => [k, refuse(`${prefix}.${k}`)])) as T;

  return {
    identity: group("identity", ["callerIdentity", "accountAlias", "orgId"]),
    store: {
      agents: group("store.agents", ["get", "putIfAbsent", "update", "scan", "delete"]),
      events: group("store.events", ["append", "query", "appendTombstone", "queryTombstones"]),
      fleet: group("store.fleet", [
        "get",
        "put",
        "updateFleet",
        "replaceFleet",
        "lockFleet",
        "unlockFleet",
        "putSettings",
      ]),
      volumeClaims: group("store.volumeClaims", ["get", "list", "claim", "release"]),
    },
    secrets: group("secrets", [
      "ensureSlot",
      "put",
      "exists",
      "isPlaceholder",
      "deleteByPrefix",
      "list",
    ]),
    artifacts: group("artifacts", [
      "putObject",
      "copy",
      "purgeByPrefix",
      "exists",
      "getText",
      "deleteByPrefix",
      "emptyBucket",
      "presign",
    ]),
    compute: group<ComputeApi>("compute", COMPUTE_METHODS),
    foundation: group("foundation", [
      "describeStack",
      "listStacks",
      "bindFleet",
      "createStack",
      "deleteStack",
      "createChangeSet",
      "describeChangeSet",
      "executeChangeSet",
      "deleteChangeSet",
    ]),
    tailscale: group("tailscale", [
      "mintAuthKey",
      "listDevices",
      "deleteDevice",
      "getPolicy",
      "validatePolicy",
      "setPolicy",
    ]),
    rpc: group("rpc", ["logs", "health"]),
    /**
     * §4.8. The directory is account-global rather than fleet-scoped, but it is
     * still an AWS table in an account nobody has chosen yet, so it refuses
     * like the rest. `region` is a value, not a call — a head asking where the
     * directory *would* be must get an answer rather than a refusal.
     */
    directory: {
      region: DEFAULT_DIRECTORY_REGION,
      ...group<Omit<DirectoryApi, "region">>("directory", [
        "ensure",
        "status",
        "get",
        "list",
        "register",
        "update",
      ]),
    },
    clock: { now: () => new Date() },
  };
}

/**
 * What the interactive `init` flow needs before a config row exists (§4.7).
 * `openHermetic` cannot serve it: it refuses without a frozen config, and it
 * would have nothing to point `aws.client()` at.
 */
export async function openForInit(opts: OpenOptions = {}): Promise<InitSession> {
  const fixture = opts.fixture ?? process.env["HERMETIC_FIXTURE"] === "1";
  if (fixture) return fixtureInitSession(opts);

  const home = hermeticHome(opts.home);
  const openOpts = { home: opts.home };

  /**
   * §4.7/AGENTS.md rule 1: a laptop that has never run `init` — the exact case
   * `hermetic-portal` boots into — must not gain a ~45 KB `hermetic.db` (and the
   * `HERMETIC_HOME` directory itself) just from *asking* whether it is
   * initialized. So the probe is `existsSync`, not `openLocalDb`: a from-scratch
   * home is read as "nothing frozen, nothing corrupt" without touching disk at
   * all, and the real open — directory creation, `CREATE TABLE`, migrations —
   * is deferred to `ensureLocal()`, reached only from `bind()`'s `configStore`
   * once `init` actually writes something (or, for an already-existing
   * database, opened eagerly below so `existingConfig`/`corruptedTo` are
   * accurate immediately).
   */
  let local: LocalDb | null = existsSync(dbPath(opts.home)) ? openLocalDb(openOpts) : null;
  /**
   * §4.8: with a home that may hold several fleets, "the row this init might
   * re-target" is the one that was *named* — and with nothing named, only an
   * unambiguous home has one at all (`readConfig` answers null for the rest).
   * `freeze()` reads this to decide whether an init re-targets, so guessing
   * here would be guessing about the guard.
   */
  const existingConfig = local ? readConfig(local.db, opts.fleet) : null;
  const corruptedTo = local ? local.corruptedTo : null;

  function ensureLocal(): LocalDb {
    local ??= openLocalDb(openOpts);
    return local;
  }

  /**
   * §4.6: the wizard shows the receipt of the teardown that just returned this
   * home to uninitialized, so the pre-init instance can *read* the table — but
   * only if the database is already open. Asking whether a from-scratch laptop
   * has torn anything down must not be what creates its `hermetic.db`.
   */
  const teardowns: TeardownStore = {
    record: async (): Promise<void> => {
      /* pre-init core cannot tear down: `teardown` requires a frozen config. */
    },
    list: async (input: TeardownsListInput) =>
      local ? new SqliteTeardownStore(local.db).list(input) : [],
  };

  const configStore: ConfigStore = {
    write: async (config: LocalConfig): Promise<void> => {
      writeConfig(ensureLocal().db, config);
    },
    archiveRuns: async (): Promise<void> => {
      archiveRuns(ensureLocal().db);
    },
    clear: async (name?: string): Promise<void> => {
      clearConfig(ensureLocal().db, name);
    },
    /**
     * These read, so they must not be what creates `hermetic.db`: a laptop that
     * has never run `init` is asked "which fleets are here" by the wizard's
     * very first screen, and the answer is "none" without touching disk.
     */
    list: async (): Promise<LocalConfig[]> => (local ? listConfigs(local.db) : []),
    read: async (name?: string): Promise<LocalConfig | null> =>
      local ? readConfig(local.db, name) : null,
    defaultFleet: async (): Promise<string | null> => (local ? defaultFleet(local.db) : null),
    setDefaultFleet: async (name: string | null): Promise<void> => {
      setDefaultFleet(ensureLocal().db, name);
    },
    directoryRegion: async (): Promise<string | null> => (local ? directoryRegion(local.db) : null),
    setDirectoryRegion: async (region: string): Promise<void> => {
      setDirectoryRegion(ensureLocal().db, region);
    },
  };
  const bind = (input: {
    profile: string;
    region: string;
    accountId: string;
    /** §4.8: overrides the persisted/default directory region for this session. */
    directoryRegion?: string;
  }): Hermetic => {
    /**
     * §4.8: `init --directory-region <r>` names a region as a *field of the
     * request*, which arrives long after this backend was built. Only the
     * directory client is affected — every other client is in the fleet's own
     * region — so `init` is handed a way to build that one API rather than a
     * whole second backend.
     */
    const initSupport: InitSupport = {
      listProfiles: listAwsProfiles,
      resolveIdentity,
      describeFoundation,
      directoryFor: (region: string) =>
        createAwsBackend({
          profile: input.profile,
          region: input.region,
          expectedAccountId: input.accountId,
          directoryRegion: region,
        }).directory,
    };
    return createHermetic({
      backend: createAwsBackend({
        profile: input.profile,
        region: input.region,
        expectedAccountId: input.accountId,
        directoryRegion: input.directoryRegion ?? resolveDirectoryRegion(opts, local?.db ?? null),
        hermeticVersion: opts.hermeticdVersion,
      }),
      // The home's already-frozen row, if any (§4.6): `init`'s `freeze()` reads
      // this via `deps.config` to detect a retarget and gate it behind
      // `--reset --yes`. Passing `null` here (as this used to) made that guard
      // permanently dead on the real path both the CLI and the server use.
      config: existingConfig,
      configStore,
      teardowns,
      initSupport,
      ...opts.preflight,
      git: opts.git,
      ...(opts.hermesMirror === undefined ? {} : { hermesMirror: opts.hermesMirror }),
      ...(opts.browserMirror === undefined ? {} : { browserMirror: opts.browserMirror }),
      fixture: false,
      resolveHermeticd: hermeticdResolver(opts),
      localBuild: localBuildResolver(opts),
      hermeticdPath: opts.hermeticdPath,
      hermeticdVersion: opts.hermeticdVersion,
    });
  };

  /** What the *pre-bind* instance can do: the three reads, and no directory. */
  const preInitSupport: InitSupport = {
    listProfiles: listAwsProfiles,
    resolveIdentity,
    describeFoundation,
  };

  /**
   * The pre-init instance is deliberately inert: a refusing backend and — this
   * is the part that matters — **no `configStore`**. `init` on it cannot reach
   * AWS and cannot write the frozen row, so there is no path from "the operator
   * opened the picker" to "something was frozen into the real database". Only
   * `bind()`, which is reached after a real `resolveIdentity`, can freeze.
   */
  const hermetic = createHermetic({
    backend: notInitializedBackend(),
    config: null,
    initSupport: preInitSupport,
    teardowns,
    ...opts.preflight,
    git: opts.git,
    ...(opts.hermesMirror === undefined ? {} : { hermesMirror: opts.hermesMirror }),
    ...(opts.browserMirror === undefined ? {} : { browserMirror: opts.browserMirror }),
    fixture: false,
  });

  return {
    home,
    // Lazy for the same reason `configStore` is: reading `.db` before anything
    // has been frozen would otherwise be indistinguishable from writing to it,
    // and either should be the thing that finally creates the file.
    get db(): Database {
      return ensureLocal().db;
    },
    existingConfig,
    corruptedTo,
    envOverrides: detectEnvCredentialOverrides(),
    hermetic,
    bind,
    reopen: () =>
      openHermetic({
        home,
        fleet: opts.fleet,
        directoryRegion: opts.directoryRegion,
        hermeticdPath: opts.hermeticdPath,
        hermeticdVersion: opts.hermeticdVersion,
      }),
    close: () => local?.close(),
  };
}

/**
 * The three profiles a fixture wizard walkthrough sees. `--fixture` exists so UI
 * work and demos need no AWS account (AGENTS.md), and the profile picker is the
 * first screen of `init`, so it needs something to draw.
 */
export const FIXTURE_PROFILES: AwsProfileInfo[] = [
  { name: "acme-dev", region: "us-west-2", credential_type: "sso", source: "config" },
  { name: "acme-prod", region: "us-east-1", credential_type: "assume_role", source: "config" },
  { name: "sandbox", region: "us-west-2", credential_type: "static", source: "credentials" },
];

/**
 * A fixture `init` session: the whole of §4.7 with no AWS.
 *
 * With no explicit fleet, the backend starts with **no foundation**, so `auto`
 * resolves to create and the wizard walks its create branch. Its config goes to
 * an in-memory store and SQLite database, so merely opening the wizard writes
 * nothing. With an explicit fleet, this is the fixture attach path instead: it
 * seeds that account-side foundation and reuses an existing fixture database
 * so the newly frozen row survives the command.
 *
 * The eleven seeded agents appear as `init` finishes — the config write is its
 * last step — so a wizard that runs to completion lands on a populated fleet,
 * which is what `openHermetic({ fixture: true })` would have shown all along.
 */
function fixtureInitSession(opts: OpenOptions): InitSession {
  /**
   * §4.8: the fixture home's *own* database when it already has one, so the
   * pre-init instance can see the fleets that home has frozen. A portal that
   * booted into `FLEET_REQUIRED` reaches for this instance to draw its picker,
   * and an in-memory database would have answered "no fleets here" about a home
   * that holds two.
   *
   * Only when the file is already there, though: a from-scratch fixture home
   * must gain nothing from being *asked* about (`init-wizard.test.ts` asserts
   * the wizard writes nothing to disk), and a home with no file has no rows to
   * miss. `opts.home` may be absent here: the CLI supplies `HERMETIC_HOME`, and
   * `dbPath` resolves that same default before deciding whether the file exists.
   */
  const local = existsSync(dbPath(opts.home, { fixture: true }))
    ? openFixtureLocalDb(opts.home)
    : openMemoryDb();
  /**
   * An explicit fleet means this is the attach path, not the fixture wizard's
   * from-scratch create walkthrough. The fleet may deliberately be absent from
   * the local database — attaching it is what writes that row — so resolve it
   * against the fixture account rather than through the home's frozen rows.
   */
  const requested = opts.fleet === undefined ? null : fixtureConfigFor(opts.fleet);
  const existingConfig = requested === null ? null : readConfig(local.db, requested.fleet_id);
  /**
   * Opened per call, and only if the file is already there: the fixture wizard
   * writes *nothing* to disk (`init-wizard.test.ts` asserts exactly that), so
   * asking whether a fixture teardown happened must not be what creates
   * `hermetic-fixture.db`.
   */
  const fixtureTeardowns: TeardownStore = {
    record: async (): Promise<void> => {
      /* the fixture wizard cannot tear down: `teardown` requires a config. */
    },
    list: async (input: TeardownsListInput) => {
      if (!existsSync(dbPath(opts.home, { fixture: true }))) return [];
      const store = openTeardownStore(opts.home, { fixture: true });
      try {
        return await store.teardowns.list(input);
      } finally {
        store.close();
      }
    },
  };
  /**
   * §4.8: the wizard's account has no foundation — which is what makes `auto`
   * resolve to create — so it has no fleet directory either. A wizard walking a
   * create against an account that already held `main` and `staging` would be
   * refused for want of a `--name` the wizard has no field for. So the account
   * the head shared is *put* into that state rather than left alone: the
   * portal's later reopen (a fleet switch after the wizard) must see the fleet
   * the wizard created, not the two the seed knows, and an account is one
   * object precisely so that every backend standing in it agrees.
   */
  const knobs = opts.fixtureOptions ?? {};
  const backend =
    requested === null
      ? new MemoryBackend({
          account: knobs.account
            ? resetFixtureAccount(knobs.account, "absent")
            : createFixtureAccount("absent"),
        })
      : seedFixtureFleet(
          new MemoryBackend({ account: knobs.account ?? createFixtureAccount("seeded") }),
          {
            fleet: requested.fleet_id,
            outdated: knobs.outdated,
          },
        );
  // `bun run dev:wizard` with the head's slow-stack variable set (read there
  // into `slowStackMs`) reproduces the minutes-long foundation phase so its
  // progress UX can be worked on.
  backend.slowStackMs = knobs.slowStackMs ?? 0;

  let frozen: LocalConfig | null = existingConfig;
  const configStore: ConfigStore = {
    write: async (config: LocalConfig): Promise<void> => {
      frozen = config;
      // Also into the in-memory database, so `config show` and the run log
      // behave exactly as they do on a real home.
      writeConfig(local.db, config);
      // A created fleet gains the canned agents at the end of init. An attach
      // target was seeded above and must not have its event history duplicated.
      if (requested === null) seedFixtureAgents(backend);
    },
    archiveRuns: async (): Promise<void> => {
      archiveRuns(local.db);
    },
    list: async (): Promise<LocalConfig[]> => listConfigs(local.db),
    read: async (name?: string): Promise<LocalConfig | null> => readConfig(local.db, name),
    defaultFleet: async (): Promise<string | null> => defaultFleet(local.db),
    setDefaultFleet: async (name: string | null): Promise<void> => {
      setDefaultFleet(local.db, name);
    },
    directoryRegion: async (): Promise<string | null> => directoryRegion(local.db),
    setDirectoryRegion: async (region: string): Promise<void> => {
      setDirectoryRegion(local.db, region);
    },
  };

  const initSupport: InitSupport = {
    listProfiles: async (): Promise<AwsProfileInfo[]> => FIXTURE_PROFILES.map((p) => ({ ...p })),
    resolveIdentity: async (profile: string, region: string): Promise<ResolvedIdentity> => ({
      account_id: FIXTURE_CONFIG.account_id,
      arn: FIXTURE_CONFIG.frozen_by,
      alias: FIXTURE_CONFIG.account_alias,
      org_id: FIXTURE_CONFIG.org_id,
      region,
      profile,
    }),
    describeFoundation: async (): Promise<FoundationSummary> =>
      requested === null
        ? { ...NO_FOUNDATION }
        : {
            found: true,
            fleet_id: requested.fleet_id,
            region: requested.region,
            tailnet: FIXTURE_TAILNET,
            stack_status: "CREATE_COMPLETE",
          },
  };

  const make = (): Hermetic =>
    createHermetic({
      fixture: true,
      backend,
      config: frozen,
      configStore,
      initSupport,
      ...FIXTURE_PREFLIGHT,
      foundation: { hermesFetch: FIXTURE_HERMES_FETCH },
      // Canned for the same reason as everything above it: the wizard's fixture
      // may not open a socket either (§3.2).
      modelCatalog: { fetch: fixtureModelFetch, bedrock: fixtureBedrockCatalog },
      probe: fixtureProbe(backend),
      runs: new SqliteRunStore(local.db),
      /**
       * The fixture wizard's db is in-memory and brand new, but the receipt the
       * fixture *teardown* just wrote went to `hermetic-fixture.db` — the same
       * file `openHermetic({fixture:true})` uses. Reading it from there is what
       * makes `bun run dev:fixture`'s teardown → receipt → wizard loop behave
       * the way the real one does.
       */
      teardowns: fixtureTeardowns,
      hermeticdVersion: opts.hermeticdVersion,
    });

  return {
    home: local.home,
    db: local.db,
    existingConfig,
    corruptedTo: null,
    envOverrides: detectEnvCredentialOverrides(),
    hermetic: make(),
    // The profile and account are already whatever the fixture says they are, so
    // binding is just "rebuild against whatever `init` has done so far".
    bind: () => make(),
    // Same backend, same in-memory config store: whatever `init` has frozen so
    // far (`frozen`) is what this sees, exactly like `bind`.
    reopen: () => Promise.resolve(make()),
    close: () => local.close(),
  };
}
