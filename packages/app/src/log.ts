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
import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface AppLog {
  /** Where the file half of this log lives; printed at boot so it can be tailed. */
  readonly path: string | null;
  line(level: LogLevel, scope: string, message: string, fields?: Record<string, unknown>): void;
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
  /**
   * Whether the file's mode has been set this run. `appendFileSync`'s `mode`
   * only applies to a file it creates, so a log left by an older build (0644
   * under the default umask) is tightened once, on the first write.
   */
  let tightened = false;
  return {
    get path() {
      return path;
    },
    line(level, scope, message, fields) {
      const text = formatLine(level, scope, message, fields);
      if (ORDER[level] >= stderrLevel) write(text);
      if (path === null) return;
      try {
        mkdirSync(dirname(path), { recursive: true, mode: LOG_DIR_MODE });
        appendFileSync(path, text, { mode: LOG_FILE_MODE });
        if (!tightened) {
          chmodSync(path, LOG_FILE_MODE);
          tightened = true;
        }
      } catch {
        // A home that cannot be written must never take the app down; the
        // stderr half keeps working and the file half goes quiet.
        path = null;
      }
    },
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
  };
}
