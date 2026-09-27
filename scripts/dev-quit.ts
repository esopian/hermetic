/**
 * Notice when the operator quits the dev app, so the `--watch` session that
 * launched it can end too.
 *
 * `hutch electrobun dev --watch` outlives the app it launched: quit the window
 * and the watcher keeps running, waiting for the next edit. That is harmless on
 * its own, but the watcher holds a shared lock on the Electrobun release
 * (`~/.hutch/releases/electrobun/<version>/macos-arm64.lock`), which is one file
 * for the whole machine, and a new `dev` in *any* checkout wants it exclusively
 * at startup. So a forgotten terminal tab whose app was quit an hour ago leaves
 * every other checkout at "[electrobun] Waiting for the project build lock...".
 *
 * Telling a quit apart from a watch rebuild, which also takes the app down:
 *
 * - A rebuild holds the checkout's build lock
 *   (`packages/app/.hutch/locks/electrobun-build.lock`) exclusively for as long
 *   as the app is down: the lock is taken as the old app goes and released as
 *   the new one starts (measured at under 100ms apart on both edges).
 * - A rebuild that fails ends the watcher itself (`CottontailBuildFailed`), so
 *   an app that stays down with the lock free is never a watcher waiting on a
 *   fix.
 *
 * So: the app was up, and now it is gone and the build lock is free, for the
 * whole of `GRACE_MS`, means the operator quit it.
 *
 * "The app" is a launcher in the session's own process group, not any launcher
 * built from this checkout: a canary build left open from `build/`, or a
 * second session, must not keep this one alive.
 */
import { dlopen, FFIType } from "bun:ffi";
import { closeSync, existsSync, openSync } from "node:fs";
import { join } from "node:path";

const POLL_MS = 500;
/** How long "app down, lock free" must hold before it counts as a quit. */
const GRACE_MS = 2_000;

const LOCK_SH = 1;
const LOCK_NB = 4;
const LOCK_UN = 8;

const libc = dlopen("/usr/lib/libSystem.B.dylib", {
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
});

/**
 * Whether another process holds `path` exclusively. A shared, non-blocking
 * probe: it fails only against an exclusive holder, and is released at once so
 * the probe itself can never be what a build waits on.
 */
function heldExclusively(path: string): boolean {
  if (!existsSync(path)) return false;
  const fd = openSync(path, "r");
  try {
    if (libc.symbols.flock(fd, LOCK_SH | LOCK_NB) !== 0) return true;
    libc.symbols.flock(fd, LOCK_UN);
    return false;
  } finally {
    closeSync(fd);
  }
}

/** Whether an app launcher is running in process group `pgid`. */
function appRunning(pgid: number): boolean {
  const ps = Bun.spawnSync(["ps", "-axo", "pgid=,command="]);
  return ps.stdout
    .toString()
    .split("\n")
    .some((line) => {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      return (
        match !== null &&
        Number(match[1]) === pgid &&
        (match[2] ?? "").includes(".app/Contents/MacOS/launcher")
      );
    });
}

/**
 * Call `onQuit` once, the first time the app launched by the session leading
 * process group `pgid` is quit. `appDir` is `packages/app`, whose build lock
 * tells a rebuild from a quit. Returns a function that stops watching.
 */
export function onAppQuit(appDir: string, pgid: number, onQuit: () => void): () => void {
  const buildLock = join(appDir, ".hutch/locks/electrobun-build.lock");
  let seen = false;
  let downSince: number | null = null;
  const timer = setInterval(() => {
    if (appRunning(pgid)) {
      seen = true;
      downSince = null;
      return;
    }
    if (!seen || heldExclusively(buildLock)) {
      downSince = null;
      return;
    }
    downSince ??= Date.now();
    if (Date.now() - downSince < GRACE_MS) return;
    clearInterval(timer);
    onQuit();
  }, POLL_MS);
  return () => clearInterval(timer);
}
