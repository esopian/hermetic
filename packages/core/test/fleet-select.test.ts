import { describe, expect, test } from "bun:test";
import { matchFleet, resolveFleetId } from "../src/fleet/fleet-select.ts";
import { isHermeticError } from "../src/errors.ts";

/** The code a thrown `HermeticError` carries, or the string it threw instead. */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return isHermeticError(e) ? e.code : String(e);
  }
  return "(did not throw)";
}

/**
 * The two fleets every case below chooses between, with the display aliases
 * they answer to as well as the ids. The id is what a fleet *is* (§4.6); the
 * alias is a label over it, and both fixtures carry one so a test that means
 * "by alias" does not have to invent a home.
 */
const MAIN = { name: "main", fleet_id: "k7m2x9qa" };
const STAGING = { name: "staging", fleet_id: "b4n8t1zc" };
const BOTH = [MAIN, STAGING];

describe("resolveFleetId", () => {
  test("an explicit alias wins over everything else", () => {
    expect(
      resolveFleetId({
        explicit: "staging",
        env: "main",
        defaultFleet: "main",
        fleets: BOTH,
      }),
    ).toBe(STAGING.fleet_id);
  });

  test("HERMETIC_FLEET wins over the persisted default", () => {
    expect(resolveFleetId({ env: "staging", defaultFleet: "main", fleets: BOTH })).toBe(
      STAGING.fleet_id,
    );
  });

  test("the persisted default wins over 'the only one'", () => {
    expect(resolveFleetId({ defaultFleet: "staging", fleets: BOTH })).toBe(STAGING.fleet_id);
  });

  test("one frozen fleet needs no choosing", () => {
    expect(resolveFleetId({ fleets: [MAIN] })).toBe(MAIN.fleet_id);
  });

  /** §4.6: a fleet with no alias at all is still perfectly selectable — by its id. */
  test("an aliasless fleet resolves by id and is the sole-row fallback", () => {
    const unlabelled = { name: null, fleet_id: "q3w9e7r1" };
    expect(resolveFleetId({ fleets: [unlabelled] })).toBe("q3w9e7r1");
    expect(resolveFleetId({ explicit: "q3w9e7r1", fleets: [unlabelled, MAIN] })).toBe("q3w9e7r1");
  });

  /** Two aliasless fleets are two fleets, not one: the refusal names both ids. */
  test("two aliasless fleets and nothing chosen names each by id", () => {
    const a = { name: null, fleet_id: "q3w9e7r1" };
    const b = { name: null, fleet_id: "t5y8u2i6" };
    try {
      resolveFleetId({ fleets: [a, b] });
      throw new Error("expected a refusal");
    } catch (e) {
      expect(isHermeticError(e) && e.code).toBe("FLEET_REQUIRED");
      expect((e as Error).message).toContain("q3w9e7r1, t5y8u2i6");
    }
  });

  /** §4.6: hermetic refuses to run without a frozen row, whatever was asked for. */
  test("no frozen fleets is NOT_INITIALIZED", () => {
    expect(codeOf(() => resolveFleetId({ fleets: [] }))).toBe("NOT_INITIALIZED");
    expect(codeOf(() => resolveFleetId({ explicit: "main", fleets: [] }))).toBe("NOT_INITIALIZED");
  });

  test("a token that is not frozen here is NOT_FOUND, and says what is", () => {
    try {
      resolveFleetId({ explicit: "prod", fleets: BOTH });
      throw new Error("expected a refusal");
    } catch (e) {
      expect(isHermeticError(e) && e.code).toBe("NOT_FOUND");
      expect((e as Error).message).toContain("known: k7m2x9qa (main), b4n8t1zc (staging)");
      expect((e as Error).message).toContain("hermetic init --attach --fleet prod");
    }
  });

  test("two fleets and nothing chosen is FLEET_REQUIRED, and names them", () => {
    try {
      resolveFleetId({ fleets: BOTH });
      throw new Error("expected a refusal");
    } catch (e) {
      expect(isHermeticError(e) && e.code).toBe("FLEET_REQUIRED");
      expect((e as Error).message).toContain("k7m2x9qa (main), b4n8t1zc (staging)");
      expect((e as Error).message).toContain("hermetic fleet use");
    }
  });

  /**
   * A default left behind by `teardown --reset-local` names a fleet that is no
   * longer here. Falling through is the point: it is stale, not wrong.
   */
  test("a stale default falls through rather than refusing", () => {
    expect(resolveFleetId({ defaultFleet: "gone", fleets: [MAIN] })).toBe(MAIN.fleet_id);
    expect(codeOf(() => resolveFleetId({ defaultFleet: "gone", fleets: BOTH }))).toBe("FLEET_REQUIRED");
  });

  test("an empty explicit or env string is treated as nothing said", () => {
    expect(resolveFleetId({ explicit: "", env: "", fleets: [MAIN] })).toBe(MAIN.fleet_id);
  });

  /**
   * §4.6: a fleet answers to its display alias as well as to its id, and the
   * *id* is what comes back — every local table this home keeps is keyed on it.
   */
  describe("addressing a fleet by its id", () => {
    test("an explicit fleet id resolves to that fleet", () => {
      expect(resolveFleetId({ explicit: "b4n8t1zc", fleets: BOTH })).toBe(STAGING.fleet_id);
    });

    test("HERMETIC_FLEET may be an id too", () => {
      expect(resolveFleetId({ env: "k7m2x9qa", fleets: BOTH })).toBe(MAIN.fleet_id);
    });

    test("a persisted default recorded as an id still resolves", () => {
      expect(resolveFleetId({ defaultFleet: "b4n8t1zc", fleets: BOTH })).toBe(STAGING.fleet_id);
    });

    test("an id belonging to no frozen fleet is NOT_FOUND like any other token", () => {
      expect(codeOf(() => resolveFleetId({ explicit: "zzzzzzzz", fleets: BOTH }))).toBe("NOT_FOUND");
    });

    /**
     * The collision the precedence exists for. A fleet id is eight lowercase
     * base32 characters and a display alias may legally be the same eight, so a
     * home can hold a fleet *aliased* `k7m2x9qa` that is not fleet `k7m2x9qa`.
     * Identity wins: the token means the fleet whose id it is.
     */
    test("an id beats a different fleet that merely bears that alias", () => {
      const impostor = { name: "k7m2x9qa", fleet_id: "zzzzzzzz" };
      expect(resolveFleetId({ explicit: "k7m2x9qa", fleets: [impostor, MAIN] })).toBe(MAIN.fleet_id);
    });
  });

  /** The one rule both `resolveFleetId` and `fleets.use` address a fleet by. */
  describe("matchFleet", () => {
    test("finds by id, by alias, and not at all", () => {
      expect(matchFleet(BOTH, "k7m2x9qa")).toEqual(MAIN);
      expect(matchFleet(BOTH, "staging")).toEqual(STAGING);
      expect(matchFleet(BOTH, "prod")).toBeNull();
    });

    /** A null alias must never be matched by a caller passing an empty token. */
    test("an aliasless row is never matched by an empty token", () => {
      const unlabelled = [{ name: null, fleet_id: "q3w9e7r1" }];
      expect(matchFleet(unlabelled, "")).toBeNull();
    });
  });
});
