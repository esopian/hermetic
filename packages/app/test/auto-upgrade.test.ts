/**
 * §6.6: the fleet's opt-in automatic update — the decision as a table, then
 * the hook starting a real `artifacts.push` through the ops registry against
 * the fixture backend.
 */
import { describe, expect, test } from "bun:test";
import { openHermetic } from "@hermetic/core";
import type { FoundationStatus, Hermetic } from "@hermetic/core";
import { autoUpgradeDecision, createAutoUpgrade } from "../src/auto-upgrade.ts";
import type { AutoUpgradeInput } from "../src/auto-upgrade.ts";
import { OpRegistry } from "../src/ops.ts";
import { AppState } from "../src/state.ts";
import { testHome } from "./home.ts";

const SHA = "a".repeat(64);

/** A status that fires: newer build, foundation current, a config to push. */
function status(over: Partial<FoundationStatus> = {}): FoundationStatus {
  return {
    fleet: {
      foundation_version: 17,
      template_sha256: SHA,
      hermeticd_version: "0.8.3",
      artifacts_version: 5,
      ubuntu_release: "24.04",
      ami_id: "ami-0abc",
    },
    available: {
      foundation_version: 17,
      template_sha256: SHA,
      hermeticd_version: "0.8.3",
      artifacts_version: 5,
    },
    update_available: true,
    tool_outdated: false,
    build_order: "newer",
    in_progress: null,
    agents: [
      {
        name: "atlas",
        hermeticd_version: "0.8.3",
        config: "update",
        hermes_version: null,
        last_heartbeat: null,
      },
    ],
    ...over,
  } as FoundationStatus;
}

const base: AutoUpgradeInput = {
  settings: { auto_upgrade: true },
  status: status(),
  opInFlight: false,
  attempted: false,
};

describe("autoUpgradeDecision", () => {
  test("fires when on, newer, foundation current, idle, and there is work", () => {
    expect(autoUpgradeDecision(base)).toEqual({ run: true });
    // Each kind of work alone is enough.
    const idle = status({ agents: [] });
    expect(autoUpgradeDecision({ ...base, status: idle }).run).toBe(false);
    expect(
      autoUpgradeDecision({
        ...base,
        status: { ...idle, fleet: { ...idle.fleet, artifacts_version: 4 } },
      }).run,
    ).toBe(true);
    expect(
      autoUpgradeDecision({
        ...base,
        status: { ...idle, fleet: { ...idle.fleet, hermeticd_version: "0.8.2" } },
      }).run,
    ).toBe(true);
  });

  const refusals: Array<[string, Partial<AutoUpgradeInput>]> = [
    ["the setting is absent", { settings: {} }],
    ["the setting is off", { settings: { auto_upgrade: false } }],
    ["no settings were read", { settings: null }],
    ["the build is the same", { status: status({ build_order: "same" }) }],
    ["the build is older", { status: status({ build_order: "older" }) }],
    ["the order is unknown", { status: status({ build_order: "unknown" }) }],
    ["an older server sent no order", { status: status({ build_order: undefined }) }],
    ["the tool is outdated", { status: status({ tool_outdated: true }) }],
    [
      "the foundation is behind",
      { status: { ...status(), fleet: { ...status().fleet, foundation_version: 16 } } },
    ],
    [
      "the template differs",
      { status: { ...status(), fleet: { ...status().fleet, template_sha256: "b".repeat(64) } } },
    ],
    [
      "the fleet is locked",
      {
        status: status({ in_progress: { owner: "x", expires: "2026-10-22T00:00:00.000Z" } }),
      },
    ],
    ["an op is running", { opInFlight: true }],
    ["this process already tried", { attempted: true }],
    ["nothing to do", { status: status({ agents: [] }) }],
  ];
  for (const [why, over] of refusals) {
    test(`never when ${why}`, () => {
      expect(autoUpgradeDecision({ ...base, ...over }).run).toBe(false);
    });
  }
});

describe("createAutoUpgrade", () => {
  async function harness() {
    const hermetic: Hermetic = await openHermetic({ fixture: true, home: testHome("auto-up-") });
    const ops = new OpRegistry();
    const state = new AppState({
      fixture: true,
      home: testHome("auto-up-"),
      reopen: () => Promise.resolve(hermetic),
      hermetic,
      // What `openState` gives every real state: the fleet it serves.
      fleetId: hermetic.target?.fleet_id ?? null,
    });
    const lines: string[] = [];
    const log = { line: (_l: string, scope: string, msg: string) => lines.push(`${scope}: ${msg}`) };
    const auto = createAutoUpgrade({ state, ops, log: log as never });
    return { hermetic, ops, auto, lines };
  }

  /** The fixture fleet's real status, as one a newer build would read. */
  async function newer(hermetic: Hermetic): Promise<FoundationStatus> {
    const real = await hermetic.foundation.status({}, { hermes: false });
    return { ...real, build_order: "newer", fleet: { ...real.fleet, artifacts_version: 0 } };
  }

  test("starts artifacts.push through the registry once per fleet, reading the setting", async () => {
    const { hermetic, ops, auto, lines } = await harness();
    const s = await newer(hermetic);

    // Off by default: the fleet's own settings are read and say no.
    expect(await auto.check(s)).toEqual({ run: false, reason: "auto_upgrade is off" });
    expect(ops.list().ops).toEqual([]);

    await hermetic.settings.set({ auto_upgrade: true });
    expect(await auto.check(s)).toEqual({ run: true });
    const [op] = ops.list().ops;
    expect(op?.method).toBe("artifacts.push");
    expect(lines.some((l) => l.startsWith("auto-upgrade:"))).toBe(true);
    // While it runs, and after it settles, the same build does not start another.
    expect((await auto.check(s)).run).toBe(false);
    expect((await ops.wait(op!.id))?.status).toBe("ok");
    expect(await auto.check(s)).toEqual({ run: false, reason: "already attempted by this process" });
    expect(ops.list().ops).toHaveLength(1);
  });

  test("the status gates are judged before the settings are read", async () => {
    const { hermetic, auto } = await harness();
    let reads = 0;
    const get = hermetic.settings.get.bind(hermetic.settings);
    hermetic.settings.get = (...args: Parameters<typeof get>) => {
      reads += 1;
      return get(...args);
    };
    const s = await newer(hermetic);
    expect((await auto.check({ ...s, build_order: "same" })).run).toBe(false);
    expect(reads).toBe(0);
  });
});
