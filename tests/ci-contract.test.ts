/**
 * The CI workflow's own contract: immutable action pins, a read-only default
 * token, and an aggregate that requires every job.
 *
 * These are seam tests like the others in this directory — the two sides here
 * are `.github/` (what the hosted runner does) and `scripts/ci-results.ts`
 * (what decides the aggregate). Nothing else can catch the failures they
 * prevent: a mutable `@v4` is only a supply-chain change the day upstream moves
 * the tag, a `permissions` block that quietly grants write shows up in no test
 * output, and a new job missing from `needs` makes the required check *greener*,
 * not redder. Every rule is checked against the real files and against a
 * hand-written negative fixture, so a rule that stopped matching anything would
 * fail rather than pass vacuously.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EXPECTED_JOBS, RESULTS_ENV } from "../scripts/ci-results.ts";
import { TEST_SHARDS } from "../scripts/test-shard.ts";

const ROOT = join(import.meta.dir, "..");
const GITHUB = join(ROOT, ".github");
/**
 * Bun's own discovery rule: `*.test`, `_test`, `.spec` and `_spec`, in any
 * directory that is not hidden (`.git`, `.context`, `.claude`) or
 * `node_modules`. A narrower pattern here would let a `foo_test.ts` that
 * `bun run test` runs fall out of both shards unnoticed.
 */
const TEST_FILE = /[._](test|spec)\.[cm]?[jt]sx?$/;
const skippedDir = (name: string) => name.startsWith(".") || name === "node_modules";

/** A pin is a full 40-character commit SHA. Anything shorter is a name. */
const PINNED = /^[\w.-]+\/[\w.-]+(\/[\w.-]+)*@[0-9a-f]{40}$/;

/** `uses: owner/repo@<sha> # v1.2.3` — the comment is what makes a pin readable. */
const PINNED_LINE = /uses:\s*\S+@[0-9a-f]{40}\s+#\s*\S+/;

/** A service container's image is pinned the same way: by digest, not by tag. */
const PINNED_IMAGE = /^[\w./-]+@sha256:[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(text: string): Record<string, unknown> {
  const doc = Bun.YAML.parse(text);
  if (!isRecord(doc)) throw new Error("not a YAML mapping");
  return doc;
}

/** Every `uses:` value anywhere in the document, however deeply nested. */
function usesValues(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) usesValues(item, found);
    return found;
  }
  if (isRecord(node)) {
    for (const [key, value] of Object.entries(node)) {
      if (key === "uses" && typeof value === "string") found.push(value);
      else usesValues(value, found);
    }
  }
  return found;
}

/** Every line that references an action, with its 1-based line number. */
function usesLines(text: string): { ref: string; line: string; number: number }[] {
  const found: { ref: string; line: string; number: number }[] = [];
  text.split("\n").forEach((line, index) => {
    const match = line.match(/^\s*-?\s*uses:\s*(\S+)/);
    if (match?.[1] !== undefined) found.push({ ref: match[1], line, number: index + 1 });
  });
  return found;
}

/**
 * Actions referenced by a mutable ref, or pinned without a readable version.
 *
 * Checked per *line*, not per distinct ref: the same pin appears on eleven
 * lines of ci.yml, and a twelfth pasted in without its version comment must not
 * be excused by the first eleven having one. The YAML walk is still what
 * decides whether a ref is mutable, and the two views are cross-checked so a
 * `uses:` the line scan cannot see is itself a problem.
 */
function pinProblems(text: string): string[] {
  const problems: string[] = [];
  const parsed = usesValues(parse(text));
  const lines = usesLines(text);

  for (const ref of parsed) {
    if (!lines.some((l) => l.ref === ref)) {
      problems.push(`action ref not on a line this test can read: ${ref}`);
    }
  }

  for (const { ref, line, number } of lines) {
    // A local composite action is a path into this repository, reviewed with
    // the rest of the diff. There is nothing to pin.
    if (ref.startsWith("./")) continue;
    if (!PINNED.test(ref)) {
      problems.push(`mutable action ref: ${ref}`);
      continue;
    }
    if (!PINNED_LINE.test(line)) {
      problems.push(`pinned without a version comment (line ${number}): ${ref}`);
    }
  }
  return problems;
}

/**
 * Service containers referenced by a tag rather than a digest.
 *
 * Exactly the `uses:` rule, applied to the other thing a workflow pulls from
 * somewhere else: `amazon/dynamodb-local:latest` is a moving target, and a gate
 * whose subject moved is a gate that changed meaning without a review. The
 * `dynamodb-local` job (§11.2) is the only service today; the rule is written
 * for whatever is added beside it.
 */
function serviceImageProblems(text: string): string[] {
  const problems: string[] = [];
  const jobs = parse(text)["jobs"];
  if (!isRecord(jobs)) return problems;
  for (const [id, job] of Object.entries(jobs)) {
    if (!isRecord(job)) continue;
    const services = job["services"];
    if (!isRecord(services)) continue;
    for (const [service, spec] of Object.entries(services)) {
      const image = isRecord(spec) ? spec["image"] : undefined;
      if (typeof image !== "string") {
        problems.push(`job "${id}" service "${service}" names no image`);
      } else if (!PINNED_IMAGE.test(image)) {
        problems.push(`job "${id}" service "${service}" is not pinned by digest: ${image}`);
      }
    }
  }
  return problems;
}

/**
 * The lines of one job's block, with their 1-based numbers.
 *
 * Job-level `permissions` has to be located in the raw text, not just the
 * parsed tree, because the rule is about what a reader sees: a grant is allowed
 * when the reason for it is written on the line above. YAML alone cannot say
 * where a comment was.
 */
function jobLines(text: string, id: string): { line: string; number: number }[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^\\s{0,4}${id}:\\s*$`).test(l));
  if (start === -1) return [];
  const indent = (lines[start] ?? "").search(/\S/);
  const block: { line: string; number: number }[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const column = line.search(/\S/);
    if (line.trim() !== "" && column <= indent) break;
    block.push({ line, number: i + 1 });
  }
  return block;
}

/**
 * Token scope. The workflow default must be read-only, and any job-level grant
 * beyond it must carry its reason on the line immediately above.
 *
 * Both halves of the check are deliberately suspicious of YAML's shorthands.
 * `permissions: write-all` is a *string*, not a mapping, and skipping it because
 * it does not look like the shape we expected would wave through the widest
 * grant GitHub offers. Justification is checked against the line above the
 * grant, not against the file: a reason written for one job must not silently
 * excuse another job's.
 */
function permissionProblems(text: string): string[] {
  const doc = parse(text);
  const problems: string[] = [];

  const top = doc["permissions"];
  if (top === undefined) {
    problems.push("no workflow-level permissions block");
  } else if (!isRecord(top)) {
    problems.push(`workflow default is not contents: read, it is ${String(top)}`);
  } else {
    if (top["contents"] !== "read") problems.push("workflow default is not contents: read");
    for (const [scope, level] of Object.entries(top)) {
      if (scope !== "contents") problems.push(`workflow default grants ${scope}: ${String(level)}`);
    }
  }

  const jobs = doc["jobs"];
  if (!isRecord(jobs)) return problems;

  for (const [id, job] of Object.entries(jobs)) {
    if (!isRecord(job)) continue;
    const perms = job["permissions"];
    if (perms === undefined) continue;

    // `permissions: write-all` / `read-all` — one string, every scope.
    if (!isRecord(perms)) {
      problems.push(`job "${id}" uses the all-scopes form permissions: ${String(perms)}`);
      continue;
    }

    const block = jobLines(text, id);
    for (const [scope, level] of Object.entries(perms)) {
      // The workflow default, restated. Nothing is widened, nothing to justify.
      if (scope === "contents" && level === "read") continue;
      const at = block.find((l) => new RegExp(`^\\s*${scope}:\\s*${String(level)}\\s*$`).test(l.line));
      const above = at === undefined ? undefined : block.find((l) => l.number === at.number - 1);
      const justified = above?.line.trim().startsWith("#") === true && above.line.includes(scope);
      if (!justified) {
        problems.push(`job "${id}" grants ${scope}: ${String(level)} with no reason on the line above`);
      }
    }
  }
  return problems;
}

/** The three-way agreement: workflow job IDs, the aggregate's needs, EXPECTED_JOBS. */
function aggregateProblems(text: string): string[] {
  const doc = parse(text);
  const jobs = doc["jobs"];
  if (!isRecord(jobs)) return ["workflow declares no jobs"];

  const aggregate = jobs["ci"];
  if (!isRecord(aggregate)) return ['workflow has no "ci" aggregate job'];

  const needs = aggregate["needs"];
  if (!Array.isArray(needs)) return ['the "ci" job has no needs list'];

  const required = new Set(needs.map(String));
  const problems: string[] = [];
  for (const id of Object.keys(jobs)) {
    if (id === "ci") continue;
    if (!required.has(id)) problems.push(`job "${id}" is not in the ci aggregate's needs`);
  }
  for (const id of required) {
    if (!(id in jobs)) problems.push(`ci needs "${id}", which is not a job in this workflow`);
    if (!EXPECTED_JOBS.includes(id as (typeof EXPECTED_JOBS)[number])) {
      problems.push(`ci needs "${id}", which is not in EXPECTED_JOBS`);
    }
  }
  for (const id of EXPECTED_JOBS) {
    if (!required.has(id)) problems.push(`EXPECTED_JOBS has "${id}", which ci does not require`);
  }
  if (aggregate["if"] !== "always()") {
    problems.push("the ci aggregate must run with if: always(), or a skipped job skips the gate");
  }

  // Everything above is about which jobs the aggregate waits for. This is about
  // whether it then *looks* at them: a `ci` job that waits for all nine and
  // runs `echo ok` is a green check that means nothing, and every other
  // assertion in this file would still pass.
  const steps = aggregate["steps"];
  const gate = Array.isArray(steps)
    ? steps.find((step) => isRecord(step) && String(step["run"] ?? "").includes("ci-results.ts"))
    : undefined;
  if (!isRecord(gate)) {
    problems.push("no step in the ci aggregate runs scripts/ci-results.ts");
  } else {
    const env = gate["env"];
    const passed = isRecord(env) ? env[RESULTS_ENV] : undefined;
    if (passed !== "${{ toJSON(needs) }}") {
      problems.push(`the gate step does not receive ${RESULTS_ENV}: \${{ toJSON(needs) }}`);
    }
  }
  return problems;
}

/** Matrix shape and runner command for the test job. */
function testMatrixProblems(text: string): string[] {
  const jobs = parse(text)["jobs"];
  const job = isRecord(jobs) ? jobs["test"] : undefined;
  if (!isRecord(job)) return ['workflow has no "test" job'];

  const problems: string[] = [];
  const strategy = job["strategy"];
  if (!isRecord(strategy)) return ['the "test" job has no matrix strategy'];
  if (strategy["fail-fast"] !== false) problems.push("test matrix must keep fail-fast disabled");

  const matrix = strategy["matrix"];
  const shards = isRecord(matrix) ? matrix["shard"] : undefined;
  if (!Array.isArray(shards) || shards.map(String).sort().join(",") !== "cli,non-cli") {
    problems.push("test matrix must run exactly the cli and non-cli shards");
  }

  const steps = job["steps"];
  const runner = Array.isArray(steps)
    ? steps.find((step) => isRecord(step) && String(step["run"] ?? "").includes("test-shard.ts"))
    : undefined;
  if (!isRecord(runner)) {
    problems.push("test matrix does not run scripts/test-shard.ts");
  } else {
    const env = runner["env"];
    if (!isRecord(env) || env["TEST_SHARD"] !== "${{ matrix.shard }}") {
      problems.push("test matrix does not pass matrix.shard through TEST_SHARD");
    }
  }
  return problems;
}

/** Every test file under a shard root, recursively. */
function shardTestFiles(root: string): string[] {
  const absolute = join(ROOT, root);
  return readdirSync(absolute, { recursive: true, withFileTypes: true })
    .filter((entry) => {
      const nestedDirs = entry.parentPath.slice(absolute.length + 1).split(/[\\/]/);
      return entry.isFile() && !nestedDirs.some(skippedDir) && TEST_FILE.test(entry.name);
    })
    .map((entry) => join(root, entry.parentPath.slice(absolute.length + 1), entry.name));
}

/** Every test file the repository can add to the default Bun discovery set. */
function repositoryTestFiles(dir = ROOT, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = join(prefix, entry.name);
    if (entry.isDirectory()) {
      if (skippedDir(entry.name)) return [];
      return repositoryTestFiles(join(dir, entry.name), relative);
    }
    return entry.isFile() && TEST_FILE.test(entry.name) ? [relative] : [];
  });
}

/** Every workflow and composite action in the repository. */
function actionFiles(): { path: string; text: string; workflow: boolean }[] {
  const files: { path: string; text: string; workflow: boolean }[] = [];
  const workflows = join(GITHUB, "workflows");
  for (const name of readdirSync(workflows)) {
    if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
    files.push({
      path: join(workflows, name),
      text: readFileSync(join(workflows, name), "utf8"),
      workflow: true,
    });
  }
  const actions = join(GITHUB, "actions");
  for (const dir of readdirSync(actions)) {
    const path = join(actions, dir, "action.yml");
    files.push({ path, text: readFileSync(path, "utf8"), workflow: false });
  }
  return files;
}

describe("action pins", () => {
  const files = actionFiles();

  test("there are remote actions to check", () => {
    const remote = files.flatMap((f) => usesValues(parse(f.text))).filter((u) => !u.startsWith("./"));
    expect(remote.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    test(`${file.path} pins every remote action to a SHA`, () => {
      expect(pinProblems(file.text)).toEqual([]);
    });
  }

  for (const file of files.filter((f) => f.workflow)) {
    test(`${file.path} pins every service container by digest`, () => {
      expect(serviceImageProblems(file.text)).toEqual([]);
    });
  }

  test("there is a service container to check", () => {
    const withServices = files.filter((f) => f.workflow && /^\s+services:\s*$/m.test(f.text));
    expect(withServices.length).toBeGreaterThan(0);
  });

  test("a service image pinned by tag is caught", () => {
    const fixture =
      "jobs:\n  a:\n    services:\n      db:\n        image: amazon/dynamodb-local:latest\n";
    expect(serviceImageProblems(fixture)).toEqual([
      'job "a" service "db" is not pinned by digest: amazon/dynamodb-local:latest',
    ]);
  });

  test("a service with no image at all is caught", () => {
    const fixture = "jobs:\n  a:\n    services:\n      db:\n        ports: []\n";
    expect(serviceImageProblems(fixture)).toEqual(['job "a" service "db" names no image']);
  });

  test("a mutable ref nested in a composite action is caught", () => {
    const fixture = `
name: Setup
runs:
  using: composite
  steps:
    - uses: oven-sh/setup-bun@v2
`;
    expect(pinProblems(fixture)).toEqual(["mutable action ref: oven-sh/setup-bun@v2"]);
  });

  test("a short SHA is not a pin", () => {
    const fixture = "runs:\n  steps:\n    - uses: actions/checkout@11d5960\n";
    expect(pinProblems(fixture)).toEqual(["mutable action ref: actions/checkout@11d5960"]);
  });

  test("a SHA with no version comment is caught", () => {
    const sha = "11d5960a326750d5838078e36cf38b85af677262";
    const fixture = `jobs:\n  a:\n    steps:\n      - uses: actions/checkout@${sha}\n`;
    expect(pinProblems(fixture)).toEqual([
      `pinned without a version comment (line 4): actions/checkout@${sha}`,
    ]);
  });

  test("one commented pin does not excuse the same pin uncommented elsewhere", () => {
    const sha = "11d5960a326750d5838078e36cf38b85af677262";
    const fixture = [
      "jobs:",
      "  a:",
      "    steps:",
      `      - uses: actions/checkout@${sha} # v4.4.0`,
      "  b:",
      "    steps:",
      `      - uses: actions/checkout@${sha}`,
      "",
    ].join("\n");
    expect(pinProblems(fixture)).toEqual([
      `pinned without a version comment (line 7): actions/checkout@${sha}`,
    ]);
  });
});

describe("token permissions", () => {
  for (const file of actionFiles().filter((f) => f.workflow)) {
    test(`${file.path} defaults to contents: read`, () => {
      expect(permissionProblems(file.text)).toEqual([]);
    });
  }

  test("a missing permissions block is caught", () => {
    expect(permissionProblems("jobs:\n  a:\n    steps: []\n")).toEqual([
      "no workflow-level permissions block",
    ]);
  });

  test("a write grant in the workflow default is caught", () => {
    const fixture = "permissions:\n  contents: write\njobs: {}\n";
    expect(permissionProblems(fixture)).toEqual(["workflow default is not contents: read"]);
  });

  test("an unjustified job-level write grant is caught", () => {
    const fixture = [
      "permissions:",
      "  contents: read",
      "jobs:",
      "  release:",
      "    permissions:",
      "      packages: write",
      "    steps: []",
      "",
    ].join("\n");
    expect(permissionProblems(fixture)).toEqual([
      'job "release" grants packages: write with no reason on the line above',
    ]);
  });

  test("permissions: write-all is caught, string form and all", () => {
    const fixture = [
      "permissions:",
      "  contents: read",
      "jobs:",
      "  release:",
      "    permissions: write-all",
      "    steps: []",
      "",
    ].join("\n");
    expect(permissionProblems(fixture)).toEqual([
      'job "release" uses the all-scopes form permissions: write-all',
    ]);
  });

  test("a workflow-level write-all default is caught", () => {
    expect(permissionProblems("permissions: write-all\njobs: {}\n")).toEqual([
      "workflow default is not contents: read, it is write-all",
    ]);
  });

  test("a job-level read scope beyond the default still needs its reason", () => {
    const fixture = [
      "permissions:",
      "  contents: read",
      "jobs:",
      "  triage:",
      "    permissions:",
      "      issues: read",
      "    steps: []",
      "",
    ].join("\n");
    expect(permissionProblems(fixture)).toEqual([
      'job "triage" grants issues: read with no reason on the line above',
    ]);
  });

  test("one job's justification does not excuse another job's grant", () => {
    const fixture = [
      "permissions:",
      "  contents: read",
      "jobs:",
      "  release:",
      "    permissions:",
      "      # packages: write — pushes the container image built by this job",
      "      packages: write",
      "    steps: []",
      "  sneaky:",
      "    permissions:",
      "      packages: write",
      "    steps: []",
      "",
    ].join("\n");
    expect(permissionProblems(fixture)).toEqual([
      'job "sneaky" grants packages: write with no reason on the line above',
    ]);
  });

  test("a job-level write grant with its reason beside it passes", () => {
    const fixture = [
      "permissions:",
      "  contents: read",
      "jobs:",
      "  release:",
      "    permissions:",
      "      # packages: write — pushes the container image built by this job",
      "      packages: write",
      "    steps: []",
      "",
    ].join("\n");
    expect(permissionProblems(fixture)).toEqual([]);
  });
});

describe("the ci aggregate", () => {
  const ci = readFileSync(join(GITHUB, "workflows", "ci.yml"), "utf8");

  test("requires every job in the workflow, and nothing it does not have", () => {
    expect(aggregateProblems(ci)).toEqual([]);
  });

  test("keeps the check name branch protection points at", () => {
    const jobs = parse(ci)["jobs"];
    expect(isRecord(jobs) && isRecord(jobs["ci"]) && jobs["ci"]["name"]).toBe("ci");
  });

  test("an aggregate that requires every job but checks none of them is caught", () => {
    const jobs = EXPECTED_JOBS.map((id) => `  ${id}: {}`).join("\n");
    const fixture = [
      "jobs:",
      jobs,
      "  ci:",
      "    if: always()",
      `    needs: [${EXPECTED_JOBS.join(", ")}]`,
      "    steps:",
      "      - run: echo ok",
      "",
    ].join("\n");
    expect(aggregateProblems(fixture)).toEqual([
      "no step in the ci aggregate runs scripts/ci-results.ts",
    ]);
  });

  test("a gate step that is not handed the needs map is caught", () => {
    const jobs = EXPECTED_JOBS.map((id) => `  ${id}: {}`).join("\n");
    const fixture = [
      "jobs:",
      jobs,
      "  ci:",
      "    if: always()",
      `    needs: [${EXPECTED_JOBS.join(", ")}]`,
      "    steps:",
      "      - run: bun scripts/ci-results.ts",
      "",
    ].join("\n");
    expect(aggregateProblems(fixture)).toEqual([
      `the gate step does not receive ${RESULTS_ENV}: \${{ toJSON(needs) }}`,
    ]);
  });

  test("a job left out of needs is caught", () => {
    const fixture = [
      "jobs:",
      "  typecheck: {}",
      "  audit: {}",
      "  ci:",
      "    if: always()",
      "    needs: [typecheck]",
      "",
    ].join("\n");
    expect(aggregateProblems(fixture)).toContain('job "audit" is not in the ci aggregate\'s needs');
  });

  test("an aggregate that does not always run is caught", () => {
    const needs = EXPECTED_JOBS.join(", ");
    const jobs = EXPECTED_JOBS.map((id) => `  ${id}: {}`).join("\n");
    const fixture = `jobs:\n${jobs}\n  ci:\n    needs: [${needs}]\n`;
    expect(aggregateProblems(fixture)).toContain(
      "the ci aggregate must run with if: always(), or a skipped job skips the gate",
    );
  });
});

describe("the CI test matrix", () => {
  const ci = readFileSync(join(GITHUB, "workflows", "ci.yml"), "utf8");

  test("runs both committed shards without fail-fast cancellation", () => {
    expect(testMatrixProblems(ci)).toEqual([]);
  });

  test("partitions every repository test file exactly once", () => {
    const assignments = Object.values(TEST_SHARDS).flatMap((shard) =>
      shard.paths.flatMap((root) => shardTestFiles(root)),
    );
    const duplicates = assignments.filter((file, index) => assignments.indexOf(file) !== index);
    expect(duplicates).toEqual([]);

    const allTests = repositoryTestFiles();
    expect(assignments.sort()).toEqual(allTests.sort());
  });

  test("keeps the CI-only compiler test enabled outside the CLI shard", () => {
    expect(TEST_SHARDS.cli.buildHermeticd).toBe(false);
    expect(TEST_SHARDS["non-cli"].buildHermeticd).toBe(true);
    expect(TEST_SHARDS["non-cli"].paths).toContain("packages/core");
  });
});
