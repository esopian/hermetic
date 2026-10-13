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
import { MOBILE_LINK_PREFIX, parseMobileLink } from "@hermetic/core/shared";

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
