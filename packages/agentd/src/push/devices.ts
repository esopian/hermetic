/**
 * The phones this box pushes to (§9.4): one small JSON document,
 * `/var/lib/hermeticd/push-devices.json`, mode 0600.
 *
 * It is hermeticd's one bounded write surface on port 7434, and every bound is
 * here rather than in the route: at most `PUSH_DEVICES_MAX` entries, each one a
 * `MobilePushDeviceRecord` (an Expo token shape, a short id, a listening list of
 * at most 64 bot names, the owner's login and a timestamp), so the file cannot
 * grow past a few tens of kilobytes whatever a caller sends.
 *
 * A record is keyed by `(owner, device_id)`: the login that registered it and
 * the id the phone chose. Two logins presenting the same `device_id` hold two
 * records, so nobody can squat another member's id to lock their phone out,
 * and nobody can touch a record that is not theirs. Each owner may hold
 * `PUSH_DEVICES_PER_OWNER` records; a fifth phone evicts that owner's least
 * recently renewed one, never anybody else's. When the file is full of other
 * owners' live records the registration is refused (`full`) rather than
 * evicting a stranger: a stale entry lapses on its own (`PUSH_DEVICE_TTL_MS`),
 * and a member flooding the file can only ever fill their own four slots.
 *
 * A registration lapses `PUSH_DEVICE_TTL_MS` after its last renewal: the phone
 * renews on every foreground, so only a phone that has stopped stops being
 * renewed. The watcher also drops records whose owner has left the tailnet
 * (`pruneOwners`). A lapsed registration is never listed (the notifier skips
 * it) and is dropped from the file on the next load or write.
 *
 * The document is `MobilePushDeviceList`, in registration order, oldest first:
 * the order is the eviction order within an owner.
 *
 * A push token is never logged from here or from anything that calls this, and
 * a device id only as `deviceTag(id)`.
 */
import {
  MobilePushDevice,
  MobilePushDeviceRecord,
  type MobilePushDeviceList,
} from "@hermetic/core/schema";
import { sha256Hex } from "@hermetic/core/shared";
import type { Host } from "../host.ts";
import { STATE_DIR } from "../fleet.ts";

export const PUSH_DEVICES_PATH = `${STATE_DIR}/push-devices.json`;
/** Phones one box remembers at once (§9.4). */
export const PUSH_DEVICES_MAX = 32;
/** Phones one owner may register with one box; a fifth evicts their oldest. */
export const PUSH_DEVICES_PER_OWNER = 4;
/** How long a registration stands after its last renewal (`POST`): 72 hours (§9.4). */
export const PUSH_DEVICE_TTL_MS = 72 * 60 * 60_000;

/**
 * How a device id appears in a log line: the first twelve hex digits of its
 * sha256. Enough to follow one phone through the journal, nothing a reader of
 * the journal could replay as that phone's id.
 */
export function deviceTag(deviceId: string): string {
  return sha256Hex(deviceId).slice(0, 12);
}

/** A delete refused because the `device_id` is registered only by other logins. */
export interface PushDeviceForbidden {
  readonly ok: false;
  readonly reason: "forbidden";
  /** The login the registration belongs to, for the audit line only. */
  readonly owner: string;
}

/** A registration refused because other owners' live records fill the file. */
export interface PushDevicesFull {
  readonly ok: false;
  readonly reason: "full";
}

/** One stored record's key. */
export interface PushDeviceKey {
  readonly owner: string;
  readonly device_id: string;
}

export interface PushDeviceStore {
  /** Every live registration, oldest first; lapsed ones are never listed. */
  list(): Promise<MobilePushDeviceRecord[]>;
  /**
   * Insert or renew `(owner, device_id)`; the entry moves to the newest end and
   * its `renewed_at` becomes now. The input is validated again here, so a
   * caller cannot store an unchecked shape. A new record past the owner's
   * `PUSH_DEVICES_PER_OWNER` evicts that owner's oldest (`evicted`, its
   * `device_id`); a new record that would pass `PUSH_DEVICES_MAX` when the
   * owner has nothing to evict is refused (`full`) and nothing is written.
   */
  upsert(
    device: MobilePushDevice,
    owner: string,
  ): Promise<{ readonly ok: true; readonly evicted: string | null } | PushDevicesFull>;
  /**
   * The owner's own delete of `(owner, deviceId)`. `removed: false` when no
   * live record anywhere carries that id; refused when only other logins'
   * records carry it.
   */
  unregister(
    deviceId: string,
    owner: string,
  ): Promise<{ readonly ok: true; readonly removed: boolean } | PushDeviceForbidden>;
  /**
   * The box's own delete (a `DeviceNotRegistered` receipt) of one record. With
   * `token`, only if that is still the phone's token — a receipt for an old
   * token must not unregister a phone that has since registered a new one.
   * True when something was removed.
   */
  remove(key: PushDeviceKey, token?: string): Promise<boolean>;
  /**
   * Drop every record whose owner `keep` rejects (an owner who has left the
   * tailnet). Returns how many were dropped; writes only when that is > 0.
   */
  pruneOwners(keep: (owner: string) => boolean): Promise<number>;
}

function sameKey(d: PushDeviceKey, key: PushDeviceKey): boolean {
  return d.owner === key.owner && d.device_id === key.device_id;
}

/**
 * The store over `Host`, read once and then held in memory. Every write goes
 * to disk before it returns (atomically: `Host.writeFile` renames into place),
 * so a restart loses nothing a phone was told succeeded. Expiry reads
 * `host.now()`.
 */
export function pushDeviceStore(
  host: Host,
  log: (message: string) => void = () => {},
  path: string = PUSH_DEVICES_PATH,
): PushDeviceStore {
  let loaded: MobilePushDeviceRecord[] | null = null;
  /** Serialises writers, so two registrations cannot interleave a read-modify-write. */
  let queue: Promise<unknown> = Promise.resolve();

  /** The registrations still inside their TTL, logging how many lapsed. */
  function live(devices: MobilePushDeviceRecord[]): MobilePushDeviceRecord[] {
    const now = host.now().getTime();
    const kept = devices.filter((d) => now - Date.parse(d.renewed_at) < PUSH_DEVICE_TTL_MS);
    const lapsed = devices.length - kept.length;
    if (lapsed > 0)
      log(`push devices: ${lapsed} registration${lapsed === 1 ? "" : "s"} lapsed unrenewed`);
    return kept;
  }

  async function load(): Promise<MobilePushDeviceRecord[]> {
    if (loaded === null) {
      const text = await host.readFile(path).catch(() => null);
      loaded = text === null ? [] : parse(text, log);
    }
    // Lapsed entries leave memory here and the file on the next write.
    loaded = live(loaded);
    return loaded;
  }

  async function save(devices: MobilePushDeviceRecord[]): Promise<void> {
    await host.mkdir(STATE_DIR, "0755");
    const doc: MobilePushDeviceList = { devices };
    await host.writeFile(path, JSON.stringify(doc) + "\n", "0600");
    loaded = devices;
  }

  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  }

  return {
    async list() {
      return [...(await load())];
    },

    upsert(input, owner) {
      return serial(async () => {
        const device = MobilePushDeviceRecord.parse({
          ...MobilePushDevice.parse(input),
          owner,
          renewed_at: host.now().toISOString(),
        });
        const all = await load();
        const current = all.filter((d) => !sameKey(d, device));
        let evicted: string | null = null;
        // Within the owner first: their fifth phone displaces their oldest.
        if (current.filter((d) => d.owner === owner).length >= PUSH_DEVICES_PER_OWNER) {
          const oldest = current.findIndex((d) => d.owner === owner);
          evicted = current[oldest]?.device_id ?? null;
          current.splice(oldest, 1);
        }
        // Never across owners: a full file of other people's phones refuses.
        if (current.length >= PUSH_DEVICES_MAX) return { ok: false as const, reason: "full" as const };
        await save([...current, device]);
        return { ok: true as const, evicted };
      });
    },

    unregister(deviceId, owner) {
      return serial(async () => {
        const current = await load();
        const key = { owner, device_id: deviceId };
        if (current.some((d) => sameKey(d, key))) {
          await save(current.filter((d) => !sameKey(d, key)));
          return { ok: true as const, removed: true };
        }
        const other = current.find((d) => d.device_id === deviceId);
        if (other !== undefined)
          return { ok: false as const, reason: "forbidden" as const, owner: other.owner };
        // Nothing live by that id: idempotent, a phone signing out twice is not an error.
        return { ok: true as const, removed: false };
      });
    },

    remove(key, token) {
      return serial(async () => {
        const current = await load();
        const next = current.filter(
          (d) => !(sameKey(d, key) && (token === undefined || d.token === token)),
        );
        if (next.length === current.length) return false;
        await save(next);
        return true;
      });
    },

    pruneOwners(keep) {
      return serial(async () => {
        const current = await load();
        const next = current.filter((d) => keep(d.owner));
        const dropped = current.length - next.length;
        if (dropped > 0) await save(next);
        return dropped;
      });
    },
  };
}

/**
 * The file as written, or as much of it as still validates. A corrupt file is
 * not a reason to stop pushing to the phones it does name, and not a reason to
 * crash the daemon; entries that fail are dropped and counted. An entry with no
 * `owner` or `renewed_at` fails too: a registration nobody owns could be taken
 * over by anyone, so it is dropped and the phone re-registers on its next
 * foreground.
 */
function parse(text: string, log: (message: string) => void): MobilePushDeviceRecord[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    log(`${PUSH_DEVICES_PATH} is not valid JSON; starting with no push devices`);
    return [];
  }
  const raw = (json as { devices?: unknown } | null)?.devices;
  if (!Array.isArray(raw)) {
    log(`${PUSH_DEVICES_PATH} has no device list; starting with no push devices`);
    return [];
  }
  const out: MobilePushDeviceRecord[] = [];
  let dropped = 0;
  for (const entry of raw) {
    const parsed = MobilePushDeviceRecord.safeParse(entry);
    if (parsed.success && !out.some((d) => sameKey(d, parsed.data))) out.push(parsed.data);
    else dropped += 1;
  }
  if (dropped > 0)
    log(
      `${PUSH_DEVICES_PATH}: dropped ${dropped} entr${dropped === 1 ? "y" : "ies"} that did not validate`,
    );
  return out.slice(-PUSH_DEVICES_MAX);
}

/** Whether `device` wants pushes for `bot`. */
export function listensTo(device: MobilePushDevice, bot: string): boolean {
  return device.listening === "all" || device.listening.includes(bot);
}
