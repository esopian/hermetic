import { encodeMobileLink } from "@hermetic/core/shared";
import { readPairingLink } from "../../src/fleet/pairing.ts";
import {
  FLEET_KEY_PREFIX,
  FleetStore,
  loadChunked,
  memoryFile,
  memoryKv,
  SECURE_CHUNK,
  saveChunked,
} from "../../src/fleet/store.ts";
import { fakeFetch, json } from "../helpers/fakes.ts";
import { fleetView } from "../helpers/fixtures.ts";

const NOW = "2026-10-13T11:00:00.000Z";

function paired(
  agents = [
    { name: "atlas" },
    { name: "corvid", host: "fxtr0001-corvid-2.hermetic.ts.net" },
    { name: "dodo" },
  ],
) {
  const read = readPairingLink(
    encodeMobileLink({
      fleet_id: "fxtr0001",
      alias: "main",
      account_id: "123456789012",
      region: "us-west-2",
      tailnet: "hermetic.ts.net",
      agents,
    }),
  );
  if (!read.ok) throw new Error("fixture link refused");
  return read.link;
}

const VIEW = fleetView({
  agents: [
    {
      name: "atlas",
      status: "ready",
      tailscale_dns_name: "fxtr0001-atlas.hermetic.ts.net.",
      tailscale_ip: "100.64.0.1",
      version: "0.21.1",
    },
    {
      name: "corvid",
      status: "ready",
      tailscale_dns_name: "fxtr0001-corvid-2.hermetic.ts.net",
      tailscale_ip: "100.64.0.2",
      version: "0.21.1",
    },
    { name: "dodo", status: "stopped", tailscale_dns_name: null, tailscale_ip: null, version: null },
    {
      name: "egret",
      status: "ready",
      tailscale_dns_name: "fxtr0001-egret.hermetic.ts.net",
      tailscale_ip: "100.64.0.4",
      version: "0.21.1",
    },
  ],
});

function setup(answer: Parameters<typeof fakeFetch>[0] = () => json(VIEW)) {
  const secure = memoryKv();
  const viewCache = memoryFile();
  const f = fakeFetch(answer);
  const store = new FleetStore({ secure, viewCache, fetch: f.fetch, now: () => NOW });
  return { store, secure, viewCache, calls: f.calls };
}

describe("chunked keychain values", () => {
  test("a record longer than one SecureStore value is split and read back whole", async () => {
    const kv = memoryKv();
    const text = "x".repeat(SECURE_CHUNK * 2 + 10);
    await saveChunked(kv, "k", text);
    expect(kv.map.get("k")).toBe("3");
    expect([...kv.map.values()].every((v) => v.length <= SECURE_CHUNK)).toBe(true);
    expect(await loadChunked(kv, "k")).toBe(text);
    await saveChunked(kv, "k", "short");
    expect(kv.map.has("k.1")).toBe(false);
    expect(await loadChunked(kv, "k")).toBe("short");
  });
});

describe("FleetStore", () => {
  test("pair keeps the link in the keychain; listening starts as every agent the link names", async () => {
    const s = setup();
    await s.store.pair(paired());
    expect(s.store.listened()).toEqual(["atlas", "corvid", "dodo"]);
    const raw = JSON.parse((await loadChunked(s.secure, FLEET_KEY_PREFIX)) ?? "{}");
    expect(raw).toMatchObject({ listening: ["atlas", "corvid", "dodo"], listening_default: true });
    expect(raw.link).toBe(paired().link);
  });

  test("the first refresh narrows the default to ready agents; the view wins, the link is the floor", async () => {
    const s = setup();
    await s.store.pair(paired());
    expect(await s.store.refresh()).toBe(true);
    expect(s.store.listened()).toEqual(["atlas", "corvid", "egret"]);
    const agents = s.store.agents();
    expect(agents.map((a) => [a.name, a.status, a.host])).toEqual([
      ["atlas", "ready", "fxtr0001-atlas.hermetic.ts.net"],
      ["corvid", "ready", "fxtr0001-corvid-2.hermetic.ts.net"],
      ["dodo", "stopped", "fxtr0001-dodo.hermetic.ts.net"],
      ["egret", "ready", "fxtr0001-egret.hermetic.ts.net"],
    ]);
    expect(s.store.getState()).toMatchObject({ stale: false, refreshed_at: NOW, error: null });
    expect(JSON.parse(s.viewCache.text() ?? "null")).toEqual(VIEW);
  });

  test("refresh asks at most three listened boxes, ready first, on 7434", async () => {
    const s = setup();
    await s.store.pair(paired());
    await s.store.refresh();
    s.calls.length = 0;
    await s.store.setListening("dodo", true);
    await s.store.refresh();
    expect(s.calls).toHaveLength(3);
    expect(s.calls.every((c) => c.url.endsWith(":7434/fleet"))).toBe(true);
    expect(s.calls.some((c) => c.url.includes("dodo"))).toBe(false);
  });

  test("a chosen listening survives the first view, and a reload", async () => {
    const s = setup();
    await s.store.pair(paired());
    await s.store.setListening("atlas", false);
    await s.store.refresh();
    expect(s.store.listened()).toEqual(["corvid", "dodo"]);
    const again = new FleetStore({
      secure: s.secure,
      viewCache: s.viewCache,
      fetch: async () => json(VIEW),
      now: () => NOW,
    });
    expect(await again.load()).toBe(true);
    expect(again.listened()).toEqual(["corvid", "dodo"]);
    expect(again.getState().view).toEqual(VIEW);
  });

  test("503 FLEET_LIST_UNAVAILABLE keeps the snapshot and marks it stale", async () => {
    const s = setup();
    await s.store.pair(paired());
    await s.store.refresh();
    const failing = new FleetStore({
      secure: s.secure,
      viewCache: s.viewCache,
      fetch: async () =>
        new Response(
          `${JSON.stringify({ type: "error", code: "FLEET_LIST_UNAVAILABLE", message: "no scan" })}\n`,
          {
            status: 503,
          },
        ),
      now: () => NOW,
    });
    await failing.load();
    expect(await failing.refresh()).toBe(false);
    expect(failing.getState()).toMatchObject({
      stale: true,
      view: VIEW,
      error: { code: "FLEET_LIST_UNAVAILABLE" },
    });
    expect(failing.agents().map((a) => a.status)).toEqual(["ready", "ready", "stopped", "ready"]);
  });

  test("nothing answers: the link alone, stale, HERMETICD_UNAVAILABLE", async () => {
    const s = setup(() => {
      throw new TypeError("Network request failed");
    });
    await s.store.pair(paired());
    expect(await s.store.refresh()).toBe(false);
    expect(s.store.getState()).toMatchObject({
      stale: true,
      view: null,
      error: { code: "HERMETICD_UNAVAILABLE" },
    });
    expect(s.store.agents().map((a) => [a.name, a.status])).toEqual([
      ["atlas", null],
      ["corvid", null],
      ["dodo", null],
    ]);
    expect(s.store.hostOf("corvid")).toBe("fxtr0001-corvid-2.hermetic.ts.net");
  });

  test("a /fleet name off the tailnet is never dialled", async () => {
    const s = setup(() =>
      json(
        fleetView({
          agents: [
            {
              name: "atlas",
              status: "ready",
              tailscale_dns_name: "atlas.evil.example",
              tailscale_ip: null,
              version: null,
            },
          ],
        }),
      ),
    );
    await s.store.pair(paired([{ name: "atlas" }]));
    await s.store.refresh();
    expect(s.store.hostOf("atlas")).toBe("fxtr0001-atlas.hermetic.ts.net");
  });

  test("sign out forgets the keychain record and the cache", async () => {
    const s = setup();
    await s.store.pair(paired());
    await s.store.refresh();
    await s.store.signOut();
    expect(s.secure.map.size).toBe(0);
    expect(s.viewCache.text()).toBeNull();
    expect(s.store.getState().link).toBeNull();
    expect(
      await new FleetStore({
        secure: s.secure,
        viewCache: s.viewCache,
        fetch: async () => json(VIEW),
        now: () => NOW,
      }).load(),
    ).toBe(false);
  });
});
