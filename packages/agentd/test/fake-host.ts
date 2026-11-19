/**
 * The fake `Host`: a recording host over an in-memory filesystem, so the apply,
 * bootstrap and heartbeat paths run under `bun test` with no root, no systemd,
 * no apt and no network (§11.5).
 *
 * Every `exec` succeeds with empty output and is recorded in `commands`. A test
 * scripts output or failure only where the code under test *reads* a result
 * (`host.when(/^dpkg-query/, { stdout: "…" })`), and asserts what ran with
 * `expectRan`/`expectNotRan`/`ranInOrder` rather than by exact argv. The one
 * built-in model is systemd's enable/start/stop bookkeeping, which seven suites
 * read. `BoxHost` (fake-box.ts) layers the stateful box the apply suite needs.
 */
import { createHash } from "node:crypto";
import { expect } from "bun:test";
import type {
  ExecEvent,
  ExecOptions,
  ExecResult,
  FileStat,
  FilesystemSample,
  Host,
  MemorySample,
} from "../src/host.ts";
import { PATH_KIND_SCRIPT, RESOLVE_SCRIPT } from "../src/files/fs-ops.ts";
import { stagingPathFor } from "../src/host.ts";

export interface FakeFile {
  content: string;
  mode: string;
  /** `owner:group`, as `stat -c %U:%G` would report it. */
  ownership?: string;
  bytes?: Uint8Array;
}

export type ExecHandler = (argv: readonly string[], opts?: ExecOptions) => ExecResult | null;

/** What `when` registers: a canned result, or a function that may also have side effects. */
export type Script =
  | Partial<ExecResult>
  | ((argv: readonly string[], opts?: ExecOptions) => Partial<ExecResult> | null | undefined);

/**
 * What a streamed command (`execEvents`) did: the lines it printed and the code
 * it exited with. The bootstrap stage runner is the only caller, so a test
 * scripts a stage by registering one of these rather than by writing bash.
 */
export interface StreamScript {
  readonly lines?: ReadonlyArray<{ stream: "stdout" | "stderr"; line: string }>;
  readonly code?: number;
  /** Run before the lines are yielded — how a fake stage writes its facts file. */
  readonly before?: (argv: readonly string[], opts?: ExecOptions) => void | Promise<void>;
}

export type StreamHandler = (argv: readonly string[], opts?: ExecOptions) => StreamScript | null;

export const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
export const fail = (code = 1, stderr = ""): ExecResult => ({ code, stdout: "", stderr });

/**
 * The command under `timeout <secs>` and `runuser -u <who> --`, which change
 * nothing about what it is. `commands` keeps the full argv, so a test can still
 * assert something ran *as hermes*; matching sees both spellings.
 */
export function unwrapped(argv: readonly string[]): readonly string[] {
  if (argv[0] === "timeout") return unwrapped(argv.slice(2));
  if (argv[0] === "runuser") {
    const sep = argv.indexOf("--");
    if (sep !== -1) return unwrapped(argv.slice(sep + 1));
  }
  return argv;
}

const asRegExp = (pattern: string | RegExp): RegExp =>
  typeof pattern === "string" ? new RegExp(pattern) : pattern;

/** Whether a recorded command matches, wrapped or unwrapped. */
function matches(command: string, re: RegExp): boolean {
  if (command.length > 1000) throw new Error("recorded command exceeds matcher length limit");
  return re.test(command) || re.test(unwrapped(command.split(" ")).join(" "));
}

/** Every recorded command matching `pattern`. */
export function ran(host: FakeHost, pattern: string | RegExp): string[] {
  const re = asRegExp(pattern);
  return host.commands.filter((c) => matches(c, re));
}

/** Asserts a matching command ran — exactly `times` of them when given. */
export function expectRan(host: FakeHost, pattern: string | RegExp, times?: number): void {
  const hits = ran(host, pattern);
  if (times === undefined)
    expect(hits, `expected a command matching ${String(pattern)}`).not.toEqual([]);
  else expect(hits, `expected ${times} command(s) matching ${String(pattern)}`).toHaveLength(times);
}

export function expectNotRan(host: FakeHost, pattern: string | RegExp): void {
  expect(ran(host, pattern), `expected no command matching ${String(pattern)}`).toEqual([]);
}

/**
 * Whether the first match of each pattern comes after the first match of the
 * one before it. `false` when any pattern never ran.
 */
export function ranInOrder(host: FakeHost, patterns: ReadonlyArray<string | RegExp>): boolean {
  let from = 0;
  for (const pattern of patterns) {
    const re = asRegExp(pattern);
    const at = host.commands.findIndex((c, i) => i >= from && matches(c, re));
    if (at === -1) return false;
    from = at + 1;
  }
  return true;
}

export class FakeHost implements Host {
  readonly files = new Map<string, FakeFile>();
  private readonly fileLocks = new Map<string, Promise<void>>();

  async withFileLock<T>(path: string, work: () => Promise<T>): Promise<T> {
    const previous = this.fileLocks.get(path);
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.fileLocks.set(path, current);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.fileLocks.get(path) === current) this.fileLocks.delete(path);
    }
  }
  /**
   * The directories an Ubuntu box already has before hermeticd touches it.
   *
   * `requireParent` refuses a write into a directory nothing created, which is
   * the real `writeAtomically`'s behaviour — but only for directories hermetic
   * is responsible for. `/etc` and `/usr/local/bin` are the distribution's,
   * and a test that had to `mkdir` them would be documenting the fake instead
   * of the box.
   */
  readonly dirs = new Set<string>([
    "/",
    "/etc",
    "/etc/apt",
    "/etc/default",
    "/etc/systemd",
    "/etc/systemd/system",
    "/home",
    "/opt",
    "/proc",
    "/proc/self",
    "/root",
    "/run",
    "/tmp",
    "/usr",
    "/usr/bin",
    "/usr/lib",
    "/usr/local",
    "/usr/local/bin",
    "/usr/local/lib",
    "/usr/local/share",
    "/var",
    "/var/lib",
    "/var/log",
    "/var/tmp",
  ]);
  /** Every argv, joined with spaces, in order. */
  readonly commands: string[] = [];
  /** Scripts from `when`, newest first. */
  private readonly scripts: Array<{ re: RegExp; script: Script }> = [];
  /** Consulted after `when` scripts and before the built-in model; first match wins. */
  readonly handlers: ExecHandler[] = [];
  /** Hooks before each `exec`; the first `Error` makes the call *throw*: the process dying mid-step. */
  readonly execFaults: Array<(argv: readonly string[], opts?: ExecOptions) => Error | null> = [];
  /** Same, for `execEvents`. Nothing matching means "exited 0, said nothing". */
  readonly streamHandlers: StreamHandler[] = [];
  /** Every streamed argv (joined) and the env it was given, in order. */
  readonly streamed: string[] = [];
  readonly streamedEnv: Array<Record<string, string>> = [];
  /** Every `rename`/`link`/`remove`, in order: the binary swap's correctness is the sequence. */
  readonly fsOps: string[] = [];
  /** Hooks before each `rename`/`link`/`remove`, and before each write; the first `Error` fails it. */
  readonly fsFaults: Array<
    (op: "rename" | "link" | "remove", path: string, to?: string) => Error | null
  > = [];
  readonly writeFaults: Array<(path: string) => Error | null> = [];
  /** `lstat`'s `mtimeMs`, from the clock: set by `seed`, `writeFile` and an `appendFile` that writes. */
  readonly mtimes = new Map<string, number>();
  /** `[path, mode]` for every chmod, including ones on directories. */
  readonly chmods: Array<[string, string]> = [];
  /**
   * A directory's mode and `owner:group`, where something set them. Absent is
   * `0755` and root's, which is what a root `mkdir` under umask 022 leaves.
   */
  readonly dirAttrs = new Map<string, { mode?: string; ownership?: string }>();
  /** Names `stat` maps to ids; an unknown name is given the next free id, as `useradd` would. */
  readonly userIds = new Map<string, number>([
    ["root", 0],
    ["hermes", 1000],
  ]);
  /**
   * Hooks over the bytes each `copyFile` writes, in order: how a test makes a
   * copy land different from its source without the copy itself failing.
   */
  readonly copyCorruptions: Array<(from: string, to: string, bytes: Uint8Array) => Uint8Array> = [];

  // systemd, as far as `systemctl` moves it.
  readonly enabledUnits = new Set<string>();
  /** Every `systemctl start|restart`, and every `enable --now`, in order. */
  readonly restarted: string[] = [];
  /** Every `systemctl stop`, and every `disable --now`, in order. */
  readonly stopped: string[] = [];
  /** Units up as far as `start|restart|stop` says; `is-active` never reads it. */
  readonly runningUnits = new Set<string>();
  /**
   * Units `stop` brought down, when this host models unit state (`BoxHost`
   * does): `is-active` then answers `inactive` for these and `active` for every
   * other unit, the box's default; `start`, `restart` and `enable --now` bring
   * one back. Unmodelled, `is-active` always answers `active`.
   */
  readonly downUnits = new Set<string>();
  protected readonly modelsUnitState: boolean = false;
  /**
   * `ConditionPathExists=!<path>` lines from unit drop-ins, per unit, as of the
   * last `daemon-reload`. A start or restart while one of the paths exists is
   * skipped (`skippedStarts`), not failed.
   */
  readonly startConditions = new Map<string, string[]>();
  readonly skippedStarts: string[] = [];
  /** Units `stop` cannot bring down: a writer that survives it. */
  readonly stuckUnits = new Set<string>();
  /** Transient scopes under a user manager (`systemctl --user -M <user>@`); `stop <glob>` removes the matches. */
  readonly userScopes = new Set<string>();
  /** What `systemctl show` reports; no entry answers `active (running)`. */
  readonly unitStates = new Map<string, string | { ActiveState: string; SubState: string }>();
  readonly daemonReloads: string[] = [];

  /** The pids `/proc` has a directory for. Empty by default: a stale lock is litter. */
  readonly livePids = new Set<number>();
  /** Paths this box treats as symlinks. `lstat` is the only thing that sees them. */
  readonly symlinks = new Set<string>();
  /**
   * Where a symlink points, for the ones a test gave a target (`symlink`).
   * Only `RESOLVE_SCRIPT` (`realpath -e`) follows them; a link in `symlinks`
   * with no target here is dangling.
   */
  readonly linkTargets = new Map<string, string>();
  /** The fleet bucket: key → bytes. `getObject` is the `ObjectFetch` a test hands to `apply`. */
  readonly s3Objects = new Map<string, Uint8Array>();
  getObject = async (bucket: string, key: string): Promise<Uint8Array> => {
    this.commands.push(`s3:GetObject ${bucket} ${key}`);
    const bytes = this.s3Objects.get(key);
    if (!bytes) throw new Error(`AccessDenied: not authorized to perform s3:GetObject on ${key}`);
    return bytes;
  };
  /** `cpuLoad()`'s answer; `null` is "could not measure". */
  cpuLoadPct: number | null = 0;
  /** How many times `cpuLoad()` was asked — the heartbeat primes it once. */
  cpuLoadCalls = 0;
  /** `memory()`'s answer. */
  memorySample: MemorySample | null = { total: 4 * 1024 ** 3, available: 3 * 1024 ** 3 };
  /** The answer for any path with no entry in `filesystemByPath`. */
  filesystemResult: FilesystemSample | null = {
    mount: "/",
    size: 4_096_000_000,
    available: 3_276_800_000,
    usePct: 20,
  };
  /** Per-path answers, consulted first; a `null` value is "could not measure here". */
  readonly filesystemByPath = new Map<string, FilesystemSample | null>();
  clock = new Date("2026-09-01T12:00:00.000Z");
  sleeps: number[] = [];
  journalLines: string[] = [];
  /** When set, `execLines` parks after its lines until the command is killed. */
  followsForever = false;
  /** Every `execLines` argv whose child was killed, joined with spaces. */
  readonly killedCommands: string[] = [];
  /** Every `writeStreamAs`: who wrote, where, at what mode, and how many bytes landed. */
  readonly streamWrites: Array<{ user: string; path: string; mode: string; bytes: number }> = [];
  /** Every `readStreamAs`, as `user path`. */
  readonly streamReads: string[] = [];
  /** Every `readStreamAs` path whose reader was cancelled before it ended. */
  readonly cancelledReads: string[] = [];
  /**
   * Hooks consulted after each chunk of a `writeStreamAs`, with the bytes
   * written so far; the first `Error` fails the write mid-stream, leaving the
   * partial file behind as the real one would.
   */
  readonly streamFaults: Array<(path: string, bytesSoFar: number) => Error | null> = [];
  /**
   * Every filesystem call made through a `Host` method — root's own, as
   * opposed to a command run as an account — as `<method> <path>`. How a test
   * proves root never touched a path under `/data` (`files/fs-ops.ts`).
   */
  readonly rootFsCalls: string[] = [];

  private rootFs(method: string, path: string): void {
    this.rootFsCalls.push(`${method} ${path}`);
  }

  now(): Date {
    return new Date(this.clock.getTime());
  }

  advance(ms: number): void {
    this.clock = new Date(this.clock.getTime() + ms);
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.advance(ms);
  }

  /**
   * Seed a file as if it were already on the box — its directory included.
   *
   * `writeFile` refuses a write into a directory nothing created, because the
   * real one does and that refusal is how a missing `mkdir` in hermeticd gets
   * caught. A seeded file is not hermeticd writing, it is a precondition: the
   * box it describes had the directory before the test began.
   */
  seed(path: string, content: string, mode = "0644"): void {
    this.markDirs(path);
    this.files.set(path, { content, mode });
    this.mtimes.set(path, this.clock.getTime());
  }

  /** `seed` for the byte-shaped ones: a half-downloaded zip a killed apply left. */
  seedBytes(path: string, content: Uint8Array, mode = "0644"): void {
    this.markDirs(path);
    this.files.set(path, { content: new TextDecoder().decode(content), bytes: content, mode });
  }

  /** A symlink at `path` pointing at `target` (absolute, or relative to the link's directory). */
  symlink(path: string, target: string): void {
    this.markDirs(path);
    this.files.delete(path);
    this.symlinks.add(path);
    this.linkTargets.set(path, target);
  }

  /**
   * `realpath -e`: every component followed, `.`/`..` folded, each one
   * required to exist. `null` for a dangling link, a loop or a missing
   * component.
   */
  realpath(path: string): string | null {
    let pending = path.split("/").filter((p) => p !== "");
    let out = "";
    let hops = 0;
    while (pending.length > 0) {
      const seg = pending.shift() as string;
      if (seg === ".") continue;
      if (seg === "..") {
        out = out.slice(0, Math.max(0, out.lastIndexOf("/")));
        continue;
      }
      const next = `${out}/${seg}`;
      const target = this.linkTargets.get(next);
      if (target !== undefined) {
        if (++hops > 40) return null;
        if (target.startsWith("/")) out = "";
        pending = [...target.split("/").filter((p) => p !== ""), ...pending];
        continue;
      }
      if (this.symlinks.has(next)) return null;
      const last = pending.length === 0;
      if (!this.dirs.has(next) && !(last && this.files.has(next))) return null;
      out = next;
    }
    return out === "" ? "/" : out;
  }

  /** Register a file's parent, and its parents, as directories that exist. */
  private markDirs(path: string): void {
    for (let slash = path.indexOf("/", 1); slash !== -1; slash = path.indexOf("/", slash + 1)) {
      this.dirs.add(path.slice(0, slash));
    }
  }

  /** Commands matching `pattern`, wrapped or unwrapped, for terse assertions. */
  commandsMatching(pattern: string | RegExp): string[] {
    return ran(this, pattern);
  }

  /** Script what a command answers; newest wins, `null` falls through. Returns the unregister. */
  when(pattern: string | RegExp, script: Script = {}): () => void {
    const entry = { re: asRegExp(pattern), script };
    this.scripts.unshift(entry);
    return () => {
      const at = this.scripts.indexOf(entry);
      if (at !== -1) this.scripts.splice(at, 1);
    };
  }

  async exec(argv: readonly string[], opts?: ExecOptions): Promise<ExecResult> {
    const command = argv.join(" ");
    this.commands.push(command);
    for (const fault of this.execFaults) {
      const error = fault(argv, opts);
      if (error) throw error;
    }
    for (const { re, script } of this.scripts) {
      if (!matches(command, re)) continue;
      const result = typeof script === "function" ? script(argv, opts) : script;
      if (result) return { ...ok(), ...result };
    }
    for (const handler of this.handlers) {
      const result = handler(argv, opts);
      if (result) return result;
    }
    return this.builtin(unwrapped(argv), opts);
  }

  /** The built-in model. Subclasses extend it; anything unmodelled exits 0 silently. */
  protected builtin(argv: readonly string[], _opts?: ExecOptions): ExecResult {
    const [bin, ...args] = argv;
    if (bin === "systemctl") return this.systemctl(args);
    return this.fileCommand(bin, args) ?? ok();
  }

  /**
   * The handful of coreutils spellings the files service drives as `hermes`
   * (`files/fs-ops.ts`): `install -d`, `mv -n -T`, `rm -f[r] --`, `chown`.
   * `null` for anything else, which falls through to "exited 0".
   *
   * `mv -n` onto an existing name skips silently and exits 0, as GNU coreutils
   * did for years — the worst case the caller has to detect for itself.
   */
  private fileCommand(bin: string | undefined, args: readonly string[]): ExecResult | null {
    // `test -L|-f|-d|-e <path>`: what the account sees. `-f`, `-d` and `-e`
    // follow a link, so a symlink with no seeded target answers no to them.
    // `PATH_KIND_SCRIPT` (`files/fs-ops.ts`): the same three answers, on stdout.
    // `RESOLVE_SCRIPT` (`files/fs-ops.ts`): `realpath -e` through `linkTargets`.
    if (bin === "sh" && args[0] === "-c" && args[1] === RESOLVE_SCRIPT) {
      const real = this.realpath(args[3] ?? "");
      if (real === null) return ok("missing\n");
      const file = this.files.get(real);
      if (!file) return ok("other\n");
      const size = file.bytes?.byteLength ?? new TextEncoder().encode(file.content).byteLength;
      return ok(`regular ${size}\n${real}\n`);
    }
    if (bin === "sh" && args[0] === "-c" && args[1] === PATH_KIND_SCRIPT) {
      const path = args[3] ?? "";
      if (this.symlinks.has(path)) return ok("other\n");
      if (this.files.has(path)) return ok("regular\n");
      if (this.dirs.has(path)) return ok("other\n");
      return ok("missing\n");
    }
    if (bin === "test" && args.length === 2) {
      const [flag, path = ""] = args;
      const yes =
        flag === "-L"
          ? this.symlinks.has(path)
          : flag === "-f"
            ? this.files.has(path)
            : flag === "-d"
              ? this.dirs.has(path)
              : flag === "-e"
                ? this.files.has(path) || this.dirs.has(path)
                : false;
      return yes ? ok() : fail(1);
    }
    if (bin === "install" && args[0] === "-d") {
      for (let i = 1; i < args.length; i += 1) {
        const arg = args[i] as string;
        if (arg === "-m" || arg === "-o" || arg === "-g") i += 1;
        else if (!arg.startsWith("-")) {
          this.markDirs(arg);
          this.dirs.add(arg);
        }
      }
      return ok();
    }
    if (bin === "mv" && args[0] === "-n" && args[1] === "-T") {
      const [from, to] = args.slice(2).filter((a) => a !== "--");
      if (from === undefined || to === undefined) return fail(1, "mv: missing operand");
      const file = this.files.get(from);
      if (!file) return fail(1, `mv: cannot stat '${from}': No such file or directory`);
      if (this.files.has(to) || this.dirs.has(to) || this.symlinks.has(to)) return ok();
      const slash = to.lastIndexOf("/");
      if (slash > 0 && !this.dirs.has(to.slice(0, slash))) {
        return fail(1, `mv: cannot move '${from}' to '${to}': No such file or directory`);
      }
      this.fsOps.push(`rename ${from} -> ${to}`);
      this.files.set(to, file);
      this.files.delete(from);
      return ok();
    }
    // `mv -f -T`: a rename over whatever file or symlink is at the target
    // (`apply/plugins.ts`); a directory there is refused, as `-T` does.
    if (bin === "mv" && args[0] === "-f" && args[1] === "-T") {
      const [from, to] = args.slice(2).filter((a) => a !== "--");
      if (from === undefined || to === undefined) return fail(1, "mv: missing operand");
      const file = this.files.get(from);
      if (!file) return fail(1, `mv: cannot stat '${from}': No such file or directory`);
      if (this.dirs.has(to)) return fail(1, `mv: cannot overwrite directory '${to}'`);
      this.fsOps.push(`rename ${from} -> ${to}`);
      this.symlinks.delete(to);
      this.files.set(to, file);
      this.files.delete(from);
      return ok();
    }
    if (bin === "rm" && (args[0] === "-f" || args[0] === "-rf") && args[1] === "--") {
      for (const path of args.slice(2)) {
        this.fsOps.push(`remove ${path}`);
        this.files.delete(path);
        if (args[0] === "-rf") {
          const prefix = `${path}/`;
          for (const key of [...this.files.keys()]) if (key.startsWith(prefix)) this.files.delete(key);
          for (const dir of [...this.dirs])
            if (dir === path || dir.startsWith(prefix)) this.dirs.delete(dir);
        }
      }
      return ok();
    }
    if (bin === "rmdir" && args[0] === "--") {
      const path = args[1] ?? "";
      const prefix = `${path}/`;
      const busy =
        [...this.files.keys()].some((k) => k.startsWith(prefix)) ||
        [...this.dirs].some((d) => d.startsWith(prefix));
      if (busy) return fail(1, `rmdir: failed to remove '${path}': Directory not empty`);
      this.dirs.delete(path);
      return ok();
    }
    if (bin === "chown") {
      const operands = args.filter((a) => !a.startsWith("-"));
      const [ownership, path] = operands;
      const file = path === undefined ? undefined : this.files.get(path);
      if (ownership && path && file) this.files.set(path, { ...file, ownership });
      return ok();
    }
    // `du -sk -- <dir>`: the tree's bytes in KiB, rounded up.
    if (bin === "du" && args[0] === "-sk" && args[1] === "--") {
      const path = args[2] ?? "";
      let bytes = 0;
      for (const [key, file] of this.files) {
        if (key === path || key.startsWith(`${path}/`)) {
          bytes += file.bytes?.byteLength ?? new TextEncoder().encode(file.content).byteLength;
        }
      }
      return ok(`${Math.ceil(bytes / 1024)}\t${path}\n`);
    }
    // `cp -a -- <dir> <new>`: the tree copied whole, modes and links kept.
    if (bin === "cp" && args[0] === "-a" && args[1] === "--") {
      const [from = "", to = ""] = args.slice(2);
      if (!this.dirs.has(from) && !this.files.has(from)) {
        return fail(1, `cp: cannot stat '${from}': No such file or directory`);
      }
      const moved = (key: string): string => to + key.slice(from.length);
      const under = (key: string): boolean => key === from || key.startsWith(`${from}/`);
      for (const [key, file] of [...this.files])
        if (under(key)) this.files.set(moved(key), { ...file });
      for (const dir of [...this.dirs]) if (under(dir)) this.dirs.add(moved(dir));
      for (const link of [...this.symlinks]) {
        if (!under(link)) continue;
        this.symlinks.add(moved(link));
        const target = this.linkTargets.get(link);
        if (target !== undefined) this.linkTargets.set(moved(link), target);
      }
      return ok();
    }
    return null;
  }

  private systemctl(args: readonly string[]): ExecResult {
    const [verb, ...rest] = args;
    const unit = rest.filter((a) => !a.startsWith("-"))[0] ?? "";
    if (verb === "--user" && rest.includes("stop")) {
      // A user manager down (`user@<uid>.service` in `downUnits`) has no bus to ask.
      if ([...this.downUnits].some((u) => u.startsWith("user@"))) {
        return fail(
          1,
          "Failed to connect to user scope bus via machine transport: No such file or directory",
        );
      }
      // As systemd: a glob matching nothing exits 0.
      const glob = new RegExp(
        `^${(rest.at(-1) ?? "")
          .split("*")
          .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*")}$`,
      );
      for (const scope of [...this.userScopes]) if (glob.test(scope)) this.userScopes.delete(scope);
      return ok();
    }
    switch (verb) {
      case "daemon-reload": {
        this.daemonReloads.push("daemon-reload");
        // Drop-ins are read here, as systemd reads them: only a reload sees a new one.
        this.startConditions.clear();
        for (const [file, { content }] of this.files) {
          const unit = /^\/etc\/systemd\/system\/([^/]+)\.d\/[^/]+\.conf$/.exec(file)?.[1];
          if (unit === undefined) continue;
          for (const m of content.matchAll(/^ConditionPathExists=!(\S+)$/gm)) {
            this.startConditions.set(unit, [...(this.startConditions.get(unit) ?? []), m[1] as string]);
          }
        }
        return ok();
      }
      case "is-enabled":
        if (this.enabledUnits.has(unit)) return ok("enabled\n");
        // As systemd does: a known unit answers its state on stdout and exits 1;
        // one it has never heard of says nothing there (`requireKnownUnit`).
        return this.unitIsKnown(unit)
          ? { code: 1, stdout: "disabled\n", stderr: "" }
          : fail(1, `Failed to get unit file state for ${unit}: No such file or directory`);
      case "cat":
        return this.unitIsKnown(unit)
          ? ok(this.files.get(`/etc/systemd/system/${unit}`)?.content ?? "")
          : fail(1, `No files found for ${unit}.`);
      case "enable":
        this.enabledUnits.add(unit);
        if (rest.includes("--now")) {
          this.restarted.push(unit);
          this.runningUnits.add(unit);
          this.downUnits.delete(unit);
        }
        return ok();
      case "disable":
        this.enabledUnits.delete(unit);
        if (rest.includes("--now")) {
          this.stopped.push(unit);
          this.runningUnits.delete(unit);
          if (this.modelsUnitState) this.downUnits.add(unit);
        }
        return ok();
      case "restart":
      case "start":
        // An unmet condition is not a failure: systemd skips the start and exits 0.
        if ((this.startConditions.get(unit) ?? []).some((p) => this.files.has(p))) {
          this.skippedStarts.push(unit);
          this.runningUnits.delete(unit);
          if (this.modelsUnitState) this.downUnits.add(unit);
          return ok();
        }
        this.restarted.push(unit);
        this.runningUnits.add(unit);
        this.downUnits.delete(unit);
        return ok();
      case "stop":
        this.stopped.push(unit);
        if (this.stuckUnits.has(unit)) return ok();
        this.runningUnits.delete(unit);
        if (this.modelsUnitState) this.downUnits.add(unit);
        return ok();
      case "show": {
        // The unit is the last operand: `-p <properties>` sits in the middle.
        const shown = rest.at(-1) ?? "";
        const recorded = this.unitStates.get(shown);
        // Stopped, or its last start skipped by a condition: systemd says so.
        const down =
          this.downUnits.has(shown) ||
          (this.skippedStarts.includes(shown) && !this.runningUnits.has(shown));
        const active =
          typeof recorded === "string"
            ? recorded
            : (recorded?.ActiveState ?? (down ? "inactive" : "active"));
        const sub =
          typeof recorded === "object"
            ? recorded.SubState
            : active === "activating"
              ? "start"
              : active === "active"
                ? "running"
                : "dead";
        return ok(`ActiveState=${active}\nSubState=${sub}\nNRestarts=0\n`);
      }
      case "is-active":
        return this.downUnits.has(unit)
          ? { code: 3, stdout: "inactive\n", stderr: "" }
          : ok("active\n");
      default:
        return ok();
    }
  }

  /**
   * Whether systemd on this box would know `unit`: a file under
   * `/etc/systemd/system`, its template (`xvfb@.service` for `xvfb@default.service`),
   * or the one package-provided unit a manifest lists (`nginx.service`).
   */
  protected unitIsKnown(unit: string): boolean {
    if (this.files.has(`/etc/systemd/system/${unit}`)) return true;
    const suffix = ".service";
    if (!unit.endsWith(suffix)) return false;
    const at = unit.lastIndexOf("@", unit.length - suffix.length - 2);
    if (at <= 0) return false;
    return this.files.has(`/etc/systemd/system/${unit.slice(0, at)}@.service`);
  }

  async *execLines(argv: readonly string[], opts?: ExecOptions): AsyncIterable<string> {
    const command = argv.join(" ");
    this.commands.push(command);
    let killed = false;
    const kill = (): void => {
      if (killed) return;
      killed = true;
      this.killedCommands.push(command);
    };
    opts?.signal?.addEventListener("abort", kill, { once: true });
    if (opts?.signal?.aborted) kill();
    try {
      for (const line of this.journalLines) yield line;
      const signal = opts?.signal;
      if (this.followsForever && signal && !killed) {
        await new Promise<void>((resolve) => {
          if (killed || signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    } finally {
      opts?.signal?.removeEventListener("abort", kill);
      kill();
    }
  }

  async *execEvents(argv: readonly string[], opts?: ExecOptions): AsyncIterable<ExecEvent> {
    this.streamed.push(argv.join(" "));
    this.streamedEnv.push({ ...(opts?.env ?? {}) });
    for (const fault of this.execFaults) {
      const error = fault(argv, opts);
      if (error) throw error;
    }
    let script: StreamScript | null = null;
    for (const handler of this.streamHandlers) {
      script = handler(argv, opts);
      if (script) break;
    }
    if (script?.before) await script.before(argv, opts);
    for (const line of script?.lines ?? []) yield { type: "line", ...line };
    yield { type: "exit", code: script?.code ?? 0 };
  }

  // --- filesystem --------------------------------------------------------------

  /**
   * Exclusive, like the real `set -C` create: anything at `path` — a file, a
   * directory, a symlink — refuses with `EEXIST` before a byte is written. The
   * file exists from the first chunk, so a fault mid-stream leaves the partial
   * behind for the caller to clean up, which is what the real one does.
   */
  async writeStreamAs(
    user: string,
    path: string,
    chunks: AsyncIterable<Uint8Array>,
    opts: { readonly mode: string },
  ): Promise<{ bytes: number }> {
    this.writeFault(path);
    this.requireParent(path);
    if (this.files.has(path) || this.dirs.has(path) || this.symlinks.has(path)) {
      throw Object.assign(new Error(`EEXIST: file already exists, open '${path}'`), { code: "EEXIST" });
    }
    const record = { user, path, mode: opts.mode, bytes: 0 };
    this.streamWrites.push(record);
    const parts: Uint8Array[] = [];
    const store = (): void => {
      const bytes = Buffer.concat(parts);
      const content = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      record.bytes = content.byteLength;
      this.files.set(path, {
        content: new TextDecoder().decode(content),
        bytes: content,
        mode: opts.mode,
        ownership: `${user}:${user}`,
      });
    };
    store();
    for await (const chunk of chunks) {
      parts.push(chunk);
      store();
      for (const fault of this.streamFaults) {
        const error = fault(path, record.bytes);
        if (error) throw error;
      }
    }
    return { bytes: record.bytes };
  }

  /**
   * Refuses a symlink or anything but a regular file, as `READ_STREAM_SCRIPT`
   * does. Pull-based, like a child's stdout: the bytes on the first pull, the
   * end on the next, so a reader nobody drains stays open — and a cancel
   * reaches it, recorded in `cancelledReads` as the real one kills its `cat`.
   */
  readStreamAs(user: string, path: string): ReadableStream<Uint8Array> {
    this.streamReads.push(`${user} ${path}`);
    const file = this.symlinks.has(path) ? undefined : this.files.get(path);
    const cancelled = this.cancelledReads;
    let sent = false;
    return new ReadableStream<Uint8Array>(
      {
        start(controller) {
          if (!file) {
            controller.error(
              Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
                code: "ENOENT",
              }),
            );
          }
        },
        pull(controller) {
          if (!file) return;
          if (sent) {
            controller.close();
            return;
          }
          sent = true;
          controller.enqueue(file.bytes ?? new TextEncoder().encode(file.content));
        },
        cancel() {
          cancelled.push(path);
        },
      },
      { highWaterMark: 0 },
    );
  }

  async readFile(path: string): Promise<string | null> {
    this.rootFs("readFile", path);
    return this.files.get(path)?.content ?? null;
  }

  async readBytes(path: string): Promise<Uint8Array | null> {
    this.rootFs("readBytes", path);
    const file = this.files.get(path);
    if (!file) return null;
    return file.bytes ?? new TextEncoder().encode(file.content);
  }

  /**
   * The real `writeAtomically` stages a sibling of the target with `O_CREAT`,
   * so a write into a directory nothing has created fails with `ENOENT` — on
   * the staged name, which is what the box reports. A fake that happily
   * invented the parent turned that into a silent pass, and a missing
   * `mkdir` before a first write is exactly the bug that only ever shows up
   * on a *fresh* box, where no earlier apply left the directory behind.
   */
  private requireParent(path: string): void {
    const slash = path.lastIndexOf("/");
    if (slash <= 0) return;
    const dir = path.slice(0, slash);
    if (this.dirs.has(dir)) return;
    throw Object.assign(
      new Error(`ENOENT: no such file or directory, open '${stagingPathFor(path)}'`),
      { code: "ENOENT", path },
    );
  }

  /** Keeps the previous mode *and* ownership, as the real staged-and-renamed write does. */
  async writeFile(path: string, content: string, mode?: string): Promise<void> {
    this.rootFs("writeFile", path);
    this.writeFault(path);
    this.requireParent(path);
    const existing = this.files.get(path);
    if (mode) this.chmods.push([path, mode]);
    this.files.set(path, {
      content,
      mode: mode ?? existing?.mode ?? "0644",
      ...(existing?.ownership ? { ownership: existing.ownership } : {}),
    });
    this.mtimes.set(path, this.clock.getTime());
  }

  async appendFile(path: string, content: string, mode?: string): Promise<void> {
    this.rootFs("appendFile", path);
    this.writeFault(path);
    const existing = this.files.get(path);
    if (mode) this.chmods.push([path, mode]);
    this.files.set(path, {
      content: (existing?.content ?? "") + content,
      mode: mode ?? existing?.mode ?? "0644",
    });
    // Appending nothing to a file that exists writes nothing, so its mtime stays, as on Linux.
    if (!existing || content !== "") this.mtimes.set(path, this.clock.getTime());
  }

  /** Direct children, files *and* directories; the latter inferred from deeper paths and `mkdir`. */
  async readdir(path: string): Promise<string[]> {
    this.rootFs("readdir", path);
    const prefix = path.endsWith("/") ? path : path + "/";
    const names = new Set<string>();
    for (const key of [...this.files.keys(), ...this.dirs]) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf("/");
      names.add(slash === -1 ? rest : rest.slice(0, slash));
    }
    names.delete("");
    return [...names].sort();
  }

  async writeBytes(path: string, content: Uint8Array, mode?: string): Promise<void> {
    this.rootFs("writeBytes", path);
    this.writeFault(path);
    this.requireParent(path);
    const existing = this.files.get(path);
    if (mode) this.chmods.push([path, mode]);
    this.files.set(path, {
      content: new TextDecoder().decode(content),
      mode: mode ?? existing?.mode ?? "0644",
      bytes: content,
      ...(existing?.ownership ? { ownership: existing.ownership } : {}),
    });
  }

  /** Every `writeChunks`: the path, and the size of each chunk it was handed. */
  readonly chunkWrites: Array<{ path: string; sizes: number[] }> = [];

  /** All or nothing, as on the real host: a `chunks` that throws stores nothing. */
  async writeChunks(path: string, chunks: AsyncIterable<Uint8Array>, mode?: string): Promise<void> {
    const record = { path, sizes: [] as number[] };
    this.chunkWrites.push(record);
    const parts: Uint8Array[] = [];
    for await (const chunk of chunks) {
      record.sizes.push(chunk.byteLength);
      parts.push(chunk);
    }
    await this.writeBytes(path, Buffer.concat(parts), mode);
  }

  async stat(path: string): Promise<FileStat | null> {
    this.rootFs("stat", path);
    return this.statOf(path);
  }

  /** `owner:group` names or ids → ids; root's when nothing set it. */
  private idsOf(ownership: string | undefined): { uid: number; gid: number } {
    const [owner = "root", group = owner] = (ownership ?? "root:root").split(":");
    return { uid: this.idOf(owner), gid: this.idOf(group) };
  }

  private idOf(name: string): number {
    if (/^\d+$/.test(name)) return Number(name);
    let id = this.userIds.get(name);
    if (id === undefined) {
      id = 2000 + this.userIds.size;
      this.userIds.set(name, id);
    }
    return id;
  }

  private nameOf(id: number): string {
    for (const [name, known] of this.userIds) if (known === id) return name;
    return String(id);
  }

  private statOf(path: string): FileStat | null {
    const dir = (mode: string, ownership?: string): FileStat => ({
      mode,
      size: 0,
      isDirectory: true,
      isSymlink: false,
      isFile: false,
      ...this.idsOf(ownership),
    });
    // `/proc` is how the installation lock asks whether its holder is still there.
    const pid = /^\/proc\/(\d+)$/.exec(path);
    if (pid !== null) return this.livePids.has(Number(pid[1])) ? dir("0555") : null;
    if (path === "/proc") return dir("0555");
    const file = this.files.get(path);
    if (file) {
      return {
        mode: file.mode,
        size: file.bytes?.byteLength ?? new TextEncoder().encode(file.content).byteLength,
        isDirectory: false,
        isSymlink: false,
        isFile: true,
        ...this.idsOf(file.ownership),
        ...(this.mtimes.has(path) ? { mtimeMs: this.mtimes.get(path) } : {}),
      };
    }
    if (this.dirs.has(path)) {
      const attrs = this.dirAttrs.get(path);
      return dir(attrs?.mode ?? "0755", attrs?.ownership);
    }
    return null;
  }

  async lstat(path: string): Promise<FileStat | null> {
    this.rootFs("lstat", path);
    if (this.symlinks.has(path)) {
      return {
        mode: "0777",
        size: 0,
        isDirectory: false,
        isSymlink: true,
        isFile: false,
        uid: 0,
        gid: 0,
      };
    }
    return this.statOf(path);
  }

  async chmod(path: string, mode: string): Promise<void> {
    this.rootFs("chmod", path);
    this.chmods.push([path, mode]);
    const file = this.files.get(path);
    if (file) this.files.set(path, { ...file, mode });
    else if (this.dirs.has(path)) this.dirAttrs.set(path, { ...this.dirAttrs.get(path), mode });
  }

  async chown(path: string, uid: number, gid: number): Promise<void> {
    this.rootFs("chown", path);
    const ownership = `${this.nameOf(uid)}:${this.nameOf(gid)}`;
    const file = this.files.get(path);
    if (file) this.files.set(path, { ...file, ownership });
    else if (this.dirs.has(path)) this.dirAttrs.set(path, { ...this.dirAttrs.get(path), ownership });
    else
      throw Object.assign(new Error(`ENOENT: no such file or directory, lchown '${path}'`), {
        code: "ENOENT",
      });
  }

  /** Refuses a symlink or non-file at `from` and anything at `to`; the copy is root's, 0600. */
  async copyFile(from: string, to: string): Promise<void> {
    this.rootFs("copyFile", from);
    this.writeFault(to);
    if (this.symlinks.has(from)) {
      throw Object.assign(new Error(`ELOOP: too many symbolic links, open '${from}'`), {
        code: "ELOOP",
      });
    }
    const file = this.files.get(from);
    if (!file) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${from}'`), {
        code: "ENOENT",
      });
    }
    this.requireParent(to);
    if (this.files.has(to) || this.dirs.has(to) || this.symlinks.has(to)) {
      throw Object.assign(new Error(`EEXIST: file already exists, open '${to}'`), { code: "EEXIST" });
    }
    let bytes = file.bytes ?? new TextEncoder().encode(file.content);
    for (const corrupt of this.copyCorruptions) bytes = corrupt(from, to, bytes);
    this.files.set(to, { content: new TextDecoder().decode(bytes), bytes, mode: "0600" });
  }

  async readPrefix(path: string, length: number): Promise<Uint8Array | null> {
    this.rootFs("readPrefix", path);
    if (this.symlinks.has(path)) {
      throw Object.assign(new Error(`ELOOP: too many symbolic links, open '${path}'`), {
        code: "ELOOP",
      });
    }
    const file = this.files.get(path);
    if (!file) return null;
    return (file.bytes ?? new TextEncoder().encode(file.content)).slice(0, length);
  }

  // Recursive, like the real one: `mkdir -p /a/b/c` leaves `/a` and `/a/b` as
  // directories too, and a fake that only remembered the leaf would call a
  // write into `/a/b` parentless. The mode lands on every directory it creates.
  async mkdir(path: string, mode?: string): Promise<void> {
    this.rootFs("mkdir", path);
    const created = [...this.ancestorsOf(path), path].filter((d) => !this.dirs.has(d));
    this.markDirs(path);
    this.dirs.add(path);
    if (mode) for (const d of created) this.dirAttrs.set(d, { mode });
  }

  private ancestorsOf(path: string): string[] {
    const out: string[] = [];
    for (let slash = path.indexOf("/", 1); slash !== -1; slash = path.indexOf("/", slash + 1)) {
      out.push(path.slice(0, slash));
    }
    return out;
  }

  /**
   * Throws on a missing source, like the real one: silently doing nothing
   * would hide a bug. A directory moves with everything under it; it may
   * replace only an empty directory, and a file never replaces a directory.
   */
  async rename(path: string, to: string): Promise<void> {
    this.rootFs("rename", path);
    this.fault("rename", path, to);
    const errno = (code: string): Error =>
      Object.assign(new Error(`${code}: rename '${path}' -> '${to}'`), { code });
    const file = this.files.get(path);
    if (!file && !this.dirs.has(path)) throw errno("ENOENT");
    if (this.dirs.has(to) && (file || this.hasChildren(to))) throw errno(file ? "EISDIR" : "ENOTEMPTY");
    if (!file && this.files.has(to)) throw errno("ENOTDIR");
    this.requireParent(to);
    this.fsOps.push(`rename ${path} -> ${to}`);
    if (file) {
      this.files.set(to, file);
      this.files.delete(path);
      return;
    }
    const prefix = `${path}/`;
    const moved = (key: string): string => to + key.slice(path.length);
    for (const key of [...this.files.keys()].filter((k) => k.startsWith(prefix))) {
      this.files.set(moved(key), this.files.get(key) as FakeFile);
      this.files.delete(key);
    }
    for (const dir of [...this.dirs].filter((d) => d === path || d.startsWith(prefix))) {
      this.dirs.delete(dir);
      this.dirs.add(moved(dir));
      const attrs = this.dirAttrs.get(dir);
      this.dirAttrs.delete(dir);
      if (attrs) this.dirAttrs.set(moved(dir), attrs);
    }
    for (const link of [...this.symlinks].filter((l) => l.startsWith(prefix))) {
      this.symlinks.delete(link);
      this.symlinks.add(moved(link));
      const target = this.linkTargets.get(link);
      this.linkTargets.delete(link);
      if (target !== undefined) this.linkTargets.set(moved(link), target);
    }
  }

  private hasChildren(dir: string): boolean {
    const prefix = `${dir}/`;
    return [...this.files.keys(), ...this.dirs, ...this.symlinks].some((k) => k.startsWith(prefix));
  }

  /** A hard link, modelled as a copy: the *source* is still there afterwards (§6.5). */
  async link(path: string, to: string): Promise<void> {
    this.rootFs("link", path);
    this.fault("link", path, to);
    const file = this.files.get(path);
    if (!file) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, link '${path}' -> '${to}'`), {
        code: "ENOENT",
      });
    }
    if (this.files.has(to)) {
      throw Object.assign(new Error(`EEXIST: file already exists, link '${path}' -> '${to}'`), {
        code: "EEXIST",
      });
    }
    this.fsOps.push(`link ${path} -> ${to}`);
    this.files.set(to, { ...file });
  }

  private writeFault(path: string): void {
    for (const hook of this.writeFaults) {
      const error = hook(path);
      if (error) throw error;
    }
  }

  private fault(op: "rename" | "link" | "remove", path: string, to?: string): void {
    for (const hook of this.fsFaults) {
      const error = hook(op, path, to);
      if (error) throw error;
    }
  }

  async remove(path: string): Promise<void> {
    this.rootFs("remove", path);
    this.fault("remove", path);
    this.fsOps.push(`remove ${path}`);
    this.files.delete(path);
    // Recursive, like the real host: a directory goes with its contents, a
    // symlink goes itself and its target stays.
    const prefix = path.endsWith("/") ? path : path + "/";
    for (const key of [...this.files.keys()]) if (key.startsWith(prefix)) this.files.delete(key);
    for (const dir of [...this.dirs]) {
      if (dir !== path && !dir.startsWith(prefix)) continue;
      this.dirs.delete(dir);
      this.dirAttrs.delete(dir);
    }
    for (const link of [...this.symlinks]) {
      if (link !== path && !link.startsWith(prefix)) continue;
      this.symlinks.delete(link);
      this.linkTargets.delete(link);
    }
  }

  async sha256File(path: string): Promise<string | null> {
    const bytes = await this.readBytes(path);
    if (bytes === null) return null;
    return createHash("sha256").update(bytes).digest("hex");
  }

  async cpuLoad(): Promise<number | null> {
    this.cpuLoadCalls += 1;
    return this.cpuLoadPct;
  }

  async memory(): Promise<MemorySample | null> {
    return this.memorySample;
  }

  async filesystem(path: string): Promise<FilesystemSample | null> {
    return this.filesystemByPath.has(path)
      ? (this.filesystemByPath.get(path) ?? null)
      : this.filesystemResult;
  }
}
