/**
 * §9 `artifacts push` as a long operation: publish a release, point the fleet
 * at it, and — when the fleet auto-updates hermeticd, or the operator says
 * `--now` — ask every running box to take it at once (§6.5).
 *
 * Two halves with different rules. The push is what it always was: release and
 * pointer both, under the `_fleet` lock for the upload as well as the pointer
 * move, because a release uploaded inside a `foundation.update`'s prune window
 * is deleted out from under the boxes now fetching it. The rollout runs after
 * the lock is given back — it can wait minutes, and holding the fleet lock that
 * long would refuse every agent operation for nothing — and it never fails the
 * push: the release is published whatever the boxes do (`followRelease`).
 * Last, the config phase (`fleet/config-update.ts`) converges every agent
 * whose re-rendered config changed, under the same never-fails rule.
 *
 * `init` publishes through `pushAndPublish` directly and never comes here: a
 * fleet being created has no running box to ask.
 */
import { randomUUID } from "node:crypto";
import {
  ArtifactsPushInput as ArtifactsPushInputSchema,
  autoUpdateHermeticd,
  FLEET_KEY,
} from "../schema/index.ts";
import type { Agent, ArtifactsPushInput, FleetItem, OpEvent } from "../schema/index.ts";
import { checkAbort } from "../abort.ts";
import { ARTIFACTS_VERSION } from "../version.ts";
import { evt } from "../events.ts";
import { LOCK_TTL_MS } from "../fleet/fleet-lock.ts";
import { pushAndPublish } from "../fleet/init-release.ts";
import { followRelease, releaseIdentityOf } from "../fleet/hermeticd-rollout.ts";
import { configUpdate } from "../fleet/config-update.ts";
import { compareBuild } from "../fleet/build-order.ts";
import type { CoreContext } from "../context.ts";
import type { OpOptions } from "../hermetic-deps.ts";
import { readFleetManifest, withFleetLock } from "./artifacts-manifest.ts";
import type { ReleasePushResult } from "./artifacts.ts";

/** What `artifacts.push` needs beyond the shared context (rule 5). */
export interface ArtifactsPushDeps {
  ctx: CoreContext;
  /**
   * How long the rollout watches the fleet land when the request names no
   * `rollout_wait_ms`: the same deployment value `foundation.update` waits
   * (`FoundationDeps.rolloutWaitMs` — ten minutes in real mode, zero in
   * fixtures and tests).
   */
  rolloutWaitMs?: number | undefined;
  rolloutPollMs?: number | undefined;
  /** The config phase's rollout deps (`fleet/config-update.ts`): §8.3's staged-change step and the converge timings. */
  applyPending: (agent: Agent) => Promise<Agent>;
  convergeTimeoutMs?: number | undefined;
  convergePollMs?: number | undefined;
}

/** Where on the progress bar each part sits. */
const PUSH = [0.05, 0.55] as const;
const ROLLOUT = [0.6, 0.8] as const;
const CONFIG = [0.8, 0.99] as const;

export function createArtifactsPush(deps: ArtifactsPushDeps) {
  const { ctx } = deps;

  /**
   * Returns the push's result as the generator's return value, so a caller in
   * the same process (a test, a script) can read the key and digest it
   * published; heads see only the events.
   */
  async function* push(
    input: ArtifactsPushInput = {},
    opts: OpOptions = {},
  ): AsyncGenerator<OpEvent, ReleasePushResult> {
    // The stack the guard just validated, rather than a second read of it: a
    // `DescribeStacks` answering `null` here would land in `resources` as blanks.
    const { fleet, stack } = await ctx.guardFleet();
    const parsed = ArtifactsPushInputSchema.parse(input);
    const { nowIso, backend } = ctx;
    const version = parsed.version ?? ctx.hermeticdVersion;
    yield evt(
      "artifacts",
      PUSH[0],
      `pushing hermeticd ${version}${parsed.path === undefined ? "" : ` from ${parsed.path}`}`,
      nowIso(),
      undefined,
      "start",
    );
    checkAbort(opts.signal, "artifacts");
    const owner = `${await ctx.actor()}#${randomUUID()}`;
    const now = () => backend.clock.now();
    const { pushed, locked, before, unrecorded } = await withFleetLock(
      backend.store.fleet,
      { fleet, owner, ttlMs: LOCK_TTL_MS, now },
      async (locked: FleetItem) => {
        /**
         * What the boxes were told to run before this push, to tell a push
         * that changed something from one that republished the same bytes.
         * Read with the lock held, so no other writer's pointer move can land
         * between this read and the push and be mistaken for ours. Unreadable
         * or refused reads as "nothing" — a push is how either is repaired,
         * and after a repair every box is owed the release.
         */
        const before = await readFleetManifest(backend.artifacts).catch(() => null);
        const pushed = await pushAndPublish(ctx, parsed, locked, stack);
        // An explicit binary or another version is not this build's bundle, so
        // it says nothing about `ARTIFACTS_VERSION` (§6.6).
        if (parsed.path !== undefined || parsed.bytes !== undefined || parsed.version !== undefined) {
          return { pushed, locked, before, unrecorded: false };
        }
        const local = ctx.buildIdentity();
        const written = await backend.store.fleet.updateFleet(
          {
            artifacts_version: ARTIFACTS_VERSION,
            // §6.6: which build last published, beside what it published —
            // never moved backwards, or an older build's next push would read
            // as `same` and push its older config.
            ...(compareBuild(local, locked.published_by) === "older" ? {} : { published_by: local }),
          },
          { now: now(), owner },
        );
        return { pushed, locked, before, unrecorded: written === null };
      },
    );
    yield evt(
      "artifacts",
      PUSH[1],
      `pushed ${pushed.key} (sha256 ${pushed.sha256.slice(0, 12)}…) and ${pushed.stages} stage(s); the fleet manifest names hermeticd ${pushed.version}`,
      nowIso(),
      undefined,
      "done",
    );
    // §3.6 and §7.3: soft by design — the release went up either way.
    if (pushed.mirror_warning !== undefined) {
      yield evt("artifacts", PUSH[1], pushed.mirror_warning, nowIso(), "warn");
    }
    if (pushed.browser_warning !== undefined) {
      yield evt("artifacts", PUSH[1], pushed.browser_warning, nowIso(), "warn");
    }
    // The release is up either way; only the skew band's record of it is missing.
    if (unrecorded) {
      yield evt(
        "artifacts",
        PUSH[1],
        `the release is published, but ${FLEET_KEY} could not record artifacts v${ARTIFACTS_VERSION}; run \`hermetic artifacts push\` again to clear the update notice`,
        nowIso(),
        "warn",
      );
    }

    yield* followRelease(
      { ctx, waitMs: deps.rolloutWaitMs ?? 0, pollMs: deps.rolloutPollMs },
      {
        move: {
          before: before === null ? null : releaseIdentityOf(before.hermeticd),
          after: {
            version: pushed.version,
            generation: pushed.generation,
            // `publishRelease` answers `""` for a release with no binary entry.
            sha256: pushed.sha256 === "" ? null : pushed.sha256,
          },
        },
        options: parsed,
        // From the `_fleet` re-read under the lock: the freshest copy, and the
        // one the manifest just published was derived from.
        autoUpdate: autoUpdateHermeticd(locked.settings),
        phase: "rollout",
        progress: ROLLOUT,
        // Not `artifacts push --now`: that would push again (and may rebuild)
        // when all that is wanted is to ask the boxes for what is published.
        nowCommand: `hermetic upgrade --hermeticd ${pushed.version} --now`,
        signal: opts.signal,
      },
    );
    /**
     * The other half of updating the fleet: every agent whose config this build
     * renders differently converges onto it. After the rollout, so a box that
     * just took the release can apply a config needing it; ordered against the
     * build that published *before* this push (`locked`, read under the lock).
     */
    yield* configUpdate(
      {
        ctx,
        applyPending: deps.applyPending,
        ...(deps.convergeTimeoutMs === undefined ? {} : { convergeTimeoutMs: deps.convergeTimeoutMs }),
        ...(deps.convergePollMs === undefined ? {} : { convergePollMs: deps.convergePollMs }),
      },
      {
        phase: "config",
        progress: CONFIG,
        publishedBefore: locked.published_by,
        rollout: parsed.rollout,
        signal: opts.signal,
      },
    );
    yield evt(
      "done",
      1,
      `hermeticd ${pushed.version} (generation ${pushed.generation}) is the fleet's release`,
      nowIso(),
    );
    return pushed;
  }

  return { push };
}
