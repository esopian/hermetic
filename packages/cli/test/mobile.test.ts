/**
 * `hermetic mobile pair` rendering (`commands/mobile.ts`): the pair screen
 * carries the QR, the link and the fleet it names, and says when the link
 * could not carry every agent.
 */
import { describe, expect, test } from "bun:test";
import type { MobilePairResult } from "@hermetic/core";
import { renderPair } from "../src/commands/mobile.ts";

const PAIR: MobilePairResult = {
  link:
    "hermetic://fleet?v=2&fleet=fxtr0001&alias=main&account=123456789012&region=us-west-2" +
    "&tailnet=hermetic.ts.net&agents=atlas,corvid:fxtr0001-corvid-2.hermetic.ts.net",
  fleet: {
    fleet_id: "fxtr0001",
    alias: "main",
    account_id: "123456789012",
    region: "us-west-2",
    tailnet: "hermetic.ts.net",
  },
  agents: [{ name: "atlas" }, { name: "corvid", host: "fxtr0001-corvid-2.hermetic.ts.net" }],
  agents_in_link: 2,
};

describe("mobile pair rendering", () => {
  test("the pair screen has a QR, the link, the fleet and the tailnet", () => {
    const text = renderPair(PAIR, { qr: true });
    expect(text).toContain(PAIR.link);
    expect(text).toContain("main (fxtr0001)");
    expect(text).toContain("hermetic.ts.net");
    expect(text).toContain("2 agents");
    expect(text).toMatch(/[█▀▄]/);
    expect(renderPair(PAIR, { qr: false })).not.toMatch(/[█▀▄]/);
  });

  test("a fleet without an alias shows its id", () => {
    const text = renderPair({ ...PAIR, fleet: { ...PAIR.fleet, alias: null } }, { qr: false });
    expect(text).toContain("fxtr0001 (fxtr0001)");
  });

  test("says when the link carries fewer agents than the fleet has", () => {
    const text = renderPair({ ...PAIR, agents_in_link: 1 }, { qr: false });
    expect(text).toContain("1 of 2 agents in the link");
  });
});
