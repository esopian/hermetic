/** Bot Mode's allowlisted, profile-scoped management surface. No arbitrary RPC or paths. */
import { z } from "zod";
import { AgentName, BotName } from "./requests.ts";
const Id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_.:-]+$/)
  .refine((v) => v !== "." && v !== "..", "A concrete identifier is required");
const Text = z.string().max(100_000);
const Ref = { instance: AgentName, bot: BotName };
const RoomRef = { instance: AgentName, room: Id };
export const BotCapabilitiesInput = z.object({ instance: AgentName }).strict();
export const BotProfileInput = z.object(Ref).strict();
export const BotCreateInput = z
  .object({
    instance: AgentName,
    name: BotName,
    description: z.string().max(1000).optional(),
    soul: Text.optional(),
    model: z.string().max(200).optional(),
    provider: z.string().max(100).optional(),
  })
  .strict();
export const BotUpdateInput = z
  .object({
    ...Ref,
    /**
     * The friendly name a bot presents, stored as `ui_meta['hermes-bots'].title`
     * the way Hermes Desktop's Edit profile does. `null` or an empty string
     * clears it, so the bot falls back to its display name or profile name. It
     * never renames the profile directory.
     */
    title: z.string().trim().max(64).nullable().optional(),
    description: z.string().max(1000).optional(),
    soul: Text.optional(),
    model: z.string().max(200).optional(),
    provider: z.string().max(100).optional(),
    disabled_skills: z.array(z.string().max(200)).max(500).optional(),
    enabled_toolsets: z.array(z.string().max(200)).max(500).optional(),
    enabled_mcp_servers: z.array(z.string().max(200)).max(500).optional(),
    confirm_expensive_model: z.boolean().optional(),
  })
  .strict();
export const BotDeleteInput = z.object({ ...Ref, confirm: z.literal(true) }).strict();
export const RoomsListInput = z
  .object({
    instance: AgentName,
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export const RoomGetInput = z.object(RoomRef).strict();
export const RoomCreateInput = z
  .object({
    instance: AgentName,
    room: Id,
    name: z.string().trim().min(1).max(120),
    members: z.array(z.object(Ref).strict()).min(2).max(6),
  })
  .strict()
  .refine(
    (v) => new Set(v.members.map((m) => `${m.instance}/${m.bot}`)).size === v.members.length,
    "Room members must be unique",
  );
export const RoomRenameInput = z
  .object({ ...RoomRef, name: z.string().trim().min(1).max(120), event_id: Id })
  .strict();
export const RoomDeleteInput = z.object({ ...RoomRef, confirm: z.literal(true) }).strict();
export const RoomHistoryInput = z
  .object({
    ...RoomRef,
    since_seq: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();
export const RoomSendInput = z.object({ ...RoomRef, text: Text.min(1), event_id: Id }).strict();
export const RoomControlInput = z
  .object({ ...RoomRef, action: z.enum(["stop", "retry"]), task_id: Id.optional() })
  .strict()
  .refine((v) => v.action !== "retry" || !!v.task_id, "Retry requires an exact task_id");
export const RoomRespondInput = z
  .object({
    ...RoomRef,
    member_id: Id,
    task_id: Id,
    execution_generation: z.number().int().min(0),
    request_id: Id,
    choice: z.enum(["once", "session", "always", "deny"]),
  })
  .strict();
export const RoutinesListInput = z.object(Ref).strict();
const RoutineFields = {
  name: z.string().trim().min(1).max(120),
  prompt: Text.min(1),
  schedule: z.string().trim().min(1).max(200),
  deliver: z.enum(["local", "bot"]).default("local"),
};
export const RoutineCreateInput = z.object({ ...Ref, ...RoutineFields }).strict();
export const RoutineUpdateInput = z
  .object({
    ...Ref,
    id: Id,
    name: RoutineFields.name.optional(),
    prompt: RoutineFields.prompt.optional(),
    schedule: RoutineFields.schedule.optional(),
    deliver: z.enum(["local", "bot"]).optional(),
    paused: z.boolean().optional(),
  })
  .strict();
export const RoutineDeleteInput = z.object({ ...Ref, id: Id, confirm: z.literal(true) }).strict();
export const RoutineRunInput = z.object({ ...Ref, id: Id }).strict();
export const RoutineHistoryInput = z
  .object({ ...Ref, id: Id, limit: z.number().int().min(1).max(100).optional() })
  .strict();

/**
 * Why each capability reads the way it does.
 *
 * `bots.capabilities` probes four independent gateway surfaces, so one `reason`
 * string cannot explain four flags: a gateway can have a live profile roster,
 * an unauthorized routine registry and an old hosted-room protocol at once. An
 * entry is null when the gateway answered that probe and the capability is on.
 */
export const BotCapabilityDetail = z.object({
  profiles: z.string().nullable(),
  routines: z.string().nullable(),
  hosted_rooms: z.string().nullable(),
  room_driver: z.string().nullable(),
});

/**
 * How much the probe actually learned about one capability.
 *
 * The booleans keep their meaning — `true` is "this gateway answered and the
 * capability is on" — but `false` used to carry two very different situations.
 * A 404 on the job registry is the gateway saying it has none. A 500, a
 * malformed body or an expired token is the gateway saying nothing at all, and
 * reporting that as "unsupported" hides a feature the box may well have.
 *
 * - `supported`: the probe answered and the capability is on (boolean `true`).
 * - `refused`: the probe answered *about the endpoint* — missing, forbidden or
 *   conflicting — so the capability is off (boolean `false`), and that answer
 *   is worth caching for the memo's lifetime.
 * - `unknown`: nothing was learned (boolean `false`, because a capability this
 *   build cannot confirm must not be offered). Never cached: the next call
 *   re-probes rather than serving a guess.
 *
 * Heads that want to say "we could not tell" rather than "your gateway is too
 * old" read this; heads that only gate a button keep reading the boolean.
 */
export const BotCapabilityStatus = z.enum(["supported", "refused", "unknown"]);

export const BotCapabilityCertainty = z.object({
  profiles: BotCapabilityStatus,
  routines: BotCapabilityStatus,
  hosted_rooms: BotCapabilityStatus,
  room_driver: BotCapabilityStatus,
});

export const BotModeCapabilities = z.object({
  instance: z.string(),
  profiles: z.boolean(),
  routines: z.boolean(),
  hosted_rooms: z.boolean(),
  room_driver: z.boolean(),
  room_methods: z.array(z.string()),
  /**
   * `groups.capabilities.protocol_version` exactly as the gateway reported it,
   * null when the gateway did not answer that call. Heads gate on this rather
   * than re-deriving a version from the boolean flags.
   */
  protocol_version: z.number().nullable(),
  /** `groups.capabilities.features`: the hosted-room feature flags as advertised. */
  room_features: z.array(z.string()),
  membership_edit: z.literal(false),
  cross_instance_rooms: z.literal(false),
  cross_instance_relay: z.literal(false),
  /** Unchanged meaning: why the hosted-room protocol call itself did not answer. */
  reason: z.string().nullable(),
  detail: BotCapabilityDetail,
  /**
   * Per-flag certainty. A boolean and a `detail` string cannot tell "this
   * gateway has no job registry" from "the probe never got an answer", and the
   * two want different words on screen and different retry behaviour.
   */
  status: BotCapabilityCertainty,
});
export const BotCapabilityEntry = z.object({ name: z.string(), enabled: z.boolean() });
export const BotProfile = z.object({
  instance: z.string(),
  bot: z.string(),
  description: z.string(),
  soul: z.string(),
  model: z.object({ provider: z.string(), default: z.string() }),
  skills: z.array(BotCapabilityEntry),
  toolsets: z.array(
    BotCapabilityEntry.extend({ label: z.string().optional(), description: z.string().optional() }),
  ),
  mcp_servers: z.array(BotCapabilityEntry.extend({ transport: z.string().optional() })),
});
export const HostedRoomMember = z.object({
  member_id: z.string(),
  profile: z.string(),
  handle: z.string(),
  display_name: z.string(),
});
export const HostedRoomEvent = z.object({
  room_id: z.string(),
  seq: z.number(),
  event_id: z.string(),
  kind: z.string(),
  actor: z.object({ kind: z.string(), id: z.string() }),
  text: z.string().nullable(),
  member_id: z.string().nullable(),
  created_at: z.string(),
});
export const HostedRoomAction = z.object({
  kind: z.string(),
  task_id: z.string(),
  member_id: z.string().optional(),
  request_id: z.string().optional(),
  execution_generation: z.number().optional(),
  text: z.string().optional(),
});
export const HostedRoom = z.object({
  instance: z.string(),
  id: z.string(),
  name: z.string(),
  members: z.array(HostedRoomMember),
  revision: z.number(),
  latest_seq: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
  disbanded_at: z.string().nullable(),
  working: z.boolean(),
  blocked: z.boolean(),
  pending_actions: z.array(HostedRoomAction),
});
/**
 * One `groups.log` page.
 *
 * `latest_seq` is the room's highest sequence number, which the gateway reports
 * on every page including an empty one. It is the only tail signal the protocol
 * offers — there is no reverse read, no `before_seq` and no negative offset —
 * so a client that wants to start near the end of a long room computes its own
 * `since_seq` from it. `cursor` is how far this page answered to; `has_more`
 * says the log runs past it.
 */
export const RoomHistoryPage = z.object({
  events: z.array(HostedRoomEvent),
  cursor: z.number(),
  latest_seq: z.number(),
  has_more: z.boolean(),
});
/**
 * What one `rooms.send` did.
 *
 * `duplicate` is upstream's `idempotent` flag: the gateway recognised this
 * `event_id` and returned the event it already holds rather than appending a
 * second one. An unknown delivery is not permission to replay, so a retry
 * carries the identity the first attempt carried — and this flag is how the
 * caller learns that the retry reconciled with an existing message instead of
 * posting another. A reused id carrying *different* content is a `CONFLICT`,
 * not a duplicate, and never reaches this shape.
 */
export const RoomSendReceipt = z.object({
  accepted: z.literal(true),
  event_id: z.string(),
  duplicate: z.boolean(),
});
export const BotRoutine = z.object({
  instance: z.string(),
  bot: z.string(),
  id: z.string(),
  name: z.string(),
  prompt: z.string(),
  schedule: z.string(),
  deliver: z.enum(["local", "bot", "other"]),
  paused: z.boolean(),
  next_run_at: z.string().nullable(),
  last_run_at: z.string().nullable(),
  last_status: z.string().nullable(),
});
export const BotRoutineRun = z.object({
  id: z.string(),
  status: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  text: z.string(),
  error: z.string().nullable(),
});

export type BotCapabilitiesInput = z.infer<typeof BotCapabilitiesInput>;
export type BotProfileInput = z.infer<typeof BotProfileInput>;
export type BotCreateInput = z.infer<typeof BotCreateInput>;
export type BotUpdateInput = z.infer<typeof BotUpdateInput>;
export type BotDeleteInput = z.infer<typeof BotDeleteInput>;
export type RoomsListInput = z.infer<typeof RoomsListInput>;
export type RoomGetInput = z.infer<typeof RoomGetInput>;
export type RoomCreateInput = z.infer<typeof RoomCreateInput>;
export type RoomRenameInput = z.infer<typeof RoomRenameInput>;
export type RoomDeleteInput = z.infer<typeof RoomDeleteInput>;
export type RoomHistoryInput = z.infer<typeof RoomHistoryInput>;
export type RoomSendInput = z.infer<typeof RoomSendInput>;
export type RoomControlInput = z.infer<typeof RoomControlInput>;
export type RoomRespondInput = z.infer<typeof RoomRespondInput>;
export type RoutinesListInput = z.infer<typeof RoutinesListInput>;
export type RoutineCreateInput = z.infer<typeof RoutineCreateInput>;
export type RoutineUpdateInput = z.infer<typeof RoutineUpdateInput>;
export type RoutineDeleteInput = z.infer<typeof RoutineDeleteInput>;
export type RoutineRunInput = z.infer<typeof RoutineRunInput>;
export type RoutineHistoryInput = z.infer<typeof RoutineHistoryInput>;
export type BotModeCapabilities = z.infer<typeof BotModeCapabilities>;
export type BotCapabilityDetail = z.infer<typeof BotCapabilityDetail>;
export type BotCapabilityStatus = z.infer<typeof BotCapabilityStatus>;
export type BotCapabilityCertainty = z.infer<typeof BotCapabilityCertainty>;
export type BotProfile = z.infer<typeof BotProfile>;
export type HostedRoom = z.infer<typeof HostedRoom>;
export type HostedRoomEvent = z.infer<typeof HostedRoomEvent>;
export type RoomHistoryPage = z.infer<typeof RoomHistoryPage>;
export type RoomSendReceipt = z.infer<typeof RoomSendReceipt>;
export type BotRoutine = z.infer<typeof BotRoutine>;
export type BotRoutineRun = z.infer<typeof BotRoutineRun>;
