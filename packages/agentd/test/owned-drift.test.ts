/**
 * Drift on the keys hermetic owns (#53, §6.4): reported when a key hermetic set
 * in the managed file moves, never for a key it did not set, and never while
 * an apply is still between fetch and files.
 */
import { describe, expect, test } from "bun:test";
import { HERMES_MANAGED_CONFIG, HERMES_USER_CONFIG } from "@hermetic/core/shared";
import { APPLIED_CONFIG_PATH, MANIFEST_PATH } from "../src/manifest.ts";
import { describeOwnedDrift, readOwnedDrift } from "../src/owned-drift.ts";
import { FakeHost } from "./fake-host.ts";
import { makeManifest } from "./fixtures.ts";

const MANAGED = 'model:\n  provider: "bedrock"\nupdates:\n  check: false\n';
const OWNED = { "model.provider": "bedrock", "updates.check": "false" };

/** A box that has fetched and applied a manifest recording `OWNED`. */
function box(options: { managed?: string | null; applied?: string; owned?: boolean } = {}) {
  const host = new FakeHost();
  const manifest = makeManifest({ hermesConfigBody: MANAGED });
  host.seed(
    MANIFEST_PATH,
    JSON.stringify(options.owned === false ? manifest : { ...manifest, hermes_owned: OWNED }),
  );
  host.seed(
    APPLIED_CONFIG_PATH,
    JSON.stringify({ config_hash: options.applied ?? manifest.config_hash, applied_at: "x" }),
  );
  if (options.managed !== null) host.seed(HERMES_MANAGED_CONFIG, options.managed ?? MANAGED);
  host.seed(HERMES_USER_CONFIG, 'model:\n  default: "seed-model"\n');
  return host;
}

describe("readOwnedDrift", () => {
  test("a box whose managed file says what was rendered has no drift", async () => {
    expect(await readOwnedDrift(box())).toEqual([]);
  });

  test("an owned key changed in the managed file is reported", async () => {
    const host = box({ managed: 'model:\n  provider: "openrouter"\nupdates:\n  check: false\n' });
    expect(await readOwnedDrift(host)).toEqual([
      { key: "model.provider", expected: "bedrock", found: "openrouter" },
    ]);
  });

  test("an owned key removed from the managed file is reported as missing", async () => {
    const host = box({ managed: 'model:\n  provider: "bedrock"\n' });
    expect(await readOwnedDrift(host)).toEqual([
      { key: "updates.check", expected: "false", found: null },
    ]);
  });

  /**
   * The agent's own edits are not drift: a changed `model.default` in its user
   * config, and even a key added to the managed file that hermetic never set.
   */
  test("a key hermetic did not set is never reported", async () => {
    const host = box({ managed: MANAGED + "agent:\n  max_turns: 9\n" });
    host.seed(HERMES_USER_CONFIG, 'model:\n  default: "agent-chosen"\nagent:\n  max_turns: 3\n');
    expect(await readOwnedDrift(host)).toEqual([]);
  });

  /** Between fetch and apply the old file is on disk; that is not drift. */
  test("nothing is compared until the fetched manifest has been applied", async () => {
    const host = box({ managed: 'model:\n  provider: "openrouter"\n', applied: "0000000000000000" });
    expect(await readOwnedDrift(host)).toBeNull();
  });

  test("a manifest from before hermes_owned is not watched", async () => {
    expect(await readOwnedDrift(box({ owned: false, managed: "" }))).toBeNull();
  });

  test("a missing managed file on an applied box is drift on every owned key", async () => {
    const drift = await readOwnedDrift(box({ managed: null }));
    expect(drift?.map((d) => d.key)).toEqual(["model.provider", "updates.check"]);
  });
});

describe("describeOwnedDrift", () => {
  test("names each key with what was rendered and what the box has, clipped", () => {
    const detail = describeOwnedDrift([
      { key: "model.provider", expected: "bedrock", found: "openrouter" },
      { key: "platform_hints.hermetic.replace", expected: "x".repeat(200), found: null },
    ]);
    expect(detail).toContain('model.provider (expected "bedrock", found "openrouter")');
    expect(detail).toContain("platform_hints.hermetic.replace (expected");
    expect(detail).toContain("missing)");
    expect(detail).not.toContain("x".repeat(61));
  });
});
