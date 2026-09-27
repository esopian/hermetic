/**
 * The `scripts.preBuild` hook.
 *
 * Hutch does not run a hook as a command. It writes a runner beside the build
 * that does `import * as hook from "<scripts.preBuild>"` and calls the module's
 * *default export* — so the configured string is a module path resolved against
 * this package, not a shell line, and `bun ../../scripts/app-stage.ts` failed as
 * a module specifier rather than running anything.
 *
 * `scripts/app-stage.ts` stays a script: it does its work under
 * `import.meta.main` so that its own test can import `stageBin` without
 * building the sidecars. This file is the adapter between the two — one
 * subprocess, inherited stdio so the staging output reaches the build log, and
 * a throw on a non-zero exit because a bundle missing `hermeticd` looks fine
 * until someone runs `init` from it.
 *
 * The path is derived from this file rather than from `process.cwd()`, which
 * belongs to whatever invoked the build.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "..", "..", "scripts", "app-stage.ts");

export default function preBuild(): void {
  const run = spawnSync("bun", [SCRIPT], { stdio: "inherit" });
  if (run.error) throw run.error;
  if (run.status !== 0) {
    throw new Error(`preBuild: app-stage.ts exited ${run.status ?? "on a signal"}`);
  }
}
