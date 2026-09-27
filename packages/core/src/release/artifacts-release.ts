/**
 * Where this laptop's release comes from: the compiled `hermeticd` and the
 * ordered bootstrap stages it runs (§3.6). `locateRelease` is the entry;
 * `artifacts.ts` uploads what it finds.
 *
 * `init` and `upgrade` push; nothing about that should be the operator's job, so
 * this finds the binary in the three places it can legitimately be, in order:
 *
 *  1. **Explicit** — `HERMETIC_HERMETICD=/path` in the environment. Wins outright.
 *  2. **Sibling** — `hermeticd` next to the running executable. `scripts/build.ts`
 *     puts the host binaries and `hermeticd` side by side in `dist/`, so this is
 *     the shipped-binary path and costs nothing.
 *  3. **Built** — on a source checkout (`bun run dev`, `bun run cli`), compile it
 *     with the same command the agentd package uses, into
 *     `packages/agentd/dist/hermeticd`, cached by a fingerprint of the sources
 *     it is built from. A dev laptop then produces the same fleet a release
 *     would.
 *
 * Each candidate carries a version stamp (`<path>.version`, written by the
 * build). A stamp that disagrees with the version being pushed is a refusal,
 * not a warning: an instance would fetch the wrong build and report it forever.
 * The stages are found the same way — `HERMETIC_STAGES`, a `stages/` directory
 * beside the executable, or `packages/agentd/stages` on a source checkout — and
 * their names are validated by `orderStages` before a single byte is uploaded.
 *
 * No `console.*`, no `process.exit` (§3.2 rule 1): a build failure is a
 * `HermeticError` whose details carry the compiler's last lines.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { HermeticError } from "../errors.ts";
import { orderStages } from "../schema/index.ts";

export const HERMETICD_ENV = "HERMETIC_HERMETICD";
/** Where the bootstrap stages come from when they are not beside the binary. */
export const STAGES_ENV = "HERMETIC_STAGES";
/** The only target agents boot: Graviton (§7.1). */
export const AGENTD_TARGET = "bun-linux-arm64";
export const AGENTD_ENTRY = "packages/agentd/src/main.ts";
export const AGENTD_OUT = "packages/agentd/dist/hermeticd";
/** The stages a source checkout ships; `scripts/build.ts` copies them beside the binaries. */
export const AGENTD_STAGES = "packages/agentd/stages";
/**
 * What a release's identity is made of.
 *
 * The two source trees are what the binary is compiled from (`agentd` may
 * import only core's schema, §3.1) — and the stages, which are not compiled
 * into anything at all but *are* part of the release: `pushRelease` uploads
 * them alongside the binary and a box runs them at boot.
 *
 * The stages belong here because of what this fingerprint is used for.
 * `releaseDrift` compares it to tell an operator "the fleet's release was
 * pushed from a different build than this checkout", and the sentence it says
 * names the stages explicitly. While they were excluded, the most ordinary
 * forgotten push there is — edit a stage, skip `artifacts push`, `agent rerun` —
 * produced a byte-identical fingerprint and therefore no warning at all, from
 * the one check that exists to catch it.
 *
 * It also keys the source-build cache, so editing a stage now recompiles
 * hermeticd. That is a few seconds of a cross-compile that was already cached,
 * and it is the right trade: the alternative is two fingerprints that mean
 * almost the same thing, and a later reader picking the wrong one.
 */
const FINGERPRINT_DIRS = ["packages/agentd/src", "packages/core/src/schema", "packages/agentd/stages"];

/**
 * Single files that change what `bun build --compile` emits without appearing
 * in any of the directories above: the pinned toolchain and the resolved
 * dependency graph.
 *
 * Without them the cache is wrong rather than merely coarse. `bun install`
 * moving `@aws-sdk/client-s3` to a newer patch inside its existing range, or a
 * bump of `.bun-version`, changes the bytes a rebuild would produce while
 * leaving every hashed source file untouched — so `resolveHermeticd` finds its
 * `.build-key` still matching and ships the binary from before the change.
 *
 * Missing files are skipped rather than failed on: a consumer running from
 * somewhere without a lockfile still gets a usable fingerprint, just a coarser
 * one.
 */
const FINGERPRINT_FILES = [".bun-version", "bun.lock", "packages/agentd/package.json"];

export interface HermeticdCandidate {
  path: string;
  source: "explicit" | "sibling" | "built";
  /** From `<path>.version`; null when no stamp exists (an explicit path from an unknown build). */
  version: string | null;
  /**
   * *Which build* this binary came from — `sourceFingerprint` of the sources it
   * was compiled from, not its version. Two checkouts a day apart both call
   * themselves `0.5.0` while shipping different bytes, and a fleet running the
   * older one fails to apply a manifest rendered by the newer (a unit only the
   * newer hermeticd installs). The version cannot express that; this can.
   *
   * `null` when the binary carries no stamp — an explicit path from an unknown
   * build, or a sibling laid down before builds stamped one.
   */
  build: string | null;
}

export interface BuildRequest {
  entry: string;
  outfile: string;
  version: string;
}

export interface ResolveHermeticdOptions {
  /** The version being pushed (`BUILD_VERSIONS.hermeticd`); stamps must match it. */
  version: string;
  env?: Record<string, string | undefined>;
  /** Defaults to `process.execPath`; tests point it into a temp dir. */
  execPath?: string;
  /** Defaults to walking up from this file; `null` disables the source build. */
  repoRoot?: string | null;
  /** Defaults to spawning `bun build --compile`; tests inject a fake. */
  build?: (req: BuildRequest) => Promise<void>;
}

/** The repo root, found by the one file the source build needs. */
export function findRepoRoot(from: string = import.meta.dir): string | null {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, AGENTD_ENTRY))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .flatMap((entry) => {
      const path = join(dir, entry);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
}

/** Changes when anything the release is built from changes, or the version does. */
export function sourceFingerprint(root: string, version: string): string {
  const hash = createHash("sha256").update(`version=${version}\n`);
  for (const dir of FINGERPRINT_DIRS) {
    for (const file of walk(join(root, dir))) {
      hash
        .update(`${relative(root, file)}\n`)
        .update(readFileSync(file))
        .update("\n");
    }
  }
  for (const name of FINGERPRINT_FILES) {
    const file = join(root, name);
    if (!existsSync(file)) continue;
    hash.update(`${name}\n`).update(readFileSync(file)).update("\n");
  }
  return hash.digest("hex");
}

function stampOf(path: string): string | null {
  const stamp = `${path}.version`;
  if (!existsSync(stamp)) return null;
  return readFileSync(stamp, "utf8").trim() || null;
}

/**
 * The build stamp beside a binary: `<path>.build`, written by `scripts/build.ts`
 * in the same shape as `<path>.version` (one hex line).
 *
 * `<path>.build-key` is read as a fallback because that is the name the *source*
 * build caches its fingerprint under (`resolveHermeticd` below), so pointing
 * `HERMETIC_HERMETICD` at `packages/agentd/dist/hermeticd` still says which
 * build it is rather than shrugging.
 */
export function buildStampOf(path: string): string | null {
  for (const stamp of [`${path}.build`, `${path}.build-key`]) {
    if (!existsSync(stamp)) continue;
    const value = readFileSync(stamp, "utf8").trim();
    if (value) return value;
  }
  return null;
}

function checkStamp(candidate: HermeticdCandidate, version: string): HermeticdCandidate {
  if (candidate.version !== null && candidate.version !== version) {
    throw new HermeticError(
      "HERMETICD_UNAVAILABLE",
      `the hermeticd at ${candidate.path} is version ${candidate.version}, but this build pushes ${version}; rebuild it or unset ${HERMETICD_ENV}`,
      { path: candidate.path, source: candidate.source, found: candidate.version, expected: version },
    );
  }
  return candidate;
}

/** `bun build --compile` for Graviton, the same invocation `scripts/build.ts` uses. */
export async function buildHermeticd(req: BuildRequest): Promise<void> {
  mkdirSync(dirname(req.outfile), { recursive: true });
  const proc = Bun.spawn(
    [
      "bun",
      "build",
      "--compile",
      `--target=${AGENTD_TARGET}`,
      "--define",
      `process.env.HERMETIC_VERSION="${req.version}"`,
      req.entry,
      "--outfile",
      req.outfile,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) {
    throw new HermeticError(
      "HERMETICD_UNAVAILABLE",
      `compiling hermeticd for ${AGENTD_TARGET} failed (exit ${code})`,
      { exit: code, stderr: stderr.split("\n").slice(-12).join("\n") },
    );
  }
}

/**
 * The candidate to push, or null when none of the three places has one. Throws
 * only for a candidate that exists but cannot be used (wrong version, build
 * failure) — "nothing found" is the caller's decision to make.
 */
export async function resolveHermeticd(
  opts: ResolveHermeticdOptions,
): Promise<HermeticdCandidate | null> {
  const env = opts.env ?? process.env;
  const explicit = env[HERMETICD_ENV];
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new HermeticError(
        "HERMETICD_UNAVAILABLE",
        `${HERMETICD_ENV} points at ${explicit}, which does not exist`,
        { path: explicit },
      );
    }
    return checkStamp(
      {
        path: explicit,
        source: "explicit",
        version: stampOf(explicit),
        build: buildStampOf(explicit),
      },
      opts.version,
    );
  }

  const sibling = join(dirname(opts.execPath ?? process.execPath), "hermeticd");
  if (existsSync(sibling)) {
    return checkStamp(
      { path: sibling, source: "sibling", version: stampOf(sibling), build: buildStampOf(sibling) },
      opts.version,
    );
  }

  const root = opts.repoRoot === undefined ? findRepoRoot() : opts.repoRoot;
  if (root === null) return null;
  const outfile = join(root, AGENTD_OUT);
  const keyFile = `${outfile}.build-key`;
  const key = sourceFingerprint(root, opts.version);
  const cached =
    existsSync(outfile) && existsSync(keyFile) && readFileSync(keyFile, "utf8").trim() === key;
  if (!cached) {
    await (opts.build ?? buildHermeticd)({
      entry: join(root, AGENTD_ENTRY),
      outfile,
      version: opts.version,
    });
    writeFileSync(`${outfile}.version`, `${opts.version}\n`);
    writeFileSync(keyFile, `${key}\n`);
  }
  // `key` *is* the build: the fingerprint of every source the binary was
  // compiled from, cached beside it so the next run can skip the compile.
  return { path: outfile, source: "built", version: opts.version, build: key };
}

/**
 * Which build of `hermeticd` *this* process would push, without pushing — or
 * compiling — anything. `agents.create` and `agent rerun` call it to compare
 * against the build the fleet's release was pushed from (`releaseDrift`), and
 * neither may pay for a cross-compile or fail because a binary is missing: this
 * never spawns a build and never throws.
 *
 * Same precedence as `resolveHermeticd` — explicit, sibling, then the checkout —
 * so the answer is the build of the binary a push would actually upload. The
 * checkout branch computes `sourceFingerprint` directly, which is a hash of a
 * few dozen source files and costs milliseconds.
 */
export function localBuild(opts: {
  version: string;
  env?: Record<string, string | undefined>;
  execPath?: string;
  repoRoot?: string | null;
}): string | null {
  const env = opts.env ?? process.env;
  const explicit = env[HERMETICD_ENV];
  // A path that does not exist is `resolveHermeticd`'s refusal to raise, not
  // this one's: here it simply means there is no build to name.
  if (explicit) return existsSync(explicit) ? buildStampOf(explicit) : null;

  const sibling = join(dirname(opts.execPath ?? process.execPath), "hermeticd");
  if (existsSync(sibling)) return buildStampOf(sibling);

  const root = opts.repoRoot === undefined ? findRepoRoot() : opts.repoRoot;
  if (root === null) return null;
  return sourceFingerprint(root, opts.version);
}

/**
 * The sentence to say when the fleet's release was pushed from a *different
 * build* than this checkout, at the same version — or `null` when there is
 * nothing to say.
 *
 * `null` for every case where the comparison cannot mean anything: no manifest,
 * either side's build unknown (a release pushed before builds were recorded, or
 * by `upgrade --hermeticd`), or the versions differ — a differing version is
 * already the §6.6 skew's job and saying it twice, in two vocabularies, would
 * teach an operator to ignore both.
 *
 * Deliberately generic: it does not claim the drift *is* the failure, because
 * usually it is not. It names the remedy, which is the same either way.
 */
export function releaseDrift(
  published: { version: string; build?: string | null } | null,
  local: { version: string; build: string | null },
): string | null {
  if (!published) return null;
  const theirs = published.build ?? null;
  if (theirs === null || local.build === null) return null;
  if (published.version !== local.version) return null;
  if (theirs === local.build) return null;
  return `the fleet's hermeticd ${published.version} was pushed from a different build of hermetic than this checkout; if hermeticd or its stages changed, run \`hermetic artifacts push\` and \`hermetic agent recreate <name>\` for any box that then fails to apply (a rerun keeps the binary the box already has)`;
}

// ─── the stages half of a release ────────────────────────────────────────────

export interface StagesLocation {
  dir: string;
  source: "explicit" | "sibling" | "checkout";
  /** File names (`NN-<name>.sh`), in run order — `orderStages` has agreed to them. */
  names: string[];
}

export interface LocateOptions {
  env?: Record<string, string | undefined>;
  /** Defaults to `process.execPath`; tests point it into a temp dir. */
  execPath?: string;
  /** Defaults to walking up from this file; `null` disables the checkout lookup. */
  repoRoot?: string | null;
}

function readStageNames(dir: string, source: StagesLocation["source"]): StagesLocation {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sh"));
  if (files.length === 0) {
    throw new HermeticError(
      "HERMETICD_UNAVAILABLE",
      `the stage directory ${dir} holds no .sh files; a release without stages boots nothing`,
      { dir, source },
    );
  }
  try {
    return { dir, source, names: orderStages(files) };
  } catch (e) {
    throw new HermeticError(
      "HERMETICD_UNAVAILABLE",
      `the bootstrap stages in ${dir} are not a valid release: ${e instanceof Error ? e.message : String(e)}`,
      { dir, source },
    );
  }
}

/**
 * The stages of the release this build ships, or `null` when this machine has
 * none. Same three places, same order, as the binary: an explicit env var, a
 * `stages/` directory beside the running executable (what `scripts/build.ts`
 * lays down), then `packages/agentd/stages` on a source checkout.
 */
export function locateStages(opts: LocateOptions = {}): StagesLocation | null {
  const env = opts.env ?? process.env;
  const explicit = env[STAGES_ENV];
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new HermeticError(
        "HERMETICD_UNAVAILABLE",
        `${STAGES_ENV} points at ${explicit}, which does not exist`,
        { dir: explicit },
      );
    }
    return readStageNames(explicit, "explicit");
  }

  const sibling = join(dirname(opts.execPath ?? process.execPath), "stages");
  if (existsSync(sibling)) return readStageNames(sibling, "sibling");

  const root = opts.repoRoot === undefined ? findRepoRoot() : opts.repoRoot;
  if (root === null) return null;
  const checkout = join(root, AGENTD_STAGES);
  return existsSync(checkout) ? readStageNames(checkout, "checkout") : null;
}

/** A release as it sits on this laptop: one binary, and the stages in run order. */
export interface ReleaseLocation {
  version: string;
  hermeticd: HermeticdCandidate;
  /** `null` when this machine ships no stages — a fixture push, or a broken install. */
  stages: StagesLocation | null;
}

/**
 * The whole release, found rather than asked for. `null` when there is no
 * binary at all — "nothing found" stays the caller's decision to make, exactly
 * as it is for `resolveHermeticd`.
 */
export async function locateRelease(opts: ResolveHermeticdOptions): Promise<ReleaseLocation | null> {
  const hermeticd = await resolveHermeticd(opts);
  if (!hermeticd) return null;
  const locate: LocateOptions = {
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.execPath !== undefined ? { execPath: opts.execPath } : {}),
    ...(opts.repoRoot !== undefined ? { repoRoot: opts.repoRoot } : {}),
  };
  return { version: opts.version, hermeticd, stages: locateStages(locate) };
}
