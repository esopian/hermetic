/**
 * What every phase of `foundation/` shares: the constants `plan` and `update`
 * agree on, `FoundationDeps`, and the context each module's factory is handed —
 * the backend, the `_fleet` lock, the archive step and the small readers
 * (`versionOf`, `lockIsLive`) that used to be closure variables of one
 * `createFoundation`. The module doc in `index.ts` says why the split exists.
 */
import type { Database } from "bun:sqlite";
import type { GitBuildInfo } from "../../release/git.ts";
import type { Agent, AgentStatus, FleetItem } from "../../schema/index.ts";
import type { FetchLike } from "../../aws/tailscale.ts";
import { HermeticError } from "../../errors.ts";
import type { Backend } from "../../backend/types.ts";
import { createArchive } from "../../agents/archive.ts";
import { LOCK_TTL_MS, createFleetLock } from "../fleet-lock.ts";
import type { FoundationMigration } from "../foundation-migrations.ts";
import { FOUNDATION_VERSION } from "../../version.ts";
import { foundationTemplateSha256 } from "../../aws/cfn-template.ts";
import type { CoreContext } from "../../context.ts";

/**
 * The statuses an agent must not be in for a foundation update to start. Each
 * one is an operation already in flight over that row — a create mid-boot, a
 * destroy mid-terminate — and the update rewrites the release every one of them
 * is about to install (§4.3).
 */
export const TRANSITIONAL: readonly AgentStatus[] = [
  "creating",
  "bootstrapping",
  "stopping",
  "destroying",
];

/** The agents a rollout targets: up, reachable, and running a hermeticd that can take it. */
export const ROLLOUT_STATUSES: readonly AgentStatus[] = ["ready", "degraded"];

/** How often the rollout scans for boxes that have taken the new release. */
export const ROLLOUT_POLL_MS = 10_000;

/** The phase boundaries, so `plan` and `update` agree about where the bar is. */
export const PHASE = {
  preflight: [0, 0.08],
  archive: [0.08, 0.3],
  stack: [0.3, 0.62],
  artifacts: [0.62, 0.76],
  migrate: [0.76, 0.82],
  rollout: [0.82, 0.99],
} as const;

/**
 * What `foundation.*` needs beyond the shared context. Everything past `ctx`
 * is optional and is an override: the version and template this build carries
 * (`FOUNDATION_VERSION`, `foundationTemplateSha256`) so a test can be a build
 * two versions ahead; the advisory GitHub fetch, real by default (rule 6); the
 * lock TTL, so a test can watch a phase outlive it; the local-archive half of
 * an update and the timings a real fleet spends minutes on.
 */
export interface FoundationDeps {
  ctx: CoreContext;
  /** `FOUNDATION_VERSION` unless a test says otherwise. */
  foundationVersion?: number;
  /** `foundationTemplateSha256` unless a test says otherwise. */
  templateSha256?: () => string;
  /**
   * The advisory upstream-Hermes check's way out to GitHub (§6.6): the platform
   * `fetch` unless a test hands in one that reaches nothing.
   */
  hermesFetch?: FetchLike;
  /** `LOCK_TTL_MS` unless a test shortens it. */
  lockTtlMs?: number;
  /** This checkout's commit count and cleanliness, for the plan's release block. */
  git?: () => GitBuildInfo | null;
  /**
   * The build this checkout would push (`artifacts.ts`'s `localBuild`), or
   * `null` when this process cannot say. Defaults to `ctx.localBuild`;
   * overridable so a test can be two different checkouts without compiling.
   */
  localBuild?: () => string | null;
  /** `${hermeticHome}/archive/`; absent ⇒ the local half of the archive is skipped. */
  archiveDir?: string;
  archiveLocalDb?: (path: string) => void;
  /** The open local database, for a migration with a `local` hook. */
  localDb?: Database;
  /**
   * The migration list this build applies. Defaults to `FOUNDATION_MIGRATIONS`;
   * injectable only so a test can exercise a hook, since the shipped list has
   * none. Nothing in production ever passes it.
   */
  migrations?: ReadonlyArray<FoundationMigration>;
  /**
   * How long `rollout` waits for every targeted agent to report the new
   * release. Ten minutes in real mode; **zero** in fixtures and tests, where
   * there is no box to wait for and the wait would only ever be spent.
   */
  rolloutWaitMs?: number;
  rolloutPollMs?: number;
  changeSetPollMs?: number;
  changeSetTimeoutMs?: number;
  /** How often the stack wait says "still updating"; tests shorten it. */
  heartbeatMs?: number;
}

/** The closure state one `createFoundation` call shares across its phases. */
export interface FoundationCtx {
  deps: FoundationDeps;
  core: CoreContext;
  backend: Backend;
  hermeticdVersion: string;
  nowIso: () => string;
  /** `deps.foundationVersion ?? FOUNDATION_VERSION`, resolved once. */
  foundationVersion: number;
  templateSha256: () => string;
  lockTtlMs: number;
  archive: ReturnType<typeof createArchive>["archive"];
  now: () => Date;
  versionOf: (fleet: FleetItem) => number;
  lockIsLive: (fleet: FleetItem, owner?: string) => boolean;
  fleetLock: ReturnType<typeof createFleetLock>;
}

export function createContext(deps: FoundationDeps): FoundationCtx {
  const { ctx: core } = deps;
  const { backend, hermeticdVersion, nowIso } = core;
  const foundationVersion = deps.foundationVersion ?? FOUNDATION_VERSION;
  const templateSha256 = deps.templateSha256 ?? foundationTemplateSha256;
  const lockTtlMs = deps.lockTtlMs ?? LOCK_TTL_MS;
  const { archive } = createArchive({
    backend,
    nowIso,
    archiveDir: deps.archiveDir,
    archiveLocalDb: deps.archiveLocalDb,
  });

  const now = () => backend.clock.now();
  const versionOf = (fleet: FleetItem): number => fleet.foundation_version ?? 0;

  /**
   * The `_fleet` lock (§4.4), shared with `apply` kind `network` — the other op
   * that takes it. `fleet-lock.ts` holds the argument for why a lost lock is a
   * refusal rather than a silent no-op; both callers have to make it the same
   * way, which is why neither of them owns a copy.
   */
  const fleetLock = createFleetLock({
    backend,
    lockTtlMs,
    now,
    rerun: "`hermetic foundation update`",
  });

  /** §4.4 on the `_fleet` item, through the lock this module shares (`fleet-lock.ts`). */
  function lockIsLive(fleet: FleetItem, owner?: string): boolean {
    return fleetLock.isLive(fleet, owner);
  }

  return {
    deps,
    core,
    backend,
    hermeticdVersion,
    nowIso,
    foundationVersion,
    templateSha256,
    lockTtlMs,
    archive,
    now,
    versionOf,
    lockIsLive,
    fleetLock,
  };
}

/** The three readers `plan` and `update` both refuse or prune on. */
export function foundationHelpers(ctx: FoundationCtx) {
  const { backend, now, versionOf, foundationVersion } = ctx;

  /** Release version directories in the bucket, as `artifacts/<version>/` names them. */
  async function releaseVersions(): Promise<string[]> {
    const keys = await backend.artifacts.list("artifacts/");
    const versions = new Set<string>();
    for (const key of keys) {
      const rest = key.slice("artifacts/".length);
      const slash = rest.indexOf("/");
      if (slash > 0) versions.add(rest.slice(0, slash));
    }
    return [...versions].sort();
  }

  function newerError(fleet: FleetItem): HermeticError {
    return new HermeticError(
      "FOUNDATION_NEWER",
      `this fleet's foundation is v${versionOf(fleet)} but this build of hermetic only knows v${foundationVersion}; upgrade hermetic rather than applying an older foundation over a newer one`,
      { fleet: versionOf(fleet), tool: foundationVersion },
    );
  }

  /** One sentence per agent that would make an update unsafe to start. */
  function blockingAgents(agents: readonly Agent[]): string[] {
    const out: string[] = [];
    for (const a of agents) {
      if (TRANSITIONAL.includes(a.status)) {
        out.push(`${a.name} is ${a.status}; an operation is already in flight on it`);
      } else if (a.lock && Date.parse(a.lock.expires) > now().getTime()) {
        out.push(`${a.name} is locked by ${a.lock.owner} until ${a.lock.expires}`);
      }
    }
    return out;
  }

  return { releaseVersions, newerError, blockingAgents };
}
