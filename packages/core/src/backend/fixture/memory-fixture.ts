/**
 * The fixture fleet: the seeded account `--fixture` runs against (§3.4).
 *
 * Split out of `memory.ts` because the two are different kinds of thing. That
 * file is a `Backend` implementation — the AWS-shaped behaviour every core
 * operation is tested against — while this one is the *data* a demo and a test
 * suite start from: two fleets, their stacks, their agents, their volumes and
 * the tailnet devices to match. Keeping them together pushed `memory.ts` at the
 * 2500-line ceiling of AGENTS.md rule 5, and the seam between them was already
 * clean: nothing here reaches into `MemoryBackend`'s privates, and the class
 * needs only three names back (`FIXTURE_FLEETS`, `FIXTURE_HERMETICD_VERSION`
 * and `fixtureDirectoryEntry`).
 *
 * `memory.ts` re-exports everything below, so every existing
 * `from "./backend/memory.ts"` import keeps working.
 */
import { createHash } from "node:crypto";
import type {
  Agent,
  DirectoryEntry,
  FleetSettings,
  LocalConfig,
  NetworkMode,
  Provider,
} from "../../schema/index.ts";
import {
  BROWSER_FOUNDATION_VERSION,
  browserBuildKey,
  DEFAULT_ROOT_GIB,
  FLEET_MANIFEST_KEY,
  ROOT_GIB_MIN,
  SIZES,
  cloudName,
  defaultFleetSettings,
  profileSlotSlug,
  providerKeySlot,
  providerNeedsKey,
  RELEASE_MANIFEST_NAME,
  releaseKey,
  stackNameFor,
  tablesFor,
} from "../../schema/index.ts";
import {
  FIXTURE_BUILD_NUMBER,
  FIXTURE_COMMIT,
  FIXTURE_HERMETICD_BYTES,
  FIXTURE_LOCAL_BUILD,
  RELEASE_BINARY_CONTENT_TYPE,
  RELEASE_STAGE_CONTENT_TYPE,
  STAND_IN_STAGES,
  fleetManifestFrom,
  releaseGeneration,
} from "../../release/artifacts.ts";
export { FIXTURE_BUILD_NUMBER, FIXTURE_COMMIT, FIXTURE_LOCAL_BUILD };
import { FOUNDATION_VERSION, HERMETIC_VERSION } from "../../version.ts";
import { fixtureBrowserBytes, fixtureBrowserEntry } from "../../release/browser-mirror.ts";
import { foundationTemplateSha256 } from "../../aws/cfn-template.ts";
import { HermeticError } from "../../errors.ts";
import { SEEDS, STAGING_SEEDS } from "./fixture-agents.ts";
import {
  type FixtureAccount,
  type FixtureDirectoryMode,
  fixtureAccount,
  seedFixtureAccount,
} from "./fixture-directory.ts";
import { MemoryBackend } from "../memory.ts";
import {
  AGENT_PARAM_ROOT,
  HERMETIC_PARAM_ROOT,
  ROLE_DATA,
  ROLE_TAG,
  SECRET_PLACEHOLDER,
  agentParamPath,
  sharedSecretPath,
} from "../constants.ts";

/**
 * The `NatEip` a `nat` fixture fleet's stack reports. Fixed, because the point
 * of an Elastic IP is that it does not move, and a head that shows the fleet's
 * egress address has to have one to show.
 */
export const FIXTURE_NAT_EGRESS_IP = "203.0.113.200";

/**
 * The fleets a fixture home is frozen to. Two, not one, and that is the point:
 * a single-fleet fixture cannot exercise `--fleet`, the portal's switcher, the
 * directory's `update_available` badge, or the teardown refusal that only fires
 * when a home holds more than one fleet (§4.8). `staging` is deliberately a
 * *small* fleet one foundation version behind, because those are the two things
 * the second fleet has to differ in for any of that to be visible.
 */
export const FIXTURE_FLEETS = ["main", "staging"] as const;
export type FixtureFleetName = (typeof FIXTURE_FLEETS)[number];

/**
 * Both are real `FleetId`s — 8 chars of Crockford base32 (`schema/common.ts`).
 * `staging1` would have been the obvious id for the second fleet and is not a
 * legal one — Crockford drops `i`, `l`, `o` and `u` — so `sg7k2m4p` it is.
 */
const FIXTURE_FLEET_IDS: Record<FixtureFleetName, string> = {
  main: "fxtr0001",
  staging: "sg7k2m4p",
};

/**
 * Which fixture fleet a seeder is being asked for; absent means `main`. It is a
 * plain `string` rather than `FixtureFleetName` because the name reaching here
 * came from `--fleet` or `HERMETIC_FLEET` — operator input — and an unknown one
 * has to be a `NOT_FOUND` an operator can read, not a compile error nobody
 * sees.
 */
export interface FixtureSeed {
  fleet?: string | undefined;
  /**
   * Seed the fleet a foundation update has something to do to: no
   * `foundation_version`, no `fleet_name`, no settings, an older release, and
   * boxes and parameters where a pre-v3 fleet's really are. The heads' outdated
   * knob (`OpenOptions.fixtureOptions.outdated`) lands here.
   */
  outdated?: boolean | undefined;
  /**
   * Seed the fleet at a foundation version of the caller's choosing, instead of
   * the one `fixtureFoundationVersion` derives.
   *
   * The fixture's own arrangement is fixed on purpose — `main` is current and
   * `staging` is exactly one version behind, so precisely one fleet has an
   * update waiting — and that says nothing about any *particular* older
   * version. A gate pinned at the version that introduced it
   * (`BROWSER_FOUNDATION_VERSION`) needs a fleet below *that* number, which
   * "one behind" only happens to be until the next unrelated bump moves
   * `FOUNDATION_VERSION` past it. A test asserting such a refusal says which
   * version it means rather than borrowing `staging`'s.
   *
   * Reaches `_fleet.foundation_version` and, through it, the fleet manifest.
   * It does **not** reach the account directory: `fixtureDirectoryEntry` is
   * built by the account seeders, which run from the `MemoryBackend`
   * constructor and never see these options. A fixture that seeds a directory
   * (`directory: "seeded"`, or an explicit account) *and* overrides the version
   * will have the row disagree with the fleet — so this option is for the
   * fleet-only seeding the refusal tests do, and a test that needs both
   * coherent has to state the version on the directory side as well.
   */
  foundationVersion?: number | undefined;
}

/** Narrow an operator-supplied name to one of the fixture's fleets. */
export function isFixtureFleet(name: string): name is FixtureFleetName {
  return (FIXTURE_FLEETS as readonly string[]).includes(name);
}

/**
 * Which fixture fleet a token means, by `fleet_id` or by display alias (§4.6).
 * The id comes first for the reason `matchFleet` puts it first: identity wins.
 *
 * Every seeder below keys its differences (`staging` is smaller, one foundation
 * version behind, and behind a NAT) on the canonical name, so a token has to be
 * resolved *once*, here, rather than compared against `"staging"` in four
 * places — three of which would silently seed `main` when handed an id.
 */
export function fixtureFleetName(token: string): FixtureFleetName {
  const byId = Object.entries(FIXTURE_FLEET_IDS).find(([, id]) => id === token)?.[0];
  if (byId !== undefined) return byId as FixtureFleetName;
  if (isFixtureFleet(token)) return token;
  throw new HermeticError(
    "NOT_FOUND",
    `no fixture fleet named ${token}; known: ${FIXTURE_FLEETS.join(", ")}`,
    { name: token, known: [...FIXTURE_FLEETS] },
  );
}

/**
 * The foundation contract version a fixture fleet is on. `staging` sits one
 * behind so exactly one fleet in the fixture has an update waiting for it.
 */
function fixtureFoundationVersion(name: string): number {
  return name === "staging" ? FOUNDATION_VERSION - 1 : FOUNDATION_VERSION;
}

/**
 * The network mode a fixture fleet is in (§5). `staging` is the `nat` fleet, so
 * exactly one fleet in the fixture is behind a NAT instance and both branches
 * of everything that reads the mode — status, the manifest, the UI — have a
 * fleet to render with no AWS.
 */
function fixtureNetwork(name: string): NetworkMode {
  return name === "staging" ? "nat" : "public";
}

/** The frozen local config the named fixture fleet is bound to, by id or alias. */
export function fixtureConfigFor(name: string): LocalConfig {
  const fixtureName = fixtureFleetName(name);
  return {
    schema_version: 1,
    name: fixtureName,
    fleet_id: FIXTURE_FLEET_IDS[fixtureName],
    account_id: "123456789012",
    account_alias: "acme-dev",
    org_id: "o-fixture00",
    profile: "acme-dev",
    region: "us-west-2",
    frozen_at: "2026-07-20T09:00:00.000Z",
    frozen_by: "arn:aws:sts::123456789012:assumed-role/hermetic-operator/evan",
  };
}

/**
 * The frozen local config of the *default* fixture fleet. Every test written
 * before there was more than one fleet means this one, so the name keeps
 * meaning `main` rather than becoming ambiguous.
 */
export const FIXTURE_CONFIG: LocalConfig = fixtureConfigFor("main");

/** The fixture fleet's tailnet; Serve URLs are `https://<name>.<this>`. */
export const FIXTURE_TAILNET = "hermetic.ts.net";

/** The CloudFormation stack id a seeded fixture fleet's foundation carries. */
function fixtureStackId(config: LocalConfig): string {
  return `arn:aws:cloudformation:${config.region}:${config.account_id}:stack/${stackNameFor(config.fleet_id)}/fixture`;
}

/**
 * A fresh fixture account (§4.8). `seeded` is the populated one — the two
 * fixture fleets, in a table that exists — and the default, because it is the
 * account `--fixture` stands in. `absent` is an account with no fleet
 * directory at all: what `init` meets the first time it is run anywhere, and
 * therefore what the fixture wizard and every test that walks `init --create`
 * is describing. Without it the seeded `main`/`staging` would make every
 * unnamed create refuse, which is right for a populated account and wrong for
 * an empty one. `empty` is the table there and holding nothing.
 */
export function createFixtureAccount(mode: FixtureDirectoryMode = "seeded"): FixtureAccount {
  return fixtureAccount(mode, () => FIXTURE_FLEETS.map(fixtureDirectoryEntry));
}

/** Put an existing account back into one of its states, for every backend holding it. */
export function resetFixtureAccount(
  account: FixtureAccount,
  mode: FixtureDirectoryMode = "seeded",
): FixtureAccount {
  return seedFixtureAccount(account, mode, () => FIXTURE_FLEETS.map(fixtureDirectoryEntry));
}

export function fixtureDirectoryEntry(name: FixtureFleetName): DirectoryEntry {
  const config = fixtureConfigFor(name);
  return {
    name,
    fleet_id: config.fleet_id,
    account_id: config.account_id,
    region: config.region,
    status: "active",
    stack_id: fixtureStackId(config),
    // `staging` is one contract version behind, so `update_available` is true
    // for exactly one fleet in the fixture and the badge has somewhere to land.
    foundation_version: fixtureFoundationVersion(name),
    // The *tool* build, which is what `init` and `foundation update` write into
    // a real directory entry (`DirectoryEntry.hermetic_version`). The fixture
    // seeded a hermeticd release here, which is the same conflation the manifest
    // had: two different numbers, one field, no reader able to tell.
    hermetic_version: HERMETIC_VERSION,
    tailnet: FIXTURE_TAILNET,
    created_at: config.frozen_at,
    created_by: config.frozen_by,
    updated_at: config.frozen_at,
    updated_by: config.frozen_by,
  };
}

/** A fixture secret value; `secrets-leak.test.ts` greps every stream for it. */
export const FIXTURE_TS_KEY = "tskey-auth-FIXTURE-SECRET";
export const FIXTURE_BWS_TOKEN = "bws-token-FIXTURE-SECRET";

/**
 * The fleet-level shared secret the fixture already holds (§8.3): the Nous
 * Portal key `settings.providers.nous.secret` names. It exists so the Secrets
 * section, `secrets ls` and `secrets verify`'s stale-copy report all have a
 * *set* slot to render with no AWS — the second fixture slot (`openrouter-key`)
 * is meta with a placeholder behind it, which is the other state.
 */
export const FIXTURE_SHARED_NOUS_KEY = "sk-nous-FIXTURE-SHARED-KEY";

/**
 * The fixture fleet's provider profiles (§8.3), with ids fixed rather than
 * minted: `bun run cli -- providers update <id> --fixture` has to name one, and
 * a demo whose ids changed on every process start could not be written down.
 *
 * Between them they cover every state `providers ls` renders — ready and
 * default, ready, a slot still holding the placeholder, a role-authenticated
 * Bedrock profile, and one disabled — so the Providers section, the create
 * drawer's ready-only filter and the delete guards all have something real to
 * act on with no AWS.
 */
export const FIXTURE_PROFILE_IDS = {
  anthropic: "ant00001",
  openrouter: "rtr00002",
  nous: "nsr00003",
  bedrock: "bdr00004",
  vercel: "vrc00005",
} as const;

/**
 * Which provider each fixture profile is on, and which revision it has reached.
 *
 * Two tables rather than a reach into `fixtureSettings`, because the agent
 * seeding runs against a foundation the caller may have created itself (a
 * fixture `init`), so the settings object is not always the one above.
 */
export const FIXTURE_PROFILE_PROVIDERS = {
  anthropic: "anthropic",
  openrouter: "openrouter",
  nous: "nous",
  bedrock: "bedrock",
  vercel: "vercel",
} as const satisfies Record<keyof typeof FIXTURE_PROFILE_IDS, Provider>;

export const FIXTURE_PROFILE_REVISIONS = {
  anthropic: 1,
  openrouter: 1,
  nous: 1,
  // Above 1 so one seeded agent can be pinned behind its profile.
  bedrock: 2,
  vercel: 1,
} as const satisfies Record<keyof typeof FIXTURE_PROFILE_IDS, number>;

/** Fixture profile keys; `secrets-leak.test.ts` greps every stream for these. */
export const FIXTURE_PROFILE_KEY = "sk-profile-FIXTURE-SECRET";

/** The hermeticd release the fixture fleet's manifest points at. */
export const FIXTURE_HERMETICD_VERSION = "0.5.1";

/**
 * The browser build the fixture fleet's manifest names (§7.3). Written out
 * rather than imported from `BUILD_VERSIONS`, which lives in `hermetic.ts` and
 * is the SDK's — a backend that reached up into it would invert the dependency
 * every other constant here respects. `browser-mirror.test.ts` holds the two
 * equal, so a bumped pin cannot leave the fixture naming a build a fixture
 * `artifacts push` would then mirror a second copy of.
 */
export const FIXTURE_CHROME_REF = "153.0.8010.12";

/**
 * The digest of the stand-in binary the fixture publishes — sha256 of the
 * four-byte ELF magic `seedFixtureRelease` puts in the bucket.
 *
 * A constant rather than a hash computed at seed time because the *agents* have
 * to report it: §6.6's rollout confirms a landing by comparing what a box says
 * it is running against what the manifest names, so a fixture whose boxes
 * reported nothing — or reported something else — would show every agent as
 * unconfirmed in `bun run dev:fixture`, and the confirmed path would exist only
 * in a test. `tests/seams.test.ts` holds it equal to the bytes.
 */
export const FIXTURE_HERMETICD_SHA256 =
  "3bdbb4fe8397cd2b842430b39ccff01a8663c751945ef5e9a09e267fb8b1d359";

/**
 * What a box on an *older* release reports. Any digest that is not the one
 * above; the point is only that it differs, which is what makes such a box a
 * straggler the rollout keeps waiting for rather than one it cannot judge.
 */
export const FIXTURE_STALE_SHA256 = "9".repeat(64);

/**
 * What the fixture fleet's boxes report for their own `tailscaled`.
 *
 * Shaped like the real thing — the release, then the build's commit — because
 * the surfaces that render it are the point of the fixture, and a bare `1.86.2`
 * would let a column be sized for a string no live fleet ever produces. Nothing
 * compares it against anything: no release here is the "right" one, since the
 * box's own updater chooses (§4.3) and hermetic only records the answer.
 */
export const FIXTURE_TAILSCALE_VERSION = "1.86.2-t01ab2cd34";

/**
 * The checkout `bun run dev:fixture` pretends to be running from.
 *
 * Canned for the same reason `FIXTURE_PREFLIGHT` and `fixtureHermesMirror` are:
 * fixture mode must not depend on the machine it runs on. Before this, the
 * plan's release block carried whoever's real `git rev-list --count HEAD` and
 * real commit sha — so two developers running the same fixture saw different
 * numbers, and the drawer's comparison changed meaning depending on how many
 * commits you happened to have.
 *
 * One commit *ahead* of what the fixture fleet published, so the drawer opens on
 * the state worth looking at: a release this checkout would change.
 */

/**
 * The bootstrap stages of §4.3, in run order. The fixture ships stand-in bytes
 * for each so a fixture fleet has a *complete* release — binary, stages and a
 * fleet manifest naming both — rather than a binary and a promise.
 */
export const FIXTURE_STAGES: readonly string[] = STAND_IN_STAGES;

/** The stages of the release, in run order — what a booted agent's row shows. */
const STAGE_IDS: readonly string[] = FIXTURE_STAGES.map((f) => f.replace(/\.sh$/, ""));

/**
 * A `BootstrapState` for a seeded agent: every stage `ok`, or everything up to
 * `failed` ok, that one `failed`, and the rest still `pending` — the shape the
 * board's triage view and `agent rerun` are written against (§4.2).
 */
function seedBootstrap(
  version: string,
  startedAtMs: number,
  failed?: { id: string; exit_code: number; message: string },
): Agent["bootstrap"] {
  const at = (offset: number) => new Date(startedAtMs + offset).toISOString();
  const failedAt = failed ? STAGE_IDS.indexOf(failed.id) : -1;
  const stages = STAGE_IDS.map((id, i) => {
    const started_at = at(i * 20_000);
    const ended_at = at(i * 20_000 + 12_000);
    if (failedAt === -1 || i < failedAt) {
      return {
        id,
        status: "ok" as const,
        attempt: 1,
        started_at,
        ended_at,
        exit_code: 0,
        message: null,
      };
    }
    if (i === failedAt) {
      return {
        id,
        status: "failed" as const,
        attempt: 1,
        started_at,
        ended_at,
        exit_code: failed!.exit_code,
        message: failed!.message,
      };
    }
    return {
      id,
      status: "pending" as const,
      attempt: 0,
      started_at: null,
      ended_at: null,
      exit_code: null,
      message: null,
    };
  });
  return {
    hermeticd_version: version,
    stages,
    current: null,
    started_at: at(0),
    updated_at: at(STAGE_IDS.length * 20_000),
    last_command_id: null,
  };
}

/**
 * Eleven sample agents plus one tombstone, with the spec's status vocabulary
 * (`running` → `ready`, `upgrading` → `error` on a failed bootstrap stage).
 * One agent is `degraded` with a failing hermes check, one stopped on
 * `02-data-volume` and is waiting for a `rerun`, one has a stale heartbeat so
 * it derives `unreachable`, two are `stopped`, two are still on an older
 * hermes version so `upgrade` has something to do, and one is `destroyed` —
 * hidden by the dashboard until the toolbar's destroyed toggle asks for it.
 *
 * Only the seeds on a current `hermeticd` report `root_disk` — one of them
 * (`lumen`) with a root filesystem full enough to explain its failing disk
 * check — so both halves of the optional metric, the number and its absence,
 * are visible without anybody having to break a real fleet.
 */
/**
 * Seed only the foundation: the CloudFormation stack and the `_fleet` item, no
 * agents. This is the starting reality for lifecycle tests.
 */
export function seedFixtureFoundation(backend: MemoryBackend, opts: FixtureSeed = {}): MemoryBackend {
  const fixtureName = fixtureFleetName(opts.fleet ?? "main");
  const config = fixtureConfigFor(fixtureName);
  const region = config.region;
  const actor = config.frozen_by;
  const outdated = opts.outdated === true;

  backend.stack = {
    stack_id: fixtureStackId(config),
    stack_name: stackNameFor(config.fleet_id),
    status: "CREATE_COMPLETE",
    tags: {
      fleet_id: config.fleet_id,
      hermetic_version: FIXTURE_HERMETICD_VERSION,
      network: fixtureNetwork(fixtureName),
    },
    // `Network` as CloudFormation records it — the authoritative copy of the
    // mode (§5). `_fleet.network` below is the cache, and the two agree here
    // exactly as they do on a fleet created by this build.
    parameters: { FleetId: config.fleet_id, Network: fixtureNetwork(fixtureName) },
    // The full output set the real template emits (§5): the fleet manifest's
    // `resources` is derived from these, so a fixture that carried fewer would
    // exercise only the fallbacks.
    outputs: {
      Bucket: "hermetic-fixture-bucket",
      BucketName: "hermetic-fixture-bucket",
      AgentSecurityGroupId: "sg-fixture",
      SecurityGroupId: "sg-fixture",
      InstanceProfileArn: `arn:aws:iam::${config.account_id}:instance-profile/hermetic-agent`,
      RoleArn: `arn:aws:iam::${config.account_id}:role/hermetic-agent`,
      VpcId: "vpc-fixture",
      // The template's `SubnetIds` output is the private pair for a `nat`
      // fleet and the public pair otherwise, so the fixture's is too.
      SubnetIds:
        fixtureNetwork(fixtureName) === "nat"
          ? "subnet-fixture-private0,subnet-fixture-private1"
          : "subnet-fixture0,subnet-fixture1",
      Network: fixtureNetwork(fixtureName),
      ...(fixtureNetwork(fixtureName) === "nat" ? { NatEgressIp: FIXTURE_NAT_EGRESS_IP } : {}),
      AgentsTable: tablesFor(stackNameFor(config.fleet_id)).agents,
      EventsTable: tablesFor(stackNameFor(config.fleet_id)).events,
    },
  };

  // §5's `NatEip`: a `nat` fleet's stack holds one Elastic IP, and it is the
  // only stack resource that can survive a `DeleteStack` (§4.6). Seeded here so
  // the fixture's `nat` fleet is tearable-down with the same leftovers a real
  // one has.
  if (fixtureNetwork(fixtureName) === "nat") backend.allocateNatAddress(config.fleet_id);

  const fixtureDefaults = {
    size: "medium",
    provider: "bedrock",
    volume_gib: 100,
    root_gib: DEFAULT_ROOT_GIB,
    /**
     * `main` defaults to a browser; `staging` deliberately does not. The two
     * fleets exist to show two different things, and a fleet default of `true`
     * on the second would collapse them into one: `staging` is the fleet with
     * an update waiting, and the only thing it has to demonstrate is that.
     *
     * This used to be a statement about `BROWSER_FOUNDATION_VERSION` — one
     * version behind was below the browser gate, so the default *had* to be
     * `false` or every create on `staging` would refuse. It is no longer:
     * `FOUNDATION_VERSION` has moved past the gate for a reason of its own, and
     * a test that means "below the browser gate" now says so with
     * `FixtureSeed.foundationVersion` rather than borrowing this fleet.
     */
    browser: fixtureName !== "staging",
    secrets: "none",
  } as const;

  /**
   * The shared settings a fixture fleet has already been given (§4.6). One
   * provider carries a `default_model` override so the Providers section has a
   * real override to render rather than four identical rows; the rest inherit
   * the catalog, which is the ordinary case.
   *
   * Two shared secret slots for the same reason: one *set* and named by a
   * provider (`nous-key`), one declared but never filled (`openrouter-key`,
   * still holding the placeholder). Between them they cover every state
   * `secrets ls` renders, and the first is what makes `secrets rm` refusable
   * on a fixture — a provider names it.
   *
   * `outdated` omits them along with `foundation_version`,
   * because that is the same fleet: one created before either existed. It is
   * what makes the v2 migration exercisable with no AWS.
   */
  const fixtureSettings: FleetSettings = (() => {
    const base = defaultFleetSettings(fixtureDefaults, actor, config.frozen_at);
    const profile = (
      id: string,
      name: string,
      provider: Provider,
      model: string,
      extra: { enabled?: boolean; role?: boolean; revision?: number } = {},
    ) => ({
      id,
      name,
      provider,
      model,
      enabled: extra.enabled ?? true,
      // Above 1 on the Bedrock profile so one seeded agent is pinned behind its
      // profile and `update_available` is on screen in `bun run dev:fixture`.
      revision: extra.revision ?? 1,
      credential:
        extra.role === true
          ? { kind: "role" as const }
          : { kind: "secret" as const, slug: profileSlotSlug(id) },
      created_at: config.frozen_at,
      created_by: actor,
      updated_at: config.frozen_at,
      updated_by: actor,
    });
    return {
      ...base,
      providers: {
        ...base.providers,
        nous: {
          enabled: true,
          default_model: "deepseek-v4-flash-0731",
          secret: "nous-key",
        },
      },
      /**
       * Stated rather than migrated: `settingsOf` normalises a fleet that has
       * no `profiles` at all, and a fixture that relied on that would only ever
       * show the migration's output. `outdated` omits the
       * whole settings object, which is where the migration is exercised.
       */
      profiles: {
        [FIXTURE_PROFILE_IDS.anthropic]: profile(
          FIXTURE_PROFILE_IDS.anthropic,
          "anthropic-main",
          "anthropic",
          "claude-sonnet-5",
        ),
        [FIXTURE_PROFILE_IDS.openrouter]: profile(
          FIXTURE_PROFILE_IDS.openrouter,
          "openrouter-cheap",
          "openrouter",
          "deepseek/deepseek-v4.1-flash",
        ),
        [FIXTURE_PROFILE_IDS.nous]: profile(
          FIXTURE_PROFILE_IDS.nous,
          "nous-lab",
          "nous",
          "deepseek/deepseek-v4.1-flash",
        ),
        [FIXTURE_PROFILE_IDS.bedrock]: profile(
          FIXTURE_PROFILE_IDS.bedrock,
          "bedrock-role",
          "bedrock",
          "zai.glm-4.7-flash",
          { role: true, revision: 2 },
        ),
        [FIXTURE_PROFILE_IDS.vercel]: profile(
          FIXTURE_PROFILE_IDS.vercel,
          "vercel-gw",
          "vercel",
          "deepseek/deepseek-v4.1-flash",
          { enabled: false },
        ),
      },
      default_profile: FIXTURE_PROFILE_IDS.anthropic,
      secrets: [
        {
          slug: "nous-key",
          label: "Nous Portal",
          created_at: config.frozen_at,
          last_set_at: config.frozen_at,
        },
        {
          slug: "openrouter-key",
          label: "OpenRouter",
          created_at: config.frozen_at,
          last_set_at: config.frozen_at,
        },
        // The slots the four keyed profiles own (§8.3). `secrets ls` marks each
        // with its owner and `secrets rm` refuses it, which is the state the
        // Secrets section's link-back is rendered from.
        ...(["anthropic", "openrouter", "nous", "vercel"] as const).map((p) => ({
          slug: profileSlotSlug(FIXTURE_PROFILE_IDS[p]),
          label: `${p} profile`,
          created_at: config.frozen_at,
          last_set_at: config.frozen_at,
        })),
      ].sort((a, b) => a.slug.localeCompare(b.slug)),
    };
  })();
  if (outdated) {
    /**
     * The pre-v3 shape, which is the whole point of this flag: the same two
     * slots, on the account roots the v3 migration copies *from*. Without them
     * `outdated` would have nothing for the migration to
     * move, and `doctor`'s "legacy parameters present" nothing to report.
     */
    backend.params.set(`${HERMETIC_PARAM_ROOT}secrets/nous-key`, FIXTURE_SHARED_NOUS_KEY);
    backend.params.set(`${HERMETIC_PARAM_ROOT}secrets/openrouter-key`, SECRET_PLACEHOLDER);
    backend.params.set(`${HERMETIC_PARAM_ROOT}tailscale/oauth-secret`, "tskey-client-FIXTURE");
  } else {
    // The values behind the two slots: one real (fixture-shaped), one still the
    // placeholder `ensureSlot` writes. No value is ever read back out of here
    // by anything but the copy into an agent's own slot (§8.3).
    backend.params.set(sharedSecretPath(config.fleet_id, "nous-key"), FIXTURE_SHARED_NOUS_KEY);
    backend.params.set(sharedSecretPath(config.fleet_id, "openrouter-key"), SECRET_PLACEHOLDER);
    // Three profiles hold a real (fixture-shaped) key and one holds the
    // placeholder, so `providers ls` shows both readiness answers.
    for (const p of ["anthropic", "openrouter", "vercel"] as const) {
      backend.params.set(
        sharedSecretPath(config.fleet_id, profileSlotSlug(FIXTURE_PROFILE_IDS[p])),
        FIXTURE_PROFILE_KEY,
      );
    }
    backend.params.set(
      sharedSecretPath(config.fleet_id, profileSlotSlug(FIXTURE_PROFILE_IDS.nous)),
      SECRET_PLACEHOLDER,
    );
  }

  backend.fleetItem = {
    fleet_id: config.fleet_id,
    /**
     * §5: the prefix every cloud-side name carries. `outdated`
     * omits it along with `foundation_version` and the fleet-scoped SSM paths,
     * because that is the same fleet: one created before v3, and the target the
     * v3 migration exists to move forward.
     */
    ...(outdated || config.name === null ? {} : { fleet_name: config.name }),
    defaults: fixtureDefaults,
    ...(outdated ? {} : { settings: fixtureSettings }),
    /**
     * §8.3: the Bedrock grant this fleet's stack actually holds, recorded the
     * way a fleet whose foundation has been reconciled records it. Without it
     * every reader falls back to the pre-GLM list — correct for a fleet nobody
     * has updated, and the state `outdated` leaves the
     * fixture in — and the Bedrock profile would read as needing a foundation
     * update, which is not the state the up-to-date fixture is meant to show.
     */
    ...(outdated
      ? {}
      : {
          bedrock_model_ids: [
            "zai.glm-4.7-flash",
            "anthropic.claude-sonnet-4-5-20250929-v1:0",
            "anthropic.claude-haiku-4-5-20251001-v1:0",
            "anthropic.claude-opus-4-1-20250805-v1:0",
          ],
        }),
    ubuntu_release: "24.04",
    ami_id: "ami-0abc1234def567890",
    /**
     * The fixture fleet is *up to date* by default (§6.6): a demo fleet that
     * nags about a foundation update on every command would make the pill and
     * the doctor finding permanent furniture rather than a state to develop
     * against. `outdated` is the other seed — no
     * `foundation_version` at all, which is what every fleet created before the
     * stamp existed looks like, plus an older release — so the pill, the Settings
     * section and the update drawer have something real to act on.
     */
    ...(outdated
      ? { min_hermetic_version: "0.4.0" }
      : {
          min_hermetic_version: FIXTURE_HERMETICD_VERSION,
          /**
           * `staging` is deliberately one version behind — the same fact the
           * directory records for it — so `foundation update`, the "update
           * available" badge and the "N other fleets need an update" line have
           * a real fleet to point at with no AWS (§4.8).
           */
          foundation_version: opts.foundationVersion ?? fixtureFoundationVersion(fixtureName),
          foundation_template_sha256: foundationTemplateSha256(),
        }),
    tailnet: FIXTURE_TAILNET,
    // Seeded on both fixture fleets, because a fleet created by this build
    // stamps it at `init` (§5); the absent case is what the v6 migration is
    // for, and lives in that migration's own tests rather than here.
    network: fixtureNetwork(fixtureName),
    tailscale_oauth_client_id: "kFIXTURE",
    region,
    bucket: "hermetic-fixture-bucket",
    stack_id: backend.stack.stack_id,
    created_by: actor,
    created_at: config.frozen_at,
  };

  seedFixtureRelease(backend, FIXTURE_HERMETICD_VERSION);
  backend.resetMutations();
  return backend;
}

/**
 * Put a release in the bucket and point the fleet manifest at it — what
 * `artifacts.push` does against AWS, done directly so a seeded fixture starts
 * from a fleet that could actually launch an agent (§3.2).
 */
export function seedFixtureRelease(backend: MemoryBackend, version: string): void {
  /**
   * Stages first, binary last, and everything under one generation — the shape
   * `pushRelease` guarantees, so the fixture bucket is a bucket a reader may
   * make the same assumptions about as a real one (§3.1). The generation is
   * computed from the same bytes `releaseFiles` republishes, so one
   * `artifacts push` in `dev:fixture` lands on the generation already seeded
   * rather than inventing a second one.
   */
  const contents: Array<{ name: string; bytes: Uint8Array; contentType: string }> = [
    ...FIXTURE_STAGES.map((stage) => ({
      name: `stages/${stage}`,
      bytes: new TextEncoder().encode(`#!/usr/bin/env bash\n# fixture stand-in for ${stage}\n`),
      contentType: RELEASE_STAGE_CONTENT_TYPE,
    })),
    {
      name: "hermeticd",
      bytes: new Uint8Array(FIXTURE_HERMETICD_BYTES),
      contentType: RELEASE_BINARY_CONTENT_TYPE,
    },
  ];
  const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
  /**
   * The content types are part of the digest (`releaseGeneration`), so they are
   * part of what the seed has to match: leaving them out here computed a
   * different generation from the one `releaseFiles` republishes, and the
   * comment above would have been false in exactly the way it warns about.
   */
  const generation = releaseGeneration(
    contents.map((f) => ({ name: f.name, sha256: digest(f.bytes), contentType: f.contentType })),
  );

  const files: Record<string, { key: string; sha256: string; size: number }> = {};
  for (const { name, bytes } of contents) {
    const key = releaseKey(version, name, generation);
    backend.objects.set(key, bytes);
    files[name] = { key, sha256: digest(bytes), size: bytes.byteLength };
  }
  // Written last, exactly as a push writes it: the marker that says the
  // generation is whole.
  backend.objects.set(
    releaseKey(version, RELEASE_MANIFEST_NAME, generation),
    new TextEncoder().encode(
      `${JSON.stringify(
        {
          schema_version: 1,
          version,
          generation,
          files,
          created_at: backend.now().toISOString(),
        },
        null,
        2,
      )}\n`,
    ),
  );

  const fleet = backend.fleetItem;
  if (!fleet) return;
  /**
   * §7.3's mirrored browser, seeded only on a fleet whose foundation can
   * actually read it. That is not decoration: `staging` is deliberately one
   * version behind, which puts it below `BROWSER_FOUNDATION_VERSION`, and a
   * manifest naming a build the fleet's role may not fetch would be a state no
   * real fleet can be in — while the fleet with no block is exactly what
   * `BROWSER_NEEDS_FOUNDATION_UPDATE` exists to refuse a `--browser` create on.
   *
   * The object goes in the bucket beside the entry, with the same bytes
   * `fixtureBrowserMirror` would write, so a fixture `artifacts push` takes the
   * "already mirrored" path rather than re-uploading what is already there.
   */
  const browser =
    (fleet.foundation_version ?? 0) >= BROWSER_FOUNDATION_VERSION
      ? { [FIXTURE_CHROME_REF]: fixtureBrowserEntry(FIXTURE_CHROME_REF) }
      : undefined;
  if (browser) {
    backend.objects.set(browserBuildKey(FIXTURE_CHROME_REF), fixtureBrowserBytes(FIXTURE_CHROME_REF));
  }
  /**
   * Built through `fleetManifestFrom`, not by hand: `init --attach` rewrites
   * the manifest from the same stack outputs, and a seed that disagreed with
   * it would make attaching to a healthy fixture fleet look like a mutation.
   */
  const manifest = fleetManifestFrom({
    fleet,
    stack: backend.stack,
    hermeticd: {
      version,
      generation,
      files,
      /**
       * §3.6's provenance, seeded so the update drawer has two sides to compare
       * in `bun run dev:fixture`. Published one commit behind
       * `FIXTURE_BUILD_NUMBER`, so the fixture opens on "this checkout would
       * change what the fleet runs" — the state the line exists to show —
       * rather than on the two blanks it showed while these were absent.
       */
      build: "b".repeat(64),
      build_number: FIXTURE_BUILD_NUMBER - 1,
      commit: "f1x7ur0",
    },
    updatedBy: backend.callerArn,
    updatedAt: backend.now().toISOString(),
    ...(browser === undefined ? {} : { browser }),
  });
  backend.objects.set(
    FLEET_MANIFEST_KEY,
    new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
  );
}

/**
 * Seed `_fleet` plus the eleven sample agents, their resources, and an event
 * history for each. Everything lives in one region — the fixture config's.
 */
export function seedFixtureFleet(backend: MemoryBackend, opts: FixtureSeed = {}): MemoryBackend {
  seedFixtureFoundation(backend, opts);
  return seedFixtureAgents(backend, opts);
}

/**
 * The eleven agents alone, onto whatever foundation the backend already has.
 * Split out so a fixture `init` can create its *own* stack and `_fleet` — with
 * its own minted `fleet_id` — and then have the fleet appear on it, rather than
 * having the fixture foundation stamped over the one init just made (§4.7).
 */
export function seedFixtureAgents(backend: MemoryBackend, opts: FixtureSeed = {}): MemoryBackend {
  const region = backend.fleetItem?.region ?? FIXTURE_CONFIG.region;
  const actor = FIXTURE_CONFIG.frozen_by;
  const nowMs = backend.now().getTime();
  const fleetId = backend.fleetItem?.fleet_id ?? FIXTURE_CONFIG.fleet_id;
  const outdated = opts.outdated === true;
  /**
   * §5: what these agents are called *in the cloud* — `k7m2x9qa-atlas`, not
   * `atlas`, since v4 keys the spelling on the fleet's id. Undefined under
   * `outdated`, which is the pre-v3 fleet whose boxes really
   * do wear bare names, and which is therefore also the fixture where `doctor`
   * has legacy hostnames to recognise.
   */
  const cloud = (agent: string): string => cloudName(outdated ? undefined : fleetId, agent);
  /**
   * An agent's slot. `outdated` puts them where a pre-v3
   * fleet's really are — directly under `/hermes/<name>/` — so the v3 migration
   * has a fixture to move forward and `doctor` a legacy set to count.
   */
  const slot = (agent: string, name: string): string =>
    outdated ? `${AGENT_PARAM_ROOT}${agent}/${name}` : agentParamPath(fleetId, agent, name);

  /**
   * §5: whether this fleet's boxes were launched behind a NAT. `staging` is the
   * fixture's `nat` fleet, and its agents therefore have no public address —
   * seeding one would render the state the mode exists to prevent.
   */
  const natMode = backend.stack?.parameters["Network"] === "nat";

  let n = 0;
  for (const seed of fixtureFleetName(opts.fleet ?? "main") === "staging" ? STAGING_SEEDS : SEEDS) {
    n += 1;
    const volume_id = `vol-fixture${String(n).padStart(11, "0")}`;
    const instance_id = `i-fixture${String(n).padStart(11, "0")}`;
    // A destroyed agent kept nothing but its row and its data volume: `destroy`
    // terminated the instance, deleted every SSM parameter and config object,
    // and the tailscale device went with the box (§6.6).
    const destroyed = seed.status === "destroyed";
    const running = !destroyed && seed.status !== "stopped";
    const spec = SIZES[seed.size];
    const config_hash = `fixture${String(n).padStart(2, "0")}`.padEnd(16, "0");
    const ssm_paths = [slot(seed.name, "ts-key")];
    // What the node would report about itself. `corvid` is the seed whose
    // predecessor still holds the canonical name, so it answers as `corvid-2`
    // and every URL built for it has to follow.
    const dnsName = `${cloud(seed.dns_host ?? seed.name)}.${backend.fleetItem?.tailnet ?? FIXTURE_TAILNET}`;
    /**
     * §8.3: the profile this row is bound to, and the instance slot its key was
     * snapshotted into. A seed with no `profile` is the *legacy* shape — no
     * binding, the fixed `provider-key` slot — which the fixture carries on
     * purpose so both of a reader's paths are on screen.
     */
    const profileId = seed.profile === undefined ? undefined : FIXTURE_PROFILE_IDS[seed.profile];
    const keyed = providerNeedsKey(seed.provider ?? "bedrock");
    const credentialRef =
      profileId === undefined || !keyed
        ? undefined
        : providerKeySlot(profileId, seed.profile_revision ?? FIXTURE_PROFILE_REVISIONS[seed.profile!]);
    // The same slots a real create would have made (§8.1): a keyed provider's
    // API key, and the bws token when Bitwarden was asked for.
    if (keyed) {
      ssm_paths.push(slot(seed.name, credentialRef ?? "provider-key"));
    }
    if ((seed.secrets_mode ?? "none") === "bitwarden") {
      ssm_paths.push(slot(seed.name, "bws-token"));
    }

    backend.volumes.set(volume_id, {
      volume_id,
      size_gib: seed.size === "large" ? 200 : 100,
      state: running ? "in-use" : "available",
      agent: seed.name,
      role: "data",
      fleet_id: fleetId,
      name_tag: `${cloud(seed.name)}-data`,
      // An `in-use` volume is in use *by* something: without the attachment the
      // model says "in-use, attached to nothing", which is a state EC2 never
      // reports and which `volume ls` would have to read as unattached.
      ...(running ? { attached_to: instance_id } : {}),
      az: backend.launchAzId,
      created_at: seed.created_at,
    });
    if (!destroyed) {
      backend.instances.set(instance_id, {
        instance_id,
        state: running ? "running" : "stopped",
        // §5: a `nat` fleet's boxes are launched with no public address at all,
        // so `staging` seeds none. `null` here is the same fact a real
        // `DescribeInstances` reports for an instance in a private subnet.
        public_ip: running && natMode ? null : running ? `203.0.113.${20 + n}` : null,
        // The subnet this fleet launches into, so a seeded fixture starts with
        // every agent *matching* its fleet's mode — drift has to be created by
        // a test, not inherited from the seed (§5).
        subnet_id: (backend.stack?.outputs["SubnetIds"] ?? "").split(",")[0] ?? null,
        agent: seed.name,
        fleet_id: fleetId,
      });
      /**
       * The agent's own slots, filled the way a real create fills them (§8.3):
       * the provider-key slot holds a *copy of the profile's* key, because that
       * is what `snapshotCredential` puts there, and everything else holds the
       * fixture's auth-key sentinel. Seeding the provider slot with the
       * sentinel instead would make `secrets verify` report every bound agent
       * as holding a stale copy of its profile's credential — a rotation the
       * fixture never performed.
       */
      const copied = credentialRef === undefined ? null : slot(seed.name, credentialRef);
      for (const p of ssm_paths) {
        backend.params.set(p, p === copied ? FIXTURE_PROFILE_KEY : `${FIXTURE_TS_KEY}-${seed.name}`);
      }
      backend.objects.set(`config/${seed.name}/${config_hash}.tgz`, new Uint8Array([1, 2, 3]));
      // Every seeded agent has a matching tailscale device, so `doctor` sees no
      // tailscale_missing drift on the baseline fixture (§9). `hostname` is the
      // OS hostname stage 00 set — the agent's own name — and `name` the FQDN
      // the tailnet actually gave the node; for `corvid` those disagree.
      backend.tailscaleDevices?.push({
        id: `nodeFIXTURE${String(n).padStart(6, "0")}`,
        name: dnsName,
        hostname: cloud(seed.name),
        addresses: [`100.64.12.${n}`],
        online: running,
        tags: ["tag:hermetic"],
      });
      /**
       * The predecessor that pushed this node onto a suffixed name: same OS
       * hostname, offline, still holding `<name>.<tailnet>`. It is what
       * `agent recreate corvid` has to delete, so the fixture carries it rather
       * than describing it.
       */
      if (seed.dns_host) {
        backend.tailscaleDevices?.push({
          id: `nodeFIXTURESTALE${String(n).padStart(2, "0")}`,
          name: `${cloud(seed.name)}.${backend.fleetItem?.tailnet ?? FIXTURE_TAILNET}`,
          hostname: cloud(seed.name),
          addresses: [`100.64.12.${200 + n}`],
          online: false,
          tags: ["tag:hermetic"],
        });
      }
    }

    const agent: Agent = {
      name: seed.name,
      status: seed.status,
      version: 7 + n,
      lock: null,
      size: seed.size,
      instance_type: spec.instance_type,
      region,
      instance_id: destroyed ? null : instance_id,
      volume_id,
      volume_gib: seed.size === "large" ? 200 : 100,
      /**
       * `lumen` is the box the root-disk reading exists for — 96% full — so it
       * is the one seeded at the AMI's own floor, where that reading is what
       * actually happens. Everything else takes the default a create would give
       * it today.
       */
      root_gib: seed.root_disk !== undefined && seed.root_disk > 90 ? ROOT_GIB_MIN : DEFAULT_ROOT_GIB,
      hermes_version: seed.hermes,
      hermeticd_version: seed.hermeticd,
      config_hash,
      /**
       * §6.6's config axis, seeded so the fixture can show all three verdicts
       * rather than a fleet that is uniformly `unknown`: a box that has never
       * reported (no heartbeat) stays unknown, one whose reported hash differs
       * is the `drifted` case the skew warning exists for, and everything else
       * agrees with what the fleet rendered for it.
       */
      applied_config_hash:
        seed.heartbeat_age_min === null
          ? null
          : seed.config_drifted
            ? `stale${String(n).padStart(2, "0")}`.padEnd(16, "0")
            : config_hash,
      /**
       * §6.6's release axis, seeded on the same principle as the config axis
       * above: every state the readers can reach should be on screen in
       * `bun run dev:fixture`, not only in a test.
       *
       * A box that has never reported says nothing. One too old to report a
       * digest (`reports_no_digest`) says nothing either, and the rollout calls
       * that *unconfirmed* rather than landed. A box on the published release
       * reports the digest the manifest names, which is what a confirmed
       * landing looks like. Anything else reports a different digest and is a
       * straggler — visibly behind rather than merely unjudgeable.
       */
      running_hermeticd_sha256:
        seed.heartbeat_age_min === null || seed.reports_no_digest
          ? null
          : seed.hermeticd === FIXTURE_HERMETICD_VERSION
            ? FIXTURE_HERMETICD_SHA256
            : FIXTURE_STALE_SHA256,
      /**
       * The box's own answer about Hermes, which for most seeds agrees with the
       * pin beside it. `running_hermes` is the one that does not: the window
       * between `upgrade --hermes` and the recreate that applies it, where the
       * row names a version no box is running.
       */
      running_hermes_version:
        seed.heartbeat_age_min === null ? null : (seed.running_hermes ?? seed.hermes),
      bootstrap: seedBootstrap(seed.hermeticd, Date.parse(seed.created_at) + 60_000, seed.failed_stage),
      command: null,
      provider: seed.provider ?? "bedrock",
      ...(profileId === undefined
        ? {}
        : {
            profile_id: profileId,
            profile_revision: seed.profile_revision ?? FIXTURE_PROFILE_REVISIONS[seed.profile!],
          }),
      ...(credentialRef === undefined ? {} : { credential_ref: credentialRef }),
      ...(seed.pending_profile === undefined
        ? {}
        : {
            pending: {
              profile_id: FIXTURE_PROFILE_IDS[seed.pending_profile],
              profile_revision: FIXTURE_PROFILE_REVISIONS[seed.pending_profile],
              provider: FIXTURE_PROFILE_PROVIDERS[seed.pending_profile],
              model: seed.pending_model ?? "claude-sonnet-5",
              ...(seed.pending_profile === "bedrock"
                ? {}
                : {
                    credential_ref: providerKeySlot(
                      FIXTURE_PROFILE_IDS[seed.pending_profile],
                      FIXTURE_PROFILE_REVISIONS[seed.pending_profile],
                    ),
                  }),
              staged_at: FIXTURE_CONFIG.frozen_at,
              staged_by: actor,
            },
          }),
      secrets_mode: seed.secrets_mode ?? "none",
      // A box that is neither running nor bootstrapping holds no tailnet
      // identity at all: `stop` and `destroy` both null the address, the
      // MagicDNS name and the version together, because the next boot
      // re-registers and may be admitted under a different name (§6.5).
      tailscale_ip: running ? seed.ip : null,
      tailscale_dns_name: running ? dnsName : null,
      // The version gate is narrower than the two above it, and deliberately
      // so. Stage 01 writes the address and the name before hermeticd has ever
      // heartbeated, so a live box that has not yet reported carries an ip and
      // a dns name with an unknown version — a real shape the surfaces have to
      // render. Only a box that has heartbeated has ever said which
      // `tailscaled` it is running.
      tailscale_version: !running || seed.heartbeat_age_min === null ? null : FIXTURE_TAILSCALE_VERSION,
      resources: destroyed
        ? { volume_id, ssm_paths: [] }
        : { volume_id, instance_id, ssm_paths, config_key: `config/${seed.name}/${config_hash}.tgz` },
      last_heartbeat:
        seed.heartbeat_age_min === null
          ? null
          : new Date(nowMs - seed.heartbeat_age_min * 60_000).toISOString(),
      health: seed.health,
      metrics: destroyed
        ? null
        : {
            cpu_pct: seed.cpu,
            mem_pct: seed.mem,
            disk_pct: seed.disk,
            ...(seed.root_disk === undefined ? {} : { root_disk_pct: seed.root_disk }),
            /**
             * The measured free space, on the seeds that report a reading — and
             * deliberately *not* the product of the two numbers above it. A
             * root filesystem carries Canonical's ESP and `bls_boot` partitions
             * plus ext4's own metadata, so the true figure always lands under
             * the estimate: `lumen` at 96% of 8 GiB computes to ≈0.3 GiB and
             * really has 0.25. Seeding the honest number is what lets the
             * fixture show the difference between a reading and a guess, which
             * is the whole reason the field exists.
             */
            ...(seed.root_disk === undefined || seed.root_free_mib === undefined
              ? {}
              : { root_free_mib: seed.root_free_mib }),
          },
      created_by: actor,
      created_at: seed.created_at,
      updated_at: new Date(nowMs - 60_000).toISOString(),
    };
    backend.agents.set(seed.name, agent);

    const created = Date.parse(seed.created_at);
    const history: Array<[string, string, Agent["status"] | null, Agent["status"] | null, number]> = [
      ["create", "requested", null, "creating", 0],
      ["bootstrap", "instance reported bootstrapping", "creating", "bootstrapping", 90_000],
      ["stage", "04-apply ok in 41.2s", null, null, 240_000],
      ["ready", "all bootstrap stages ok", "bootstrapping", "ready", 420_000],
    ];
    for (const [action, detail, from, to, offset] of history) {
      backend.events.push({
        name: seed.name,
        timestamp: new Date(created + offset).toISOString(),
        actor: action === "create" ? actor : `hermeticd/${seed.name}`,
        action,
        from_status: from,
        to_status: to,
        detail,
      });
    }
    if (seed.status === "stopped") {
      backend.events.push({
        name: seed.name,
        timestamp: new Date(nowMs - 86_400_000).toISOString(),
        actor,
        action: "stop",
        from_status: "stopping",
        to_status: "stopped",
        detail: "operator stopped the instance",
      });
    }
    if (destroyed) {
      backend.events.push({
        name: seed.name,
        timestamp: new Date(nowMs - 172_800_000).toISOString(),
        actor,
        action: "destroy",
        from_status: "destroying",
        to_status: "destroyed",
        detail: "destroy complete; data volume kept",
      });
    }
    if (seed.status === "degraded") {
      backend.events.push({
        name: seed.name,
        timestamp: new Date(nowMs - 3_600_000).toISOString(),
        actor: `hermeticd/${seed.name}`,
        action: "health",
        from_status: "ready",
        to_status: "degraded",
        detail: "hermes health check failing",
      });
    }
    if (seed.failed_stage) {
      backend.events.push({
        name: seed.name,
        timestamp: new Date(nowMs - 120_000).toISOString(),
        actor: `hermeticd/${seed.name}`,
        action: "stage",
        from_status: "bootstrapping",
        to_status: "error",
        detail: `${seed.failed_stage.id} failed exit ${seed.failed_stage.exit_code}: ${seed.failed_stage.message}`,
      });
    }
  }

  backend.resetMutations();
  return backend;
}

/**
 * The volumes no agent row explains (§9). Seeded only into the *heads'* fixture
 * (`fixtureBackend`) and never into `seedFixtureFleet`, so every existing test's
 * view of the fleet is unchanged and a test that wants these shapes asks for
 * them by name.
 *
 * The seeded fleet already covers two of the five groups on its own — `attached`
 * for every running agent, `detached` for the stopped ones, and `no_agent` for
 * the destroyed agent that kept its volume. These are the three it cannot
 * produce, because each of them is a volume with no matching row:
 *
 * - a volume whose row is gone entirely, not merely destroyed;
 * - a volume hermetic did not create, unattached in the fleet's own AZ;
 * - two volumes carrying one agent tag and no `role=data` on either, which is
 *   exactly the shape `findVolumeByTag` refuses to guess about (§1).
 */
export function seedFixtureVolumes(backend: MemoryBackend): MemoryBackend {
  const day = 86_400_000;
  const at = (daysAgo: number) => new Date(backend.now().getTime() - daysAgo * day).toISOString();
  /** Every managed volume here is this fleet's; an untagged one is invisible (`inFleet`). */
  const fleet_id = backend.fleetItem?.fleet_id ?? FIXTURE_CONFIG.fleet_id;

  backend.volumes.set("vol-fixture0000000dorado", {
    volume_id: "vol-fixture0000000dorado",
    size_gib: 500,
    state: "available",
    agent: "dorado",
    role: "data",
    fleet_id,
    name_tag: `${cloudName(backend.fleetItem?.fleet_id, "dorado")}-data`,
    az: backend.launchAzId,
    created_at: at(140),
  });
  backend.volumes.set("vol-fixture00000000stray", {
    volume_id: "vol-fixture00000000stray",
    size_gib: 100,
    state: "available",
    agent: null,
    role: null,
    // Not hermetic's at all, so it carries no fleet tag either — it shows up in
    // `listVolumes` because it is `available` and bills, and nowhere else.
    managed: false,
    az: backend.launchAzId,
    created_at: at(9),
  });
  for (const [suffix, days] of [
    ["grovea", 27],
    ["groveb", 4],
  ] as const) {
    backend.volumes.set(`vol-fixture000000${suffix}`, {
      volume_id: `vol-fixture000000${suffix}`,
      size_gib: 100,
      state: "available",
      agent: "grove",
      // Neither carries `role=data`: that missing tag is the whole ambiguity.
      role: null,
      fleet_id,
      az: backend.launchAzId,
      created_at: at(days),
    });
  }

  // The DLM policy keeps seven per volume (§7.1); one is enough to prove the
  // count and the "snapshots are kept" line in the delete confirmation.
  let n = 0;
  for (const volume of backend.volumes.values()) {
    if (volume.role !== "data") continue;
    n += 1;
    const snapshot_id = `snap-fixture${String(n).padStart(10, "0")}`;
    backend.snapshots.set(snapshot_id, {
      snapshot_id,
      volume_id: volume.volume_id,
      size_gib: volume.size_gib,
      started_at: at(0.25),
      tags: { [ROLE_TAG]: ROLE_DATA },
    });
  }
  backend.resetMutations();
  return backend;
}

/**
 * A seeded fixture backend plus its frozen config — one call for heads and
 * tests. `fleet` picks which of `FIXTURE_FLEETS` is seeded; the default is
 * `main`, which is the fleet every test written before this existed means.
 * `account` is the fake account it stands in — the one the head created for
 * the session, so a portal that rebuilds a backend per fleet switch keeps its
 * fleet list — or a fresh populated one when the caller has none to share.
 */
export function fixtureBackend(opts: FixtureSeed & { account?: FixtureAccount | undefined } = {}): {
  backend: MemoryBackend;
  config: LocalConfig;
} {
  const fleet = fixtureFleetName(opts.fleet ?? "main");
  const backend = seedFixtureFleet(
    new MemoryBackend({ account: opts.account ?? createFixtureAccount("seeded") }),
    { fleet, outdated: opts.outdated },
  );
  // The unexplained volumes of §9 are `main`'s story — five groups on one
  // board. `staging` exists to be small, and giving it four volumes no agent
  // row explains would make the two fleets differ in the wrong dimension.
  if (fleet === "main") seedFixtureVolumes(backend);
  return { backend, config: fixtureConfigFor(fleet) };
}
