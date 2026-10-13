/**
 * The bridge's HTTP half: pairing, `hello`, `rpc`, push registration.
 *
 * Pure TypeScript with every effect injected (`fetch`, the token and fleet
 * target readers), so the root e2e test can drive it from bun against a real
 * bridge on loopback. No React, no React Native.
 */
import { MOBILE_PROTOCOL, MOBILE_ROUTES } from "../protocol/constants.ts";
import type {
  FleetTarget,
  HealthResult,
  Hello,
  PairRequest,
  PairResult,
  PushSettingsResult,
} from "../protocol/types.ts";
import { BridgeError, CLIENT_ERROR_CODES, errorBody } from "./errors.ts";

/** The slice of `fetch` the client uses; the global one satisfies it. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface BridgeHttpOptions {
  /** `http://100.64.0.1:7877` — no trailing slash needed. */
  baseUrl: string;
  fetch?: FetchLike;
  /** The device token, or `null` before pairing. Read per request so a re-pair takes effect at once. */
  token?: () => string | null;
  /** The fleet every `rpc` names (`Hello.fleet`). */
  target?: () => FleetTarget | null;
  timeoutMs?: number;
}

export interface BridgeHttp {
  readonly baseUrl: string;
  health(): Promise<HealthResult>;
  pair(request: PairRequest): Promise<PairResult>;
  hello(): Promise<Hello>;
  rpc<T = unknown>(method: string, params?: unknown): Promise<T>;
  pushRegister(input: { expo_push_token: string; previews?: boolean }): Promise<{ ok: true }>;
  pushSettings(input: { previews?: boolean; enabled?: boolean }): Promise<PushSettingsResult>;
}

export const DEFAULT_HTTP_TIMEOUT_MS = 15_000;

export function normaliseBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** `ws://host:port/mobile/v1/ws` for an `http://host:port` base (and `wss` for `https`). */
export function wsUrlFor(baseUrl: string): string {
  const base = normaliseBaseUrl(baseUrl);
  const swapped = base.replace(/^http(s?):\/\//i, (_m, s: string) => `ws${s}://`);
  return `${swapped}${MOBILE_ROUTES.ws}`;
}

export function createBridgeHttp(options: BridgeHttpOptions): BridgeHttp {
  const baseUrl = normaliseBaseUrl(options.baseUrl);
  const doFetch: FetchLike = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;

  async function call<T>(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    auth: boolean,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      [MOBILE_PROTOCOL.VERSION_HEADER]: String(MOBILE_PROTOCOL.PROTOCOL_VERSION),
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (auth) {
      const token = options.token?.() ?? null;
      if (!token) throw new BridgeError(CLIENT_ERROR_CODES.NOT_PAIRED, "This phone is not paired.");
      headers.Authorization = `Bearer ${token}`;
    }
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller?.abort();
    }, timeoutMs);
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(controller ? { signal: controller.signal } : {}),
      });
    } catch (error) {
      if (timedOut)
        throw new BridgeError(
          CLIENT_ERROR_CODES.TIMEOUT,
          `The bridge did not answer within ${timeoutMs} ms.`,
        );
      throw new BridgeError(
        CLIENT_ERROR_CODES.NETWORK,
        error instanceof Error ? error.message : "The bridge could not be reached.",
      );
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new BridgeError(
          CLIENT_ERROR_CODES.BAD_RESPONSE,
          `The bridge answered ${response.status} with a body that is not JSON.`,
          response.status,
        );
      }
    }
    if (!response.ok) {
      const err = errorBody(parsed) ?? errorBody((parsed as { error?: unknown } | null)?.error);
      throw new BridgeError(
        err?.code ?? "INTERNAL",
        err?.message ?? `The bridge answered ${response.status}.`,
        response.status,
        err?.details,
      );
    }
    return parsed as T;
  }

  return {
    baseUrl,
    health: () => call<HealthResult>("GET", MOBILE_ROUTES.health, undefined, false),
    pair: (request) => call<PairResult>("POST", MOBILE_ROUTES.pair, request, false),
    hello: () => call<Hello>("GET", MOBILE_ROUTES.hello, undefined, true),
    async rpc<T>(method: string, params: unknown = {}): Promise<T> {
      const target = options.target?.() ?? null;
      if (!target) throw new BridgeError(CLIENT_ERROR_CODES.NO_TARGET, "No fleet target: pair first.");
      const answer = await call<{ ok: boolean; result?: unknown; error?: unknown }>(
        "POST",
        MOBILE_ROUTES.rpc,
        { method, params, target },
        true,
      );
      if (answer && answer.ok === true) return answer.result as T;
      const err = errorBody(answer?.error);
      throw new BridgeError(
        err?.code ?? "INTERNAL",
        err?.message ?? "The bridge refused the call.",
        200,
        err?.details,
      );
    },
    pushRegister: (input) => call<{ ok: true }>("POST", MOBILE_ROUTES.pushRegister, input, true),
    pushSettings: (input) => call<PushSettingsResult>("POST", MOBILE_ROUTES.pushSettings, input, true),
  };
}

/** What a `hermetic://pair?…` link carries. */
export interface PairLink {
  host: string;
  port: number;
  code: string;
  fleet: string | null;
  name: string | null;
}

/**
 * Parse a pairing link (the QR's payload, or one pasted by hand). Returns
 * `null` for anything that is not a complete `hermetic://pair` link. The code
 * is upper-cased and stripped of separators, so `abcd-1234` pastes cleanly.
 */
export function parsePairLink(input: string): PairLink | null {
  const text = input.trim();
  const match = /^hermetic:\/\/pair\/?\?(.*)$/i.exec(text);
  if (!match) return null;
  const params = new Map<string, string>();
  for (const part of (match[1] ?? "").split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const k = decodeURIComponent((eq < 0 ? part : part.slice(0, eq)).replace(/\+/g, " "));
    const v = eq < 0 ? "" : decodeURIComponent(part.slice(eq + 1).replace(/\+/g, " "));
    params.set(k, v);
  }
  const host = params.get("host")?.trim() ?? "";
  const port = Number(params.get("port") ?? MOBILE_PROTOCOL.DEFAULT_PORT);
  const code = normalisePairCode(params.get("code") ?? "");
  if (!host || !Number.isInteger(port) || port <= 0 || port > 65535 || !code) return null;
  return { host, port, code, fleet: params.get("fleet") || null, name: params.get("name") || null };
}

/** Upper-case, drop spaces and dashes. Validity is the bridge's to judge. */
export function normalisePairCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]+/g, "");
}

/** `http://<host>:<port>`, bracketing an IPv6 literal. */
export function baseUrlFor(host: string, port: number): string {
  const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${h}:${port}`;
}
