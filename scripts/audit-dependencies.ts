#!/usr/bin/env bun
/**
 * The dependency advisory gate: `bun run audit:dependencies`.
 *
 * `bun install --frozen-lockfile` makes every build install the same tree, which
 * is the point — and also means a package that was clean when it was pinned
 * stays pinned after an advisory lands against it. Nothing in `bun run check`
 * would notice. This runs the pinned bun's `bun audit` over the resolved graph
 * (workspace packages, dev dependencies and transitive dependencies included —
 * verified against Bun 1.3.10) and fails on a high or critical finding.
 *
 * It is deliberately not part of `bun run check`: check is offline, and a lint
 * that needs a network service is a lint that fails on a plane. It is the last
 * step of `bun run ci`, and its own CI job.
 *
 * The distinction this file exists to preserve is advisory vs. broken. A
 * scanner that timed out, printed nothing, or printed something this code
 * cannot read is *not* a clean bill of health, and must never exit 0. Exit
 * codes: 0 clean, 1 advisory found, 2 the scan itself failed.
 */
import { fileURLToPath } from "node:url";

/** Severities that fail the gate. Anything below is printed and passes. */
export const FAILING_SEVERITIES = new Set(["high", "critical"]);

/** Severities `bun audit` is known to report. An unknown one fails, see classify. */
const KNOWN_SEVERITIES = new Set(["info", "low", "moderate", "high", "critical"]);

/**
 * Advisories waived, as `--ignore` arguments (GHSA or advisory ID).
 *
 * Empty, and kept that way by preference: an entry needs the advisory ID, the
 * package, why it does not apply here, and who is watching it, written beside
 * it. When there are two of these, move them to a reviewed file with an
 * expiry.
 */
export const IGNORED_ADVISORIES: string[] = [];

/**
 * How long the scanner gets before the run counts as an infrastructure failure.
 *
 * A malformed override falls back rather than resolving to `NaN` or `0`, either
 * of which would kill the scanner the instant it started and report a timeout
 * nobody caused.
 */
const configured = Number(process.env["HERMETIC_AUDIT_TIMEOUT_MS"]);
export const TIMEOUT_MS = Number.isFinite(configured) && configured > 0 ? configured : 120_000;

/** Grace between SIGTERM and SIGKILL, for a scanner that ignores the first. */
export const KILL_GRACE_MS = 5_000;

/** Exit codes `bun audit` uses: 0 clean, 1 advisories found. Anything else is a failure. */
const EXPECTED_EXITS = new Set([0, 1]);

/** One transient failure is weather; two is a problem worth failing for. */
export const ATTEMPTS = 2;

export type Finding = {
  package: string;
  id: string;
  title: string;
  severity: string;
  url: string;
};

export type AuditRun = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Set by the caller's timer, not inferred from the process — see runAudit. */
  timedOut?: boolean;
  signalCode?: string | null;
};

export type Verdict =
  | { kind: "clean"; findings: Finding[] }
  | { kind: "vulnerable"; findings: Finding[]; failing: Finding[] }
  /** The scan did not produce a usable answer. Never reported as clean. */
  | { kind: "broken"; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

function tail(text: string, lines = 3): string {
  const kept = text.trim().split("\n").slice(-lines).join("; ");
  return kept === "" ? "(no output)" : kept;
}

/**
 * Turn one scanner run into a verdict.
 *
 * `bun audit --json` writes `{ "<package>": [ {id, url, title, severity, ...} ] }`
 * to stdout — `{}` when clean — and exits nonzero when it found something. Both
 * halves are checked against each other: a nonzero exit with nothing to show for
 * it is the scanner failing, not the tree being clean, and an unreadable report
 * is never coerced into an empty one.
 */
export function classify(run: AuditRun): Verdict {
  // Checked before the report is even read. A scan that was killed, or that
  // died in a way `bun audit` has no exit code for, tells us nothing about the
  // tree — including when it managed to print a complete-looking report first.
  if (run.timedOut === true) {
    return { kind: "broken", reason: `scanner timed out after ${TIMEOUT_MS} ms` };
  }
  if (run.signalCode !== undefined && run.signalCode !== null) {
    return { kind: "broken", reason: `scanner was killed by ${run.signalCode}` };
  }
  if (run.exitCode === null || !EXPECTED_EXITS.has(run.exitCode)) {
    return {
      kind: "broken",
      reason: `scanner exited ${String(run.exitCode)}: ${tail(run.stderr)}`,
    };
  }
  if (run.stdout.trim() === "") {
    return {
      kind: "broken",
      reason: `scanner produced no report (exit ${run.exitCode}): ${tail(run.stderr)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: "broken", reason: `scanner report is not JSON: ${message}` };
  }
  if (!isRecord(parsed)) {
    return { kind: "broken", reason: "scanner report is not an object" };
  }

  const findings: Finding[] = [];
  for (const [pkg, advisories] of Object.entries(parsed)) {
    if (!Array.isArray(advisories)) {
      return { kind: "broken", reason: `scanner report for "${pkg}" is not a list of advisories` };
    }
    for (const advisory of advisories) {
      if (!isRecord(advisory)) {
        return { kind: "broken", reason: `scanner report for "${pkg}" holds a non-advisory entry` };
      }
      findings.push({
        package: pkg,
        id: str(advisory["id"] === undefined ? undefined : String(advisory["id"]), "unknown"),
        title: str(advisory["title"], "(no title)"),
        // An unrecognised severity is treated as failing below rather than
        // dropped: a scanner that renames "critical" must not silently pass.
        severity: str(advisory["severity"], "unknown").toLowerCase(),
        url: str(advisory["url"], ""),
      });
    }
  }

  const failing = findings.filter(
    (f) => FAILING_SEVERITIES.has(f.severity) || !KNOWN_SEVERITIES.has(f.severity),
  );

  if (findings.length === 0) {
    if (run.exitCode !== 0) {
      return {
        kind: "broken",
        reason: `scanner exited ${run.exitCode} with an empty report: ${tail(run.stderr)}`,
      };
    }
    return { kind: "clean", findings };
  }
  if (failing.length === 0) return { kind: "clean", findings };
  return { kind: "vulnerable", findings, failing };
}

/** What the command prints. One line per advisory, worst first. */
export function report(verdict: Verdict): string {
  if (verdict.kind === "broken") {
    return `audit:dependencies: the scan failed, which is not a pass — ${verdict.reason}`;
  }
  const lines = [...verdict.findings]
    .sort(
      (a, b) => Number(FAILING_SEVERITIES.has(b.severity)) - Number(FAILING_SEVERITIES.has(a.severity)),
    )
    .map(
      (f) => `  ${f.severity.padEnd(8)} ${f.package}  ${f.title}${f.url === "" ? "" : `  ${f.url}`}`,
    );
  if (verdict.kind === "clean") {
    const suffix =
      verdict.findings.length === 0
        ? "no advisories against the resolved dependency graph"
        : `${verdict.findings.length} advisory/advisories below the failing threshold`;
    return [`audit:dependencies: ${suffix}`, ...lines].join("\n");
  }
  return [
    `audit:dependencies: ${verdict.failing.length} high or critical advisory/advisories`,
    ...lines,
    "  fix by upgrading the dependency; waive one only via IGNORED_ADVISORIES, with a reason.",
  ].join("\n");
}

/** Run the scanner once. Exported so a caller can substitute one in a test. */
export async function runAudit(cwd: string): Promise<AuditRun> {
  const args = ["bun", "audit", "--json", ...IGNORED_ADVISORIES.map((id) => `--ignore=${id}`)];
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });

  // The timer records that *it* fired. `proc.killed` cannot stand in for that:
  // it is true of any killed process, false for a scanner that hung after
  // printing a valid report, and reading it would let a timed-out run whose
  // output happened to parse be reported as a clean tree.
  let timedOut = false;
  let kill: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
    // SIGTERM is a request. A scanner that ignores it would otherwise hold this
    // process open past its own timeout.
    kill = setTimeout(() => proc.kill("SIGKILL"), KILL_GRACE_MS);
  }, TIMEOUT_MS);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr, timedOut, signalCode: proc.signalCode };
  } finally {
    clearTimeout(timer);
    if (kill !== undefined) clearTimeout(kill);
  }
}

if (import.meta.main) {
  // fileURLToPath, not `.pathname`: a checkout under a path with a space in it
  // is percent-encoded there, and Bun.spawn would reject the cwd.
  const root = fileURLToPath(new URL("..", import.meta.url));
  let verdict: Verdict = { kind: "broken", reason: "the scanner never ran" };
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    verdict = classify(await runAudit(root));
    // Only an infrastructure failure is worth retrying; an advisory will not
    // heal on a second look.
    if (verdict.kind !== "broken") break;
    if (attempt < ATTEMPTS) {
      process.stderr.write(`audit:dependencies: ${verdict.reason} — retrying once\n`);
    }
  }
  if (verdict.kind === "broken") {
    process.stderr.write(`${report(verdict)}\n`);
    process.exit(2);
  }
  process.stdout.write(`${report(verdict)}\n`);
  if (verdict.kind === "vulnerable") process.exit(1);
}
