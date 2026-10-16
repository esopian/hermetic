import { encodeMobileLink, type MobileLinkPayload } from "@hermetic/core/shared";
import {
  cleanLabel,
  pairConfirmLines,
  pairPrefLines,
  pairPrefsPatch,
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
  prefs: {},
};
const LINK = encodeMobileLink(PAYLOAD);
/** A v2 link as an older laptop wrote it, before `prefs`. */
const V2_LINK =
  "hermetic://fleet?v=2&fleet=fxtr0001&alias=main&account=123456789012&region=us-west-2" +
  "&tailnet=hermetic.ts.net&agents=atlas,corvid:fxtr0001-corvid-2.hermetic.ts.net";

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
    ["a v1 fleet link", LINK.replace("v=3", "v=1")],
    ["a v4 fleet link", LINK.replace("v=3", "v=4")],
    ["a bad fleet id", LINK.replace("fleet=fxtr0001", "fleet=FXTR0001")],
    ["a duplicate field", `${LINK}&fleet=fxtr0002`],
  ])("refuses %s", (_name, text) => {
    expect(readPairingLink(text).ok).toBe(false);
  });

  test("a v2 link, from before prefs, reads back whole with empty prefs", () => {
    expect(readPairingLink(V2_LINK)).toEqual({
      ok: true,
      link: { link: V2_LINK, payload: PAYLOAD, label: "main" },
    });
  });

  test("a v3 link carries its prefs through to the proposal", () => {
    const link = encodeMobileLink({ ...PAYLOAD, prefs: { avatar_style: "pixel" } });
    const read = readPairingLink(link);
    if (!read.ok) throw new Error(read.error.title);
    expect(read.link.payload.prefs).toEqual({ avatar_style: "pixel" });
  });

  test("a pref the phone cannot read is dropped, and the link still pairs", () => {
    const read = readPairingLink(`${LINK}&prefs=avatar_style:hologram;theme:dark`);
    if (!read.ok) throw new Error(read.error.title);
    expect(read.link.payload.prefs).toEqual({});
  });

  test("an older and a newer link each say which side to update", () => {
    const older = readPairingLink(LINK.replace("v=3", "v=1"));
    if (older.ok) throw new Error("accepted v1");
    expect(older.error.title).toMatch(/older Hermetic/);
    const newer = readPairingLink(LINK.replace("v=3", "v=4"));
    if (newer.ok) throw new Error("accepted v4");
    expect(newer.error.title).toMatch(/newer Hermetic/);
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

  test("pref lines and the prefs patch: one per pref carried, none for a v2 link", () => {
    const v2 = readPairingLink(V2_LINK);
    if (!v2.ok) throw new Error("expected ok");
    expect(pairPrefLines(v2.link)).toEqual([]);
    expect(pairPrefsPatch(v2.link)).toEqual({});
    const v3 = readPairingLink(encodeMobileLink({ ...PAYLOAD, prefs: { avatar_style: "sigil" } }));
    if (!v3.ok) throw new Error("expected ok");
    expect(pairPrefLines(v3.link)).toEqual([{ label: "Avatar style", value: "sigil" }]);
    expect(pairPrefsPatch(v3.link)).toEqual({ avatarStyle: "sigil" });
  });
});
