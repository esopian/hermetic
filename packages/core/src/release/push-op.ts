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
 *
 * `init` publishes through `pushAndPublish` directly and never comes here: a
 * fleet being created has no running box to ask.
 */
import { randomUUID } from "node:crypto";
import {
  ArtifactsPushInput as ArtifactsPushInputSchema,
  autoUpdateHermeticd,
} from "../schema/index.ts";
import type { ArtifactsPushInput, FleetItem, OpEvent } from "../schema/index.ts";
import { checkAbort } from "../abort.ts";
import { evt } from "../events.ts";
import { LOCK_TTL_MS } from "../fleet/fleet-lock.ts";
import { pushAndPublish } from "../fleet/init-release.ts";
import { followRelease, releaseIdentityOf } from "../fleet/hermeticd-rollout.ts";
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
}

/** Where on the progress bar each half sits. */
const PUSH = [0.05, 0.55] as const;
const ROLLOUT = [0.6, 0.99] as const;

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
    const { pushed, locked, before } = await withFleetLock(
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
        return { pushed: await pushAndPublish(ctx, parsed, locked, stack), locked, before };
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
