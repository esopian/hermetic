/**
 * `FleetSwitch`: several paired fleets, one in front. Adding a fleet, switching
 * back, signing out of one, and a locked keychain at launch, over the fixture
 * kit's network with the OS as doubles.
 */
import { encodeMobileLink } from "@hermetic/core/shared";
import { act, render } from "@testing-library/react-native";
import { type FixtureKit, fixtureKit } from "../../src/fixture/index.ts";
import type { Notifier } from "../../src/fleet/alerts.ts";
import { type FleetContextValue, useFleetContext } from "../../src/fleet/FleetProvider.tsx";
import { FleetSwitch, type FleetSwitchDeps } from "../../src/fleet/FleetSwitch.tsx";
import { FLEETS_KEY } from "../../src/fleet/fleets.ts";
import { readPairingLink } from "../../src/fleet/pairing.ts";
import { hermeticdRegistrar } from "../../src/fleet/push.ts";
import { type KvStorage, memoryFile, memoryKv, type TextFile } from "../../src/fleet/store.ts";
import { flush } from "../helpers/fakes.ts";

const NOW = "2026-10-24T10:00:00.000Z";

const notifier: Notifier = {
  registerCategories: async () => {},
  setForegroundHandler: () => {},
  onTap: () => () => {},
  presented: async () => [],
  presentLocal: async () => {},
  setBadge: async () => {},
  pushToken: async () => ({ ok: true, token: "ExponentPushToken[FIXTURE-switch]" }),
};

async function settle() {
  for (let i = 0; i < 20; i++) await act(flush);
}

async function setup(secure: KvStorage = memoryKv(), initial = "active") {
  const kit = fixtureKit("1", () => NOW) as FixtureKit;
  let state = initial;
  const listeners = new Set<(s: string) => void>();
  const appState = {
    current: () => state,
    subscribe: (fn: (s: string) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    set: (next: string) => {
      state = next;
      for (const fn of [...listeners]) fn(next);
    },
  };
  const files = new Map<string, { viewCache: TextFile; inboxFile: TextFile }>();
  const deps: FleetSwitchDeps = {
    secure,
    fleetFiles: (id) => {
      const key = id ?? "none";
      if (!files.has(key)) files.set(key, { viewCache: memoryFile(), inboxFile: memoryFile() });
      return files.get(key) as { viewCache: TextFile; inboxFile: TextFile };
    },
    fetch: kit.fetch,
    openSocket: () => {
      throw new Error("no socket in fixture mode");
    },
    chat: kit.chat,
    notifier,
    registrar: hermeticdRegistrar(kit.fetch),
    background: null,
    appState,
    platform: "ios",
    appVersion: "0.1.0",
    operatorTailnet: null,
    fixture: null,
    now: () => NOW,
  };
  const ctx: { current: FleetContextValue | null } = { current: null };
  function Probe() {
    ctx.current = useFleetContext();
    return null;
  }
  await render(
    <FleetSwitch deps={deps}>
      <Probe />
    </FleetSwitch>,
  );
  await settle();
  const value = () => {
    if (!ctx.current) throw new Error("not rendered");
    return ctx.current;
  };
  return { kit, appState, value, ctx };
}

const linkOf = (text: string) => {
  const read = readPairingLink(text);
  if (!read.ok) throw new Error(read.error.title);
  return read.link;
};

const staging = linkOf(
  encodeMobileLink({
    fleet_id: "sg7k2m4p",
    alias: "staging",
    account_id: "123456789012",
    region: "us-west-2",
    tailnet: "hermetic.ts.net",
    agents: [{ name: "kestrel" }],
  }),
);

test("a second fleet is added beside the first; switching back keeps each fleet's choices", async () => {
  const secure = memoryKv();
  const s = await setup(secure);
  expect(s.value().status).toBe("unpaired");

  await act(async () => {
    expect(await s.value().pair(linkOf(s.kit.link))).toBe("switched");
  });
  await settle();
  expect(s.value().status).toBe("paired");
  await act(() => s.value().setPrimary("atlas"));
  expect(s.value().needsPrimary).toBe(false);

  await act(async () => {
    expect(await s.value().pair(staging)).toBe("switched");
  });
  await settle();
  expect(s.value().fleet.getState().link?.payload.fleet_id).toBe("sg7k2m4p");
  expect(s.value().needsPrimary).toBe(true);
  expect(s.value().fleets.map((f) => f.label)).toEqual(["main", "staging"]);

  await act(() => s.value().switchFleet("fxtr0001"));
  await settle();
  expect(s.value().fleet.getState().link?.payload.fleet_id).toBe("fxtr0001");
  // The first fleet's primary came back with it.
  expect(s.value().primary).toBe("atlas");
  expect(JSON.parse(secure.map.get(FLEETS_KEY) ?? "{}").active).toBe("fxtr0001");
});

test("signing out of one fleet brings the next to the front; the last leaves the phone unpaired", async () => {
  const s = await setup();
  await act(async () => {
    await s.value().pair(linkOf(s.kit.link));
  });
  await settle();
  await act(async () => {
    await s.value().pair(staging);
  });
  await settle();

  await act(() => s.value().signOut());
  await settle();
  expect(s.value().status).toBe("paired");
  expect(s.value().fleet.getState().link?.payload.fleet_id).toBe("fxtr0001");
  expect(s.value().fleets.map((f) => f.fleet_id)).toEqual(["fxtr0001"]);

  await act(() => s.value().signOut());
  await settle();
  expect(s.value().status).toBe("unpaired");
  expect(s.value().fleets).toEqual([]);
});

test("a keychain the locked phone keeps shut is not 'unpaired': it is read again in front", async () => {
  const secure = memoryKv();
  const first = await setup(secure);
  await act(async () => {
    await first.value().pair(linkOf(first.kit.link));
  });
  await settle();

  // A background launch: every keychain read fails until the app comes to the front.
  let locked = true;
  const get = secure.get;
  secure.get = async (key) => {
    if (locked) throw new Error("errSecInteractionNotAllowed");
    return get(key);
  };
  const s = await setup(secure, "background");
  expect(s.ctx.current).toBeNull();
  locked = false;
  await act(async () => s.appState.set("active"));
  await settle();
  expect(s.value().status).toBe("paired");
  expect(s.value().fleet.getState().link?.payload.fleet_id).toBe("fxtr0001");
});
