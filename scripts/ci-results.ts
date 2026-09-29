#!/usr/bin/env bun
/**
 * Decides whether the aggregate `ci` check passes, from the `needs` result map
 * GitHub hands the aggregate job (`.github/workflows/ci.yml`).
 *
 * The aggregate exists so branch protection has one stable check name to
 * require. That makes it the only thing standing between a broken job and a
 * merge, so it has to fail closed: the shell conditional it replaces rejected
 * `failure` and `cancelled`, which meant a job that never ran — skipped by a
 * condition, dropped by a bad `needs`, cancelled upstream of its own start —
 * reported green. "Did not fail" is not "passed".
 *
 * EXPECTED_JOBS is the third independent source in the same three-way check the
 * parity contract uses: this list, the job IDs in the workflow, and the
 * aggregate's `needs` must all agree, and `tests/ci-contract.test.ts` fails when
 * they do not. Adding a job to the workflow and forgetting to require it is
 * therefore a test failure rather than a quiet hole in the gate.
 */

/** Every job that must report `success` before `ci` passes. */
export const EXPECTED_JOBS = [
  "typecheck",
  "test",
  "lint-biome",
  "lint",
  "lint-cfn",
  "lint-sh",
  "build",
  "dynamodb-local",
  "app",
  "audit",
  "gitleaks",
  "site",
] as const;

/** The environment variable the workflow passes `toJSON(needs)` through. */
export const RESULTS_ENV = "CI_JOB_RESULTS";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every reason the aggregate must fail, in a stable order. Empty means pass.
 *
 * `raw` is the JSON of GitHub's `needs` context: `{ "<job>": { "result": "...",
 * "outputs": {...} } }`. Anything else about it — absent, unparseable, empty,
 * missing a job, carrying a job nobody expected, or holding a result string
 * this code does not recognise — is a failure, not a pass with a caveat.
 */
export function checkResults(
  raw: string | undefined,
  expected: readonly string[] = EXPECTED_JOBS,
): string[] {
  if (raw === undefined || raw.trim() === "") {
    return [`no job results: ${RESULTS_ENV} is empty or unset`];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [`job results are not JSON: ${message}`];
  }

  if (!isRecord(parsed)) {
    return [`job results are not an object: ${JSON.stringify(parsed)}`];
  }

  const jobs = Object.keys(parsed);
  if (jobs.length === 0) {
    return ["no job results: the needs map is empty"];
  }

  const problems: string[] = [];
  for (const job of expected) {
    const entry = parsed[job];
    if (entry === undefined) {
      problems.push(`job "${job}" reported nothing — it is missing from the aggregate's needs`);
      continue;
    }
    if (!isRecord(entry)) {
      problems.push(`job "${job}" has no result object: ${JSON.stringify(entry)}`);
      continue;
    }
    const result = entry["result"];
    if (typeof result !== "string" || result === "") {
      problems.push(`job "${job}" has no result`);
      continue;
    }
    if (result !== "success") {
      problems.push(`job "${job}" reported ${result}`);
    }
  }

  for (const job of jobs) {
    if (!expected.includes(job)) {
      problems.push(`job "${job}" is in needs but not in EXPECTED_JOBS`);
    }
  }

  return problems;
}

if (import.meta.main) {
  const problems = checkResults(process.env[RESULTS_ENV]);
  if (problems.length > 0) {
    process.stderr.write(`ci: ${problems.length} problem(s), this check fails closed:\n`);
    for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
    process.exit(1);
  }
  process.stdout.write(`ci: all ${EXPECTED_JOBS.length} required jobs reported success\n`);
}
