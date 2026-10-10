#!/usr/bin/env bun
/**
 * Runs shellcheck over the bootstrap stages (`packages/agentd/stages/*.sh`,
 * §4.3). Those files are the only shell hermetic ships to a box, they run as
 * root on first boot, and nothing else in the repo can catch the class of
 * mistake shellcheck exists for — an unquoted `$HERMETIC_DATA_MOUNT` reaching
 * `mkfs`, a `trap` that never fires, a `set -e` defeated by a pipeline. The
 * unit tests can only assert what the stages *say*; this asserts they are shell.
 *
 * shellcheck is Haskell, distributed for Python by `shellcheck-py`. It runs
 * through `uvx` pinned to SHELLCHECK_VERSION so a laptop and CI lint with the
 * same rules; set SHELLCHECK=/path/to/shellcheck to use an installed binary
 * instead (version is then yours to keep in step). Wired into `bun run check`
 * via `bun run lint:sh`, next to `lint:cfn`.
 *
 * It also lints the site's `curl … | bash` installer (`site/public/install.sh`):
 * the other shell hermetic hands to someone else's machine.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The `shellcheck-py` release, which carries shellcheck 0.11.0. */
export const SHELLCHECK_VERSION = "0.11.0.1";

/**
 * `-S warning` and no lower: a stage runs unattended as root, so "warning" is
 * the level at which a finding is a bug rather than a style note. Suppress one
 * only with a `# shellcheck disable=SCxxxx` line and a reason above it.
 */
const SEVERITY = "warning";

export const STAGES_DIR = join(import.meta.dir, "..", "packages", "agentd", "stages");

function command(): string[] | null {
  const override = process.env["SHELLCHECK"];
  if (override) return [override];
  if (Bun.which("uvx")) {
    return ["uvx", "--from", `shellcheck-py==${SHELLCHECK_VERSION}`, "shellcheck"];
  }
  const onPath = Bun.which("shellcheck");
  return onPath ? [onPath] : null;
}

const cmd = command();
if (cmd === null) {
  process.stderr.write(
    [
      "lint:sh: shellcheck not found.",
      "  install uv (https://docs.astral.sh/uv/) so `uvx` can run the pinned version, or",
      "  `brew install shellcheck` / set SHELLCHECK=/path/to/shellcheck.",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

const files = readdirSync(STAGES_DIR)
  .filter((name) => name.endsWith(".sh"))
  .sort()
  .map((name) => join(STAGES_DIR, name));

/** Served from the site at `/install.sh`; linted here because the root CI job has shellcheck. */
export const INSTALLER = join(import.meta.dir, "..", "site", "public", "install.sh");

if (files.length === 0) {
  process.stderr.write(`lint:sh: no stage scripts under ${STAGES_DIR}\n`);
  process.exit(2);
}

// shellcheck exits non-zero for anything at or above `-S`, which is what makes
// a warning fail the build rather than scroll past.
const installer = existsSync(INSTALLER) ? [INSTALLER] : [];
const proc = Bun.spawnSync([...cmd, "-S", SEVERITY, "--format", "tty", ...files, ...installer], {
  stdout: "inherit",
  stderr: "inherit",
});
if (proc.exitCode !== 0) {
  process.stderr.write(`lint:sh: shellcheck ${SHELLCHECK_VERSION} exited ${proc.exitCode}\n`);
  process.exit(proc.exitCode ?? 1);
}
process.stdout.write(
  `lint:sh: ${files.length} bootstrap stage(s)${installer.length ? " + site installer" : ""} clean (shellcheck ${SHELLCHECK_VERSION}, -S ${SEVERITY})\n`,
);
