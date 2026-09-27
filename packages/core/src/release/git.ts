/**
 * Which commit a release was built from, and whether the tree it was built from
 * was clean.
 *
 * Three facts, all from the checkout hermetic is running out of:
 *
 * - `build_number` — `git rev-list --count HEAD`. A monotonic integer along the
 *   branch, which is the one thing a digest cannot be. `a1b2c3d4 → e5f6a7b8`
 *   says two releases differ; `build 35 → build 36` says which one is newer,
 *   and therefore whether the operator is about to push their work or about to
 *   overwrite a colleague's with something older. Those need opposite actions
 *   and the fingerprint cannot tell them apart.
 * - `commit` — the short sha, so the number can be resolved back to a tree.
 * - `dirty` — whether anything is uncommitted or untracked.
 *
 * The number is only meaningful because of `dirty`. A commit count does not
 * move when a file is edited and not committed, so on its own it would repeat
 * the exact failure it was introduced to fix: a release whose contents changed
 * under an identifier that did not. `assertCleanTree` is what closes that, and
 * the two are deliberately in one module so neither is adopted without the
 * other.
 *
 * Everything here is best effort in one direction only. A checkout that is not
 * a git repository — a released binary, a tarball, a container — reports
 * `null`, and `null` never becomes a refusal: not knowing whether a tree is
 * clean is not the same as knowing it is dirty, and refusing on the first would
 * make hermetic unusable everywhere git is absent.
 */
import { HermeticError } from "../errors.ts";

/** What a source checkout says about itself. `null` when there is no checkout. */
export interface GitBuildInfo {
  /** `git rev-list --count HEAD` — commits reachable from HEAD, on this branch. */
  readonly build_number: number;
  /** Short sha of HEAD. */
  readonly commit: string;
  /** Anything modified, staged, or untracked. */
  readonly dirty: boolean;
}

export interface GitOptions {
  /**
   * The checkout to ask about. **Required in spirit**: callers pass the repo
   * root the release is actually built from (`findRepoRoot()`), never a default
   * taken from the process.
   *
   * It used to default to `process.cwd()`, which is the wrong repository
   * whenever the two differ — an installed `hermetic` run from `~/dotfiles`
   * would refuse the push because *dotfiles* had an edit, and a clean unrelated
   * repo with 900 commits would stamp `build_number: 900` onto the fleet and
   * make every later plan from the real checkout report "you are behind".
   * Every other checkout lookup in this package (`localBuild`, `locateStages`,
   * `resolveHermeticd`) resolves the root the same way, and this is now the
   * same answer rather than a second one.
   *
   * `null` disables the lookup entirely, which is what "no checkout" means.
   */
  readonly cwd?: string | null;
  /** Injected by tests so none of this has to run a real `git`. */
  readonly run?: (args: readonly string[], cwd: string) => { code: number; stdout: string };
}

/** Two seconds is far more than three local plumbing commands need. */
const GIT_TIMEOUT_MS = 2_000;

function runGit(args: readonly string[], cwd: string): { code: number; stdout: string } {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout: GIT_TIMEOUT_MS,
    // A release push must never stop on a credential prompt: everything here is
    // local plumbing and none of it should ever reach the network, but a
    // misconfigured `core.hooksPath` or a credential helper can still block.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  });
  return { code: proc.exitCode ?? 1, stdout: new TextDecoder().decode(proc.stdout).trim() };
}

/**
 * The checkout's own account of itself, or `null` when there is no usable one.
 *
 * `null` for every way of not being in a git checkout, and they are all
 * ordinary: a compiled binary on a box, a source tarball, a container built
 * without `.git`, a `git` that is not installed. None of those is an error and
 * none of them is a dirty tree — see the note at the top of this file.
 *
 * A shallow clone is deliberately rejected rather than reported. `git rev-list
 * --count` on a `--depth=1` checkout answers `1`, which is not a small error
 * but a completely different number: CI would stamp `build 1` on a release the
 * laptop would call `build 35`, and the ordering the field exists for would be
 * backwards. Absent is the honest answer; the fix is `fetch-depth: 0`.
 */
export function gitBuildInfo(opts: GitOptions = {}): GitBuildInfo | null {
  // No `process.cwd()` fallback: a caller that does not say which checkout it
  // means gets "no checkout" rather than whichever directory a shell happened
  // to be in. Silence is not a guess here any more than anywhere else.
  const cwd = opts.cwd ?? null;
  if (cwd === null) return null;
  const run = opts.run ?? runGit;

  let inside: { code: number; stdout: string };
  try {
    inside = run(["rev-parse", "--is-inside-work-tree"], cwd);
  } catch {
    // `git` is not on PATH. Not a checkout, as far as this is concerned.
    return null;
  }
  if (inside.code !== 0 || inside.stdout !== "true") return null;

  const shallow = run(["rev-parse", "--is-shallow-repository"], cwd);
  if (shallow.code !== 0 || shallow.stdout === "true") return null;

  const count = run(["rev-list", "--count", "HEAD"], cwd);
  const commit = run(["rev-parse", "--short", "HEAD"], cwd);
  // A repository with no commits at all answers neither, and has no build
  // number to give.
  if (count.code !== 0 || commit.code !== 0) return null;
  const build_number = Number.parseInt(count.stdout, 10);
  if (!Number.isInteger(build_number) || build_number <= 0) return null;
  if (commit.stdout.length === 0) return null;

  const status = run(["status", "--porcelain"], cwd);
  // A `status` that failed is the one case worth thinking about: the count and
  // the sha are known, but whether the tree is clean is not. Reporting
  // `dirty: true` would block a push on a question that was never answered, so
  // the whole reading is discarded — no number, no refusal, and `releaseDrift`
  // falls back to the fingerprint it used before.
  if (status.code !== 0) return null;

  return { build_number, commit: commit.stdout, dirty: status.stdout.length > 0 };
}

/**
 * Refuse to publish a release built from a tree that is not committed (§3.6).
 *
 * The rule the build number depends on. `git rev-list --count HEAD` counts
 * *commits*, so an edited-but-uncommitted file produces a release whose
 * contents differ from the last one under an identical build number — which is
 * precisely the shape of the bug this numbering replaced, arriving by a
 * different route. Either the number is trustworthy or it is decoration, and a
 * decoration is worse than nothing because people believe it.
 *
 * It is also the more useful half on its own. A release pushed from a dirty
 * tree cannot be reproduced by anyone, including the operator who pushed it:
 * `git checkout <commit>` does not bring back what was actually running on the
 * fleet. Whatever it is running becomes something nobody can rebuild.
 *
 * Refuses **only** on a definite `dirty: true`. A `null` reading — no checkout,
 * no git, a shallow clone, a `status` that failed — proceeds, because this is
 * the one thing in hermetic that would otherwise turn "I cannot tell" into
 * "no", and doing that here would break every release pushed from a built
 * binary.
 */
export function assertCleanTree(
  info: GitBuildInfo | null,
  opts: { readonly allowDirty?: boolean } = {},
): void {
  if (info === null || !info.dirty) return;
  if (opts.allowDirty === true) return;
  throw new HermeticError(
    "WORKING_TREE_DIRTY",
    `this checkout has uncommitted changes, so the release it would push is not the commit it claims to be: ` +
      `build ${info.build_number} (${info.commit}) already describes a different tree. ` +
      `Commit or stash them first — or set ${ALLOW_DIRTY_ENV}=1 to push anyway, accepting that nobody, including you, ` +
      `will be able to rebuild what the fleet is running.`,
    { build_number: info.build_number, commit: info.commit },
  );
}

/**
 * The escape hatch, as an environment variable rather than a flag.
 *
 * Deliberately awkward. Pushing an unreproducible release is a thing to do
 * knowingly once while debugging a box, not a flag that ends up in a script and
 * then in everyone's muscle memory — and a `--force`-shaped option on
 * `artifacts push`, `init` and `foundation update` alike would be exactly that.
 */
export const ALLOW_DIRTY_ENV = "HERMETIC_ALLOW_DIRTY";

/** Whether the escape hatch is set in this process's environment. */
export function allowDirtyFromEnv(env: Record<string, string | undefined> = process.env): boolean {
  return env[ALLOW_DIRTY_ENV] === "1";
}
