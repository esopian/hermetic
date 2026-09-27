/**
 * §3.6: mirror the Hermes checkout into the fleet's bucket, so a box installs
 * Hermes from S3 over the gateway endpoint instead of cloning github.com at
 * boot — where a GitHub capacity refusal (`429`, which no credential gets past)
 * kills a bootstrap that nobody is watching.
 *
 * The bytes are a **git bundle**, not a tarball: a tarball has no `.git`, which
 * breaks upstream's documented pinned install and rollback (`git checkout <tag>`
 * + `uv pip install -e ".[all]"`), breaks `git describe`, and would clobber
 * `venv/` and `web/node_modules/`, which live inside the checkout.
 *
 * The bundle is **synthesized** — a single root commit over the exported tree,
 * tagged with the ref — rather than made from a shallow clone. `git bundle
 * create` succeeds from a shallow clone, but the result claims a full history
 * it does not have: the working tree is fine and every traversal
 * (`git log`, `git describe`) fails on a missing parent. Silently broken is
 * worse than refused. The cost is that the commit sha is ours, so the real one
 * is recorded as `upstream_sha` in the fleet manifest.
 *
 * Upstream's `pyproject.toml` declares a *static* `version = "0.21.1"` with
 * `setuptools.build_meta` — no setuptools-scm, no hatch-vcs — so the
 * synthesized commit cannot change the version an editable install reports, and
 * the box's `MANIFEST_REFUSED` cross-check is unaffected. (Verified against
 * Hermes Agent 0.21.1.) The tag is still synthesized so `git describe` answers.
 *
 * **`hermes_ref` is a tag, by contract.** `BUILD_VERSIONS.hermes_ref` is
 * `v2026.8.31` and every ref this module has ever been asked for is an upstream
 * release tag. That is not decoration: idempotence here is "the manifest names
 * this ref *and* its object is still in the bucket", with no comparison against
 * upstream, so a ref that *moves* would be mirrored once and then pinned
 * forever at whatever it pointed to that afternoon while the manifest went on
 * naming the branch. `isHermesRef` cannot see the difference — a branch name
 * and a tag name are the same string — so `buildAndPush` checks `refs/tags/`
 * after the fetch and refuses anything else, softly, like every other failure.
 *
 * **Failure is soft.** A laptop that cannot reach GitHub warns and leaves the
 * manifest block untouched, so the box falls back to the direct clone rather
 * than the operator being unable to create an agent at all because a mirror
 * could not be refreshed. `HermeticError` is reserved for programmer errors —
 * a ref that is not a ref — which no retry would fix.
 *
 * Deps are explicit (AGENTS.md rule 5), and the git spawner among them defaults
 * to the real one in `hermetic.ts` for the reason §4.7's preflight probes do:
 * an absent dependency must not be able to silently disable the step. Fixture
 * mode is canned in `fixtureHermesMirror` and never spawns git.
 */
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactsApi } from "../backend/types.ts";
import { HermeticError } from "../errors.ts";
import { hermeticHome } from "../local/db/index.ts";
import { type FleetManifest, hermesBundleKey, isHermesRef } from "../schema/index.ts";

/**
 * Where Hermes comes from. The box has the same constant
 * (`packages/agentd/src/apply/hermes.ts`, `HERMES_REPO`) for its fallback clone, and
 * `tests/seams.test.ts` holds the two equal — the laptop mirroring one repo
 * while the box falls back to another would be invisible until the fallback ran.
 */
export const HERMES_REPO_URL = "https://github.com/NousResearch/hermes-agent.git";

/** The bare mirror's directory name inside `mirrorDir`. */
export const HERMES_MIRROR_DIR = "hermes-agent.git";

/**
 * Long, because this is the one attended fetch: a cold `--mirror` clone of a
 * repository that ships a web app is minutes of network on a good day, and a
 * timeout that fired mid-clone would look exactly like the outage this exists
 * to route around.
 */
export const MIRROR_TIMEOUT_MS = 15 * 60_000;

/**
 * How long a `git` that has been asked to stop gets before it is killed
 * outright. Long enough for a fetch to unwind its own transport helper, short
 * enough that a `git` ignoring the signal does not hold an op open.
 */
export const KILL_GRACE_MS = 10_000;

/** The prefix `buildAndPush` gives its interrupted-clone staging directories. */
const STAGING_PREFIX = ".clone-";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injected in tests; production spawns `git` (`spawnGit`). */
export type GitRun = (args: readonly string[], opts?: { cwd?: string }) => Promise<GitResult>;

/**
 * Deliberately no `Clock`: nothing here is timestamped. The entry this returns
 * is dated by the manifest write that records it (`updated_at`), and a second
 * clock in this module would be a second answer to the same question.
 */
export interface HermesMirrorDeps {
  artifacts: Pick<ArtifactsApi, "putObject" | "exists">;
  /** `$HERMETIC_HOME/mirror`: where the bare mirror is kept between pushes. */
  mirrorDir: string;
  git: GitRun;
}

export interface HermesMirrorInput {
  /** The git ref to mirror — `BUILD_VERSIONS.hermes_ref` at every call site today. */
  ref: string;
  /** Defaults to `HERMES_REPO_URL`; a test points it at a local path. */
  repoUrl?: string;
  /** The manifest's mirror block as it stands, so this can merge rather than replace. */
  existing?: FleetManifest["hermes"];
}

/**
 * - `present`: the bundle is already in the bucket and named by the manifest.
 *   No git ran at all — this is the idempotent path every re-push takes.
 * - `pushed`: a bundle was built and uploaded; `block` gains an entry.
 * - `skipped`: git or the upload failed. `block` is unchanged and `warning`
 *   says why; the box falls back to cloning github.com.
 */
export type HermesMirrorStatus = "present" | "pushed" | "skipped";

export interface HermesMirrorResult {
  /** The manifest block to write: `existing` plus the new ref, or `existing`. */
  block: FleetManifest["hermes"];
  status: HermesMirrorStatus;
  warning?: string;
}

/** How a caller asks for the mirror, whichever implementation is wired in. */
export type HermesMirrorFn = (input: {
  ref: string;
  existing: FleetManifest["hermes"];
}) => Promise<HermesMirrorResult>;

/**
 * The same thing with the ref already bound. `artifacts.ts` takes this shape
 * rather than `HermesMirrorFn`: which ref this build mirrors is
 * `BUILD_VERSIONS.hermes_ref`, which lives in `hermetic.ts` — and `hermetic.ts`
 * imports `artifacts.ts`, not the other way round.
 */
export type HermesMirrorStep = (existing: FleetManifest["hermes"]) => Promise<HermesMirrorResult>;

/** `$HERMETIC_HOME/mirror`, for a caller that was not told where to keep it. */
export function defaultMirrorDir(home?: string): string {
  return join(hermeticHome(home), "mirror");
}

/**
 * Ensure `hermes/<ref>.bundle` is in the bucket and return the manifest block
 * that names it. Never throws for a failure a retry could fix.
 */
export async function ensureHermesMirror(
  deps: HermesMirrorDeps,
  input: HermesMirrorInput,
): Promise<HermesMirrorResult> {
  const { ref } = input;
  /**
   * A programmer error, not an outage: the ref becomes an object key and a git
   * argument, and neither is a place to find out it was something else.
   */
  if (!isHermesRef(ref)) {
    throw new HermeticError(
      "VALIDATION",
      `${JSON.stringify(ref)} is not a Hermes ref hermetic will mirror: a tag or branch name, no path separator, no "..", no whitespace, no leading dash`,
      { ref },
    );
  }
  const key = hermesBundleKey(ref);
  const existing = input.existing;

  try {
    /**
     * Idempotent: a ref the manifest already names, whose object is still there,
     * is a no-op — no clone, no fetch, no upload. The digest is not re-verified
     * here because that would mean downloading the bundle on every push; the box
     * verifies it against this digest before it installs anything, which is where
     * a corrupted object has to be caught anyway.
     *
     * Inside the `try` because `exists` is an S3 call: expired credentials, a
     * bucket policy, a 503 — every one of them throws, and a throw escaping
     * this function would take `artifacts push`, `init` and `upgrade` down with
     * it over a probe whose whole purpose is to decide whether to skip work.
     * The module's contract is that a mirror that cannot be refreshed warns.
     */
    if (existing?.[ref]?.key === key && (await deps.artifacts.exists(key))) {
      return { block: existing, status: "present" };
    }
    const entry = await buildAndPush(deps, { ref, key, repoUrl: input.repoUrl ?? HERMES_REPO_URL });
    return { block: { ...(existing ?? {}), [ref]: entry }, status: "pushed" };
  } catch (e) {
    return {
      block: existing,
      status: "skipped",
      warning: `could not mirror Hermes ${ref} into the fleet bucket (${e instanceof Error ? e.message : String(e)}); agents will clone it from ${HERMES_REPO_URL} at boot instead`,
    };
  }
}

/**
 * Fixture mode's mirror: a stand-in bundle, in the in-memory bucket. Shape
 * rather than content, the same way `STAND_IN_STAGES` is — a fixture bucket
 * boots nothing, and `--fixture` must not spawn git or reach github.com any
 * more than it may construct an AWS client.
 */
export async function fixtureHermesMirror(
  artifacts: Pick<ArtifactsApi, "putObject" | "exists">,
  input: { ref: string; existing: FleetManifest["hermes"] },
): Promise<HermesMirrorResult> {
  const { ref, existing } = input;
  const key = hermesBundleKey(ref);
  if (existing?.[ref]?.key === key && (await artifacts.exists(key))) {
    return { block: existing, status: "present" };
  }
  const bytes = new TextEncoder().encode(`fixture hermes bundle for ${ref}\n`);
  await artifacts.putObject(key, bytes, BUNDLE_CONTENT_TYPE);
  const sha256 = digestOf(bytes);
  return {
    block: {
      ...(existing ?? {}),
      // Forty hex characters off a digest we already have: a fixture commit id
      // that looks like one, from bytes rather than from a literal nobody reads.
      [ref]: { key, sha256, size: bytes.byteLength, upstream_sha: sha256.slice(0, 40) },
    },
    status: "pushed",
  };
}

const BUNDLE_CONTENT_TYPE = "application/x-git-bundle";

/** A 40-hex sha1 or a 64-hex sha256 object id, as `rev-parse` prints it. */
const OBJECT_ID_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function digestOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Delete every `.clone-*` staging directory left in the mirror directory by an
 * earlier run.
 *
 * The `finally` around the clone removes this run's, but only if the promise
 * settles: a laptop closed mid-clone, a killed portal, or a `git` this module
 * SIGKILLed on the mirror timeout all leave one behind, each holding a partial
 * copy of a repository that ships a web app. Nothing else ever reads them, so
 * the newest is as stale as the oldest.
 *
 * Swept on entry, before this run makes its own, so it never removes the
 * directory it is about to use. Two `artifacts push` runs on the same laptop at
 * the same instant could still take each other's — which is a soft mirror
 * failure and a warning, the same outcome as any other interrupted clone.
 */
async function sweepStaging(mirrorDir: string): Promise<void> {
  const entries = await readdir(mirrorDir).catch((): string[] => []);
  for (const entry of entries) {
    if (!entry.startsWith(STAGING_PREFIX)) continue;
    await rm(join(mirrorDir, entry), { recursive: true, force: true });
  }
}

/**
 * Clone or refresh the bare mirror, export the ref's tree, synthesize a
 * single-commit repository over it, bundle that and upload it. Throws on any
 * failure; `ensureHermesMirror` is what turns a failure into a warning.
 */
async function buildAndPush(
  deps: HermesMirrorDeps,
  target: { ref: string; key: string; repoUrl: string },
): Promise<NonNullable<FleetManifest["hermes"]>[string]> {
  const { ref, key, repoUrl } = target;
  const git = async (args: readonly string[], cwd?: string): Promise<string> => {
    const result = await deps.git(args, cwd === undefined ? {} : { cwd });
    if (result.code !== 0) {
      const said = (result.stderr.trim() || result.stdout.trim()).split("\n").slice(-2).join("; ");
      throw new Error(`git ${args.join(" ")} exited ${result.code}: ${said}`);
    }
    return result.stdout;
  };

  await mkdir(deps.mirrorDir, { recursive: true });
  await sweepStaging(deps.mirrorDir);
  const bare = join(deps.mirrorDir, HERMES_MIRROR_DIR);
  if (existsSync(bare)) {
    await git(["-C", bare, "fetch", "--tags", "--prune", "origin"]);
  } else {
    /**
     * `--mirror` and not a plain `--bare`: a bare clone records no fetch
     * refspec, so the *next* run's `git fetch origin` would quietly update
     * nothing and a new tag would never appear. Cloned into a temp directory
     * and renamed into place, so an interrupted clone leaves no half-repository
     * that every later run then tries to fetch from.
     */
    const staging = await mkdtemp(join(deps.mirrorDir, STAGING_PREFIX));
    try {
      await git(["clone", "--mirror", repoUrl, join(staging, HERMES_MIRROR_DIR)]);
      await rename(join(staging, HERMES_MIRROR_DIR), bare);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  /**
   * Tags only, resolved through `refs/tags/` rather than through the bare ref.
   *
   * `isHermesRef` cannot tell a tag from a branch — both are just names — and a
   * branch is the one thing this module's idempotence rule cannot survive: a
   * bundle built from `main` is uploaded once, matches on every later push
   * because the key and the object are both still there, and goes on being
   * installed long after `main` moved. So the contract (see the module comment)
   * is that `hermes_ref` is a release tag, and this is where it is enforced —
   * softly, because it reaches this line only after a clone or fetch, and every
   * failure after that point is a warning rather than a refusal.
   *
   * `--verify --quiet` exits 1 with no output for a name that is not a tag,
   * which is exactly the signal wanted; without `--quiet` git also writes the
   * name to stderr, which the wrapper would quote back as though it were a
   * transport error.
   */
  const tagged = await deps.git(
    ["-C", bare, "rev-parse", "--verify", "--quiet", `refs/tags/${ref}^{commit}`],
    {},
  );
  const upstreamSha = tagged.stdout.trim();
  if (tagged.code !== 0 || !OBJECT_ID_RE.test(upstreamSha)) {
    throw new Error(
      `${ref} is not a tag in ${repoUrl}; hermetic mirrors tags only, because a ref that moves ` +
        "would be pinned forever at whatever it named the day it was first mirrored",
    );
  }

  const work = await mkdtemp(join(tmpdir(), "hermetic-hermes-"));
  const tree = join(work, "tree");
  const bundle = join(work, "bundle");
  try {
    await mkdir(tree, { recursive: true });
    /**
     * The tree, and only the tree: a `--work-tree` checkout out of the bare
     * mirror leaves no `.git` in `tree/`, which is what makes the next step a
     * *new* repository rather than a graft onto upstream's history. It writes
     * an index inside the bare mirror, which is ours and is never read again.
     */
    await git(
      [`--git-dir=${bare}`, `--work-tree=${tree}`, "checkout", "-f", `refs/tags/${ref}`, "--", "."],
      tree,
    );
    await git(["-C", tree, "init", "-q", "-b", "main"]);
    // `-f`: a file upstream tracks *and* ignores is still part of the tree, and
    // a bundle that quietly dropped it would install a different checkout.
    await git(["-C", tree, "add", "-A", "-f", "."]);
    await git([
      "-C",
      tree,
      // Identity and signing are forced here rather than inherited: the laptop's
      // global git config must not decide whether this commit can be made.
      "-c",
      "user.name=hermetic",
      "-c",
      "user.email=hermetic@localhost",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      `hermes-agent ${ref} (mirrored from ${upstreamSha})`,
    ]);
    await git(["-C", tree, "tag", ref]);
    await git(["-C", tree, "bundle", "create", bundle, "--all"]);

    const bytes = new Uint8Array(await readFile(bundle));
    await deps.artifacts.putObject(key, bytes, BUNDLE_CONTENT_TYPE);
    return { key, sha256: digestOf(bytes), size: bytes.byteLength, upstream_sha: upstreamSha };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * The real spawner, with its two limits named so a test can shrink them.
 *
 * `GIT_TERMINAL_PROMPT=0` and an empty `GIT_ASKPASS` are not optional: core
 * never prompts (AGENTS.md rule 1), and a private or moved repo would otherwise
 * park the op on a credential prompt nobody can see — under the portal, forever.
 *
 * The timeout is three steps rather than one `kill()`, because one `kill()` was
 * not enough to guarantee the op ends:
 *
 * 1. `SIGTERM`, so a `git` that is merely slow unwinds and reports.
 * 2. `SIGKILL` `graceMs` later, for one that does not.
 * 3. **Reject anyway.** `git` spawns transport helpers (`git-remote-https`) and
 *    `!`-aliases as children that inherit these pipes; killing `git` does not
 *    kill them, and a surviving child holds `stdout`/`stderr` open, so the
 *    `Promise.all` below never settles and the timeout that just fired achieves
 *    nothing. Racing the deadline against the reads is what actually bounds the
 *    call. The orphan is reaped by its own exit; what matters here is that
 *    `ensureHermesMirror` gets an answer and the operator gets a warning.
 */
export function gitSpawner(limits: { timeoutMs: number; graceMs: number }): GitRun {
  return async (args, opts = {}) => {
    const proc = Bun.spawn(["git", ...args], {
      ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
        GCM_INTERACTIVE: "never",
      },
    });
    let term: ReturnType<typeof setTimeout> | undefined;
    let hard: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      term = setTimeout(() => {
        proc.kill("SIGTERM");
        hard = setTimeout(() => {
          proc.kill("SIGKILL");
          reject(
            new Error(
              `git ${args.join(" ")} did not finish within ${limits.timeoutMs} ms and was killed`,
            ),
          );
        }, limits.graceMs);
      }, limits.timeoutMs);
    });
    const finished = (async (): Promise<GitResult> => {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { code, stdout, stderr };
    })();
    try {
      return await Promise.race([finished, deadline]);
    } finally {
      clearTimeout(term);
      clearTimeout(hard);
    }
  };
}

/** The spawner every caller but a timeout test uses. */
export const spawnGit: GitRun = gitSpawner({
  timeoutMs: MIRROR_TIMEOUT_MS,
  graceMs: KILL_GRACE_MS,
});
