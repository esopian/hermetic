/**
 * The pairing link's seam: the laptop writes it (`mobile.pair`, through
 * `@hermetic/core`) and the phone reads it (`parseMobileLink`, through
 * `@hermetic/core/shared`, the only core door the phone has). This is the core
 * half: what core encodes, the shared parser reads back exactly. The phone
 * half — the phone's own import of the same parser, and what it stores — is
 * added beside it with the phone's pairing screen.
 *
 * The link is versioned (`v=3` today) and its `prefs` field is forgiving: a
 * phone reads a v2 link (no `prefs`) and a v3 one, and drops a pref it cannot
 * read rather than refusing the pairing.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MobilePairResult, openHermetic } from "@hermetic/core";
import {
  cloudName,
  encodeMobileLink,
  MOBILE_LINK_PREFIX,
  parseMobileLink,
} from "@hermetic/core/shared";
import { readPairingLink } from "../mobile/src/fleet/pairing.ts";
import { FleetStore, memoryFile, memoryKv } from "../mobile/src/fleet/store.ts";

async function fixturePair(input: object = {}): Promise<MobilePairResult> {
  const h = await openHermetic({
    fixture: true,
    home: mkdtempSync(join(tmpdir(), "hermetic-link-seam-")),
  });
  return MobilePairResult.parse(await h.mobile.pair(input));
}

/** A v2 link as an older laptop wrote it: no `prefs`, by hand so no encoder can drift it. */
const V2_LINK =
  "hermetic://fleet?v=2&fleet=fxtr0001&alias=main&account=123456789012&region=us-west-2" +
  "&tailnet=hermetic.ts.net&agents=atlas,corvid:fxtr0001-corvid-2.hermetic.ts.net";

describe("mobile.pair → parseMobileLink", () => {
  test("the shared parser reads back the fleet and the agents core encoded", async () => {
    const result = await fixturePair();
    expect(result.link.startsWith(`${MOBILE_LINK_PREFIX}?`)).toBe(true);
    const parsed = parseMobileLink(result.link);
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual({ ...result.fleet, agents: result.agents, prefs: {} });
    expect(result.prefs).toEqual({});
    expect(parsed?.agents).toHaveLength(result.agents_in_link);
    // The fixture's `corvid` came up as `-2`, so it is the one agent with a host.
    expect(result.agents.filter((a) => a.host !== undefined)).toEqual([
      { name: "corvid", host: "fxtr0001-corvid-2.hermetic.ts.net" },
    ]);
  });

  test("prefs asked of mobile.pair ride a v3 link and come back out of the shared parser", async () => {
    const result = await fixturePair({ prefs: { avatar_style: "pixel" } });
    expect(result.link).toContain("?v=3&");
    expect(result.link).toContain("&prefs=avatar_style:pixel&");
    const parsed = parseMobileLink(result.link);
    expect(parsed?.prefs.avatar_style).toBe("pixel");
    expect(result.prefs).toEqual({ avatar_style: "pixel" });
    expect(parsed?.prefs).toEqual(result.prefs);
  });

  test("a hand-built v2 link, written before prefs existed, still parses with empty prefs", () => {
    expect(parseMobileLink(V2_LINK)).toEqual({
      fleet_id: "fxtr0001",
      alias: "main",
      account_id: "123456789012",
      region: "us-west-2",
      tailnet: "hermetic.ts.net",
      agents: [{ name: "atlas" }, { name: "corvid", host: "fxtr0001-corvid-2.hermetic.ts.net" }],
      prefs: {},
    });
  });

  test("a pref key this build does not know, or a bad value, is dropped and the link kept", async () => {
    const result = await fixturePair({ prefs: { avatar_style: "blob" } });
    const newer = result.link.replace("prefs=avatar_style:blob", "prefs=avatar_style:blob;theme:dark");
    expect(parseMobileLink(newer)?.prefs).toEqual({ avatar_style: "blob" });
    const bad = result.link.replace("prefs=avatar_style:blob", "prefs=avatar_style:hologram");
    const parsed = parseMobileLink(bad);
    expect(parsed?.prefs).toEqual({});
    expect(parsed?.fleet_id).toBe(result.fleet.fleet_id);
  });

  test("the link carries no credential-shaped parameter", async () => {
    const result = await fixturePair({ prefs: { avatar_style: "sigil" } });
    const query = result.link.slice(result.link.indexOf("?") + 1);
    const keys = query.split("&").map((part) => part.slice(0, part.indexOf("=")));
    expect(keys.sort()).toEqual([
      "account",
      "agents",
      "alias",
      "fleet",
      "prefs",
      "region",
      "tailnet",
      "v",
    ]);
    for (const banned of ["token", "key", "secret", "code", "password", "auth"]) {
      expect(keys.some((k) => k.toLowerCase().includes(banned))).toBe(false);
    }
  });
});

describe("mobile.pair → the phone's pairing gate", () => {
  test("the phone accepts the fixture link whole, with the fleet and agents core encoded", async () => {
    const result = await fixturePair();
    const read = readPairingLink(result.link);
    if (!read.ok) throw new Error(`the phone refused the fixture link: ${read.error.title}`);
    expect(read.link.link).toBe(result.link);
    expect(read.link.payload).toEqual({ ...result.fleet, agents: result.agents, prefs: {} });
    expect(read.link.label).toBe(result.fleet.alias ?? result.fleet.fleet_id);
  });

  test("the phone accepts a v3 link with prefs and an older v2 link alike", async () => {
    const result = await fixturePair({ prefs: { avatar_style: "pixel" } });
    const v3 = readPairingLink(result.link);
    if (!v3.ok) throw new Error(`the phone refused the v3 link: ${v3.error.title}`);
    expect(v3.link.payload.prefs).toEqual({ avatar_style: "pixel" });
    const v2 = readPairingLink(V2_LINK);
    if (!v2.ok) throw new Error(`the phone refused the v2 link: ${v2.error.title}`);
    expect(v2.link.payload.prefs).toEqual({});
    expect(v2.link.payload.fleet_id).toBe("fxtr0001");
  });

  test("a paired phone dials each box at the host the laptop would", async () => {
    const result = await fixturePair();
    const read = readPairingLink(result.link);
    if (!read.ok) throw new Error("refused");
    const store = new FleetStore({
      secure: memoryKv(),
      viewCache: memoryFile(),
      fetch: async () => new Response("offline", { status: 503 }),
      now: () => "2026-10-13T10:00:00.000Z",
    });
    await store.pair(read.link);
    for (const agent of result.agents) {
      const derived = `${cloudName(result.fleet.fleet_id, agent.name)}.${result.fleet.tailnet}`;
      expect(store.hostOf(agent.name)).toBe(agent.host ?? derived);
    }
    // Pairing listens to nothing until the operator picks a primary instance;
    // the pick is what admits an instance to the listened set (§9.4).
    expect(store.listened()).toEqual([]);
    expect(store.needsPrimary()).toBe(true);
    const first = result.agents[0];
    if (!first) throw new Error("the fixture link names no agents");
    await store.setPrimary(first.name);
    expect(store.listened()).toEqual([first.name]);
    expect(store.needsPrimary()).toBe(false);
  });

  test("a link core trimmed tells the phone so, and a re-pair with it keeps a primary past the cut", async () => {
    const agents = Array.from({ length: 200 }, (_, i) => ({
      name: `agent-with-a-long-name-${String(i).padStart(4, "0")}`,
    }));
    const base = {
      fleet_id: "fxtr0001",
      alias: "main",
      account_id: "123456789012",
      region: "us-west-2",
      tailnet: "hermetic.ts.net",
    };
    const full = readPairingLink(encodeMobileLink({ ...base, agents: agents.slice(0, 3) }));
    const trimmed = readPairingLink(encodeMobileLink({ ...base, agents }));
    if (!full.ok || !trimmed.ok) throw new Error("the phone refused a core link");
    expect(full.link.payload.agents_total).toBeUndefined();
    expect(trimmed.link.payload.agents_total).toBe(200);
    expect(trimmed.link.payload.agents.length).toBeLessThan(200);
    const store = new FleetStore({
      secure: memoryKv(),
      viewCache: memoryFile(),
      fetch: async () => new Response("{}"),
      now: () => "2026-10-13T10:00:00.000Z",
    });
    await store.pair(full.link);
    const beyond = "agent-with-a-long-name-0199";
    await store.setListening(beyond, true);
    await store.setPrimary("agent-with-a-long-name-0001");
    await store.pair(trimmed.link);
    expect(store.getState().primary).toBe("agent-with-a-long-name-0001");
    expect([...(store.getState().listening as Set<string>)].sort()).toEqual([
      "agent-with-a-long-name-0001",
      beyond,
    ]);
  });
});
