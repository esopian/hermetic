/**
 * What the Pair screen says when pairing fails: one sentence per way it can
 * fail, keyed by the bridge's error code (`.context/mobile-protocol.md`, HTTP
 * statuses) and the client's own (`CLIENT_ERROR_CODES`). Pure.
 */
import { MOBILE_PROTOCOL } from "../protocol/constants.ts";
import type { Hello } from "../protocol/types.ts";
import { BridgeError, CLIENT_ERROR_CODES } from "./errors.ts";

export interface PairErrorCopy {
  title: string;
  detail: string;
}

export function pairErrorCopy(error: unknown, where?: string): PairErrorCopy {
  const code = error instanceof BridgeError ? error.code : "UNKNOWN";
  const message = error instanceof Error ? error.message : String(error);
  const at = where ? ` at ${where}` : "";
  switch (code) {
    case "PAIR_CODE_INVALID":
    case "CONFLICT":
      return {
        title: "That code did not work.",
        detail:
          "It is wrong, expired (codes last 10 minutes) or already used. Run `hermetic mobile pair` on the laptop for a new one.",
      };
    case "RATE_LIMITED":
      return {
        title: "Too many tries.",
        detail: "The bridge locks pairing for a minute after five wrong codes. Wait, then try again.",
      };
    case "PROTOCOL_MISMATCH":
      return {
        title: "This app and the bridge do not speak the same version.",
        detail: `The app speaks protocol ${MOBILE_PROTOCOL.PROTOCOL_VERSION}. Update whichever side is older, then pair again.`,
      };
    case "NETWORK":
    case "TIMEOUT":
      return {
        title: `No bridge answered${at}.`,
        detail:
          "Check `hermetic mobile serve` (or Settings → Mobile on the desktop) is running, and that this phone can reach the laptop — on the same tailnet, with Tailscale connected.",
      };
    case "BAD_RESPONSE":
      return {
        title: `Something answered${at}, but not a Hermetic bridge.`,
        detail: "Check the host and port the laptop printed.",
      };
    case "VALIDATION":
      return { title: "The bridge refused the request.", detail: message };
    case "WRONG_FLEET":
      return { title: "That bridge serves a different fleet.", detail: message };
    default:
      return { title: "Pairing failed.", detail: message };
  }
}

/** A host the phone can dial: a name or address, no scheme, no path. */
export function validHost(host: string): boolean {
  const h = host.trim();
  return h.length > 0 && !/[\s/]/.test(h) && !/^[a-z]+:\/\//i.test(h);
}

export function validPort(port: string): boolean {
  const n = Number(port);
  return Number.isInteger(n) && n > 0 && n <= 65535;
}

/* ── which hosts a phone may pair with ──────────────────────────────────── */

/**
 * Why a host may be paired with. The bridge speaks plain HTTP and hands back a
 * device token, so the phone only dials somewhere the link itself is private:
 * this device (the simulator against a laptop bridge on loopback), or a
 * Tailscale address — the tailnet's WireGuard tunnel is the encryption.
 */
export type PairHostKind = "loopback" | "tailnet-ipv4" | "tailnet-ipv6" | "magicdns";

export type PairHostCheck = { ok: true; kind: PairHostKind } | { ok: false; reason: string };

export const PAIR_HOST_REFUSED =
  "Hermetic pairs only over Tailscale: a 100.64.0.0/10 or fd7a:115c:a1e0::/48 address, a *.ts.net name, or this device's loopback. Use the address `hermetic mobile serve` printed.";

function ipv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => (/^(0|[1-9][0-9]{0,2})$/.test(p) ? Number(p) : Number.NaN));
  return octets.every((o) => o >= 0 && o <= 255) ? octets : null;
}

/** The eight 16-bit groups of an IPv6 literal (no zone, no embedded IPv4), or `null`. */
function ipv6(host: string): number[] | null {
  if (!/^[0-9a-f:]+$/i.test(host) || host.includes(":::")) return null;
  const halves = host.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string | undefined) => (part ? part.split(":") : []);
  const head = groups(halves[0]);
  const tail = groups(halves[1]);
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (all.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return all.map((g) => Number.parseInt(g, 16));
}

/** A DNS name: dot-separated labels of letters, digits and inner hyphens. */
function dnsName(host: string): boolean {
  const labels = host.split(".");
  return labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l));
}

/**
 * Whether the phone may pair with `host`: loopback, Tailscale's CGNAT range
 * `100.64.0.0/10`, its IPv6 ULA `fd7a:115c:a1e0::/48`, or a MagicDNS
 * `*.ts.net` name. Anything else — a LAN address, a public name — is refused.
 */
export function pairHostAllowed(input: string): PairHostCheck {
  const host = input
    .trim()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "")
    .toLowerCase();
  if (!host || !validHost(host)) return { ok: false, reason: "That is not a host name or address." };
  if (host === "localhost" || host === "::1") return { ok: true, kind: "loopback" };
  const v4 = ipv4(host);
  if (v4) {
    if (v4[0] === 127) return { ok: true, kind: "loopback" };
    if (v4[0] === 100 && v4[1]! >= 64 && v4[1]! <= 127) return { ok: true, kind: "tailnet-ipv4" };
    return { ok: false, reason: PAIR_HOST_REFUSED };
  }
  if (host.includes(":")) {
    const v6 = ipv6(host);
    if (!v6) return { ok: false, reason: "That is not a valid IPv6 address." };
    if (v6.slice(0, 7).every((g) => g === 0) && v6[7] === 1) return { ok: true, kind: "loopback" };
    if (v6[0] === 0xfd7a && v6[1] === 0x115c && v6[2] === 0xa1e0)
      return { ok: true, kind: "tailnet-ipv6" };
    return { ok: false, reason: PAIR_HOST_REFUSED };
  }
  if (dnsName(host) && host.endsWith(".ts.net") && host !== "ts.net")
    return { ok: true, kind: "magicdns" };
  return { ok: false, reason: PAIR_HOST_REFUSED };
}

/* ── what pairing sends and checks ──────────────────────────────────────── */

/**
 * The name this phone gives itself, made acceptable to the bridge
 * (`MobileDeviceName`: trimmed, 1–64 characters, no control or bidi-override
 * characters). Falls back to "iPhone".
 */
export function deviceNameFor(raw: string | null | undefined): string {
  const cleaned = (raw ?? "")
    .replace(/[\p{Cc}\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, "")
    .trim()
    .slice(0, 64)
    .trim();
  return cleaned || "iPhone";
}

/**
 * After a pair: the link named a fleet, and the bridge answered for another.
 * The token is not kept — this phone stays as it was — and the device it
 * created on the laptop is the operator's to revoke.
 */
export function pairedFleetMismatch(
  expected: string | null | undefined,
  hello: Pick<Hello, "fleet">,
): BridgeError | null {
  if (!expected || hello.fleet.fleet_id === expected) return null;
  return new BridgeError(
    CLIENT_ERROR_CODES.WRONG_FLEET,
    `The link was for fleet ${expected}, but the bridge answered for ${hello.fleet.alias ?? hello.fleet.fleet_id} (${hello.fleet.fleet_id}). This phone did not keep the pairing; revoke the new device on the laptop with \`hermetic mobile revoke\`.`,
  );
}
