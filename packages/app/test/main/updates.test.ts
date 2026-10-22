/**
 * The update flow: check, download, verify, install — and the manual path
 * whenever any step short of a verified download fails.
 *
 * Every side of it is injected — updater, verifier, ops, dialogs, browser,
 * broadcast, timer — so the suite never waits, never spawns and never reaches a
 * release server. The calls all land in one ordered array. The assertions that
 * matter most are about `apply`: it appears only right after a `verify` that
 * passed, and never after one that failed.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { memoryLog } from "../../src/log.ts";
import type { OpSummary } from "../../src/ops.ts";
import type { VerifyResult } from "../../src/main/update-verify.ts";
import {
  RELEASE_ASSETS_URL,
  RELEASES_URL,
  UPDATE_INTERVAL_MS,
  UPDATE_STATUSES,
  type UpdaterLike,
  createUpdater,
  isNewerVersion,
  restartPrompt,
  updatePrompt,
} from "../../src/main/updates.ts";

/**
 * Lets every pending microtask settle. The flows here are several `await`s
 * deep, so counting `Promise.resolve()`s would be counting implementation
 * steps; a macrotask boundary drains them all.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function runningOp(): OpSummary {
  return {
    id: "op-1",
    method: "agents.create",
    target: "lisbon",
    status: "running",
    started_at: "2026-09-21T00:00:00.000Z",
    finished_at: null,
    event_count: 0,
    dropped: 0,
    error: null,
  };
}

interface Scenario {
  channel?: string;
  /** What this bundle's `version.json` says. Default `0.3.0`. */
  installed?: string;
  available?: boolean;
  version?: string;
  /** How the download goes: prepared (default), the devkit's error field, or a throw. */
  download?: "ok" | "field" | "throw";
  /** What each `verify` answers, in order; the last one repeats. Default: ok. */
  verify?: boolean[];
  /** The operator's answer to the "restart now?" box. */
  restart?: boolean;
  /** The operator's answer to the "open the release page?" box. */
  open?: boolean;
  /** How the check fails: a throw, or the devkit's own `error` field. */
  fail?: { how: "throw" | "field"; message: string };
}

function harness(initial: Scenario = {}) {
  const scenario = { ...initial };
  const calls: string[] = [];
  const broadcasts: Array<{ status: string; version?: string }> = [];
  let running: OpSummary[] = [];
  let verifies = 0;
  const log = memoryLog();

  const updater: UpdaterLike = {
    localInfo: {
      channel: () => scenario.channel ?? "stable",
      version: () => scenario.installed ?? "0.3.0",
    },
    checkForUpdate: async () => {
      calls.push("check");
      if (scenario.fail?.how === "throw") throw new Error(scenario.fail.message);
      if (scenario.fail?.how === "field")
        return { updateAvailable: false, version: "", error: scenario.fail.message };
      return { updateAvailable: scenario.available ?? false, version: scenario.version, error: "" };
    },
    downloadUpdate: async () => {
      calls.push("download");
      if (scenario.download === "throw") throw new Error("disk full");
    },
    updateInfo: () =>
      scenario.download === "field"
        ? { updateReady: false, error: "Failed to download update: HTTP 503" }
        : { updateReady: true, error: "" },
    applyUpdate: async () => void calls.push("apply"),
  };

  /** The fake clock: `tick()` is what six hours of wall time looks like here. */
  const timers: Array<{ fn: () => void; ms: number }> = [];

  const checker = createUpdater({
    updater,
    ops: { list: () => ({ ops: running }) },
    verify: async (): Promise<VerifyResult> => {
      calls.push("verify");
      const answers = scenario.verify ?? [true];
      const ok = answers[Math.min(verifies, answers.length - 1)] ?? true;
      verifies += 1;
      return ok
        ? { ok: true, version: scenario.version ?? "" }
        : { ok: false, reason: "bad signature" };
    },
    prompt: async (message: string) => {
      calls.push(`prompt:${message}`);
      return scenario.open ?? false;
    },
    confirmRestart: async (message: string) => {
      calls.push(`restart:${message}`);
      return scenario.restart ?? false;
    },
    openExternal: (url) => void calls.push(`open:${url}`),
    broadcast: (_name, payload) => {
      calls.push(`broadcast:${payload.status}`);
      broadcasts.push(payload);
    },
    log,
    setTimer: (fn, ms) => {
      const entry = { fn, ms };
      timers.push(entry);
      return () => {
        const at = timers.indexOf(entry);
        if (at >= 0) timers.splice(at, 1);
      };
    },
  });

  return {
    checker,
    calls,
    broadcasts,
    log,
    timers,
    scenario,
    setRunning: (ops: OpSummary[]) => void (running = ops),
    setFailMessage: (message: string) => {
      scenario.fail = { how: "throw", message };
    },
    clearFail: () => {
      scenario.fail = undefined;
    },
    setVersion: (version: string) => {
      scenario.version = version;
    },
    tick: () => {
      for (const t of [...timers]) t.fn();
    },
  };
}

/** A verified download, up to the restart box. */
const READY = (version: string) => [
  "check",
  "broadcast:downloading",
  "download",
  "verify",
  "broadcast:ready",
  `restart:${restartPrompt(version)}`,
];

/** A download that could not be installed, falling back to the release page. */
const FALLBACK = (version: string) => ["broadcast:available", `prompt:${updatePrompt(version)}`];

describe("createUpdater", () => {
  test("no update tells the footer so", async () => {
    const h = harness({ available: false });
    await h.checker.check();
    expect(h.calls).toEqual(["check", "broadcast:none"]);
  });

  test("available → download → verify → restart → verify again → apply", async () => {
    const h = harness({ available: true, version: "0.4.0", restart: true });
    await h.checker.check();
    expect(h.calls).toEqual([...READY("0.4.0"), "verify", "apply"]);
    expect(h.broadcasts).toEqual([
      { status: "downloading", version: "0.4.0" },
      { status: "ready", version: "0.4.0" },
    ]);
  });

  test("'Later' leaves the update ready, and install() takes it after verifying again", async () => {
    const h = harness({ available: true, version: "0.4.0", restart: false });
    await h.checker.check();
    expect(h.calls).toEqual(READY("0.4.0"));
    expect(h.log.lines.join("")).toContain("install deferred");

    h.calls.length = 0;
    expect(await h.checker.install()).toBe(true);
    expect(h.calls).toEqual(["verify", "apply"]);
  });

  test("a signature that fails never installs, and offers the release page", async () => {
    const h = harness({ available: true, version: "0.4.0", verify: [false], open: true });
    await h.checker.check();
    expect(h.calls).toEqual([
      "check",
      "broadcast:downloading",
      "download",
      "verify",
      ...FALLBACK("0.4.0"),
      `open:${RELEASES_URL}`,
    ]);
    expect(h.log.lines.join("")).toContain("bad signature");
    expect(await h.checker.install()).toBe(false);
    expect(h.calls).not.toContain("apply");
  });

  test("a failed download is never verified or installed", async () => {
    for (const download of ["field", "throw"] as const) {
      const h = harness({ available: true, version: "0.4.0", download });
      await h.checker.check();
      expect(h.calls).toEqual(["check", "broadcast:downloading", "download", ...FALLBACK("0.4.0")]);
      expect(h.log.lines.join("")).toContain("download failed");
    }
  });

  test("a tar that stops verifying before the restart is not installed", async () => {
    // Verified after the download, tampered with before the restart.
    const h = harness({ available: true, version: "0.4.0", verify: [true, false], restart: true });
    await h.checker.check();
    expect(h.calls).toEqual([...READY("0.4.0"), "verify", "broadcast:available"]);
    expect(h.calls).not.toContain("apply");
    // Discarded: nothing is left to install.
    h.calls.length = 0;
    expect(await h.checker.install()).toBe(false);
    expect(h.calls).toEqual([]);
  });

  test("install() with nothing verified does nothing", async () => {
    const h = harness();
    expect(await h.checker.install()).toBe(false);
    expect(h.calls).toEqual([]);
  });

  test("install() does not run under a check", async () => {
    const h = harness({ available: true, version: "0.4.0", restart: false });
    await h.checker.check();
    h.calls.length = 0;
    const checking = h.checker.check({ interactive: true });
    expect(await h.checker.install()).toBe(false);
    await checking;
    expect(h.calls).not.toContain("apply");
  });

  test("a ready update is not downloaded again on the timer, nor asked about", async () => {
    const h = harness({ available: true, version: "0.4.0", restart: false });
    await h.checker.check();
    h.calls.length = 0;
    await h.checker.check();
    expect(h.calls).toEqual(["check", "broadcast:ready"]);
  });

  test("an interactive check asks about a ready update again", async () => {
    const h = harness({ available: true, version: "0.4.0", restart: false });
    await h.checker.check();
    h.calls.length = 0;
    await h.checker.check({ interactive: true });
    expect(h.calls).toEqual(["check", "broadcast:ready", `restart:${restartPrompt("0.4.0")}`]);
  });

  test("a refused version is not downloaded again on the timer; the operator can retry", async () => {
    const h = harness({ available: true, version: "0.4.0", verify: [false] });
    await h.checker.check();
    h.calls.length = 0;
    await h.checker.check();
    // The footer still says it exists; no second download, no second modal.
    expect(h.calls).toEqual(["check", "broadcast:available"]);

    h.calls.length = 0;
    await h.checker.check({ interactive: true });
    expect(h.calls).toEqual([
      "check",
      "broadcast:downloading",
      "download",
      "verify",
      ...FALLBACK("0.4.0"),
    ]);
  });

  test("a newer version after a decline is fetched and offered", async () => {
    const h = harness({ available: true, version: "0.4.0", restart: false });
    await h.checker.check();
    h.calls.length = 0;
    h.setVersion("0.5.0");
    await h.checker.check();
    expect(h.calls).toEqual(READY("0.5.0"));
  });

  test("the release page is the constant, not a URL built from the manifest", async () => {
    // The manifest is the untrusted half: whatever its version says, the only
    // URL this process hands the browser is the fixed one.
    const h = harness({ available: true, version: "9.0.0+evil.example", verify: [false], open: true });
    await h.checker.check();
    expect(h.calls.filter((c) => c.startsWith("open:"))).toEqual([`open:${RELEASES_URL}`]);
  });

  test("a different but older or equal build is not an update", async () => {
    // The devkit's `updateAvailable` is only "the hash differs".
    for (const version of ["0.2.9", "0.3.0", "0.3.0-rc.1", "not-a-version", undefined]) {
      const h = harness({ available: true, version, restart: true });
      await h.checker.check();
      expect({ version, calls: h.calls }).toEqual({ version, calls: ["check", "broadcast:none"] });
    }
  });

  test("an installed version that cannot be read offers nothing", async () => {
    const h = harness({ installed: "", available: true, version: "0.4.0", restart: true });
    await h.checker.check();
    expect(h.calls).toEqual(["check", "broadcast:none"]);
  });

  test("isNewerVersion is strict semver", () => {
    expect(isNewerVersion("0.10.0", "0.9.0")).toBe(true);
    expect(isNewerVersion("1.0.0", "1.0.0-rc.2")).toBe(true);
    expect(isNewerVersion("1.0.0-rc.2", "1.0.0")).toBe(false);
    expect(isNewerVersion("1.0.0", "1.0.0")).toBe(false);
    expect(isNewerVersion("v1.0.0", "0.1.0")).toBe(false);
  });

  test("the footer's statuses are the closed set the page switches on", () => {
    expect(UPDATE_STATUSES).toEqual(["none", "downloading", "ready", "available", "error"]);
  });

  test("a running op skips a scheduled check, and the next tick takes it", async () => {
    const h = harness({ available: true, version: "0.4.0" });
    h.setRunning([runningOp()]);
    await h.checker.check();
    // Not even `checkForUpdate`: a modal over an op in flight is an
    // interruption nobody asked for.
    expect(h.calls).toEqual([]);

    h.setRunning([]);
    await h.checker.check();
    expect(h.calls[0]).toBe("check");
  });

  test("an interactive check runs with an op in flight", async () => {
    const h = harness({ available: false });
    h.setRunning([runningOp()]);
    await h.checker.check({ interactive: true });
    expect(h.calls).toEqual(["check", "broadcast:none"]);
  });

  test("the dev channel never asks", async () => {
    const h = harness({ channel: "dev", available: true, version: "0.4.0" });
    await h.checker.check({ interactive: true });
    expect(h.calls).toEqual([]);
  });

  test("the devkit's error field is a failure, not 'nothing newer'", async () => {
    const h = harness({ fail: { how: "field", message: "Failed to check for updates: HTTP 404" } });
    await h.checker.check();
    expect(h.calls).toEqual(["check", "broadcast:error"]);
    expect(h.log.lines.join("")).toContain("HTTP 404");
  });

  test("the same failure is logged once across three checks", async () => {
    const h = harness({ fail: { how: "throw", message: "release server unreachable" } });
    await h.checker.check();
    await h.checker.check();
    await h.checker.check();
    const logged = h.log.lines.filter((l) => l.includes("release server unreachable"));
    expect(logged.length).toBe(1);
    // Every attempt still tells the footer; only the file is spared the repeats.
    expect(h.calls.filter((c) => c === "broadcast:error").length).toBe(3);
  });

  test("a genuinely new failure is logged again", async () => {
    const h = harness({ fail: { how: "throw", message: "release server unreachable" } });
    await h.checker.check();
    await h.checker.check();
    h.setFailMessage("certificate expired");
    await h.checker.check();
    // Suppression is per-message, not "never log twice": a new symptom is news.
    expect(h.log.lines.filter((l) => l.includes("release server unreachable")).length).toBe(1);
    expect(h.log.lines.filter((l) => l.includes("certificate expired")).length).toBe(1);
  });

  test("a recovery re-arms the log, so the same outage twice is recorded twice", async () => {
    const h = harness({ fail: { how: "throw", message: "release server unreachable" } });
    await h.checker.check();
    h.clearFail();
    await h.checker.check();
    h.setFailMessage("release server unreachable");
    await h.checker.check();
    // The memo suppresses a repeat, not a recurrence: a second outage weeks
    // later is the one the file most needs to have.
    expect(h.log.lines.filter((l) => l.includes("release server unreachable")).length).toBe(2);
  });

  test("the 6 h timer fires a check", async () => {
    const h = harness({ available: false });
    h.checker.start();
    await flush();
    expect(h.timers[0]?.ms).toBe(UPDATE_INTERVAL_MS);
    // `start` checks once at launch rather than waiting out the first interval.
    expect(h.calls.filter((c) => c === "check").length).toBe(1);

    h.tick();
    await flush();
    expect(h.calls.filter((c) => c === "check").length).toBe(2);

    h.checker.stop();
    h.tick();
    await flush();
    expect(h.calls.filter((c) => c === "check").length).toBe(2);
  });

  test("a check while one is in flight returns immediately", async () => {
    const h = harness({ available: true, version: "0.4.0" });
    const first = h.checker.check();
    await h.checker.check();
    expect(h.calls.filter((c) => c === "check").length).toBe(1);
    await first;
  });
});

const APP_ROOT = join(import.meta.dir, "..", "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}

describe("no path applies an unverified update", () => {
  const files = sourceFiles(join(APP_ROOT, "src")).map((path) => ({
    path,
    text: readFileSync(path, "utf8"),
  }));
  const rel = (path: string) => path.slice(APP_ROOT.length + 1);

  test("applyUpdate is called only by the verified path and its one devkit wrapper", () => {
    // Comments name it freely; only code counts.
    const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const calls = files.flatMap(({ path, text }) =>
      [...code(text).matchAll(/\.applyUpdate\s*\(/g)].map(() => rel(path)),
    );
    // `updates.ts` calls it once, in `installVerified`, after `verified()`;
    // `index.ts` is the wrapper that hands the devkit's method over.
    expect(calls.sort()).toEqual(["src/main/index.ts", "src/main/updates.ts"]);
    const updates = files.find((f) => rel(f.path) === "src/main/updates.ts")?.text ?? "";
    const installer = /const installVerified = async[\s\S]*?\n {2}};/.exec(updates)?.[0] ?? "";
    expect(installer).toContain("applyUpdate()");
    expect(installer.indexOf("verified()")).toBeGreaterThan(-1);
    expect(installer.indexOf("verified()")).toBeLessThan(installer.indexOf("applyUpdate()"));
  });

  test("the devkit's Updater is reached member by member, never spread", () => {
    const main = files.find((f) => f.path.endsWith(join("main", "index.ts")));
    expect(main).toBeDefined();
    const text = main?.text ?? "";
    // A spread would hand `createUpdater` every method the devkit has.
    expect(/\.\.\.\s*Updater\b/.test(text)).toBe(false);
    const members = new Set([...text.matchAll(/\bUpdater\.(\w+)/g)].map((m) => m[1]));
    expect([...members].sort()).toEqual([
      "appDataFolder",
      "applyUpdate",
      "checkForUpdate",
      "downloadUpdate",
      "getLocalInfo",
      "localInfo",
      "updateInfo",
    ]);
  });

  test("the release page and the signature's home are the repository the app checks against", () => {
    const config = readFileSync(join(APP_ROOT, "electrobun.config.ts"), "utf8");
    const baseUrl = /baseUrl:\s*"([^"]+)"/.exec(config)?.[1];
    expect(baseUrl).toBe(RELEASE_ASSETS_URL);
    expect(RELEASE_ASSETS_URL.startsWith(`${RELEASES_URL}/`)).toBe(true);
  });
});
