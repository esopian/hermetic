/**
 * The fixture's DynamoDB: the `store` port of `MemoryBackend`, split out of
 * `memory.ts` (AGENTS.md rule 5). Reads and writes the backend's own maps and
 * records every mutation through it, exactly as the in-class literal did.
 */
import type { Agent, AgentEvent, AgentTombstone, FleetItem, FleetSettings } from "../schema/index.ts";
import { FLEET_KEY, tombstoneSortKey } from "../schema/index.ts";
import { HermeticError } from "../errors.ts";
import type {
  AgentPatch,
  Backend,
  FleetExpectation,
  FleetPatch,
  FleetUpdateOptions,
  VolumeClaim,
} from "./types.ts";

import type { MemoryBackend } from "./memory.ts";
import { simulateRerun } from "./memory-simulation.ts";

/**
 * Is this TTL lock still held at `now`?
 *
 * `>=`, not `>`, because DynamoDB frees the lock on `#lock.#expires < :now` —
 * a lock whose expiry is exactly the current tick is still *held* there. The
 * memory backend exists to be indistinguishable from the real store, so the one
 * millisecond the two used to disagree over is not a rounding detail: it is the
 * millisecond in which two operators could both believe they hold it.
 */
function lockIsLive(lock: { expires: string }, now: Date): boolean {
  return Date.parse(lock.expires) >= now.getTime();
}

export function createMemoryStore(b: MemoryBackend): Backend["store"] {
  return {
    agents: {
      get: async (name: string): Promise<Agent | null> => {
        const found = b.agents.get(name);
        return found ? structuredClone(found) : null;
      },
      putIfAbsent: async (agent: Agent): Promise<boolean> => {
        b.record("store.agents.putIfAbsent");
        if (b.agents.has(agent.name)) return false;
        b.agents.set(agent.name, structuredClone(agent));
        return true;
      },
      update: async (name: string, expectedVersion: number, patch: AgentPatch): Promise<Agent> => {
        b.record("store.agents.update");
        const current = b.agents.get(name);
        if (!current) {
          throw new HermeticError("NOT_FOUND", `no such agent: ${name}`, { name });
        }
        if (current.version !== expectedVersion) {
          throw new HermeticError(
            "CONFLICT",
            `agent ${name} changed underneath this operation (expected version ${expectedVersion}, found ${current.version})`,
            { name, expected: expectedVersion, actual: current.version },
          );
        }
        const next: Agent = {
          ...current,
          ...structuredClone(patch),
          name,
          version: current.version + 1,
          updated_at: b.now().toISOString(),
        };
        b.agents.set(name, next);
        // §3.2: the fixture has no box to poll the row, so it plays the runner.
        if (patch.command?.action === "rerun") simulateRerun(b, name, patch.command.id);
        return structuredClone(next);
      },
      scan: async (): Promise<Agent[]> =>
        structuredClone([...b.agents.values()].filter((a) => !b.unparseableRows.includes(a.name))),
      /**
       * The real store skips a row it cannot parse rather than failing the whole
       * fleet read (§4.5). Naming a row here models that: `scan` hides it and
       * `doctor` reports it.
       */
      unparseable: (): string[] => [...b.unparseableRows],
      /**
       * As the real store: conditional on `expectedVersion` and
       * `expectedCreatedAt` when given — one incarnation at one version — and
       * a no-op when gone.
       */
      delete: async (
        name: string,
        opts?: { expectedVersion: number; expectedCreatedAt: string },
      ): Promise<void> => {
        b.record("store.agents.delete");
        const current = b.agents.get(name);
        if (!current) return;
        if (
          opts !== undefined &&
          (current.version !== opts.expectedVersion || current.created_at !== opts.expectedCreatedAt)
        ) {
          const replaced = current.created_at !== opts.expectedCreatedAt;
          throw new HermeticError(
            "CONFLICT",
            replaced
              ? `agent ${name} is a different incarnation now (created ${current.created_at}, expected ${opts.expectedCreatedAt}); the record was not deleted`
              : `agent ${name} changed underneath this operation (expected version ${opts.expectedVersion}, found ${current.version}); the record was not deleted`,
            {
              name,
              expected: opts.expectedVersion,
              actual: current.version,
              expected_created_at: opts.expectedCreatedAt,
              actual_created_at: current.created_at,
            },
          );
        }
        b.agents.delete(name);
      },
    },
    events: {
      append: async (event: AgentEvent): Promise<void> => {
        b.record("store.events.append");
        b.events.push(structuredClone(event));
      },
      query: async (name: string, limit?: number): Promise<AgentEvent[]> => {
        const rows = b.events
          .filter((e) => e.name === name)
          .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
        return structuredClone(limit === undefined ? rows : rows.slice(0, limit));
      },
      appendTombstone: async (tombstone: AgentTombstone): Promise<void> => {
        b.record("store.events.appendTombstone");
        b.tombstones.set(
          tombstoneSortKey(tombstone.destroyed_at, tombstone.name),
          structuredClone({ ...tombstone, legacy: false }),
        );
      },
      queryTombstones: async (opts?: { name?: string; limit?: number }): Promise<AgentTombstone[]> => {
        const rows = [...b.tombstones.entries()]
          .sort(([a], [c]) => (a < c ? 1 : a > c ? -1 : 0))
          .map(([, t]) => t)
          .filter((t) => opts?.name === undefined || t.name === opts.name);
        return structuredClone(opts?.limit === undefined ? rows : rows.slice(0, opts.limit));
      },
    },
    fleet: {
      get: async (): Promise<FleetItem | null> => (b.fleetItem ? structuredClone(b.fleetItem) : null),
      /**
       * Creation only, exactly as the real store's `attribute_not_exists`
       * condition makes it: a fixture fleet that already has a `_fleet` item
       * must refuse the overwrite the same way a real one does, or fixture mode
       * is a more permissive fleet than production (§4.4).
       */
      put: async (item: FleetItem): Promise<void> => {
        if (b.fleetItem) {
          throw new HermeticError(
            "CONFLICT",
            `fleet ${item.fleet_id} already has a ${FLEET_KEY} record; it was not overwritten`,
            { fleet_id: item.fleet_id },
          );
        }
        b.record("store.fleet.put");
        b.fleetItem = structuredClone({ ...item, version: item.version ?? 0 });
      },
      /**
       * The attribute-level metadata write (§4.4): the named fields and the
       * revision counter, evaluated against what is stored rather than against
       * the caller's copy of it. A key with no value means "leave it alone",
       * which is what the real store's expression can express and a spread
       * cannot — hence the filter.
       */
      updateFleet: async (patch: FleetPatch, opts: FleetUpdateOptions): Promise<FleetItem | null> => {
        const stored = b.fleetItem;
        if (!stored) return null;
        const named = Object.fromEntries(
          Object.entries(patch).filter(([, v]) => v !== undefined),
        ) as FleetPatch;
        // A patch that names nothing is not a write, so it moves no counter and
        // records no mutation — the real store short-circuits the same way.
        if (Object.keys(named).length === 0) return structuredClone(stored);
        const held = stored.lock;
        if (held && held.owner !== opts.owner && lockIsLive(held, opts.now)) return null;
        const version = stored.version ?? 0;
        if (opts.expectVersion !== undefined && opts.expectVersion !== version) return null;
        b.record("store.fleet.updateFleet");
        b.fleetItem = structuredClone({ ...stored, ...named, version: version + 1 });
        return structuredClone(b.fleetItem);
      },
      /**
       * The whole-item replacement, and the two counters it has to agree with
       * before it is allowed to overwrite everything: the item's own `version`
       * and the `settings.version` a `putSettings` moves independently of it.
       */
      replaceFleet: async (
        item: FleetItem,
        owner: string,
        now: Date,
        expect: FleetExpectation,
      ): Promise<FleetItem | null> => {
        const stored = b.fleetItem;
        if (!stored) return null;
        const held = stored.lock;
        if (held && held.owner !== owner && lockIsLive(held, now)) return null;
        if ((stored.version ?? 0) !== expect.version) return null;
        if ((stored.settings?.version ?? null) !== expect.settingsVersion) return null;
        b.record("store.fleet.replaceFleet");
        b.fleetItem = structuredClone({ ...item, version: expect.version + 1 });
        return structuredClone(b.fleetItem);
      },
      /**
       * The same four conditions over the `lock` field alone: the stored item
       * keeps every other attribute it has — `version` included, because the
       * lock is not content (§4.4). A fleet that is not there cannot be locked,
       * which is the real store's `attribute_exists(#name)`.
       */
      lockFleet: async (owner: string, expires: string, now: Date): Promise<boolean> => {
        const stored = b.fleetItem;
        if (!stored) return false;
        const held = stored.lock;
        if (held && held.owner !== owner && lockIsLive(held, now)) return false;
        b.record("store.fleet.lockFleet");
        b.fleetItem = structuredClone({ ...stored, lock: { owner, expires } });
        return true;
      },
      /**
       * The renew, and the one condition that tells it apart from a take: the
       * stored lock is already ours and has not lapsed. A run that let its TTL
       * run out does not get it back by asking again (§4.4).
       */
      renewFleetLock: async (owner: string, expires: string, now: Date): Promise<boolean> => {
        const stored = b.fleetItem;
        if (!stored) return false;
        const held = stored.lock;
        if (!held || held.owner !== owner || !lockIsLive(held, now)) return false;
        b.record("store.fleet.renewFleetLock");
        b.fleetItem = structuredClone({ ...stored, lock: { owner, expires } });
        return true;
      },
      /** Ours to drop or nobody's business; either way, never an error. */
      unlockFleet: async (owner: string): Promise<void> => {
        const stored = b.fleetItem;
        if (!stored || stored.lock?.owner !== owner) return;
        b.record("store.fleet.unlockFleet");
        b.fleetItem = structuredClone({ ...stored, lock: null });
      },
      /**
       * The same two conditions the real store puts on a settings write: the
       * version the caller composed against is still the stored one, and no
       * live fleet lock — unless the lock is the caller's own, which is the
       * re-entry §8.3's profile writes need. Evaluated against `b.fleetItem`,
       * never against the caller's copy — that is the whole point of the method.
       */
      putSettings: async (
        settings: FleetSettings,
        expectedVersion: number | null,
        now: Date,
        owner?: string,
      ): Promise<boolean> => {
        const stored = b.fleetItem;
        if (!stored) return false;
        const current = stored.settings?.version ?? null;
        if (current !== expectedVersion) return false;
        const held = stored.lock;
        if (held && held.owner !== owner && lockIsLive(held, now)) return false;
        b.record("store.fleet.putSettings");
        b.fleetItem = structuredClone({
          ...stored,
          settings,
          defaults: settings.defaults,
        });
        return true;
      },
    },
    /**
     * §9.1's volume reservations, with the same three conditions the real store
     * evaluates — absent, expired, or already ours — decided against what is
     * stored rather than against the caller's copy of it. That is the whole
     * point of the method: two adoptions racing for one disk must not both
     * believe they took it.
     */
    volumeClaims: {
      get: async (volumeId: string): Promise<VolumeClaim | null> => {
        const held = b.claims.get(volumeId);
        return held ? structuredClone(held) : null;
      },
      list: async (): Promise<VolumeClaim[]> => structuredClone([...b.claims.values()]),
      claim: async (
        volumeId: string,
        owner: string,
        expires: string,
        now: Date,
      ): Promise<{ ok: boolean; holder: VolumeClaim }> => {
        const held = b.claims.get(volumeId);
        if (held && held.owner !== owner && lockIsLive(held, now)) {
          return { ok: false, holder: structuredClone(held) };
        }
        b.record("store.volumeClaims.claim");
        const claim: VolumeClaim = { volume_id: volumeId, owner, expires };
        b.claims.set(volumeId, claim);
        return { ok: true, holder: structuredClone(claim) };
      },
      /** Ours to drop or nobody's business; either way, never an error. */
      release: async (volumeId: string, owner: string): Promise<void> => {
        const held = b.claims.get(volumeId);
        if (held && held.owner !== owner) return;
        b.record("store.volumeClaims.release");
        b.claims.delete(volumeId);
      },
    },
  };
}
