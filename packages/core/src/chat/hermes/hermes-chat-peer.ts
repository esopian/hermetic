/**
 * The peer protocol: the two raw transports Bot Mode drives a box with.
 *
 * `botModeRest` is the dashboard's authenticated JSON API and `botModeRpc` is
 * one request on a socket that is closed again immediately. Both are
 * deliberately shapeless — they carry a method and a payload and hand back
 * whatever the box answered, because the Bot Mode surface in `bot-mode.ts`
 * owns the schemas and this module owns only the round trip.
 *
 * The HTTP status mapping is part of the contract: 404 is `NOT_FOUND`, 409 is
 * `CONFLICT`, 403 is `FORBIDDEN`, anything else is `CHAT_PROTOCOL`.
 */
import { checkAbort } from "../../abort.ts";
import { HermeticError } from "../../errors.ts";
import {
  CHAT_ERROR_CODES,
  chatError,
  DIRECT_DIAL_HEADERS,
  type BoxAddress,
  type HermesChatOptions,
} from "./hermes-chat-types.ts";
import type { ChatConnection } from "./hermes-chat-connect.ts";
import type { RequestPool } from "./hermes-chat-pool.ts";
import { describe, stripToken } from "./hermes-chat-wire.ts";

/** What `createChatPeer` needs, and nothing more. */
export interface ChatPeerDeps {
  connection: ChatConnection;
  /**
   * The shared request socket (`hermes-chat-pool.ts`), when the caller wants
   * one. Explicit rather than implicit: a peer handed no pool keeps the
   * original behaviour exactly — one socket per RPC, dialled and closed — and
   * every other transport in the adapter is untouched either way.
   */
  pool?: RequestPool | undefined;
}

export function createChatPeer(deps: ChatPeerDeps) {
  const conn = deps.connection;

  async function botModeRest(
    box: BoxAddress,
    method: string,
    path: string,
    body?: unknown,
    opts: HermesChatOptions = {},
  ): Promise<unknown> {
    if (!path.startsWith("/api/") || path.startsWith("//"))
      throw new HermeticError("VALIDATION", "Invalid dashboard path");
    const cached = conn.cached(box);
    let tok = await conn.token(box, opts.signal);
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await conn.fetch(new URL(path, box.baseUrl), {
          method,
          headers: {
            ...DIRECT_DIAL_HEADERS,
            "X-Hermes-Session-Token": tok,
            "Content-Type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: opts.signal ?? null,
        });
      } catch (error) {
        checkAbort(opts.signal, "Bot Mode");
        throw chatError(
          CHAT_ERROR_CODES.UNREACHABLE,
          `${box.instance}: dashboard request failed (${stripToken(describe(error), tok)})`,
        );
      }
      if (response.status === 401 && cached && attempt === 0) {
        conn.invalidate(box);
        tok = await conn.token(box, opts.signal);
        continue;
      }
      if (!response.ok)
        throw new HermeticError(
          response.status === 404
            ? "NOT_FOUND"
            : response.status === 409
              ? "CONFLICT"
              : response.status === 403
                ? "FORBIDDEN"
                : "CHAT_PROTOCOL",
          `${box.instance}: dashboard ${method} failed (HTTP ${response.status})`,
        );
      return response.json();
    }
  }
  async function botModeRpc(
    box: BoxAddress,
    method: string,
    params: Record<string, unknown>,
    opts: HermesChatOptions & { deadlineMs?: number } = {},
  ) {
    if (deps.pool) return deps.pool.request(box, method, params, opts);
    const rpc = await conn.connect(box, opts.signal);
    try {
      return await rpc.request(method, params, opts.deadlineMs, { signal: opts.signal });
    } finally {
      rpc.close();
    }
  }
  return { botModeRest, botModeRpc };
}
