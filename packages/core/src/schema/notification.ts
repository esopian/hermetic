/**
 * The notification record (§4.9).
 *
 * A notification is about *who is watching*, not about the fleet: it lives in
 * the laptop's local SQLite beside `runs` (§4.6), never in DynamoDB. Two
 * laptops watching one fleet keep their own inboxes, and muting on one does not
 * silence the other.
 *
 * `key` is what makes a *condition* notify once while it holds: it is unique
 * among unresolved rows, so a scan that keeps seeing the same advisory keeps
 * finding the row it already wrote. `resolved_at` closes it, and a later
 * recurrence is a new row.
 */
import { z } from "zod";
import { Iso } from "./common.ts";

/** Which part of hermetic raised the row. `budget` is reserved for a later phase. */
export const NotificationSource = z.enum(["operation", "agent", "fleet", "chat", "budget"]);
export type NotificationSource = z.infer<typeof NotificationSource>;

export const NOTIFICATION_SOURCES = NotificationSource.options;
export { INSTANCE_NOTIFICATION_SOURCES, hiddenByListening } from "../shared/notifications.ts";

/**
 * What happened, at the granularity a head renders against. `budget.*` joins
 * this list with the phase that raises it.
 *
 * The two chat kinds (§4.9) are a deliberately asymmetric pair, and the split between them
 * is the split between *the operator asked and did not get it* and *something
 * arrived that nobody here asked for*:
 *
 * - `chat.error` — a turn failed. It is keyed on the bot and the failure's own
 *   code, so a laptop that has fallen off the tailnet writes one row per bot
 *   rather than one per attempt, and a turn that later succeeds resolves it.
 * - `chat.message` — a bot's transcript moved on without this portal having
 *   driven the turn: a cron routine, a messaging channel, a peer bot, another
 *   Hermes client (§9.2's "Origin"). A turn the caller is streaming raises
 *   nothing, because the reply is already arriving in their hands.
 */
export const NotificationKind = z.enum([
  "operation.failed",
  "operation.done",
  "agent.health",
  "fleet.advisory",
  "chat.message",
  "chat.error",
]);
export type NotificationKind = z.infer<typeof NotificationKind>;

/** How it reads: the colour a head gives the row, and whether it wants an answer. */
export const NotificationClass = z.enum(["ok", "info", "warn", "bad", "needs_action"]);
export type NotificationClass = z.infer<typeof NotificationClass>;

/**
 * Where an action button goes. A closed enum, because a head has to be able to
 * route every one of them — an action naming a destination the portal has never
 * heard of is a dead button, and core is where that is prevented.
 */
export const NotificationActionTarget = z.enum([
  "agent",
  "op",
  "run",
  "foundation",
  "volumes",
  "settings",
  /**
   * A conversation. `ref` is `<instance>/<bot>` (`chatActionRef` below), which
   * is more than the portal can route today — `#chat` addresses the view and
   * not yet a thread within it; deep-linking one is future work. The ref is
   * carried anyway, because the alternative is a schema change whenever that
   * lands, and because `hermetic inbox` can print
   * it as the thread to open by hand in the meantime.
   */
  "chat",
]);
export type NotificationActionTarget = z.infer<typeof NotificationActionTarget>;

export const NotificationAction = z.object({
  label: z.string().min(1),
  target: NotificationActionTarget,
  /** What the target is addressed by: an agent name, an op id, a run id. */
  ref: z.string().optional(),
});
export type NotificationAction = z.infer<typeof NotificationAction>;

export const Notification = z.object({
  id: z.string().min(1),
  at: Iso,
  source: NotificationSource,
  kind: NotificationKind,
  class: NotificationClass,
  title: z.string().min(1),
  detail: z.string().nullish(),
  agent: z.string().nullish(),
  /**
   * Nullable: a row raised before a fleet was chosen, or about the laptop
   * itself, belongs to no fleet. `notifications.list` returns the active
   * fleet's rows plus those.
   */
  fleet_id: z.string().nullish(),
  /** Op id, run id, volume id — whatever the row is *about*. */
  ref: z.string().nullish(),
  /** The condition this row reports, unique among unresolved rows. */
  key: z.string().nullish(),
  actions: z.array(NotificationAction),
  read_at: Iso.nullish(),
  resolved_at: Iso.nullish(),
  /**
   * Derived at list time by joining the mute table — never stored, because a
   * mute applies to every row an agent or a source has ever raised and a stored
   * copy would be right only until the next `inbox mute`.
   */
  muted: z.boolean(),
});
export type Notification = z.infer<typeof Notification>;

/**
 * How a `chat` action names its thread: `<instance>/<bot>`.
 *
 * Spelled once, here, beside the enum member it belongs to, because both heads
 * have to take it apart again and a second spelling of the separator is a
 * second thing to keep in step. An instance is an agent name and therefore
 * matches `AGENT_NAME_RE`, which admits neither `/` nor `:`, so the first `/`
 * is unambiguously the separator however a box has chosen to name its bots.
 */
export function chatActionRef(instance: string, bot: string): string {
  return `${instance}/${bot}`;
}

/** `agent:<name>` or `source:<source>` — the two things that can be silenced. */
export const NotificationMute = z.object({ target: z.string().min(1), at: Iso });
export type NotificationMute = z.infer<typeof NotificationMute>;

export const NotificationsListResult = z.object({
  notifications: z.array(Notification),
  unread: z.number().int(),
  needs_action: z.number().int(),
  mutes: z.array(NotificationMute),
});
export type NotificationsListResult = z.infer<typeof NotificationsListResult>;

export const NotificationsAckResult = z.object({ acked: z.number().int() });
export type NotificationsAckResult = z.infer<typeof NotificationsAckResult>;

export const NotificationsMuteResult = z.object({ mutes: z.array(NotificationMute) });
export type NotificationsMuteResult = z.infer<typeof NotificationsMuteResult>;

/** `agent:<name>` / `source:<source>`, spelled in exactly one place. */
export function agentMuteTarget(agent: string): string {
  return `agent:${agent}`;
}

export function sourceMuteTarget(source: NotificationSource): string {
  return `source:${source}`;
}
