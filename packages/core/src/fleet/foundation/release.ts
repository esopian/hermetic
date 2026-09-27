/**
 * §6.6 step 4: publish this checkout's release, prune what nothing pins, and
 * rewrite the fleet manifest — with the keep sets read off every live agent's
 * uploaded configuration.
 */
import { z } from "zod";
import { AgentConfig, browserBuildKey, hermesBundleKey, releaseKey } from "../../schema/index.ts";
import type { FleetItem } from "../../schema/index.ts";
import { megabytes } from "../../release/browser-mirror.ts";
import type { StackInfo } from "../../backend/types.ts";
import {
  pushRelease,
  readFleetManifest,
  releaseFiles,
  writeFleetManifest,
} from "../../release/artifacts.ts";
import { ustarEntry } from "../../release/tar.ts";
import type { OpEvent } from "../../schema/index.ts";
import { PHASE, foundationHelpers, type FoundationCtx } from "./shared.ts";
import { evt } from "../../events.ts";
import { BUILD_VERSIONS } from "../../build-versions.ts";

export function createRelease(ctx: FoundationCtx) {
  const { core, backend, hermeticdVersion, nowIso, foundationVersion, templateSha256 } = ctx;
  const { releaseVersions } = foundationHelpers(ctx);

  /**
   * §6.6 step 4: push this checkout's release, prune every release directory
   * that is neither the new one nor the one the fleet was on, and *then* write
   * the manifest — which is the last write of any push (§1), so no box ever
   * follows a pointer to a release that is not fully there.
   *
   * Returns the digest of the binary it just pushed, because `rollout` below
   * has no other way to know what "took the release" looks like: the version
   * label is a constant this build shares with every other build that did not
   * edit it, so the digest is the only thing that distinguishes the release
   * being rolled out from the one it replaces. `null` only if the push somehow
   * recorded no binary, which `pushRelease` refuses to do — handled rather than
   * asserted, because a rollout that cannot verify must say so, not throw.
   */
  async function* pushAndPrune(
    fleet: FleetItem,
    stack: StackInfo,
    keepLock: () => Promise<void>,
  ): AsyncGenerator<OpEvent, string | null> {
    yield evt(
      "artifacts",
      PHASE.artifacts[0],
      `pushing hermeticd ${hermeticdVersion}`,
      nowIso(),
      undefined,
      "start",
    );
    const publish = core.publishDeps();
    /**
     * Read *before* the push: whichever release the live manifest names is one
     * no prune may remove, whatever `_fleet` says. `upgrade --hermeticd V`
     * moves the manifest pointer and writes nothing to `_fleet` (§6.5), so a
     * keep set built from `min_hermetic_version` alone would happily delete the
     * release every box in the fleet is currently fetching.
     */
    const published = await readFleetManifest(backend.artifacts);
    const pointed = published?.hermeticd.version;
    const { files, build, git } = await releaseFiles(publish, {}, hermeticdVersion);
    await keepLock();
    const hermeticd = await pushRelease(backend.artifacts, {
      version: hermeticdVersion,
      files,
      build,
      git,
      now: nowIso(),
    });

    const keep = new Set(
      [hermeticdVersion, fleet.min_hermetic_version, pointed].filter(
        (v): v is string => v !== undefined,
      ),
    );
    const stale = (await releaseVersions()).filter((v) => !keep.has(v));
    for (const version of stale) {
      await keepLock();
      // Version-aware: the bucket is versioned, and a plain delete would leave
      // every byte of the old release behind under a delete marker (§5).
      const removed = await backend.artifacts.purgeByPrefix(releaseKey(version, ""));
      yield evt(
        "artifacts",
        PHASE.artifacts[0] + 0.04,
        `pruned release ${version} (${removed} object version(s))`,
        nowIso(),
      );
    }
    await keepLock();

    /**
     * §3.6's Hermes bundles. Mirror first, then prune — in that order, because
     * the prune's keep set is built around the ref this build pins and a block
     * that never gained it would be emptied by its own keep set.
     *
     * `foundation update` republishes the release and rewrites the manifest, so
     * it is a writer of the mirror block whether it wants to be or not. Until
     * it mirrored, a fleet last pushed from a laptop on a different ref came
     * out of an update with an empty block and no event explaining it: the
     * bundles it had were pruned as stale, the one this build pins was never
     * uploaded, and every box silently went back to cloning github.com. Soft,
     * like every other call: a mirror that cannot be refreshed warns.
     */
    const mirror = await publish.mirrorHermes?.(published?.hermes);
    if (mirror?.warning !== undefined) {
      yield evt("artifacts", PHASE.artifacts[0] + 0.045, mirror.warning, nowIso(), "warn");
    }
    await keepLock();

    /**
     * §7.3's browser, on the same "mirror first, then prune" rule and in the
     * same place for the same reason — this op rewrites the manifest, so it
     * writes the browser block whether it wants to or not, and a block it never
     * refreshed would be emptied by its own keep set.
     *
     * It is also the op that *makes* the browser installable: foundation v14 is
     * what grants the box read on `browser/*`, so the update that applies v14 is
     * exactly the update that should be putting the build there.
     */
    if (publish.mirrorBrowser) {
      yield evt(
        "artifacts",
        PHASE.artifacts[0] + 0.046,
        `mirroring Chrome for Testing ${BUILD_VERSIONS.chrome_ref} (${megabytes(BUILD_VERSIONS.chrome_size)}) into s3://${fleet.bucket}/${browserBuildKey(BUILD_VERSIONS.chrome_ref)}`,
        nowIso(),
      );
    }
    const browserMirror = await publish.mirrorBrowser?.(published?.browser);
    if (browserMirror?.warning !== undefined) {
      yield evt("artifacts", PHASE.artifacts[0] + 0.047, browserMirror.warning, nowIso(), "warn");
    } else if (browserMirror?.status === "present") {
      yield evt(
        "artifacts",
        PHASE.artifacts[0] + 0.047,
        `the fleet bucket already holds Chrome for Testing ${browserMirror.chrome_ref}`,
        nowIso(),
      );
    } else if (browserMirror?.status === "pushed") {
      yield evt(
        "artifacts",
        PHASE.artifacts[0] + 0.047,
        `mirrored Chrome for Testing ${browserMirror.chrome_ref}, verified against this build's pinned digest`,
        nowIso(),
      );
    }
    await keepLock();

    /**
     * The keep set, on the same rule and from the same pre-push read as the
     * release prune above: the ref this build pins, plus the ref every live
     * agent's *uploaded config* pins.
     *
     * Those were treated as one set, on the grounds that every render pins
     * `BUILD_VERSIONS.hermes_ref`. That is true of every render *this checkout*
     * does and says nothing about the objects already in the bucket: a config
     * uploaded by an older laptop names an older ref until something re-renders
     * it, and it is the object the box downloads and installs from. A newer
     * laptop running `foundation update` would have deleted the bundle a live
     * agent's own config names, and the failure would surface as a boot that
     * cannot fetch its Hermes.
     *
     * Read from the config object rather than from the row because the row has
     * no `hermes_ref` column — the open marker beside `renderFor` in
     * `hermetic.ts` is the other half of that — and because the object is the
     * document that actually governs the box.
     */
    const keepRefs = new Set<string>([BUILD_VERSIONS.hermes_ref]);
    /**
     * The browser's keep set, built in the same pass and on the same rule — the
     * build this checkout pins, plus every build a live agent's uploaded
     * configuration names.
     *
     * Same hazard as the Hermes one and a worse outcome: a configuration
     * rendered by an older laptop names the Chrome *that* laptop shipped, and
     * there is no fallback on the box. A newer laptop that pruned it would
     * leave a running agent's next recreate with a browser it cannot fetch and
     * nothing else to try. An older render with no `chrome_ref` at all pins
     * nothing and keeps nothing.
     */
    const keepChrome = new Set<string>([BUILD_VERSIONS.chrome_ref]);
    let unknownRefs: string | null = null;
    for (const agent of await backend.store.agents.scan()) {
      if (agent.status === "destroyed") continue;
      const configKey = agent.resources.config_key;
      /**
       * No config object named at all: a row that has not reached step 5 of
       * §6.2 yet. Nothing has been uploaded, so nothing pins a ref.
       */
      if (configKey === undefined) continue;
      let pinned: { hermes: string | null; chrome: string | null };
      try {
        // One read, both answers: the two keep sets are about the same document.
        pinned = refsOfConfig(await backend.artifacts.getObject(configKey));
      } catch (e) {
        /**
         * A read that *failed* — credentials, a bucket policy, a 503 — is not
         * evidence that nothing pins the ref, so nothing is pruned on this
         * update at all. A missing object (`getObject` answers `null`, not a
         * throw) is different and handled below: the config is gone, so no box
         * is installing from whatever it named.
         */
        unknownRefs = `could not read ${agent.name}'s configuration (${e instanceof Error ? e.message : String(e)})`;
        break;
      }
      if (pinned.hermes !== null) keepRefs.add(pinned.hermes);
      if (pinned.chrome !== null) keepChrome.add(pinned.chrome);
    }
    if (unknownRefs !== null) {
      yield evt(
        "artifacts",
        PHASE.artifacts[0] + 0.05,
        `${unknownRefs}; leaving every mirrored hermes in place rather than risk deleting one an agent installs from`,
        nowIso(),
        "warn",
      );
    }

    const hermes = { ...(published?.hermes ?? {}), ...(mirror?.block ?? {}) };
    // Nothing at all is pruned on an update that could not read a config: the
    // one ref it failed to learn may be the one it is about to delete.
    const prunable = unknownRefs === null ? Object.keys(hermes) : [];
    for (const ref of prunable) {
      if (keepRefs.has(ref)) continue;
      await keepLock();
      const removed = await backend.artifacts.purgeByPrefix(hermesBundleKey(ref));
      delete hermes[ref];
      yield evt(
        "artifacts",
        PHASE.artifacts[0] + 0.05,
        `pruned the mirrored hermes ${ref} (${removed} object version(s))`,
        nowIso(),
      );
    }
    if (Object.keys(hermes).length === 0) {
      yield evt(
        "artifacts",
        PHASE.artifacts[0] + 0.055,
        "this fleet's manifest now names no mirrored hermes, so agents will clone it from GitHub " +
          "at boot; run `hermetic artifacts push` from a laptop that can reach GitHub to restore it",
        nowIso(),
        "warn",
      );
    }

    /**
     * The browser prune, on the keep set built above and gated twice.
     *
     * The first gate is the unknown-config rule the Hermes prune follows: a
     * config this update could not read may be the one pinning the build it is
     * about to delete, and a deleted build is a browser agent that cannot be
     * recreated.
     *
     * The second is this op's own mirror step. `keepChrome` starts from the
     * build *this checkout pins*, which is only a safe thing to keep alone
     * because the mirror above has just put it in the bucket. When the mirror
     * did not run — no step wired, or the CDN unreachable, which is `skipped` —
     * that is false, and on a bumped `chrome_ref` the keep set then holds
     * exactly one ref that does not exist while the build the fleet is actually
     * running is in neither it nor any agent's config yet. Pruning there deletes
     * the only browser the fleet has, and unlike `hermes/` — which the box falls
     * back to cloning from GitHub — there is nothing else to install from. So a
     * mirror that did not succeed prunes nothing at all.
     */
    const browser = { ...(published?.browser ?? {}), ...(browserMirror?.block ?? {}) };
    const browserMirrored = browserMirror?.status === "present" || browserMirror?.status === "pushed";
    if (!browserMirrored) {
      yield evt(
        "artifacts",
        PHASE.artifacts[0] + 0.0555,
        "the browser mirror did not run, so every mirrored browser build is left in place rather " +
          "than risk deleting the one this fleet installs from",
        nowIso(),
      );
    }
    const prunableChrome = unknownRefs === null && browserMirrored ? Object.keys(browser) : [];
    for (const ref of prunableChrome) {
      if (keepChrome.has(ref)) continue;
      await keepLock();
      const removed = await backend.artifacts.purgeByPrefix(browserBuildKey(ref));
      delete browser[ref];
      yield evt(
        "artifacts",
        PHASE.artifacts[0] + 0.056,
        `pruned the mirrored browser (Chrome for Testing ${ref}, ${removed} object version(s))`,
        nowIso(),
      );
    }
    if (Object.keys(browser).length === 0) {
      yield evt(
        "artifacts",
        PHASE.artifacts[0] + 0.057,
        "this fleet's manifest now names no mirrored browser, so `--browser` agents have nothing " +
          "to install; run `hermetic artifacts push` from a laptop that can reach " +
          "cdn.playwright.dev to restore it",
        nowIso(),
        "warn",
      );
    }
    await keepLock();

    await writeFleetManifest(backend.artifacts, {
      fleet,
      stack,
      hermeticd,
      updatedBy: await core.actor(),
      updatedAt: nowIso(),
      foundation: {
        version: foundationVersion,
        template_sha256: templateSha256(),
        applied_at: nowIso(),
        applied_by: await core.actor(),
      },
      // Carried over, minus whatever the prune above removed: this rewrite is
      // about the release and the foundation stamp, and a fleet's Hermes mirror
      // must not disappear because its foundation was updated (§3.6).
      hermes,
      // And its browser, on the same terms (§7.3).
      browser,
    });
    yield evt(
      "artifacts",
      PHASE.artifacts[1],
      `the fleet manifest names hermeticd ${hermeticdVersion} and foundation v${foundationVersion}; kept ${[...keep].sort().join(" and ")}`,
      nowIso(),
      undefined,
      "done",
    );
    return hermeticd.files["hermeticd"]?.sha256 ?? null;
  }

  return { pushAndPrune };
}

/**
 * The `hermes_ref` and `chrome_ref` an agent's uploaded config pins, each
 * `null` when there is no object or nothing in it that answers.
 *
 * The object is the gzipped ustar the box downloads and unpacks (§6.2 step 5),
 * with `manifest.json` at its root — so this reads the same document hermeticd
 * reads, which is the whole point of consulting it rather than the row. A
 * tarball that does not unpack, or a manifest that does not validate, answers
 * `null` for both; only an S3 read that *throws* is a read failure, and that is
 * the caller's to catch.
 *
 * `chrome_ref` is read through a schema of its own rather than off the parsed
 * `AgentConfig`, because a configuration written before that field existed is a
 * perfectly valid one that simply pins no browser — and the keep set has to
 * read it as "nothing to keep" rather than as a config it could not parse.
 */
function refsOfConfig(bytes: Uint8Array | null): { hermes: string | null; chrome: string | null } {
  const none = { hermes: null, chrome: null };
  const parsed = configManifestOf(bytes);
  if (parsed === null) return none;
  const config = AgentConfig.safeParse(parsed);
  if (!config.success) return none;
  const chrome = ConfigChromeRef.safeParse(parsed);
  return {
    hermes: config.data.hermes_ref,
    chrome: chrome.success ? (chrome.data.chrome_ref ?? null) : null,
  };
}

/** Just the field the browser keep set needs, from a config that has one. */
const ConfigChromeRef = z.object({ chrome_ref: z.string().min(1).optional() });

/**
 * `manifest.json` out of a config tarball, parsed as JSON and not yet
 * validated, or `null` when the object is absent or is not one.
 */
function configManifestOf(bytes: Uint8Array | null): unknown {
  if (bytes === null) return null;
  let manifest: Uint8Array | null;
  try {
    // Copied rather than passed through: `getObject` hands back a view over
    // whatever buffer the SDK read into, and `gunzipSync` wants its own.
    manifest = ustarEntry(Bun.gunzipSync(new Uint8Array(bytes)), "manifest.json");
  } catch {
    return null;
  }
  if (manifest === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(manifest));
  } catch {
    return null;
  }
  return parsed;
}
