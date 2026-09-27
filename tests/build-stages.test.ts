/**
 * `scripts/stages.ts`: the build step that puts the bootstrap stages next to the
 * binaries it just compiled.
 *
 * It is tested rather than merely run because the failure it prevents is
 * silent: `locateStages` finds an installed CLI's stages by looking for a
 * `stages/` directory beside the executable, so a build that shipped none would
 * produce a `hermetic` that publishes releases no box can boot — and nothing
 * about the binary would say so.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTD_STAGES, copyStages } from "../scripts/stages.ts";

const tmp: string[] = [];
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "hermetic-build-"));
  tmp.push(d);
  return d;
}

/** A checkout with the given files under `packages/agentd/stages`. */
function checkout(files: Record<string, string>): string {
  const root = dir();
  mkdirSync(join(root, AGENTD_STAGES), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(root, AGENTD_STAGES, name), body);
  }
  return root;
}

describe("copyStages", () => {
  test("copies every stage into <outDir>/stages, contents and all", () => {
    const root = checkout({
      "00-preflight.sh": "#!/usr/bin/env bash\nexit 0\n",
      "01-tailscale.sh": "#!/usr/bin/env bash\nexit 0\n",
    });
    const out = dir();

    expect(copyStages(root, out).sort()).toEqual(["00-preflight.sh", "01-tailscale.sh"]);
    expect(readdirSync(join(out, "stages")).sort()).toEqual(["00-preflight.sh", "01-tailscale.sh"]);
    expect(readFileSync(join(out, "stages", "00-preflight.sh"), "utf8")).toBe(
      "#!/usr/bin/env bash\nexit 0\n",
    );
  });

  test("copies only .sh files: a README beside them is not a stage", () => {
    const root = checkout({
      "00-preflight.sh": "#!/usr/bin/env bash\n",
      "README.md": "these are the stages\n",
      "notes.txt": "scratch\n",
    });
    const out = dir();
    expect(copyStages(root, out)).toEqual(["00-preflight.sh"]);
    expect(readdirSync(join(out, "stages"))).toEqual(["00-preflight.sh"]);
  });

  test("works for both destination shapes: dist/ and dist/<target>/", () => {
    const root = checkout({ "00-preflight.sh": "#!/usr/bin/env bash\n" });
    const dist = dir();
    copyStages(root, dist);
    copyStages(root, join(dist, "bun-linux-arm64"));
    expect(existsSync(join(dist, "stages", "00-preflight.sh"))).toBe(true);
    expect(existsSync(join(dist, "bun-linux-arm64", "stages", "00-preflight.sh"))).toBe(true);
  });

  test("refuses when the source directory does not exist", () => {
    expect(() => copyStages(dir(), dir())).toThrow(/does not exist/);
  });

  test("refuses a source directory with no .sh files rather than shipping nothing", () => {
    const root = checkout({ "README.md": "no stages here yet\n" });
    const out = dir();
    expect(() => copyStages(root, out)).toThrow(/no \.sh files/);
    expect(existsSync(join(out, "stages"))).toBe(false);
  });

  test("this checkout really has stages to ship — the build is not vacuously fine", () => {
    const root = new URL("..", import.meta.url).pathname;
    expect(existsSync(join(root, AGENTD_STAGES))).toBe(true);
    expect(copyStages(root, dir()).length).toBeGreaterThan(0);
  });
});
