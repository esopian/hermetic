/**
 * §4.6: `hermetic runs` says what this laptop has been doing, so it is also
 * where an operator finds the work it stopped in the middle of and will not
 * finish on its own.
 *
 * A portal that died during `agent recreate` leaves a pending row that no boot
 * replays — replaying one can destroy the instance the interrupted attempt had
 * already built. The portal says so in its own log; an operator in a terminal
 * never reads that file, and this is the same sentence where they are.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureConfigFor, openHermetic, openPendingOpStore } from "@hermetic/core";
import { cliBinary } from "./cli-binary.ts";

const HOME = mkdtempSync(join(tmpdir(), "hermetic-cli-recovery-"));

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

async function run(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([await cliBinary(), ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HERMETIC_FIXTURE: "1", HERMETIC_NO_TTY: "1", HERMETIC_HOME: HOME },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("hermetic runs", () => {
  test("names the agent and the command for an interrupted recreate", async () => {
    const config = fixtureConfigFor("main");
    // Freeze the fixture fleets into this home first, so the row below names a
    // fleet the CLI will actually resolve to.
    await openHermetic({ fixture: true, home: HOME });
    const pending = openPendingOpStore({ fixture: true, home: HOME });
    try {
      pending.claim({
        id: "op-interrupted-recreate",
        method: "agents.recreate",
        target: "atlas",
        input: { name: "atlas", yes: true },
        started_at: new Date().toISOString(),
        phase: "instance",
        fleet: config.fleet_id,
        account_id: config.account_id,
        region: config.region,
      });
    } finally {
      pending.close();
    }

    const { code, stdout, stderr } = await run("runs", "--json");
    expect(code).toBe(0);
    // On stderr, so a script reading `runs --json` still gets an array.
    expect(stderr).toContain("hermetic agent recreate atlas");
    expect(stderr).toContain("atlas");
    expect(Array.isArray(JSON.parse(stdout))).toBe(true);
  });
});
