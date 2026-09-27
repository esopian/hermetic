#!/usr/bin/env bun
/**
 * Stages the sidecars the desktop app bundles (§3.6).
 *
 * Electrobun's `build.copy` carries `packages/app/dist/bin` into the app's
 * `Resources/app/bin/`, and this script is the `preBuild` hook that fills that
 * directory: it runs `scripts/build.ts stage` and copies what the build left in
 * the repo's `dist/` across. One command builds the app, which is the point of
 * the hook.
 *
 * It refuses on a missing item rather than shipping a smaller bundle. An app
 * without `hermeticd` beside it looks fine until someone runs `init` from it,
 * at which point core reports `HERMETICD_UNAVAILABLE` from a bundle that was
 * built, signed and notarised — the same failure `scripts/build.ts` refuses for
 * the CLI, for the same reason.
 *
 * It also checks the vendored faces (`packages/ui/fonts`), which `build.copy`
 * carries into the same bundle: the page has no network behind `views://`, so a
 * `fonts.css` naming a file that is not there is the whole portal drawn in
 * Helvetica rather than a slow first paint.
 *
 * Usage: `bun run app:stage` (or as Electrobun's `preBuild` hook).
 */
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;

/** One thing the app bundles, and whether it is a file or a directory. */
export interface StagedItem {
  name: string;
  kind: "file" | "directory";
  /** Files the bundle must be able to execute. `hermeticd` is pushed, not run here. */
  executable?: boolean;
}

/**
 * Everything the app bundles beside itself, and nothing else.
 *
 * `hermetic` is the CLI the "Install Command Line Tool…" shim points at.
 * `hermeticd` and its two stamps are the agent release `artifacts push`
 * uploads — `resolveHermeticd` reads the version stamp before it will push, and
 * `hermeticd.build` is the fingerprint `create`/`rerun` warn from. `stages/`
 * is the bootstrap the box runs (§4.3).
 *
 * `hermetic-portal` is deliberately absent: the app is the head.
 */
export const STAGED_ITEMS: readonly StagedItem[] = [
  { name: "hermetic", kind: "file", executable: true },
  { name: "hermeticd", kind: "file" },
  { name: "hermeticd.version", kind: "file" },
  { name: "hermeticd.build", kind: "file" },
  { name: "stages", kind: "directory" },
];

/** What a refusal says: which item, and where it was looked for. */
export class StagingError extends Error {}

/**
 * Copies the staged items from a build's output directory into the app's `bin/`.
 *
 * Separate from the build it follows so it can be tested against a temporary
 * directory, which is the only way to prove the refusals: a real build takes
 * minutes and would have to be sabotaged to produce a missing item.
 */
export function stageBin(from: string, to: string): readonly string[] {
  const missing = STAGED_ITEMS.filter((item) => {
    const path = join(from, item.name);
    if (!existsSync(path)) return true;
    // A file where a directory belongs is as broken as nothing at all, and it
    // is the shape a half-finished build leaves behind.
    return statSync(path).isDirectory() !== (item.kind === "directory");
  });
  if (missing.length > 0) {
    throw new StagingError(
      `the app cannot be staged: ${missing.map((m) => m.name).join(", ")} ` +
        `${missing.length === 1 ? "is" : "are"} missing from ${from}. ` +
        `Run \`bun scripts/build.ts stage\` first.`,
    );
  }

  // Replaced rather than merged: a stale binary left by an earlier build is
  // exactly what a bundle must not ship, and nothing else writes here.
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });

  for (const item of STAGED_ITEMS) {
    cpSync(join(from, item.name), join(to, item.name), {
      recursive: item.kind === "directory",
      // `cpSync` keeps the mode, but the archive the updater applies has been
      // known to drop it, so the bit is set explicitly on the way in and
      // asserted on the way out.
      preserveTimestamps: true,
    });
    if (item.executable === true) chmodSync(join(to, item.name), 0o755);
  }
  return STAGED_ITEMS.map((item) => item.name);
}

/**
 * Every path a stylesheet names with `url()`, in source order.
 *
 * Deliberately naive: it reads `url(…)` with or without quotes and nothing
 * else, because `fonts.css` is a hand-written list of `@font-face` rules and a
 * parser that understood more would only have more ways to be wrong. A `data:`
 * or absolute URL is skipped — there is no local file to check.
 */
export function cssUrls(css: string): readonly string[] {
  const found: string[] = [];
  for (const match of css.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]+))\s*\)/g)) {
    const url = match[1] ?? match[2] ?? match[3] ?? "";
    if (url === "" || /^[a-z]+:/i.test(url) || url.startsWith("//")) continue;
    found.push(url.split(/[?#]/)[0] ?? url);
  }
  return found;
}

/**
 * Checks the vendored faces are all there, and refuses if they are not.
 *
 * `build.copy` carries `packages/ui/fonts` into the bundle whole and copies a
 * stylesheet naming a missing file as happily as one naming a present file. The
 * app has no network behind `views://`, so the result is not a slow font: it is
 * the whole portal drawn in Helvetica, in a bundle that built, signed and
 * notarised without complaint. Same reason `stageBin` refuses on a missing
 * `hermeticd`.
 */
export function checkFonts(dir: string): readonly string[] {
  const css = join(dir, "fonts.css");
  if (!existsSync(css)) {
    throw new StagingError(
      `the app cannot be staged: ${css} is missing. ` +
        `The bundle copies this directory as the page's only source of faces.`,
    );
  }
  const referenced = cssUrls(readFileSync(css, "utf8"));
  const missing = referenced.filter((url) => !existsSync(join(dir, url)));
  if (missing.length > 0) {
    throw new StagingError(
      `the app cannot be staged: fonts.css names ${missing.join(", ")}, ` +
        `${missing.length === 1 ? "which is" : "which are"} not in ${dir}.`,
    );
  }
  return referenced;
}

function main(): void {
  const build = spawnSync("bun", [join(root, "scripts/build.ts"), "stage"], {
    stdio: "inherit",
    cwd: root,
  });
  if (build.status !== 0) {
    process.stderr.write("app:stage failed: the sidecar build did not finish\n");
    process.exit(1);
  }

  const to = join(root, "packages/app/dist/bin");
  const fonts = join(root, "packages/ui/fonts");
  try {
    const faces = checkFonts(fonts);
    const staged = stageBin(join(root, "dist"), to);
    process.stdout.write(`staged ${staged.length} item(s) into ${to}\n`);
    process.stdout.write(`checked ${faces.length} font file(s) under ${fonts}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

// Only when run as a script: the test imports `stageBin` and must not build.
if (import.meta.main) main();
