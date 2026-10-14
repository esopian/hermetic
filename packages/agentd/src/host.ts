/**
 * Every shell and filesystem touch in hermeticd goes through `Host`. The real
 * implementation is the only module allowed to reach the actual box; tests
 * inject `FakeHost` (test/fake-host.ts) and assert on its recorded command log,
 * so the whole apply path runs with no root, no systemd and no network (§11.5).
 */
import { randomBytes } from "node:crypto";
import { AgentdError } from "./errors.ts";
import { redactArgv, redactEnv, redactValue } from "./redact.ts";
import * as sysinfo from "./sysinfo.ts";
import type { FilesystemSample, MemorySample } from "./sysinfo.ts";

export type { FilesystemSample, MemorySample } from "./sysinfo.ts";

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
  /** Hold an OS file lock across `work`, including awaits; the real daemon and apply share it. */
  withFileLock<T>(path: string, work: () => Promise<T>): Promise<T>;
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
  /**
   * The OS readings (`sysinfo.ts`). Each is `null` when it could not be taken —
   * "not measured", never a fabricated zero. `cpuLoad` is busy percent since its
   * previous call, so it has exactly one caller: the heartbeat.
   */
  cpuLoad(): Promise<number | null>;
  memory(): Promise<MemorySample | null>;
  /** The filesystem holding `path`, which need not be a mount point itself. */
  filesystem(path: string): Promise<FilesystemSample | null>;
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
  /**
   * Create `path` as `user` and stream `chunks` into it — the files service's
   * one way of putting bytes under `/data/hermes` (`files/fs-ops.ts`).
   *
   * As the account, never as root: every directory on the way is the
   * account's own, so it can swap any of them for a symlink, and a root
   * writer would follow it. Exclusive: the create fails if anything — a file,
   * a symlink — is already at `path`, so nothing is ever overwritten. Created
   * at mode 0600 (umask 077), then set to `opts.mode`.
   *
   * A failure mid-stream — the iterator throwing, the child dying — rejects,
   * and may leave the partial file behind: the caller owns cleaning it up,
   * because the caller is the one that named it.
   */
  writeStreamAs(
    user: string,
    path: string,
    chunks: AsyncIterable<Uint8Array>,
    opts: { readonly mode: string },
  ): Promise<{ readonly bytes: number }>;
  /**
   * The bytes of `path`, read as `user` — so nothing is read with root's
   * permissions. Refuses a symlink and anything but a regular file
   * (`READ_STREAM_SCRIPT`): the account could otherwise point a path the index
   * trusts at a file it can read but must not hand out (`$HERMES_HOME/.env`, a
   * tmpfs secret). The stream errors if the file cannot be read. Cancelling it
   * stops the reader.
   */
  readStreamAs(user: string, path: string): ReadableStream<Uint8Array>;
}

/**
 * The shell `writeStreamAs` runs as the target account. `umask 077` makes the
 * create 0600. `set -C` (noclobber) makes `>` an `O_EXCL` create for a path
 * that does not exist and a refusal for a *regular* file that does — but it
 * still opens an existing non-regular file, and follows a symlink to one, so
 * a link to `/dev/null` or a fifo would swallow the upload and "succeed". The
 * explicit test before it refuses anything at all at `$1`, a dangling or
 * non-regular symlink included, with exit 17 (EEXIST); `set -C` stays to
 * close the window between that test and the create. `$1` is the path, `$2`
 * the final mode — positional, so neither is ever parsed as shell.
 */
export const WRITE_STREAM_SCRIPT =
  'umask 077; set -C; [ -e "$1" ] || [ -L "$1" ] && exit 17; cat > "$1" || exit $?; [ "$2" = 0600 ] || chmod -- "$2" "$1"';

/**
 * The shell `readStreamAs` runs as the account: exit 40 for a symlink or
 * anything but a regular file, else `cat` it. A check-then-open, so the
 * account can still swap the path between the two (the files service checks
 * the byte count against its index and the laptop verifies `Content-Digest`;
 * see `files/entries.ts`).
 */
export const READ_STREAM_SCRIPT = '[ -L "$1" ] || [ ! -f "$1" ] && exit 40; exec cat -- "$1"';

/** `READ_STREAM_SCRIPT`'s refusal. */
export const READ_STREAM_REFUSED = 40;

/** The slice of a Bun subprocess `pipeIntoChild` drives — structural, so a test can hand it a real child. */
export interface PipedChild {
  readonly stdin: { write(chunk: Uint8Array): unknown; flush(): unknown; end(): unknown };
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(): void;
}

/** How long a broken pipe waits for the child's exit status before killing it. */
const PIPE_EXIT_GRACE_MS = 1000;

/**
 * Stream `chunks` into `proc`'s stdin, with backpressure, and wait for it.
 *
 * The child exiting early ends the read: each write's flush is raced against
 * `proc.exited`, so a `cat` that refused its target (noclobber, a full disk)
 * stops the upload there and surfaces its own exit code and stderr, instead
 * of the rest of a 256 MiB body being read and written into a dead pipe. An
 * early exit with status 0 is a failure too: the child stopped reading before
 * the body ended.
 *
 * Two kinds of failure, told apart by where they come from. The iterator's
 * own (a 408 for a stalled body, a 413 for one over its length) is the
 * caller's answer and is rethrown as it is, after the child is stopped — even
 * when the child had already died. A write or flush failing (`EPIPE`) is only
 * the symptom of the child going away: it waits for the child's exit status
 * and reports that, with the child's stderr.
 */
export async function pipeIntoChild(
  proc: PipedChild,
  chunks: AsyncIterable<Uint8Array>,
  what: string,
  details: Record<string, unknown> = {},
): Promise<{ bytes: number }> {
  const state: { code: number | null } = { code: null };
  const exited = proc.exited.then(
    (code) => {
      state.code = code;
      return code;
    },
    () => {
      state.code = 1;
      return 1;
    },
  );
  const stop = async (): Promise<void> => {
    if (state.code === null) {
      try {
        proc.kill();
      } catch {
        // Already gone.
      }
    }
    await exited;
  };
  const iterator = chunks[Symbol.asyncIterator]();
  let bytes = 0;
  let early = false;
  for (;;) {
    let next: IteratorResult<Uint8Array>;
    try {
      next = await iterator.next();
    } catch (e) {
      await stop();
      throw e;
    }
    if (next.done) break;
    if (state.code !== null) {
      early = true;
      break;
    }
    const chunk = next.value;
    bytes += chunk.byteLength;
    try {
      proc.stdin.write(chunk);
      // Backpressure: a 256 MiB upload must not sit in this process's memory
      // because the disk was slower than the network.
      const won = await Promise.race([
        Promise.resolve(proc.stdin.flush()).then(() => "flushed" as const),
        exited.then(() => "exited" as const),
      ]);
      if (won === "exited") {
        early = true;
        break;
      }
    } catch {
      // A broken pipe: the child is going or gone, and its exit says why.
      early = true;
      break;
    }
  }
  if (early) {
    // Stop the body: nothing more of it is wanted.
    await Promise.resolve(iterator.return?.()).catch(() => undefined);
  } else {
    try {
      await proc.stdin.end();
    } catch {
      early = true;
    }
  }
  if (early && state.code === null) {
    // Give a child that broke the pipe a moment to report its status before
    // stopping it, so the error carries its exit code and not a bare EPIPE.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = await Promise.race([
      exited.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), PIPE_EXIT_GRACE_MS);
      }),
    ]);
    clearTimeout(timer);
    if (!settled) await stop();
  }
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text().catch(() => ""), exited]);
  if (code !== 0) {
    throw new AgentdError("COMMAND_FAILED", `${what} exited ${code}: ${redactValue(stderr.trim())}`, {
      ...details,
      code,
    });
  }
  if (early) {
    throw new AgentdError("COMMAND_FAILED", `${what} stopped reading before the body ended`, {
      ...details,
      code,
    });
  }
  return { bytes };
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

/**
 * A whole file, or `null` where there is no file to read — absent, a parent
 * that is not a directory, or a directory itself (which `Bun.file().exists()`
 * also answered `false` for). Anything else, a permission error included, is a
 * real failure and throws.
 */
async function readOrNull(path: string): Promise<Uint8Array | null> {
  const { readFile } = await import("node:fs/promises");
  try {
    const buf = await readFile(path);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return null;
    throw error;
  }
}

/**
 * The real host: `Bun.$` for commands, `Bun.file`/`node:fs` for the filesystem,
 * `systeminformation` (`sysinfo.ts`) for the OS readings.
 */
export function realHost(): Host {
  return {
    async withFileLock(path, work) {
      const { mkdir } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdir(dirname(path), { recursive: true, mode: 0o711 });
      // `flock` keeps the lock for as long as its child is alive. A ready line
      // distinguishes acquisition from merely starting a process that is waiting.
      const proc = Bun.spawn(
        ["flock", "-x", "-w", "300", path, "sh", "-c", "printf 'ready\\n'; cat >/dev/null"],
        { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
      );
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      let ready = "";
      try {
        while (!ready.includes("\n")) {
          const chunk = await reader.read();
          if (chunk.done) throw new AgentdError("COMMAND_FAILED", "could not acquire file secret lock");
          ready += new TextDecoder().decode(chunk.value);
        }
        if (ready.split("\n", 1)[0] !== "ready") {
          throw new AgentdError("COMMAND_FAILED", "could not acquire file secret lock");
        }
        return await work();
      } finally {
        reader.releaseLock();
        try {
          await proc.stdin.end();
        } catch {
          // Acquisition may have failed and closed the child's stdin already.
        }
        await proc.exited;
      }
    },

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

    async writeStreamAs(user, path, chunks, opts) {
      const proc = Bun.spawn(
        ["runuser", "-u", user, "--", "sh", "-c", WRITE_STREAM_SCRIPT, "sh", path, opts.mode],
        { env: execEnv(), stdin: "pipe", stdout: "ignore", stderr: "pipe" },
      );
      return pipeIntoChild(proc, chunks, `writing as ${user}`, { path });
    },

    readStreamAs(user, path) {
      const proc = Bun.spawn(
        ["runuser", "-u", user, "--", "sh", "-c", READ_STREAM_SCRIPT, "sh", path],
        {
          env: execEnv(),
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
        },
      );
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          const next = await reader.read();
          if (!next.done) {
            controller.enqueue(next.value);
            return;
          }
          const code = await proc.exited;
          if (code === 0) controller.close();
          else
            controller.error(
              code === READ_STREAM_REFUSED
                ? new AgentdError("COMMAND_FAILED", `reading as ${user}: not a regular file`, {
                    path,
                    code,
                  })
                : new AgentdError("COMMAND_FAILED", `reading as ${user} exited ${code}`, {
                    path,
                    code,
                  }),
            );
        },
        cancel() {
          try {
            proc.kill();
          } catch {
            // Already gone.
          }
        },
      });
    },

    // `node:fs`, not `Bun.file`: a `BunFile` that has been stat'ed (`exists()`
    // does) trusts the size it saw, and every procfs file reports size 0 — so
    // `/proc/stat`, `/proc/meminfo` and the boot id all read back as "", and the
    // heartbeat reported 0% CPU and 0% memory on every box. `readFile` reads to
    // EOF whatever the stat said.
    async readFile(path) {
      const bytes = await readOrNull(path);
      return bytes === null ? null : new TextDecoder().decode(bytes);
    },

    async readBytes(path) {
      return readOrNull(path);
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

    cpuLoad: () => sysinfo.cpuLoad(),
    memory: () => sysinfo.memory(),
    filesystem: (path) => sysinfo.filesystem(path),

    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
