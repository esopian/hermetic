/** Incoming system URLs: a `hermetic://fleet?…` pairing link opens the Pair screen with it. */
import { pairingRedirect } from "../src/fleet/pairing.ts";

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    return pairingRedirect(path);
  } catch {
    return path;
  }
}
