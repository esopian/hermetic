#!/usr/bin/env bun
/**
 * Runs `biome check .` (format + lint, report only, configured in `biome.jsonc`)
 * and fails on any diagnostic it prints, whatever its severity.
 *
 * Biome exits non-zero only for errors (and, with `--error-on-warnings`, for
 * warnings). Many of the recommended rules report at `info`, so a plain
 * `biome check` prints them, exits 0, and `check`, CI and the release script
 * all pass while the finding sits there until someone reads the scrollback.
 * Here the human-readable report still goes to the terminal, and a second,
 * JSON reporter written to a temp file gives the counts to decide on. A rule
 * the repo does not want is turned off in `biome.jsonc` with its reason, not
 * left to print. Wired into `bun run check` via `bun run lint:biome`.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface BiomeSummary {
  errors: number;
  warnings: number;
  infos: number;
}

/** The workspace's pinned Biome, so a direct `bun scripts/lint-biome.ts` does not need it on PATH. */
const BIOME = join(import.meta.dir, "..", "node_modules", ".bin", "biome");

function lint(report: string): number {
  const proc = Bun.spawnSync(
    [
      BIOME,
      "check",
      ".",
      "--error-on-warnings",
      "--reporter=default",
      "--reporter=json",
      `--reporter-file=${report}`,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );

  // Biome calls its JSON reporter experimental. The version is pinned, and a
  // report that no longer carries the counts fails here rather than passing.
  let summary: BiomeSummary | undefined;
  try {
    summary = (JSON.parse(readFileSync(report, "utf8")) as { summary?: BiomeSummary }).summary;
  } catch {
    summary = undefined;
  }
  if (
    typeof summary?.errors !== "number" ||
    typeof summary.warnings !== "number" ||
    typeof summary.infos !== "number"
  ) {
    process.stderr.write(`lint:biome: biome exited ${proc.exitCode} without a readable JSON summary\n`);
    return proc.exitCode || 2;
  }

  const { errors, warnings, infos } = summary;
  if (proc.exitCode !== 0 || errors + warnings + infos > 0) {
    process.stderr.write(
      `lint:biome: ${errors} error(s), ${warnings} warning(s), ${infos} info(s); ` +
        "every diagnostic fails the check\n",
    );
    return proc.exitCode || 1;
  }
  process.stdout.write("lint:biome: no diagnostics\n");
  return 0;
}

const dir = mkdtempSync(join(tmpdir(), "lint-biome-"));
let code: number;
try {
  code = lint(join(dir, "biome.json"));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(code);
