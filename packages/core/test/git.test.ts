/**
 * §3.6's build number and the clean-tree rule that makes it mean anything.
 *
 * Every test drives `gitBuildInfo` through an injected `run`, so none of this
 * shells out and none of it depends on the state of the repository it is
 * running inside — which is the whole point: the real reader walks *this*
 * checkout, and a suite that failed whenever its author had unsaved work would
 * be unusable.
 */
import { describe, expect, test } from "bun:test";
import {
  ALLOW_DIRTY_ENV,
  allowDirtyFromEnv,
  assertCleanTree,
  gitBuildInfo,
} from "../src/release/git.ts";
import type { HermeticError } from "../src/errors.ts";

/** A fake `git`, keyed by the subcommand each call starts with. */
function fakeGit(answers: Record<string, { code?: number; stdout?: string }>) {
  return (args: readonly string[]): { code: number; stdout: string } => {
    const key = args.join(" ");
    const hit = answers[key];
    if (!hit) throw new Error(`unexpected git invocation: ${key}`);
    return { code: hit.code ?? 0, stdout: hit.stdout ?? "" };
  };
}

const CLEAN = {
  "rev-parse --is-inside-work-tree": { stdout: "true" },
  "rev-parse --is-shallow-repository": { stdout: "false" },
  "rev-list --count HEAD": { stdout: "35" },
  "rev-parse --short HEAD": { stdout: "427e7b2" },
  "status --porcelain": { stdout: "" },
};

describe("gitBuildInfo", () => {
  test("a clean checkout reports its number, its commit, and that it is clean", () => {
    expect(gitBuildInfo({ cwd: "/repo", run: fakeGit(CLEAN) })).toEqual({
      build_number: 35,
      commit: "427e7b2",
      dirty: false,
    });
  });

  test("an uncommitted change is reported as dirty, not hidden", () => {
    const run = fakeGit({
      ...CLEAN,
      "status --porcelain": { stdout: " M packages/agentd/src/apply.ts" },
    });
    expect(gitBuildInfo({ cwd: "/repo", run })?.dirty).toBe(true);
  });

  test("an untracked file counts too — it would ship in the release", () => {
    const run = fakeGit({
      ...CLEAN,
      "status --porcelain": { stdout: "?? packages/agentd/stages/07-new.sh" },
    });
    expect(gitBuildInfo({ cwd: "/repo", run })?.dirty).toBe(true);
  });

  /**
   * Every one of these is an ordinary way to run hermetic, and none of them is
   * a dirty tree. `null` is the answer, and `assertCleanTree` never refuses on
   * it.
   */
  test("no checkout at all is null, which is not the same as dirty", () => {
    const run = fakeGit({ "rev-parse --is-inside-work-tree": { code: 128, stdout: "" } });
    expect(gitBuildInfo({ cwd: "/repo", run })).toBeNull();
  });

  test("no git on PATH is null", () => {
    const run = (): never => {
      throw new Error("spawn git ENOENT");
    };
    expect(gitBuildInfo({ cwd: "/repo", run })).toBeNull();
  });

  test("`cwd: null` disables the lookup entirely", () => {
    expect(gitBuildInfo({ cwd: null })).toBeNull();
  });

  /**
   * And so does saying nothing. There is no `process.cwd()` fallback, because
   * the checkout a release is built from and the directory a shell happens to
   * be in are different questions: an installed `hermetic` run from `~/dotfiles`
   * would otherwise refuse the push because *dotfiles* had an edit, and a clean
   * unrelated repo would stamp its own commit count onto the fleet.
   */
  test("a caller that names no checkout gets no reading, not the shell's", () => {
    expect(gitBuildInfo()).toBeNull();
    expect(gitBuildInfo({})).toBeNull();
  });

  /**
   * The one that would otherwise be silently wrong. `rev-list --count` on a
   * `--depth=1` clone answers `1` — not a smaller number, a different one — so
   * CI would stamp `build 1` on the release a laptop calls `build 35` and the
   * ordering this field exists for would run backwards. `actions/checkout@v4`
   * shallow-clones by default, so this is the common CI shape, not an exotic one.
   */
  test("a shallow clone is refused rather than believed", () => {
    const run = fakeGit({ ...CLEAN, "rev-parse --is-shallow-repository": { stdout: "true" } });
    expect(gitBuildInfo({ cwd: "/repo", run })).toBeNull();
  });

  /**
   * The count and the sha are known here, and whether the tree is clean is not.
   * Returning the pair without `dirty` would force a guess at the one field the
   * refusal reads, so the whole reading is discarded.
   */
  test("a status that failed discards the whole reading rather than guessing", () => {
    const run = fakeGit({ ...CLEAN, "status --porcelain": { code: 1, stdout: "" } });
    expect(gitBuildInfo({ cwd: "/repo", run })).toBeNull();
  });

  test("a repository with no commits has no build number", () => {
    const run = fakeGit({ ...CLEAN, "rev-list --count HEAD": { code: 128, stdout: "" } });
    expect(gitBuildInfo({ cwd: "/repo", run })).toBeNull();
  });

  test("a count that is not a positive integer is not believed", () => {
    for (const stdout of ["0", "", "abc", "-3"]) {
      const run = fakeGit({ ...CLEAN, "rev-list --count HEAD": { stdout } });
      expect(gitBuildInfo({ cwd: "/repo", run })).toBeNull();
    }
  });
});

describe("assertCleanTree", () => {
  test("a clean tree passes", () => {
    expect(() => assertCleanTree({ build_number: 35, commit: "abc1234", dirty: false })).not.toThrow();
  });

  test("a dirty tree is refused, and the message says which commit it is lying about", () => {
    let err: HermeticError | null = null;
    try {
      assertCleanTree({ build_number: 35, commit: "427e7b2", dirty: true });
    } catch (e) {
      err = e as HermeticError;
    }
    expect(err?.code).toBe("WORKING_TREE_DIRTY");
    expect(err?.message).toContain("build 35");
    expect(err?.message).toContain("427e7b2");
    // It names the way out rather than leaving the operator to find it.
    expect(err?.message).toContain(ALLOW_DIRTY_ENV);
  });

  /**
   * The asymmetry this whole module rests on. A refusal is only ever made on a
   * definite `dirty: true`; "I could not tell" proceeds, because turning that
   * into a "no" would refuse every release pushed from a built binary, a
   * tarball or a container — none of which has a repository to ask.
   */
  test("an unknown checkout proceeds — it is not a dirty one", () => {
    expect(() => assertCleanTree(null)).not.toThrow();
  });

  test("the escape hatch lets a dirty tree through", () => {
    expect(() =>
      assertCleanTree({ build_number: 35, commit: "abc1234", dirty: true }, { allowDirty: true }),
    ).not.toThrow();
  });
});

describe("the escape hatch is deliberately exact", () => {
  test("only `1` enables it", () => {
    expect(allowDirtyFromEnv({ [ALLOW_DIRTY_ENV]: "1" })).toBe(true);
    // Not "true", not "yes", not an empty string — a variable left set to
    // something vague must not quietly disable a guard.
    for (const value of ["true", "yes", "0", "", undefined]) {
      expect(allowDirtyFromEnv({ [ALLOW_DIRTY_ENV]: value })).toBe(false);
    }
    expect(allowDirtyFromEnv({})).toBe(false);
  });
});
