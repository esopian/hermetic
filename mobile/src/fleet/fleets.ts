/**
 * Every fleet this phone is paired with, and which one is in front: the list
 * a Slack-style switcher reads. One fleet is active at a time; each keeps its
 * own record (`fleetRecordKey`), view cache and inbox, so switching back finds
 * its listening choice, primary and unread marks where they were.
 *
 * Kept in the keychain under `hermetic.fleets`. A phone paired before this
 * list existed holds one record at `FLEET_KEY_PREFIX`; the first read moves it
 * to its per-fleet key. Writing it fresh also re-adds it under the keychain
 * class `persist.ts` now asks for (SecureStore's update keeps an item's old one).
 *
 * A failed keychain read throws: a background launch on a locked phone is not
 * "no fleets".
 */
import type { PairedLink } from "./pairing.ts";
import { readPairingLink } from "./pairing.ts";
import {
  FLEET_KEY_PREFIX,
  fleetRecordKey,
  type KvStorage,
  loadChunked,
  removeChunked,
  saveChunked,
} from "./store.ts";

export const FLEETS_KEY = "hermetic.fleets";

export interface FleetEntry {
  fleet_id: string;
  /** What the switcher shows: the alias, else the id (`PairedLink.label`). */
  label: string;
  tailnet: string;
}

export interface FleetIndex {
  active: string | null;
  fleets: FleetEntry[];
}

export const NO_FLEETS: FleetIndex = { active: null, fleets: [] };

export const entryOf = (link: PairedLink): FleetEntry => ({
  fleet_id: link.payload.fleet_id,
  label: link.label,
  tailnet: link.payload.tailnet,
});

/** The stored list, moving a one-fleet record into it first. */
export async function loadFleets(
  kv: KvStorage,
  opts: { operatorTailnet?: string | null } = {},
): Promise<FleetIndex> {
  const raw = await kv.get(FLEETS_KEY);
  if (raw) return parseIndex(raw);
  const legacy = await loadChunked(kv, FLEET_KEY_PREFIX);
  if (!legacy) return NO_FLEETS;
  let link: string | null = null;
  try {
    const v = JSON.parse(legacy) as { link?: unknown };
    link = typeof v.link === "string" ? v.link : null;
  } catch {}
  const read = link ? readPairingLink(link, opts) : null;
  if (!read?.ok) return NO_FLEETS;
  // New record, then the list, then the old record: a crash part way leaves one readable copy.
  const index: FleetIndex = { active: read.link.payload.fleet_id, fleets: [entryOf(read.link)] };
  await saveChunked(kv, fleetRecordKey(read.link.payload.fleet_id), legacy);
  await saveFleets(kv, index);
  await removeChunked(kv, FLEET_KEY_PREFIX);
  return index;
}

export function saveFleets(kv: KvStorage, index: FleetIndex): Promise<void> {
  return kv.set(FLEETS_KEY, JSON.stringify(index));
}

/** `link`'s fleet added (or its entry refreshed) and made active. */
export function withFleet(index: FleetIndex, link: PairedLink): FleetIndex {
  const entry = entryOf(link);
  const at = index.fleets.findIndex((f) => f.fleet_id === entry.fleet_id);
  const fleets = at < 0 ? [...index.fleets, entry] : index.fleets.map((f, i) => (i === at ? entry : f));
  return { active: entry.fleet_id, fleets };
}

/** `fleetId` dropped; the next one left (else none) becomes active. */
export function withoutFleet(index: FleetIndex, fleetId: string): FleetIndex {
  const fleets = index.fleets.filter((f) => f.fleet_id !== fleetId);
  const active = index.active === fleetId ? (fleets[0]?.fleet_id ?? null) : index.active;
  return { active, fleets };
}

function parseIndex(raw: string): FleetIndex {
  try {
    const v = JSON.parse(raw) as Partial<FleetIndex>;
    const fleets = Array.isArray(v.fleets)
      ? v.fleets.filter(
          (f): f is FleetEntry =>
            typeof f?.fleet_id === "string" &&
            typeof f.label === "string" &&
            typeof f.tailnet === "string",
        )
      : [];
    const active = fleets.some((f) => f.fleet_id === v.active) ? (v.active as string) : null;
    return { active: active ?? fleets[0]?.fleet_id ?? null, fleets };
  } catch {
    return NO_FLEETS;
  }
}
