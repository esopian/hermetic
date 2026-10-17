/**
 * The phone's Hermes gateway client: core's adapter (`createHermesChat`, the
 * one the desktop uses), handed the phone's `fetch`, socket opener and clock.
 *
 * One client per paired fleet. The adapter keeps each box's dashboard session
 * token in its own memory (scraped from `GET /`, never persisted, never
 * logged), so a new client is a new set of tokens and nothing else to forget.
 *
 * Every effect is injected and nothing here imports React, React Native or
 * Expo, so the root `tests/mobile-gateway-e2e.test.ts` drives this module
 * under bun against a scripted Hermes-wire server.
 */
import "./polyfills.ts";
import {
  type BoxAddress,
  createHermesChat,
  type HermesChatClient,
  type HermesChatDeps,
} from "@hermetic/core/chat-client";
import { cloudName } from "@hermetic/core/shared";
import type { OpenSocket } from "./socket.ts";

export interface GatewayClientDeps {
  fetch: HermesChatDeps["fetch"];
  openSocket: OpenSocket;
  /** ISO-8601 now. */
  now: () => string;
  /** Test seam: the adapter's slot wait (defaults to its own thirty seconds). */
  slotWaitMs?: number;
}

export function createGatewayClient(deps: GatewayClientDeps): HermesChatClient {
  return createHermesChat({
    fetch: deps.fetch,
    openSocket: deps.openSocket,
    now: deps.now,
    ...(deps.slotWaitMs !== undefined ? { slotWaitMs: deps.slotWaitMs } : {}),
  });
}

/* ── where a box is ─────────────────────────────────────────────────────── */

/** What the phone knows of a fleet's names: the pairing link, merged with `GET /fleet`. */
export interface FleetHosts {
  fleet_id: string;
  /** The tailnet's MagicDNS suffix, `tail1234.ts.net`. */
  tailnet: string;
  agents: readonly { name: string; host?: string | null | undefined }[];
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A lower-case DNS name of at least two labels: no scheme, port, path or userinfo. */
function dnsName(host: string): boolean {
  return host.length <= 253 && host.includes(".") && host.split(".").every((l) => LABEL.test(l));
}

/**
 * Whether `host` names a node under this fleet's tailnet. A name reported by a
 * box (`tailscale_dns_name`) is not trusted on its own: the phone dials only
 * names under the paired tailnet, never a LAN or public address.
 */
export function onTailnet(host: string, tailnet: string): boolean {
  const zone = tailnet.trim().toLowerCase().replace(/\.$/, "");
  return dnsName(host) && dnsName(zone) && host.endsWith(`.${zone}`);
}

/**
 * The MagicDNS name of `name`'s box: the host the link or `/fleet` reported,
 * when it is under the tailnet, else the derived `<fleet>-<name>.<tailnet>`.
 */
export function agentHost(fleet: FleetHosts, name: string): string {
  const derived = `${cloudName(fleet.fleet_id, name)}.${fleet.tailnet}`.toLowerCase();
  const reported = fleet.agents
    .find((a) => a.name === name)
    ?.host?.trim()
    .toLowerCase()
    .replace(/\.$/, "");
  return reported && onTailnet(reported, fleet.tailnet) ? reported : derived;
}

/** The adapter's address for `name`'s box: `https://<host>/` through Tailscale Serve. */
export function boxAddress(fleet: FleetHosts, name: string): BoxAddress {
  return { instance: name, baseUrl: `https://${agentHost(fleet, name)}/`, fleet_id: fleet.fleet_id };
}
