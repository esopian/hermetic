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

/**
 * A host the noVNC URL may name: a lower-case DNS name — letters, digits, dots
 * and hyphens, nothing else. No `/`, `@`, `:` or `?`, so a box's reported name
 * can never smuggle a userinfo, a port or a path into the URL the WebView loads.
 */
export const TAILNET_HOST = /^[a-z0-9][a-z0-9.-]*$/;

export function validTailnetHost(host: string): boolean {
  return host.length <= 253 && TAILNET_HOST.test(host) && !host.includes("..");
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

/** A Serve path: `/`-separated segments of letters, digits, `.`, `_` and `-`. */
const SERVE_PATH = /^(\/[A-Za-z0-9._-]+)+$/;

/**
 * `null` when there is no tailnet name to build a host from, or when the name
 * (or the browser's Serve path) is not one a URL can carry safely.
 */
export function noVncUrl(
  agent: Pick<AgentView, "name" | "tailscale_dns_name">,
  tailnet: string | null,
  fleetId: string | null,
  opts: VncOptions = {},
): string | null {
  if (!agent.tailscale_dns_name && !tailnet) return null;
  const host = agentHostname(agent, tailnet ?? "", cloudName(fleetId, agent.name)).toLowerCase();
  if (!validTailnetHost(host)) return null;
  const path = `/${(opts.servePath ?? "/vnc").replace(/^\/+|\/+$/g, "")}`;
  if (!SERVE_PATH.test(path) || path.split("/").some((seg) => seg === "." || seg === "..")) return null;
  const socket = `${path.replace(/^\//, "")}/websockify`;
  const view = opts.viewOnly ? "&view_only=true" : "";
  return `https://${host}${path}/vnc.html?path=${socket}&autoconnect=true&resize=scale&reconnect=true${view}`;
}

/** The one origin a noVNC URL loads from (`https://host`), for the WebView's allow-list. */
export function noVncOrigin(url: string): string | null {
  const match = /^https:\/\/([a-z0-9][a-z0-9.-]*)\//.exec(url);
  return match ? `https://${match[1]}` : null;
}

/**
 * Whether the WebView may navigate to `url`: only the noVNC origin itself.
 * `originWhitelist` alone is a prefix match (`https://host` also admits
 * `https://host.example` and `https://host:8443`), so the screen checks the
 * exact authority here too. Everything else is handed to the OS, not loaded.
 */
export function vncNavigationAllowed(url: string, origin: string): boolean {
  if (url === "about:blank") return true;
  const authority = /^[A-Za-z][A-Za-z0-9+\-.]+:(\/\/)?[^/?#]*/.exec(url);
  return authority !== null && authority[0].toLowerCase() === origin;
}

export type VncScale = "fit" | "actual";

/**
 * JavaScript run inside the noVNC page to switch its scaling: `fit` is noVNC's
 * `resize=scale` (the remote screen shrinks to the view), `actual` is `off`
 * (1:1, pan and pinch). Sets the settings control and the live client both.
 */
export function vncScaleScript(scale: VncScale): string {
  const mode = scale === "fit" ? "scale" : "off";
  return `(function(){try{var m=${JSON.stringify(mode)};var s=document.getElementById('noVNC_setting_resize');if(s){s.value=m;s.dispatchEvent(new Event('change'));}if(window.UI&&UI.rfb){UI.rfb.scaleViewport=(m==='scale');UI.rfb.clipViewport=(m!=='scale');}}catch(e){}})();true;`;
}
