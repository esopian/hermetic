import { encodeMobileLink, type MobileLinkPayload } from "@hermetic/core/shared";
import {
  cleanLabel,
  pairConfirmLines,
  readPairingLink,
  tailnetAllowed,
} from "../../src/fleet/pairing.ts";

const PAYLOAD: MobileLinkPayload = {
  fleet_id: "fxtr0001",
  alias: "main",
  account_id: "123456789012",
  region: "us-west-2",
  tailnet: "hermetic.ts.net",
  agents: [{ name: "atlas" }, { name: "corvid", host: "fxtr0001-corvid-2.hermetic.ts.net" }],
};
const LINK = encodeMobileLink(PAYLOAD);

describe("readPairingLink", () => {
  test("a link mobile.pair would make reads back whole, with a display label", () => {
    const read = readPairingLink(`  ${LINK}\n`);
    expect(read).toEqual({ ok: true, link: { link: LINK, payload: PAYLOAD, label: "main" } });
  });

  test("no alias: the label is the fleet id", () => {
    const read = readPairingLink(encodeMobileLink({ ...PAYLOAD, alias: null }));
    expect(read.ok && read.link.label).toBe("fxtr0001");
  });

  test.each(["token", "api_key", "secret", "code", "TOKEN", "x%74oken"])(
    "a link carrying a %p parameter is refused, as a credential",
    (name) => {
      const read = readPairingLink(`${LINK}&${name}=FIXTURE`);
      expect(read.ok).toBe(false);
      if (!read.ok) expect(read.error.title).toMatch(/credential/);
    },
  );

  test.each([
    ["not a string", 42],
    ["another scheme", "https://example.com/?v=2"],
    ["the round-2 pairing link", "hermetic://pair?host=100.64.0.1&port=7435&code=123456"],
    ["a v1 fleet link", LINK.replace("v=2", "v=1")],
    ["a bad fleet id", LINK.replace("fleet=fxtr0001", "fleet=FXTR0001")],
    ["a duplicate field", `${LINK}&fleet=fxtr0002`],
  ])("refuses %s", (_name, text) => {
    expect(readPairingLink(text).ok).toBe(false);
  });

  test("a tailnet that is not a Tailscale one is refused unless the build names it", () => {
    const custom = encodeMobileLink({ ...PAYLOAD, tailnet: "corp.example.com" });
    const refused = readPairingLink(custom);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.title).toMatch(/not a Tailscale tailnet/);
    expect(readPairingLink(custom, { operatorTailnet: "corp.example.com" }).ok).toBe(true);
  });
});

describe("helpers", () => {
  test("tailnetAllowed", () => {
    expect(tailnetAllowed("tail1234.ts.net")).toBe(true);
    expect(tailnetAllowed("Tail1234.TS.NET.")).toBe(true);
    expect(tailnetAllowed("ts.net")).toBe(false);
    expect(tailnetAllowed("ts.net.example.com")).toBe(false);
  });

  test("cleanLabel strips control and bidi characters and caps the length", () => {
    expect(cleanLabel("  ma‮in\u0007  ")).toBe("main");
    expect(cleanLabel("x".repeat(100))).toHaveLength(64);
    expect(cleanLabel(null)).toBe("");
  });

  test("the confirm screen's lines", () => {
    const read = readPairingLink(LINK);
    if (!read.ok) throw new Error("expected ok");
    expect(pairConfirmLines(read.link)).toEqual({
      fleet: "main · fxtr0001",
      tailnet: "hermetic.ts.net",
      agents: "2 agents",
    });
  });
});
