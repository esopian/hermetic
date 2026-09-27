/**
 * The one test that runs the real compiler: `buildHermeticd` cross-compiles
 * `packages/agentd` for linux-arm64 the way `init` does on a source checkout.
 * Slow (Bun fetches the target runtime the first time), so it runs only when
 * `HERMETIC_TEST_BUILD=1` — CI sets it; the default suite skips it.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTD_ENTRY, buildHermeticd, findRepoRoot } from "../src/release/artifacts.ts";

const enabled = process.env["HERMETIC_TEST_BUILD"] === "1";

describe.skipIf(!enabled)("compiling hermeticd from source", () => {
  test("produces a linux-arm64 executable", async () => {
    const root = findRepoRoot();
    expect(root).not.toBeNull();
    const dir = mkdtempSync(join(tmpdir(), "hermetic-build-"));
    try {
      const outfile = join(dir, "hermeticd");
      await buildHermeticd({ entry: join(root!, AGENTD_ENTRY), outfile, version: "0.0.0-test" });
      expect(existsSync(outfile)).toBe(true);
      // A compiled Bun binary is tens of MB; a stub or an error page is not.
      expect(statSync(outfile).size).toBeGreaterThan(10 * 1024 * 1024);
      // ELF magic, not Mach-O: the target is the agents', not this laptop.
      const head = new Uint8Array(await Bun.file(outfile).slice(0, 4).arrayBuffer());
      expect([...head]).toEqual([0x7f, 0x45, 0x4c, 0x46]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 240_000);
});
