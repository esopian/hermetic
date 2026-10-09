/**
 * The fleet lens's spelling (`fleet-nav.ts`). The rule worth pinning is the
 * `null`: a Settings or Chat hash must not be read as "agents", or a detour to
 * either would drop an operator back on the other lens.
 */
import { describe, expect, test } from "bun:test";
import {
  FLEET_DESTROYED_HASH,
  FLEET_VOLUMES_HASH,
  LEGACY_VOLUMES_HASH,
  fleetLensHash,
  parseFleetLensHash,
} from "../src/nav/fleet-nav.ts";

describe("parseFleetLensHash", () => {
  test("the volumes lens has one address, and the old view's still reaches it", () => {
    expect(FLEET_VOLUMES_HASH).toBe("#fleet/volumes");
    expect(parseFleetLensHash(FLEET_VOLUMES_HASH)).toBe("volumes");
    expect(parseFleetLensHash(LEGACY_VOLUMES_HASH)).toBe("volumes");
  });

  test("the destroyed lens has its own address, and each lens round-trips", () => {
    expect(FLEET_DESTROYED_HASH).toBe("#fleet/destroyed");
    expect(parseFleetLensHash(FLEET_DESTROYED_HASH)).toBe("destroyed");
    for (const lens of ["agents", "volumes", "destroyed"] as const) {
      expect(parseFleetLensHash(fleetLensHash(lens))).toBe(lens);
    }
  });

  test("every other fleet address is the agents lens", () => {
    for (const hash of ["", "#", "#fleet", "#agent/lumen", "#agent/lumen/desktop"]) {
      expect(parseFleetLensHash(hash)).toBe("agents");
    }
  });

  test("Settings and Chat hashes say nothing about the lens", () => {
    for (const hash of ["#settings", "#settings/providers", "#chat", "#chat/lumen/main"]) {
      expect(parseFleetLensHash(hash)).toBeNull();
    }
  });
});
