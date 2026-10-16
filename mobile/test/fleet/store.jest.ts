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
import { resetTunnelChecks } from "../../src/gateway/hermeticd.ts";
import { fakeFetch, json } from "../helpers/fakes.ts";
import { fleetView } from "../helpers/fixtures.ts";

const NOW = "2026-10-13T11:00:00.000Z";

// The off-tunnel gate remembers hosts for 60 s across tests in this process.
beforeEach(() => resetTunnelChecks());

function paired(
  agents = [
    { name: "atlas" },
    { name: "corvid", host: "fxtr0001-corvid-2.hermetic.ts.net" },
    { name: "dodo" },
  ],
  fleet_id = "fxtr0001",
) {
  const read = readPairingLink(
    encodeMobileLink({
      fleet_id,
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
  test("pair keeps the link in the keychain; it listens to nothing and needs a primary", async () => {
    const s = setup();
    expect(s.store.needsPrimary()).toBe(false);
    await s.store.pair(paired());
    expect(s.store.listened()).toEqual([]);
    expect(s.store.getState().primary).toBeNull();
    expect(s.store.needsPrimary()).toBe(true);
    const raw = JSON.parse((await loadChunked(s.secure, FLEET_KEY_PREFIX)) ?? "{}");
    expect(raw).toEqual({ link: paired().link, listening: [], primary: null });
  });

  test("setPrimary listens to the primary alone, and survives a reload", async () => {
    const s = setup();
    await s.store.pair(paired());
    await s.store.setPrimary("corvid");
    expect(s.store.getState().primary).toBe("corvid");
    expect(s.store.needsPrimary()).toBe(false);
    expect(s.store.listened()).toEqual(["corvid"]);
    await s.store.setListening("dodo", true);
    const again = new FleetStore({
      secure: s.secure,
      viewCache: s.viewCache,
      fetch: async () => json(VIEW),
      now: () => NOW,
    });
    expect(await again.load()).toBe(true);
    expect(again.getState().primary).toBe("corvid");
    expect(again.listened()).toEqual(["corvid", "dodo"]);
    expect(again.needsPrimary()).toBe(false);
  });

  test("the primary stays primary when its listening is switched off", async () => {
    const s = setup();
    await s.store.pair(paired());
    await s.store.setPrimary("atlas");
    await s.store.setListening("atlas", false);
    expect(s.store.listened()).toEqual([]);
    expect(s.store.getState().primary).toBe("atlas");
    expect(s.store.needsPrimary()).toBe(false);
  });

  test("setPrimary keeps listening to all, and refuses a name the fleet does not list", async () => {
    const s = setup();
    await s.store.pair(paired());
    await s.store.setListeningAll();
    await s.store.setPrimary("dodo");
    expect(s.store.getState().listening).toBe("all");
    expect(s.store.listened()).toEqual(["atlas", "corvid", "dodo"]);
    await expect(s.store.setPrimary("zebra")).rejects.toThrow("zebra");
    expect(s.store.getState().primary).toBe("dodo");
  });

  test("pairing another fleet forgets the primary and the listening", async () => {
    const s = setup();
    await s.store.pair(paired());
    await s.store.setPrimary("atlas");
    await s.store.pair(paired(undefined, "sg7k2m4p"));
    expect(s.store.getState().primary).toBeNull();
    expect(s.store.listened()).toEqual([]);
    expect(s.store.needsPrimary()).toBe(true);
  });

  test("re-pairing the same fleet keeps the primary and listening, less agents it no longer names", async () => {
    const s = setup();
    await s.store.pair(paired());
    await s.store.setPrimary("atlas");
    await s.store.setListening("dodo", true);
    await s.store.pair(paired([{ name: "atlas" }, { name: "corvid" }, { name: "egret" }]));
    expect(s.store.getState().primary).toBe("atlas");
    expect(s.store.listened()).toEqual(["atlas"]);
    expect(s.store.needsPrimary()).toBe(false);
    const raw = JSON.parse((await loadChunked(s.secure, FLEET_KEY_PREFIX)) ?? "{}");
    expect(raw).toMatchObject({ listening: ["atlas"], primary: "atlas" });
    // A primary the new link drops is cleared; "all" stays "all".
    await s.store.setListeningAll();
    await s.store.pair(paired([{ name: "corvid" }, { name: "egret" }]));
    expect(s.store.getState().primary).toBeNull();
    expect(s.store.getState().listening).toBe("all");
    expect(s.store.needsPrimary()).toBe(true);
  });

  test("a same-fleet re-pair drops what the fresh link no longer names; a dropped primary asks again", async () => {
    const s = setup();
    await s.store.pair(paired());
    expect(await s.store.refresh()).toBe(true);
    await s.store.setPrimary("dodo");
    await s.store.setListening("atlas", true);
    // dodo was destroyed: the fresh link leaves it out, though the cached view still names it.
    await s.store.pair(paired([{ name: "atlas" }, { name: "corvid" }]));
    expect(s.store.getState().view).toEqual(VIEW);
    expect(s.store.getState().primary).toBeNull();
    expect(s.store.needsPrimary()).toBe(true);
    expect([...(s.store.getState().listening as Set<string>)]).toEqual(["atlas"]);
    const raw = JSON.parse((await loadChunked(s.secure, FLEET_KEY_PREFIX)) ?? "{}");
    expect(raw).toMatchObject({ listening: ["atlas"], primary: null });
  });

  test("a trimmed link (it carries the fleet's full count) drops nothing", async () => {
    const s = setup();
    await s.store.pair(paired());
    await s.store.setPrimary("dodo");
    await s.store.setListening("corvid", true);
    const read = readPairingLink(paired([{ name: "atlas" }]).link.replace("&agents=", "&n=40&agents="));
    if (!read.ok) throw new Error("trimmed link refused");
    expect(read.link.payload.agents_total).toBe(40);
    await s.store.pair(read.link);
    expect(s.store.getState().primary).toBe("dodo");
    expect(s.store.needsPrimary()).toBe(false);
    expect([...(s.store.getState().listening as Set<string>)].sort()).toEqual(["corvid", "dodo"]);
  });

  test("isGone answers only from this store's own /fleet read, never from a cache", async () => {
    const s = setup();
    await s.store.pair(paired([...paired().payload.agents, { name: "heron" }]));
    expect(s.store.isGone("heron")).toBe(false);
    expect(await s.store.refresh()).toBe(true);
    expect(s.store.isGone("heron")).toBe(true);
    expect(s.store.isGone("atlas")).toBe(false);
    const again = new FleetStore({
      secure: s.secure,
      viewCache: s.viewCache,
      fetch: async () => json(VIEW),
      now: () => NOW,
    });
    expect(await again.load()).toBe(true);
    expect(again.getState().view).toEqual(VIEW);
    expect(again.isGone("heron")).toBe(false);
  });

  test("a record from before the primary takes its first listened name, else none", async () => {
    const load = async (record: Record<string, unknown>) => {
      const secure = memoryKv();
      await saveChunked(secure, FLEET_KEY_PREFIX, JSON.stringify({ link: paired().link, ...record }));
      const store = new FleetStore({
        secure,
        viewCache: memoryFile(),
        fetch: async () => json(VIEW),
        now: () => NOW,
      });
      expect(await store.load()).toBe(true);
      return store;
    };
    const listed = await load({ listening: ["dodo", "atlas"], listening_default: false });
    expect(listed.getState().primary).toBe("atlas");
    expect(listed.listened()).toEqual(["atlas", "dodo"]);
    expect((await load({ listening: [], listening_default: true })).getState().primary).toBeNull();
    const all = await load({ listening: "all", listening_default: false });
    expect(all.getState().primary).toBeNull();
    expect(all.needsPrimary()).toBe(true);
    expect((await load({ listening: ["dodo"], primary: null })).getState().primary).toBeNull();
  });

  test("a refresh never changes listening; the view wins, the link is the floor", async () => {
    const s = setup();
    await s.store.pair(paired());
    expect(await s.store.refresh()).toBe(true);
    expect(s.store.listened()).toEqual([]);
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
    for (const name of ["atlas", "corvid", "dodo", "egret"]) await s.store.setListening(name, true);
    await s.store.refresh();
    // The off-tunnel gate's HTTPS probes (already fresh from the first refresh) aside.
    const fleetCalls = s.calls.filter((c) => c.url.includes(":7434/"));
    expect(fleetCalls).toHaveLength(3);
    expect(fleetCalls.every((c) => c.url.endsWith(":7434/fleet"))).toBe(true);
    expect(s.calls.some((c) => c.url.includes("dodo"))).toBe(false);
  });

  test("a chosen listening survives the first view, and a reload", async () => {
    const s = setup();
    await s.store.pair(paired());
    await s.store.setPrimary("corvid");
    await s.store.setListening("dodo", true);
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
    await s.store.setListeningAll();
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
    // Every box's /healthz refused the same way: each reads unreachable.
    expect(failing.getState().fromBoxes).toEqual({
      atlas: "unreachable",
      corvid: "unreachable",
      dodo: "unreachable",
      egret: "unreachable",
    });
  });

  test("pre-v16: /fleet unavailable, so each box's /healthz fills its status", async () => {
    const asked: string[] = [];
    const secure = memoryKv();
    const store = new FleetStore({
      secure,
      viewCache: memoryFile(),
      fetch: async () =>
        new Response(
          `${JSON.stringify({ type: "error", code: "FLEET_LIST_UNAVAILABLE", message: "no scan" })}\n`,
          { status: 503 },
        ),
      now: () => NOW,
      healthz: async (host) => {
        asked.push(host);
        if (host.startsWith("fxtr0001-atlas")) return { ok: true };
        if (host.startsWith("fxtr0001-corvid")) return { ok: false };
        // dodo: the off-tunnel gate would not ask.
        return { ok: false, error: { code: "TUNNEL_UNVERIFIED" } };
      },
    });
    await store.pair(paired());
    expect(await store.refresh()).toBe(false);
    expect(asked.sort()).toEqual([
      "fxtr0001-atlas.hermetic.ts.net",
      "fxtr0001-corvid-2.hermetic.ts.net",
      "fxtr0001-dodo.hermetic.ts.net",
    ]);
    expect(store.getState()).toMatchObject({
      stale: true,
      error: { code: "FLEET_LIST_UNAVAILABLE" },
      fromBoxes: { atlas: "ready", corvid: "unreachable" },
    });
    expect(store.agents().map((a) => [a.name, a.status])).toEqual([
      ["atlas", "ready"],
      ["corvid", "unreachable"],
      ["dodo", null],
    ]);
    // No answer picks for the operator: nothing is listened until they choose.
    expect(store.listened()).toEqual([]);
    expect(store.needsPrimary()).toBe(true);
    const reloaded = new FleetStore({
      secure,
      viewCache: memoryFile(),
      fetch: async () => json(VIEW),
      now: () => NOW,
    });
    await reloaded.load();
    expect(reloaded.listened()).toEqual([]);
  });

  test("pre-v16: /healthz goes to the listened boxes plus at most three others, in turn", async () => {
    const names = ["atlas", "bison", "corvid", "dodo", "egret", "finch", "gull", "heron"];
    let asked: string[] = [];
    const store = new FleetStore({
      secure: memoryKv(),
      viewCache: memoryFile(),
      fetch: async () =>
        new Response(
          `${JSON.stringify({ type: "error", code: "FLEET_LIST_UNAVAILABLE", message: "no scan" })}\n`,
          { status: 503 },
        ),
      now: () => NOW,
      healthz: async (host) => {
        const name = host.replace(/^fxtr0001-/, "").replace(/\..*$/, "");
        asked.push(name);
        return name === "heron" ? { ok: false } : { ok: true };
      },
    });
    await store.pair(paired(names.map((name) => ({ name }))));
    // Every box listened, so the first refresh asks all; no answer narrows it.
    await store.setListeningAll();
    await store.refresh();
    expect(asked.sort()).toEqual(names);
    expect(store.listened()).toEqual(names);
    for (const n of ["bison", "corvid", "dodo", "egret", "finch", "heron"])
      await store.setListening(n, false);
    // Listened: atlas, gull. Others: bison, corvid, dodo, egret, finch, heron.
    asked = [];
    await store.refresh();
    expect(asked.sort()).toEqual(["atlas", "bison", "corvid", "dodo", "gull"]);
    asked = [];
    await store.refresh();
    expect(asked.sort()).toEqual(["atlas", "egret", "finch", "gull", "heron"]);
    // A box not asked this time keeps its last answer.
    expect(store.getState().fromBoxes).toMatchObject({ bison: "ready", heron: "unreachable" });
  });

  test("pre-v16 with every box silent: the chosen listening is left as it is", async () => {
    const store = new FleetStore({
      secure: memoryKv(),
      viewCache: memoryFile(),
      fetch: async () => {
        throw new TypeError("Network request failed");
      },
      now: () => NOW,
      healthz: async () => {
        throw new TypeError("Network request failed");
      },
    });
    await store.pair(paired());
    await store.setPrimary("atlas");
    await store.refresh();
    expect(store.listened()).toEqual(["atlas"]);
    expect(store.getState().fromBoxes).toEqual({
      atlas: "unreachable",
      corvid: "unreachable",
      dodo: "unreachable",
    });
  });

  test("a /fleet answer after the fallback clears it", async () => {
    let fleetUp = false;
    const store = new FleetStore({
      secure: memoryKv(),
      viewCache: memoryFile(),
      fetch: async () => {
        if (fleetUp) return json(VIEW);
        throw new TypeError("Network request failed");
      },
      now: () => NOW,
      healthz: async () => ({ ok: false }),
    });
    await store.pair(paired());
    await store.refresh();
    expect(store.agents().every((a) => a.status === "unreachable")).toBe(true);
    fleetUp = true;
    expect(await store.refresh()).toBe(true);
    expect(store.getState()).toMatchObject({ stale: false, fromBoxes: null });
    expect(store.agents().find((a) => a.name === "dodo")?.status).toBe("stopped");
  });

  test("nothing answers, HTTPS included: the link alone, stale, and no 7434 call made", async () => {
    const s = setup(() => {
      throw new TypeError("Network request failed");
    });
    await s.store.pair(paired());
    expect(await s.store.refresh()).toBe(false);
    expect(s.store.getState()).toMatchObject({
      stale: true,
      view: null,
      error: { code: "TUNNEL_UNVERIFIED" },
      // The gate refused every /healthz too: no status is guessed.
      fromBoxes: null,
    });
    expect(s.store.agents().map((a) => [a.name, a.status])).toEqual([
      ["atlas", null],
      ["corvid", null],
      ["dodo", null],
    ]);
    expect(s.calls.some((c) => c.url.includes(":7434/"))).toBe(false);
    expect(s.store.hostOf("corvid")).toBe("fxtr0001-corvid-2.hermetic.ts.net");
  });

  test("on the tailnet but hermeticd silent: HERMETICD_UNAVAILABLE, every box unreachable", async () => {
    const s = setup((url) => {
      if (url.startsWith("https://")) return json({ status: "ok" });
      throw new TypeError("Network request failed");
    });
    await s.store.pair(paired());
    expect(await s.store.refresh()).toBe(false);
    expect(s.store.getState()).toMatchObject({
      stale: true,
      error: { code: "HERMETICD_UNAVAILABLE" },
    });
    expect(s.store.agents().map((a) => [a.name, a.status])).toEqual([
      ["atlas", "unreachable"],
      ["corvid", "unreachable"],
      ["dodo", "unreachable"],
    ]);
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
