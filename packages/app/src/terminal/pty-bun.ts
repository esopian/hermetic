/**
 * The real PTY: `Bun.spawn` with a `terminal` (issue #18).
 *
 * Two things here are easy to get wrong, and the probe found both:
 *
 * - **The exit code** comes from the subprocess (`exited`, `exitCode`,
 *   `signalCode`), never from the terminal's own `exit` callback, which
 *   reports the PTY reaching EOF — 0 for a clean EOF whatever the process
 *   exited with.
 * - **Signals go to the group.** The PTY child is a session leader, so
 *   `process.kill(-pid, sig)` reaches every process in its foreground job.
 *   SIGSTOP to the group is what stops a flood at the source (the mirror's
 *   valve, `mirror.ts`); signalling only the pid would stop `tailscale` and
 *   leave nothing else to stop, but a local pipeline would run on.
 *
 * The child's environment is built from scratch rather than inherited: the
 * app's own environment may hold credentials (`AWS_*`, tokens a launcher
 * exported) that have no business inside an ssh client's process.
 */
import type { PtyExit, PtyLike, PtySignal, PtySpawnOptions, PtySpawner } from "./pty.ts";
import { DataListeners } from "./pty.ts";

/** The terminal type the PTY advertises, and the one xterm.js emulates. */
export const PTY_TERM = "xterm-256color";

/** Variables passed through from the app's environment; everything else is dropped. */
const PASS_THROUGH = new Set(["PATH", "HOME", "USER", "LANG", "SHELL"]);

/**
 * The environment a PTY child starts with: PATH, HOME, USER, LANG, SHELL and
 * the `LC_*` locale variables from `source`, then `TERM`, then `extra`.
 */
export function ptyEnv(
  source: Record<string, string | undefined>,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (PASS_THROUGH.has(key) || key.startsWith("LC_")) env[key] = value;
  }
  env.TERM = PTY_TERM;
  return { ...env, ...extra };
}

/** `process.kill`, as the group signaller calls it. Injected so a test can watch it. */
export type KillFn = (pid: number, sig: PtySignal) => void;

export interface BunPtyDeps {
  /** Defaults to `Bun.spawn`. */
  spawn?: typeof Bun.spawn;
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Defaults to `process.kill`. */
  kill?: KillFn;
}

/**
 * Signals a process group, treating "no such group" as done: the session may
 * have exited between the decision to signal it and the signal.
 */
export function signalProcessGroup(pid: number, sig: PtySignal, kill: KillFn): void {
  try {
    kill(-pid, sig);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "ESRCH") return;
    throw error;
  }
}

/** A spawner over `Bun.spawn`. */
export function bunPtySpawner(deps: BunPtyDeps = {}): PtySpawner {
  return (argv, opts) => spawnBunPty(argv, opts, deps);
}

export function spawnBunPty(argv: string[], opts: PtySpawnOptions, deps: BunPtyDeps = {}): PtyLike {
  const spawn = deps.spawn ?? Bun.spawn;
  const kill: KillFn = deps.kill ?? ((pid, sig) => process.kill(pid, sig));
  const listeners = new DataListeners();
  let done = false;

  const proc = spawn(argv, {
    env: ptyEnv(deps.env ?? process.env, opts.env),
    terminal: {
      cols: opts.cols,
      rows: opts.rows,
      name: PTY_TERM,
      // Copied: the mirror holds chunks until xterm has parsed them, and the
      // runtime makes no promise that it will not reuse the buffer it lent.
      data: (_terminal, bytes) => listeners.emit(bytes.slice()),
    },
  });
  const terminal = proc.terminal;
  if (terminal === undefined) {
    // Spawned, but not behind a PTY: this runtime does not support one.
    proc.kill("SIGKILL");
    throw new Error("this runtime cannot spawn a process behind a PTY");
  }

  // `done` flips in the same callback that settles `exited`, so nobody who has
  // seen the exit can still reach a live `signalGroup` a microtask later.
  const settle = (): PtyExit => {
    done = true;
    return { code: proc.exitCode, signal: proc.signalCode };
  };
  const exited: Promise<PtyExit> = proc.exited.then(settle, settle);

  return {
    pid: proc.pid,
    write(data) {
      if (done || terminal.closed) return;
      terminal.write(data);
    },
    resize(cols, rows) {
      if (done || terminal.closed) return;
      terminal.resize(cols, rows);
    },
    signalGroup(sig) {
      // Once the leader is reaped its pid — and so the group id — can be
      // handed to an unrelated process; a late hangup must not reach it.
      if (done) return;
      signalProcessGroup(proc.pid, sig, kill);
    },
    close() {
      if (!terminal.closed) terminal.close();
    },
    onData(cb) {
      listeners.add(cb);
    },
    exited,
  };
}
