/**
 * Notice when the operator quits the dev app, so the `--watch` session that
 * launched it can end too.
 *
 * `hutch electrobun dev --watch` outlives the app it launched: quit the window
 * and the watcher keeps running, waiting for the next edit. That is harmless on
 * its own, but the watcher holds a shared lock on the Electrobun release
 * (`~/.hutch/releases/electrobun/<version>/<os>-<arch>.lock`), which is one file
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
 * "The app" is the Electrobun launcher in the session's own process group, not
 * any launcher built from this checkout: a canary build left open from
 * `build/`, or a second session, must not keep this one alive.
 *
 * The same mechanism on macOS and Linux, with only the C library differing:
 *
 * - The lock probe is `flock(2)`, because that is what Hutch's engine takes the
 *   build lock with, and only an `flock` probe sees an `flock` holder (`fcntl`
 *   and `flock` locks do not conflict on Linux). Bun has no file-lock API and
 *   `node:fs` none either, so it is called through `bun:ffi` from `libSystem`
 *   on macOS and `libc.so.6` on Linux; the `LOCK_*` values are the same on
 *   both. The library is opened on first use, so importing this module never
 *   fails.
 * - The launcher's file name, and the `<os>-<arch>` key of the release, come
 *   from the Electrobun release in use (`native-devkit.json`, found from the
 *   version `packages/app` pins), not from a path written in here. A process is
 *   the app when it is in the session's group and its executable is that file:
 *   `ps -o comm=` names the executable on both systems (the full path on
 *   macOS, the bare name on Linux), so its basename is compared.
 *
 * On any other platform (Windows has neither `flock` nor `ps`) the watch is
 * inert.
 */
import { dlopen, FFIType } from "bun:ffi";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const POLL_MS = 500;
/** How long "app down, lock free" must hold before it counts as a quit. */
const GRACE_MS = 2_000;

export const LOCK_SH = 1;
export const LOCK_EX = 2;
export const LOCK_NB = 4;
export const LOCK_UN = 8;

/** The C library that exports `flock`, per platform the quit watch supports. */
const LIBC: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "/usr/lib/libSystem.B.dylib",
  linux: "libc.so.6",
};

/** Electrobun's name for each supported platform, as in its release keys. */
const ELECTROBUN_OS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "macos",
  linux: "linux",
};

/** The launcher's file name when a release carries no manifest to say so. */
const DEFAULT_LAUNCHER = "launcher";

type Flock = (fd: number, operation: number) => number;

const flocks = new Map<NodeJS.Platform, Flock>();

/** `flock(2)` from the platform's C library, opened on first use. */
export function flock(platform: NodeJS.Platform = process.platform): Flock {
  const cached = flocks.get(platform);
  if (cached !== undefined) return cached;
  const path = LIBC[platform];
  if (path === undefined) throw new Error(`dev-quit: no flock on ${platform}`);
  const lib = dlopen(path, {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  const call: Flock = (fd, operation) => lib.symbols.flock(fd, operation);
  flocks.set(platform, call);
  return call;
}

/**
 * Whether another process holds `path` exclusively. A shared, non-blocking
 * probe: it fails only against an exclusive holder, and is released at once so
 * the probe itself can never be what a build waits on.
 */
export function heldExclusively(path: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!existsSync(path)) return false;
  const call = flock(platform);
  const fd = openSync(path, "r");
  try {
    if (call(fd, LOCK_SH | LOCK_NB) !== 0) return true;
    call(fd, LOCK_UN);
    return false;
  } finally {
    closeSync(fd);
  }
}

/** Electrobun's release key for a platform, e.g. `macos-arm64`, `linux-arm64`. */
export function releaseKey(platform: NodeJS.Platform, arch: string): string {
  const os = ELECTROBUN_OS[platform];
  if (os === undefined) throw new Error(`dev-quit: Electrobun has no ${platform} release here`);
  return `${os}-${arch}`;
}

/**
 * The Electrobun release `appDir` builds with: the version it pins (its
 * `electrobun` devDependency, which `test/pins.test.ts` holds equal to
 * `hutch.config.ts`) under Hutch's release store in `home`.
 */
export function electrobunRelease(
  appDir: string,
  platform: NodeJS.Platform,
  arch: string,
  home: string = homedir(),
): string {
  const pkg = JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")) as {
    devDependencies?: Record<string, string>;
  };
  const version = pkg.devDependencies?.["electrobun"];
  if (version === undefined) throw new Error(`dev-quit: ${appDir} pins no electrobun version`);
  return join(home, ".hutch/releases/electrobun", version, releaseKey(platform, arch));
}

/**
 * The launcher's file name as the release's `native-devkit.json` declares it.
 * Read again until the release is there, since the watch can start before
 * `hutch` has fetched it.
 */
function launcherReader(release: string): () => string {
  let name: string | undefined;
  return () => {
    if (name !== undefined) return name;
    const manifest = join(release, "native-devkit.json");
    if (!existsSync(manifest)) return DEFAULT_LAUNCHER;
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
      layout?: { runtime?: { launcher?: string } };
    };
    name = parsed.layout?.runtime?.launcher ?? DEFAULT_LAUNCHER;
    return name;
  };
}

/** One process as `ps -axo pgid=,stat=,comm=` lists it. */
export interface ProcessEntry {
  pgid: number;
  /** The process state, e.g. `Ss`, `R+`; a zombie's starts with `Z`. */
  stat: string;
  /** The executable: a full path on macOS, the bare name on Linux. */
  comm: string;
}

export function parsePs(output: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*?)\s*$/.exec(line);
    if (match !== null) {
      entries.push({ pgid: Number(match[1]), stat: match[2] ?? "", comm: match[3] ?? "" });
    }
  }
  return entries;
}

export function listProcesses(): ProcessEntry[] {
  return parsePs(Bun.spawnSync(["ps", "-axo", "pgid=,stat=,comm="]).stdout.toString());
}

/**
 * Whether a live process running the executable `launcher` is in group `pgid`.
 * A launcher that has exited but not been reaped stays in the table as a
 * zombie (`Z`, or `X` once dead on Linux) under the same group and name, and
 * must not count, or the watch never sees the quit.
 */
export function appRunning(processes: ProcessEntry[], pgid: number, launcher: string): boolean {
  return processes.some(
    (p) => p.pgid === pgid && !/^[ZX]/.test(p.stat) && basename(p.comm) === launcher,
  );
}

export interface QuitWatchOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  /** Where Hutch's `.hutch` release store lives. */
  home?: string;
  pollMs?: number;
  graceMs?: number;
}

/**
 * Call `onQuit` once, the first time the app launched by the session leading
 * process group `pgid` is quit. `appDir` is `packages/app`, whose build lock
 * tells a rebuild from a quit. Returns a function that stops watching.
 */
export function onAppQuit(
  appDir: string,
  pgid: number,
  onQuit: () => void,
  options: QuitWatchOptions = {},
): () => void {
  const platform = options.platform ?? process.platform;
  if (LIBC[platform] === undefined) return () => {};
  const release = electrobunRelease(
    appDir,
    platform,
    options.arch ?? process.arch,
    options.home ?? homedir(),
  );
  const launcher = launcherReader(release);
  const graceMs = options.graceMs ?? GRACE_MS;
  const buildLock = join(appDir, ".hutch/locks/electrobun-build.lock");
  let seen = false;
  let downSince: number | null = null;
  const timer = setInterval(() => {
    if (appRunning(listProcesses(), pgid, launcher())) {
      seen = true;
      downSince = null;
      return;
    }
    if (!seen || heldExclusively(buildLock, platform)) {
      downSince = null;
      return;
    }
    downSince ??= Date.now();
    if (Date.now() - downSince < graceMs) return;
    clearInterval(timer);
    onQuit();
  }, options.pollMs ?? POLL_MS);
  return () => clearInterval(timer);
}
