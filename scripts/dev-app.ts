#!/usr/bin/env bun
/**
 * `bun run dev`, `dev:fixture`, `dev:wizard`: `hutch run <script>` in
 * `packages/app`, ended when the operator quits the app.
 *
 * Left to itself the `--watch` session outlives the window and keeps holding
 * the machine-wide Electrobun release lock, so the next `dev` in any checkout
 * waits on a terminal tab nobody is looking at (`dev-quit.ts`). This wrapper
 * adds exactly one thing: when the app is quit, it stops the session the way
 * Ctrl-C would.
 *
 * `hutch` leads its own process group and is stopped as a group: it does not
 * pass a signal on to the app it launched, so signalling the `hutch` pid alone
 * leaves an orphaned window behind (the same reason `dev-hmr.ts` does it).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { onAppQuit } from "./dev-quit.ts";

const script = process.argv[2] ?? "dev";
const appDir = join(resolve(import.meta.dir, ".."), "packages/app");

function hutchBinary(): string {
  const onPath = Bun.which("hutch");
  if (onPath !== null) return onPath;
  const installed = join(homedir(), ".hutch/bin/hutch");
  if (existsSync(installed)) return installed;
  console.error("dev: `hutch` is not installed — see CONTRIBUTING.md");
  process.exit(2);
}

// Hutch's own scripts (`hutch.config.ts`) call `hutch` by name, so the
// installer's bin directory goes on the child's `PATH` too, after the caller's.
const hutch = spawn(hutchBinary(), ["run", script], {
  cwd: appDir,
  env: { ...process.env, PATH: `${process.env["PATH"] ?? ""}:${join(homedir(), ".hutch/bin")}` },
  stdio: "inherit",
  detached: true,
});

function stop(signal: NodeJS.Signals): void {
  if (hutch.pid === undefined || hutch.exitCode !== null) return;
  try {
    process.kill(-hutch.pid, signal);
  } catch {
    // Already gone.
  }
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

/** Set once the app was quit, so the session we then stop counts as a clean exit. */
let quit = false;
const unwatch = onAppQuit(appDir, hutch.pid ?? -1, () => {
  quit = true;
  console.error("dev: the app was quit; stopping the watch session");
  stop("SIGINT");
});

hutch.on("exit", (code, signal) => {
  unwatch();
  if (quit) process.exit(0);
  process.exit(code ?? (signal === null ? 0 : 130));
});
