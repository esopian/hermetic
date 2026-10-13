/**
 * Fixture mode: built only when the flag says so, and, when it is, the real
 * stores run over it unchanged.
 */
import { MobileFleetView } from "@hermetic/core/schema";
import {
  FIXTURE_FLEET_ID,
  FIXTURE_PUSH_TOKEN,
  FIXTURE_TAILNET,
  fixtureKit,
} from "../../src/fixture/index.ts";
import { createHermeticClient } from "../../src/client/client.ts";
import { readPairingLink } from "../../src/fleet/pairing.ts";
import { hermeticdRegistrar, PushSync } from "../../src/fleet/push.ts";
import { FleetStore, memoryFile, memoryKv } from "../../src/fleet/store.ts";
import { probeTailscale } from "../../src/gateway/tailscale.ts";
import { InboxStore } from "../../src/inbox/store.ts";

const NOW = "2026-10-13T10:00:00.000Z";

function kit() {
  const k = fixtureKit("1", () => NOW);
  if (!k) throw new Error("fixture kit not built with the flag set");
  return k;
}

async function pairedFleet(k = kit()) {
  const read = readPairingLink(k.link);
  if (!read.ok) throw new Error(read.error.title);
  const fleet = new FleetStore({
    secure: memoryKv(),
    viewCache: memoryFile(),
    fetch: k.fetch,
    now: () => NOW,
  });
  await fleet.pair(read.link);
  return fleet;
}

describe("fixtureKit", () => {
  test("is nothing without the flag", () => {
    expect(fixtureKit(undefined)).toBeNull();
    expect(fixtureKit("")).toBeNull();
    expect(fixtureKit("0")).toBeNull();
    expect(fixtureKit("true")).toBeNull();
  });

  test("its link pairs with the fixture fleet: main, eleven agents, corvid on a suffixed host", () => {
    const read = readPairingLink(kit().link);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.link.label).toBe("main");
    expect(read.link.payload.fleet_id).toBe(FIXTURE_FLEET_ID);
    expect(read.link.payload.tailnet).toBe(FIXTURE_TAILNET);
    expect(read.link.payload.agents.map((a) => a.name)).toEqual([
      "atlas",
      "corvid",
      "ember",
      "fathom",
      "granite",
      "heron",
      "ibis",
      "juniper",
      "kestrel",
      "lumen",
      "marrow",
    ]);
    expect(read.link.payload.agents.find((a) => a.name === "corvid")?.host).toBe(
      "fxtr0001-corvid-2.hermetic.ts.net",
    );
  });

  test("GET /fleet answers a valid view, and the fleet store takes it", async () => {
    const k = kit();
    const response = await k.fetch("http://fxtr0001-atlas.hermetic.ts.net:7434/fleet");
    expect(MobileFleetView.safeParse(await response.json()).success).toBe(true);
    const fleet = await pairedFleet(k);
    expect(await fleet.refresh()).toBe(true);
    const agents = fleet.agents();
    expect(agents).toHaveLength(11);
    expect(agents.find((a) => a.name === "heron")).toMatchObject({ status: "error", live: true });
    // The first view narrows the listening default to the ready agents.
    expect(fleet.listened()).toEqual([
      "atlas",
      "corvid",
      "fathom",
      "granite",
      "ibis",
      "kestrel",
      "lumen",
    ]);
  });

  test("the Tailscale switch is what the real probe sees", async () => {
    const k = kit();
    const hosts = ["fxtr0001-atlas.hermetic.ts.net", "fxtr0001-ibis.hermetic.ts.net"];
    expect((await probeTailscale({ hosts, fetch: k.fetch })).status).toBe("ok");
    k.tailscale.set("off");
    expect((await probeTailscale({ hosts, fetch: k.fetch })).status).toBe("off");
    k.tailscale.set("unreachable");
    expect((await probeTailscale({ hosts, fetch: k.fetch })).status).toBe("unreachable");
  });

  test("push registration lands in the memory registry, and leaves it", async () => {
    const k = kit();
    const fleet = await pairedFleet(k);
    await fleet.refresh();
    const push = new PushSync({
      fleet,
      registrar: hermeticdRegistrar(k.fetch),
      deviceId: async () => "phone-1",
      rotateDeviceId: async () => "phone-2",
      token: async () => ({ ok: true, token: k.pushToken }),
      platform: "ios",
      appVersion: "0.1.0",
      previews: () => false,
    });
    const status = await push.enable();
    expect(status.state).toBe("on");
    expect(k.registry.devicesOn("fxtr0001-atlas.hermetic.ts.net")).toEqual([
      expect.objectContaining({
        device_id: "phone-1",
        token: FIXTURE_PUSH_TOKEN,
        listening: "all",
        previews: false,
      }),
    ]);
    // A stopped agent is not listened, so it was never asked.
    expect(k.registry.devicesOn("fxtr0001-juniper.hermetic.ts.net")).toEqual([]);
    await push.disable();
    expect(k.registry.devicesOn("fxtr0001-atlas.hermetic.ts.net")).toEqual([]);
  });

  test("the canned chat client answers the fleet's swarms", async () => {
    const k = kit();
    const swarm = await k.chat.swarm({
      instance: "atlas",
      baseUrl: "https://fxtr0001-atlas.hermetic.ts.net/",
      fleet_id: FIXTURE_FLEET_ID,
    });
    expect(swarm.instance).toBe("atlas");
  });

  test("chat: a sent prompt is one row, and the conversation observes live from the start", async () => {
    const k = kit();
    const fleet = await pairedFleet(k);
    const client = createHermeticClient({
      fleet,
      inbox: new InboxStore(memoryFile(), () => NOW),
      fetch: k.fetch,
      openSocket: () => {
        throw new Error("no socket in fixture mode");
      },
      chat: k.chat,
    });
    const until = async (ok: () => boolean, ms = 8_000) => {
      const end = Date.now() + ms;
      while (!ok()) {
        if (Date.now() > end) throw new Error("timed out");
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    try {
      const target = { instance: "atlas", bot: "scribe", session: null };
      client.chat.open(target);
      await until(() => client.chat.view(target).history === "ready");
      // Not "Reconnecting…": the fixture's observation has its activity store.
      expect(client.chat.view(target).observe).toBe("live");
      const prompt = "FIXTURE prompt sent once";
      client.chat.send(target, prompt);
      const said = () =>
        client.chat
          .view(target)
          .messages.filter(
            (m) =>
              m.role === "user" && m.blocks.some((b) => b.kind === "text" && b.markdown === prompt),
          );
      await until(() => !client.chat.view(target).live && !client.chat.view(target).sending);
      await until(() => said().every((m) => !m.id.startsWith("local:")));
      expect(said()).toHaveLength(1);
      expect(client.chat.view(target).observe).toBe("live");
    } finally {
      client.dispose();
    }
  }, 20_000);
});
