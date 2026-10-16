/**
 * The phone's pairing link (`shared/mobile-link.ts`): it roundtrips, carries a
 * host only where the box's name is not the derived one, degrades to names
 * past `MOBILE_LINK_MAX_AGENTS`, stays drawable, and the parser refuses
 * anything else without throwing. Its `prefs` field is forgiving: a pref
 * this build cannot read is dropped, never a reason to refuse the link.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MOBILE_LINK_MAX_AGENTS,
  MOBILE_LINK_MAX_LENGTH,
  encodeMobileLink,
  parseMobileLink,
  type MobileLinkPayload,
} from "../src/shared/mobile-link.ts";
import { encodeQr } from "../src/shared/qr.ts";
import { mobileLinkAgents } from "../src/mobile-pair.ts";
import { AccountId, FleetIdSchema, Region } from "../src/schema/common.ts";
import { FleetName } from "../src/schema/directory.ts";
import { MobilePairResult } from "../src/schema/mobile.ts";
import { openHermetic } from "../src/index.ts";

const BASE: MobileLinkPayload = {
  fleet_id: "fxtr0001",
  alias: "main",
  account_id: "123456789012",
  region: "us-west-2",
  tailnet: "hermetic.ts.net",
  agents: [{ name: "atlas" }, { name: "corvid", host: "fxtr0001-corvid-2.hermetic.ts.net" }],
  prefs: {},
};

const linkWith = (fields: Record<string, string>): string => {
  const all: Record<string, string> = {
    v: "3",
    fleet: "fxtr0001",
    alias: "main",
    account: "123456789012",
    region: "us-west-2",
    tailnet: "hermetic.ts.net",
    agents: "atlas",
    ...fields,
  };
  return `hermetic://fleet?${Object.entries(all)
    .map(([k, v]) => `${k}=${v}`)
    .join("&")}`;
};

describe("encodeMobileLink / parseMobileLink", () => {
  test("roundtrips a payload", () => {
    const link = encodeMobileLink(BASE);
    expect(link).toBe(
      "hermetic://fleet?v=3&fleet=fxtr0001&alias=main&account=123456789012&region=us-west-2" +
        "&tailnet=hermetic.ts.net&agents=atlas,corvid:fxtr0001-corvid-2.hermetic.ts.net",
    );
    expect(parseMobileLink(link)).toEqual(BASE);
  });

  test("no alias encodes as empty and parses back to null", () => {
    const link = encodeMobileLink({ ...BASE, alias: null });
    expect(link).toContain("&alias=&");
    expect(parseMobileLink(link)?.alias).toBeNull();
  });

  test("a fleet with no agents roundtrips", () => {
    const link = encodeMobileLink({ ...BASE, agents: [] });
    expect(parseMobileLink(link)?.agents).toEqual([]);
  });

  test("percent-encoded and whitespace-wrapped input still parses", () => {
    const link = encodeMobileLink(BASE).replace(":fxtr0001", "%3Afxtr0001");
    expect(parseMobileLink(`  ${link}\n`)).toEqual(BASE);
  });

  test("past MOBILE_LINK_MAX_AGENTS, agents are carried as names only", () => {
    const agents = Array.from({ length: 75 }, (_, i) => ({
      name: `a${i}`,
      host: `fxtr0001-a${i}-2.hermetic.ts.net`,
    }));
    const parsed = parseMobileLink(encodeMobileLink({ ...BASE, agents }));
    expect(parsed?.agents).toHaveLength(75);
    const withHost = parsed?.agents.filter((a) => a.host !== undefined) ?? [];
    expect(withHost).toHaveLength(MOBILE_LINK_MAX_AGENTS);
    expect(parsed?.agents[MOBILE_LINK_MAX_AGENTS]).toEqual({ name: `a${MOBILE_LINK_MAX_AGENTS}` });
  });

  test("a link that would be too long drops agents from the end, and still draws as a QR", () => {
    const agents = Array.from({ length: 200 }, (_, i) => ({
      name: `agent-with-a-long-name-${String(i).padStart(4, "0")}`,
      host: `fxtr0001-agent-with-a-long-name-${i}-2.hermetic.ts.net`,
    }));
    const link = encodeMobileLink({ ...BASE, agents });
    expect(link.length).toBeLessThanOrEqual(MOBILE_LINK_MAX_LENGTH);
    const parsed = parseMobileLink(link);
    expect(parsed).not.toBeNull();
    const kept = parsed?.agents.length ?? 0;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(200);
    expect(parsed?.agents.map((a) => a.name)).toEqual(agents.slice(0, kept).map((a) => a.name));
    // The link says it was trimmed, and from how many.
    expect(parsed?.agents_total).toBe(200);
    expect(link).toContain("&n=200&");
    expect(() => encodeQr(link)).not.toThrow();
  });

  test("a link that names every agent carries no count", () => {
    const parsed = parseMobileLink(encodeMobileLink({ ...BASE, agents: [{ name: "atlas" }] }));
    expect(parsed?.agents_total).toBeUndefined();
    expect(parsed && "agents_total" in parsed).toBe(false);
  });

  test("a count that is malformed or not above the list is dropped, never refusing the link", () => {
    const base = encodeMobileLink({ ...BASE, agents: [{ name: "atlas" }, { name: "corvid" }] });
    const withN = (n: string) => base.replace("&agents=", `&n=${n}&agents=`);
    expect(parseMobileLink(withN("5"))?.agents_total).toBe(5);
    for (const n of ["2", "1", "0", "-3", "x", "1e3", "", "9999999"]) {
      const parsed = parseMobileLink(withN(n));
      expect(parsed).not.toBeNull();
      expect(parsed?.agents_total).toBeUndefined();
    }
  });

  test("past the length limit, host overrides go (from the end) before any agent does", () => {
    // 60 agents whose names fit easily, but whose hosts together do not.
    const agents = Array.from({ length: 60 }, (_, i) => ({
      name: `a${String(i).padStart(2, "0")}`,
      host: `fxtr0001-a${String(i).padStart(2, "0")}-recreated-again-2.hermetic.ts.net`,
    }));
    const full = agents.map((a) => `${a.name}:${a.host}`).join(",");
    expect(full.length).toBeGreaterThan(MOBILE_LINK_MAX_LENGTH);
    const link = encodeMobileLink({ ...BASE, agents });
    expect(link.length).toBeLessThanOrEqual(MOBILE_LINK_MAX_LENGTH);
    const parsed = parseMobileLink(link);
    // Every agent is still named, so the link carries no count.
    expect(parsed?.agents.map((a) => a.name)).toEqual(agents.map((a) => a.name));
    expect(parsed?.agents_total).toBeUndefined();
    // The hosts kept are a prefix: the first agents keep theirs, the last lose them.
    const kept = parsed?.agents.filter((a) => a.host !== undefined).length ?? 0;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(60);
    expect(parsed?.agents.slice(0, kept)).toEqual(agents.slice(0, kept));
    expect(parsed?.agents.slice(kept).every((a) => a.host === undefined)).toBe(true);
    // And as many as fit: putting the next one back would pass the limit.
    expect(link.length + `:${agents[kept]?.host}`.length).toBeGreaterThan(MOBILE_LINK_MAX_LENGTH);
  });

  test("the encoder refuses what the parser would refuse", () => {
    expect(() => encodeMobileLink({ ...BASE, fleet_id: "FXTR0001" })).toThrow();
    expect(() => encodeMobileLink({ ...BASE, account_id: "1234" })).toThrow();
    expect(() => encodeMobileLink({ ...BASE, agents: [{ name: "Bad_Name" }] })).toThrow();
    expect(() => encodeMobileLink({ ...BASE, agents: [{ name: "a" }, { name: "a" }] })).toThrow();
    expect(() =>
      encodeMobileLink({ ...BASE, agents: [{ name: "a", host: "https://evil.example" }] }),
    ).toThrow();
  });

  test("hostile and malformed input parses to null and never throws", () => {
    const hostile: unknown[] = [
      undefined,
      null,
      42,
      {},
      "",
      "javascript:alert(1)",
      "javascript://fleet?v=2&fleet=fxtr0001",
      "https://hermetic.ts.net/?v=2",
      "hermetic://pair?host=1.2.3.4&port=7877&code=ABCD2345",
      "hermetic://fleet",
      "hermetic://fleet?",
      linkWith({ v: "1" }),
      linkWith({ v: "4" }),
      linkWith({ v: "" }),
      linkWith({ account: "12345" }),
      linkWith({ account: "12345678901a" }),
      linkWith({ fleet: "FXTR0001" }),
      linkWith({ fleet: "fxtr000" }),
      linkWith({ alias: "Main" }),
      linkWith({ region: "us-west" }),
      linkWith({ tailnet: "localhost" }),
      linkWith({ tailnet: "evil.example/../x" }),
      linkWith({ agents: "atlas,atlas" }),
      linkWith({ agents: "_fleet" }),
      linkWith({ agents: "atlas:" }),
      linkWith({ agents: "atlas:https://evil.example" }),
      linkWith({ agents: "atlas:evil.example:443" }),
      linkWith({ agents: "<script>" }),
      linkWith({ agents: "atlas,,ember" }),
      linkWith({ agents: "%E0%A4%A" }),
      `${linkWith({})}&fleet=fxtr0002`,
      `${linkWith({ prefs: "avatar_style:pixel" })}&prefs=avatar_style:blob`,
      `${linkWith({})}#frag`,
      `${linkWith({})}&noequals`,
      "hermetic://fleet?v=3&fleet=fxtr0001&alias=main&account=123456789012&region=us-west-2&tailnet=hermetic.ts.net",
      `${linkWith({})}${"a".repeat(10_240)}`,
      "x".repeat(10_240),
      `hermetic://fleet?${"&".repeat(10_000)}`,
    ];
    for (const input of hostile) {
      expect(() => parseMobileLink(input)).not.toThrow();
      expect([String(input).slice(0, 80), parseMobileLink(input)]).toEqual([
        String(input).slice(0, 80),
        null,
      ]);
    }
    // The control: the same builder with nothing altered parses.
    expect(parseMobileLink(linkWith({}))).not.toBeNull();
  });

  test("unknown parameters are ignored, so a later field does not break an older phone", () => {
    expect(parseMobileLink(`${linkWith({})}&extra=1`)).not.toBeNull();
  });

  test("a v2 link, which has no prefs, still parses, with empty prefs", () => {
    const v2 = linkWith({ v: "2" });
    expect(parseMobileLink(v2)).toEqual({
      fleet_id: "fxtr0001",
      alias: "main",
      account_id: "123456789012",
      region: "us-west-2",
      tailnet: "hermetic.ts.net",
      agents: [{ name: "atlas" }],
      prefs: {},
    });
  });

  test("prefs roundtrip, and an empty prefs writes no parameter", () => {
    const link = encodeMobileLink({ ...BASE, prefs: { avatar_style: "pixel" } });
    expect(link).toContain("&prefs=avatar_style:pixel&");
    expect(parseMobileLink(link)?.prefs).toEqual({ avatar_style: "pixel" });
    expect(encodeMobileLink({ ...BASE, prefs: {} })).not.toContain("prefs=");
    expect(encodeMobileLink({ ...BASE, prefs: undefined })).toBe(encodeMobileLink(BASE));
  });

  test("an unknown pref key, a bad value or a repeated key is dropped; the rest is kept", () => {
    const prefs = (raw: string) => parseMobileLink(linkWith({ prefs: raw }))?.prefs;
    expect(prefs("avatar_style:sigil;theme:dark")).toEqual({ avatar_style: "sigil" });
    expect(prefs("theme:dark;avatar_style:blob")).toEqual({ avatar_style: "blob" });
    expect(prefs("avatar_style:emoji")).toEqual({});
    expect(prefs("avatar_style:pixel;avatar_style:blob")).toEqual({});
    expect(prefs("")).toEqual({});
  });

  test("a malformed prefs string reads as no prefs, never as a refused link", () => {
    for (const raw of [
      "avatar_style",
      "avatar_style:pixel;",
      ";",
      "avatar_style=pixel",
      "Avatar_Style:pixel",
      "avatar_style:pixel;theme:%3Cscript%3E",
      "avatar_style:<b>",
      `avatar_style:${"a".repeat(40)}`,
    ]) {
      const parsed = parseMobileLink(linkWith({ prefs: raw }));
      expect([raw, parsed?.prefs]).toEqual([raw, {}]);
    }
  });

  test("the encoder refuses a pref this build's parser would drop", () => {
    const bad = [
      { avatar_style: "emoji" },
      { theme: "dark" },
    ] as unknown as MobileLinkPayload["prefs"][];
    for (const prefs of bad) {
      expect(() => encodeMobileLink({ ...BASE, prefs })).toThrow(/invalid pref/);
    }
  });

  test("prefs survive the length budget: hosts and agents go first", () => {
    const agents = Array.from({ length: 400 }, (_, i) => ({ name: `agent-number-${i}` }));
    const link = encodeMobileLink({ ...BASE, agents, prefs: { avatar_style: "pixel" } });
    expect(link.length).toBeLessThanOrEqual(MOBILE_LINK_MAX_LENGTH);
    const parsed = parseMobileLink(link);
    expect(parsed?.agents.length).toBeLessThan(400);
    expect(parsed?.prefs).toEqual({ avatar_style: "pixel" });
  });

  /** The module restates the schemas' character rules; these keep the two in step. */
  test("its character rules agree with the Zod schemas", () => {
    const cases: Array<[keyof typeof FIELD_SCHEMAS, string]> = [
      ["fleet", "fxtr0001"],
      ["fleet", "abcdefgh"],
      ["fleet", "abcdefgi"],
      ["fleet", "abcdefg"],
      ["alias", "main"],
      ["alias", "a-b-c"],
      ["alias", "-main"],
      ["alias", "Main"],
      ["alias", "a".repeat(32)],
      ["account", "123456789012"],
      ["account", "12345678901"],
      ["region", "us-west-2"],
      ["region", "ap-southeast-1"],
      ["region", "us-gov-west-1"],
      ["region", "usw2"],
    ];
    for (const [field, value] of cases) {
      const schemaOk = FIELD_SCHEMAS[field].safeParse(value).success;
      const linkOk = parseMobileLink(linkWith({ [field]: value })) !== null;
      expect([field, value, linkOk]).toEqual([field, value, schemaOk]);
    }
  });
});

const FIELD_SCHEMAS = {
  fleet: FleetIdSchema,
  alias: FleetName,
  account: AccountId,
  region: Region,
} as const;

describe("mobileLinkAgents", () => {
  test("a host only where the real name differs from the derived one", () => {
    const agents = mobileLinkAgents(
      [
        { name: "atlas", status: "ready", tailscale_dns_name: "fxtr0001-atlas.hermetic.ts.net" },
        { name: "corvid", status: "ready", tailscale_dns_name: "fxtr0001-corvid-2.hermetic.ts.net" },
        { name: "ember", status: "stopped", tailscale_dns_name: null },
        { name: "fathom", status: "ready", tailscale_dns_name: "fxtr0001-fathom.hermetic.ts.net." },
        { name: "gone", status: "destroyed", tailscale_dns_name: null },
      ],
      "fxtr0001",
      "hermetic.ts.net",
    );
    expect(agents).toEqual([
      { name: "atlas" },
      { name: "corvid", host: "fxtr0001-corvid-2.hermetic.ts.net" },
      { name: "ember" },
      { name: "fathom" },
    ]);
  });
});

describe("mobile.pair in fixture mode", () => {
  test("the fixture fleet's link is well under a QR's capacity, and every agent is in it", async () => {
    const h = await openHermetic({
      fixture: true,
      home: mkdtempSync(join(tmpdir(), "hermetic-mobile-link-")),
    });
    const result = MobilePairResult.parse(await h.mobile.pair({}));
    expect(result.link.length).toBeLessThan(2_900);
    expect(result.agents.length).toBe(11);
    expect(result.agents_in_link).toBe(result.agents.length);
    expect(result.fleet).toEqual({
      fleet_id: "fxtr0001",
      alias: "main",
      account_id: "123456789012",
      region: "us-west-2",
      tailnet: "hermetic.ts.net",
    });
    expect(() => encodeQr(result.link)).not.toThrow();
    expect(result.prefs).toEqual({});
  });

  test("carries the prefs it is asked to, and answers what the link holds", async () => {
    const h = await openHermetic({
      fixture: true,
      home: mkdtempSync(join(tmpdir(), "hermetic-mobile-link-")),
    });
    const result = MobilePairResult.parse(await h.mobile.pair({ prefs: { avatar_style: "sigil" } }));
    expect(result.prefs).toEqual({ avatar_style: "sigil" });
    expect(parseMobileLink(result.link)?.prefs).toEqual({ avatar_style: "sigil" });
    await expect(h.mobile.pair({ prefs: { avatar_style: "emoji" } })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(h.mobile.pair({ prefs: { theme: "dark" } })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  test("refuses an option it does not take", async () => {
    const h = await openHermetic({
      fixture: true,
      home: mkdtempSync(join(tmpdir(), "hermetic-mobile-link-")),
    });
    await expect(h.mobile.pair({ ttl_ms: 60_000 })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
