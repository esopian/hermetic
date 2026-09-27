#!/usr/bin/env bun
/**
 * Cuts a release: the local half of CONTRIBUTING.md "Cutting a release", end to
 * end. `.github/workflows/release.yml` is the other half — it builds the app on
 * a macOS runner and publishes the GitHub Release when a `v<version>` tag lands.
 *
 * Usage:
 *   bun run release [patch|minor|major|<x.y.z>] [--skip-check] [--yes] [--no-watch] [--dry-run]
 *
 *   patch (default)  0.1.6 → 0.1.7; minor → 0.2.0; major → 1.0.0; or an exact version
 *   --skip-check     do not run `bun run check` locally (release.yml runs it anyway)
 *   --yes            do not ask before pushing
 *   --no-watch       push and exit, instead of following the workflow to the release
 *   --dry-run        run every preflight and print the plan; change nothing
 *
 * The order matters because a pushed tag is permanent (tags are never moved or
 * re-pushed): everything that can fail without side effects — branch, clean
 * tree, sync with origin, tag free locally and remotely, `bun run check` — runs
 * before the one commit, and the commit and tag go up in a single `git push
 * --atomic`, so origin never holds a tag without the version bump it names.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const BRANCH = "master";
const REMOTE = "origin";
const WORKFLOW = "release.yml";

/**
 * Assets every release carries (CONTRIBUTING.md step 4). The
 * `stable-macos-arm64-<prevhash>.patch` that appears from the second release on
 * is not listed: whether it exists depends on the history, not on this release.
 */
export const EXPECTED_ASSETS = [
  "macos-arm64-Hermetic.dmg",
  "stable-macos-arm64-Hermetic.app.tar.zst",
  "stable-macos-arm64-update.json",
] as const;

export type Bump = "patch" | "minor" | "major";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** The version after `current`, from a bump keyword or an exact `x.y.z` that must be newer. */
export function nextVersion(current: string, spec: string): string {
  const cur = SEMVER.exec(current);
  if (!cur) throw new Error(`package.json version "${current}" is not x.y.z`);
  const [major, minor, patch] = [Number(cur[1]), Number(cur[2]), Number(cur[3])];
  if (spec === "patch") return `${major}.${minor}.${patch + 1}`;
  if (spec === "minor") return `${major}.${minor + 1}.0`;
  if (spec === "major") return `${major + 1}.0.0`;
  const next = SEMVER.exec(spec);
  if (!next) throw new Error(`"${spec}" is not patch, minor, major or an x.y.z version`);
  const a = [major, minor, patch];
  const b = [Number(next[1]), Number(next[2]), Number(next[3])];
  const cmp = b.map((n, i) => n - (a[i] ?? 0)).find((d) => d !== 0) ?? 0;
  if (cmp <= 0) throw new Error(`${spec} is not newer than the current version ${current}`);
  return spec;
}

/**
 * package.json with its top-level `version` replaced, formatting untouched — a
 * JSON round trip would reflow the file and put unrelated lines in the commit.
 */
export function setVersion(pkgText: string, version: string): string {
  const pattern = /^(\s*"version":\s*")[^"]*(")/m;
  if (!pattern.test(pkgText)) throw new Error('package.json has no "version" field');
  return pkgText.replace(pattern, `$1${version}$2`);
}

/** The expected assets a published release is missing. */
export function missingAssets(names: readonly string[]): string[] {
  return EXPECTED_ASSETS.filter((a) => !names.includes(a));
}

type Options = { spec: string; skipCheck: boolean; yes: boolean; watch: boolean; dryRun: boolean };

export function parseArgs(argv: readonly string[]): Options {
  const opts: Options = { spec: "patch", skipCheck: false, yes: false, watch: true, dryRun: false };
  let positional = false;
  for (const arg of argv) {
    if (arg === "--skip-check") opts.skipCheck = true;
    else if (arg === "--yes" || arg === "-y") opts.yes = true;
    else if (arg === "--no-watch") opts.watch = false;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
    else if (positional) throw new Error(`unexpected argument ${arg}`);
    else {
      opts.spec = arg;
      positional = true;
    }
  }
  return opts;
}

class ReleaseError extends Error {}

/** Run a command, capturing output; throws with its stderr on a non-zero exit. */
function capture(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8" });
  if (r.error) throw new ReleaseError(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) {
    throw new ReleaseError(`${cmd} ${args.join(" ")} failed:\n${(r.stderr || r.stdout).trim()}`);
  }
  return r.stdout.trim();
}

/** Run a command with the terminal attached; returns whether it succeeded. */
function stream(cmd: string, args: string[]): boolean {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit" });
  return r.status === 0;
}

function step(message: string): void {
  console.log(`\n▸ ${message}`);
}

function preflight(tag: string, needGh: boolean): void {
  step("Preflight");
  const branch = capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== BRANCH) throw new ReleaseError(`on branch ${branch}; releases are cut from ${BRANCH}`);

  const dirty = capture("git", ["status", "--porcelain"]);
  if (dirty) throw new ReleaseError(`working tree is not clean:\n${dirty}`);

  capture("git", ["fetch", "--quiet", "--tags", REMOTE, BRANCH]);
  const behind = capture("git", ["rev-list", "--count", `HEAD..${REMOTE}/${BRANCH}`]);
  if (behind !== "0") {
    throw new ReleaseError(`${BRANCH} is ${behind} commit(s) behind ${REMOTE}/${BRANCH}; pull first`);
  }
  const ahead = capture("git", ["rev-list", "--count", `${REMOTE}/${BRANCH}..HEAD`]);
  if (ahead !== "0")
    console.log(`  ${ahead} unpushed commit(s) on ${BRANCH} will be pushed with the release`);

  if (capture("git", ["tag", "--list", tag]))
    throw new ReleaseError(`tag ${tag} already exists locally`);
  if (capture("git", ["ls-remote", "--tags", REMOTE, `refs/tags/${tag}`])) {
    throw new ReleaseError(
      `tag ${tag} already exists on ${REMOTE}; tags are never re-pushed — pick a newer version`,
    );
  }

  if (needGh) capture("gh", ["auth", "status"]);
  console.log("  ok");
}

function confirm(question: string): boolean {
  const answer = prompt(`${question} [y/N]`);
  return answer !== null && /^y(es)?$/i.test(answer.trim());
}

/** How long to wait for GitHub to register the run a tag push started. */
const RUN_WAIT_MS = 3 * 60_000;
/** How long to wait for a published release to be readable after its run succeeds. */
const RELEASE_WAIT_MS = 60_000;
const POLL_MS = 3_000;

/**
 * Wait for GitHub to register the run the tag push started, then return its id.
 * Matched on the pushed commit, not just the tag name, so a run left over from
 * an older push of the same ref can never be mistaken for this one.
 */
async function findRun(tag: string, sha: string): Promise<string> {
  const deadline = Date.now() + RUN_WAIT_MS;
  while (Date.now() < deadline) {
    const id = capture("gh", [
      "run",
      "list",
      "--workflow",
      WORKFLOW,
      "--branch",
      tag,
      "--limit",
      "10",
      "--json",
      "databaseId,headSha",
      "--jq",
      `map(select(.headSha == "${sha}")) | .[0].databaseId // empty`,
    ]);
    if (id) return id;
    await Bun.sleep(POLL_MS);
  }
  throw new ReleaseError(
    `no ${WORKFLOW} run for ${sha.slice(0, 12)} appeared within three minutes; check the Actions tab`,
  );
}

type ReleaseView = { url: string; assets: { name: string }[] };

/**
 * The published release, once it carries every expected asset. `gh release
 * create` is the workflow's last step, but the release API can trail the run's
 * success by a moment, so a missing release or asset is retried for a bounded
 * time before it counts as a failure.
 */
async function awaitRelease(tag: string): Promise<ReleaseView> {
  const deadline = Date.now() + RELEASE_WAIT_MS;
  let problem = "";
  while (true) {
    try {
      const view = JSON.parse(
        capture("gh", ["release", "view", tag, "--json", "url,assets"]),
      ) as ReleaseView;
      const missing = missingAssets(view.assets.map((a) => a.name));
      if (missing.length === 0) return view;
      problem = `release ${tag} is missing: ${missing.join(", ")}`;
    } catch (err) {
      if (!(err instanceof ReleaseError)) throw err;
      problem = err.message;
    }
    if (Date.now() >= deadline) throw new ReleaseError(`${problem}\n${failureAdvice(tag)}`);
    await Bun.sleep(POLL_MS);
  }
}

/**
 * The release commit and tag, made locally. Preflight proved the tree clean, so
 * on any failure — a pre-commit hook refusing, `git tag` erroring — the
 * checkout is put back exactly where it started, and a rerun is not blocked by
 * the half-made release it left behind.
 */
function commitAndTag(
  pkgPath: string,
  pkgText: string,
  version: string,
  subject: string,
  tag: string,
): void {
  const start = capture("git", ["rev-parse", "HEAD"]);
  try {
    writeFileSync(pkgPath, setVersion(pkgText, version));
    capture("git", ["commit", "--quiet", "-m", subject, "--", "package.json"]);
    capture("git", ["tag", "-a", tag, "-m", tag]);
  } catch (err) {
    spawnSync("git", ["tag", "-d", tag], { cwd: root, stdio: "ignore" });
    const reset = spawnSync("git", ["reset", "--quiet", "--hard", start], { cwd: root });
    const undo =
      reset.status === 0
        ? `rolled back to ${start.slice(0, 12)}; nothing was pushed`
        : `rollback failed; restore by hand with: git tag -d ${tag}; git reset --hard ${start}`;
    const reason = err instanceof Error ? err.message : String(err);
    throw new ReleaseError(`${reason}\n${undo}`);
  }
}

function failureAdvice(tag: string): string {
  return [
    `${tag} is pushed and stays pushed — do not move or re-push it.`,
    "Delete the draft release if one was left (`gh release delete " + tag + "`),",
    "fix what broke, and cut a new release: `bun run release`.",
  ].join("\n");
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const pkgPath = join(root, "package.json");
  const pkgText = readFileSync(pkgPath, "utf8");
  const current = (JSON.parse(pkgText) as { version?: string }).version ?? "";
  const version = nextVersion(current, opts.spec);
  const tag = `v${version}`;

  preflight(tag, opts.watch);

  if (opts.skipCheck) {
    step("Skipping `bun run check` (--skip-check)");
  } else {
    step("bun run check");
    if (!stream("bun", ["run", "check"]))
      throw new ReleaseError("`bun run check` failed; nothing was changed");
  }

  const subject = `chore: release ${tag}`;
  console.log(`\nRelease plan:
  version   ${current} → ${version}
  commit    "${subject}" on ${BRANCH}
  tag       ${tag}
  push      git push --atomic ${REMOTE} ${BRANCH} ${tag}
  then      ${WORKFLOW} builds the app and publishes the GitHub Release`);

  if (opts.dryRun) {
    console.log("\n--dry-run: nothing changed.");
    return;
  }
  if (!opts.yes && !confirm(`\nPush ${tag}? This publishes a release and cannot be undone.`)) {
    console.log("Aborted; nothing changed.");
    return;
  }

  step(`Bumping package.json to ${version}`);
  commitAndTag(pkgPath, pkgText, version, subject, tag);
  const sha = capture("git", ["rev-parse", "HEAD"]);

  step(`Pushing ${BRANCH} and ${tag}`);
  if (!stream("git", ["push", "--atomic", REMOTE, BRANCH, tag])) {
    throw new ReleaseError(
      `push failed; nothing reached ${REMOTE}. Undo locally with:\n` +
        `  git tag -d ${tag} && git reset --hard HEAD~1`,
    );
  }

  if (!opts.watch) {
    console.log(
      `\n${tag} pushed. Follow it with: gh run watch $(gh run list --workflow ${WORKFLOW} --branch ${tag} --limit 1 --json databaseId --jq '.[0].databaseId')`,
    );
    return;
  }

  step(`Following ${WORKFLOW} (about ten minutes)`);
  const runId = await findRun(tag, sha);
  if (!stream("gh", ["run", "watch", runId, "--exit-status", "--interval", "15"])) {
    throw new ReleaseError(`${WORKFLOW} failed (run ${runId}).\n${failureAdvice(tag)}`);
  }

  step("Verifying the release assets");
  const view = await awaitRelease(tag);
  for (const asset of view.assets) console.log(`  ${asset.name}`);
  console.log(`\n✓ Released ${tag}: ${view.url}`);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
