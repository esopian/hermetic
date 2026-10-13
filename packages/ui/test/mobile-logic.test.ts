/**
 * Settings › Mobile's pure rules (`src/logic/mobile-logic.ts`): the address
 * parse, the bridge feed's frames, and the strings the page formats.
 */
import { describe, expect, test } from "bun:test";
import { MOBILE_PROTOCOL } from "@hermetic/core";
import {
  DEFAULT_MOBILE_PORT,
  addressDirty,
  describeFeedEvent,
  draftOf,
  fmtCountdown,
  fmtStamp,
  formatPairCode,
  isWildcardHost,
  mobileFeedEvent,
  nextConnected,
  parseAddress,
  platformLabel,
} from "../src/logic/mobile-logic.ts";

const STATUS = {
  host: "127.0.0.1",
  port: 7877,
  url: "http://127.0.0.1:7877",
  started_at: "2026-10-13T10:00:00.000Z",
  connected: 1,
  app: "desktop" as const,
};

describe("the address form", () => {
  test("the default port is core's", () => {
    expect(DEFAULT_MOBILE_PORT).toBe(MOBILE_PROTOCOL.DEFAULT_PORT);
  });

  test("empty fields clear the overrides", () => {
    expect(parseAddress({ host: " ", port: "" })).toEqual({
      ok: true,
      patch: { host: null, port: null },
    });
  });

  test("a host and a port are written trimmed and typed", () => {
    expect(parseAddress({ host: " 100.64.0.9 ", port: " 8123 " })).toEqual({
      ok: true,
      patch: { host: "100.64.0.9", port: 8123 },
    });
  });

  test("a URL, a bad port and port zero are refused with a sentence", () => {
    for (const draft of [
      { host: "http://laptop", port: "" },
      { host: "", port: "99999" },
      { host: "", port: "0" },
      { host: "", port: "80.5" },
      { host: "", port: "-1" },
    ]) {
      const parsed = parseAddress(draft);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.length).toBeGreaterThan(0);
    }
  });

  test("dirty compares against what is saved, ignoring surrounding spaces", () => {
    const saved = { enabled: true, host: null, port: 9000 };
    expect(draftOf(saved)).toEqual({ host: "", port: "9000" });
    expect(addressDirty(saved, { host: "", port: " 9000" })).toBe(false);
    expect(addressDirty(saved, { host: "0.0.0.0", port: "9000" })).toBe(true);
    expect(addressDirty(null, { host: "", port: "" })).toBe(false);
  });

  test("wildcard hosts are the IPv4 and IPv6 any-addresses", () => {
    expect(isWildcardHost("0.0.0.0")).toBe(true);
    expect(isWildcardHost("::")).toBe(true);
    expect(isWildcardHost("[::]")).toBe(true);
    expect(isWildcardHost("100.64.0.9")).toBe(false);
    expect(isWildcardHost(null)).toBe(false);
  });
});

describe("the feed", () => {
  test("status frames, with and without a bridge", () => {
    expect(mobileFeedEvent({ event: "status", data: STATUS })).toEqual({
      kind: "status",
      status: STATUS,
    });
    expect(mobileFeedEvent({ event: "status", data: null })).toEqual({ kind: "status", status: null });
    expect(mobileFeedEvent({ event: "status", data: { url: 1 } })).toBeNull();
  });

  test("paired and device frames carry the core event's fields", () => {
    expect(
      mobileFeedEvent({ event: "paired", data: { type: "paired", device_id: "d1", name: "Pixel" } }),
    ).toEqual({ kind: "paired", device_id: "d1", name: "Pixel" });
    expect(
      mobileFeedEvent({
        event: "device",
        data: { type: "device", device_id: "d1", action: "connected" },
      }),
    ).toEqual({ kind: "device", device_id: "d1", action: "connected" });
  });

  test("frames the page has no use for read as null", () => {
    expect(
      mobileFeedEvent({ event: "device", data: { device_id: "d1", action: "exploded" } }),
    ).toBeNull();
    expect(mobileFeedEvent({ event: "listening", data: { device_id: "d1" } })).toBeNull();
    expect(mobileFeedEvent({ event: "paired", data: "d1" })).toBeNull();
  });

  test("connections are learned from device events and cleared by a stop", () => {
    let connected = nextConnected(new Set(), { kind: "device", device_id: "a", action: "connected" });
    connected = nextConnected(connected, { kind: "device", device_id: "b", action: "connected" });
    expect([...connected].sort()).toEqual(["a", "b"]);
    connected = nextConnected(connected, { kind: "device", device_id: "a", action: "revoked" });
    expect([...connected]).toEqual(["b"]);
    connected = nextConnected(connected, { kind: "status", status: STATUS });
    expect([...connected]).toEqual(["b"]);
    expect(nextConnected(connected, { kind: "status", status: null }).size).toBe(0);
  });

  test("the last-event line names the phone", () => {
    const nameOf = (id: string) => (id === "d1" ? "Pixel" : id);
    expect(describeFeedEvent({ kind: "paired", device_id: "d1", name: "Pixel" }, nameOf)).toBe(
      "paired Pixel",
    );
    expect(describeFeedEvent({ kind: "device", device_id: "d1", action: "disconnected" }, nameOf)).toBe(
      "Pixel disconnected",
    );
    expect(describeFeedEvent({ kind: "status", status: STATUS }, nameOf)).toBeNull();
    expect(describeFeedEvent({ kind: "status", status: null }, nameOf)).toBe("bridge stopped");
  });
});

describe("formatting", () => {
  test("pair codes read in two groups; anything else is left alone", () => {
    expect(formatPairCode("ABCD2345")).toBe("ABCD-2345");
    expect(formatPairCode("ABC")).toBe("ABC");
  });

  test("countdowns round up and stop at zero", () => {
    expect(fmtCountdown(299_001)).toBe("5:00");
    expect(fmtCountdown(65_000)).toBe("1:05");
    expect(fmtCountdown(-3_000)).toBe("0:00");
  });

  test("stamps are en-US and never throw on a bad value", () => {
    expect(fmtStamp(null)).toBe("—");
    expect(fmtStamp("not a date")).toBe("—");
    expect(fmtStamp("2026-10-13T10:00:00.000Z")).toMatch(/^Oct 1[34]/);
  });

  test("platforms have their proper names", () => {
    expect(platformLabel("ios")).toBe("iOS");
    expect(platformLabel("android")).toBe("Android");
    expect(platformLabel("other")).toBe("Other");
  });
});
