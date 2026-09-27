/**
 * §3.6: how this build publishes a release — the Hermes and browser mirrors
 * with this build's pins bound, and the `PublishDeps` closure `publishRelease`
 * takes. Built once per `createHermetic` and read through `ctx.publishDeps`
 * by `init`, `artifacts push`, `foundation.update` and `network`.
 *
 * Real mode mirrors for real; fixture mode puts a stand-in bundle in its
 * in-memory bucket and never spawns git. Neither ever throws — a mirror that
 * could not be refreshed is a warning and a manifest left as it was. The
 * mirrors default to the *real* ones rather than to "skip" (rule 6): an
 * absent dependency must not be able to quietly stop a fleet's bundles being
 * refreshed, leaving every box back on the direct clone.
 */
import type { Backend } from "../backend/types.ts";
import { BUILD_VERSIONS } from "../build-versions.ts";
import type { HermeticDeps } from "../hermetic-deps.ts";
import type { PublishDeps } from "./artifacts.ts";
import { browserMirrorFor, browserMirrorStep } from "./browser-mirror.ts";
import {
  defaultMirrorDir,
  ensureHermesMirror,
  fixtureHermesMirror,
  spawnGit,
  type HermesMirrorFn,
  type HermesMirrorStep,
} from "./hermes-mirror.ts";

export function createPublisher(
  deps: Pick<
    HermeticDeps,
    | "hermesMirror"
    | "browserMirror"
    | "mirrorDir"
    | "hermeticdPath"
    | "resolveHermeticd"
    | "git"
    | "allowDirty"
  >,
  build: { backend: Backend; fixture: boolean; hermeticdVersion: string },
): { hermesMirror: HermesMirrorFn; publishDeps: () => PublishDeps } {
  const { backend, fixture, hermeticdVersion } = build;
  const hermesMirror: HermesMirrorFn =
    deps.hermesMirror ??
    (fixture
      ? (input) => fixtureHermesMirror(backend.artifacts, input)
      : (input) =>
          ensureHermesMirror(
            {
              artifacts: backend.artifacts,
              mirrorDir: deps.mirrorDir ?? defaultMirrorDir(),
              git: spawnGit,
            },
            { ref: input.ref, existing: input.existing },
          ));
  /** The same step with this build's ref bound, which is what a push takes. */
  const mirrorHermes: HermesMirrorStep = (existing) =>
    hermesMirror({ ref: BUILD_VERSIONS.hermes_ref, existing });
  /** §7.3's, defaulted the same way and with this build's pin already bound. */
  const mirrorBrowser = browserMirrorStep(
    deps.browserMirror ?? browserMirrorFor({ artifacts: backend.artifacts, fixture }),
    BUILD_VERSIONS,
  );

  /**
   * What `publishRelease` needs from the SDK. It skips `guardFleet` because
   * `init` runs it before a config row exists. Built per call so it always
   * reads the current `hermeticd` path and mirrors.
   */
  const publishDeps = (): PublishDeps => ({
    artifacts: backend.artifacts,
    hermeticVersion: hermeticdVersion,
    fixture,
    mirrorHermes,
    mirrorBrowser,
    hermeticdPath: deps.hermeticdPath,
    resolveHermeticd: deps.resolveHermeticd,
    git: deps.git,
    allowDirty: deps.allowDirty,
  });

  return { hermesMirror, publishDeps };
}
