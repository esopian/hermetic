/**
 * The update check, and what it is no longer allowed to do.
 *
 * Every side of it is injected — updater, ops, dialog, browser, broadcast,
 * timer — so the suite never waits, never spawns and never reaches a release
 * server. The calls all land in one ordered array. The assertion that matters
 * most is an absence: nothing here, and nothing in the package, downloads or
 * applies a release, because the devkit verifies one by TLS alone.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { memoryLog } from "../../src/log.ts";
import type { OpSummary } from "../../src/ops.ts";
import {
  RELEASES_URL,
  UPDATE_INTERVAL_MS,
  UPDATE_STATUSES,
  type UpdaterLike,
  createUpdater,
  isNewerVersion,
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
  const log = memoryLog();

  /**
   * The devkit's real updater has `downloadUpdate` and `applyUpdate` too. The
   * fake carries both, recording into `calls`, so a regression that reached
   * for either — through a cast, a spread, a wider interface — shows up as a
   * call rather than as a type error someone silenced.
   */
  const devkit = {
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
    downloadUpdate: async () => void calls.push("download"),
    applyUpdate: async () => void calls.push("apply"),
  };
  const updater: UpdaterLike = devkit;

  /** The fake clock: `tick()` is what six hours of wall time looks like here. */
  const timers: Array<{ fn: () => void; ms: number }> = [];

  const checker = createUpdater({
    updater,
    ops: { list: () => ({ ops: running }) },
    prompt: async (message: string) => {
      calls.push(`prompt:${message}`);
      return scenario.open ?? false;
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

describe("createUpdater", () => {
  test("no update tells the footer so", async () => {
    const h = harness({ available: false });
    await h.checker.check();
    expect(h.calls).toEqual(["check", "broadcast:none"]);
  });

  test("available → prompt → the release page, and nothing is downloaded or applied", async () => {
    const h = harness({ available: true, version: "0.4.0", open: true });
    await h.checker.check();
    expect(h.calls).toEqual([
      "check",
      "broadcast:available",
      `prompt:${updatePrompt("0.4.0")}`,
      `open:${RELEASES_URL}`,
    ]);
    expect(h.broadcasts).toEqual([{ status: "available", version: "0.4.0" }]);
  });

  test("declining opens nothing and still installs nothing", async () => {
    const h = harness({ available: true, version: "0.4.0", open: false });
    await h.checker.check();
    expect(h.calls.at(-1)).toBe(`prompt:${updatePrompt("0.4.0")}`);
    expect(h.calls.some((c) => c.startsWith("open:"))).toBe(false);
    expect(h.calls).not.toContain("download");
    expect(h.calls).not.toContain("apply");
    expect(h.log.lines.join("")).toContain("update deferred");
  });

  test("the release page is the constant, not a URL built from the manifest", async () => {
    // The manifest is the untrusted half: whatever its version says, the only
    // URL this process hands the browser is the fixed one.
    const h = harness({ available: true, version: "9.0.0+evil.example", open: true });
    await h.checker.check();
    expect(h.calls.filter((c) => c.startsWith("open:"))).toEqual([`open:${RELEASES_URL}`]);
  });

  test("a different but older or equal build is not an update", async () => {
    // The devkit's `updateAvailable` is only "the hash differs".
    for (const version of ["0.2.9", "0.3.0", "0.3.0-rc.1", "not-a-version", undefined]) {
      const h = harness({ available: true, version, open: true });
      await h.checker.check();
      expect({ version, calls: h.calls }).toEqual({ version, calls: ["check", "broadcast:none"] });
    }
  });

  test("an installed version that cannot be read offers nothing", async () => {
    const h = harness({ installed: "", available: true, version: "0.4.0", open: true });
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

  test("the footer is never told a build is downloaded", () => {
    expect(UPDATE_STATUSES).toEqual(["none", "available", "error"]);
  });

  test("a running op skips a scheduled check, and the next tick takes it", async () => {
    const h = harness({ available: true, version: "0.4.0", open: false });
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

  test("a version already asked about is not asked about again on the timer", async () => {
    const h = harness({ available: true, version: "0.4.0", open: false });
    await h.checker.check();
    expect(h.calls.filter((c) => c.startsWith("prompt:")).length).toBe(1);

    h.calls.length = 0;
    await h.checker.check();
    // The footer still says it is there; only the modal is withheld.
    expect(h.calls).toEqual(["check", "broadcast:available"]);
  });

  test("an interactive check asks again", async () => {
    const h = harness({ available: true, version: "0.4.0", open: false });
    await h.checker.check();
    h.calls.length = 0;
    await h.checker.check({ interactive: true });
    expect(h.calls).toEqual(["check", "broadcast:available", `prompt:${updatePrompt("0.4.0")}`]);
  });

  test("a newer version after a decline is still offered", async () => {
    const h = harness({ available: true, version: "0.4.0", open: false });
    await h.checker.check();

    h.calls.length = 0;
    h.setVersion("0.5.0");
    await h.checker.check();
    expect(h.calls).toEqual(["check", "broadcast:available", `prompt:${updatePrompt("0.5.0")}`]);
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
    const h = harness({ available: true, version: "0.4.0", open: false });
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

  test("nothing in the app package calls downloadUpdate or applyUpdate", () => {
    // Re-enabling either is a decision that needs signed releases first (see
    // `main/updates.ts`); this is where that decision has to be made on purpose.
    const offenders = files.filter(({ text }) => /\b(downloadUpdate|applyUpdate)\s*\(/.test(text));
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  test("the devkit's Updater is reached only for the check and the channel", () => {
    const main = files.find((f) => f.path.endsWith(join("main", "index.ts")));
    expect(main).toBeDefined();
    const text = main?.text ?? "";
    // A spread would hand `createUpdater` every method the devkit has.
    expect(/\.\.\.\s*Updater\b/.test(text)).toBe(false);
    const members = new Set([...text.matchAll(/\bUpdater\.(\w+)/g)].map((m) => m[1]));
    expect([...members].sort()).toEqual(["checkForUpdate", "localInfo"]);
  });

  test("the release page is the repository the app checks against", () => {
    const config = readFileSync(join(APP_ROOT, "electrobun.config.ts"), "utf8");
    const baseUrl = /baseUrl:\s*"([^"]+)"/.exec(config)?.[1];
    expect(baseUrl).toBeDefined();
    expect(baseUrl?.startsWith(`${RELEASES_URL}/`)).toBe(true);
  });
});
