/**
 * The phones this box pushes to (§9.4): one small JSON document,
 * `/var/lib/hermeticd/push-devices.json`, mode 0600.
 *
 * It is hermeticd's one bounded write surface on port 7434, and every bound is
 * here rather than in the route: at most `PUSH_DEVICES_MAX` entries, each one a
 * `MobilePushDevice` (an Expo token shape, a short id, a listening list of at
 * most 64 bot names), so the file cannot grow past a few tens of kilobytes
 * whatever a caller sends. A registration over the cap evicts the
 * least-recently registered phone rather than refusing the new one: a stale
 * entry (a phone wiped without signing out) must not lock a real one out, and
 * the receipts path prunes dead tokens on its own.
 *
 * The document is `MobilePushDeviceList`, in registration order, oldest
 * first — the order *is* the eviction order, so no timestamp has to ride on a
 * `.strict()` schema that would refuse one.
 *
 * A push token is never logged from here or from anything that calls this.
 */
import { MobilePushDevice, type MobilePushDeviceList } from "@hermetic/core/schema";
import type { Host } from "../host.ts";
import { STATE_DIR } from "../fleet.ts";

export const PUSH_DEVICES_PATH = `${STATE_DIR}/push-devices.json`;
/** Phones one box remembers at once (§9.4). */
export const PUSH_DEVICES_MAX = 32;

export interface PushDeviceStore {
  /** Every registered phone, oldest registration first. */
  list(): Promise<MobilePushDevice[]>;
  /**
   * Insert or replace by `device_id`; the entry moves to the newest end. The
   * input is validated again here, so a caller cannot store an unchecked shape.
   * Returns the `device_id` evicted to stay under the cap, if any.
   */
  upsert(device: MobilePushDevice): Promise<{ evicted: string | null }>;
  /**
   * Remove one phone. With `token`, only if that is still the phone's token —
   * a receipt for an old token must not unregister a phone that has since
   * registered a new one. True when something was removed.
   */
  remove(deviceId: string, token?: string): Promise<boolean>;
}

/**
 * The store over `Host`, read once and then held in memory. Every write goes
 * to disk before it returns (atomically: `Host.writeFile` renames into place),
 * so a restart loses nothing a phone was told succeeded.
 */
export function pushDeviceStore(
  host: Host,
  log: (message: string) => void = () => {},
  path: string = PUSH_DEVICES_PATH,
): PushDeviceStore {
  let loaded: MobilePushDevice[] | null = null;
  /** Serialises writers, so two registrations cannot interleave a read-modify-write. */
  let queue: Promise<unknown> = Promise.resolve();

  async function load(): Promise<MobilePushDevice[]> {
    if (loaded !== null) return loaded;
    const text = await host.readFile(path).catch(() => null);
    loaded = text === null ? [] : parse(text, log);
    return loaded;
  }

  async function save(devices: MobilePushDevice[]): Promise<void> {
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

    upsert(input) {
      return serial(async () => {
        const device = MobilePushDevice.parse(input);
        const current = (await load()).filter((d) => d.device_id !== device.device_id);
        let evicted: string | null = null;
        while (current.length >= PUSH_DEVICES_MAX) {
          evicted = current.shift()?.device_id ?? null;
        }
        await save([...current, device]);
        return { evicted };
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
 * crash the daemon; entries that fail are dropped and counted.
 */
function parse(text: string, log: (message: string) => void): MobilePushDevice[] {
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
  const out: MobilePushDevice[] = [];
  let dropped = 0;
  for (const entry of raw) {
    const parsed = MobilePushDevice.safeParse(entry);
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
