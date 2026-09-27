#!/usr/bin/env bun
/**
 * `bun run dev:hmr [fixture|wizard]`: the app with a hot-reloading page.
 *
 * Electrobun's Vite loop (its hot-reloading guide), in one process tree:
 *
 * 1. Vite serves `packages/ui` (`packages/ui/vite.config.ts`) on loopback.
 * 2. Once it answers, `hutch electrobun dev --watch` starts the app with
 *    `HERMETIC_VIEW_URL` naming it. The main process loads its window from
 *    there instead of `views://` (`packages/app/src/main/view-url.ts`), and
 *    `electrobun.config.ts` drops the UI from the watch list.
 *
 * So a UI edit is a hot update in the open window, with main-process state —
 * op streams, chat observations, the poller — untouched; an edit under
 * `packages/core` or `packages/app` still rebuilds and relaunches the app.
 *
 * Waiting for Vite before launching is the one thing the upstream template's
 * `concurrently` pair does not do: its app probes once at startup, and loses
 * the race to a cold server on a slow first compile. Either child exiting
 * stops the other, and so does quitting the app (`dev-quit.ts`: the watcher
 * outlives its window otherwise), so Ctrl-C or quitting ends the whole session.
 *
 * Each child leads its own process group and is stopped as a group: `hutch`
 * does not pass a SIGTERM on to the app it launched, so signalling the `hutch`
 * pid alone leaves an orphaned window behind.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { onAppQuit } from "./dev-quit.ts";

const MODES: Record<string, Record<string, string>> = {
  real: {},
  fixture: { HERMETIC_FIXTURE: "1" },
  wizard: { HERMETIC_FIXTURE: "1", HERMETIC_UNINIT: "1" },
};

const mode = process.argv[2] ?? "real";
const modeEnv = MODES[mode];
if (modeEnv === undefined) {
  console.error(`dev-hmr: unknown mode "${mode}" (expected ${Object.keys(MODES).join(", ")})`);
  process.exit(2);
}

const root = resolve(import.meta.dir, "..");
const appDir = join(root, "packages/app");
const uiDir = join(root, "packages/ui");

if (!existsSync(join(appDir, ".hutch/devkit/package.json"))) {
  console.error(
    "dev-hmr: no Electrobun devkit in packages/app/.hutch — run `bun run app:prepare` first",
  );
  process.exit(2);
}

/** `hutch` from PATH, else the installer's default location. */
function hutchBinary(): string {
  const onPath = Bun.which("hutch");
  if (onPath !== null) return onPath;
  const installed = join(homedir(), ".hutch/bin/hutch");
  if (existsSync(installed)) return installed;
  console.error("dev-hmr: `hutch` is not installed — see CONTRIBUTING.md");
  process.exit(2);
}

const port = Number(process.env["HERMETIC_HMR_PORT"] ?? 5273);
const viewUrl = `http://127.0.0.1:${port}/`;
const env = { ...process.env, ...modeEnv, HERMETIC_HMR_PORT: String(port) };

const children: ChildProcess[] = [];

function start(argv: string[], cwd: string, childEnv: NodeJS.ProcessEnv): ChildProcess {
  const [command, ...args] = argv as [string, ...string[]];
  const child = spawn(command, args, { cwd, env: childEnv, stdio: "inherit", detached: true });
  children.push(child);
  return child;
}

function stopAll(code: number): never {
  for (const child of children) {
    if (child.pid === undefined || child.exitCode !== null) continue;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  process.exit(code);
}
process.on("SIGINT", () => stopAll(130));
process.on("SIGTERM", () => stopAll(143));

const vite = start([process.execPath, "x", "--bun", "vite"], uiDir, env);
vite.on("exit", (code) => {
  console.error(`dev-hmr: vite exited (${code}); stopping`);
  stopAll(code || 1);
});

const deadline = Date.now() + 30_000;
for (;;) {
  try {
    await fetch(viewUrl, { method: "HEAD", signal: AbortSignal.timeout(1_000) });
    break;
  } catch {
    if (Date.now() > deadline) {
      console.error(`dev-hmr: vite did not answer on ${viewUrl} within 30s`);
      stopAll(1);
    }
    await Bun.sleep(200);
  }
}

console.error(`dev-hmr: page served from ${viewUrl} (${mode}); starting the app`);
const app = start([hutchBinary(), "electrobun", "dev", "--watch"], appDir, {
  ...env,
  HERMETIC_VIEW_URL: viewUrl,
});
app.on("exit", (code) => stopAll(code ?? 0));
onAppQuit(appDir, app.pid ?? -1, () => {
  console.error("dev-hmr: the app was quit; stopping");
  stopAll(0);
});
