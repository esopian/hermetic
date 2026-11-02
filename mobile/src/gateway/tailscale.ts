/**
 * Is Tailscale up? iOS has no public API to ask the Tailscale app, so this
 * infers it (§9.4): probe `https://<host>/api/health` (the dashboard's public
 * health route, no token) on up to three listened boxes, ready ones first
 * (`probeHosts`), 3 s each, and read the failures.
 *
 * - any probe answered (any HTTP status: the tailnet carried it) → `ok`, with
 *   the boxes that did not listed in `failing`;
 * - every probe failed to resolve its name, by an explicit DNS signature →
 *   `off` ("Tailscale is off or not signed in": MagicDNS names resolve only
 *   through Tailscale);
 * - every probe failed otherwise (timed out, refused, or a failure that does
 *   not say why) → `unreachable` ("on the tailnet, but no box answers");
 * - no hosts → `unknown`.
 *
 * **A heuristic.** React Native's `fetch` reports most network failures as a
 * bare `TypeError: Network request failed` with no code. What is matched, in
 * `classifyProbeError`:
 *
 * - name resolution: `NSURLErrorDomain` code `-1003` / `NSURLErrorCannotFindHost`,
 *   "A server with the specified hostname could not be found", "hostname could
 *   not be found", `ENOTFOUND`, `getaddrinfo`, "Unable to resolve host";
 * - timed out: this module's own 3 s abort, `-1001` / `NSURLErrorTimedOut`, "timed out";
 * - refused: `-1004` / `NSURLErrorCannotConnectToHost`, "Could not connect to the
 *   server", `ECONNREFUSED`, "Connection refused";
 * - anything else — React Native's bare "Network request failed" included,
 *   however fast it came back — is `network`, which never reads as `off`. A
 *   fast failure is not evidence of DNS: a TLS failure, a dropped route or an
 *   offline radio all fail fast too, and telling an operator to sign in to
 *   Tailscale when it is already on sends them after the wrong problem.
 *
 * Every probe also records, per host, whether HTTPS to that box worked
 * (`noteTunnel`, `hermeticd.ts`): the gate every plain-HTTP call to hermeticd
 * on 7434 passes first.
 *
 * The UI words it as a heuristic and never gates chat on it. Pure: `fetch` and
 * the clock are injected.
 *
 * **Tailscale's own answer.** Alongside the box probes, every probe also asks
 * the Tailscale client on this phone (`probeTunnel`): Tailscale serves a small
 * status page at `http://100.100.100.100/` from inside the client, never
 * forwarded to a peer. It reads `<h1>Tailscale</h1>` then either "No netmap."
 * (running, not yet connected to its tailnet) or this device's tailnet
 * addresses (connected). No answer means the tunnel is not up. That splits
 * "Tailscale is still waking" from "Tailscale is up, the box is silent", which
 * the box probes alone cannot. It is never a security gate: `100.64.0.0/10` is
 * also carrier-grade NAT space, so only the HTTPS check above opens the
 * plain-HTTP port, and this answer only chooses what the screen says.
 */
import { type FetchLike, noteTunnel } from "./hermeticd.ts";

export type TailscaleStatus = "ok" | "off" | "unreachable" | "unknown";

/**
 * What the Tailscale client on this phone says about itself: `connected`
 * (its page lists this device's addresses), `no_netmap` (it answers, but has
 * no tailnet map yet: signing in or still syncing), `down` (nothing answered:
 * the tunnel is not up), `unknown` (something answered that is not Tailscale's
 * page, so it says nothing either way).
 */
export type TunnelState = "connected" | "no_netmap" | "down" | "unknown";

export interface TailscaleProbe {
  status: TailscaleStatus;
  /** The hosts whose probe failed. */
  failing: string[];
  /** The Tailscale client's own answer (`probeTunnel`). */
  tunnel: TunnelState;
}

/** Tailscale's service address: its MagicDNS resolver and its status page live here. */
export const TAILSCALE_SERVICE_URL = "http://100.100.100.100/";
/** The status page answers from inside the client, so a short wait is plenty. */
export const TUNNEL_TIMEOUT_MS = 1_500;

/**
 * Read the status page. The plain page is Tailscale's `handleQuad100Port80Conn`
 * (`ipn/ipnlocal/local.go`); a client with the web interface turned on serves
 * that instead, which still names Tailscale and still means connected.
 */
export function readTunnelPage(status: number, body: string): TunnelState {
  if (status < 200 || status >= 400) return "unknown";
  if (/<h1>\s*Tailscale\s*<\/h1>/i.test(body)) {
    if (/No netmap|No local addresses/i.test(body)) return "no_netmap";
    return /Local addresses/i.test(body) ? "connected" : "unknown";
  }
  return /tailscale/i.test(body) ? "connected" : "unknown";
}

/** Ask the Tailscale client on this phone for its status page (`readTunnelPage`). */
export async function probeTunnel(input: {
  fetch: FetchLike;
  timeoutMs?: number;
}): Promise<TunnelState> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? TUNNEL_TIMEOUT_MS);
  try {
    const res = await input.fetch(TAILSCALE_SERVICE_URL, { method: "GET", signal: controller.signal });
    const body = await res.text().catch(() => "");
    return readTunnelPage(res.status, body);
  } catch {
    return "down";
  } finally {
    clearTimeout(timer);
  }
}

export type ProbeFailure = "dns" | "timeout" | "refused" | "network";

export const PROBE_TIMEOUT_MS = 3_000;
export const PROBE_HOSTS_MAX = 3;
export const HEALTH_PATH = "/api/health";

const DNS =
  /-1003\b|NSURLErrorCannotFindHost|hostname could not be found|ENOTFOUND|getaddrinfo|Unable to resolve host|no address associated/i;
const TIMEOUT = /-1001\b|NSURLErrorTimedOut|timed out|timeout/i;
const REFUSED =
  /-1004\b|NSURLErrorCannotConnectToHost|Could not connect to the server|ECONNREFUSED|Connection refused/i;

/** Every string an error carries: message, code, name, and its cause's. */
function textOf(error: unknown, depth = 0): string {
  if (error === null || error === undefined || depth > 3) return "";
  if (typeof error !== "object") return String(error);
  const e = error as { message?: unknown; code?: unknown; name?: unknown; cause?: unknown };
  return [e.name, e.code, e.message, textOf(e.cause, depth + 1)]
    .filter((v) => v !== undefined && v !== null && v !== "")
    .map(String)
    .join(" ");
}

/** What one failed probe says. `timedOut` is this module's own deadline having fired. */
export function classifyProbeError(error: unknown, timedOut: boolean): ProbeFailure {
  if (timedOut) return "timeout";
  const text = textOf(error);
  if (DNS.test(text)) return "dns";
  if (TIMEOUT.test(text)) return "timeout";
  if (REFUSED.test(text)) return "refused";
  // RN's bare "Network request failed", or anything else that does not say why.
  return "network";
}

/**
 * The hosts to probe, at most `PROBE_HOSTS_MAX`: agents the fleet view
 * reports `ready` first (a box that is up is the one whose silence says the
 * most), then the rest, each group in the order given; duplicates once.
 */
export function probeHosts(
  agents: readonly { host: string | null | undefined; status?: string | null | undefined }[],
): string[] {
  const ready = agents.filter((a) => a.status === "ready");
  const rest = agents.filter((a) => a.status !== "ready");
  const hosts: string[] = [];
  for (const agent of [...ready, ...rest]) {
    const host = agent.host?.trim();
    if (!host || hosts.includes(host)) continue;
    hosts.push(host);
    if (hosts.length === PROBE_HOSTS_MAX) break;
  }
  return hosts;
}

async function probe(fetch: FetchLike, host: string, timeoutMs: number): Promise<ProbeFailure | null> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    await fetch(`https://${host}${HEALTH_PATH}`, { method: "GET", signal: controller.signal });
    noteTunnel(host, true);
    return null;
  } catch (error) {
    noteTunnel(host, false);
    return classifyProbeError(error, timedOut);
  } finally {
    clearTimeout(timer);
  }
}

export async function probeTailscale(input: {
  hosts: readonly string[];
  fetch: FetchLike;
  timeoutMs?: number;
}): Promise<TailscaleProbe> {
  const hosts = [...new Set(input.hosts)].slice(0, PROBE_HOSTS_MAX);
  const timeoutMs = input.timeoutMs ?? PROBE_TIMEOUT_MS;
  const [tunnel, results] = await Promise.all([
    probeTunnel({ fetch: input.fetch, timeoutMs: Math.min(timeoutMs, TUNNEL_TIMEOUT_MS) }),
    Promise.all(hosts.map((host) => probe(input.fetch, host, timeoutMs))),
  ]);
  if (hosts.length === 0) return { status: "unknown", failing: [], tunnel };
  const failing = hosts.filter((_, i) => results[i] !== null);
  if (results.some((r) => r === null)) return { status: "ok", failing, tunnel };
  if (results.every((r) => r === "dns")) return { status: "off", failing, tunnel };
  return { status: "unreachable", failing, tunnel };
}
