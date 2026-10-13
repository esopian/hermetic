/**
 * The phones this box pushes to (§9.4): one small JSON document,
 * `/var/lib/hermeticd/push-devices.json`, mode 0600.
 *
 * It is hermeticd's one bounded write surface on port 7434, and every bound is
 * here rather than in the route: at most `PUSH_DEVICES_MAX` entries, each one a
 * `MobilePushDeviceRecord` (an Expo token shape, a short id, a listening list of
 * at most 64 bot names, the owner's login and a timestamp), so the file cannot
 * grow past a few tens of kilobytes whatever a caller sends. A registration
 * over the cap evicts the least-recently registered phone rather than refusing
 * the new one: a stale entry (a phone wiped without signing out) must not lock
 * a real one out, and the receipts path prunes dead tokens on its own.
 *
 * Two rules make it safe to let any tailnet member write here (§9.4's trust
 * model). A registration belongs to the login that made it (`owner`): another
 * login presenting the same `device_id` may neither replace nor delete it. And
 * it lapses `PUSH_DEVICE_TTL_MS` after its last renewal: the phone renews on
 * every foreground, so only a phone that has stopped — or a member who has been
 * removed from the tailnet and can no longer reach this port — stops being
 * renewed. A lapsed registration is never listed (the notifier skips it) and is
 * dropped from the file on the next load or write.
 *
 * The document is `MobilePushDeviceList`, in registration order, oldest first:
 * the order is the eviction order.
 *
 * A push token is never logged from here or from anything that calls this.
 */
import {
  MobilePushDevice,
  MobilePushDeviceRecord,
  type MobilePushDeviceList,
} from "@hermetic/core/schema";
import type { Host } from "../host.ts";
import { STATE_DIR } from "../fleet.ts";

export const PUSH_DEVICES_PATH = `${STATE_DIR}/push-devices.json`;
/** Phones one box remembers at once (§9.4). */
export const PUSH_DEVICES_MAX = 32;
/** How long a registration stands after its last renewal (`POST`): 30 days (§9.4). */
export const PUSH_DEVICE_TTL_MS = 30 * 24 * 60 * 60_000;

/** A write refused because the `device_id` belongs to another login. */
export interface PushDeviceForbidden {
  readonly ok: false;
  /** The login the registration belongs to, for the audit line only. */
  readonly owner: string;
}

export interface PushDeviceStore {
  /** Every live registration, oldest first; lapsed ones are never listed. */
  list(): Promise<MobilePushDeviceRecord[]>;
  /**
   * Insert or renew by `device_id`, owned by `owner`; the entry moves to the
   * newest end and its `renewed_at` becomes now. The input is validated again
   * here, so a caller cannot store an unchecked shape. Refused, and nothing
   * written, when a live registration with that id belongs to another login.
   * Returns the `device_id` evicted to stay under the cap, if any.
   */
  upsert(
    device: MobilePushDevice,
    owner: string,
  ): Promise<{ readonly ok: true; readonly evicted: string | null } | PushDeviceForbidden>;
  /**
   * The owner's own delete. `removed: false` when there is nothing live by that
   * id; refused when the registration belongs to another login.
   */
  unregister(
    deviceId: string,
    owner: string,
  ): Promise<{ readonly ok: true; readonly removed: boolean } | PushDeviceForbidden>;
  /**
   * The box's own delete (a `DeviceNotRegistered` receipt), with no owner. With
   * `token`, only if that is still the phone's token — a receipt for an old
   * token must not unregister a phone that has since registered a new one.
   * True when something was removed.
   */
  remove(deviceId: string, token?: string): Promise<boolean>;
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
        const existing = all.find((d) => d.device_id === device.device_id);
        if (existing !== undefined && existing.owner !== owner)
          return { ok: false as const, owner: existing.owner };
        const current = all.filter((d) => d.device_id !== device.device_id);
        let evicted: string | null = null;
        while (current.length >= PUSH_DEVICES_MAX) {
          evicted = current.shift()?.device_id ?? null;
        }
        await save([...current, device]);
        return { ok: true as const, evicted };
      });
    },

    unregister(deviceId, owner) {
      return serial(async () => {
        const current = await load();
        const existing = current.find((d) => d.device_id === deviceId);
        // Nothing live by that id: idempotent, a phone signing out twice is not an error.
        if (existing === undefined) return { ok: true as const, removed: false };
        if (existing.owner !== owner) return { ok: false as const, owner: existing.owner };
        await save(current.filter((d) => d.device_id !== deviceId));
        return { ok: true as const, removed: true };
      });
    },

    remove(deviceId, token) {
      return serial(async () => {
        const current = await load();
        const next = current.filter(
          (d) => !(d.device_id === deviceId && (token === undefined || d.token === token)),
        );
        if (next.length === current.length) return false;
        await save(next);
        return true;
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
    if (parsed.success && !out.some((d) => d.device_id === parsed.data.device_id))
      out.push(parsed.data);
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
