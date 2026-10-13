/**
 * What the Pair screen says when pairing fails: one sentence per way it can
 * fail, keyed by the bridge's error code (`.context/mobile-protocol.md`, HTTP
 * statuses) and the client's own (`CLIENT_ERROR_CODES`). Pure.
 */
import { MOBILE_PROTOCOL } from "../protocol/constants.ts";
import { BridgeError } from "./errors.ts";

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
