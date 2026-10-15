/**
 * macOS quarantine for a file the app saved from a box (`files.get`).
 *
 * A browser marks what it downloads with the `com.apple.quarantine` extended
 * attribute, and Gatekeeper and Launch Services check it before a downloaded
 * app, script or document opens. A file an agent produced is just as foreign to
 * this Mac, so the desktop head marks it the same way, right after core has
 * written and verified it.
 *
 * Best effort and silent: a missing `xattr`, a refusing filesystem or another
 * platform leaves the saved file as it is, and nothing here logs the path (a
 * file's name can be as sensitive as its contents). `/usr/bin/xattr` is run
 * with an argv, never through a shell.
 */

export interface QuarantineDeps {
  /** Defaults to `process.platform`. */
  platform?: string;
  /**
   * Runs one argv to completion and answers its exit code. Defaults to
   * `Bun.spawn`, killed once the signal fires.
   */
  spawn?: (argv: string[], signal: AbortSignal) => Promise<number>;
  /** How long `xattr` may take before it is abandoned. */
  timeoutMs?: number;
  /** Milliseconds since the epoch. */
  now?: () => number;
}

export const XATTR = "/usr/bin/xattr";
export const QUARANTINE_ATTR = "com.apple.quarantine";
/** `xattr` answers in milliseconds; a hung one must not hold the save's `saved` event. */
export const QUARANTINE_TIMEOUT_MS = 2000;

/**
 * The attribute's value: `flags;hex unix time;agent;` — `0081` is "downloaded,
 * not yet approved by the user", the flags Safari writes for a download.
 */
export function quarantineValue(nowMs: number): string {
  return `0081;${Math.floor(nowMs / 1000).toString(16)};Hermetic;`;
}

async function spawnArgv(argv: string[], signal: AbortSignal): Promise<number> {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const kill = (): void => proc.kill();
  signal.addEventListener("abort", kill, { once: true });
  try {
    return await proc.exited;
  } finally {
    signal.removeEventListener("abort", kill);
  }
}

/** Marks `path` quarantined on darwin; a no-op elsewhere. Never throws. */
export async function markQuarantined(path: string, deps: QuarantineDeps = {}): Promise<void> {
  if ((deps.platform ?? process.platform) !== "darwin") return;
  const spawn = deps.spawn ?? spawnArgv;
  const now = deps.now ?? (() => Date.now());
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve();
    }, deps.timeoutMs ?? QUARANTINE_TIMEOUT_MS);
  });
  try {
    const run = spawn([XATTR, "-w", QUARANTINE_ATTR, quarantineValue(now()), path], controller.signal);
    await Promise.race([run.then(() => undefined), timedOut]);
    // A spawn that rejects after the race was settled must not surface as unhandled.
    run.catch(() => undefined);
  } catch {
    // Best effort: the file is saved and verified either way.
  } finally {
    clearTimeout(timer);
  }
}
