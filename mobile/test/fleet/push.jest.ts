import type { MobilePushDevice } from "@hermetic/core/schema";
import { MobilePushDevice as MobilePushDeviceSchema } from "@hermetic/core/schema";
import { encodeMobileLink } from "@hermetic/core/shared";
import type { PushBox } from "../../src/gateway/push-registry.ts";
import { readPairingLink } from "../../src/fleet/pairing.ts";
import {
  DEVICE_ID_KEY,
  deviceId,
  hermeticdRegistrar,
  type PushRegistrar,
  PushSync,
  type PushTokenResult,
  randomId,
} from "../../src/fleet/push.ts";
import { FleetStore, memoryFile, memoryKv } from "../../src/fleet/store.ts";
import { fakeFetch, json } from "../helpers/fakes.ts";

const TOKEN = "ExponentPushToken[FIXTURE-token]";

async function pairedFleet() {
  const read = readPairingLink(
    encodeMobileLink({
      fleet_id: "fxtr0001",
      alias: "main",
      account_id: "123456789012",
      region: "us-west-2",
      tailnet: "hermetic.ts.net",
      agents: [{ name: "atlas" }, { name: "corvid" }, { name: "ember" }],
    }),
  );
  if (!read.ok) throw new Error("fixture link refused");
  const fleet = new FleetStore({
    secure: memoryKv(),
    viewCache: memoryFile(),
    fetch: fakeFetch(() => json({})).fetch,
    now: () => "2026-10-13T10:00:00.000Z",
  });
  await fleet.pair(read.link);
  return fleet;
}

function recorder(): PushRegistrar & {
  registered: { boxes: string[]; device: MobilePushDevice }[];
  unregistered: { boxes: string[]; id: string }[];
} {
  const registered: { boxes: string[]; device: MobilePushDevice }[] = [];
  const unregistered: { boxes: string[]; id: string }[] = [];
  const names = (boxes: readonly PushBox[]) => boxes.map((b) => b.instance);
  return {
    registered,
    unregistered,
    register: async (boxes, device) => {
      registered.push({ boxes: names(boxes), device });
      return boxes.map((b) => ({ instance: b.instance, ok: true as const }));
    },
    unregister: async (boxes, id) => {
      unregistered.push({ boxes: names(boxes), id });
      return boxes.map((b) => ({ instance: b.instance, ok: true as const }));
    },
  };
}

function sync(
  fleet: FleetStore,
  registrar: PushRegistrar,
  token: PushTokenResult = { ok: true, token: TOKEN },
) {
  return new PushSync({
    fleet,
    registrar,
    deviceId: async () => "device-1",
    token: async () => token,
    platform: "ios",
    appVersion: "0.1.0",
  });
}

describe("PushSync", () => {
  test("enable registers a valid MobilePushDevice with every listened box", async () => {
    const fleet = await pairedFleet();
    const reg = recorder();
    const status = await sync(fleet, reg).enable();
    expect(status).toMatchObject({ state: "on" });
    expect(reg.registered).toHaveLength(1);
    expect(reg.registered[0]?.boxes).toEqual(["atlas", "corvid", "ember"]);
    const device = reg.registered[0]?.device;
    expect(MobilePushDeviceSchema.safeParse(device).success).toBe(true);
    expect(device).toEqual({
      device_id: "device-1",
      token: TOKEN,
      platform: "ios",
      app_version: "0.1.0",
      listening: "all",
    });
  });

  test("a listening change registers the kept boxes and unregisters the dropped one", async () => {
    const fleet = await pairedFleet();
    const reg = recorder();
    const push = sync(fleet, reg);
    await push.enable();
    await fleet.setListening("corvid", false);
    await push.sync();
    expect(reg.registered[1]?.boxes).toEqual(["atlas", "ember"]);
    expect(reg.unregistered).toEqual([{ boxes: ["corvid"], id: "device-1" }]);
  });

  test("disable unregisters everywhere it registered, plus any extra boxes", async () => {
    const fleet = await pairedFleet();
    const reg = recorder();
    const push = sync(fleet, reg);
    await push.enable();
    const status = await push.disable([{ instance: "granite", host: "g.hermetic.ts.net" }]);
    expect(status).toEqual({ state: "off" });
    expect(push.enabled()).toBe(false);
    expect(reg.unregistered[0]?.boxes.sort()).toEqual(["atlas", "corvid", "ember", "granite"]);
    // Off stays off: a later sync registers nothing.
    await push.sync();
    expect(reg.registered).toHaveLength(1);
  });

  test("no token: unavailable with the reason, and nothing registered", async () => {
    const fleet = await pairedFleet();
    const reg = recorder();
    const status = await sync(fleet, reg, { ok: false, reason: "no-project-id" }).enable();
    expect(status).toEqual({ state: "unavailable", reason: "no-project-id" });
    expect(reg.registered).toEqual([]);
  });

  test("one box refusing does not stop the others (hermeticd registrar)", async () => {
    const fleet = await pairedFleet();
    const f = fakeFetch((url) => {
      if (url.includes("corvid")) throw new TypeError("Network request failed");
      return json({ ok: true });
    });
    const status = await sync(fleet, hermeticdRegistrar(f.fetch)).enable();
    expect(status.state).toBe("on");
    if (status.state !== "on") return;
    expect(status.boxes.filter((b) => b.ok).map((b) => b.instance)).toEqual(["atlas", "ember"]);
    expect(status.boxes.find((b) => b.instance === "corvid")).toMatchObject({
      ok: false,
      code: "HERMETICD_UNAVAILABLE",
    });
    const posted = f.calls.filter((c) => c.method === "POST");
    expect(posted.map((c) => c.url)).toContain(
      "http://fxtr0001-atlas.hermetic.ts.net:7434/push/devices",
    );
  });
});

describe("device id", () => {
  test("minted once and kept", async () => {
    const kv = memoryKv();
    const a = await deviceId(kv);
    expect(a).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(await deviceId(kv)).toBe(a);
    expect(kv.map.get(DEVICE_ID_KEY)).toBe(a);
  });

  test("a stored value that is not an id is replaced", async () => {
    const kv = memoryKv({ [DEVICE_ID_KEY]: "not/an id" });
    expect(await deviceId(kv)).not.toBe("not/an id");
  });

  test("the fallback is a v4 uuid", () => {
    const c = globalThis.crypto;
    // @ts-expect-error -- hide crypto to reach the fallback
    globalThis.crypto = undefined;
    try {
      expect(randomId(() => 0.5)).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    } finally {
      globalThis.crypto = c;
    }
  });
});
