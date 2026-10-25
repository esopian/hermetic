/** The paired-fleets list: the one-fleet record moved into it, adding, removing. */
import { encodeMobileLink } from "@hermetic/core/shared";
import { FLEETS_KEY, loadFleets, NO_FLEETS, withFleet, withoutFleet } from "../../src/fleet/fleets.ts";
import { readPairingLink } from "../../src/fleet/pairing.ts";
import {
  FLEET_KEY_PREFIX,
  FleetStore,
  fleetRecordKey,
  loadChunked,
  memoryFile,
  memoryKv,
} from "../../src/fleet/store.ts";

function link(fleet_id: string, alias: string) {
  const read = readPairingLink(
    encodeMobileLink({
      fleet_id,
      alias,
      account_id: "123456789012",
      region: "us-west-2",
      tailnet: "hermetic.ts.net",
      agents: [{ name: "atlas" }],
    }),
  );
  if (!read.ok) throw new Error(read.error.title);
  return read.link;
}

test("a one-fleet record moves to its own key and becomes the active fleet", async () => {
  const kv = memoryKv();
  const legacy = new FleetStore({
    secure: kv,
    viewCache: memoryFile(),
    fetch: async () => new Response(null, { status: 503 }),
    now: () => "2026-10-24T00:00:00.000Z",
  });
  await legacy.pair(link("fxtr0001", "main"));
  await legacy.setPrimary("atlas");

  const index = await loadFleets(kv);
  expect(index).toEqual({
    active: "fxtr0001",
    fleets: [{ fleet_id: "fxtr0001", label: "main", tailnet: "hermetic.ts.net" }],
  });
  expect(await loadChunked(kv, FLEET_KEY_PREFIX)).toBeNull();
  const moved = new FleetStore({
    secure: kv,
    recordKey: fleetRecordKey("fxtr0001"),
    viewCache: memoryFile(),
    fetch: async () => new Response(null, { status: 503 }),
    now: () => "2026-10-24T00:00:00.000Z",
  });
  expect(await moved.load()).toBe(true);
  expect(moved.getState().primary).toBe("atlas");
  // Read again: the list itself now answers.
  expect(await loadFleets(kv)).toEqual(index);
});

test("nothing stored is no fleets; a failed keychain read throws", async () => {
  expect(await loadFleets(memoryKv())).toEqual(NO_FLEETS);
  const locked = memoryKv();
  locked.get = async () => {
    throw new Error("errSecInteractionNotAllowed");
  };
  await expect(loadFleets(locked)).rejects.toThrow();
});

test("adding brings a fleet to the front; removing the active one brings the next", () => {
  const one = withFleet(NO_FLEETS, link("fxtr0001", "main"));
  const two = withFleet(one, link("sg7k2m4p", "staging"));
  expect(two.active).toBe("sg7k2m4p");
  expect(two.fleets.map((f) => f.fleet_id)).toEqual(["fxtr0001", "sg7k2m4p"]);
  // Re-adding refreshes the entry in place.
  expect(withFleet(two, link("fxtr0001", "prod")).fleets.map((f) => f.label)).toEqual([
    "prod",
    "staging",
  ]);
  expect(withoutFleet(two, "sg7k2m4p")).toEqual({ active: "fxtr0001", fleets: one.fleets });
  expect(withoutFleet(one, "fxtr0001")).toEqual(NO_FLEETS);
});

test("a garbled list falls back to its first fleet, or none", async () => {
  const kv = memoryKv({
    [FLEETS_KEY]: JSON.stringify({
      active: "gone0000",
      fleets: [{ fleet_id: "fxtr0001", label: "main", tailnet: "hermetic.ts.net" }, { bad: 1 }],
    }),
  });
  expect((await loadFleets(kv)).active).toBe("fxtr0001");
  expect(await loadFleets(memoryKv({ [FLEETS_KEY]: "{" }))).toEqual(NO_FLEETS);
});
