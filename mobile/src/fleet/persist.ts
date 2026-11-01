/**
 * The device-backed persistence the fleet store and the inbox are handed:
 * SecureStore for the pairing (`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`: never
 * backed up, never synced) and JSON files in the document directory for caches.
 *
 * The stores themselves take these as seams (`KvStorage`, `TextFile`), so
 * their tests run on Maps; this module is the only one that imports the native
 * modules.
 */
import { File, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";
import type { KvStorage, TextFile } from "./store.ts";

/**
 * Readable after the first unlock since boot: iOS launches the app in the
 * background (refresh task, push) while the phone is locked, and a
 * `WHEN_UNLOCKED` item cannot be read then. SecureStore's update keeps an
 * item's old class, so only items first written since then have this one.
 */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

/** SecureStore keys allow only `[A-Za-z0-9._-]`. */
const safeKey = (key: string): string => key.replace(/[^A-Za-z0-9._-]/g, "_");

export const secureKv: KvStorage = {
  get: (key) => SecureStore.getItemAsync(safeKey(key), OPTIONS),
  set: (key, value) => SecureStore.setItemAsync(safeKey(key), value, OPTIONS),
  remove: (key) => SecureStore.deleteItemAsync(safeKey(key), OPTIONS),
};

/** A JSON file in the app's document directory. */
export function documentFile(name: string): TextFile {
  const file = () => new File(Paths.document, name);
  return {
    read: async () => {
      const f = file();
      return f.exists ? await f.text() : null;
    },
    write: async (text) => {
      const f = file();
      if (!f.exists) f.create({ intermediates: true });
      f.write(text);
    },
    remove: async () => {
      const f = file();
      if (f.exists) f.delete();
    },
  };
}

/** One fleet's view cache, inbox and last roster (`none` before any pairing), under `prefix`. */
export function fleetFiles(prefix = ""): (fleetId: string | null) => {
  viewCache: TextFile;
  inboxFile: TextFile;
  rosterFile: TextFile;
} {
  return (fleetId) => ({
    viewCache: documentFile(`${prefix}hermetic-fleet-view.${fleetId ?? "none"}.json`),
    inboxFile: documentFile(`${prefix}hermetic-inbox.${fleetId ?? "none"}.json`),
    rosterFile: documentFile(`${prefix}hermetic-roster.${fleetId ?? "none"}.json`),
  });
}
