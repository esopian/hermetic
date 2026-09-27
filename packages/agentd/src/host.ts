/**
 * Every shell and filesystem touch in hermeticd goes through `Host`. The real
 * implementation is the only module allowed to reach the actual box; tests
 * inject `FakeHost` (test/fake-host.ts) and assert on its recorded command log,
 * so the whole apply path runs with no root, no systemd and no network (§11.5).
 */
import { randomBytes } from "node:crypto";
import { AgentdError } from "./errors.ts";
import { redactArgv, redactEnv, redactValue } from "./redact.ts";

export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ExecOptions {
  /** Extra environment for this one command. Never logged. */
  readonly env?: Record<string, string>;
  /** Fed to the child's stdin — how a secret reaches `bws` without a file. */
  readonly stdin?: string;
  readonly cwd?: string;
  /**
   * Kills the child when aborted. Read by `execLines`, which is the only entry
   * point that can outlive its caller: a `--follow` stream is unbounded by
   * construction, so when the operator hangs up, something has to say so.
   *
   * Returning early from the `for await` is not that something. An async
   * generator parked inside an `await` — which is exactly where `execLines`
   * sits between two lines — does not run its `finally` until that `await`
   * settles, so a `return()` on a quiet log is queued behind a line that may
   * never come. The `finally` is still there for the ordinary case; this is the
   * out-of-band channel for the one that matters.
   */
  readonly signal?: AbortSignal;
}

export interface FileStat {
  /** Octal permission string, e.g. `0644`. */
  readonly mode: string;
  readonly size: number;
  readonly isDirectory: boolean;
  /** Only ever true from `lstat`; `stat` follows the link and reports its target. */
  readonly isSymlink: boolean;
}

export interface StatfsResult {
  readonly blockSize: number;
  readonly blocks: number;
  readonly available: number;
}

/**
 * One thing a streamed child process did: emitted a line, or finished.
 *
 * `exec` buffers everything and hands back the exit code at the end, which is
 * right for the hundred short commands `apply` runs. A bootstrap stage is the
 * opposite shape: it can take minutes, its output is the operator's only view
 * of what is happening, and its `::progress` lines are only useful while it is
 * still running (§4.2). Both streams are interleaved in the order they arrived,
 * and exactly one `exit` arrives, last.
 */
export type ExecEvent =
  | { readonly type: "line"; readonly stream: "stdout" | "stderr"; readonly line: string }
  | { readonly type: "exit"; readonly code: number };

export interface Host {
  exec(argv: readonly string[], opts?: ExecOptions): Promise<ExecResult>;
  /** `null` when the path does not exist — hermeticd never throws on absence. */
  readFile(path: string): Promise<string | null>;
  readBytes(path: string): Promise<Uint8Array | null>;
  writeFile(path: string, content: string, mode?: string): Promise<void>;
  writeBytes(path: string, content: Uint8Array, mode?: string): Promise<void>;
  stat(path: string): Promise<FileStat | null>;
  /**
   * `stat` that does not follow a symlink. The difference matters exactly where
   * hermeticd is about to *replace* a path: following the link would report the
   * target's mode and then overwrite the link itself (§6.5, §8.3).
   */
  lstat(path: string): Promise<FileStat | null>;
  chmod(path: string, mode: string): Promise<void>;
  mkdir(path: string, mode?: string): Promise<void>;
  rename(path: string, to: string): Promise<void>;
  /**
   * A second name for the same inode. The one operation that can put a file
   * *beside* itself without the original ever ceasing to exist, which is what
   * the self-update's backup needs: `/usr/local/bin/hermeticd` is the
   * `ExecStart` of two units, so it may never be missing, not even between two
   * renames (§6.5).
   */
  link(path: string, to: string): Promise<void>;
  /** Unlink; a missing path is not an error. */
  remove(path: string): Promise<void>;
  statfs(path: string): Promise<StatfsResult | null>;
  /** Wall clock, injected so heartbeat and event timestamps are testable. */
  now(): Date;
  sleep(ms: number): Promise<void>;
  /** Append, creating the file if it is not there. Used for the stage logs. */
  appendFile(path: string, content: string, mode?: string): Promise<void>;
  /** File names in a directory, without paths. `[]` when it does not exist. */
  readdir(path: string): Promise<string[]>;
  /**
   * SHA-256 of a file, streamed. `null` when the path is not there. The
   * hermeticd binary is ~100 MB and the nightly update hashes it every tick;
   * reading it into a `Uint8Array` first is memory this box does not have to
   * spend (§4.4).
   */
  sha256File(path: string): Promise<string | null>;
  /**
   * Line stream for `journalctl --follow`; the fake yields a fixed script.
   *
   * The child is killed when the consumer stops reading — by `opts.signal`, or
   * failing that when the iterator is returned or thrown into. A followed
   * stream has no other end: nothing makes `tail -F` exit on its own, and a
   * `hermetic logs --follow` the operator closed would otherwise leave one
   * running on the box until its next write found a closed pipe, which on a
   * quiet log is never.
   */
  execLines(argv: readonly string[], opts?: ExecOptions): AsyncIterable<string>;
  /** Streamed exec with both pipes and the exit code — how a stage is run (§4.2). */
  execEvents(argv: readonly string[], opts?: ExecOptions): AsyncIterable<ExecEvent>;
}

/**
 * `exec` that throws instead of returning a non-zero code.
 *
 * Secrets reach a subprocess by env or stdin, never argv — but the failure path
 * is exactly where a leak would be preserved forever, so the recorded argv is
 * redacted, only env *keys* are recorded, and stderr is scrubbed too.
 */
export async function must(
  host: Host,
  argv: readonly string[],
  opts?: ExecOptions,
): Promise<ExecResult> {
  const res = await host.exec(argv, opts);
  if (res.code !== 0) {
    const safeArgv = redactArgv(argv);
    throw new AgentdError(
      "COMMAND_FAILED",
      `${safeArgv[0]} exited ${res.code}: ${redactValue(res.stderr.trim())}`,
      { argv: safeArgv, env: redactEnv(opts?.env), code: res.code },
    );
  }
  return res;
}

/**
 * The environment a *stage* runs in (§4.3). hermeticd's own process environment
 * carries whatever cloud-init, systemd and the instance role left in it —
 * including, on a box mid-`apply`, credentials materialised for another unit.
 * A stage gets an explicit list instead: the handful of variables any Unix
 * program needs, plus exactly what the runner chose to tell it.
 */
export const EXEC_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TERM",
  "DEBIAN_FRONTEND",
] as const;

export function execEnv(
  opts?: ExecOptions,
  source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of EXEC_ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === "string") env[key] = value;
  }
  return { ...env, ...(opts?.env ?? {}) };
}

function octal(mode: number): string {
  return "0" + (mode & 0o777).toString(8).padStart(3, "0");
}

/**
 * The sibling a file is staged through before it is renamed into place.
 *
 * A *sibling*, not `/tmp`: `rename(2)` is only atomic within one filesystem, and
 * the whole point of staging is that the rename is the single step in which the
 * new content appears. Dot-prefixed because `installStages`'s `prune` — the one
 * directory scan hermeticd does — already ignores dot entries, so a write in
 * flight is never mistaken for a file a release no longer names.
 *
 * The suffix is four bytes from `crypto.randomBytes`, not the pid. Two
 * hermeticd processes can be writing at once (the bootstrap runner is still in
 * `05-service` when the hermeticd it just started runs its own start-up update,
 * §4.2), so it cannot be a constant — but a pid is guessable, and so is
 * `Math.random` after a couple of samples, while these writes happen as root
 * into directories (`/etc`, `/etc/systemd/system`) a less privileged account
 * may be able to create entries in. A predictable staging name is a file or a
 * symlink an attacker can plant and have root write through. An unguessable
 * name plus `O_EXCL` (see `writeAtomically`) closes both halves of that.
 */
export function stagingPathFor(path: string, suffix: string = randomSuffix()): string {
  const slash = path.lastIndexOf("/");
  const dir = slash === -1 ? "" : path.slice(0, slash + 1);
  const name = slash === -1 ? path : path.slice(slash + 1);
  return `${dir}.${name}.tmp.${suffix}`;
}

function randomSuffix(): string {
  // `crypto`, not `Math.random`: this name is the thing an attacker would have
  // to guess to plant a file in front of a root write, and a PRNG seeded per
  // process is guessable from two previous names.
  return randomBytes(4).toString("hex");
}

/**
 * The join between two callback-shaped pipe readers and one async iterator.
 * Without it a stage's stdout and stderr would arrive as two lumps at the end
 * instead of interleaved as they happen, which is the whole point of streaming.
 */
class EventQueue implements AsyncIterable<ExecEvent> {
  private readonly buffer: ExecEvent[] = [];
  private waiting: (() => void) | null = null;
  private closed = false;

  push(event: ExecEvent): void {
    this.buffer.push(event);
    this.wake();
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ExecEvent> {
    for (;;) {
      while (this.buffer.length > 0) yield this.buffer.shift() as ExecEvent;
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
    }
  }
}

/**
 * Write a file the only way an unattended box may: in full, or not at all.
 *
 * hermeticd writes files nothing on the box can re-derive — a systemd unit, the
 * `secrets.env` a unit sources, the fleet-manifest cache every other subcommand
 * reads — and it writes them on a machine that can lose power mid-`apply` or be
 * terminated mid-update. A direct `write(2)` leaves the truncated prefix behind,
 * and a truncated unit file or a half-written `fleet.json` is a box that comes
 * back up broken in a way no later run notices, because the file *is* there.
 *
 * So: stage a sibling, `fsync` it, rename over the target. The rename is the
 * only step a reader can observe, and it either happened or it did not.
 *
 * Three properties of the previous file are carried across on purpose, because
 * a rename replaces the inode and would otherwise silently reset them:
 *
 *  - **mode**, when the caller did not name one (`writeFile(path, content)` has
 *    always meant "leave the mode alone");
 *  - **ownership**, when the target is owned by somebody other than us — the
 *    `hermes` account owns rendered files that `apply` chowns once, and an
 *    update that quietly handed them back to root would break the unit that
 *    reads them;
 *  - nothing else. A file with hard links or an ACL is not a shape hermeticd
 *    writes.
 *
 * The staged file is removed if anything fails, so a crashed writer leaves at
 * most one dot-prefixed sibling and never a damaged target.
 */
async function writeAtomically(
  path: string,
  content: string | Uint8Array,
  mode?: string,
): Promise<void> {
  const fs = await import("node:fs/promises");

  /**
   * `lstat`, not `stat`. hermeticd writes no path that is meant to be a
   * symlink, so one at the target is either a mistake or somebody redirecting
   * a root write somewhere else. Following it would resolve the mode and owner
   * of the *destination* and then replace the link with a regular file — the
   * worst of both readings. Refusing is the only answer that cannot be turned
   * into a primitive.
   */
  const previous = await fs.lstat(path).catch(() => null);
  if (previous?.isSymbolicLink()) {
    throw new AgentdError("INTERNAL", `refusing to write through the symlink at ${path}`, { path });
  }
  const modeBits = mode ? Number.parseInt(mode, 8) : previous ? previous.mode & 0o777 : undefined;

  const staged = stagingPathFor(path);
  try {
    /**
     * `wx` — `O_CREAT|O_EXCL`. With the mode passed here the file is created
     * with its final permissions rather than at the umask's and chmod'd a
     * syscall later, and `O_EXCL` means the open fails outright if anything is
     * already at the name instead of writing through it. Between that and the
     * random suffix there is no window in which a planted file or symlink can
     * receive these bytes (§8.3).
     */
    const handle = await fs.open(staged, "wx", modeBits ?? 0o600);
    try {
      await handle.writeFile(content);
      // Ordered before the rename: a rename that lands ahead of the data is a
      // file that exists, is the right size, and is full of zeroes after a
      // power cut — the exact failure staging exists to prevent.
      await handle.sync();
    } finally {
      await handle.close();
    }
    // `open(…, mode)` is masked by the umask, and the target's mode is a
    // promise hermeticd makes to systemd and to §8.3.
    if (modeBits !== undefined) await fs.chmod(staged, modeBits);
    if (previous && (previous.uid !== process.getuid?.() || previous.gid !== process.getgid?.())) {
      await fs.chown(staged, previous.uid, previous.gid);
    }
    await fs.rename(staged, path);
  } catch (e) {
    await fs.rm(staged, { force: true }).catch(() => undefined);
    throw e;
  }

  /**
   * The rename is atomic but not yet *durable*: the directory entry it created
   * can still be lost to a power cut, which would resurrect the previous file
   * — and the whole update path leans on the swap marker being on disk before
   * `systemctl restart` is asked for (§6.5). Syncing the parent directory is
   * what makes the rename survive the box going away.
   *
   * Best effort: the bytes are already in place and the caller's write has
   * succeeded, so a filesystem that will not sync a directory handle is not a
   * reason to report a failed write.
   */
  const slash = path.lastIndexOf("/");
  const dir = slash <= 0 ? "/" : path.slice(0, slash);
  try {
    const handle = await fs.open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // A directory that cannot be synced is still a directory the file is in.
  }
}

/** The real host: `Bun.$` for commands, `Bun.file`/`node:fs` for the filesystem. */
export function realHost(): Host {
  return {
    async exec(argv, opts) {
      const proc = Bun.spawn([...argv], {
        env: opts?.env ? { ...process.env, ...opts.env } : process.env,
        cwd: opts?.cwd,
        stdin: opts?.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { code, stdout, stderr };
    },

    async *execLines(argv, opts) {
      const proc = Bun.spawn([...argv], {
        env: opts?.env ? { ...process.env, ...opts.env } : process.env,
        stdout: "pipe",
        stderr: "ignore",
      });
      // `kill` on an already-exited process is harmless, and both paths below
      // can fire for the same child: the signal arrives while the generator is
      // parked, and the `finally` then runs as the read unblocks.
      const stop = (): void => {
        try {
          proc.kill();
        } catch {
          // Already gone; there is nothing left to stop.
        }
      };
      opts?.signal?.addEventListener("abort", stop, { once: true });
      if (opts?.signal?.aborted) stop();
      try {
        const decoder = new TextDecoder();
        let buffered = "";
        for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
          buffered += decoder.decode(chunk, { stream: true });
          const lines = buffered.split("\n");
          buffered = lines.pop() ?? "";
          for (const line of lines) if (line.length > 0) yield line;
        }
        if (buffered.length > 0) yield buffered;
      } finally {
        opts?.signal?.removeEventListener("abort", stop);
        stop();
      }
    },

    execEvents(argv, opts) {
      // Not `{...process.env}`: a stage sees an allowlist and nothing else.
      const proc = Bun.spawn([...argv], {
        env: execEnv(opts),
        cwd: opts?.cwd,
        stdin: opts?.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
        stdout: "pipe",
        stderr: "pipe",
      });
      const queue = new EventQueue();

      const pump = async (
        stream: ReadableStream<Uint8Array>,
        which: "stdout" | "stderr",
      ): Promise<void> => {
        const decoder = new TextDecoder();
        let buffered = "";
        for await (const chunk of stream) {
          buffered += decoder.decode(chunk, { stream: true });
          const lines = buffered.split("\n");
          buffered = lines.pop() ?? "";
          for (const line of lines) queue.push({ type: "line", stream: which, line });
        }
        if (buffered.length > 0) queue.push({ type: "line", stream: which, line: buffered });
      };

      void Promise.all([
        pump(proc.stdout as ReadableStream<Uint8Array>, "stdout"),
        pump(proc.stderr as ReadableStream<Uint8Array>, "stderr"),
      ])
        .then(async () => {
          queue.push({ type: "exit", code: await proc.exited });
        })
        .catch(async () => {
          // A broken pipe still has an exit status, and the caller needs one:
          // a stage with no `exit` event would hang the runner forever.
          queue.push({ type: "exit", code: await proc.exited.catch(() => 1) });
        })
        .finally(() => queue.close());

      return queue;
    },

    async readFile(path) {
      const file = Bun.file(path);
      return (await file.exists()) ? await file.text() : null;
    },

    async readBytes(path) {
      const file = Bun.file(path);
      return (await file.exists()) ? new Uint8Array(await file.arrayBuffer()) : null;
    },

    // Every write is staged and renamed — see `writeAtomically`. `open(…, mode)`
    // rather than write-then-chmod, so a secret is never readable at the umask's
    // mode for the width of two syscalls (§8.3).
    async writeFile(path, content, mode) {
      await writeAtomically(path, content, mode);
    },

    async writeBytes(path, content, mode) {
      await writeAtomically(path, content, mode);
    },

    async appendFile(path, content, mode) {
      const { appendFile } = await import("node:fs/promises");
      await appendFile(path, content, mode ? { mode: Number.parseInt(mode, 8) } : undefined);
      if (mode) await this.chmod(path, mode);
    },

    async readdir(path) {
      const { readdir } = await import("node:fs/promises");
      try {
        return await readdir(path);
      } catch {
        return [];
      }
    },

    async stat(path) {
      const { stat } = await import("node:fs/promises");
      try {
        const s = await stat(path);
        return { mode: octal(s.mode), size: s.size, isDirectory: s.isDirectory(), isSymlink: false };
      } catch {
        return null;
      }
    },

    async lstat(path) {
      const { lstat } = await import("node:fs/promises");
      try {
        const s = await lstat(path);
        return {
          mode: octal(s.mode),
          size: s.size,
          isDirectory: s.isDirectory(),
          isSymlink: s.isSymbolicLink(),
        };
      } catch {
        return null;
      }
    },

    async chmod(path, mode) {
      const { chmod } = await import("node:fs/promises");
      await chmod(path, Number.parseInt(mode, 8));
    },

    async mkdir(path, mode) {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(path, { recursive: true, mode: mode ? Number.parseInt(mode, 8) : undefined });
    },

    async rename(path, to) {
      const { rename } = await import("node:fs/promises");
      await rename(path, to);
    },

    async link(path, to) {
      const { link } = await import("node:fs/promises");
      await link(path, to);
    },

    // Recursive: the stage installer leaves a per-process temp directory
    // behind, and `prune` removes whatever a release no longer names.
    async remove(path) {
      const { rm } = await import("node:fs/promises");
      await rm(path, { force: true, recursive: true });
    },

    async sha256File(path) {
      const { createReadStream } = await import("node:fs");
      const { createHash } = await import("node:crypto");
      const hash = createHash("sha256");
      try {
        const stream = createReadStream(path);
        for await (const chunk of stream) hash.update(chunk as Uint8Array);
      } catch {
        return null;
      }
      return hash.digest("hex");
    },

    async statfs(path) {
      const fs = await import("node:fs/promises");
      const statfs = (fs as unknown as { statfs?: (p: string) => Promise<Record<string, number>> })
        .statfs;
      if (!statfs) return null;
      try {
        const s = await statfs(path);
        return {
          blockSize: Number(s["bsize"] ?? 0),
          blocks: Number(s["blocks"] ?? 0),
          available: Number(s["bavail"] ?? 0),
        };
      } catch {
        return null;
      }
    },

    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
