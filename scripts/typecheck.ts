/**
 * Typechecks every workspace package with `tsc --noEmit -p <pkg>`.
 * Run via `bun run typecheck`.
 */
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const packagesDir = join(root, "packages");

/**
 * The desktop app's Electrobun types come from a devkit Hutch projects into
 * `packages/app/.hutch/`, which is generated and not checked in. Without it,
 * three of the four programs fail on "cannot find module electrobun/…" — a
 * message that names the import and not the command that would produce it.
 */
const devkitTsconfig = join(packagesDir, "app", ".hutch", "devkit", "tsconfig.json");
if (!existsSync(devkitTsconfig)) {
  process.stderr.write(
    "typecheck: packages/app/.hutch/devkit is missing — run `bun run app:prepare` " +
      "(needs hutch on PATH, see CONTRIBUTING.md)\n",
  );
  process.exit(1);
}

const targets = [
  root,
  ...readdirSync(packagesDir)
    .map((d) => join(packagesDir, d))
    .filter((p) => existsSync(join(p, "tsconfig.json"))),
].filter((p) => existsSync(join(p, "tsconfig.json")));

let failed = false;
for (const target of targets) {
  const label = target === root ? "<root>" : target.slice(packagesDir.length + 1);
  process.stdout.write(`typecheck ${label}\n`);
  const res = spawnSync("bun", ["x", "tsc", "--noEmit", "-p", target], {
    stdio: "inherit",
    cwd: root,
  });
  if (res.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
