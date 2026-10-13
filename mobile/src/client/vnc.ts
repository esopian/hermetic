/**
 * The noVNC client URL for an agent's browser desktop — the phone's mirror of
 * `agentHostname` / `agentDesktopClientUrl` in `packages/core/src/shared/naming.ts`.
 *
 * Only the long form works from a WebView: `/vnc/vnc.html?path=vnc/websockify`.
 * noVNC builds its socket URL from the site root, so without `path=` a client
 * served under `/vnc` dials the dashboard's `/websockify` and never upgrades,
 * and a plain `/vnc` 404s the socket.
 */
import type { AgentView } from "../protocol/types.ts";

export function cloudName(fleetId: string | null | undefined, agent: string): string {
  return fleetId ? `${fleetId}-${agent}` : agent;
}

export function agentHostname(
  agent: Pick<AgentView, "name" | "tailscale_dns_name">,
  tailnet: string,
  cloud?: string | null,
): string {
  return (agent.tailscale_dns_name ?? `${cloud ?? agent.name}.${tailnet}`).replace(/\.$/, "");
}

export interface VncOptions {
  /** The browser identity's Serve path (`AgentView.browsers[].serve_path`); `/vnc` for `default`. */
  servePath?: string;
  viewOnly?: boolean;
}

/** `null` when there is no tailnet name to build a host from. */
export function noVncUrl(
  agent: Pick<AgentView, "name" | "tailscale_dns_name">,
  tailnet: string | null,
  fleetId: string | null,
  opts: VncOptions = {},
): string | null {
  if (!agent.tailscale_dns_name && !tailnet) return null;
  const host = agentHostname(agent, tailnet ?? "", cloudName(fleetId, agent.name));
  const path = `/${(opts.servePath ?? "/vnc").replace(/^\/+|\/+$/g, "")}`;
  const socket = `${path.replace(/^\//, "")}/websockify`;
  const view = opts.viewOnly ? "&view_only=true" : "";
  return `https://${host}${path}/vnc.html?path=${socket}&autoconnect=true&resize=scale&reconnect=true${view}`;
}
