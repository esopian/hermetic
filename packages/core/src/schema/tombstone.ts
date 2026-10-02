import { z } from "zod";
import { Iso } from "./common.ts";
import { AgentName } from "./requests.ts";

/**
 * The partition key every tombstone lives under in the `events` table (§4.2).
 *
 * A destroyed agent no longer has a row: `agents.destroy` ends by deleting it
 * so the name is free again (§6.7). What survives is this record, written
 * under one reserved partition rather than under the agent's own name, so a
 * single `Query` lists every agent the fleet has ever destroyed, newest first,
 * without a `Scan`. The leading underscore is what keeps it out of the way:
 * `validateName` refuses any name that starts with `_` (§6.1), so no agent's
 * event log can ever share this partition, and `agents.history` — which admits
 * `_fleet` and nothing else with that prefix — can never read it as history.
 */
export const DESTROYED_KEY = "_destroyed";

/**
 * A tombstone's range key: the moment of destruction first, so the partition
 * sorts chronologically and a reverse query is newest-first, then the name,
 * so two agents destroyed in the same millisecond do not overwrite each other.
 */
export function tombstoneSortKey(destroyedAt: string, name: string): string {
  return `${destroyedAt}#${name}`;
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
 */
export const TombstoneItem = AgentTombstone.omit({ name: true, legacy: true }).extend({
  name: z.literal(DESTROYED_KEY),
  timestamp: z.string(),
  agent: AgentName,
});
export type TombstoneItem = z.infer<typeof TombstoneItem>;

export function toTombstoneItem(t: AgentTombstone): TombstoneItem {
  const { name, legacy: _legacy, ...rest } = t;
  return {
    ...rest,
    name: DESTROYED_KEY,
    timestamp: tombstoneSortKey(t.destroyed_at, name),
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
