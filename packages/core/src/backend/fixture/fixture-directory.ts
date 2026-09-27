/**
 * The fixture fleet directory (§4.8): the account-level register of which
 * fleets exist, for a `MemoryBackend`.
 *
 * It lives outside `memory.ts` for two reasons. The obvious one is size — that
 * file is at the limit rule 5 sets. The real one is that this is the single
 * piece of fixture state that is *not* per-backend: a portal switching fleets
 * throws away one `MemoryBackend` and builds another, and a directory that went
 * with the old one would make the list of fleets disappear the moment it was
 * used. So the directory is a `FixtureAccount`: an explicit object the head
 * that owns the session creates once and hands to every backend that stands
 * in it. Nothing here is process-global; two accounts in one process are two
 * accounts, which is what a test suite needs and what a fixture never had.
 *
 * Three states, because a fixture has to be able to be all three accounts an
 * `init` can meet: an account with a directory holding the two fixture fleets,
 * an account with a directory holding nothing, and an account with no directory
 * table at all.
 */
import type { DirectoryApi } from "../types.ts";
import type { DirectoryEntry, DirectoryStatus } from "../../schema/index.ts";
import { DEFAULT_DIRECTORY_REGION, DIRECTORY_PITR_DAYS, DIRECTORY_TABLE } from "../../schema/index.ts";

/** Which account a fixture backend is standing in. */
export type FixtureDirectoryMode = "seeded" | "empty" | "absent";

/**
 * The fake account's fleet directory: what every `MemoryBackend` sharing the
 * account reads and writes. Mutable on purpose — a test reaches into `entries`
 * to describe an account no seed does (a torn-down fleet, a sole survivor).
 */
export interface FixtureAccount {
  readonly entries: Map<string, DirectoryEntry>;
  /**
   * Whether the *table* is there. Distinct from `entries.size === 0`: an
   * account whose directory exists and holds nothing is what the second
   * `init` in a fresh account meets, and an account with no table at all is
   * what the first one meets. `init` says something different about each.
   */
  exists: boolean;
}

/**
 * Put an account into one of its three states, in place — in place so that
 * every backend already holding the account sees the change, which is what a
 * fixture `init --create` relies on when it empties the account it was given.
 */
export function seedFixtureAccount(
  account: FixtureAccount,
  mode: FixtureDirectoryMode,
  seed: () => DirectoryEntry[],
): FixtureAccount {
  account.entries.clear();
  if (mode === "seeded") for (const e of seed()) account.entries.set(e.fleet_id, e);
  account.exists = mode !== "absent";
  return account;
}

/** A fresh account in the given state. */
export function fixtureAccount(
  mode: FixtureDirectoryMode,
  seed: () => DirectoryEntry[],
): FixtureAccount {
  return seedFixtureAccount({ entries: new Map(), exists: false }, mode, seed);
}

/**
 * Whether a display alias is already spoken for by some *other* fleet (§4.7).
 *
 * Torn-down rows count. Their labels stay reserved so an old label cannot
 * silently start meaning a different fleet, and `fleet alias --clear` on the
 * torn-down id is what releases one — the same rule the real directory enforces
 * with a conditional write against the alias reservation row, which is why it
 * has to be enforced here too rather than only there.
 */
function aliasHeld(account: FixtureAccount, alias: string | null, fleetId: string): boolean {
  if (alias === null) return false;
  return [...account.entries.values()].some((e) => e.fleet_id !== fleetId && e.name === alias);
}

/**
 * The `DirectoryApi` over an account. `record` is the backend's own mutation
 * log, passed in rather than reached for, so this file knows nothing about the
 * backend it belongs to.
 */
export function createFixtureDirectory(
  account: FixtureAccount,
  record: (method: string) => void,
): DirectoryApi {
  const status = async (): Promise<DirectoryStatus> => {
    const exists = account.exists;
    const fleets = exists ? [...account.entries.values()].map((e) => structuredClone(e)) : [];
    fleets.sort((a, b) => (a.name ?? a.fleet_id).localeCompare(b.name ?? b.fleet_id));
    return {
      region: DEFAULT_DIRECTORY_REGION,
      table: DIRECTORY_TABLE,
      exists,
      billing_mode: exists ? "PAY_PER_REQUEST" : null,
      pitr_enabled: exists,
      pitr_recovery_days: exists ? DIRECTORY_PITR_DAYS : null,
      deletion_protection: exists,
      item_count: exists ? fleets.length : null,
      fleets,
      // A fixture writes only what this build can read, so there is never
      // anything here it cannot parse.
      unparseable: 0,
    };
  };

  return {
    region: DEFAULT_DIRECTORY_REGION,

    ensure: async (): Promise<DirectoryStatus> => {
      record("directory.ensure");
      account.exists = true;
      return status();
    },

    status,

    get: async (fleet_id: string): Promise<DirectoryEntry | null> => {
      if (!account.exists) return null;
      const found = account.entries.get(fleet_id);
      return found ? structuredClone(found) : null;
    },

    list: async (): Promise<DirectoryEntry[]> => (await status()).fleets,

    register: async (entry: DirectoryEntry): Promise<boolean> => {
      record("directory.register");
      const entries = account.entries;
      if (entries.has(entry.fleet_id)) return false;
      if (aliasHeld(account, entry.name, entry.fleet_id)) return false;
      entries.set(entry.fleet_id, structuredClone(entry));
      account.exists = true;
      return true;
    },

    update: async (entry: DirectoryEntry, expect?: { alias: string | null }): Promise<boolean> => {
      record("directory.update");
      const entries = account.entries;
      const existing = entries.get(entry.fleet_id);
      if (!existing) return false;
      // The same optimistic guard the real directory puts in its condition
      // expression: a caller that read an alias and then wrote loses if the row
      // moved in between. Modelled here so the refusal is reachable offline.
      if (expect !== undefined && existing.name !== expect.alias) return false;
      if (entry.name !== existing.name && aliasHeld(account, entry.name, entry.fleet_id)) return false;
      entries.set(entry.fleet_id, structuredClone(entry));
      return true;
    },

    remove: async (fleet_id: string): Promise<boolean> => {
      record("directory.remove");
      const entries = account.entries;
      if (!entries.has(fleet_id)) return false;
      entries.delete(fleet_id);
      return true;
    },

    /**
     * Nothing to do: a fixture directory has only ever held rows in the current
     * shape. It answers rather than throws so `foundation update` runs the same
     * v9 hook in fixture mode as against a real account (§4.8).
     */
    migrate: async () => ({ fleets: 0, aliases: 0, duplicates: 0 }),
  };
}
