/**
 * Is Tailscale up? iOS has no public API to ask the Tailscale app, so this
 * infers it (§9.4): probe `https://<host>/api/health` (the dashboard's public
 * health route, no token) on up to three listened boxes, 3 s each, and read the
 * failures.
 *
 * - any probe answered (any HTTP status: the tailnet carried it) → `ok`, with
 *   the boxes that did not listed in `failing`;
 * - every probe failed to resolve its name → `off` ("Tailscale is off or not
 *   signed in": MagicDNS names resolve only through Tailscale);
 * - every probe failed otherwise (timed out, refused) → `unreachable` ("on the
 *   tailnet, but no box answers");
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
 * - a bare "Network request failed" that came back before the timeout is
 *   counted as a resolution failure: with Tailscale off, a `*.ts.net` name
 *   fails to resolve at once, while a box that is down on a live tailnet
 *   times out instead.
 *
 * The UI words it as a heuristic and never gates chat on it. Pure: `fetch` and
 * the clock are injected.
 */
import type { FetchLike } from "./hermeticd.ts";

export type TailscaleStatus = "ok" | "off" | "unreachable" | "unknown";

export interface TailscaleProbe {
  status: TailscaleStatus;
  /** The hosts whose probe failed. */
  failing: string[];
}

export type ProbeFailure = "dns" | "timeout" | "refused";

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
  // RN's bare "Network request failed", or anything else that failed fast.
  return "dns";
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
    return null;
  } catch (error) {
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
  if (hosts.length === 0) return { status: "unknown", failing: [] };
  const timeoutMs = input.timeoutMs ?? PROBE_TIMEOUT_MS;
  const results = await Promise.all(hosts.map((host) => probe(input.fetch, host, timeoutMs)));
  const failing = hosts.filter((_, i) => results[i] !== null);
  if (results.some((r) => r === null)) return { status: "ok", failing };
  if (results.every((r) => r === "dns")) return { status: "off", failing };
  return { status: "unreachable", failing };
}
