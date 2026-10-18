/**
 * The app's log: one line per thing worth knowing about the running head,
 * written to stderr *and* appended to `<home>/app.log` (`app-fixture.log` in
 * fixture mode), so a window that has been closed, a reload, or an agent
 * debugging the stack from another shell can all `tail -f` the same file. Core
 * never logs (§3.2 rule 1); this is head-side bookkeeping over what core
 * already reports — op starts and outcomes, every op event at `debug` (file
 * only), and every request that ended in an error.
 *
 * §8.3 holds here as it does everywhere: op events carry phases and messages
 * and never values, op inputs reach the log only after `redactInitInput` and
 * friends, and error messages are core's own, which are written to be shown.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { type LogSink, type LogWriterOptions, createLogWriter, fileSink } from "./log-writer.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface AppLog {
  /** Where the file half of this log lives; printed at boot so it can be tailed. */
  readonly path: string | null;
  /**
   * Queues the line for the file (written within a few milliseconds, in order)
   * and writes it to stderr now when `level` reaches `stderrLevel`.
   */
  line(level: LogLevel, scope: string, message: string, fields?: Record<string, unknown>): void;
  /** Resolves once every line logged before the call has reached the file. */
  flush(): Promise<void>;
  /**
   * Synchronous flush for `process.on("exit")` and a crash, where nothing can
   * be awaited. Also covers a batch whose async write may not have landed.
   */
  flushSync(): void;
  /** Flushes, then releases the file handle. A later line reopens it. */
  close(): Promise<void>;
}

export interface AppLogOptions {
  /** `HERMETIC_HOME` as the app knows it; `~` is expanded. */
  home: string;
  fixture: boolean;
  /** Levels at or above this reach stderr; everything reaches the file. Default `info`. */
  stderrLevel?: LogLevel;
  /** Injected in tests; production writes to `Bun.stderr`. */
  stderr?: (text: string) => void;
  /** Set false to keep everything in memory (tests). */
  file?: boolean;
  /** Queue and flush tuning; the defaults suit the app, tests shrink them. */
  writer?: Pick<LogWriterOptions, "flushMs" | "flushBytes" | "maxQueueBytes" | "onBatch">;
  /** Where batches go; tests inject a sink that stalls or counts. Default: `<path>` itself. */
  sink?: LogSink;
}

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Owner-only, for the directory this log creates and for the file. The log
 * carries no secret values (§8.3), but it does carry fleet names, account
 * shapes, hostnames and every failed request — a map of the operator's fleet
 * that another account on a shared laptop has no business reading. The
 * directory mode applies only when this log is the one creating it: an
 * existing `$HERMETIC_HOME` is the operator's, and is left as they made it.
 */
export const LOG_DIR_MODE = 0o700;
export const LOG_FILE_MODE = 0o600;

export function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/**
 * Where the file goes. `home` is the directory `hermetic.db` lives in
 * (`$HERMETIC_HOME`, default `~/.hermetic`) — the same one fixture mode keeps
 * `hermetic-fixture.db` in — never the `:memory:` label the fixture *state*
 * reports as its home, which is not a path. Null means stderr only.
 */
export function logPathFor(home: string, fixture: boolean): string | null {
  if (home === "" || home === ":memory:") return null;
  return join(expandHome(home), fixture ? "app-fixture.log" : "app.log");
}

/** One line: ISO time, level, scope, message, then `key=value` fields. */
export function formatLine(
  level: LogLevel,
  scope: string,
  message: string,
  fields: Record<string, unknown> = {},
  at: Date = new Date(),
): string {
  const tail = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === "string" ? JSON.stringify(v) : String(v)}`)
    .join(" ");
  return `${at.toISOString()} ${level.toUpperCase().padEnd(5)} ${scope} ${message}${tail ? ` ${tail}` : ""}\n`;
}

export function createAppLog(options: AppLogOptions): AppLog {
  const stderrLevel = ORDER[options.stderrLevel ?? "info"];
  const write = options.stderr ?? ((text: string) => void Bun.write(Bun.stderr, text));
  let path: string | null = options.file === false ? null : logPathFor(options.home, options.fixture);
  if (path !== null && !path.startsWith("/")) path = null; // never a path relative to the cwd
  const writer =
    path === null
      ? null
      : createLogWriter({
          sink: options.sink ?? fileSink(path, { dirMode: LOG_DIR_MODE, fileMode: LOG_FILE_MODE }),
          droppedNotice: (dropped) =>
            formatLine("warn", "log", "queue full: older lines dropped", { dropped }),
          // A home that cannot be written must never take the app down; the
          // stderr half keeps working and the file half goes quiet.
          onFailure: () => {
            path = null;
          },
          ...options.writer,
        });
  return {
    get path() {
      return path;
    },
    line(level, scope, message, fields) {
      const text = formatLine(level, scope, message, fields);
      if (ORDER[level] >= stderrLevel) write(text);
      writer?.write(text, level === "debug");
    },
    flush: () => writer?.flush() ?? Promise.resolve(),
    flushSync: () => writer?.flushSync(),
    close: () => writer?.close() ?? Promise.resolve(),
  };
}

/**
 * Hooks that keep the queue's tail from dying with the process. Call once from
 * the head's entry point; returns the remover (tests).
 *
 * - `exit` flushes synchronously, which covers `process.exit()` after a
 *   graceful quit, a normal end, and a crash that still reaches `exit`.
 * - `uncaughtExceptionMonitor` logs the error and flushes before any
 *   `uncaughtException` handler runs, which matters because Electrobun's own
 *   handler force-exits without raising `exit`. A monitor observes only; it
 *   does not change what happens to the exception.
 * - `unhandledRejection` is logged (Electrobun already keeps the process alive
 *   through one; this only adds the line to the file).
 *
 * SIGKILL, a power cut, or the OS killing the process still lose whatever was
 * queued, at most `flushMs` of lines under normal load.
 */
export function installLogCrashFlush(
  log: AppLog,
  target: Pick<NodeJS.Process, "on" | "off"> = process,
): () => void {
  const describe = (e: unknown): string => (e instanceof Error ? (e.stack ?? e.message) : String(e));
  const onExit = (): void => log.flushSync();
  const onException = (e: unknown, origin?: string): void => {
    log.line("error", "process", `${origin ?? "uncaughtException"}: ${describe(e)}`);
    log.flushSync();
  };
  const onRejection = (e: unknown): void => {
    log.line("error", "process", `unhandledRejection: ${describe(e)}`);
  };
  target.on("exit", onExit);
  target.on("uncaughtExceptionMonitor", onException);
  target.on("unhandledRejection", onRejection);
  return () => {
    target.off("exit", onExit);
    target.off("uncaughtExceptionMonitor", onException);
    target.off("unhandledRejection", onRejection);
  };
}

/** A log that keeps every line in memory and writes nowhere; for tests. */
export function memoryLog(): AppLog & { lines: string[] } {
  const lines: string[] = [];
  return {
    path: null,
    lines,
    line(level, scope, message, fields) {
      lines.push(formatLine(level, scope, message, fields));
    },
    flush: () => Promise.resolve(),
    flushSync: () => {},
    close: () => Promise.resolve(),
  };
}
