/**
 * A `HERMETIC_HOME` of one test's own.
 *
 * `tests/preload.ts` already keeps the whole run out of the operator's
 * `~/.hermetic`, which is the safety property. This is the *determinism* one:
 * `bun test` runs every file of a package in a single process, so a run-level
 * home is still one directory shared by every harness in `packages/app/test`
 * — and `openState`/`openHermetic` write real rows into the
 * `hermetic-fixture.db` inside it. `fleet use` records a default; `init`
 * freezes a config; teardown drops one. A suite sharing that file has each test
 * starting from whatever the previous one decided, which is exactly the shape
 * of failure that made `bun test packages/app/test/app.test.ts` on its own
 * disagree with `bun test packages/app`.
 *
 * `packages/app/test/fleets.test.ts` solved it first, per harness, with
 * `mkdtempSync` plus an `afterAll` that removes what it made. This is that,
 * factored out, so every harness in the package can have it for the cost of one
 * call.
 *
 * Cleanup is by *containment* rather than by a hook: each directory is made
 * inside the run's own `HERMETIC_HOME`, which the preload removes when the
 * process ends however it ends. A module-level `afterAll` here would have been
 * wrong — bun registers a hook in the scope of the file that pulled the module
 * in, and a module is evaluated once, so the whole package's directories would
 * have been swept after whichever file imported this one first, out from under
 * every later file.
 *
 * The *other* half of a fixture session's state — the fleet directory — is a
 * `FixtureAccount` each `openState` creates for itself, so no temp directory
 * touches it and no test's `init` or teardown reaches another's fleet list.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Where the per-harness directories go. The preload's home when there is one;
 * `tmpdir()` when this module is somehow reached without it, so the helper
 * still cannot land in `~/.hermetic` — `tests/test-isolation.test.ts` is what
 * fails loudly in that case, rather than a stray directory nobody looks at.
 */
const root = process.env["HERMETIC_HOME"] ?? tmpdir();

/**
 * A fresh, empty directory for one harness to use as its `HERMETIC_HOME`.
 *
 * `prefix` is cosmetic — it only makes a leaked directory name the suite that
 * leaked it — but it costs nothing and has paid for itself more than once.
 */
export function testHome(prefix = "server-test-"): string {
  return mkdtempSync(join(root, prefix));
}

/**
 * §4.7: the fleet a mutation against `hermetic` has to name.
 *
 * Every fleet-scoped write the app serves carries a `target`, and an absent one
 * is refused exactly as firmly as a wrong one (`src/target.ts`). That holds on a
 * state built around a single instance too, since it binds that instance's own
 * target — so a test that dispatches a mutation names the fleet, the same way
 * the page does.
 */
export function fleetTarget(hermetic: {
  target: { account_id: string; region: string; fleet_id: string } | null;
}): { account_id: string; region: string; fleet_id: string } {
  const target = hermetic.target;
  if (target === null) throw new Error("this instance has no fleet to target");
  return { account_id: target.account_id, region: target.region, fleet_id: target.fleet_id };
}
