/**
 * The phone companion's shapes (round 3: the phone talks to the boxes, not to
 * a laptop bridge).
 *
 * - `mobile.pair` — the one public `mobile.*` method: the laptop reads the
 *   fleet and its agents and returns a pairing link (`shared/mobile-link.ts`)
 *   that carries **no secret**. The phone's authentication to the fleet is
 *   tailnet membership, like the laptop's.
 * - `MobileFleetView` — what hermeticd's read-only `GET /fleet` answers, so a
 *   paired phone can refresh the agent list without AWS credentials.
 * - `MobilePushDevice` — what the phone registers with hermeticd's
 *   `POST /push/devices`, and `MobilePushData`, the `data` payload of the Expo
 *   push the box's watcher sends.
 *
 * Imports only `shared/*`, zod and sibling schema modules.
 */
import { z } from "zod";
import { AGENT_NAME_RE } from "../shared/naming.ts";
import { AccountId, FleetIdSchema, Iso, Region } from "./common.ts";
import { AgentStatus, Health } from "./agent.ts";
import { FleetName } from "./directory.ts";
import { AgentName, BotName } from "./requests.ts";

// The pairing link's QR and its codec, so this door opens onto them like `shared` does.
export { encodeQr, qrToSvg, qrToTerminal, type QrMatrix } from "../shared/qr.ts";
export {
  MOBILE_LINK_MAX_AGENTS,
  MOBILE_LINK_MAX_LENGTH,
  MOBILE_LINK_PREFIX,
  MOBILE_LINK_VERSION,
  encodeMobileLink,
  parseMobileLink,
  type MobileLinkAgentEntry,
  type MobileLinkPayload,
} from "../shared/mobile-link.ts";

/** A MagicDNS name: dotted labels, no scheme, no port, no trailing dot. */
const DnsName = z
  .string()
  .max(253)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i,
    "a DNS name",
  );

/* ── Pairing ────────────────────────────────────────────────────────────── */

/**
 * One agent as the pairing link carries it. `host` is present only when the
 * box's `tailscale_dns_name` differs from `cloudName(fleet_id, name).<tailnet>`,
 * the name the phone derives on its own (a recreate that came up as `-2`, a
 * box built under an older naming rule).
 */
export const MobileLinkAgent = z
  .object({
    name: z.string().regex(AGENT_NAME_RE),
    host: DnsName.optional(),
  })
  .strict();
export type MobileLinkAgent = z.infer<typeof MobileLinkAgent>;

/** `hermetic mobile pair` takes nothing but the global options (`--fleet` among them). */
export const MobilePairInput = z.object({}).strict();
export type MobilePairInput = z.infer<typeof MobilePairInput>;

export const MobilePairResult = z.object({
  /** `hermetic://fleet?v=2&…` — what the QR draws. Not a secret. */
  link: z.string(),
  fleet: z.object({
    fleet_id: FleetIdSchema,
    alias: FleetName.nullable(),
    account_id: AccountId,
    region: Region,
    tailnet: z.string(),
  }),
  /** Every live agent, name-sorted, with `host` where it differs from the derived one. */
  agents: z.array(MobileLinkAgent),
  /**
   * How many of `agents` the link actually names. Less than `agents.length`
   * only when the link would otherwise pass `MOBILE_LINK_MAX_LENGTH`; the
   * phone fills the rest from `GET /fleet`.
   */
  agents_in_link: z.number().int().nonnegative(),
});
export type MobilePairResult = z.infer<typeof MobilePairResult>;

/* ── hermeticd GET /fleet ───────────────────────────────────────────────── */

/** One agent as `GET /fleet` reports it: enough for the phone's list and detail. */
export const MobileFleetAgent = z.object({
  name: AgentName,
  status: AgentStatus,
  tailscale_dns_name: z.string().nullable(),
  tailscale_ip: z.string().nullable(),
  /**
   * The Hermes version the box runs (`running_hermes_version`, else the pinned
   * `hermes_version`); `null` when neither is known.
   */
  version: z.string().nullable(),
  /** The heartbeat's health block; absent until the first heartbeat lands. */
  health: Health.optional(),
});
export type MobileFleetAgent = z.infer<typeof MobileFleetAgent>;

/**
 * hermeticd's `GET /fleet` answer: the `_fleet` row's identity and every live
 * agent (no `_`-prefixed and no `destroyed` rows). Read with the agent role's
 * `dynamodb:Scan`; a phone without it keeps its pairing snapshot.
 */
export const MobileFleetView = z.object({
  fleet: z.object({
    fleet_id: FleetIdSchema,
    alias: z.string().nullable(),
    tailnet: z.string(),
    region: Region,
    account_id: AccountId,
    foundation_version: z.number().int().nonnegative(),
  }),
  agents: z.array(MobileFleetAgent),
  /** When the box read the table (it caches the scan briefly). */
  read_at: Iso,
});
export type MobileFleetView = z.infer<typeof MobileFleetView>;

/* ── Push registration (hermeticd /push/devices) ────────────────────────── */

export const MOBILE_PUSH_PLATFORMS = ["ios", "android"] as const;
export const MobilePushPlatform = z.enum(MOBILE_PUSH_PLATFORMS);
export type MobilePushPlatform = z.infer<typeof MobilePushPlatform>;

/** Expo's push token shape, the only token a box will store. */
export const EXPO_PUSH_TOKEN_RE = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]+\]$/;

/**
 * One phone's registration with one box: which bots on that box it wants
 * pushes for (`"all"`, or a list of bot names), and where to send them.
 */
export const MobilePushDevice = z
  .object({
    /** The phone's own stable id, chosen on the phone. */
    device_id: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_-]+$/),
    token: z.string().max(256).regex(EXPO_PUSH_TOKEN_RE, "an Expo push token"),
    platform: MobilePushPlatform,
    app_version: z.string().min(1).max(64),
    listening: z.union([z.literal("all"), z.array(BotName).max(64)]),
  })
  .strict();
export type MobilePushDevice = z.infer<typeof MobilePushDevice>;

/**
 * One registration as the box stores it: the phone's `MobilePushDevice` plus
 * two fields the box sets and the phone never sends (§9.4).
 *
 * - `owner` — who registered it: the tailnet login `tailscale whois` reported
 *   for the registering peer. Only that login may update or delete it.
 * - `renewed_at` — the last `POST` for this `device_id`. A registration not
 *   renewed for `PUSH_DEVICE_TTL_MS` (agentd) is skipped and then pruned, so a
 *   member removed from the tailnet stops receiving pushes on their own.
 */
export const MobilePushDeviceRecord = MobilePushDevice.extend({
  owner: z.string().min(1).max(256),
  renewed_at: Iso,
}).strict();
export type MobilePushDeviceRecord = z.infer<typeof MobilePushDeviceRecord>;

/** `push-devices.json` on the box: the stored registrations, oldest first. */
export const MobilePushDeviceList = z.object({ devices: z.array(MobilePushDeviceRecord) });
export type MobilePushDeviceList = z.infer<typeof MobilePushDeviceList>;

/* ── Push payload ───────────────────────────────────────────────────────── */

export const MOBILE_PUSH_KINDS = ["turn.done", "turn.error", "needs_action", "message"] as const;
export const MobilePushKind = z.enum(MOBILE_PUSH_KINDS);
export type MobilePushKind = z.infer<typeof MobilePushKind>;

/**
 * The `data` of an Expo push from a box's gateway watcher. `dedupe` is
 * `<instance>:<session>:<message_count>:<kind>`, so the phone drops a push for
 * an event its own live socket already showed.
 */
export const MobilePushData = z.object({
  fleet_id: FleetIdSchema,
  instance: AgentName,
  bot: BotName,
  session: z.string().min(1).max(256),
  kind: MobilePushKind,
  dedupe: z.string().min(1).max(512),
});
export type MobilePushData = z.infer<typeof MobilePushData>;
