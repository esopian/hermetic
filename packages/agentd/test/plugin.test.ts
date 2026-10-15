/**
 * The hermetic-files Hermes plugin's own suite (`plugins/hermetic-files/tests`),
 * run under `bun test` so CI holds the Python to it. Standard library only: it
 * needs a `python3` of 3.10 or later and nothing else, no Hermes and no box.
 * Without one it is skipped, and the skip says why.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const PLUGIN_DIR = join(import.meta.dir, "..", "plugins", "hermetic-files");

function python(): { bin: string; ok: boolean; why: string } {
  const bin = Bun.which("python3");
  if (bin === null) return { bin: "", ok: false, why: "no python3 on PATH" };
  const probe = Bun.spawnSync([bin, "-c", "import sys; print(sys.version_info >= (3, 10))"]);
  const ok = probe.exitCode === 0 && probe.stdout.toString().trim() === "True";
  return { bin, ok, why: ok ? "" : "python3 is older than 3.10" };
}

const PY = python();

describe.skipIf(!PY.ok)(
  `hermetic-files plugin under python3${PY.ok ? "" : ` (skipped: ${PY.why})`}`,
  () => {
    test("python3 -m unittest passes", () => {
      // The plugin's own overrides, never inherited from the caller's shell.
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && !k.startsWith("HERMETIC_FILES_")) env[k] = v;
      }
      const run = Bun.spawnSync([PY.bin, "-m", "unittest", "discover", "-s", "tests", "-v"], {
        cwd: PLUGIN_DIR,
        env: { ...env, PYTHONDONTWRITEBYTECODE: "1" },
      });
      const output = run.stderr.toString();
      if (run.exitCode !== 0) throw new Error(`python3 -m unittest exited ${run.exitCode}\n${output}`);
      expect(output).toMatch(/\nOK( \(skipped=\d+\))?\n/);
    }, 60_000);
  },
);
