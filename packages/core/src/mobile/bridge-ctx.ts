/**
 * What every part of a running bridge shares — the HTTP routes (`http.ts`), the
 * socket hub (`ws.ts`) and the server that owns both (`server.ts`) — plus the
 * three helpers all of them need: the wire error, the fleet guard and `Hello`.
 */
import { HermeticError, isHermeticError } from "../errors.ts";
import { redactText } from "../chat/chat-redact.ts";
import type { ObservePool } from "../chat/observe-pool.ts";
import type { MobileErrorBody, MobileHello, Notification } from "../schema/index.ts";
import { sameFleetTarget, type FleetTarget } from "../shared/target.ts";
import type { MobileCore } from "./core.ts";
import type { MobileDeviceRow, MobileStore } from "./device-store.ts";
import type { PairLimiter } from "./pairing.ts";
import { MOBILE_HTTP_STATUS, MOBILE_PROTOCOL } from "./protocol.ts";
import type { PushNotifier } from "./push.ts";
import type { TurnRegistry } from "./turns.ts";

/** What a running bridge says about itself, for a head to show or log. */
export type MobileBridgeEvent =
  | { type: "listening"; host: string; port: number; url: string }
  | { type: "paired"; device_id: string; name: string }
  | {
      type: "device";
      device_id: string;
      action: "connected" | "disconnected" | "revoked";
    }
  | { type: "stopped"; reason: string };

export interface BridgeCtx {
  core: () => MobileCore;
  store: MobileStore;
  turns: TurnRegistry;
  pool: ObservePool;
  push: PushNotifier;
  limiter: PairLimiter;
  clock: () => number;
  app: "desktop" | "cli";
  version: string;
  fixture: boolean;
  /** The fleet's tailnet, read once when the bridge starts; `null` until then or if unreadable. */
  tailnet: () => string | null;
  emit: (event: MobileBridgeEvent) => void;
  /** Late-bound to the hub: tell every authenticated socket. */
  broadcast: (frame: Record<string, unknown>) => void;
  /** Late-bound to the hub: does this device have a socket open in the foreground? */
  isLive: (deviceId: string) => boolean;
  heartbeatMs: number;
  authDeadlineMs: number;
}

export function statusFor(code: string): number {
  const mapped = (MOBILE_HTTP_STATUS as Readonly<Record<string, number>>)[code];
  if (mapped !== undefined) return mapped;
  if (code.startsWith("CHAT_")) return 502;
  return 400;
}

/** A throw as the phone sees it. Unclassified failures never say why. */
export function wireError(e: unknown): { status: number; body: MobileErrorBody } {
  if (isHermeticError(e) && e.code !== "INTERNAL") {
    return {
      status: statusFor(e.code),
      body: {
        code: e.code,
        message: redactText(e.message),
        ...(e.details !== undefined ? { details: e.details } : {}),
      },
    };
  }
  return { status: 500, body: { code: "INTERNAL", message: "internal error" } };
}

/** `FLEET_MISMATCH` unless the request names the fleet this bridge serves. */
export function guardFleet(core: MobileCore, target: FleetTarget): void {
  const own = core.target;
  if (own === null || !sameFleetTarget(target, own)) {
    throw new HermeticError("FLEET_MISMATCH", "this bridge serves a different fleet", {
      expected:
        own === null
          ? null
          : { account_id: own.account_id, region: own.region, fleet_id: own.fleet_id },
    });
  }
}

export async function buildHello(ctx: BridgeCtx, device: MobileDeviceRow): Promise<MobileHello> {
  const core = ctx.core();
  const target = core.target;
  if (target === null) {
    throw new HermeticError("NOT_INITIALIZED", "this laptop has no fleet to serve");
  }
  let listening: string[] = [];
  try {
    listening = (await core.chat.listening({})).instances;
  } catch {
    /* an unreadable opt-in set reads as none */
  }
  return {
    protocol: MOBILE_PROTOCOL.PROTOCOL_VERSION,
    fleet: {
      fleet_id: target.fleet_id,
      account_id: target.account_id,
      region: target.region,
      alias: target.fleet_name ?? null,
    },
    tailnet: ctx.tailnet(),
    device: {
      device_id: device.device_id,
      name: device.name,
      platform: device.platform,
      created_at: device.created_at,
      previews: device.previews,
      push_registered: device.expo_push_token !== null,
    },
    host: { app: ctx.app, version: ctx.version, fixture: ctx.fixture },
    listening,
    active_turns: ctx.turns.list(),
  };
}

/** The `notification` frame for one inbox row. */
export function notificationFrame(
  row: Notification,
  counts: { unread: number; needs_action: number },
): Record<string, unknown> {
  return { type: "notification", row, counts };
}
