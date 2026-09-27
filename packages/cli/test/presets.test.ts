/**
 * `hermetic presets show|set` and `agent create --preset` (§9, §4.6), run as a
 * real process against the fixture, in a home of their own so the loadout this
 * file writes is nobody else's.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { presetsView } from "@hermetic/core";
import { renderPresets } from "../src/commands/presets.ts";

const MAIN = Bun.fileURLToPath(new URL("../src/main.ts", import.meta.url));
const HOME = mkdtempSync(join(tmpdir(), "hermetic-cli-presets-"));

async function run(...args: string[]) {
  const proc = Bun.spawn([process.execPath, MAIN, ...args], {
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

describe("presets show / set", () => {
  test("a laptop with nothing saved shows the built-in loadout", async () => {
    const { code, stdout } = await run("presets", "show", "--json");
    expect(code).toBe(0);
    const view = JSON.parse(stdout);
    expect(view.source).toBe("builtin");
    expect(view.loadout).toEqual(["light", "standard", "heavy", "gpu"]);
    expect(view.default).toBe("standard");
  });

  test("flags, a file, and reset each write this laptop's row", async () => {
    let r = await run(
      "presets",
      "set",
      "--loadout",
      "light,standard,-,gpu-m",
      "--default",
      "gpu-m",
      "--json",
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      loadout: ["light", "standard", null, "gpu-m"],
      default: "gpu-m",
    });

    const file = join(HOME, "presets.json");
    writeFileSync(
      file,
      JSON.stringify({
        custom: [{ id: "research", name: "research", size: "large", volume_gib: 300, root_gib: 60 }],
        loadout: ["light", "standard", "research", "gpu-m"],
      }),
    );
    r = await run("presets", "set", "--file", file, "--json");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).loadout[2]).toBe("research");

    // A later process reads what this one wrote: it is in the fixture database.
    r = await run("presets", "show");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("loadout  light · standard · research · gpu-m*");
    expect(r.stdout).toContain("research");

    r = await run("presets", "set", "--reset", "--json");
    expect(JSON.parse(r.stdout).source).toBe("builtin");
  });

  test("a default outside the loadout is refused as a validation error", async () => {
    const { code, stderr } = await run("presets", "set", "--default", "micro", "--json");
    expect(code).toBe(2);
    expect(stderr).toContain("not in the loadout");
  });
});

describe("agent create --preset", () => {
  test("an unknown preset is refused before anything is created", async () => {
    const { code, stderr } = await run("agent", "create", "wren", "--preset", "nope", "--json");
    expect(code).not.toBe(0);
    expect(stderr).toContain("no create preset nope");
  });

  test("a named preset creates", async () => {
    const { code } = await run("agent", "create", "wren", "--preset", "heavy", "--json");
    expect(code).toBe(0);
  });
});

test("the human table marks the default and prices each preset", () => {
  const out = renderPresets(presetsView(null));
  expect(out).toContain("loadout  light · standard* · heavy · gpu");
  expect(out).toMatch(
    /standard\s+Standard\s+cpu\s+medium\s+t4g\.2xlarge\s+100 GiB\s+40 GiB\s+\$207\s+2 \*/,
  );
});
