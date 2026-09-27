#!/usr/bin/env bun
/** Test partitions used by the CI matrix. */
import { availableParallelism } from "node:os";

export const TEST_SHARDS = {
  cli: {
    paths: ["packages/cli"],
    buildHermeticd: false,
    // Nearly every test here spawns the compiled CLI, and a spawn is CPU-bound.
    // Bun's default of 20 tests in flight, on a 2-vCPU runner, left each spawn
    // a tenth of a core: all twenty overran the 5s timeout together, and every
    // batch after them did the same. More spawns than cores buys nothing, so
    // the shard runs one per core. Even then a test that spawns five times
    // takes ~2s on two cores, and a CI runner is slower than that: the longer
    // timeout is headroom for a slow machine, and still fails a hung spawn.
    maxConcurrencyPerCpu: true,
    timeoutMs: 15_000,
  },
  "non-cli": {
    paths: ["tests", "packages/core", "packages/app", "packages/agentd", "packages/ui"],
    buildHermeticd: true,
    maxConcurrencyPerCpu: false,
    timeoutMs: undefined,
  },
} as const;

export type TestShard = keyof typeof TEST_SHARDS;

function isTestShard(value: string | undefined): value is TestShard {
  return value !== undefined && Object.hasOwn(TEST_SHARDS, value);
}

async function main(): Promise<number> {
  const name = process.argv[2];
  if (!isTestShard(name)) {
    console.error(`usage: bun scripts/test-shard.ts <${Object.keys(TEST_SHARDS).join("|")}>`);
    return 2;
  }

  const shard = TEST_SHARDS[name];
  const env = { ...process.env };
  if (shard.buildHermeticd) env["HERMETIC_TEST_BUILD"] = "1";
  else delete env["HERMETIC_TEST_BUILD"];

  // `./` makes each one a path. A bare `tests` is a filter Bun matches against
  // every discovered file's path as a substring, so it would also pick up a
  // `packages/core/test/contests.test.ts` and run it in both shards.
  const flags: string[] = [];
  if (shard.maxConcurrencyPerCpu) flags.push(`--max-concurrency=${availableParallelism()}`);
  if (shard.timeoutMs !== undefined) flags.push(`--timeout=${shard.timeoutMs}`);
  const child = Bun.spawn(
    [process.execPath, "test", ...flags, ...shard.paths.map((path) => `./${path}`)],
    {
      env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  return child.exited;
}

if (import.meta.main) process.exitCode = await main();
