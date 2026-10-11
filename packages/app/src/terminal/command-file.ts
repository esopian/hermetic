/**
 * "Open in Terminal ↗" (D6, issue #18): the same `tailscale ssh` the in-app
 * terminal runs, handed to macOS Terminal instead.
 *
 * There is no API to ask Terminal to run an argv, but it runs any `.command`
 * file `open` is pointed at. So the argv is written into one, every element
 * through `shellQuote`, in a directory only this user can read, and the file is
 * removed a minute later — long after Terminal has read it. It holds nothing
 * secret: the argv is the tailscale binary, `ssh` and `hermes@<host>`.
 *
 * Nothing here runs at import time; the runner and the clock are injected, and
 * refusing in fixture mode is the handler's job.
 */
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HermeticError } from "@hermetic/core";
import type { Timers } from "./timers.ts";

/** How long the file outlives the `open`. Terminal reads it at once; this is slack. */
export const COMMAND_FILE_TTL_MS = 60_000;

/**
 * One argument as POSIX `sh` reads it back verbatim: the whole string in
 * single quotes, where nothing is special, and each `'` in it closed, escaped
 * and reopened (`'\''`). Newlines, `$(…)`, backticks, globs and a leading `-`
 * or `VAR=` all come back as the literal text. Always quoted, even a plain
 * word, so `FOO=bar` as the first word can never become an assignment.
 *
 * NUL is refused rather than quoted: no argv element can hold one, and the
 * shell would cut the string at it.
 */
export function shellQuote(arg: string): string {
  if (arg.includes("\0")) {
    throw new HermeticError("VALIDATION", "a command argument cannot contain a NUL byte");
  }
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/** The script body: `exec` the argv, so closing the window ends the ssh session. */
export function commandFileContent(argv: readonly string[]): string {
  if (argv.length === 0) throw new HermeticError("VALIDATION", "nothing to run");
  return `#!/bin/sh\n# Opened by Hermetic; removed shortly after it starts.\nexec ${argv.map(shellQuote).join(" ")}\n`;
}

export interface OpenInTerminalDeps {
  /** Runs `open <file>`; resolves to its exit code. */
  run(argv: string[]): Promise<number>;
  timers: Pick<Timers, "setTimeout">;
  /** Parent of the private directory. Defaults to the OS temp dir. */
  tmpRoot?: string;
}

/**
 * Write the `.command` file and `open` it. Resolves to the file's path once
 * `open` has accepted it; the file and its directory are removed after
 * `COMMAND_FILE_TTL_MS`, or at once if `open` fails.
 */
export async function openInTerminal(
  argv: readonly string[],
  deps: OpenInTerminalDeps,
): Promise<{ path: string }> {
  const content = commandFileContent(argv);
  // mkdtemp creates the directory 0700 already; the chmod says so out loud and
  // does not depend on the platform's default.
  const dir = await mkdtemp(join(deps.tmpRoot ?? tmpdir(), "hermetic-terminal-"));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    await chmod(dir, 0o700);
    const path = join(dir, "hermetic-ssh.command");
    // `wx`: a fresh file in a fresh directory, never through something already there.
    await writeFile(path, content, { mode: 0o700, flag: "wx" });
    await chmod(path, 0o700);
    const code = await deps.run(["open", path]);
    if (code !== 0) {
      throw new HermeticError("INTERNAL", `open exited ${code} for the terminal command file`);
    }
    deps.timers.setTimeout(() => {
      void cleanup();
    }, COMMAND_FILE_TTL_MS);
    return { path };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/** The real runner: `Bun.spawn`, only when called. */
export async function spawnRunner(argv: string[]): Promise<number> {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  return await proc.exited;
}
