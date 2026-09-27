import { describe, expect, test } from "bun:test";
import { mintFleetId, isFleetId } from "../src/fleet/fleet-id.ts";
import { FLEET_ID_ALPHABET, FleetIdSchema } from "../src/schema/common.ts";

const N = 10_000;

describe("mintFleetId", () => {
  test("produces 8 characters, every one from the alphabet", () => {
    for (let i = 0; i < 100; i++) {
      const id = mintFleetId();
      expect(id).toHaveLength(8);
      for (const c of id) expect(FLEET_ID_ALPHABET).toContain(c);
      expect(isFleetId(id)).toBe(true);
    }
  });

  test("10k mints have no duplicates", () => {
    const seen = new Set<string>();
    for (let i = 0; i < N; i++) seen.add(mintFleetId());
    expect(seen.size).toBe(N);
  });

  /**
   * Smoke test for uniformity: with 10k mints of 8 characters each (80k draws)
   * over a 32-symbol alphabet, every symbol should appear at least once — a
   * biased generator (e.g. a naive `% 32` without rejection sampling) would
   * still likely pass this, but a badly broken one (e.g. only ever emitting a
   * handful of characters) would not.
   */
  test("every alphabet character appears across 10k mints", () => {
    const counts = new Map<string, number>();
    for (const c of FLEET_ID_ALPHABET) counts.set(c, 0);
    for (let i = 0; i < N; i++) {
      for (const c of mintFleetId()) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    for (const c of FLEET_ID_ALPHABET) {
      expect(counts.get(c)).toBeGreaterThan(0);
    }
  });

  test("draws are uniform-ish: no character claims more than 2x its fair share", () => {
    const counts = new Map<string, number>();
    for (const c of FLEET_ID_ALPHABET) counts.set(c, 0);
    for (let i = 0; i < N; i++) {
      for (const c of mintFleetId()) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    const total = N * 8;
    const fairShare = total / FLEET_ID_ALPHABET.length;
    for (const c of FLEET_ID_ALPHABET) {
      expect(counts.get(c)!).toBeLessThan(fairShare * 2);
    }
  });

  test("a custom random source is used deterministically", () => {
    // Bytes chosen below the rejection threshold so every draw is accepted
    // on the first try: index 0 -> '0', index 1 -> '1', ... repeating.
    let call = 0;
    const fixed = <T extends ArrayBufferView>(array: T): T => {
      (array as unknown as Uint8Array)[0] = call++ % 10;
      return array;
    };
    const id = mintFleetId(fixed);
    expect(id).toBe("01234567");
  });
});

describe("isFleetId", () => {
  test("accepts a well-formed id", () => {
    expect(isFleetId("k7m2x9qa")).toBe(true);
  });

  test("rejects a UUID", () => {
    expect(isFleetId("8f14e45f-ceea-4e73-9a1b-2f6f4e1c0001")).toBe(false);
  });

  test("rejects uppercase", () => {
    expect(isFleetId("K7M2X9QA")).toBe(false);
  });

  for (const bad of ["i", "l", "o", "u"]) {
    test(`rejects the excluded letter ${bad}`, () => {
      expect(isFleetId(`${bad}xxxxxxx`)).toBe(false);
    });
  }

  test("rejects 7 characters", () => {
    expect(isFleetId("k7m2x9q")).toBe(false);
  });

  test("rejects 9 characters", () => {
    expect(isFleetId("k7m2x9qaa")).toBe(false);
  });
});

describe("FleetIdSchema", () => {
  test("rejects a UUID with a clear message", () => {
    const result = FleetIdSchema.safeParse("8f14e45f-ceea-4e73-9a1b-2f6f4e1c0001");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]!.message).toContain("Crockford base32");
    }
  });

  test("accepts an id minted by mintFleetId", () => {
    expect(FleetIdSchema.safeParse(mintFleetId()).success).toBe(true);
  });
});
