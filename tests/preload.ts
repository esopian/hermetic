/**
 * The first thing every `bun test` process runs (root `bunfig.toml`, `[test]
 * preload`), before any test file — and therefore before any module that could
 * open state — is evaluated.
 *
 * Why it exists: `hermeticHome()` (`packages/core/src/local/db/index.ts`) falls back
 * to `~/.hermetic` when `HERMETIC_HOME` is unset, so a test that opened state
 * without naming a home opened the *operator's* home. Fixture mode kept that
 * honest as far as the filename went — `hermetic-fixture.db`, never
 * `hermetic.db` — but a fixture database in `~/.hermetic` is still the
 * developer's, shared by their `bun run dev:fixture` portal and their
 * `hermetic --fixture` runs. A teardown test dropped the `fxtr0001` config row
 * out of one, and an archive test left `~/.hermetic/archive/foundation-v11-*`
 * behind. Those runs were not wrong about what they asked for; nothing had
 * pinned where "here" was.
 *
 * So `HERMETIC_HOME` is pinned here, for the whole process, to a fresh
 * `mkdtemp` directory under `os.tmpdir()`. Three consequences worth naming:
 *
 *   - A test that names no home gets the temp one rather than the real one.
 *   - A `Bun.spawn` that forwards `...process.env` (every CLI test does) hands
 *     the same temp home to the child, so subprocess suites inherit the pin
 *     without each call site repeating it.
 *   - `bun test` is one process per invocation, so this home is shared by every
 *     file in a run. It stops the suite reaching the real home; it does not by
 *     itself stop one file leaking into the next. Tests that mutate state a
 *     later test reads still take their own home (`mkdtempSync` in the file's
 *     own harness) — `packages/app/test/fleets.test.ts` is the pattern.
 *
 * What this deliberately does *not* do is set `HERMETIC_FIXTURE`. No suite
 * relies on that variable being set ambiently: the server tests pass
 * `{ fixture: true }` explicitly and the CLI tests put `HERMETIC_FIXTURE=1` in
 * the child's env themselves. Setting it here would silently flip every core
 * test that opens a *real*-mode `Hermetic` into fixture mode, which is a change
 * of behaviour, not of isolation.
 *
 * An inherited `HERMETIC_HOME` is replaced rather than honoured, which is the
 * one place this disagrees with the version that grew on `master`. A named home
 * cannot be assumed safe: CI's own `setup` action named
 * `${runner.temp}/hermetic-home`, and on a GitHub runner that path sits under
 * `/home/runner` — inside the very directory this file exists to stay out of.
 * The check above would then have to be dropped to let CI run, which is the
 * wrong trade. The action no longer names one; this file owns the variable.
 *
 * `tests/test-isolation.test.ts` is the gate that fails if this stops running.
 */
import { afterAll, afterEach } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";

/** `true` when `path` is `root` or sits inside it, both resolved through symlinks. */
function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

const tempRoot = realpathSync(tmpdir());
const realHome = realpathSync(homedir());

/**
 * The assertion the whole file is for. `tmpdir()` reads `TMPDIR`, which a
 * developer or a CI image is free to point anywhere — including at something
 * under `$HOME`. Resolved through symlinks on both sides, because macOS's
 * `/var` is a link to `/private/var` and a prefix comparison between the two
 * spellings is meaningless.
 *
 * Check the parent before `mkdtempSync`: a refusal that first creates its own
 * directory under the real home has already violated the rule, and because the
 * hooks below are not registered yet it leaks that directory too.
 */
if (isInside(tempRoot, realHome)) {
  throw new Error(
    `test HERMETIC_HOME would resolve inside the real home directory (${tempRoot} is under ${realHome}) — ` +
      "tests must never read or write ~/.hermetic; check TMPDIR",
  );
}

const home = mkdtempSync(join(tempRoot, "hermetic-test-home-"));
process.env["HERMETIC_HOME"] = home;

/**
 * A `bun:test` hook registered from a preload is a hook on the whole run, so
 * this is the last thing the process does with the directory. `force` because a
 * test may legitimately have removed it already, and because a run that failed
 * still has to clean up after itself.
 *
 * `exit` as well, and not instead: bun's test runner does not fire `afterAll`
 * on a crash or an interrupt, and a bare `process.on("exit")` on its own was
 * observed not to fire at the end of a normal `bun test` — between them the
 * directory goes away on every ending that leaves the process able to run code.
 */
function cleanup(): void {
  rmSync(home, { recursive: true, force: true });
}

afterAll(cleanup);
process.on("exit", cleanup);

/**
 * The rest of what a shell can hand a suite.
 *
 * The home above was the loud half of this: a developer who had ever run
 * `hermetic fleet use staging --fixture` had a fixture database whose default
 * fleet was `staging`, and the server suite failed on a two-agent fleet where it
 * expected twelve. These three reach the same place by a shorter route —
 * `HERMETIC_FLEET` *is* the fleet selection (`open.ts`'s `fixtureFleetId` and
 * `resolveFleetId`), `HERMETIC_FIXTURE` decides the mode a bare `openHermetic`
 * opens, and `AWS_PROFILE` decides which credentials `aws.client()` would reach
 * for. None of them is cleared by pointing the home somewhere else.
 *
 * Unset rather than overwritten, because there is no right value to impose: the
 * absence *is* the default every test was written against. A test that wants one
 * of these sets it itself — which is also the escape hatch, since nothing here
 * runs after the test file does.
 *
 * `HERMETIC_HOME` is deliberately not in this list because the fresh temp home
 * above has already replaced it. These three are cleared separately because
 * they change *what the suite is testing*, not only where it writes state.
 */
for (const key of ["HERMETIC_FLEET", "HERMETIC_FIXTURE", "AWS_PROFILE"]) {
  delete process.env[key];
}

/**
 * The UI harness's per-test reset (`packages/ui/test/setup.ts`), after every
 * test of every file.
 *
 * A hook registered at the top level of an imported module attaches only to the
 * test file that was loading when the module was evaluated, and `setup.ts` is
 * evaluated once per run — so as an `afterEach` of its own, its reset ran for
 * the first DOM file and no other. Hooks in this preload run for every file.
 * It is looked up on `globalThis` rather than imported so that core's, the
 * app's and agentd's runs never load the UI's modules; until a UI test has
 * loaded `setup.ts` there is nothing to reset and this does nothing.
 */
afterEach(() => {
  (globalThis as { __hermeticUiReset?: () => void }).__hermeticUiReset?.();
});
