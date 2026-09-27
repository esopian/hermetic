/**
 * `log.ts`: the app's stderr + file log. What an operator (or an agent
 * debugging the stack from another shell) can see when an op or a request
 * fails, with no window attached to watch it happen.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HermeticError } from "@hermetic/core";
import { refusalFor } from "../src/rpc/bind.ts";
import {
  LOG_DIR_MODE,
  LOG_FILE_MODE,
  createAppLog,
  formatLine,
  logPathFor,
  memoryLog,
} from "../src/log.ts";
import { OpRegistry } from "../src/ops.ts";

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the app log", () => {
  test("one line per entry: time, level, scope, message, fields", () => {
    const line = formatLine(
      "error",
      "op:init",
      "error INTERNAL: boom",
      { op: "abc", target: null },
      new Date(0),
    );
    expect(line).toBe('1970-01-01T00:00:00.000Z ERROR op:init error INTERNAL: boom op="abc"\n');
  });

  test("writes to stderr at info and above, and everything to the file", () => {
    const home = mkdtempSync(join(tmpdir(), "hermetic-log-"));
    tmp.push(home);
    const stderr: string[] = [];
    const log = createAppLog({ home, fixture: false, stderr: (t) => stderr.push(t) });
    log.line("debug", "op:x", "phase: quiet");
    log.line("info", "portal", "listening");
    log.line("error", "op:x", "error INTERNAL: could not create the hermetic stack");
    expect(stderr.join("")).not.toContain("quiet");
    expect(stderr.join("")).toContain("listening");
    expect(stderr.join("")).toContain("could not create the hermetic stack");
    const file = readFileSync(logPathFor(home, false)!, "utf8");
    expect(file).toContain("quiet");
    expect(file).toContain("could not create the hermetic stack");
    expect(log.path).toBe(join(home, "app.log"));
  });

  test("fixture mode keeps its own file, ~ is expanded, and :memory: is not a path", () => {
    expect(logPathFor("/x", true)).toBe("/x/app-fixture.log");
    expect(logPathFor("~/.hermetic", false)!.startsWith("/")).toBe(true);
    expect(logPathFor("~/.hermetic", false)).not.toContain("~");
    // What fixture `AppState` reports as its home; a file there would land
    // in a `:memory:/` directory under the cwd.
    expect(logPathFor(":memory:", true)).toBeNull();
    const log = createAppLog({ home: ":memory:", fixture: true, stderr: () => {} });
    log.line("info", "portal", "listening");
    expect(log.path).toBeNull();
    expect(existsSync(":memory:")).toBe(false);
  });

  test("an unwritable home silences the file half without throwing", () => {
    const home = mkdtempSync(join(tmpdir(), "hermetic-log-"));
    tmp.push(home);
    // A *file* where the home directory should be: mkdir and append both fail.
    const blocker = join(home, "not-a-dir");
    writeFileSync(blocker, "");
    const log = createAppLog({ home: blocker, fixture: false, stderr: () => {} });
    expect(() => log.line("info", "portal", "listening")).not.toThrow();
    expect(log.path).toBeNull();
    expect(existsSync(join(blocker, "app.log"))).toBe(false);
  });

  /** The report this whole file exists for: "init failed and the terminal shows nothing". */
  test("a failing op lands in the log with its code and core's message", async () => {
    const log = memoryLog();
    const ops = new OpRegistry({ log });
    async function* run() {
      yield { phase: "identity", progress: 0.1, message: "account 123", at: new Date().toISOString() };
      yield {
        phase: "preflight",
        progress: 0.2,
        message: "tailscale ok",
        level: "warn" as const,
        at: new Date().toISOString(),
      };
      throw new HermeticError(
        "INTERNAL",
        "could not create the hermetic stack: Template error: bad Fn::Sub",
      );
    }
    const op = ops.start("init", null, () => run());
    await ops.wait(op.id);
    const text = log.lines.join("");
    expect(text).toContain(`INFO  op:init started op="${op.id}"`);
    expect(text).toContain("DEBUG op:init identity: account 123");
    expect(text).toContain("WARN  op:init preflight: tailscale ok");
    expect(text).toContain(
      "ERROR op:init error INTERNAL: could not create the hermetic stack: Template error: bad Fn::Sub",
    );
  });

  test("an op that ends well says so once", async () => {
    const log = memoryLog();
    const ops = new OpRegistry({ log });
    async function* run() {
      yield { phase: "done", progress: 1, message: "fine", at: new Date().toISOString() };
    }
    const op = ops.start("agents.create", "alpha", () => run());
    await ops.wait(op.id);
    expect(log.lines.filter((l) => l.includes(" ok ")).length).toBe(1);
    expect(log.lines.join("")).toContain('target="alpha"');
  });

  test("an unclassified error keeps its stack, at debug", async () => {
    const log = memoryLog();
    const ops = new OpRegistry({ log });
    // biome-ignore lint/correctness/useYield: a test double for a long op that fails before its first event.
    async function* run(): AsyncGenerator<never> {
      throw new TypeError("undefined is not a function");
    }
    const op = ops.start("doctor", null, () => run());
    await ops.wait(op.id);
    const text = log.lines.join("");
    expect(text).toContain("ERROR op:doctor error INTERNAL: undefined is not a function");
    expect(text).toMatch(/DEBUG op:doctor TypeError: undefined is not a function\n\s+at /);
  });

  /**
   * The binding's own half of the rule, as `rpc/bind.ts` applies it: a refusal
   * the caller can act on is a `debug` line carrying core's own sentence, and
   * an unclassified one is an `error` line carrying the truth the caller was
   * not given (`errors.ts`).
   */
  test("a failed request is logged with the same code the caller got", () => {
    const log = memoryLog();
    for (const [name, thrown] of [
      ["agents.get", new HermeticError("NOT_FOUND", "no such agent")],
      ["agents.list", new Error("nope")],
    ] as const) {
      const { refusal, internal } = refusalFor(thrown);
      log.line(internal === undefined ? "debug" : "error", "rpc", `${name} refused`, {
        code: refusal.body.code,
        message: internal ?? refusal.body.message,
      });
    }
    expect(log.lines[0]).toContain(
      'DEBUG rpc agents.get refused code="NOT_FOUND" message="no such agent"',
    );
    expect(log.lines[1]).toMatch(/ERROR rpc agents.list refused code="INTERNAL" message="nope"/);
  });

  describe("permissions", () => {
    const modeOf = (path: string): number => statSync(path).mode & 0o777;

    test("a directory the log creates is owner-only, and so is the file", () => {
      const root = mkdtempSync(join(tmpdir(), "hermetic-log-"));
      tmp.push(root);
      const home = join(root, "fresh", "home");
      const log = createAppLog({ home, fixture: false, stderr: () => {} });
      log.line("info", "app", "starting");
      expect(modeOf(home)).toBe(LOG_DIR_MODE);
      expect(modeOf(join(home, "app.log"))).toBe(LOG_FILE_MODE);
      expect(LOG_DIR_MODE).toBe(0o700);
      expect(LOG_FILE_MODE).toBe(0o600);
    });

    test("a log left world-readable by an older build is tightened on the first write", () => {
      const home = mkdtempSync(join(tmpdir(), "hermetic-log-"));
      tmp.push(home);
      const file = join(home, "app.log");
      writeFileSync(file, "old line\n");
      chmodSync(file, 0o644);
      const log = createAppLog({ home, fixture: false, stderr: () => {} });
      log.line("info", "app", "starting");
      expect(modeOf(file)).toBe(LOG_FILE_MODE);
      expect(readFileSync(file, "utf8")).toStartWith("old line\n");
    });

    test("an existing home keeps the mode the operator gave it", () => {
      const home = mkdtempSync(join(tmpdir(), "hermetic-log-"));
      tmp.push(home);
      chmodSync(home, 0o755);
      createAppLog({ home, fixture: false, stderr: () => {} }).line("info", "app", "starting");
      expect(modeOf(home)).toBe(0o755);
    });
  });
});
