/**
 * A *release* — the compiled `hermeticd` and the ordered bootstrap stages it
 * runs — and everything that puts one in a fleet bucket (§1, §3.6). One owner:
 * `locateRelease` finds it on this laptop, `pushRelease` uploads it and returns
 * the digests, `writeFleetManifest` publishes the pointer, `readFleetManifest`
 * reads it back, and `describeRelease` recovers the digests of a release that
 * was pushed by some other laptop.
 *
 * The fleet manifest (`manifest.json` at the root of the bucket) is always the
 * *last* write of a push: until it moves, every box is still running the release
 * it names, and a half-uploaded one is invisible.
 *
 * Finding the release on this laptop — the binary, its stamps, the stages —
 * lives in `artifacts-release.ts`; the fleet manifest and the lock that guards
 * it in `artifacts-manifest.ts`. This module is the two halves that touch the
 * bucket: `pushRelease` and `describeRelease` over the release objects, and
 * `publishRelease`, the whole operation `init` and `artifacts push` run.
 *
 * No `console.*`, no `process.exit` (§3.2 rule 1): a build failure is a
 * `HermeticError` whose details carry the compiler's last lines.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HermeticError } from "../errors.ts";
import { allowDirtyFromEnv, assertCleanTree, gitBuildInfo, type GitBuildInfo } from "./git.ts";
import {
  AGENT_CAPABILITY_LIST,
  RELEASE_MANIFEST_NAME,
  ReleaseManifest as ReleaseManifestSchema,
  isReleaseObjectKey,
  orderStages,
  releaseKey,
} from "../schema/index.ts";
import type { FleetItem, FleetManifest, FleetManifestFile, ReleaseManifest } from "../schema/index.ts";
import type { ArtifactsApi, StackInfo } from "../backend/types.ts";
import type { HermesMirrorStep } from "./hermes-mirror.ts";
import type { BrowserMirrorStep } from "./browser-mirror.ts";
import {
  HERMETICD_ENV,
  STAGES_ENV,
  buildStampOf,
  findRepoRoot,
  locateStages,
  type HermeticdCandidate,
  type ReleaseLocation,
} from "./artifacts-release.ts";
import {
  carriedBlocks,
  laterFoundation,
  manifestFoundationOf,
  writeFleetManifest,
} from "./artifacts-manifest.ts";

// The public surface of the two sibling modules, so every importer keeps
// reading it from here (`index.ts` re-exports this module whole).
export {
  AGENTD_ENTRY,
  AGENTD_OUT,
  AGENTD_STAGES,
  AGENTD_TARGET,
  HERMETICD_ENV,
  STAGES_ENV,
  buildHermeticd,
  findRepoRoot,
  localBuild,
  locateRelease,
  locateStages,
  releaseDrift,
  resolveHermeticd,
  sourceFingerprint,
  type BuildRequest,
  type HermeticdCandidate,
  type LocateOptions,
  type ReleaseLocation,
  type ResolveHermeticdOptions,
  type StagesLocation,
} from "./artifacts-release.ts";
export {
  fleetManifestFrom,
  laterFoundation,
  manifestFoundationOf,
  pointFleetAt,
  readFleetManifest,
  recordHermesMirror,
  withFleetLock,
  writeFleetManifest,
  type FleetLockStore,
  type FleetManifestInput,
} from "./artifacts-manifest.ts";

/**
 * The content types a release is published with — one constant per kind rather
 * than a literal at each upload site.
 *
 * They are not decoration: `releaseGeneration` digests the content type beside
 * the name and the bytes, so two writers that disagree about them compute two
 * different generations for the same release. That is exactly how the fixture
 * seed and the fixture push came apart — the seed omitted them entirely, so one
 * `artifacts push` in `dev:fixture` invented a second generation beside the one
 * it was supposed to land on. Sharing the constants makes the disagreement
 * impossible to write rather than merely tested for.
 */
export const RELEASE_BINARY_CONTENT_TYPE = "application/octet-stream";
export const RELEASE_STAGE_CONTENT_TYPE = "text/x-shellscript";

/** One file of a release, in memory, keyed by its release-relative name. */
export interface ReleaseFile {
  /** `hermeticd`, or `stages/01-tailscale.sh`. */
  name: string;
  bytes: Uint8Array;
  contentType: string;
}

function read(path: string): Uint8Array {
  try {
    return new Uint8Array(readFileSync(path));
  } catch (e) {
    throw new HermeticError("NOT_FOUND", `could not read ${path}`, {
      path,
      cause: e instanceof Error ? e.message : String(e),
    });
  }
}

/** Load a located release off disk, ready to push. */
export function readRelease(location: ReleaseLocation): ReleaseFile[] {
  const files: ReleaseFile[] = [
    {
      name: "hermeticd",
      bytes: read(location.hermeticd.path),
      contentType: RELEASE_BINARY_CONTENT_TYPE,
    },
  ];
  for (const stage of location.stages?.names ?? []) {
    files.push({
      name: `stages/${stage}`,
      bytes: read(join(location.stages!.dir, stage)),
      contentType: RELEASE_STAGE_CONTENT_TYPE,
    });
  }
  return files;
}

function digestOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The stage file names of a release, in the order they run. */
function stageNames(files: readonly { name: string }[]): string[] {
  return files.filter((f) => f.name.startsWith("stages/")).map((f) => f.name.slice("stages/".length));
}

/**
 * The generation id of a set of release files: the first 16 hex digits of a
 * digest over every file's name, content type and content digest, in name
 * order.
 *
 * It is what makes a release an *immutable generation*. Identical bytes always
 * produce the same id, so a republish of an unchanged checkout writes the same
 * keys with the same content and is genuinely idempotent; a single changed byte
 * anywhere in the binary or in any stage produces a different id, so the new
 * release cannot land on top of the old one even though both call themselves
 * the same version.
 *
 * The content *type* is in the digest because it is part of the object a push
 * writes and part of what a fetch gets back. A build that started serving the
 * stages as `application/octet-stream` would otherwise write a different object
 * to a key a published generation already names, which is the one thing a
 * generation exists to forbid.
 *
 * Sixteen hex digits is 64 bits over the releases one fleet holds, not a global
 * namespace. Collision is not the failure being defended against here; silent
 * overwrite is.
 */
export function releaseGeneration(
  files: readonly { name: string; sha256: string; contentType?: string | undefined }[],
): string {
  const hash = createHash("sha256");
  const ordered = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const file of ordered)
    hash.update(`${file.name}\u0000${file.contentType ?? ""}\u0000${file.sha256}\n`);
  return hash.digest("hex").slice(0, 16);
}

/**
 * Upload every file of a release under `artifacts/<version>/<generation>/` and
 * return the `hermeticd` half of a `FleetManifest` — the version, the
 * generation, and every file's key, digest and size. It writes no fleet
 * pointer: `writeFleetManifest` does that, after this has returned, so a
 * half-uploaded release is never named by one.
 *
 * **The generation is the invariant.** It used to be the ordering — stages
 * first, binary last — and the ordering is still kept, but it could not carry
 * the weight it was given. Every file went to a key named by the *version*
 * alone, so a second push of the same version overwrote the first in place. The
 * old binary was already there, which meant its presence no longer proved
 * anything about the stages beside it, and an interrupted republish left new
 * stages paired with an old binary under exactly the keys the live fleet
 * manifest — and any bootstrap URL already presigned from it — still named.
 *
 * Under a generation none of that is reachable. The keys are derived from the
 * content, so different content cannot occupy the same keys, and the objects a
 * published manifest names are never written to again by any later push.
 *
 * The publish is then three steps, and their order is the whole durability
 * argument:
 *
 *  1. every file uploaded (stages first, binary last, as before);
 *  2. every uploaded key confirmed present in the bucket;
 *  3. `release.json` written **last**, naming the generation's files.
 *
 * Only step 3 makes the generation visible to `describeRelease`, and only after
 * this whole function returns does `publishRelease` move the fleet pointer. An
 * interruption at any earlier point leaves an unreferenced directory of bytes,
 * and the previous manifest with every object it names untouched.
 *
 * Every route to a push comes through here, so the "a release must have stages"
 * refusal lives here too rather than in each of `releaseFiles`' branches.
 */
export async function pushRelease(
  artifacts: Pick<ArtifactsApi, "putObject" | "exists" | "getObject">,
  /**
   * `build` is the fingerprint of the sources the binary was compiled from
   * (`HermeticdCandidate.build`), recorded so a later `create`/`rerun` can tell
   * this release apart from another one calling itself the same version. Absent
   * or `null` when the pusher does not know — the manifest then simply carries
   * no `build`, which is what every manifest written before this field says.
   */
  input: {
    version: string;
    files: readonly ReleaseFile[];
    build?: string | null;
    /**
     * The checkout this release came from (`gitBuildInfo`), or `null` where it
     * could not say. Recorded so the fleet can *order* two releases rather than
     * only tell them apart — see `FleetManifest.hermeticd.build_number`.
     */
    git?: GitBuildInfo | null;
    /**
     * When this generation was published, for `release.json`. Supplied by the
     * caller that already holds the operation's clock, so a push and the fleet
     * manifest that ends it carry one timestamp rather than two.
     */
    now?: string;
  },
): Promise<FleetManifest["hermeticd"]> {
  const binary = input.files.find((f) => f.name === "hermeticd");
  if (!binary) {
    throw new HermeticError(
      "HERMETICD_UNAVAILABLE",
      `release ${input.version} has no hermeticd binary to push`,
      { version: input.version },
    );
  }
  // The names are checked before anything is uploaded: a release with a stage
  // hermeticd would refuse to run — or with no stages at all — is not worth
  // putting in the bucket.
  let ordered: string[];
  try {
    ordered = orderStages(stageNames(input.files));
  } catch (e) {
    throw new HermeticError(
      "HERMETICD_UNAVAILABLE",
      `release ${input.version} has an invalid stage set: ${e instanceof Error ? e.message : String(e)}. Set ${STAGES_ENV}=/path/to/stages, run a build that ships a stages/ directory next to this executable, or run from a source checkout.`,
      { version: input.version },
    );
  }

  /**
   * The generation is decided before a single byte moves: it is a function of
   * the bytes themselves, so it cannot depend on how far an upload got.
   */
  const generation = releaseGeneration(
    input.files.map((f) => ({
      name: f.name,
      sha256: digestOf(f.bytes),
      contentType: f.contentType,
    })),
  );

  const files: Record<string, FleetManifestFile> = {};
  const upload = async (file: ReleaseFile): Promise<void> => {
    const key = releaseKey(input.version, file.name, generation);
    await artifacts.putObject(key, file.bytes, file.contentType);
    files[file.name] = { key, sha256: digestOf(file.bytes), size: file.bytes.byteLength };
  };

  for (const name of ordered) {
    const stage = input.files.find((f) => f.name === `stages/${name}`);
    if (stage) await upload(stage);
  }
  // Last, deliberately: see the ordering invariant above.
  await upload(binary);

  /**
   * Step 2. A `putObject` that resolved is not the same statement as an object
   * that is in the bucket: a retried client, a bucket policy that dropped one
   * write, a key deleted between two pushes. The pointer written after this is
   * what every box verifies its downloads against, so the generation is checked
   * before anything can name it.
   */
  for (const [name, entry] of Object.entries(files)) {
    if (await artifacts.exists(entry.key)) continue;
    throw new HermeticError(
      "HERMETICD_UNAVAILABLE",
      `s3://…/${entry.key} is not in the bucket after being uploaded, so release ${input.version} generation ${generation} is incomplete and nothing has been pointed at it; run \`hermetic artifacts push\` again`,
      { version: input.version, generation, file: name, key: entry.key },
    );
  }

  const hermeticd: FleetManifest["hermeticd"] = {
    version: input.version,
    generation,
    files,
    ...(input.build ? { build: input.build } : {}),
    // Absent, never zeroed, when the checkout could not say — a built binary, a
    // tarball, a shallow clone. `0` would order below every real release.
    ...(input.git ? { build_number: input.git.build_number, commit: input.git.commit } : {}),
    /**
     * What the binary just uploaded implements. It is this checkout's list
     * because the binary was built from this checkout — `tests/seams.test.ts`
     * holds `hermeticd`'s own set equal to it, so the claim is checked rather
     * than asserted.
     */
    capabilities: [...AGENT_CAPABILITY_LIST],
  };

  /**
   * Step 3, and the last write of the generation: the marker that says it is
   * whole. `describeRelease` judges a generation by this object alone, so an
   * interruption before it leaves a directory of bytes that nothing — no
   * manifest, no `upgrade --hermeticd` — can be pointed at. Which is the point.
   *
   * A generation that already carries a marker naming these exact files keeps
   * the one it has. A republish of unchanged bytes lands on the same keys by
   * construction, and rewriting the marker would move a *published* generation's
   * `created_at`, `build` and `commit` to whoever pushed last — reordering the
   * generations of a version and relabelling the provenance of bytes nobody
   * touched. The immutability is the whole claim; it has to hold for the marker
   * too.
   */
  const markerKey = releaseKey(input.version, RELEASE_MANIFEST_NAME, generation);
  const published = await sameMarker(artifacts, markerKey, input.version, generation, files);
  if (published) return asPublished(hermeticd, published);

  const release: ReleaseManifest = ReleaseManifestSchema.parse({
    schema_version: 1,
    version: input.version,
    generation,
    files,
    ...(hermeticd.build === undefined ? {} : { build: hermeticd.build }),
    ...(hermeticd.build_number === undefined ? {} : { build_number: hermeticd.build_number }),
    ...(hermeticd.commit === undefined ? {} : { commit: hermeticd.commit }),
    capabilities: hermeticd.capabilities,
    created_at: input.now ?? new Date().toISOString(),
  });
  await artifacts.putObject(
    markerKey,
    new TextEncoder().encode(`${JSON.stringify(release, null, 2)}\n`),
    "application/json",
  );
  return hermeticd;
}

/**
 * The marker already in the bucket when it describes *this* generation naming
 * exactly these files — the republish-of-unchanged-bytes case — and `null`
 * otherwise.
 *
 * Anything else reads as "no usable marker" and is overwritten: a truncated
 * write, a marker for another generation somebody copied in, a `files` block
 * that disagrees with what is about to be recorded. None of those describes the
 * generation being published, and leaving one in place would leave the bucket
 * lying about a release.
 */
async function sameMarker(
  artifacts: Pick<ArtifactsApi, "getObject">,
  markerKey: string,
  version: string,
  generation: string,
  files: Record<string, FleetManifestFile>,
): Promise<ReleaseManifest | null> {
  const bytes = await artifacts.getObject(markerKey);
  if (!bytes) return null;
  let existing: ReleaseManifest;
  try {
    existing = ReleaseManifestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return null;
  }
  if (existing.version !== version || existing.generation !== generation) return null;
  // Same set, not merely a subset either way: a marker naming a file this push
  // does not have describes some other release, and one missing a file this
  // push has is not a marker for it.
  const names = Object.keys(files);
  if (names.length !== Object.keys(existing.files).length) return null;
  const same = names.every((name) => {
    const was = existing.files[name];
    const now = files[name];
    return was?.key === now?.key && was?.sha256 === now?.sha256 && was?.size === now?.size;
  });
  return same ? existing : null;
}

/**
 * The `hermeticd` block a no-op republish returns: this push's release, with
 * the provenance the *published* generation already records.
 *
 * `release.json` is kept when a republish lands on bytes that are already there
 * — the immutability of a generation has to hold for its marker too — and the
 * fleet manifest has to say the same thing, or the same generation carries one
 * commit in `release.json` and another in `manifest.json` and neither answers
 * "which commit were these bytes built from". The marker wins because it is the
 * one that was written by the push that *made* the bytes; a second push of an
 * identical tree did not build them and has no claim on their provenance. It is
 * also the answer any other laptop would get, since `describeRelease` reads the
 * bucket rather than the pusher.
 *
 * A field the marker does not carry falls back to this push's, per field: an
 * older marker records no `capabilities`, and absent reads as *cannot tell*
 * (§3.6), so taking the marker's silence for an answer would quietly drop
 * `agent create`'s capability refusal for a release whose bytes this checkout
 * can describe exactly — they are the bytes it just built.
 */
function asPublished(
  hermeticd: FleetManifest["hermeticd"],
  marker: ReleaseManifest,
): FleetManifest["hermeticd"] {
  const build = marker.build ?? hermeticd.build;
  const buildNumber = marker.build_number ?? hermeticd.build_number;
  const commit = marker.commit ?? hermeticd.commit;
  const capabilities = marker.capabilities ?? hermeticd.capabilities;
  return {
    version: hermeticd.version,
    ...(hermeticd.generation === undefined ? {} : { generation: hermeticd.generation }),
    files: hermeticd.files,
    ...(build === undefined ? {} : { build }),
    ...(buildNumber === undefined ? {} : { build_number: buildNumber }),
    ...(commit === undefined ? {} : { commit }),
    ...(capabilities === undefined ? {} : { capabilities }),
  };
}

/**
 * Every *complete* generation of `version` in the bucket, newest first.
 *
 * "Complete" is judged by `release.json` and by nothing else: it is written
 * last, so its presence is the only statement in the bucket that the objects
 * beside it are a whole release rather than however far an interrupted push
 * happened to get. A marker that does not parse, that names a different version
 * or a different generation than the directory it sits in, or that names an
 * object the listing does not contain, is not a complete generation — each of
 * those is a bucket somebody has edited by hand, and none of them is a release
 * a fleet may be pointed at.
 */
async function completeGenerations(
  artifacts: Pick<ArtifactsApi, "getObject">,
  version: string,
  keys: readonly string[],
): Promise<ReleaseManifest[]> {
  const prefix = releaseKey(version, "");
  const present = new Set(keys);
  const found: ReleaseManifest[] = [];
  for (const key of keys) {
    const parts = key.slice(prefix.length).split("/");
    if (parts.length !== 2 || parts[1] !== RELEASE_MANIFEST_NAME) continue;
    const bytes = await artifacts.getObject(key);
    if (!bytes) continue;
    let release: ReleaseManifest;
    try {
      release = ReleaseManifestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
      continue;
    }
    if (release.version !== version || release.generation !== parts[0]) continue;
    if (
      !Object.values(release.files).every(
        (f) => isReleaseObjectKey(f.key, release.version, release.generation) && present.has(f.key),
      )
    ) {
      continue;
    }
    found.push(release);
  }
  return found.sort((a, b) =>
    a.created_at === b.created_at
      ? b.generation.localeCompare(a.generation)
      : b.created_at.localeCompare(a.created_at),
  );
}

/** The newest complete generation of `version`, or `null` when there is none. */
async function newestGeneration(
  artifacts: Pick<ArtifactsApi, "getObject">,
  version: string,
  keys: readonly string[],
): Promise<ReleaseManifest | null> {
  return (await completeGenerations(artifacts, version, keys))[0] ?? null;
}

/**
 * The digests of a release already in the bucket, recomputed from the bytes
 * themselves. `upgrade --hermeticd V` needs them to move the fleet manifest's
 * pointer to a release some other laptop pushed, and a digest that was not
 * computed from the object it names would be worse than none: every box
 * verifies against it.
 *
 * Completeness is a fact in the bucket, not an inference: a generation counts
 * only once its `release.json` is there and every object it names is too. It
 * used to rest on `pushRelease`'s ordering — stages first, binary last, so a
 * present `hermeticd` meant the stages beside it were the whole release — and
 * that reasoning died with mutable keys, because on a republish the binary was
 * already there before the push began.
 *
 * A version may hold several generations; this picks the newest by
 * `created_at`, breaking a tie on the generation id so the answer is a function
 * of the bucket and not of listing order. A version with no generation at all
 * falls back to the flat pre-generation layout, which is still in every bucket
 * an older hermetic ever pushed to and still has to be pointable-at.
 *
 * No `build`: the bytes in the bucket do not say which checkout compiled them,
 * and this laptop did not push them — `upgrade --hermeticd V` points at a
 * release some other laptop made. Absent is the honest answer, and it is the
 * one `releaseDrift` reads as "cannot tell", rather than as agreement. The
 * generation is reported, because that one *is* a fact about the objects.
 */
export async function describeRelease(
  artifacts: Pick<ArtifactsApi, "list" | "getObject">,
  version: string,
): Promise<FleetManifest["hermeticd"]> {
  const prefix = `${releaseKey(version, "")}`;
  const keys = await artifacts.list(prefix);

  const generation = await newestGeneration(artifacts, version, keys);
  if (generation) {
    const files: Record<string, FleetManifestFile> = {};
    for (const [name, entry] of Object.entries(generation.files)) {
      // Digests recomputed from the objects the generation manifest names, not
      // copied out of it: this is the answer every box verifies against.
      const bytes = await artifacts.getObject(entry.key);
      if (!bytes) {
        throw new HermeticError(
          "NOT_FOUND",
          `s3://…/${entry.key} disappeared while reading release ${version} generation ${generation.generation}`,
          { key: entry.key, version, generation: generation.generation },
        );
      }
      files[name] = { key: entry.key, sha256: digestOf(bytes), size: bytes.byteLength };
    }
    return { version, generation: generation.generation, files };
  }

  const binaryKey = releaseKey(version, "hermeticd");
  if (!keys.includes(binaryKey)) {
    throw new HermeticError(
      "NOT_FOUND",
      `hermeticd ${version} is not in the bucket; run \`hermetic artifacts push ${version}\` first`,
      { version, key: binaryKey },
    );
  }
  const names = keys
    .map((k) => k.slice(prefix.length))
    .filter((n) => n === "hermeticd" || n.startsWith("stages/"));
  const stages = stageNames(names.map((name) => ({ name })));
  if (stages.length === 0) {
    throw new HermeticError(
      "NOT_FOUND",
      `the release at ${prefix} has a hermeticd binary but no stages, so it is not a release the fleet can be pointed at; push ${version} again`,
      { version, prefix },
    );
  }
  try {
    orderStages(stages);
  } catch (e) {
    throw new HermeticError(
      "HERMETICD_UNAVAILABLE",
      `the release at ${prefix} has an invalid stage set: ${e instanceof Error ? e.message : String(e)}`,
      { version },
    );
  }

  const files: Record<string, FleetManifestFile> = {};
  for (const name of names) {
    const key = releaseKey(version, name);
    const bytes = await artifacts.getObject(key);
    if (!bytes) {
      throw new HermeticError("NOT_FOUND", `s3://…/${key} disappeared while reading the release`, {
        key,
      });
    }
    files[name] = { key, sha256: digestOf(bytes), size: bytes.byteLength };
  }
  return { version, files };
}

/**
 * What `publishRelease` needs from the SDK's closure: where to put the bytes,
 * which version this build ships, and — in real mode — how to find the binary.
 */
export interface PublishDeps {
  artifacts: ArtifactsApi;
  /** `BUILD_VERSIONS.hermeticd`: the version pushed when the caller names none. */
  hermeticVersion: string;
  /**
   * `true` for the in-memory backend, whose bucket boots nothing: a stand-in
   * binary is then allowed, because refusing would make `--fixture` need a
   * cross-compiled hermeticd on the laptop.
   */
  fixture: boolean;
  hermeticdPath?: string | undefined;
  resolveHermeticd?: (() => Promise<HermeticdCandidate | null>) | undefined;
  /**
   * §3.6: mirror this build's Hermes ref into the bucket before the fleet
   * manifest is written, and hand back the block to write. Optional so a caller
   * that has no business mirroring (a test of the release push itself) can leave
   * it out; when it is out, the published block is carried over unchanged.
   *
   * It is handed what the published manifest says so it can merge rather than
   * replace — a half-upgraded fleet is on two refs at once (§6.5) — and it never
   * throws: a mirror that could not be refreshed returns a warning and the block
   * it was given.
   */
  mirrorHermes?: HermesMirrorStep;
  /**
   * §7.3: mirror this build's pinned Chrome for Testing build into the bucket
   * before the fleet manifest is written, and hand back the block to write.
   * Optional on the same terms `mirrorHermes` is, and merged rather than
   * replaced for the same reason: a fleet can legitimately be running two
   * builds while an older configuration is still the one governing a box.
   *
   * It throws for exactly one thing — bytes that are not the pinned build —
   * and warns for everything else.
   */
  mirrorBrowser?: BrowserMirrorStep;
  /**
   * The checkout this process is running out of (`gitBuildInfo`). Defaults to
   * reading the real one; fixture mode and tests hand in a fixed answer, and
   * `null` means "cannot say", which is never a refusal.
   */
  git?: (() => GitBuildInfo | null) | undefined;
  /**
   * Publish from a dirty tree anyway. Wired from `HERMETIC_ALLOW_DIRTY=1`; see
   * `assertCleanTree` for why this is an environment variable and not a flag.
   */
  allowDirty?: boolean | undefined;
}

/** What `artifacts push` and `init`'s push report back. */
export interface ReleasePushResult {
  key: string;
  version: string;
  /**
   * Which generation of that version the push produced (`releaseGeneration`).
   * Two pushes of one version are two generations unless their bytes are
   * identical, in which case they are the same one — which is what an operator
   * comparing two `artifacts push` runs actually wants to know.
   */
  generation: string;
  sha256: string;
  stages: number;
  /**
   * Set only when the §3.6 mirror step could not run. The release itself was
   * pushed and the fleet points at it; this says the boxes will clone Hermes
   * from github.com rather than from the bucket. Heads print it; nothing
   * depends on it.
   */
  mirror_warning?: string;
  /**
   * Set only when the §7.3 browser mirror could not run. Separate from
   * `mirror_warning` because the consequence is different in kind: a fleet
   * without its Hermes bundle boots more slowly, while a fleet without its
   * browser build cannot run a `browser: true` agent at all.
   */
  browser_warning?: string;
}

/**
 * The stage names a *fixture* release carries, and the ids the fixture fleet's
 * bootstrap rows show. A fixture bucket boots nothing, so these are shape
 * rather than content — but the shape has to be a valid release, because
 * `pushRelease` refuses a stage-less one for everybody.
 */
/**
 * The bytes a fixture release publishes for the binary — four bytes of ELF
 * magic, enough to be a file and nothing more.
 *
 * Here rather than in `memory-fixture.ts` because both sides need them and the
 * dependency only runs one way: the fixture backend imports this module, so
 * this module cannot import it back. `seedFixtureRelease` writes these bytes,
 * `releaseFiles` republishes exactly these bytes, and the seeded agent rows
 * report their digest — three places that have to agree, held together by one
 * constant instead of by three literals.
 */
export const FIXTURE_HERMETICD_BYTES: readonly number[] = [0x7f, 0x45, 0x4c, 0x46];

/**
 * The provenance a fixture push records. Canned for the same reason the
 * preflight and the Hermes mirror are: fixture mode must not depend on the
 * machine it runs on, and a push that dropped these would send the update
 * drawer back to the blanks the fixture exists to stop showing.
 */
export const FIXTURE_BUILD_NUMBER = 41;
export const FIXTURE_COMMIT = "f1x7ure";
/** Deliberately unequal to what the fixture fleet publishes, so drift is demoable. */
export const FIXTURE_LOCAL_BUILD = "c".repeat(64);

export const STAND_IN_STAGES: readonly string[] = [
  "00-preflight.sh",
  "01-tailscale.sh",
  "02-data-volume.sh",
  "03-config.sh",
  "04-apply.sh",
  "05-service.sh",
  "06-verify.sh",
];

/** The stages this machine ships, as `ReleaseFile`s; empty when it ships none. */
function stageFiles(): ReleaseFile[] {
  const located = locateStages();
  if (located === null) return [];
  return located.names.map((name) => ({
    name: `stages/${name}`,
    bytes: read(join(located.dir, name)),
    contentType: RELEASE_STAGE_CONTENT_TYPE,
  }));
}

/**
 * A release ready to hand to `pushRelease`: its bytes, and which build of
 * hermetic produced the binary among them (`null` when nothing on this machine
 * says — raw bytes handed in by a caller, or a fixture stand-in).
 */
export interface ReleaseBundle {
  files: ReleaseFile[];
  build: string | null;
  /**
   * The checkout these bytes were produced from, or `null` where nothing can
   * say — raw bytes handed in, a fixture stand-in, a released binary with no
   * repository around it.
   */
  git: GitBuildInfo | null;
}

/**
 * The bytes of the release this laptop would push. Every branch attaches the
 * stages it can find; the branch that finds none still returns, because
 * `pushRelease` is the one place that decides a stage-less release is not
 * publishable — there is no route around it.
 *
 * The build comes back with them rather than being resolved a second time by
 * the caller: this is where the candidate is chosen, so this is the only place
 * that knows which binary the bytes came from.
 */
/**
 * §3.6's clean-tree rule, and the checkout's commit stamp, as one answer.
 *
 * Two callers ask, and they must not be able to disagree. `releaseFiles` asks
 * because it is about to publish bytes off this working tree; `foundation
 * update` asks in its *preflight*, before it has taken the fleet lock or
 * touched anything, because the refusal it would otherwise hit arrives ~60% of
 * the way through an operation that has by then archived the fleet's state and
 * executed a CloudFormation change set. Nothing about that later refusal is
 * wrong — it simply costs an archive and a stack update to say a thing that was
 * already true before the operation started.
 *
 * Extracted rather than restated at the second call site, because the two ways
 * of getting this wrong are both silent: a preflight that resolved the git info
 * differently could refuse a tree the push would have accepted (and in fixture
 * mode, where `git` is deliberately `null`, it would refuse *every* update), or
 * pass a tree the push then rejects — which is the bug this fixes, reintroduced
 * one level up.
 *
 * Returns the resolved build info so the caller that needs it to stamp a
 * release does not read the checkout twice for one answer.
 */
export function assertPublishableTree(deps: PublishDeps): GitBuildInfo | null {
  // `findRepoRoot()`, the same root the binary and the stages are resolved from
  // — never `process.cwd()`. The release is built from that checkout, so that
  // checkout is the one whose cleanliness decides and whose commit is recorded.
  const readGit = deps.git ?? ((): GitBuildInfo | null => gitBuildInfo({ cwd: findRepoRoot() }));
  // Fixture mode reads `null` rather than the real checkout: it publishes
  // stand-in bytes into an in-memory bucket, so there is nothing to reproduce
  // and nothing to refuse — and `bun run dev:fixture` on a working tree is the
  // single most common thing anyone does in this repository.
  const git = deps.fixture ? null : readGit();
  assertCleanTree(git, { allowDirty: deps.allowDirty ?? allowDirtyFromEnv() });
  return git;
}

export async function releaseFiles(
  deps: PublishDeps,
  input: PushInput,
  version: string,
): Promise<ReleaseBundle> {
  if (input.bytes !== undefined) {
    return {
      files: [
        { name: "hermeticd", bytes: input.bytes, contentType: RELEASE_BINARY_CONTENT_TYPE },
        ...stageFiles(),
      ],
      build: null,
      git: null,
    };
  }

  /**
   * The backstop, and the reason §3.6's clean-tree rule lives here rather than
   * in each head: every branch below publishes bytes taken off this machine's
   * working tree — the binary, or at minimum the stages beside it — so this is
   * the last place that sees all of them, and no caller has to remember to ask.
   *
   * Before anything is read or compiled, so a refusal costs nothing and a dirty
   * tree never pays for a cross-compile it is not allowed to upload. A caller
   * with mutations of its own to spend first asks earlier as well — `foundation
   * update` does, in its preflight — but this stays the line that cannot be
   * skipped by forgetting.
   */
  const git = assertPublishableTree(deps);

  if (input.path !== undefined) {
    const hermeticd: HermeticdCandidate = {
      path: input.path,
      source: "explicit",
      version: null,
      build: buildStampOf(input.path),
    };
    return {
      files: readRelease({ version, hermeticd, stages: locateStages() }),
      build: hermeticd.build,
      git,
    };
  }
  if (!deps.fixture) {
    // §3.6: the binary is found, not asked for — env, sibling, or built.
    const located: HermeticdCandidate | null = deps.hermeticdPath
      ? {
          path: deps.hermeticdPath,
          source: "explicit",
          version: null,
          build: buildStampOf(deps.hermeticdPath),
        }
      : ((await deps.resolveHermeticd?.()) ?? null);
    if (!located) {
      throw new HermeticError(
        "HERMETICD_UNAVAILABLE",
        `no hermeticd ${version} to push: set ${HERMETICD_ENV}=/path/to/hermeticd, run from a build that ships one next to this executable, or run from a source checkout so it can be compiled`,
        { version },
      );
    }
    return {
      files: readRelease({ version, hermeticd: located, stages: locateStages() }),
      build: located.build,
      git,
    };
  }
  /**
   * The fixture's stand-in release, and it has to match what `seedFixtureRelease`
   * put in the bucket byte for byte.
   *
   * The bytes are `FIXTURE_HERMETICD_BYTES` rather than a string built here
   * because the fixture's *agent rows* report the digest of those bytes: a push
   * that published something else would leave every seeded box reporting a
   * digest the manifest no longer names, so one `artifacts push` in
   * `dev:fixture` would turn a fleet of landed agents into a fleet of
   * stragglers. The provenance is canned for the same reason — a push that
   * dropped `build`/`build_number` would send the update drawer back to the two
   * blanks the fixture was seeded to stop showing.
   */
  return {
    files: [
      {
        name: "hermeticd",
        bytes: new Uint8Array(FIXTURE_HERMETICD_BYTES),
        contentType: RELEASE_BINARY_CONTENT_TYPE,
      },
      ...STAND_IN_STAGES.map((name) => ({
        name: `stages/${name}`,
        bytes: new TextEncoder().encode(`#!/usr/bin/env bash\n# fixture stand-in for ${name}\n`),
        contentType: RELEASE_STAGE_CONTENT_TYPE,
      })),
    ],
    build: FIXTURE_LOCAL_BUILD,
    git: { build_number: FIXTURE_BUILD_NUMBER, commit: FIXTURE_COMMIT, dirty: false },
  };
}

/** What a caller may name: a version, and — from the CLI only — a local file. */
export interface PushInput {
  version?: string | undefined;
  path?: string | undefined;
  bytes?: Uint8Array | undefined;
}

/**
 * Publish a release *and* point the fleet at it. Both halves, always: a release
 * nothing names is invisible, and a manifest naming a release that is not there
 * boots nothing. The manifest is the last write (§1).
 */
export async function publishRelease(
  deps: PublishDeps,
  input: PushInput,
  target: { fleet: FleetItem; stack: StackInfo | null; updatedBy: string; updatedAt: string },
): Promise<ReleasePushResult> {
  const version = input.version ?? deps.hermeticVersion;
  const { files, build, git } = await releaseFiles(deps, input, version);
  const hermeticd = await pushRelease(deps.artifacts, {
    version,
    files,
    build,
    git,
    now: target.updatedAt,
  });
  /**
   * The foundation block is *merged*, not rebuilt from `_fleet` alone. The
   * stamp reaches the bucket before it reaches the row (`pushAndPrune`, then
   * the stamp of §6.6 step 5), so a push landing inside that window would
   * otherwise publish the row's older version over the newer one and every box
   * would read a foundation the fleet had already left (`laterFoundation`).
   *
   * A manifest that cannot be read is treated as one that is not there. This
   * write replaces it either way, and a corrupt object must not be able to stop
   * `artifacts push` — which is one of the two ways an operator repairs it.
   * That is why this reads `carriedBlocks` and not the manifest: a manifest
   * refused for its `hermeticd` keys still has a `hermes` block worth keeping,
   * and reading it as absent would republish without one — losing the bundle of
   * every ref `mirrorHermes` does not rebuild (§6.5) and sending those boxes
   * back to cloning github.com.
   */
  const published = await carriedBlocks(deps.artifacts);
  const foundation = laterFoundation(manifestFoundationOf(target.fleet), published.foundation);
  /**
   * §3.6: the bundle goes up *before* the manifest that names it, exactly as
   * the release does, so a half-uploaded mirror is invisible to every box.
   */
  const mirror = await deps.mirrorHermes?.(published.hermes);
  const hermes = mirror ? mirror.block : published.hermes;
  /**
   * §7.3, and after the Hermes mirror rather than beside it: both are uploads
   * that must land before the manifest naming them, and running them in a fixed
   * order keeps the events an operator reads in a fixed order too. `init
   * --create` reaches this through the same `publishRelease` every `artifacts
   * push` does, so a fresh fleet gets its browser without a second command.
   */
  const browserMirror = await deps.mirrorBrowser?.(published.browser);
  const browser = browserMirror ? browserMirror.block : published.browser;
  await writeFleetManifest(deps.artifacts, {
    fleet: target.fleet,
    stack: target.stack,
    hermeticd,
    updatedBy: target.updatedBy,
    updatedAt: target.updatedAt,
    ...(foundation === undefined ? {} : { foundation }),
    ...(hermes === undefined ? {} : { hermes }),
    ...(browser === undefined ? {} : { browser }),
  });
  const binary = hermeticd.files["hermeticd"];
  const generation = hermeticd.generation ?? "";
  return {
    key: binary?.key ?? releaseKey(version, "hermeticd", generation),
    version,
    generation,
    sha256: binary?.sha256 ?? "",
    stages: Object.keys(hermeticd.files).length - 1,
    ...(mirror?.warning === undefined ? {} : { mirror_warning: mirror.warning }),
    ...(browserMirror?.warning === undefined ? {} : { browser_warning: browserMirror.warning }),
  };
}
