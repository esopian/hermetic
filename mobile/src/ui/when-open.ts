import { AppState } from "react-native";

/**
 * `read()`, tried again each time the app comes to the front while it fails:
 * iOS keeps the keychain shut during a background launch on a locked phone,
 * and a default read then must not stand in for the stored value.
 */
export function readWhenOpen<T>(read: () => Promise<T>): Promise<T> {
  return read().catch(
    () =>
      new Promise<T>((resolve) => {
        const sub = AppState.addEventListener("change", (state) => {
          if (state !== "active") return;
          sub.remove();
          resolve(readWhenOpen(read));
        });
      }),
  );
}
