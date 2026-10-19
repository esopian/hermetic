/**
 * `scripts/dev-quit.ts`: the quit watch, on whichever of macOS and Linux runs
 * the suite, against a real `flock` and a real process standing in for the
 * Electrobun launcher, in a temp `packages/app` and a temp Hutch release store.
 * The other platform's naming (release key, launcher as `ps` shows it) is
 * checked with the platform injected, so neither host needs the other.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appRunning,
  electrobunRelease,
  flock,
  heldExclusively,
  listProcesses,
  LOCK_EX,
  LOCK_NB,
  LOCK_UN,
  onAppQuit,
  parsePs,
  releaseKey,
} from "../scripts/dev-quit.ts";

const POLL_MS = 50;
const GRACE_MS = 300;

let root: string;
let appDir: string;
let home: string;
let launcherPath: string;
const children: ChildProcess[] = [];
const stops: (() => void)[] = [];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "dev-quit-"));
  appDir = join(root, "packages/app");
  home = join(root, "home");
  mkdirSync(join(appDir, ".hutch/locks"), { recursive: true });
  writeFileSync(
    join(appDir, "package.json"),
    JSON.stringify({ devDependencies: { electrobun: "9.9.9" } }),
  );
  // The release the app pins, with the manifest naming its launcher.
  const release = electrobunRelease(appDir, process.platform, process.arch, home);
  mkdirSync(release, { recursive: true });
  writeFileSync(
    join(release, "native-devkit.json"),
    JSON.stringify({ layout: { runtime: { launcher: "launcher" } } }),
  );
  // A built app's launcher: a real executable named as the manifest says, so
  // `ps` shows it exactly as it shows Electrobun's. A copy of bun, not of
  // /bin/sleep: macOS kills a copied Apple platform binary the moment it starts.
  mkdirSync(join(appDir, "build/bin"), { recursive: true });
  launcherPath = join(appDir, "build/bin/launcher");
  copyFileSync(process.execPath, launcherPath);
  Bun.spawnSync(["chmod", "+x", launcherPath]);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

/** Start a launcher leading its own process group, and wait until `ps` shows it. */
async function startLauncher(): Promise<ChildProcess> {
  const child = spawn(launcherPath, ["-e", "setTimeout(() => {}, 60_000)"], {
    detached: true,
    stdio: "ignore",
  });
  children.push(child);
  const pgid = child.pid ?? -1;
  for (let i = 0; i < 100; i++) {
    if (appRunning(listProcesses(), pgid, "launcher")) return child;
    await Bun.sleep(20);
  }
  throw new Error("the fake launcher never showed up in ps");
}

async function stopLauncher(child: ChildProcess): Promise<void> {
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
}

function watch(pgid: number): { quit: () => boolean } {
  let quit = false;
  stops.push(
    onAppQuit(appDir, pgid, () => (quit = true), { home, pollMs: POLL_MS, graceMs: GRACE_MS }),
  );
  return { quit: () => quit };
}

/** Hold `path` exclusively the way Hutch's engine holds the build lock. */
function holdExclusively(path: string): () => void {
  writeFileSync(path, "");
  const fd = openSync(path, "r");
  expect(flock()(fd, LOCK_EX | LOCK_NB)).toBe(0);
  return () => {
    flock()(fd, LOCK_UN);
    closeSync(fd);
  };
}

describe("naming per platform", () => {
  test("release keys match Hutch's lock and directory names", () => {
    expect(releaseKey("darwin", "arm64")).toBe("macos-arm64");
    expect(releaseKey("linux", "arm64")).toBe("linux-arm64");
    expect(releaseKey("linux", "x64")).toBe("linux-x64");
    expect(() => releaseKey("win32", "x64")).toThrow();
  });

  test("the release is found from the app's electrobun pin", () => {
    expect(electrobunRelease(appDir, "linux", "arm64", "/h")).toBe(
      "/h/.hutch/releases/electrobun/9.9.9/linux-arm64",
    );
    expect(electrobunRelease(appDir, "darwin", "arm64", "/h")).toBe(
      "/h/.hutch/releases/electrobun/9.9.9/macos-arm64",
    );
  });

  test("the launcher is matched by group and executable name, as each ps prints it", () => {
    const ps = parsePs(
      [
        // macOS: comm is the full executable path, spaces included.
        "  4242 S    /src/hermetic/packages/app/build/dev-macos-arm64/Hermetic Dev.app/Contents/MacOS/launcher",
        "  4242 Ss   /opt/bun/bin/bun",
        // Linux: comm is the bare name.
        "  5151 Sl   launcher",
        "  5151 S+   bun",
        "  6161 R    bun",
      ].join("\n"),
    );
    expect(ps[0]).toEqual({
      pgid: 4242,
      stat: "S",
      comm: "/src/hermetic/packages/app/build/dev-macos-arm64/Hermetic Dev.app/Contents/MacOS/launcher",
    });
    expect(appRunning(ps, 4242, "launcher")).toBe(true);
    expect(appRunning(ps, 5151, "launcher")).toBe(true);
    expect(appRunning(ps, 6161, "launcher")).toBe(false);
    expect(appRunning(ps, 7171, "launcher")).toBe(false);
  });

  test("an exited, unreaped launcher does not count as running", () => {
    const ps = parsePs(
      [
        // The launcher has exited; its parent has not reaped it yet.
        "  5151 Z    launcher",
        "  5151 X    launcher",
        "  5151 Sl   bun",
        // A live launcher in another group still counts.
        "  6161 Sl   launcher",
      ].join("\n"),
    );
    expect(appRunning(ps, 5151, "launcher")).toBe(false);
    expect(appRunning(ps, 6161, "launcher")).toBe(true);
  });
});

describe("the lock probe", () => {
  test("sees an exclusive flock holder, and not a free or missing lock", () => {
    const lock = join(appDir, ".hutch/locks/probe.lock");
    expect(heldExclusively(lock)).toBe(false);
    writeFileSync(lock, "");
    expect(heldExclusively(lock)).toBe(false);
    const release = holdExclusively(lock);
    expect(heldExclusively(lock)).toBe(true);
    release();
    expect(heldExclusively(lock)).toBe(false);
  });
});

describe(`the quit watch on ${process.platform}`, () => {
  test("a launcher that goes away with the build lock free is a quit", async () => {
    const launcher = await startLauncher();
    const w = watch(launcher.pid ?? -1);
    await Bun.sleep(POLL_MS * 4);
    expect(w.quit()).toBe(false);
    await stopLauncher(launcher);
    await Bun.sleep(GRACE_MS + POLL_MS * 6);
    expect(w.quit()).toBe(true);
  });

  test("a rebuild holding the build lock is not a quit", async () => {
    const launcher = await startLauncher();
    const w = watch(launcher.pid ?? -1);
    await Bun.sleep(POLL_MS * 4);
    const release = holdExclusively(join(appDir, ".hutch/locks/electrobun-build.lock"));
    await stopLauncher(launcher);
    await Bun.sleep(GRACE_MS * 3);
    expect(w.quit()).toBe(false);
    // The rebuild failed and released the lock without a new app: now a quit.
    release();
    await Bun.sleep(GRACE_MS + POLL_MS * 6);
    expect(w.quit()).toBe(true);
  });

  test("a launcher in another process group neither starts nor holds the session", async () => {
    const ours = await startLauncher();
    const unrelated = await startLauncher();
    const w = watch(ours.pid ?? -1);
    await Bun.sleep(POLL_MS * 4);
    await stopLauncher(ours);
    await Bun.sleep(GRACE_MS + POLL_MS * 6);
    expect(w.quit()).toBe(true);

    // A group whose app never started: the unrelated launcher is not it.
    expect(unrelated.exitCode).toBeNull();
    const never = watch(2 ** 30);
    await Bun.sleep(GRACE_MS + POLL_MS * 6);
    expect(never.quit()).toBe(false);
  });
});
