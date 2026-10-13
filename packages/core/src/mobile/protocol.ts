/**
 * The mobile bridge's wire constants: the one table both ends of the phone
 * protocol read.
 *
 * The phone keeps a mirror of this file (`mobile/src/protocol/constants.ts`),
 * and `tests/mobile-protocol.test.ts` compares the two value by value, so a
 * change here is a change to the protocol. Edit `.context/mobile-protocol.md`
 * (the contract) first, then both copies.
 *
 * Pure values only — no Zod, no `node:*`, no `bun:*` — because the seam test
 * imports it directly and the phone's copy must be able to say the same thing
 * in plain TypeScript. The Zod shapes of the frames live in
 * `schema/mobile.ts`, which reads the name lists here.
 */

export const MOBILE_PROTOCOL = Object.freeze({
  PROTOCOL_VERSION: 1,
  DEFAULT_PORT: 7877,
  /** Crockford base32, uppercase, from `PAIR_CODE_ALPHABET`. */
  PAIR_CODE_LENGTH: 8,
  PAIR_CODE_TTL_MS: 600_000,
  /** Random bytes in a device token, before base64url and the prefix. */
  TOKEN_BYTES: 32,
  TOKEN_PREFIX: "hmt_",
  /** A socket that has not sent `auth` within this is closed 4408. */
  AUTH_DEADLINE_MS: 5_000,
  /** The bridge sends `ping` this often; a socket silent for two of them is closed. */
  HEARTBEAT_MS: 20_000,
  /** How long a finished turn's frame buffer stays resumable. */
  TURN_RETENTION_MS: 1_800_000,
  /** Per turn; overflow drops the oldest frames and sets `truncated`. */
  TURN_MAX_FRAMES: 20_000,
  MAX_PAYLOAD_BYTES: 1_000_000,
  /** The inbox poll that feeds `notification` frames and pushes. */
  NOTIFY_POLL_MS: 10_000,
  /** The `chat.swarms` tick a headless bridge runs so core raises `chat.message` rows. */
  SWARMS_TICK_MS: 120_000,
  /** Failed pair attempts one source may make before it is refused for `PAIR_LOCKOUT_MS`. */
  PAIR_MAX_FAILURES: 5,
  PAIR_LOCKOUT_MS: 60_000,
  /** The longest reply preview a push carries. */
  PREVIEW_MAX_CHARS: 140,
  /** Every HTTP request carries this header with `PROTOCOL_VERSION`. */
  VERSION_HEADER: "X-Hermetic-Mobile",
  /** `hermetic://pair?host=…&port=…&code=…&fleet=…&name=…` */
  PAIR_URL_PREFIX: "hermetic://pair",
} as const);

/** Crockford base32 without the ambiguous I, L, O and U. */
export const PAIR_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * The only core methods `rpc` forwards. `chat.send` and `chat.observe` are
 * absent on purpose: they run only as ws turns and subscriptions.
 */
export const MOBILE_ALLOWED_METHODS = [
  "chat.listening",
  "chat.listen",
  "chat.swarms",
  "chat.sessions",
  "chat.history",
  "chat.open",
  "chat.compact",
  "chat.archive",
  "chat.respond",
  "chat.abort",
  "chat.steer",
  "chat.settings",
  "notifications.list",
  "notifications.ack",
  "notifications.clear",
  "notifications.snooze",
  "notifications.mute",
  "agents.list",
  "agents.get",
  "fleets.list",
  "config.show",
] as const;
export type MobileAllowedMethod = (typeof MOBILE_ALLOWED_METHODS)[number];

export const MOBILE_ROUTES = Object.freeze({
  health: "/mobile/v1/health",
  pair: "/mobile/v1/pair",
  hello: "/mobile/v1/hello",
  rpc: "/mobile/v1/rpc",
  pushRegister: "/mobile/v1/push/register",
  pushSettings: "/mobile/v1/push/settings",
  ws: "/mobile/v1/ws",
} as const);

/** Phone → bridge frame types. */
export const MOBILE_CLIENT_FRAMES = [
  "auth",
  "rpc",
  "turn.start",
  "turn.resume",
  "turn.abort",
  "observe.open",
  "observe.close",
  "pong",
] as const;
export type MobileClientFrameType = (typeof MOBILE_CLIENT_FRAMES)[number];

/** Bridge → phone frame types. */
export const MOBILE_SERVER_FRAMES = [
  "auth.ok",
  "auth.error",
  "res",
  "turn.frame",
  "turn.end",
  "turn.started",
  "observe.event",
  "observe.end",
  "notification",
  "listening",
  "ping",
  "error",
] as const;
export type MobileServerFrameType = (typeof MOBILE_SERVER_FRAMES)[number];

export const MOBILE_CLOSE_CODES = Object.freeze({
  BAD_FRAME: 4400,
  UNAUTHORIZED: 4401,
  AUTH_DEADLINE: 4408,
  PROTOCOL_MISMATCH: 4426,
  GOING_AWAY: 1001,
} as const);

export const MOBILE_TURN_STATES = ["running", "done", "error", "aborted"] as const;
export type MobileTurnState = (typeof MOBILE_TURN_STATES)[number];

export const MOBILE_PLATFORMS = ["ios", "android", "other"] as const;
export type MobilePlatform = (typeof MOBILE_PLATFORMS)[number];

/**
 * The error codes the bridge itself raises, and the HTTP status each maps to.
 * Any other core code a forwarded call throws maps through `MOBILE_HTTP_STATUS`
 * too, falling back to 400 for a refusal and 500 for `INTERNAL`.
 */
export const MOBILE_HTTP_STATUS = Object.freeze({
  VALIDATION: 400,
  NAME_INVALID: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  FLEET_MISMATCH: 403,
  ACCOUNT_MISMATCH: 403,
  NOT_FOUND: 404,
  TURN_GONE: 404,
  PAIR_CODE_INVALID: 409,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  PROTOCOL_MISMATCH: 426,
  RATE_LIMITED: 429,
  INTERNAL: 500,
} as const);

/** Expo notification categories the phone registers, and the approval actions. */
export const MOBILE_PUSH_CATEGORIES = Object.freeze({
  approval: "hermetic.approval",
  question: "hermetic.question",
} as const);
export const MOBILE_APPROVAL_ACTIONS = ["approve_once", "deny"] as const;

/** `data.kind` of every push the bridge sends. */
export const MOBILE_PUSH_KINDS = ["turn.done", "turn.error", "needs_action", "notification"] as const;
export type MobilePushKind = (typeof MOBILE_PUSH_KINDS)[number];
