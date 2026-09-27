#!/usr/bin/env bun
/**
 * Runs cfn-lint over the foundation template (`packages/core/src/aws/cfn-template.ts`,
 * rendered exactly as `init` sends it to CreateStack). Static and offline: it
 * checks `Fn::Sub` variable names, property names and types against AWS's
 * resource schemas, and IAM policy shape — the class of mistake our own unit
 * tests only catch when someone thought to assert it. The one that prompted
 * this (`${aws:PrincipalTag/agent}` bare inside an `Fn::Sub`) surfaced as a
 * CreateStack rejection on a real account after identity and Tailscale had
 * already been verified; cfn-lint reports it as E1019 in under a second.
 *
 * cfn-lint is Python. It runs through `uvx` pinned to CFN_LINT_VERSION so a
 * laptop and CI lint with the same rules; set CFN_LINT=/path/to/cfn-lint to
 * use an installed binary instead (version is then yours to keep in step).
 * Wired into `bun run check` via `bun run lint:cfn`.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foundationTemplateBody } from "../packages/core/src/aws/cfn-template.ts";

export const CFN_LINT_VERSION = "1.56.0";

function command(): string[] | null {
  const override = process.env["CFN_LINT"];
  if (override) return [override];
  if (Bun.which("uvx")) return ["uvx", "--from", `cfn-lint==${CFN_LINT_VERSION}`, "cfn-lint"];
  const onPath = Bun.which("cfn-lint");
  return onPath ? [onPath] : null;
}

const cmd = command();
if (cmd === null) {
  process.stderr.write(
    [
      "lint:cfn: cfn-lint not found.",
      "  install uv (https://docs.astral.sh/uv/) so `uvx` can run the pinned version, or",
      "  `pipx install cfn-lint` / set CFN_LINT=/path/to/cfn-lint.",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), "hermetic-cfn-"));
const file = join(dir, "hermetic.template.json");
writeFileSync(file, foundationTemplateBody());
try {
  // cfn-lint exits 2 on errors, 4 on warnings, 6 on both, 8 on informational;
  // all of them fail here — a warning is a review comment, and reviews are
  // answered by fixing or by an `ignore_checks` entry with a reason.
  const proc = Bun.spawnSync([...cmd, "--format", "parseable", file], {
    stdout: "inherit",
    stderr: "inherit",
  });
  if (proc.exitCode !== 0) {
    process.stderr.write(`lint:cfn: cfn-lint ${CFN_LINT_VERSION} exited ${proc.exitCode}\n`);
    process.exit(proc.exitCode ?? 1);
  }
  process.stdout.write(`lint:cfn: foundation template clean (cfn-lint ${CFN_LINT_VERSION})\n`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
