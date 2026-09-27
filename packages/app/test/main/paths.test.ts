/**
 * The bundle layout.
 *
 * `bundlePaths` takes `execPath` and the environment as arguments rather than
 * reading `process`, which is what lets these cases be the ones that matter —
 * a `HERMETIC_HOME` override, a home that is not this machine's, and the empty
 * string a shell leaves behind when it unsets an exported variable — instead of
 * whatever the test runner happens to have been launched with.
 */
import { describe, expect, test } from "bun:test";
import { bundlePaths, homeFrom } from "../../src/main/paths.ts";

const APP = "/Applications/Hermetic.app/Contents/Resources/app/bun";
const ENV = { HOME: "/Users/nobody" } as const;

describe("the sidecars", () => {
  test("live in `bin/` beside the running executable", () => {
    const paths = bundlePaths({ execPath: APP, env: ENV, fixture: false });
    expect(paths.binDir).toBe("/Applications/Hermetic.app/Contents/Resources/app/bin");
  });

  test("are named the way `HERMETIC_HERMETICD` and `HERMETIC_STAGES` expect", () => {
    const paths = bundlePaths({ execPath: APP, env: ENV, fixture: false });
    expect(paths.hermeticd).toBe(`${paths.binDir}/hermeticd`);
    expect(paths.stagesDir).toBe(`${paths.binDir}/stages`);
  });

  test("an executable at the root still resolves to a directory", () => {
    // Not a layout anybody ships, but `parentOf` deciding on a lone slash is
    // the difference between `/bin` and a path that starts with two of them.
    expect(bundlePaths({ execPath: "/bun", env: ENV, fixture: false }).binDir).toBe("/bin");
  });
});

describe("the home", () => {
  test("defaults to `~/.hermetic` under the environment's own `HOME`", () => {
    expect(homeFrom(ENV)).toBe("/Users/nobody/.hermetic");
  });

  test("`HERMETIC_HOME` wins, as it does for the CLI", () => {
    expect(homeFrom({ ...ENV, HERMETIC_HOME: "/tmp/other" })).toBe("/tmp/other");
  });

  test("an empty `HERMETIC_HOME` is not a home", () => {
    // `export HERMETIC_HOME=` is how a shell unsets a variable it already
    // exported. Honouring it would resolve every path against the cwd.
    expect(homeFrom({ ...ENV, HERMETIC_HOME: "" })).toBe("/Users/nobody/.hermetic");
  });
});

describe("the log", () => {
  test("goes in the home, under the name `log.ts` gives it", () => {
    expect(bundlePaths({ execPath: APP, env: ENV, fixture: false }).logPath).toBe(
      "/Users/nobody/.hermetic/app.log",
    );
  });

  test("fixture mode keeps its own, so a fixture run cannot be read as a real one", () => {
    expect(bundlePaths({ execPath: APP, env: ENV, fixture: true }).logPath).toBe(
      "/Users/nobody/.hermetic/app-fixture.log",
    );
  });
});
