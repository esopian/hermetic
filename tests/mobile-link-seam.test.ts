/**
 * The pairing link's seam: the laptop writes it (`mobile.pair`, through
 * `@hermetic/core`) and the phone reads it (`parseMobileLink`, through
 * `@hermetic/core/shared`, the only core door the phone has). This is the core
 * half: what core encodes, the shared parser reads back exactly. The phone
 * half — the phone's own import of the same parser, and what it stores — is
 * added beside it with the phone's pairing screen.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MobilePairResult, openHermetic } from "@hermetic/core";
import { cloudName, MOBILE_LINK_PREFIX, parseMobileLink } from "@hermetic/core/shared";
import { readPairingLink } from "../mobile/src/fleet/pairing.ts";
import { FleetStore, memoryFile, memoryKv } from "../mobile/src/fleet/store.ts";

async function fixturePair(): Promise<MobilePairResult> {
  const h = await openHermetic({
    fixture: true,
    home: mkdtempSync(join(tmpdir(), "hermetic-link-seam-")),
  });
  return MobilePairResult.parse(await h.mobile.pair({}));
}

describe("mobile.pair → parseMobileLink", () => {
  test("the shared parser reads back the fleet and the agents core encoded", async () => {
    const result = await fixturePair();
    expect(result.link.startsWith(`${MOBILE_LINK_PREFIX}?`)).toBe(true);
    const parsed = parseMobileLink(result.link);
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual({ ...result.fleet, agents: result.agents });
    expect(parsed?.agents).toHaveLength(result.agents_in_link);
    // The fixture's `corvid` came up as `-2`, so it is the one agent with a host.
    expect(result.agents.filter((a) => a.host !== undefined)).toEqual([
      { name: "corvid", host: "fxtr0001-corvid-2.hermetic.ts.net" },
    ]);
  });

  test("the link carries no credential-shaped parameter", async () => {
    const result = await fixturePair();
    const query = result.link.slice(result.link.indexOf("?") + 1);
    const keys = query.split("&").map((part) => part.slice(0, part.indexOf("=")));
    expect(keys.sort()).toEqual(["account", "agents", "alias", "fleet", "region", "tailnet", "v"]);
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
    expect(read.link.payload).toEqual({ ...result.fleet, agents: result.agents });
    expect(read.link.label).toBe(result.fleet.alias ?? result.fleet.fleet_id);
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
    expect(store.listened()).toEqual(result.agents.map((a) => a.name).sort());
  });
});
