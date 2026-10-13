/**
 * Settings › Mobile's pure rules (`src/logic/mobile-logic.ts`): the pairing
 * link's QR and the sentences the page says about it.
 */
import { describe, expect, test } from "bun:test";
import { encodeMobileLink } from "@hermetic/core/shared";
import {
  agentsInLinkLine,
  agentsLeftOutNote,
  fleetLabel,
  pairHelp,
  pairQrSvg,
} from "../src/logic/mobile-logic.ts";

const LINK = encodeMobileLink({
  fleet_id: "fxtr0001",
  alias: "main",
  account_id: "123456789012",
  region: "us-east-1",
  tailnet: "tail1234.ts.net",
  agents: [{ name: "atlas" }, { name: "corvid", host: "corvid-2.tail1234.ts.net" }],
});

describe("pairQrSvg", () => {
  test("draws a link as an SVG of modules, carrying no character of the link", () => {
    const svg = pairQrSvg(LINK);
    expect(svg).not.toBeNull();
    expect(svg?.startsWith("<svg")).toBe(true);
    expect(svg).toContain("<path");
    expect(svg).not.toContain("hermetic://");
    expect(svg).not.toContain("fxtr0001");
  });

  test("a link too long for any QR draws nothing rather than throwing", () => {
    expect(pairQrSvg("x".repeat(10_000))).toBeNull();
  });
});

describe("agentsInLinkLine", () => {
  test("counts what the link names against the fleet", () => {
    expect(agentsInLinkLine(11, 11)).toBe("11 of 11 agents in the code");
    expect(agentsInLinkLine(60, 75)).toBe("60 of 75 agents in the code");
    expect(agentsInLinkLine(0, 0)).toBe("0 of 0 agents in the code");
  });

  test("one agent is singular", () => {
    expect(agentsInLinkLine(1, 1)).toBe("1 of 1 agent in the code");
  });
});

describe("agentsLeftOutNote", () => {
  test("nothing to say when the link names every agent", () => {
    expect(agentsLeftOutNote(11, 11)).toBeNull();
    expect(agentsLeftOutNote(0, 0)).toBeNull();
  });

  test("says how many the phone reads from the fleet instead", () => {
    expect(agentsLeftOutNote(60, 75)).toBe(
      "The phone reads the other 15 from the fleet once it is on the tailnet.",
    );
  });
});

describe("fleetLabel", () => {
  test("the alias when there is one, else the fleet id", () => {
    expect(fleetLabel({ fleet_id: "fxtr0001", alias: "main" })).toBe("main");
    expect(fleetLabel({ fleet_id: "sg7k2m4p", alias: null })).toBe("sg7k2m4p");
  });
});

describe("pairHelp", () => {
  test("names the tailnet the phone must join", () => {
    expect(pairHelp("tail1234.ts.net")).toBe(
      "Install the Hermetic app and Tailscale on the phone, sign Tailscale into tail1234.ts.net, then scan this code.",
    );
  });
});
