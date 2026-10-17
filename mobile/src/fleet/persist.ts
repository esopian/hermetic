/**
 * The device-backed persistence the fleet store and the inbox are handed:
 * SecureStore for the pairing (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`: never backed
 * up, never synced) and JSON files in the document directory for caches.
 *
 * The stores themselves take these as seams (`KvStorage`, `TextFile`), so
 * their tests run on Maps; this module is the only one that imports the native
 * modules.
 */
import { File, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";
import type { KvStorage, TextFile } from "./store.ts";

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
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

/** The fleet view cache and the inbox, by file name. */
export const FLEET_VIEW_FILE = "hermetic-fleet-view.json";
export const INBOX_FILE = "hermetic-inbox.json";
