import { describe, expect, test } from "bun:test";
import {
  agentDashboardUrl,
  agentHostname,
  agentHostnameMismatch,
  cloudName,
  legacyCloudNames,
  staleDeviceNote,
  trustedDnsName,
} from "../src/shared/index.ts";

/**
 * `tailscale_dns_name` is written by the box, and every box in a fleet may
 * write every agent's row, so the name is only used when it is one hermetic
 * gives the agent, in the fleet's own tailnet (`trustedDnsName`).
 */
const TAILNET = "hermetic.ts.net";
const FLEET_ID = "k7m2x9qa";
const canonical = cloudName(FLEET_ID, "atlas");
const legacy = legacyCloudNames("main", "atlas");
const row = (dns: string | null) => ({ name: "atlas", tailscale_dns_name: dns });

describe("trustedDnsName", () => {
  const names = [canonical, ...legacy];

  test("accepts each of this agent's own spellings, normalised", () => {
    expect(trustedDnsName(`${canonical}.${TAILNET}`, TAILNET, names)).toBe(`${canonical}.${TAILNET}`);
    expect(trustedDnsName("main-atlas.hermetic.ts.net", TAILNET, names)).toBe(
      "main-atlas.hermetic.ts.net",
    );
    expect(trustedDnsName("atlas.hermetic.ts.net", TAILNET, names)).toBe("atlas.hermetic.ts.net");
    // Tailscale's own spelling: fully qualified, and case is not significant.
    expect(trustedDnsName("K7M2X9QA-Atlas.Hermetic.ts.net.", TAILNET, names)).toBe(
      "k7m2x9qa-atlas.hermetic.ts.net",
    );
  });

  test("refuses anything else", () => {
    for (const forged of [
      // A sibling's canonical name.
      `${FLEET_ID}-corvid.${TAILNET}`,
      // Tailscale's collision suffix: indistinguishable from a sibling `atlas-2`.
      `${canonical}-2.${TAILNET}`,
      // This agent's name in somebody else's tailnet — a public Funnel host.
      `${canonical}.attacker.ts.net`,
      // The fleet's tailnet as a label of another zone.
      `${canonical}.${TAILNET}.attacker.ts.net`,
      // A prefix or suffix around a real name.
      `x${canonical}.${TAILNET}`,
      `${canonical}x.${TAILNET}`,
      // Not a tailnet name at all.
      "example.com",
      "10.0.0.1",
      "",
    ]) {
      expect(trustedDnsName(forged, TAILNET, names)).toBeNull();
    }
    expect(trustedDnsName(null, TAILNET, names)).toBeNull();
    expect(trustedDnsName(`${canonical}.${TAILNET}`, "", names)).toBeNull();
    expect(trustedDnsName(`${canonical}.${TAILNET}`, TAILNET, [""])).toBeNull();
  });
});

describe("agentHostname uses only a trusted reported name", () => {
  test("a trusted name wins over the canonical spelling", () => {
    expect(agentHostname(row("main-atlas.hermetic.ts.net"), TAILNET, canonical, legacy)).toBe(
      "main-atlas.hermetic.ts.net",
    );
  });

  test("a forged name falls back to the canonical spelling, in every URL built from it", () => {
    const forged = row(`${FLEET_ID}-corvid.${TAILNET}`);
    expect(agentHostname(forged, TAILNET, canonical, legacy)).toBe(`${canonical}.${TAILNET}`);
    expect(agentDashboardUrl(forged, TAILNET, canonical, legacy)).toBe(
      `https://${canonical}.${TAILNET}/`,
    );
  });

  test("the v3 spelling is trusted only when the caller names the fleet", () => {
    expect(agentHostname(row("main-atlas.hermetic.ts.net"), TAILNET, canonical)).toBe(
      `${canonical}.${TAILNET}`,
    );
  });
});

describe("agentHostnameMismatch", () => {
  const kind = (dns: string) => agentHostnameMismatch(row(dns), TAILNET, canonical, legacy)?.kind;

  test("agrees, legacy, stale and untrusted", () => {
    expect(kind(`${canonical}.${TAILNET}`)).toBeUndefined();
    expect(kind(`${canonical}.${TAILNET}.`)).toBeUndefined();
    expect(kind("main-atlas.hermetic.ts.net")).toBe("legacy");
    expect(kind(`${canonical}-2.${TAILNET}`)).toBe("stale");
    expect(kind(`${canonical}-2.attacker.ts.net`)).toBe("untrusted");
    expect(kind(`${FLEET_ID}-corvid.${TAILNET}`)).toBe("untrusted");
    expect(kind("example.com")).toBe("untrusted");
  });

  test("an untrusted name's note says it is ignored and why it matters", () => {
    const mismatch = agentHostnameMismatch(row("example.com"), TAILNET, canonical, legacy);
    if (mismatch === null) throw new Error("expected a mismatch");
    const note = staleDeviceNote("atlas", mismatch);
    expect(note).toContain("ignores it");
    expect(note).toContain(`${canonical}.${TAILNET}`);
    expect(note).toContain("compromised");
  });
});
