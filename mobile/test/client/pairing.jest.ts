import {
  deviceNameFor,
  pairedFleetMismatch,
  pairErrorCopy,
  pairHostAllowed,
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
