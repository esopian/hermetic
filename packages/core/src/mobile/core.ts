/**
 * What the mobile bridge needs from the SDK, and the one table that decides
 * which of it a phone may call.
 *
 * `MobileCore` is a structural slice of `Hermetic`, written out rather than
 * derived because `Hermetic` is the return type of the function that builds
 * the bridge — naming it here would make the type refer to itself. Members are
 * method-shaped so the real, narrower signatures are assignable to them.
 *
 * `rpc` forwarding goes through `MOBILE_RPC` and nothing else: a null-prototype
 * map keyed by `MOBILE_ALLOWED_METHODS`, each entry an explicit call. A method
 * name off the wire is never used to walk a property path, so `constructor`,
 * `__proto__` or `agents.create` find nothing and are refused `FORBIDDEN`.
 */
import type { ZodType } from "zod";
import { HermeticError } from "../errors.ts";
import type { ChatFrame, ChatObserveEvent, NotificationsListResult } from "../schema/index.ts";
import { REQUEST_SCHEMAS } from "../surface.ts";
import { MOBILE_ALLOWED_METHODS, type MobileAllowedMethod } from "./protocol.ts";

interface CallOpts {
  signal?: AbortSignal;
}

export interface MobileCore {
  target: {
    account_id: string;
    region: string;
    fleet_id: string;
    fleet_name: string | null;
  } | null;
  chat: {
    send(input: unknown, opts?: CallOpts): AsyncIterable<ChatFrame>;
    observe(input: unknown, opts?: CallOpts): AsyncIterable<ChatObserveEvent>;
    listening(input?: unknown): Promise<{ instances: string[] }>;
    listen(input: unknown): Promise<{ instances: string[] }>;
    swarms(input: unknown, opts?: CallOpts): Promise<unknown>;
    sessions(input: unknown, opts?: CallOpts): Promise<unknown>;
    history(input: unknown, opts?: CallOpts): Promise<unknown>;
    open(input: unknown, opts?: CallOpts): Promise<{ session: string }>;
    compact(input: unknown, opts?: CallOpts): Promise<unknown>;
    archive(input: unknown, opts?: CallOpts): Promise<unknown>;
    respond(input: unknown, opts?: CallOpts): Promise<unknown>;
    abort(input: unknown, opts?: CallOpts): Promise<unknown>;
    steer(input: unknown, opts?: CallOpts): Promise<unknown>;
    settings(input?: unknown): Promise<unknown>;
  };
  notifications: {
    list(input?: unknown): Promise<NotificationsListResult>;
    ack(input: unknown): Promise<unknown>;
    clear(input: unknown): Promise<unknown>;
    snooze(input: unknown): Promise<unknown>;
    mute(input: unknown): Promise<unknown>;
  };
  agents: {
    list(input?: unknown): Promise<unknown>;
    /** Takes the bare name, not the `{name}` request the surface validates. */
    get(name: string): Promise<unknown>;
  };
  fleets: { list(input?: unknown): Promise<unknown> };
  /** Read once at bridge start for `Hello.tailnet`; not reachable from a phone. */
  config: { show(): Promise<{ tailnet: string | null }> };
}

type RpcCall = (core: MobileCore, params: unknown, signal: AbortSignal) => Promise<unknown>;

const TABLE: Record<MobileAllowedMethod, RpcCall> = {
  "chat.listening": (c, p) => c.chat.listening(p),
  "chat.listen": (c, p) => c.chat.listen(p),
  "chat.swarms": (c, p, signal) => c.chat.swarms(p, { signal }),
  "chat.sessions": (c, p, signal) => c.chat.sessions(p, { signal }),
  "chat.history": (c, p, signal) => c.chat.history(p, { signal }),
  "chat.open": (c, p, signal) => c.chat.open(p, { signal }),
  "chat.compact": (c, p, signal) => c.chat.compact(p, { signal }),
  "chat.archive": (c, p, signal) => c.chat.archive(p, { signal }),
  "chat.respond": (c, p, signal) => c.chat.respond(p, { signal }),
  "chat.abort": (c, p, signal) => c.chat.abort(p, { signal }),
  "chat.steer": (c, p, signal) => c.chat.steer(p, { signal }),
  // Read-only from a phone: the redaction setting is laptop-wide, so whatever
  // the phone sent, core is asked to read.
  "chat.settings": (c) => c.chat.settings({}),
  "notifications.list": (c, p) => c.notifications.list(p),
  "notifications.ack": (c, p) => c.notifications.ack(p),
  "notifications.clear": (c, p) => c.notifications.clear(p),
  "notifications.snooze": (c, p) => c.notifications.snooze(p),
  "notifications.mute": (c, p) => c.notifications.mute(p),
  "agents.list": (c, p) => c.agents.list(p),
  "agents.get": (c, p) => c.agents.get((p as { name: string }).name),
  "fleets.list": (c, p) => c.fleets.list(p),
};

/** The allowlist as a lookup that inherits nothing. */
export const MOBILE_RPC: Readonly<Record<string, RpcCall>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, RpcCall>, TABLE),
);

/** Every allowed method's request schema, on a map that inherits nothing. */
const SCHEMAS: Readonly<Record<string, ZodType>> = Object.freeze(
  Object.assign(
    Object.create(null) as Record<string, ZodType>,
    Object.fromEntries(MOBILE_ALLOWED_METHODS.map((m) => [m, REQUEST_SCHEMAS[m] as ZodType])),
  ),
);

/**
 * Validate and call one allowed method. Anything not on the list is
 * `FORBIDDEN` with one message, whether or not it exists elsewhere.
 */
export async function forwardRpc(
  core: MobileCore,
  method: string,
  params: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const call = MOBILE_RPC[method];
  const schema = SCHEMAS[method];
  if (call === undefined || schema === undefined) {
    throw new HermeticError("FORBIDDEN", "method not reachable from a phone");
  }
  const parsed = schema.safeParse(params ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new HermeticError("VALIDATION", `${method} input does not validate`, { issues });
  }
  return await call(core, parsed.data, signal);
}
