/**
 * The phone's calls to hermeticd (§6.4, port 7434, plain HTTP inside the
 * tailnet): `GET /fleet` for the live agent list, `GET /healthz`, and the push
 * registration routes. Whois-gated on the box; the phone sends nothing but the
 * protocol header (`x-hermetic-rpc`), exactly as the laptop's `aws/rpc.ts` does.
 *
 * **The tunnel gate.** Port 7434 is cleartext, which is safe only while the
 * packets ride the WireGuard tunnel. A MagicDNS name resolves to the box only
 * through Tailscale; with Tailscale off, or on a network whose resolver answers
 * `*.ts.net` itself, the same name could reach some other host across the
 * local network in the clear. So no request goes to `http://<host>:7434`
 * until an HTTPS request to `https://<host>/api/health` has succeeded within
 * the last `TUNNEL_TTL_MS` in this process. A valid TLS certificate for the
 * `*.ts.net` name proves DNS resolved to the real box (only that box holds
 * that certificate), so the plaintext hop that follows stays inside the
 * tunnel. The record is kept per host in memory (`tunnelOk`), fed by the
 * Tailscale probe (`tailscale.ts`) and, when it is missing or stale, by a
 * probe made here first. No HTTPS success: `TUNNEL_UNVERIFIED`, and nothing
 * is sent.
 *
 * Pure: `fetch` is injected, timeouts are the caller's `setTimeout`, nothing
 * imports React Native, so jest and the root e2e test both drive it.
 */
import { HermeticError, type ErrorCode } from "@hermetic/core/chat-client";
import { MobileFleetView, RpcHealth } from "@hermetic/core/schema";
import {
  HERMETICD_RPC_PORT,
  RPC_PATHS,
  RPC_PROTOCOL_VERSION,
  RPC_VERSION_HEADER,
} from "@hermetic/core/shared";
import { reasonOf, TUNNEL_UNVERIFIED } from "../client/errors.ts";

/**
 * `fetch`, structurally: the adapter's `ChatFetch` shape (not `typeof fetch`,
 * whose lib type carries extras no double needs), so one `fetch` serves both.
 */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** How long one hermeticd call may take. */
export const HERMETICD_TIMEOUT_MS = 8_000;

/* ── the tunnel gate ────────────────────────────────────────────────────── */

/** How long one HTTPS success vouches for a host's plain-HTTP calls. */
export const TUNNEL_TTL_MS = 60_000;
/** How long the gate's own HTTPS probe may take. */
export const TUNNEL_PROBE_TIMEOUT_MS = 3_000;
/** The dashboard's public health route, served over HTTPS by Tailscale Serve. */
export const TUNNEL_PROBE_PATH = "/api/health";

/** Host → when (epoch ms) an HTTPS request to it last succeeded, in this process. */
const tunnelOk = new Map<string, number>();

const tunnelKey = (host: string): string => host.trim().toLowerCase().replace(/\.$/, "");

/** Record an HTTPS probe of `host`: a success vouches for it, a failure withdraws that. */
export function noteTunnel(host: string, ok: boolean, at: number = Date.now()): void {
  if (ok) tunnelOk.set(tunnelKey(host), at);
  else tunnelOk.delete(tunnelKey(host));
}

/** Whether an HTTPS request to `host` succeeded within `TUNNEL_TTL_MS` of `now`. */
export function tunnelVerified(host: string, now: number = Date.now()): boolean {
  const at = tunnelOk.get(tunnelKey(host));
  return at !== undefined && now - at >= 0 && now - at < TUNNEL_TTL_MS;
}

/** Forget every host's record (sign out, and tests). */
export function resetTunnelChecks(): void {
  tunnelOk.clear();
}

/**
 * Pass only when HTTPS to `host` is known to work: from the record when it is
 * fresh, else by a probe of `https://<host>/api/health` made now. Any HTTP
 * answer counts — the TLS handshake for the name is the proof, not the status.
 */
async function ensureTunnel(fetch: FetchLike, host: string, signal?: AbortSignal): Promise<void> {
  if (tunnelVerified(host)) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TUNNEL_PROBE_TIMEOUT_MS);
  const onAbort = (): void => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const literal = host.includes(":") ? `[${host}]` : host;
  try {
    await fetch(`https://${literal}${TUNNEL_PROBE_PATH}`, {
      method: "GET",
      signal: controller.signal,
    });
    noteTunnel(host, true);
  } catch (error) {
    noteTunnel(host, false);
    const { message } = reasonOf(error);
    throw new HermeticError(
      TUNNEL_UNVERIFIED as ErrorCode,
      `${host} did not answer over HTTPS, so nothing was sent to its plain-HTTP port: ${message}`,
      { host },
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** `http://<host>:7434<path>`: hermeticd listens on the tailnet interface only. */
export function hermeticdUrl(host: string, path: string): string {
  const literal = host.includes(":") ? `[${host}]` : host;
  return `http://${literal}:${HERMETICD_RPC_PORT}${path}`;
}

/** The refusal hermeticd wrote (an NDJSON `{type:"error",code,message}` frame), as a `HermeticError`. */
async function refusalOf(response: Response, host: string): Promise<HermeticError> {
  let code: string | null = null;
  let message = `hermeticd on ${host} answered HTTP ${response.status}`;
  try {
    const text = await response.text();
    const line = text.split("\n").find((l) => l.trim().length > 0);
    const body = line ? (JSON.parse(line) as Record<string, unknown>) : null;
    const inner = (body?.error as Record<string, unknown> | undefined) ?? body;
    if (typeof inner?.code === "string") code = inner.code;
    if (typeof inner?.message === "string") message = `${host}: ${inner.message}`;
  } catch {
    // A body that is not a refusal frame keeps the status line.
  }
  return new HermeticError((code ?? "HERMETICD_UNAVAILABLE") as ErrorCode, message, {
    host,
    status: response.status,
  });
}

/** One hermeticd request: its method, body, headers, the caller's signal and the header timeout. */
export interface HermeticdInit {
  method?: string;
  /** A string is sent as JSON; bytes as the caller's `headers` describe them. */
  body?: string | Uint8Array;
  /** Extra request headers (a files upload's length, digest and session). */
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * One call to one box's hermeticd, bounded by `timeoutMs` and the caller's
 * signal, behind the tunnel gate. A box whose HTTPS name did not answer is
 * `TUNNEL_UNVERIFIED` (nothing was sent); a box that never answered on 7434 is
 * `HERMETICD_UNAVAILABLE`; one that refused is its own code
 * (`FLEET_LIST_UNAVAILABLE`, `VALIDATION`, `FORBIDDEN`, …).
 *
 * The timeout and the caller's signal stop waiting for the headers only; a
 * caller that reads a large body uses `callHermeticdBody`.
 */
export async function callHermeticd(
  fetch: FetchLike,
  host: string,
  path: string,
  init: HermeticdInit = {},
): Promise<Response> {
  return await callWith(fetch, host, path, init, null);
}

/**
 * `callHermeticd`, with the body read inside the call: the caller's signal
 * stays linked to the request, and `bodyTimeoutMs` bounds the read, until
 * `read` settles (desktop `readVerified`). Stopping either aborts the
 * transfer itself, so an abandoned download does not run on.
 */
export async function callHermeticdBody<T>(
  fetch: FetchLike,
  host: string,
  path: string,
  init: HermeticdInit & { bodyTimeoutMs: number },
  read: (response: Response, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  return await callWith(fetch, host, path, init, { read, timeoutMs: init.bodyTimeoutMs });
}

async function callWith<T>(
  fetch: FetchLike,
  host: string,
  path: string,
  init: HermeticdInit,
  body: { read: (response: Response, signal: AbortSignal) => Promise<T>; timeoutMs: number } | null,
): Promise<T> {
  await ensureTunnel(fetch, host, init.signal);
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), init.timeoutMs ?? HERMETICD_TIMEOUT_MS);
  const onAbort = (): void => controller.abort();
  if (init.signal?.aborted) controller.abort();
  else init.signal?.addEventListener("abort", onAbort, { once: true });
  const release = (): void => {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", onAbort);
  };
  let response: Response;
  try {
    response = await fetch(hermeticdUrl(host, path), {
      method: init.method ?? "GET",
      headers: {
        ...(typeof init.body === "string" ? { "content-type": "application/json" } : {}),
        ...init.headers,
        [RPC_VERSION_HEADER]: String(RPC_PROTOCOL_VERSION),
      },
      // The cast narrows the buffer type only: a body here is never a shared buffer.
      ...(init.body !== undefined ? { body: init.body as string | Uint8Array<ArrayBuffer> } : {}),
      signal: controller.signal,
    });
  } catch (error) {
    release();
    // The route that worked a moment ago may be gone: the next call re-proves it.
    noteTunnel(host, false);
    const { message } = reasonOf(error);
    throw new HermeticError(
      "HERMETICD_UNAVAILABLE",
      `hermeticd on ${host} did not answer: ${message}`,
      {
        host,
      },
    );
  }
  if (!body) {
    release();
    if (!response.ok) throw await refusalOf(response, host);
    return response as T;
  }
  // The headers are in: the body gets its own deadline, the signal stays linked.
  clearTimeout(timer);
  timer = setTimeout(() => controller.abort(), body.timeoutMs);
  try {
    if (!response.ok) throw await refusalOf(response, host);
    return await body.read(response, controller.signal);
  } finally {
    release();
  }
}

/** `GET /fleet` on one box, parsed with `MobileFleetView`. */
export async function readFleetView(
  fetch: FetchLike,
  host: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<MobileFleetView> {
  const response = await callHermeticd(fetch, host, RPC_PATHS.fleet, opts);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new HermeticError(
      "CHAT_PROTOCOL",
      `hermeticd on ${host} answered /fleet with something not JSON`,
    );
  }
  const parsed = MobileFleetView.safeParse(body);
  if (!parsed.success) {
    const where = parsed.error.issues[0]?.path.join(".") ?? "?";
    throw new HermeticError(
      "CHAT_PROTOCOL",
      `hermeticd on ${host} answered /fleet in an unknown shape (${where})`,
    );
  }
  return parsed.data;
}

/**
 * `GET /fleet` on every host at once; the first answer for `fleetId` wins and
 * the rest are cancelled. When none answers, the most telling refusal is
 * thrown: a box's own `FLEET_LIST_UNAVAILABLE` (the foundation does not grant
 * the scan yet) over a box that did not answer at all.
 */
export function firstFleetView(
  fetch: FetchLike,
  hosts: readonly string[],
  fleetId: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ view: MobileFleetView; host: string }> {
  if (hosts.length === 0)
    return Promise.reject(
      new HermeticError("HERMETICD_UNAVAILABLE", "no box to ask for the fleet list"),
    );
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    const failures: HermeticError[] = [];
    let settled = false;
    for (const host of hosts) {
      readFleetView(fetch, host, { signal: controller.signal, ...opts }).then(
        (view) => {
          if (settled) return;
          if (view.fleet.fleet_id !== fleetId) {
            failures.push(
              new HermeticError(
                "FLEET_MISMATCH",
                `hermeticd on ${host} answered for fleet ${view.fleet.fleet_id}, not ${fleetId}`,
              ),
            );
          } else {
            settled = true;
            controller.abort();
            resolve({ view, host });
            return;
          }
          if (failures.length === hosts.length) finish();
        },
        (error: unknown) => {
          if (settled) return;
          failures.push(
            error instanceof HermeticError
              ? error
              : new HermeticError("HERMETICD_UNAVAILABLE", String(error)),
          );
          if (failures.length === hosts.length) finish();
        },
      );
    }
    function finish(): void {
      settled = true;
      const rank = (e: HermeticError): number =>
        e.code === "FLEET_LIST_UNAVAILABLE"
          ? 0
          : e.code === "HERMETICD_UNAVAILABLE" || (e.code as string) === TUNNEL_UNVERIFIED
            ? 2
            : 1;
      reject([...failures].sort((a, b) => rank(a) - rank(b))[0]);
    }
  });
}

/* ── GET /healthz ───────────────────────────────────────────────────────── */

/** What one box's `GET /healthz` said, or that it said nothing usable. */
export interface HealthzAnswer {
  /** The agent name the box reports, or `null` when it did not answer. */
  name: string | null;
  hermeticd_version: string | null;
  /** The box answered with a health document this build can read. */
  ok: boolean;
  /** Why not, when `ok` is false. */
  error: { code: string; message: string } | null;
}

/**
 * `GET http://<host>:7434/healthz` (through the tunnel gate): who the box is
 * and which hermeticd it runs. For the agent detail and the fallback when a
 * fleet predates `GET /fleet`. Never throws: a box that did not answer, or
 * answered with something else, is `ok: false` with the reason.
 */
export async function fetchHealthz(
  host: string,
  fetch: FetchLike,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<HealthzAnswer> {
  const failed = (code: string, message: string): HealthzAnswer => ({
    name: null,
    hermeticd_version: null,
    ok: false,
    error: { code, message },
  });
  let body: unknown;
  try {
    const response = await callHermeticd(fetch, host, RPC_PATHS.health, opts);
    body = await response.json();
  } catch (error) {
    const { code, message } = reasonOf(error);
    return failed(error instanceof SyntaxError ? "CHAT_PROTOCOL" : code, message);
  }
  const parsed = RpcHealth.safeParse(body);
  if (!parsed.success)
    return failed("CHAT_PROTOCOL", `hermeticd on ${host} answered /healthz in an unknown shape`);
  return {
    name: parsed.data.name,
    hermeticd_version: parsed.data.hermeticd_version,
    ok: true,
    error: null,
  };
}
