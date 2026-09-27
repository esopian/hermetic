/**
 * How a release is laid out in the fleet bucket (§3.6, §4.2): the prefixes,
 * the key scheme, what counts as an object of one release, the mirrored
 * browser build's key, and the stage-file naming hermeticd orders a boot by.
 *
 * Pure values only — no Zod, no `node:*`, nothing that opens a file or a
 * socket — because `shared/index.ts` re-exports from here into the browser and
 * the box. The Zod schemas that validate these shapes live in `schema/*`, which
 * imports this module, never the reverse (`packages/core/test/shared-browser-safe.test.ts`).
 */

/** The bucket prefix every release object lives under. Nothing else may. */
export const RELEASE_PREFIX = "artifacts/";
/** Where the fleet manifest lives in the bucket. Written LAST by every push. */
export const FLEET_MANIFEST_KEY = "manifest.json";

/**
 * The one place the release key scheme is written down:
 * `artifacts/<version>/<generation>/…` for the binary (`hermeticd`), every
 * stage (`stages/NN-<name>.sh`) and the generation manifest (`release.json`).
 *
 * The generation is what makes a release *immutable*. A version label is a
 * constant this build shares with every other build that did not edit it, so
 * two pushes of "0.5.0" used to write the same keys: the second overwrote the
 * first in place, and an interrupted second push left new stages sitting beside
 * the old binary under keys a previously issued bootstrap URL still pointed at.
 * A generation is derived from the digests of the files in it, so a push whose
 * content differs lands somewhere else by construction and a push whose content
 * is identical is genuinely idempotent.
 *
 * `generation` is optional, and omitting it yields the flat pre-generation key.
 * Two callers need that: a release pushed by an older hermetic, which is still
 * in buckets and still has to be readable, and `releaseKey(version, "")`, which
 * is the version prefix the §6.6 prune deletes — generations and all.
 */
export function releaseKey(version: string, file: string, generation?: string): string {
  const scope = generation === undefined || generation === "" ? "" : `${generation}/`;
  return `${RELEASE_PREFIX}${version}/${scope}${file}`;
}

/**
 * True when `key` could name an object inside release `version`. Both sides of
 * the fleet manifest check it before acting on a key it records: the manifest
 * is a document the laptop writes and the box obeys, and "fetch exactly what
 * the manifest says" must not become "fetch any key in the bucket the manifest
 * says", which would let one bad manifest point hermeticd at a config tarball
 * or a Hermes bundle and run it as a stage, or have `create` mint a one-hour
 * bearer URL for another agent's config into a booting instance's user-data.
 *
 * Scoped to the release the manifest claims, not merely to `artifacts/`: a
 * manifest that says it publishes `0.5.0` while naming objects under `0.1.0` is
 * describing two releases at once, and the honest answer to which one the fleet
 * is on is neither.
 *
 * `generation` is the same argument one level down, and it is the level that
 * matters now that a version holds more than one release. A manifest claiming
 * generation B while naming generation A's binary is as much a description of
 * two releases as one crossing a version boundary, and it is the easier of the
 * two to write by accident: both keys are under the version the manifest names,
 * both digests are of real objects in the bucket, and nothing else in the
 * manifest would notice. Pass the generation the manifest records and the
 * prefix pins it. Pass nothing — a manifest written before generations existed,
 * or `describeRelease`'s flat fallback — and the check stays at the version, so
 * the pre-generation layout every old bucket still holds keeps working.
 */
export function isReleaseObjectKey(key: string, version: string, generation?: string): boolean {
  const prefix = releaseKey(version, "", generation);
  if (!key.startsWith(prefix)) return false;
  const rest = key.slice(prefix.length);
  if (rest.length === 0 || rest.startsWith("/")) return false;
  return !rest.split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}
/**
 * Where the mirrored browser lives: `browser/chrome-linux-arm64-<ref>.zip` at
 * the bucket root, deliberately **outside** `artifacts/`, for exactly the
 * reason `hermes/` is.
 *
 * The §6.6 release prune deletes every `artifacts/<version>/` prefix outside its
 * keep set, and a live agent can be pinned to a `chrome_ref` far older than any
 * kept hermeticd release — filing the build under a release would let a
 * hermeticd upgrade delete the browser a running agent reinstalls from.
 * Different lifetime, different prefix.
 */
export const BROWSER_BUILD_PREFIX = "browser/";

/** The architecture the fleet boots, and the only build hermetic mirrors (§7.1). */
const BROWSER_BUILD_PLATFORM = "chrome-linux-arm64";

/** The one place the browser build key scheme is written down. */
export function browserBuildKey(chromeRef: string): string {
  return `${BROWSER_BUILD_PREFIX}${BROWSER_BUILD_PLATFORM}-${chromeRef}.zip`;
}

/**
 * A Chrome for Testing build number: dotted digits, as the CDN publishes them
 * (`153.0.8010.12`). It becomes an object key, a URL path segment and a
 * directory name on the box, and none of those is a place to discover it was
 * something else.
 */
export const CHROME_REF_RE = /^[0-9]+(?:\.[0-9]+)*$/;

/** `true` when `ref` is safe to put in a key, a URL and a path. */
export function isChromeRef(ref: string): boolean {
  return CHROME_REF_RE.test(ref);
}

/**
 * A bootstrap stage file name: a two-digit ordinal, a lowercase-hyphen name and
 * `.sh`. The ordinal is the run order and must be unique within a release.
 */
export const STAGE_FILE_RE = /^(\d{2})-([a-z0-9-]+)\.sh$/;

/**
 * Validates a release's stage file names — non-empty, shape, and no duplicate
 * ordinal — and returns them sorted by ordinal. Throws `Error` with a message
 * naming the offending file(s); core wraps it in a `HermeticError`, and
 * hermeticd refuses to run a release that fails it before any stage executes
 * (§4.2).
 *
 * An *empty* set is a failure, not a trivially valid one: a release with no
 * stages boots nothing, and the shape it takes — a binary with no stages beside
 * it — is exactly what an interrupted push leaves behind.
 */
export function orderStages(names: readonly string[]): string[] {
  if (names.length === 0) {
    throw new Error("a release has no stages; it would boot nothing");
  }
  const byOrdinal = new Map<string, string>();
  for (const name of names) {
    const ordinal = STAGE_FILE_RE.exec(name)?.[1];
    if (ordinal === undefined) {
      throw new Error(`invalid stage file name ${JSON.stringify(name)}: expected NN-<name>.sh`);
    }
    const seen = byOrdinal.get(ordinal);
    if (seen !== undefined) {
      throw new Error(`duplicate stage ordinal ${ordinal}: ${seen} and ${name}`);
    }
    byOrdinal.set(ordinal, name);
  }
  return [...byOrdinal.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, name]) => name);
}
