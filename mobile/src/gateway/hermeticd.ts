/**
 * The phone's calls to hermeticd (§6.4, port 7434, plain HTTP inside the
 * tailnet): `GET /fleet` for the live agent list and the push registration
 * routes. Whois-gated on the box; the phone sends nothing but the protocol
 * header (`x-hermetic-rpc`), exactly as the laptop's `aws/rpc.ts` does.
 *
 * Pure: `fetch` is injected, timeouts are the caller's `setTimeout`, nothing
 * imports React Native, so jest and the root e2e test both drive it.
 */
import { HermeticError, type ErrorCode } from "@hermetic/core/chat-client";
import { MobileFleetView } from "@hermetic/core/schema";
import {
  HERMETICD_RPC_PORT,
  RPC_PATHS,
  RPC_PROTOCOL_VERSION,
  RPC_VERSION_HEADER,
} from "@hermetic/core/shared";
import { reasonOf } from "../client/errors.ts";

/**
 * `fetch`, structurally: the adapter's `ChatFetch` shape (not `typeof fetch`,
 * whose lib type carries extras no double needs), so one `fetch` serves both.
 */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** How long one hermeticd call may take. */
export const HERMETICD_TIMEOUT_MS = 8_000;

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

/**
 * One call to one box's hermeticd, bounded by `timeoutMs` and the caller's
 * signal. A box that never answered is `HERMETICD_UNAVAILABLE`; one that
 * refused is its own code (`FLEET_LIST_UNAVAILABLE`, `VALIDATION`, …).
 */
export async function callHermeticd(
  fetch: FetchLike,
  host: string,
  path: string,
  init: { method?: string; body?: string; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? HERMETICD_TIMEOUT_MS);
  const onAbort = (): void => controller.abort();
  if (init.signal?.aborted) controller.abort();
  else init.signal?.addEventListener("abort", onAbort, { once: true });
  let response: Response;
  try {
    response = await fetch(hermeticdUrl(host, path), {
      method: init.method ?? "GET",
      headers: {
        [RPC_VERSION_HEADER]: String(RPC_PROTOCOL_VERSION),
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: init.body } : {}),
      signal: controller.signal,
    });
  } catch (error) {
    const { message } = reasonOf(error);
    throw new HermeticError(
      "HERMETICD_UNAVAILABLE",
      `hermeticd on ${host} did not answer: ${message}`,
      {
        host,
      },
    );
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", onAbort);
  }
  if (!response.ok) throw await refusalOf(response, host);
  return response;
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
        e.code === "FLEET_LIST_UNAVAILABLE" ? 0 : e.code === "HERMETICD_UNAVAILABLE" ? 2 : 1;
      reject([...failures].sort((a, b) => rank(a) - rank(b))[0]);
    }
  });
}
