import { z } from "zod";
import { Iso } from "./common.ts";
import { AgentName } from "./requests.ts";

/**
 * The partition key every tombstone lives under in the `events` table (§4.2).
 *
 * A destroyed agent no longer has a row: `agents.destroy` ends by deleting it
 * so the name is free again (§6.7). What survives is this record, written
 * under one reserved partition rather than under the agent's own name, so a
 * single `Query` lists every agent the fleet has ever destroyed without a
 * `Scan`, and a `begins_with` key condition narrows it to one name's
 * incarnations (`tombstoneSortKey`). The leading underscore is what keeps it
 * out of the way: `validateName` refuses any name that starts with `_`
 * (§6.1), so no agent's event log can ever share this partition, and
 * `agents.history` — which admits `_fleet` and nothing else with that prefix
 * — can never read it as history.
 */
export const DESTROYED_KEY = "_destroyed";

/**
 * A tombstone's range key: the name first, then the moment of destruction.
 *
 * Name first so the reads that matter most — a release or create asking for
 * one name's predecessors (`existingTombstone`, `predecessorFloor`), the
 * destroyed view narrowed to one name — are a key condition,
 * `begins_with(timestamp, tombstoneNamePrefix(name))`, and touch only that
 * name's items rather than filtering the whole partition. Within a name the
 * ISO time sorts chronologically, so a reverse query is that name's newest
 * incarnation first. Two agents destroyed in the same millisecond still land
 * on different keys, because their names differ.
 *
 * The price is that the partition as a whole sorts by name, not by time: the
 * unfiltered read (`agents.destroyed` with no name, the archive, a plan) walks
 * every page and sorts by `destroyed_at` itself (`tombstonesNewestFirst`)
 * before it applies a limit. That list is the fleet's whole destroy history,
 * read by humans, so it is small enough to read whole.
 *
 * It is `destroyed_at`, never `released_at`, even for a legacy row released
 * long after its destroy. One name's incarnations are strictly sequential, and
 * a legacy row is always its name's newest incarnation until it is released —
 * nothing else can hold the name meanwhile — so destruction order and release
 * order agree per name, and the newest tombstone for a name is still the
 * predecessor (`predecessorFloor`, which passes over a future-dated forgery).
 * The original time is also stable across retries (it is derived from the
 * name's history, which a release does not change), so an interrupted legacy
 * release rewrites the same key rather than adding one.
 */
export function tombstoneSortKey(name: string, destroyedAt: string): string {
  return `${tombstoneNamePrefix(name)}${destroyedAt}`;
}

/**
 * The range-key prefix every one of `name`'s tombstones shares, separator
 * included. The trailing `#` is load-bearing: `validateName` admits only
 * lowercase alphanumerics and hyphens (`AGENT_NAME_RE`, §6.1), so `#` can never
 * occur inside a name, and `ab#` therefore cannot be a prefix of `abc#…`.
 * Without it, a per-name read of `ab` would return `abc`'s incarnations too.
 */
export function tombstoneNamePrefix(name: string): string {
  return `${name}#`;
}

/**
 * The order every unfiltered tombstone read returns: newest `destroyed_at`
 * first, ties broken by name so the order does not depend on the store. ISO
 * strings in the one format `Iso` admits compare correctly as strings.
 */
export function tombstonesNewestFirst(a: AgentTombstone, b: AgentTombstone): number {
  if (a.destroyed_at !== b.destroyed_at) return a.destroyed_at < b.destroyed_at ? 1 : -1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * The audit record of one incarnation of an agent (§6.7).
 *
 * This is the whole of what outlives a destroy besides the per-name event
 * log: everything an operator reviewing the fleet's history would ask of a
 * row that no longer exists. `created_at` and `destroyed_at` bound the
 * incarnation — `agents.history` can be windowed to them, so when a name is
 * reused the old life's events do not blend into the new one's. `volume_kept`
 * says whether a data volume outlived the agent (tagged `former_agent=<name>`,
 * never `agent=<name>`, so a later `create` of the same name cannot adopt it
 * by accident; §9.1), and `volume_id` names it either way.
 *
 * Legacy rows: a fleet destroyed agents before tombstones existed, and those
 * rows still sit in the agents table with `status: destroyed`. `agents.destroyed`
 * renders them through this same shape (`legacy: true`), and the first destroy
 * or create that touches one releases it for real — tombstone written, row
 * deleted — so the two representations converge without a migration.
 */
export const AgentTombstone = z.object({
  name: AgentName,
  fleet_id: z.string(),
  created_at: Iso,
  created_by: z.string().nullable(),
  destroyed_at: Iso,
  destroyed_by: z.string(),
  size: z.string().nullable(),
  region: z.string().nullable(),
  provider: z.string().nullable(),
  profile_id: z.string().nullable(),
  /** The last instance the row named; the box is terminated by the time this is written. */
  instance_id: z.string().nullable(),
  /** The last data volume the row named — deleted, or kept and released from the name. */
  volume_id: z.string().nullable(),
  volume_kept: z.boolean(),
  hermes_version: z.string().nullable(),
  /**
   * When and by whom the name was released, when that was not the destroy
   * itself. Absent on a tombstone a destroy writes today — the destroy *is*
   * the release, so `destroyed_at`/`destroyed_by` say both. Present when a
   * legacy `destroyed` row was released by a later destroy or create of its
   * name: `destroyed_at`/`destroyed_by` then keep the original destroy's time
   * and actor (from the name's history, as `agents.destroyed` read them before
   * the release; capped at the release time), and these record the release —
   * the moment of its `release` event. An incarnation's record therefore ends
   * at `released_at ?? destroyed_at`: that is the `until` that still includes
   * the `release` event, and the instant a new incarnation must be born after.
   */
  released_at: Iso.optional(),
  released_by: z.string().optional(),
  /**
   * `true` when this record was synthesised from a pre-tombstone `destroyed`
   * row rather than read from the `_destroyed` partition. Display only.
   */
  legacy: z.boolean().default(false),
});
export type AgentTombstone = z.infer<typeof AgentTombstone>;

/**
 * The item as stored: the tombstone plus the two key attributes the events
 * table needs. `name` is the partition (`_destroyed`), `timestamp` the range
 * key (`tombstoneSortKey`); the agent's own name moves to `agent`. Only the
 * stores read or write this shape — everything above them sees `AgentTombstone`.
 *
 * The range key must be exactly the one `toTombstoneItem` derives from the
 * item's own `agent` and `destroyed_at`. The events table is writable by the
 * boxes, and a per-name read selects by the key while callers trust the
 * `agent` attribute: an item keyed under `ab#…` that claimed `agent: "abc"`
 * would otherwise surface in `ab`'s read as one of `abc`'s incarnations, and
 * one keyed under another time would sort where its `destroyed_at` does not
 * say. Such an item fails the parse, and every read skips what does not parse.
 */
export const TombstoneItem = AgentTombstone.omit({ name: true, legacy: true })
  .extend({
    name: z.literal(DESTROYED_KEY),
    timestamp: z.string(),
    agent: AgentName,
  })
  .refine((item) => item.timestamp === tombstoneSortKey(item.agent, item.destroyed_at), {
    message: "range key does not match the tombstone's agent and destroyed_at",
    path: ["timestamp"],
  });
export type TombstoneItem = z.infer<typeof TombstoneItem>;

export function toTombstoneItem(t: AgentTombstone): TombstoneItem {
  const { name, legacy: _legacy, ...rest } = t;
  return {
    ...rest,
    name: DESTROYED_KEY,
    timestamp: tombstoneSortKey(name, t.destroyed_at),
    agent: name,
  };
}

export function fromTombstoneItem(item: TombstoneItem): AgentTombstone {
  const { name: _pk, timestamp: _sk, agent, ...rest } = item;
  return { ...rest, name: agent, legacy: false };
}

export const ListDestroyedInput = z.object({
  /** Only this name's incarnations, when given. */
  name: AgentName.optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});
export type ListDestroyedInput = z.infer<typeof ListDestroyedInput>;
