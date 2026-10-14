/**
 * `agent set --memory` (§9, §6.2), run as a real process against the fixture:
 * the choice reaches core as `memory_provider`, a switch tells the operator how
 * it reaches the box, and naming the provider the agent already has says
 * nothing. `atlas` is seeded on holographic.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliBinary, seedFixtureHome } from "./cli-binary.ts";

const HOME = mkdtempSync(join(tmpdir(), "hermetic-cli-set-memory-"));
beforeAll(() => seedFixtureHome(HOME));

async function run(...args: string[]) {
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

describe.concurrent("agent set --memory", () => {
  test("a provider id passes through and comes back on the row", async () => {
    const { code, stdout } = await run("agent", "set", "atlas", "--memory", "hindsight", "--json");
    expect(code).toBe(0);
    expect((JSON.parse(stdout) as { memory: unknown }).memory).toEqual({ provider: "hindsight" });
  });

  test("`none` clears it", async () => {
    const { code, stdout } = await run("agent", "set", "atlas", "--memory", "none", "--json");
    expect(code).toBe(0);
    expect((JSON.parse(stdout) as { memory: unknown }).memory).toBeNull();
  });

  test("a switch names the rollout and the data it keeps", async () => {
    const { code, stderr } = await run("agent", "set", "atlas", "--memory", "hindsight");
    expect(code).toBe(0);
    expect(stderr).toContain(
      "memory: holographic → hindsight; run `hermetic plan rollout atlas` then `hermetic apply`",
    );
    expect(stderr).toContain("holographic's data stays on the volume");
  });

  test("the provider it already has is accepted and says nothing", async () => {
    const { code, stderr } = await run("agent", "set", "atlas", "--memory", "holographic");
    expect(code).toBe(0);
    expect(stderr).not.toContain("memory:");
  });

  test("an unknown provider is refused by the schema", async () => {
    const { code, stderr } = await run("agent", "set", "atlas", "--memory", "supermemory");
    expect(code).toBe(2);
    expect(stderr).toContain("memory_provider");
  });
});
