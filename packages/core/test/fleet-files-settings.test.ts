/**
 * The fleet's files settings on the laptop side: `settings.set` merging them
 * onto `_fleet`, bounding them on the write, and republishing the fleet
 * manifest — the only way the boxes hear about them — exactly when the
 * effective values move. The box's half is the seam in `tests/seams.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { FIXTURE_CONFIG, MemoryBackend, seedFixtureFleet } from "../src/backend/memory.ts";
import { readFleetManifest } from "../src/release/artifacts.ts";
import { FLEET_MANIFEST_KEY, resolveFilesSettings } from "../src/schema/index.ts";
import { FILES_LIMITS, FILES_RETENTION_DAYS } from "../src/shared/files.ts";
import { testHermetic } from "./helpers.ts";

function fleet() {
  const backend = seedFixtureFleet(new MemoryBackend({ directory: "seeded" }));
  const hermetic = testHermetic({ backend, config: FIXTURE_CONFIG });
  return { backend, hermetic };
}

describe("settings.set files", () => {
  test("a change is merged key by key and republished with only files moved", async () => {
    const { backend, hermetic } = fleet();
    const before = (await readFleetManifest(backend.artifacts))!;
    expect(before.files).toBeUndefined();

    const result = await hermetic.settings.set({ files: { require_cap: true } });
    expect(result.warning).toBeUndefined();
    expect(result.settings.files).toEqual({ require_cap: true });

    const after = (await readFleetManifest(backend.artifacts))!;
    expect(after.files).toEqual({ require_cap: true });
    expect(after.hermeticd).toEqual(before.hermeticd);
    expect(after.auto_update_hermeticd).toBe(before.auto_update_hermeticd);

    // A second write states one key and keeps the other.
    await hermetic.settings.set({ files: { retention_days: 14 } });
    expect(backend.fleetItem!.settings!.files).toEqual({ require_cap: true, retention_days: 14 });
    const again = (await readFleetManifest(backend.artifacts))!;
    expect(resolveFilesSettings(again)).toEqual({
      require_cap: true,
      max_bytes: FILES_LIMITS.fileBytes,
      retention_days: 14,
    });

    const history = await backend.store.events.query("_fleet");
    expect(history.some((e) => e.detail?.includes("files.require_cap") === true)).toBe(true);
    expect(
      history.some(
        (e) =>
          e.action === "settings.files" &&
          e.detail?.includes("the fleet manifest now says so") === true,
      ),
    ).toBe(true);
  });

  test("stating what absence already means writes nothing to the bucket", async () => {
    const { backend, hermetic } = fleet();
    const manifest = backend.objects.get(FLEET_MANIFEST_KEY);
    backend.resetMutations();
    await hermetic.settings.set({
      files: { require_cap: false, retention_days: FILES_RETENTION_DAYS.default },
    });
    expect(backend.mutations.filter((m) => m.startsWith("artifacts."))).toEqual([]);
    expect(backend.objects.get(FLEET_MANIFEST_KEY)).toEqual(manifest);
  });

  test("values out of bounds, or none at all, are refused before anything is written", async () => {
    const { backend, hermetic } = fleet();
    const bad = [
      { max_bytes: FILES_LIMITS.fileBytes + 1 },
      { max_bytes: 0 },
      { max_bytes: 1.5 },
      { retention_days: FILES_RETENTION_DAYS.min - 1 },
      { retention_days: FILES_RETENTION_DAYS.max + 1 },
      {},
    ];
    for (const files of bad) {
      backend.resetMutations();
      await expect(hermetic.settings.set({ files })).rejects.toThrow();
      expect(backend.mutations).toEqual([]);
    }
    // The bounds themselves are accepted.
    const ok = await hermetic.settings.set({
      files: { max_bytes: FILES_LIMITS.fileBytes, retention_days: FILES_RETENTION_DAYS.max },
    });
    expect(ok.settings.files).toEqual({
      max_bytes: FILES_LIMITS.fileBytes,
      retention_days: FILES_RETENTION_DAYS.max,
    });
  });

  test("a manifest that cannot be republished is a warning, never a failed write", async () => {
    const { backend, hermetic } = fleet();
    const manifest = (await readFleetManifest(backend.artifacts))!;
    manifest.hermeticd.files["hermeticd"]!.key = "config/atlas/bundle.tar.gz";
    backend.objects.set(FLEET_MANIFEST_KEY, new TextEncoder().encode(JSON.stringify(manifest)));

    const result = await hermetic.settings.set({ files: { max_bytes: 8 * 1024 * 1024 } });

    expect(backend.fleetItem!.settings!.files).toEqual({ max_bytes: 8 * 1024 * 1024 });
    expect(result.warning).toContain("files settings are saved as no cap, 8 MiB, 7 d");
    expect(result.warning).toContain("MANIFEST_REFUSED");
    expect(result.warning).toContain("hermetic artifacts push");
  });
});
