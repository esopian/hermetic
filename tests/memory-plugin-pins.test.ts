/**
 * The memory plugins hermeticd checks out (`MEMORY_PROVIDERS[id].plugin`)
 * against upstream's `plugin-catalog/<name>.yaml` at the Hermes ref the fleet
 * pins (`BUILD_VERSIONS.hermes_ref`).
 *
 * The catalog is recorded here by hand, one row per `hermes_ref`, so the
 * suite needs no network and no upstream tree. Bumping `hermes_ref` fails
 * this until someone reads the new ref's catalog and records it; a pin that
 * then differs fails until it is moved or listed in `DIVERGES` with the
 * decision that keeps it.
 */
import { describe, expect, test } from "bun:test";
import { BUILD_VERSIONS } from "../packages/core/src/build-versions.ts";
import {
  MEMORY_PROVIDERS,
  MEMORY_PROVIDER_IDS,
  hermesMemoryProviderName,
} from "../packages/core/src/shared/memory-providers.ts";

interface CatalogEntry {
  readonly repo: string;
  readonly sha: string;
  /** The yaml's `subdir`; null when it names none (the repo root). */
  readonly subdir: string | null;
  readonly version: string;
}

/** `plugin-catalog/{holographic,openviking,honcho,hindsight}.yaml`, keyed by catalog name. */
const CATALOG: Readonly<Record<string, Readonly<Record<string, CatalogEntry>>>> = {
  "v0.23.1": {
    holographic: {
      repo: "https://github.com/itpartypattaya/hermes-plugin-holographic",
      sha: "f75c636a2865459600e0a5d8470108032d8f8860",
      subdir: null,
      version: "0.26.5",
    },
    openviking: {
      repo: "https://github.com/volcengine/OpenViking",
      sha: "e855796c83f9eb575d9b0f3082926660730f6a63",
      subdir: "examples/hermes-plugin",
      version: "2.1.2",
    },
    honcho: {
      repo: "https://github.com/plastic-labs/honcho",
      sha: "894b88321872e01702a1aa638ddfdde6ad60f173",
      subdir: "hermes-plugin-honcho",
      version: "1.2.0",
    },
    hindsight: {
      repo: "https://github.com/vectorize-io/hindsight",
      sha: "f14cc1eb5624b0374cb4d82768eb2e0b9c21ae24",
      subdir: "hindsight-integrations/hermes",
      version: "1.2.4",
    },
  },
};

/**
 * Pins deliberately not the catalog's, with the decision. hindsight (D6 of
 * the v0.23.1 adoption): stays on plugin 1.0.1 and `hindsight-client==0.10.3`
 * for this release; moving it moves the client and the server pin together.
 */
const DIVERGES: Readonly<Record<string, string>> = {
  hindsight: "D6: plugin 1.0.1 kept for the v0.23.1 adoption",
};

const row = CATALOG[BUILD_VERSIONS.hermes_ref];
const withPlugin = MEMORY_PROVIDER_IDS.filter((id) => MEMORY_PROVIDERS[id].plugin !== null);

describe("memory plugin pins against the catalog at BUILD_VERSIONS.hermes_ref", () => {
  test("the pinned hermes_ref has a recorded catalog row", () => {
    expect(
      row,
      `record plugin-catalog/*.yaml at ${BUILD_VERSIONS.hermes_ref} in CATALOG`,
    ).toBeDefined();
  });

  for (const id of withPlugin) {
    const name = hermesMemoryProviderName(id);
    test(`${id}: the plugin pin is the catalog's${name in DIVERGES ? " (an expected divergence)" : ""}`, () => {
      const entry = row?.[name];
      expect(entry, `${name} is in the catalog at ${BUILD_VERSIONS.hermes_ref}`).toBeDefined();
      const plugin = MEMORY_PROVIDERS[id].plugin!;
      const pin = {
        repo: plugin.repo,
        sha: plugin.sha,
        subdir: plugin.subdir,
        version: plugin.version,
      };
      if (name in DIVERGES) {
        // A divergence that no longer diverges is a stale exception: drop it.
        expect(pin.sha).not.toBe(entry!.sha);
        expect(pin.repo).toBe(entry!.repo);
        expect(pin.subdir).toBe(entry!.subdir);
      } else {
        expect(pin).toEqual(entry!);
      }
    });
  }

  test("every catalog plugin hermetic offers has a pin, and only those have one", () => {
    const pinned = withPlugin.map((id) => hermesMemoryProviderName(id)).sort();
    expect(pinned).toEqual(Object.keys(row ?? {}).sort());
  });
});
