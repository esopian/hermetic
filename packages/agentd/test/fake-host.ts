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
import type { ExecEvent, ExecOptions, ExecResult, FileStat, Host, StatfsResult } from "../src/host.ts";
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
  /** `[path, mode]` for every chmod, including ones on directories. */
  readonly chmods: Array<[string, string]> = [];

  // systemd, as far as `systemctl` moves it.
  readonly enabledUnits = new Set<string>();
  /** Every `systemctl start|restart`, and every `enable --now`, in order. */
  readonly restarted: string[] = [];
  /** Every `systemctl stop`, and every `disable --now`, in order. */
  readonly stopped: string[] = [];
  /** Units up as far as `start|restart|stop` says; `is-active` never reads it. */
  readonly runningUnits = new Set<string>();
  /** What `systemctl show` reports; no entry answers `active (running)`. */
  readonly unitStates = new Map<string, string | { ActiveState: string; SubState: string }>();
  readonly daemonReloads: string[] = [];

  /** The pids `/proc` has a directory for. Empty by default: a stale lock is litter. */
  readonly livePids = new Set<number>();
  /** Paths this box treats as symlinks. `lstat` is the only thing that sees them. */
  readonly symlinks = new Set<string>();
  /** The fleet bucket: key → bytes. `getObject` is the `ObjectFetch` a test hands to `apply`. */
  readonly s3Objects = new Map<string, Uint8Array>();
  getObject = async (bucket: string, key: string): Promise<Uint8Array> => {
    this.commands.push(`s3:GetObject ${bucket} ${key}`);
    const bytes = this.s3Objects.get(key);
    if (!bytes) throw new Error(`AccessDenied: not authorized to perform s3:GetObject on ${key}`);
    return bytes;
  };
  /** The answer for any path with no entry in `statfsByPath`. */
  statfsResult: StatfsResult | null = { blockSize: 4096, blocks: 1_000_000, available: 800_000 };
  /** Per-mount answers, consulted first; a `null` value is "statvfs failed here". */
  readonly statfsByPath = new Map<string, StatfsResult | null>();
  clock = new Date("2026-09-01T12:00:00.000Z");
  sleeps: number[] = [];
  journalLines: string[] = [];
  /** When set, `execLines` parks after its lines until the command is killed. */
  followsForever = false;
  /** Every `execLines` argv whose child was killed, joined with spaces. */
  readonly killedCommands: string[] = [];

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
  }

  /** `seed` for the byte-shaped ones: a half-downloaded zip a killed apply left. */
  seedBytes(path: string, content: Uint8Array, mode = "0644"): void {
    this.markDirs(path);
    this.files.set(path, { content: new TextDecoder().decode(content), bytes: content, mode });
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
    return bin === "systemctl" ? this.systemctl(args) : ok();
  }

  private systemctl(args: readonly string[]): ExecResult {
    const [verb, ...rest] = args;
    const unit = rest.filter((a) => !a.startsWith("-"))[0] ?? "";
    switch (verb) {
      case "daemon-reload":
        this.daemonReloads.push("daemon-reload");
        return ok();
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
        }
        return ok();
      case "disable":
        this.enabledUnits.delete(unit);
        if (rest.includes("--now")) {
          this.stopped.push(unit);
          this.runningUnits.delete(unit);
        }
        return ok();
      case "restart":
      case "start":
        this.restarted.push(unit);
        this.runningUnits.add(unit);
        return ok();
      case "stop":
        this.stopped.push(unit);
        this.runningUnits.delete(unit);
        return ok();
      case "show": {
        // The unit is the last operand: `-p <properties>` sits in the middle.
        const recorded = this.unitStates.get(rest.at(-1) ?? "");
        const active = typeof recorded === "string" ? recorded : (recorded?.ActiveState ?? "active");
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
        return ok("active\n");
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
    const template = /^(.+)@.+\.service$/.exec(unit)?.[1];
    return template !== undefined && this.files.has(`/etc/systemd/system/${template}@.service`);
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

  async readFile(path: string): Promise<string | null> {
    return this.files.get(path)?.content ?? null;
  }

  async readBytes(path: string): Promise<Uint8Array | null> {
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
    this.writeFault(path);
    this.requireParent(path);
    const existing = this.files.get(path);
    if (mode) this.chmods.push([path, mode]);
    this.files.set(path, {
      content,
      mode: mode ?? existing?.mode ?? "0644",
      ...(existing?.ownership ? { ownership: existing.ownership } : {}),
    });
  }

  async appendFile(path: string, content: string, mode?: string): Promise<void> {
    const existing = this.files.get(path);
    if (mode) this.chmods.push([path, mode]);
    this.files.set(path, {
      content: (existing?.content ?? "") + content,
      mode: mode ?? existing?.mode ?? "0644",
    });
  }

  /** Direct children, files *and* directories; the latter inferred from deeper paths and `mkdir`. */
  async readdir(path: string): Promise<string[]> {
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

  async stat(path: string): Promise<FileStat | null> {
    // `/proc` is how the installation lock asks whether its holder is still there.
    const pid = /^\/proc\/(\d+)$/.exec(path);
    if (pid !== null) {
      return this.livePids.has(Number(pid[1]))
        ? { mode: "0555", size: 0, isDirectory: true, isSymlink: false }
        : null;
    }
    if (path === "/proc") return { mode: "0555", size: 0, isDirectory: true, isSymlink: false };
    const file = this.files.get(path);
    if (file)
      return { mode: file.mode, size: file.content.length, isDirectory: false, isSymlink: false };
    if (this.dirs.has(path)) return { mode: "0755", size: 0, isDirectory: true, isSymlink: false };
    return null;
  }

  async lstat(path: string): Promise<FileStat | null> {
    const stat = await this.stat(path);
    if (stat === null) return null;
    return { ...stat, isSymlink: this.symlinks.has(path) };
  }

  async chmod(path: string, mode: string): Promise<void> {
    this.chmods.push([path, mode]);
    const file = this.files.get(path);
    if (file) this.files.set(path, { ...file, mode });
  }

  // Recursive, like the real one: `mkdir -p /a/b/c` leaves `/a` and `/a/b` as
  // directories too, and a fake that only remembered the leaf would call a
  // write into `/a/b` parentless.
  async mkdir(path: string, _mode?: string): Promise<void> {
    this.markDirs(path);
    this.dirs.add(path);
  }

  // Throws on a missing source, like the real one: silently doing nothing would hide a bug.
  async rename(path: string, to: string): Promise<void> {
    this.fault("rename", path, to);
    const file = this.files.get(path);
    if (!file) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, rename '${path}' -> '${to}'`), {
        code: "ENOENT",
      });
    }
    this.fsOps.push(`rename ${path} -> ${to}`);
    this.files.set(to, file);
    this.files.delete(path);
  }

  /** A hard link, modelled as a copy: the *source* is still there afterwards (§6.5). */
  async link(path: string, to: string): Promise<void> {
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
    this.fault("remove", path);
    this.fsOps.push(`remove ${path}`);
    this.files.delete(path);
    // Recursive, like the real host: a directory goes with its contents.
    const prefix = path.endsWith("/") ? path : path + "/";
    for (const key of [...this.files.keys()]) if (key.startsWith(prefix)) this.files.delete(key);
    this.dirs.delete(path);
  }

  async sha256File(path: string): Promise<string | null> {
    const bytes = await this.readBytes(path);
    if (bytes === null) return null;
    return createHash("sha256").update(bytes).digest("hex");
  }

  async statfs(path: string): Promise<StatfsResult | null> {
    return this.statfsByPath.has(path) ? (this.statfsByPath.get(path) ?? null) : this.statfsResult;
  }
}
