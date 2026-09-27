/**
 * `init`'s release step (§3.6/§1): find this build's hermeticd before the first
 * mutation, and put it in the fleet's bucket — or leave a newer one alone —
 * once the fleet exists.
 */
import { compareVersions } from "../schema/index.ts";
import type { ArtifactsPushInput, FleetItem, OpEvent } from "../schema/index.ts";
import { HermeticError } from "../errors.ts";
import {
  HERMETICD_ENV,
  publishRelease,
  readFleetManifest,
  writeFleetManifest,
  type HermeticdCandidate,
  type ReleasePushResult,
} from "../release/artifacts.ts";
import type { CallerIdentity, StackInfo } from "../backend/types.ts";
import type { CoreContext } from "../context.ts";
import { evt } from "../events.ts";
import type { InitDeps } from "./init-run.ts";

/**
 * §3.6/§1: put this build's release in the fleet's bucket and point the fleet
 * manifest at it. One call, because a release nothing names is invisible and
 * a manifest naming a release that is not there boots nothing. `init` runs it
 * before a config row exists and takes no lock; `artifacts push` takes the
 * `_fleet` lock around it (`hermetic.ts`).
 */
export async function pushAndPublish(
  ctx: Pick<CoreContext, "publishDeps" | "actor" | "nowIso">,
  input: ArtifactsPushInput,
  fleet: FleetItem,
  stack: StackInfo,
): Promise<ReleasePushResult> {
  return publishRelease(ctx.publishDeps(), input, {
    fleet,
    stack,
    updatedBy: await ctx.actor(),
    updatedAt: ctx.nowIso(),
  });
}

/**
 * §3.6/§1: hermeticd and its stages come only from the fleet's bucket, so
 * `init` puts this build's release there and points `manifest.json` at it.
 * Idempotent — a release already in the bucket is re-published only to move
 * the pointer, which is why attaching to a healthy fleet is cheap.
 */
export async function* ensureRelease(
  deps: InitDeps,
  id: CallerIdentity,
  progress: number,
  hermeticd: HermeticdCandidate | null,
  skipped: boolean,
  fleet: FleetItem,
  stack: StackInfo,
): AsyncIterable<OpEvent> {
  const { backend, hermeticdVersion, nowIso } = deps.ctx;
  /**
   * Already published, or published *ahead* of this laptop: either way the
   * release is not re-uploaded, and the pointer is not moved.
   *
   * The comparison is by version order, not equality, because the
   * dangerous case is an older laptop attaching to a fleet someone else has
   * already upgraded: repointing the manifest at the release *this* build
   * ships would downgrade every box in the fleet on its next nightly
   * update, from a command whose whole purpose is to be safe to run when
   * something is already wrong. Moving a fleet backwards is a
   * deliberate act, and it has a command of its own.
   *
   * The manifest is still rewritten in both cases: `resources` is the half
   * that goes stale — a stack updated since the last push, or a manifest
   * written by a build that recorded fewer outputs — and it is where the
   * box reads its table names. `putObject` is a no-op when the bytes are
   * unchanged, so attaching to a fleet that is already correct still
   * mutates nothing.
   */
  const published = await readFleetManifest(backend.artifacts);
  const order = published ? compareVersions(published.hermeticd.version, hermeticdVersion) : -1;
  if (published && order >= 0) {
    await writeFleetManifest(backend.artifacts, {
      fleet,
      stack,
      hermeticd: published.hermeticd,
      updatedBy: id.arn,
      updatedAt: nowIso(),
      // Carried over, never rebuilt: this branch refreshes `resources` and
      // nothing else, and a fleet's Hermes mirror is not this laptop's to
      // forget because it attached (§3.6).
      ...(published.hermes === undefined ? {} : { hermes: published.hermes }),
      // Its mirrored browser likewise (§7.3), and with a worse consequence
      // for dropping it: there is no fallback on the box.
      ...(published.browser === undefined ? {} : { browser: published.browser }),
    });
    yield evt(
      "artifacts",
      progress,
      order === 0
        ? `the fleet manifest already names hermeticd ${hermeticdVersion}; refreshed its resources from ${stack.stack_name}`
        : `this fleet runs hermeticd ${published.hermeticd.version}, newer than the ${hermeticdVersion} this hermetic ships; not repointing it backwards — upgrade hermetic, or run \`hermetic upgrade --hermeticd ${hermeticdVersion}\` if you mean to move the fleet back`,
      nowIso(),
      order === 0 ? undefined : "warn",
    );
    return;
  }
  if (skipped || (hermeticd === null && deps.ctx.fixture === false)) {
    yield evt(
      "artifacts",
      progress,
      `hermeticd ${hermeticdVersion} was not published; no agent can launch until \`hermetic artifacts push\` runs`,
      nowIso(),
      "warn",
    );
    return;
  }
  yield evt(
    "artifacts",
    progress - 0.02,
    `pushing hermeticd ${hermeticdVersion}${hermeticd ? ` from ${hermeticd.path}` : ""}`,
    nowIso(),
    undefined,
    "start",
  );
  const pushed = await pushAndPublish(
    deps.ctx,
    { version: hermeticdVersion, ...(hermeticd ? { path: hermeticd.path } : {}) },
    fleet,
    stack,
  );
  yield evt(
    "artifacts",
    progress,
    `pushed ${pushed.key} (sha256 ${pushed.sha256.slice(0, 12)}…) and ${pushed.stages} stage(s); the fleet manifest names ${pushed.version}`,
    nowIso(),
    undefined,
    "done",
  );
  /**
   * §3.6: the Hermes mirror is pushed by the same step, and its failure is
   * soft — the fleet is perfectly usable, its boxes just clone Hermes from
   * github.com at boot. Said out loud so an operator knows which of the two
   * it got.
   */
  if (pushed.mirror_warning !== undefined) {
    yield evt("artifacts", progress, pushed.mirror_warning, nowIso(), "warn");
  }
  /**
   * §7.3's browser mirror, beside it and soft for the same reason — but not
   * the same consequence. A fleet without its Hermes bundle boots more
   * slowly; a fleet without its browser build cannot run a `--browser`
   * agent at all, so it is worth saying separately rather than folding into
   * one "the mirror failed".
   */
  if (pushed.browser_warning !== undefined) {
    yield evt("artifacts", progress, pushed.browser_warning, nowIso(), "warn");
  }
}

/**
 * §3.6, before the first mutation: a fleet whose bucket will never hold
 * `hermeticd` cannot launch an agent, so not having the binary is found out
 * here — where nothing has been created yet — rather than as a warning at
 * the end. On a source checkout this may compile it, which is why the
 * phase announces itself first.
 */
export async function* locateHermeticd(
  deps: InitDeps,
  skipped: boolean,
  required: boolean,
): AsyncGenerator<OpEvent, HermeticdCandidate | null> {
  const { hermeticdVersion, nowIso } = deps.ctx;
  const publish = deps.ctx.publishDeps();
  if (skipped) {
    yield evt(
      "preflight",
      0.33,
      "artifact push skipped (--skip-artifacts); push hermeticd before the first agent",
      nowIso(),
      "warn",
    );
    return null;
  }
  if (publish.hermeticdPath !== undefined) {
    // No stamps read for a path the caller named: `releaseFiles` looks for
    // both beside it when the push actually happens (§3.6).
    return { path: publish.hermeticdPath, source: "explicit", version: null, build: null };
  }
  if (deps.ctx.fixture) return null;
  yield evt(
    "preflight",
    0.33,
    `locating hermeticd ${hermeticdVersion} (a source checkout compiles it for linux-arm64 the first time)`,
    nowIso(),
    undefined,
    "start",
  );
  const found = (await publish.resolveHermeticd?.()) ?? null;
  if (!found && !required) {
    // Attach is the recovery path; a laptop without the binary may
    // still re-bind to its fleet, whose bucket most likely has one already.
    yield evt(
      "preflight",
      0.34,
      `no hermeticd ${hermeticdVersion} on this machine to push; attaching anyway`,
      nowIso(),
      "warn",
    );
    return null;
  }
  if (!found) {
    throw new HermeticError(
      "HERMETICD_UNAVAILABLE",
      `no hermeticd ${hermeticdVersion} to push, so the fleet could never launch an agent. Set ${HERMETICD_ENV}=/path/to/hermeticd, run a build that ships one next to this executable, or run from a source checkout; or pass --skip-artifacts and push later.`,
      { version: hermeticdVersion, env: HERMETICD_ENV },
    );
  }
  yield evt(
    "preflight",
    0.34,
    `hermeticd ${hermeticdVersion} ready to push (${found.source}: ${found.path})`,
    nowIso(),
    undefined,
    "done",
  );
  return found;
}
