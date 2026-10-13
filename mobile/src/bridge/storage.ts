/**
 * Persistence on the phone. The device token lives only in the keychain
 * (SecureStore, `WHEN_UNLOCKED_THIS_DEVICE_ONLY`: never backed up, never
 * synced); small preferences use the same store under their own keys.
 */
import * as SecureStore from "expo-secure-store";
import type { Credentials } from "../client/client.ts";
import type { RosterPrefs, RosterPrefsStorage } from "../client/roster-store.ts";

/** A string key-value store. SecureStore in the app; a Map in tests. */
export interface PrefStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/** SecureStore keys allow only `[A-Za-z0-9._-]`. */
const safeKey = (key: string): string => key.replace(/[^A-Za-z0-9._-]/g, "_");

export const secureStorage: PrefStorage = {
  get: (key) => SecureStore.getItemAsync(safeKey(key), OPTIONS),
  set: (key, value) => SecureStore.setItemAsync(safeKey(key), value, OPTIONS),
  remove: (key) => SecureStore.deleteItemAsync(safeKey(key), OPTIONS),
};

export function memoryStorage(seed: Record<string, string> = {}): PrefStorage {
  const map = new Map(Object.entries(seed));
  return {
    get: async (key) => map.get(key) ?? null,
    set: async (key, value) => {
      map.set(key, value);
    },
    remove: async (key) => {
      map.delete(key);
    },
  };
}

const CREDENTIALS_KEY = "hermetic.credentials.v1";

export async function loadCredentials(
  storage: PrefStorage = secureStorage,
): Promise<Credentials | null> {
  const raw = await storage.get(CREDENTIALS_KEY).catch(() => null);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Credentials>;
    if (
      typeof value.baseUrl !== "string" ||
      typeof value.token !== "string" ||
      typeof value.device_id !== "string" ||
      !value.fleet
    )
      return null;
    return value as Credentials;
  } catch {
    return null;
  }
}

export async function saveCredentials(
  credentials: Credentials,
  storage: PrefStorage = secureStorage,
): Promise<void> {
  await storage.set(CREDENTIALS_KEY, JSON.stringify(credentials));
}

export async function clearCredentials(storage: PrefStorage = secureStorage): Promise<void> {
  await storage.remove(CREDENTIALS_KEY);
}

export function rosterPrefsStorage(storage: PrefStorage = secureStorage): RosterPrefsStorage {
  return {
    async load(fleetId) {
      const raw = await storage.get(`hermetic.rail.${fleetId}`).catch(() => null);
      if (!raw) return null;
      try {
        const v = JSON.parse(raw) as Partial<RosterPrefs>;
        return {
          pinned: Array.isArray(v.pinned)
            ? v.pinned.filter((x): x is string => typeof x === "string")
            : [],
          folded: Array.isArray(v.folded)
            ? v.folded.filter((x): x is string => typeof x === "string")
            : [],
        };
      } catch {
        return null;
      }
    },
    save: (fleetId, prefs) => storage.set(`hermetic.rail.${fleetId}`, JSON.stringify(prefs)),
  };
}
