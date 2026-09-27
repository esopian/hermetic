import { FLEET_ID_ALPHABET, FleetIdSchema, type FleetId } from "../schema/common.ts";

const FLEET_ID_LENGTH = 8;
/**
 * Rejection-sampling threshold: the largest multiple of the alphabet size that
 * fits in a byte. Bytes at or above this are discarded so every kept byte maps
 * to an alphabet index with exactly equal probability — a plain `% 32` would
 * bias the low indices (256 is not a multiple of 32... it is, actually, but we
 * keep the general rejection-sampling shape so this stays correct if the
 * alphabet size ever changes to something that doesn't divide 256 evenly).
 */
const ALPHABET_SIZE = FLEET_ID_ALPHABET.length;
const REJECTION_THRESHOLD = 256 - (256 % ALPHABET_SIZE);

/**
 * Mints an 8-character Crockford base32 fleet id (§4.2's `fleet_id`). Uses
 * rejection sampling over `random` (defaulting to the Web Crypto RNG hermetic
 * already depends on elsewhere) so every character is drawn uniformly from
 * `FLEET_ID_ALPHABET` — a naive modulo would bias the low end of the alphabet.
 */
export function mintFleetId(
  random: <T extends ArrayBufferView>(array: T) => T = crypto.getRandomValues.bind(crypto),
): FleetId {
  const chars: string[] = [];
  const buf = new Uint8Array(1);
  while (chars.length < FLEET_ID_LENGTH) {
    random(buf);
    const byte = buf[0]!;
    if (byte >= REJECTION_THRESHOLD) continue;
    chars.push(FLEET_ID_ALPHABET[byte % ALPHABET_SIZE]!);
  }
  return chars.join("") as FleetId;
}

/**
 * Mints a provider profile id (§8.3). The same 8 characters of the same
 * alphabet a fleet id uses, drawn the same way — a profile id is typed by hand
 * into `providers update` and read aloud exactly as often.
 *
 * It is deliberately the same function rather than a second one that looks like
 * it: two minting routines is two places for the alphabet to drift.
 */
export function mintProfileId(
  random: <T extends ArrayBufferView>(array: T) => T = crypto.getRandomValues.bind(crypto),
): string {
  return mintFleetId(random);
}

/** Type guard / validator for a fleet id string, backed by `FleetIdSchema`. */
export function isFleetId(s: string): s is FleetId {
  return FleetIdSchema.safeParse(s).success;
}
