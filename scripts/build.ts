#!/usr/bin/env bun
/**
 * Builds the two hermetic binaries: `hermetic` (CLI) and `hermeticd` (the fleet
 * agent, always linux-arm64 regardless of host — it never runs on the laptop).
 * The dashboard is the desktop app (§3.6) and is built by `bun run
 * app:build`, not from here.
 *
 * Usage:
 *   bun run build            same as build:host, plus hermeticd
 *   bun run build:host       hermetic for the current platform only
 *   bun run app:stage        the sidecars the desktop app bundles: `hermetic`,
 *                             `hermeticd` and its two stamps, and `stages/` —
 *                             no `dist/` wipe (see `buildStage`)
 *   bun run build:all        cross-compiles hermetic for every target in
 *                             TARGETS, into dist/<target>/, and puts hermeticd
 *                             and its stamps in each one
 *
 * Every directory a build distributes is a complete install (§3.6): `hermetic`,
 * `stages/`, `hermeticd` and the two stamps beside it. That is `dist/` for
 * `build`, and each `dist/<target>/` for `build:all`, where the one linux-arm64
 * `hermeticd` compiled into `dist/` is copied into every target directory
 * rather than rebuilt per target. An incomplete directory is not a smaller
 * install: `resolveHermeticd` and `locateStages` look beside the running
 * executable and then at a *source checkout*, which exists only on the machine
 * that ran the build, so the failure shows up on someone else's laptop as
 * `HERMETICD_UNAVAILABLE` from a binary that looked fine when it was made.
 *
 * Every binary is stamped with `--define process.env.HERMETIC_VERSION=<version>`,
 * and the CLI takes root package.json's `version` (defaulting to "0.1.0" if
 * the field is missing) — the version of the *tool*, which
 * `packages/core/src/version.ts` reads back at runtime as `HERMETIC_VERSION`.
 *
 * Every binary is stamped with `--define process.env.HERMETIC_VERSION=<version>`,
 * and the two heads take root package.json's `version` (defaulting to "0.1.0" if
 * the field is missing) — the version of the *tool*, which
 * `packages/core/src/version.ts` reads back at runtime as `HERMETIC_VERSION`.
 *
 * `hermeticd` does not. It is stamped with `BUILD_VERSIONS.hermeticd`, because
 * that is the string the laptop writes into the fleet manifest and the one a box
 * reports on every heartbeat; a binary carrying the tool's version instead would
 * report a version no manifest ever names, and every agent in the fleet would
 * read as out of date forever (`packages/agentd/src/version.ts` says the same
 * thing from the other end). The two versions are independent and must not be
 * passed to each other's builds.
 *
 * `hermeticd` also gets two stamp *files* beside it, both read by `artifacts.ts`:
 * `hermeticd.version` (the release version this build ships, which
 * `resolveHermeticd` refuses to push under a different one — and which must
 * agree with what was compiled in above) and `hermeticd.build`
 * (`sourceFingerprint` — which build of hermetic compiled it, since two
 * checkouts can ship different bytes under the same version, §3.6).
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { sourceFingerprint } from "../packages/core/src/release/artifacts.ts";
import { BUILD_VERSIONS } from "../packages/core/src/hermetic.ts";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { agentdBuildPlan, copyAgentd } from "./agentd-build.ts";
import { copyStages } from "./stages.ts";

const root = new URL("..", import.meta.url).pathname;
const dist = join(root, "dist");

type Mode = "host" | "all" | "full" | "stage";
const mode: Mode = (process.argv[2] as Mode | undefined) ?? "full";

async function readVersion(): Promise<string> {
  const raw = (await Bun.file(join(root, "package.json")).json()) as { version?: string };
  return raw.version ?? "0.1.0";
}

/** `bun-linux-x64`, `bun-darwin-arm64`, … or `undefined` for "this host". */
const TARGETS = ["bun-linux-x64", "bun-linux-arm64", "bun-darwin-arm64", "bun-darwin-x64"] as const;
type Target = (typeof TARGETS)[number];

/**
 * The bootstrap stages (§4.3) ship *beside* the binaries, because that is where
 * `locateStages` looks for an installed CLI: `HERMETIC_STAGES`, then a `stages/`
 * directory next to the running executable. A build that forgot them would
 * produce a `hermetic` that can push a release no box can boot, so a missing
 * source directory fails the build rather than warning. The copy itself lives
 * in `scripts/stages.ts` so it can be tested without running a build.
 */
function shipStages(outDir: string): void {
  try {
    const stages = copyStages(root, outDir);
    process.stdout.write(`copied ${stages.length} stage(s) to ${join(outDir, "stages")}\n`);
  } catch (e) {
    process.stderr.write(`build failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}

/**
 * `hermeticd` and its two stamps, copied from where `buildAgentd` compiled them
 * into a per-target directory. Every distributed target directory is a complete
 * install (§3.6): `hermetic`, `stages/`, and the agent the CLI pushes. Without this, `resolveHermeticd`'s sibling lookup finds
 * nothing in an unpacked `dist/<target>/` and `init` either falls back to a
 * source checkout — which only exists on the machine that did the build — or
 * refuses with `HERMETICD_UNAVAILABLE`. The copy itself lives in
 * `scripts/agentd-build.ts` so it can be tested without running a build.
 */
function shipAgentd(fromDir: string, outDir: string): void {
  try {
    const files = copyAgentd(fromDir, outDir);
    process.stdout.write(`copied ${files.join(", ")} to ${outDir}\n`);
  } catch (e) {
    process.stderr.write(`build failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}

function run(args: string[], label: string): void {
  process.stdout.write(`\n$ ${args.join(" ")}\n`);
  const res = spawnSync(args[0] as string, args.slice(1), { stdio: "inherit", cwd: root });
  if (res.status !== 0) {
    process.stderr.write(`build failed: ${label}\n`);
    process.exit(1);
  }
}

function compileArgs(entry: string, outfile: string, ver: string, target?: Target): string[] {
  return [
    "bun",
    "build",
    "--compile",
    ...(target ? [`--target=${target}`] : ["--target=bun"]),
    `--define`,
    `process.env.HERMETIC_VERSION="${ver}"`,
    entry,
    "--outfile",
    outfile,
  ];
}

async function buildHost(ver: string, outDir: string): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  shipStages(outDir);
  run(
    compileArgs(join(root, "packages/cli/src/main.ts"), join(outDir, "hermetic"), ver),
    "hermetic (cli)",
  );
}

async function buildAll(ver: string): Promise<void> {
  for (const target of TARGETS) {
    const outDir = join(dist, target);
    mkdirSync(outDir, { recursive: true });
    shipStages(outDir);
    run(
      compileArgs(join(root, "packages/cli/src/main.ts"), join(outDir, "hermetic"), ver, target),
      `hermetic (${target})`,
    );
    // The agent binary is linux-arm64 for every one of these targets — it runs
    // on the box, not on the laptop — so it is compiled once, into dist/, and
    // copied into each target directory rather than rebuilt per target.
    shipAgentd(dist, outDir);
  }
}

/**
 * What the desktop app bundles beside itself (§3.6).
 *
 * The app ships the CLI and the agent release so that `init` and
 * `artifacts push` work from a GUI launch: the main process points
 * `HERMETIC_HERMETICD` and `HERMETIC_STAGES` at these files before it opens
 * core, and the `hermetic` shim a user installs resolves them as siblings of
 * its own executable. `scripts/app-stage.ts` copies them into
 * `packages/app/dist/bin/` and refuses if one is missing.
 *
 * One deliberate difference from a full build: `dist/` is not wiped, because
 * this runs as Electrobun's `preBuild` hook and must not destroy an adjacent
 * build a developer is in the middle of.
 */
async function buildStage(ver: string): Promise<void> {
  mkdirSync(dist, { recursive: true });
  /**
   * The one thing that *is* wiped, because `copyStages` copies in without
   * pruning (`stages.ts`). A full build wipes `dist/` first and so cannot
   * produce this; here a stage script renamed or deleted in
   * `packages/agentd/stages` would survive in `dist/stages/`, be copied into
   * the bundle by `app-stage.ts`, and run on the next box — `orderStages`
   * takes the directory as it finds it.
   */
  rmSync(join(dist, "stages"), { recursive: true, force: true });
  shipStages(dist);
  run(
    compileArgs(join(root, "packages/cli/src/main.ts"), join(dist, "hermetic"), ver),
    "hermetic (cli)",
  );
  buildAgentd();
}

function buildAgentd(): void {
  mkdirSync(dist, { recursive: true });
  // The argv comes from `agentd-build.ts` rather than `compileArgs` above: the
  // version it stamps in is `BUILD_VERSIONS.hermeticd` and never `ver`, and that
  // distinction is the whole reason that module exists. See the note at the top
  // of this file, and `tests/build-stamp.test.ts`.
  const plan = agentdBuildPlan(root, join(dist, "hermeticd"));
  run(plan.args as string[], "hermeticd (agentd)");
  // The stamp `resolveHermeticd` checks before `init`/`artifacts push` will
  // push the sibling binary: it must be the version core expects to ship, and
  // the one just compiled in — `plan.version`, not a second reading of the
  // constant, so the two cannot drift apart.
  writeFileSync(join(dist, "hermeticd.version"), `${plan.version}\n`);
  // And *which build* that version is (§3.6). Two checkouts a day apart both
  // ship `0.5.0`; only the fingerprint tells them apart, and `create`/`rerun`
  // warn from it when the fleet's release was pushed from a different one.
  writeFileSync(
    join(dist, "hermeticd.build"),
    `${sourceFingerprint(root, BUILD_VERSIONS.hermeticd)}\n`,
  );
}

async function main(): Promise<void> {
  const ver = await readVersion();
  process.stdout.write(`hermetic build: version ${ver}, mode ${mode}\n`);

  if (mode === "host") {
    await buildHost(ver, dist);
    return;
  }

  if (mode === "all") {
    // hermeticd first: `buildAll` copies it into every target directory as it
    // finishes one, so it has to exist before the first target does.
    buildAgentd();
    await buildAll(ver);
    return;
  }

  if (mode === "stage") {
    await buildStage(ver);
    return;
  }

  // "full": host binaries + hermeticd, into plain dist/.
  if (existsSync(dist)) rmSync(dist, { recursive: true, force: true });
  await buildHost(ver, dist);
  buildAgentd();
}

await main();
