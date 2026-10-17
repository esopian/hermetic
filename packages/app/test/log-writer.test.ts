/**
 * `log-writer.ts` and the async half of `log.ts`: a line is queued, not written
 * on the caller's stack; a burst is one write; order holds across levels; the
 * queue is bounded; and what is queued reaches the file on shutdown, at exit
 * and after the file or its directory was removed.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LogSink } from "../src/log-writer.ts";
import { type AppLog, installLogCrashFlush, createAppLog, logPathFor } from "../src/log.ts";
import { shutdown } from "../src/shutdown.ts";
import { testHome } from "./home.ts";

const quiet = (): void => {};
const read = (home: string): string => readFileSync(join(home, "app.log"), "utf8");

/** A sink recording every batch; `stall()` holds the next append until `release()`. */
function recordingSink(): LogSink & {
  batches: string[];
  sync: string[];
  stall(): void;
  release(): void;
} {
  const batches: string[] = [];
  const sync: string[] = [];
  let gate: Promise<void> | null = null;
  let open: (() => void) | null = null;
  return {
    batches,
    sync,
    stall() {
      gate = new Promise((r) => {
        open = r;
      });
    },
    release() {
      open?.();
      gate = null;
    },
    async append(text) {
      batches.push(text);
      await gate;
    },
    appendSync(text) {
      sync.push(text);
    },
    async close() {},
  };
}

describe("the async log file", () => {
  test("a line is not on disk when line() returns, and is after flush()", async () => {
    const home = testHome("hermetic-logw-");
    const log = createAppLog({ home, fixture: false, stderr: quiet });
    log.line("info", "app", "first");
    expect(existsSync(join(home, "app.log"))).toBe(false);
    await log.flush();
    expect(read(home)).toContain("first");
    await log.close();
  });

  test("lines keep their order across levels, and the timer flushes without flush()", async () => {
    const home = testHome("hermetic-logw-");
    const log = createAppLog({
      home,
      fixture: false,
      stderrLevel: "error",
      stderr: quiet,
      writer: { flushMs: 5 },
    });
    for (let i = 0; i < 40; i++) {
      log.line((["debug", "info", "warn", "error"] as const)[i % 4] ?? "info", "t", `n${i}`);
    }
    await Bun.sleep(80);
    const seen = [...read(home).matchAll(/ t n(\d+)\n/g)].map((m) => Number(m[1]));
    expect(seen).toEqual(Array.from({ length: 40 }, (_, i) => i));
    await log.close();
  });

  test("a burst becomes few writes", async () => {
    const sink = recordingSink();
    const home = testHome("hermetic-logw-");
    const log = createAppLog({ home, fixture: false, stderr: quiet, sink });
    for (let i = 0; i < 500; i++) log.line("debug", "burst", `line ${i}`);
    await log.flush();
    expect(sink.batches.length).toBeLessThanOrEqual(2);
    expect(sink.batches.join("").split("\n").filter(Boolean)).toHaveLength(500);
  });

  test("a queue past the size threshold flushes without waiting for the timer", async () => {
    const sink = recordingSink();
    const home = testHome("hermetic-logw-");
    const log = createAppLog({
      home,
      fixture: false,
      stderr: quiet,
      sink,
      writer: { flushMs: 60_000, flushBytes: 200 },
    });
    for (let i = 0; i < 10; i++) log.line("info", "big", `line ${i}`);
    await Promise.resolve();
    expect(sink.batches.length).toBeGreaterThan(0);
  });

  test("flush() on shutdown writes the lines the teardown logged", async () => {
    const home = testHome("hermetic-logw-");
    const log = createAppLog({
      home,
      fixture: false,
      stderr: quiet,
      writer: { flushMs: 60_000 },
    });
    log.line("info", "app", "before quit");
    await shutdown({ server: { stop: () => {} }, log }, "SIGTERM");
    const text = read(home);
    expect(text).toContain("before quit");
    expect(text).toContain("shutting down (SIGTERM)");
    await log.close();
  });

  test("flushSync() writes the queue without a turn of the event loop", () => {
    const home = testHome("hermetic-logw-");
    const log = createAppLog({ home, fixture: false, stderr: quiet, writer: { flushMs: 60_000 } });
    log.line("info", "app", "one");
    log.line("error", "app", "two");
    log.flushSync();
    const text = read(home);
    expect(text.indexOf(" one\n")).toBeGreaterThan(-1);
    expect(text.indexOf(" two\n")).toBeGreaterThan(text.indexOf(" one\n"));
  });

  test("the exit and crash hooks flush synchronously", () => {
    const home = testHome("hermetic-logw-");
    const log = createAppLog({ home, fixture: false, stderr: quiet, writer: { flushMs: 60_000 } });
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const remove = installLogCrashFlush(log, {
      on: (event: string, h: (...args: never[]) => void) => {
        handlers.set(event, h as (...args: unknown[]) => void);
        return process;
      },
      off: () => process,
    } as unknown as Pick<NodeJS.Process, "on" | "off">);
    log.line("info", "app", "queued at exit");
    handlers.get("exit")?.();
    expect(read(home)).toContain("queued at exit");

    log.line("info", "app", "queued at crash");
    handlers.get("uncaughtExceptionMonitor")?.(new Error("kaboom"), "uncaughtException");
    const text = read(home);
    expect(text).toContain("queued at crash");
    expect(text).toContain("ERROR process uncaughtException: Error: kaboom");
    handlers.get("unhandledRejection")?.(new Error("late"));
    remove();
  });

  test("a stalled disk bounds the queue: oldest DEBUG first, drops counted in a later line", async () => {
    const sink = recordingSink();
    const home = testHome("hermetic-logw-");
    const log = createAppLog({
      home,
      fixture: false,
      stderr: quiet,
      sink,
      writer: { flushMs: 1, flushBytes: 1, maxQueueBytes: 2_000 },
    });
    sink.stall();
    log.line("info", "keep", "first batch, now stuck in flight");
    await Bun.sleep(10);
    log.line("error", "keep", "important-early");
    for (let i = 0; i < 400; i++) log.line("debug", "noise", `debug-${i}`);
    log.line("error", "keep", "important-late");
    sink.release();
    await log.flush();
    const text = sink.batches.join("");
    expect(text).toContain("important-early");
    expect(text).toContain("important-late");
    expect(text).toContain("debug-399");
    expect(text).not.toContain("debug-0\n");
    const notice = text.match(/WARN {2}log queue full: older lines dropped dropped=(\d+)/);
    expect(notice).not.toBeNull();
    expect(Number(notice?.[1])).toBeGreaterThan(100);
    // Order of what survived is the order written.
    expect(text.indexOf("important-early")).toBeLessThan(text.indexOf("important-late"));
    expect(sink.batches.join("").length).toBeLessThan(6_000);
  });

  test("a deleted file is recreated by the next flush", async () => {
    const home = testHome("hermetic-logw-");
    const log = createAppLog({ home, fixture: false, stderr: quiet });
    log.line("info", "app", "before");
    await log.flush();
    rmSync(join(home, "app.log"));
    log.line("info", "app", "after");
    await log.flush();
    const text = read(home);
    expect(text).toContain("after");
    expect(text).not.toContain("before");
    await log.close();
  });

  test("a deleted directory is recreated, owner-only", async () => {
    const home = join(testHome("hermetic-logw-"), "nested", "home");
    const log = createAppLog({ home, fixture: false, stderr: quiet });
    log.line("info", "app", "before");
    await log.flush();
    rmSync(home, { recursive: true });
    log.line("info", "app", "after");
    await log.flush();
    expect(read(home)).toContain("after");
    log.line("info", "app", "again");
    log.flushSync();
    rmSync(home, { recursive: true });
    log.line("info", "app", "sync after removal");
    log.flushSync();
    expect(read(home)).toContain("sync after removal");
    await log.close();
  });

  test("rotation by rename starts a fresh file at the same path", async () => {
    const home = testHome("hermetic-logw-");
    const log = createAppLog({ home, fixture: false, stderr: quiet });
    log.line("info", "app", "old era");
    await log.flush();
    const path = logPathFor(home, false) as string;
    writeFileSync(`${path}.1`, readFileSync(path));
    rmSync(path);
    log.line("info", "app", "new era");
    await log.flush();
    expect(read(home)).not.toContain("old era");
    expect(read(home)).toContain("new era");
    expect(readFileSync(`${path}.1`, "utf8")).toContain("old era");
    await log.close();
  });

  test("a sink that fails silences the file half and never throws", async () => {
    const home = testHome("hermetic-logw-");
    const log: AppLog = createAppLog({
      home,
      fixture: false,
      stderr: quiet,
      sink: {
        append: () => Promise.reject(new Error("disk gone")),
        appendSync: () => {
          throw new Error("disk gone");
        },
        close: async () => {},
      },
    });
    log.line("info", "app", "x");
    await log.flush();
    expect(log.path).toBeNull();
    expect(() => log.line("info", "app", "y")).not.toThrow();
    expect(() => log.flushSync()).not.toThrow();
  });
});
