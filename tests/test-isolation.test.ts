/**
 * The gate on `tests/preload.ts`.
 *
 * The preload is the only thing standing between this suite and the operator's
 * own `~/.hermetic`, and it is wired up in a file (`bunfig.toml`) that nothing
 * else in the repository reads. That is exactly the kind of protection that
 * rots quietly: delete the preload line, or rename the file, and every test
 * still passes — against the developer's real fixture database, which a
 * teardown test is entitled to empty. It has happened: a run dropped the
 * `fxtr0001` config row out of a laptop's `hermetic-fixture.db` and left
 * `~/.hermetic/archive/foundation-v11-*` behind.
 *
 * So this file asserts the three things that together mean "the preload ran and
 * is still wired up": the environment it sets, the configuration that loads it,
 * and — statically — that no test file hardcodes a path back into the real
 * home. The first two would fail immediately if the preload stopped running,
 * which is the property that matters; the third catches the other way in, a
 * test that names `~/.hermetic` regardless of what `HERMETIC_HOME` says.
 */
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, isAbsolute, sep } from "node:path";
import { realpathSync } from "node:fs";
import { dbPath, hermeticHome, openHermetic } from "@hermetic/core";

const ROOT = new URL("..", import.meta.url).pathname;

/** The preload, as `bunfig.toml` names it and as it sits on disk. */
const PRELOAD_SPEC = "./tests/preload.ts";
const PRELOAD_PATH = join(ROOT, "tests", "preload.ts");

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** `true` when `path` is `root` or sits inside it. Both must already be real paths. */
function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Every test file that could open local state: the package suites plus the root
 * seam tests.
 *
 * `packages/ui/test` is excluded, and the import-boundary table is why. The UI
 * may not import core at all (`tests/boundaries.test.ts`, `ui → core: no`), so
 * no UI test can reach `hermeticHome()` or open a database however it is
 * written. What it does have is fixture props called `home` holding whatever
 * string the header is supposed to render — `/tmp/hermetic-home` is one —
 * and sweeping those up would mean this gate cried wolf at the cost of the
 * checks that matter. `boundaries` is the test that keeps the exclusion honest.
 */
function testFiles(): string[] {
  const dirs = readdirSync(join(ROOT, "packages"))
    .filter((pkg) => pkg !== "ui")
    .map((pkg) => join(ROOT, "packages", pkg, "test"));
  dirs.push(join(ROOT, "tests"));
  return dirs
    .flatMap(walk)
    .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
    .filter((f) => f !== PRELOAD_PATH);
}

describe("the preload gave this process a home of its own", () => {
  test("HERMETIC_HOME is set, absolute, and a directory that exists", () => {
    const home = process.env["HERMETIC_HOME"];
    expect(home).toBeString();
    expect(isAbsolute(home ?? "")).toBe(true);
    expect(existsSync(home ?? "")).toBe(true);
  });

  test("it is under the temp directory and not under the real home", () => {
    const home = realpathSync(process.env["HERMETIC_HOME"] as string);
    expect(isInside(home, realpathSync(tmpdir()))).toBe(true);
    expect(isInside(home, realpathSync(homedir()))).toBe(false);
  });

  test.each(["HERMETIC_FLEET", "HERMETIC_FIXTURE", "AWS_PROFILE"])(
    "%s is cleared, so the shell cannot change what the suite tests",
    (key) => {
      expect(process.env[key]).toBeUndefined();
    },
  );

  /**
   * The assertion with teeth: not what the variable says, but where core would
   * actually put a database. `hermeticHome()` is the single resolver every
   * `openHermetic`/`openForInit`/`openLocalDb` call goes through, so this is the
   * door the whole suite walks through, checked at the door.
   */
  test("core's own resolver lands in the temp home, not in ~/.hermetic", () => {
    expect(realpathSync(hermeticHome())).toBe(realpathSync(process.env["HERMETIC_HOME"] as string));
    expect(hermeticHome()).not.toBe(join(homedir(), ".hermetic"));
  });

  /**
   * And the end of the same walk: not where the resolver says a database would
   * go, but where one an ordinary call actually opens ends up. `openHermetic`
   * with no home is the exact call that used to reach the operator's own
   * fixture database and rewrite it.
   */
  test("a bare openHermetic({ fixture: true }) writes inside the temp home", async () => {
    await openHermetic({ fixture: true });
    const db = realpathSync(dbPath(undefined, { fixture: true }));
    expect(isInside(db, realpathSync(process.env["HERMETIC_HOME"] as string))).toBe(true);
    expect(existsSync(db)).toBe(true);
  });

  test("a TMPDIR under HOME is refused before the preload creates anything", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "hermetic-preload-refusal-"));
    const fakeHome = join(sandbox, "home");
    const fakeTmp = join(fakeHome, "tmp");
    mkdirSync(fakeTmp, { recursive: true });
    const before = readdirSync(fakeTmp);
    try {
      const run = Bun.spawnSync({
        cmd: [process.execPath, "--preload", PRELOAD_PATH, "-e", ";"],
        env: { ...process.env, HOME: fakeHome, TMPDIR: fakeTmp },
      });
      expect(run.exitCode).not.toBe(0);
      expect(run.stderr.toString()).toContain("would resolve inside the real home directory");
      expect(readdirSync(fakeTmp)).toEqual(before);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

describe("the preload stays wired up", () => {
  test("bunfig.toml preloads it for every test process", () => {
    const bunfig = readFileSync(join(ROOT, "bunfig.toml"), "utf8");
    // Bun reads `[test] preload` only; a top-level `preload` would also load
    // into `bun run dev` and the CLI, so the section is part of the contract.
    const section = bunfig.slice(bunfig.indexOf("[test]"));
    expect(bunfig).toContain("[test]");
    expect(section).toContain(PRELOAD_SPEC);
  });

  test("the file bunfig.toml names exists and pins HERMETIC_HOME", () => {
    expect(existsSync(PRELOAD_PATH)).toBe(true);
    const source = readFileSync(PRELOAD_PATH, "utf8");
    expect(source).toContain('process.env["HERMETIC_HOME"]');
    expect(source).toContain("mkdtempSync");
  });
});

/**
 * Comments removed, line by line: every prose paragraph in this repository is a
 * `/** … *␦/` block whose continuation lines start with `*`, and the checks
 * below are about what a file *does*, not what it explains. A line-based strip
 * rather than a real parse because the alternative — matching `//` anywhere —
 * would eat the `http://` in every URL in the suite.
 */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => {
      const t = line.trimStart();
      return !(t.startsWith("*") || t.startsWith("//") || t.startsWith("/*"));
    })
    .join("\n");
}

describe("no test file reaches for the operator's real home", () => {
  /**
   * `homedir()` is the one way a test can walk around the preload entirely, and
   * it has no legitimate use in one: a test that wants a home of its own makes
   * it under `tmpdir()`, and a test that wants the default leaves
   * `HERMETIC_HOME` alone and gets the preload's.
   *
   * A bare `~/.hermetic` is deliberately *not* on this list. Core's
   * `hermeticHome()` does not expand `~`, so the literal cannot become a real
   * path by accident, and it appears legitimately as a test's own name and as
   * the input `log.test.ts` feeds `logPathFor` to prove it gets expanded.
   *
   * This file is its own exception, and the only one: proving the temp home is
   * *not* under `homedir()` means naming `homedir()`.
   */
  test("none of them call homedir()", () => {
    const offenders = testFiles()
      .filter((f) => f !== join(ROOT, "tests", "test-isolation.test.ts"))
      .filter((file) => code(file).includes("homedir("))
      .map((f) => f.slice(ROOT.length));
    expect(offenders).toEqual([]);
  });

  /**
   * A test process is free to make its own temp directories, but a *fixed* path
   * is shared with every other process on the machine — including the same
   * suite in the developer's second terminal, and the next run of this one.
   * `mkdtemp` or nothing. Scoped to literals that name hermetic, so a UI test
   * whose router prop happens to be called `home` is not swept up.
   */
  test("none of them hardcode a fixed path as a HERMETIC_HOME", () => {
    const fixed = /(?:home|HERMETIC_HOME)"?:\s*["'`]\/[^"'`]*hermetic/i;
    const offenders = testFiles().filter((file) => fixed.test(code(file)));
    expect(offenders.map((f) => f.slice(ROOT.length))).toEqual([]);
  });
});
