/**
 * The mobile bridge's shapes (`mobile/`): the four `mobile.*` methods' inputs
 * and results, what a phone sends over HTTP to pair and register for pushes,
 * and the two WebSocket frame unions.
 *
 * The wire constants and the frame-type name lists are `mobile/protocol.ts`,
 * pure values the phone mirrors; this module only gives them a Zod shape.
 * Nothing here ever carries a raw device token except `MobilePairResponse`,
 * the one answer that hands a fresh token to the phone that paired.
 */
import { z } from "zod";
import { MOBILE_PLATFORMS, MOBILE_PROTOCOL, MOBILE_TURN_STATES } from "../mobile/protocol.ts";
import { AgentName, BotName } from "./requests.ts";
import { ChatFrame, ChatObserveEvent } from "./chat.ts";
import { AccountId, FleetIdSchema, Iso, Region } from "./common.ts";
import { Notification } from "./notification.ts";
import { FleetTarget } from "./target.ts";

// The pair URL's QR, so this door opens onto it like `shared` does.
export { encodeQr, qrToSvg, qrToTerminal, type QrMatrix } from "../shared/qr.ts";

export const MobilePlatformSchema = z.enum(MOBILE_PLATFORMS);

/** A paired phone as every head sees it: no token, no hash. */
export const MobileDevice = z.object({
  device_id: z.string().min(1),
  name: z.string(),
  platform: MobilePlatformSchema,
  created_at: Iso,
  last_seen_at: Iso.nullable(),
  push_registered: z.boolean(),
  previews: z.boolean(),
  enabled: z.boolean(),
});
export type MobileDevice = z.infer<typeof MobileDevice>;

const Port = z.number().int().min(0).max(65_535);
/** A host to bind or to advertise: a name or an IP literal, never a URL. */
const Host = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9.:_-]+$/, "a hostname or an IP address");

/** What a running bridge reports about itself. */
export const MobileServeStatus = z.object({
  host: z.string(),
  port: Port,
  url: z.string(),
  started_at: Iso,
  /** Authenticated sockets open right now. */
  connected: z.number().int().nonnegative(),
  app: z.enum(["desktop", "cli"]),
});
export type MobileServeStatus = z.infer<typeof MobileServeStatus>;

export const MobilePairInput = z
  .object({
    /** A label for the phone, shown until it names itself. */
    name: z.string().min(1).max(64).optional(),
    /** Where the phone should reach the bridge; default: settings, then the tailnet IPv4. */
    host: Host.optional(),
    port: Port.min(1).optional(),
    ttl_ms: z.number().int().min(10_000).max(3_600_000).optional(),
  })
  .strict();
export type MobilePairInput = z.infer<typeof MobilePairInput>;

export const MobilePairResult = z.object({
  code: z.string(),
  expires_at: Iso,
  url: z.string(),
  host: z.string(),
  port: Port,
});
export type MobilePairResult = z.infer<typeof MobilePairResult>;

export const MobileDevicesInput = z.object({}).strict();
export type MobileDevicesInput = z.infer<typeof MobileDevicesInput>;
export const MobileDevicesResult = z.object({
  devices: z.array(MobileDevice),
  serving: MobileServeStatus.nullable(),
});
export type MobileDevicesResult = z.infer<typeof MobileDevicesResult>;

export const MobileRevokeInput = z.object({ device_id: z.string().min(1).max(64) }).strict();
export type MobileRevokeInput = z.infer<typeof MobileRevokeInput>;
export const MobileRevokeResult = z.object({ revoked: z.boolean() });
export type MobileRevokeResult = z.infer<typeof MobileRevokeResult>;

/**
 * `mobile.settings`: an empty request reads; a stated field writes. `null`
 * clears an override back to the default (tailnet IPv4, `DEFAULT_PORT`).
 */
export const MobileSettingsInput = z
  .object({
    enabled: z.boolean().optional(),
    host: Host.nullable().optional(),
    port: Port.min(1).nullable().optional(),
  })
  .strict();
export type MobileSettingsInput = z.infer<typeof MobileSettingsInput>;
export const MobileSettings = z.object({
  enabled: z.boolean(),
  host: z.string().nullable(),
  port: z.number().int().nullable(),
});
export type MobileSettings = z.infer<typeof MobileSettings>;

export const MobileServeInput = z
  .object({
    host: Host.optional(),
    /** 0 picks a free port, which is what a test wants. */
    port: Port.optional(),
    /** Tick `chat.swarms` so core raises `chat.message` rows (a headless bridge). */
    tick_swarms: z.boolean().optional(),
  })
  .strict();
export type MobileServeInput = z.infer<typeof MobileServeInput>;

/* ── Hello ──────────────────────────────────────────────────────────────── */

export const MobileTurnStateSchema = z.enum(MOBILE_TURN_STATES);

export const TurnSummary = z.object({
  turn_id: z.string(),
  instance: z.string(),
  bot: z.string(),
  session: z.string().nullable(),
  started_at: Iso,
  state: MobileTurnStateSchema,
  last_n: z.number().int().nonnegative(),
  truncated: z.boolean(),
  device_id: z.string(),
});
export type TurnSummary = z.infer<typeof TurnSummary>;

export const MobileHello = z.object({
  protocol: z.literal(MOBILE_PROTOCOL.PROTOCOL_VERSION),
  fleet: z.object({
    fleet_id: FleetIdSchema,
    account_id: AccountId,
    region: Region,
    alias: z.string().nullable(),
  }),
  tailnet: z.string().nullable(),
  device: z.object({
    device_id: z.string(),
    name: z.string(),
    platform: MobilePlatformSchema,
    created_at: Iso,
    previews: z.boolean(),
    push_registered: z.boolean(),
  }),
  host: z.object({
    app: z.enum(["desktop", "cli"]),
    version: z.string(),
    fixture: z.boolean(),
  }),
  listening: z.array(z.string()),
  active_turns: z.array(TurnSummary),
});
export type MobileHello = z.infer<typeof MobileHello>;

/* ── HTTP bodies ────────────────────────────────────────────────────────── */

export const MobilePairRequest = z
  .object({
    code: z.string().min(1).max(32),
    device_name: z.string().min(1).max(64),
    platform: MobilePlatformSchema,
  })
  .strict();
export type MobilePairRequest = z.infer<typeof MobilePairRequest>;

export const MobilePairResponse = z.object({
  token: z.string(),
  device_id: z.string(),
  hello: MobileHello,
});
export type MobilePairResponse = z.infer<typeof MobilePairResponse>;

export const MobileRpcRequest = z.object({
  method: z.string().min(1).max(64),
  params: z.unknown().optional(),
  target: FleetTarget,
});
export type MobileRpcRequest = z.infer<typeof MobileRpcRequest>;

export const MobilePushRegisterRequest = z
  .object({
    expo_push_token: z.string().min(1).max(256),
    previews: z.boolean().optional(),
  })
  .strict();
export type MobilePushRegisterRequest = z.infer<typeof MobilePushRegisterRequest>;

export const MobilePushSettingsRequest = z
  .object({ previews: z.boolean().optional(), enabled: z.boolean().optional() })
  .strict();
export type MobilePushSettingsRequest = z.infer<typeof MobilePushSettingsRequest>;

/** `{code, message, details?}` — the desktop `RpcErrorBody` shape. */
export const MobileErrorBody = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type MobileErrorBody = z.infer<typeof MobileErrorBody>;

/* ── WebSocket: phone → bridge ──────────────────────────────────────────── */

const FrameId = z.string().min(1).max(128);

export const MobileTurnStartBody = z.object({
  instance: AgentName,
  bot: BotName,
  session: z.string().min(1).optional(),
  new_session: z.boolean().optional(),
  message: z.string().min(1).max(200_000),
  client_ref: z.string().max(128).optional(),
});
export type MobileTurnStartBody = z.infer<typeof MobileTurnStartBody>;

export const MobileClientFrame = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("auth"),
    token: z.string().min(1).max(256),
    protocol: z.number().int(),
    resume: z
      .object({
        turns: z
          .array(z.object({ turn_id: z.string().min(1), after: z.number().int().min(0) }))
          .max(64),
      })
      .optional(),
  }),
  z.object({
    type: z.literal("rpc"),
    id: FrameId,
    method: z.string().min(1).max(64),
    params: z.unknown().optional(),
    target: FleetTarget,
  }),
  z.object({
    type: z.literal("turn.start"),
    id: FrameId,
    target: FleetTarget,
    turn: MobileTurnStartBody,
  }),
  z.object({
    type: z.literal("turn.resume"),
    id: FrameId,
    turn_id: z.string().min(1),
    after: z.number().int().min(0),
  }),
  z.object({ type: z.literal("turn.abort"), id: FrameId, turn_id: z.string().min(1) }),
  z.object({
    type: z.literal("observe.open"),
    id: FrameId,
    target: FleetTarget,
    instance: AgentName,
    bot: BotName,
    session: z.string().min(1).nullable().optional(),
  }),
  z.object({ type: z.literal("observe.close"), id: FrameId, sub_id: z.string().min(1) }),
  z.object({ type: z.literal("pong") }),
]);
export type MobileClientFrame = z.infer<typeof MobileClientFrame>;

/* ── WebSocket: bridge → phone ──────────────────────────────────────────── */

export const MobileServerFrame = z.union([
  z.object({ type: z.literal("auth.ok"), hello: MobileHello }),
  z.object({ type: z.literal("auth.error"), error: MobileErrorBody }),
  z.object({ type: z.literal("res"), id: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.object({ type: z.literal("res"), id: z.string(), ok: z.literal(false), error: MobileErrorBody }),
  z.object({
    type: z.literal("turn.frame"),
    turn_id: z.string(),
    n: z.number().int().positive(),
    frame: ChatFrame,
  }),
  z.object({
    type: z.literal("turn.end"),
    turn_id: z.string(),
    n: z.number().int().nonnegative(),
    state: z.enum(["done", "error", "aborted"]),
  }),
  z.object({ type: z.literal("turn.started"), turn: TurnSummary }),
  z.object({ type: z.literal("observe.event"), sub_id: z.string(), event: ChatObserveEvent }),
  z.object({
    type: z.literal("observe.end"),
    sub_id: z.string(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  }),
  z.object({
    type: z.literal("notification"),
    row: Notification,
    counts: z.object({ unread: z.number().int(), needs_action: z.number().int() }),
  }),
  z.object({ type: z.literal("listening"), instances: z.array(z.string()) }),
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("error"), error: MobileErrorBody }),
]);
export type MobileServerFrame = z.infer<typeof MobileServerFrame>;
