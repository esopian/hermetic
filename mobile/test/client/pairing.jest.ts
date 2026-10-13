import {
  cleanLabel,
  deviceNameFor,
  pairConfirmLabels,
  pairedFleetMismatch,
  pairErrorCopy,
  pairHostAllowed,
  pairProposal,
} from "../../src/client/pairing.ts";
import { hello } from "../helpers/fixtures.ts";

describe("pairHostAllowed", () => {
  test.each([
    ["127.0.0.1", "loopback"],
    ["localhost", "loopback"],
    ["::1", "loopback"],
    ["[::1]", "loopback"],
    ["100.64.0.1", "tailnet-ipv4"],
    ["100.127.255.254", "tailnet-ipv4"],
    ["fd7a:115c:a1e0::1", "tailnet-ipv6"],
    ["[FD7A:115C:A1E0:AB12:4843:CD96:6258:B240]", "tailnet-ipv6"],
    ["laptop.tail1234.ts.net", "magicdns"],
    ["Laptop.Tail1234.TS.NET.", "magicdns"],
  ])("allows %s (%s)", (host, kind) => {
    expect(pairHostAllowed(host)).toEqual({ ok: true, kind });
  });

  test.each([
    "100.63.255.255",
    "100.128.0.1",
    "192.168.1.10",
    "10.0.0.2",
    "8.8.8.8",
    "fd7a:115c:a1e1::1",
    "fe80::1",
    "example.com",
    "ts.net",
    "evil.ts.net.example.com",
    "laptop.local",
    "laptop",
    "laptop.tail1234.ts.net@evil.com",
    "laptop.tail1234.ts.net/x",
    "http://100.64.0.1",
    "",
    "100.64.0.01",
    "1:2:3",
  ])("refuses %p with a reason", (host) => {
    const check = pairHostAllowed(host);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason.length).toBeGreaterThan(10);
  });
});

describe("deviceNameFor", () => {
  test("strips control and bidi characters, trims, caps at 64, falls back to iPhone", () => {
    expect(deviceNameFor("Evan‮'s iPhone\n")).toBe("Evan's iPhone");
    expect(deviceNameFor("x".repeat(80))).toHaveLength(64);
    expect(deviceNameFor("  ‏ ")).toBe("iPhone");
    expect(deviceNameFor(null)).toBe("iPhone");
  });
});

describe("pairedFleetMismatch", () => {
  test("no fleet in the link, or the same fleet: fine", () => {
    expect(pairedFleetMismatch(null, hello())).toBeNull();
    expect(pairedFleetMismatch("fxtr0001", hello())).toBeNull();
  });

  test("another fleet: a WRONG_FLEET error the Pair screen can word", () => {
    const err = pairedFleetMismatch("sg7k2m4p", hello());
    expect(err?.code).toBe("WRONG_FLEET");
    expect(err?.message).toContain("sg7k2m4p");
    expect(err?.message).toContain("fxtr0001");
    expect(pairErrorCopy(err).title).toBe("That bridge serves a different fleet.");
  });
});

describe("pairProposal — what reaches the confirmation", () => {
  const link = { host: "100.64.0.9", port: 7877, code: "WXYZ5678", fleet: "fxtr0001", name: "main" };

  test("a good link passes, cleaned", () => {
    expect(pairProposal(link)).toEqual({ ok: true, target: link });
  });

  test.each([70000, -5, 1.5, 0, Number.NaN])("port %p is refused before the confirmation", (port) => {
    const p = pairProposal({ ...link, port });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.error.title).toBe("That port is not valid.");
  });

  test("an off-tailnet host is refused, and its echo is cleaned", () => {
    const p = pairProposal({ ...link, host: "192.168.1.10\u202E" });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.error.title).toBe("192.168.1.10 is not on your tailnet.");
  });

  test("a bracketed IPv6 host is unwrapped", () => {
    const p = pairProposal({ ...link, host: "[fd7a:115c:a1e0::9]" });
    expect(p.ok && p.target.host).toBe("fd7a:115c:a1e0::9");
  });

  test.each([
    "FXTR0001",
    "fxtr001",
    "fxtr00011",
    "fxtr-001",
    "evil fleet",
    "fxtr000\u202E",
    "fxtr000i",
  ])("fleet id %p is refused", (fleet) => {
    const p = pairProposal({ ...link, fleet });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.error.title).toBe("That pairing link names no valid fleet.");
  });

  test("no fleet is fine (a typed code); the name loses control and bidi characters and is capped", () => {
    const p = pairProposal({ ...link, fleet: null, name: `\u202Eniam\u0007 ${"x".repeat(100)}` });
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.target.fleet).toBeNull();
      expect(p.target.name).toBe(`niam ${"x".repeat(59)}`);
      expect(p.target.name!.length).toBe(64);
    }
    const blank = pairProposal({ ...link, name: "\u202A\u202C" });
    expect(blank.ok && blank.target.name).toBeNull();
  });
});

describe("pairConfirmLabels", () => {
  test("brackets an IPv6 host once, whether or not it came bracketed", () => {
    const base = { port: 7877, code: "WXYZ5678" };
    expect(pairConfirmLabels({ ...base, host: "fd7a:115c:a1e0::9" }).bridge).toBe(
      "[fd7a:115c:a1e0::9]:7877",
    );
    expect(pairConfirmLabels({ ...base, host: "[fd7a:115c:a1e0::9]" }).bridge).toBe(
      "[fd7a:115c:a1e0::9]:7877",
    );
    expect(pairConfirmLabels({ ...base, host: "100.64.0.9" }).bridge).toBe("100.64.0.9:7877");
  });

  test("never shows a malformed fleet id or a raw name", () => {
    const base = { host: "100.64.0.9", port: 7877, code: "WXYZ5678" };
    expect(pairConfirmLabels({ ...base, fleet: "fxtr0001", name: "main" }).fleet).toBe(
      "main · fxtr0001",
    );
    expect(pairConfirmLabels({ ...base, fleet: "fxtr0001", name: "fxtr0001" }).fleet).toBe("fxtr0001");
    expect(pairConfirmLabels({ ...base, fleet: "EVIL", name: "\u202Emain" }).fleet).toBe("main");
    expect(pairConfirmLabels({ ...base }).fleet).toBeNull();
  });

  test("cleanLabel caps at 64 by default", () => {
    expect(cleanLabel("a".repeat(80))).toHaveLength(64);
    expect(cleanLabel(null)).toBe("");
  });
});
