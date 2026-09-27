/**
 * The agent drawer's address, both directions. `App.tsx` reads the hash on load
 * and on `hashchange` and writes it back from state, so a spelling that does not
 * round-trip would either drop a drawer on reload or write a hash that reopens a
 * different one.
 */
import { describe, expect, test } from "bun:test";
import { AGENT_TABS, DEFAULT_AGENT_TAB, agentHash, parseAgentHash } from "../src/nav/agent-nav.ts";

describe("parseAgentHash", () => {
  test("a bare agent hash is the Overview tab", () => {
    expect(parseAgentHash("#agent/lumen")).toEqual({ name: "lumen", tab: "overview" });
  });

  test("the desktop tab is addressable, which is the point of the second axis", () => {
    expect(parseAgentHash("#agent/lumen/desktop")).toEqual({ name: "lumen", tab: "desktop" });
  });

  test("a hash that is not an agent is not an agent", () => {
    for (const hash of ["", "#", "#settings", "#settings/providers", "#volumes", "#agent/"]) {
      expect(parseAgentHash(hash)).toBeNull();
    }
  });

  /** A stale bookmark opens the agent it names, on the landing tab — it does not bounce. */
  test("an unknown tab lands on the default rather than nowhere", () => {
    expect(parseAgentHash("#agent/lumen/telemetry")).toEqual({
      name: "lumen",
      tab: DEFAULT_AGENT_TAB,
    });
  });

  test("the leading `#` is optional, as it is for settings", () => {
    expect(parseAgentHash("agent/lumen/desktop")).toEqual({ name: "lumen", tab: "desktop" });
  });
});

describe("agentHash", () => {
  test("overview has one spelling, not two", () => {
    expect(agentHash("lumen")).toBe("#agent/lumen");
    expect(agentHash("lumen", "overview")).toBe("#agent/lumen");
    expect(agentHash("lumen", "desktop")).toBe("#agent/lumen/desktop");
  });

  test("every tab round-trips", () => {
    for (const tab of AGENT_TABS) {
      expect(parseAgentHash(agentHash("lumen", tab))).toEqual({ name: "lumen", tab });
    }
  });
});

describe("the drawer's sections", () => {
  /** The left nav's order is the mockup's, and a reader of the hash relies on the names. */
  test("are the six the nav lists, in its order", () => {
    expect([...AGENT_TABS]).toEqual(["overview", "chat", "desktop", "logs", "config", "lifecycle"]);
  });

  /** Links written when the drawer had only two tabs still land where they did. */
  test("the two-tab spellings still parse", () => {
    expect(parseAgentHash("#agent/lumen/overview")).toEqual({ name: "lumen", tab: "overview" });
    expect(parseAgentHash("#agent/lumen/desktop")).toEqual({ name: "lumen", tab: "desktop" });
  });

  test("a new section is addressable", () => {
    expect(parseAgentHash("#agent/lumen/lifecycle")).toEqual({ name: "lumen", tab: "lifecycle" });
    expect(agentHash("lumen", "logs")).toBe("#agent/lumen/logs");
  });
});
