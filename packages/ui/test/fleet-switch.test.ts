/**
 * The fleet switcher's pure rules: order, switchability, badge, the "other
 * fleets need an update" roster, and the confirm line. Every branch gets its
 * own fixture rather than one shared object mutated per test, so a failure
 * names exactly which rule broke.
 */
import { describe, expect, test } from "bun:test";
import {
  confirmSwitchText,
  defaultable,
  fleetBadge,
  fleetLabel,
  type FleetListEntry,
  otherFleetsNeedingUpdate,
  sortFleets,
  switchability,
} from "../src/nav/fleet-switch.ts";

function fleet(overrides: Partial<FleetListEntry> = {}): FleetListEntry {
  return {
    name: "main",
    fleet_id: "fl-1",
    account_id: "123456789012",
    region: "us-east-1",
    local: true,
    registered: true,
    default: false,
    current: false,
    status: "active",
    foundation_version: 4,
    update_available: false,
    updated_at: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

describe("sortFleets", () => {
  test("current fleet is always first", () => {
    const a = fleet({ name: "aaa" });
    const current = fleet({ name: "zzz", current: true });
    expect(sortFleets([a, current]).map((f) => f.name)).toEqual(["zzz", "aaa"]);
  });

  test("the default fleet comes after current but before plain fleets", () => {
    const plain = fleet({ name: "bbb" });
    const def = fleet({ name: "aaa", default: true });
    const current = fleet({ name: "zzz", current: true });
    expect(sortFleets([plain, def, current]).map((f) => f.name)).toEqual(["zzz", "aaa", "bbb"]);
  });

  test("torn_down fleets sort last, even a torn_down default", () => {
    const gone = fleet({ name: "aaa", status: "torn_down" });
    const goneDefault = fleet({ name: "bbb", default: true, status: "torn_down" });
    const live = fleet({ name: "ccc" });
    expect(sortFleets([gone, goneDefault, live]).map((f) => f.name)).toEqual(["ccc", "aaa", "bbb"]);
  });

  test("otherwise, alphabetical by name", () => {
    const b = fleet({ name: "bravo" });
    const a = fleet({ name: "alpha" });
    const c = fleet({ name: "charlie" });
    expect(sortFleets([b, a, c]).map((f) => f.name)).toEqual(["alpha", "bravo", "charlie"]);
  });

  test("does not mutate its input", () => {
    const input = [fleet({ name: "b" }), fleet({ name: "a" })];
    const copy = [...input];
    sortFleets(input);
    expect(input).toEqual(copy);
  });
});

describe("switchability", () => {
  test("the current fleet cannot be switched to, and says why", () => {
    expect(switchability(fleet({ current: true }))).toEqual({
      can: false,
      reason: "current fleet",
    });
  });

  /** §4.6: attach takes the `fleet_id`, never the display alias. */
  test("a fleet not frozen in this home names the attach command, by id", () => {
    expect(switchability(fleet({ name: "staging", fleet_id: "sg7k2m4p", local: false }))).toEqual({
      can: false,
      reason: "not frozen here — run `hermetic init --attach --fleet sg7k2m4p`",
    });
  });

  test("a torn_down fleet cannot be switched to", () => {
    expect(switchability(fleet({ status: "torn_down" }))).toEqual({
      can: false,
      reason: "torn down",
    });
  });

  test("a local, non-current, non-torn-down fleet can be switched to", () => {
    expect(switchability(fleet())).toEqual({ can: true, reason: null });
  });

  test("current is checked before local, so a current fleet never reads as unattached", () => {
    expect(switchability(fleet({ current: true, local: false }))).toEqual({
      can: false,
      reason: "current fleet",
    });
  });
});

describe("fleetBadge", () => {
  test("torn_down wins over every other flag", () => {
    expect(
      fleetBadge(fleet({ status: "torn_down", update_available: true, registered: false })),
    ).toEqual({ kind: "muted", label: "torn down" });
  });

  test("tearing_down is a warning", () => {
    expect(fleetBadge(fleet({ status: "tearing_down" }))).toEqual({
      kind: "warn",
      label: "tearing down",
    });
  });

  test("tearing_down wins over an unregistered fleet", () => {
    expect(fleetBadge(fleet({ status: "tearing_down", registered: false }))).toEqual({
      kind: "warn",
      label: "tearing down",
    });
  });

  test("an available update is a warning", () => {
    expect(fleetBadge(fleet({ update_available: true }))).toEqual({
      kind: "warn",
      label: "update available",
    });
  });

  test("update_available wins over unregistered", () => {
    expect(fleetBadge(fleet({ update_available: true, registered: false }))).toEqual({
      kind: "warn",
      label: "update available",
    });
  });

  test("an unregistered fleet is muted", () => {
    expect(fleetBadge(fleet({ registered: false }))).toEqual({
      kind: "muted",
      label: "unregistered",
    });
  });

  test("otherwise, the plain foundation version", () => {
    expect(fleetBadge(fleet({ foundation_version: 7 }))).toEqual({ kind: "ok", label: "v7" });
  });

  test("a null foundation version reads as an em dash, not `vnull`", () => {
    expect(fleetBadge(fleet({ foundation_version: null }))).toEqual({ kind: "ok", label: "—" });
  });
});

describe("otherFleetsNeedingUpdate", () => {
  test("names active, non-current fleets with an update available, sorted", () => {
    const fleets = [
      fleet({ name: "zulu", update_available: true, status: "active" }),
      fleet({ name: "alpha", update_available: true, status: "active" }),
      fleet({ name: "bravo", update_available: false, status: "active" }),
    ];
    expect(otherFleetsNeedingUpdate(fleets)).toEqual(["alpha", "zulu"]);
  });

  test("excludes the current fleet even if it needs an update", () => {
    const fleets = [fleet({ name: "main", current: true, update_available: true })];
    expect(otherFleetsNeedingUpdate(fleets)).toEqual([]);
  });

  test("excludes a fleet that is tearing down or torn down", () => {
    const fleets = [
      fleet({ name: "tearing", status: "tearing_down", update_available: true }),
      fleet({ name: "gone", status: "torn_down", update_available: true }),
    ];
    expect(otherFleetsNeedingUpdate(fleets)).toEqual([]);
  });

  test("no fleets need an update", () => {
    expect(otherFleetsNeedingUpdate([fleet(), fleet({ name: "b" })])).toEqual([]);
  });
});

describe("confirmSwitchText", () => {
  test("names both fleets and the region when there is a current fleet", () => {
    expect(confirmSwitchText("main", fleet({ name: "staging", region: "us-west-2" }))).toBe(
      "Switch from main to staging (us-west-2)?",
    );
  });

  test("omits the region parenthetical when the target has none", () => {
    expect(confirmSwitchText("main", fleet({ name: "staging", region: null }))).toBe(
      "Switch from main to staging?",
    );
  });

  test("drops the `from` clause when there is no current fleet", () => {
    expect(confirmSwitchText(null, fleet({ name: "staging", region: "us-west-2" }))).toBe(
      "Switch to staging (us-west-2)?",
    );
  });

  test("no current fleet and no region", () => {
    expect(confirmSwitchText(null, fleet({ name: "staging", region: null }))).toBe(
      "Switch to staging?",
    );
  });
});

describe("defaultable", () => {
  test("a plain local fleet that is not already the default", () => {
    expect(defaultable(fleet({ name: "staging" }))).toBe(true);
  });

  test("the fleet that is already the default has nothing to offer", () => {
    expect(defaultable(fleet({ default: true }))).toBe(false);
  });

  test("a fleet known to the directory but not frozen here — `fleets.use` refuses it", () => {
    expect(defaultable(fleet({ local: false, registered: true }))).toBe(false);
  });

  test("a torn-down fleet is history, not a thing a bare command could mean", () => {
    expect(defaultable(fleet({ status: "torn_down" }))).toBe(false);
  });

  test("the current fleet is still defaultable — being open and being the default differ", () => {
    expect(defaultable(fleet({ current: true }))).toBe(true);
  });
});

/**
 * §4.6: a fleet may have no display alias at all, and two of them may be
 * aliasless at once. Everything the switcher renders or keys on therefore falls
 * back to the `fleet_id` — never to blank, and never to a shared empty string.
 */
describe("the display fallback", () => {
  test("a fleet with no alias shows as its id", () => {
    expect(fleetLabel(fleet({ name: null, fleet_id: "q3w9e7r1" }))).toBe("q3w9e7r1");
  });

  test("an alias, when there is one, is what shows", () => {
    expect(fleetLabel(fleet({ name: "prod", fleet_id: "q3w9e7r1" }))).toBe("prod");
  });

  test("two aliasless fleets sort and label distinctly", () => {
    const rows = [
      fleet({ name: null, fleet_id: "t5y8u2i6" }),
      fleet({ name: null, fleet_id: "q3w9e7r1" }),
    ];
    expect(sortFleets(rows).map(fleetLabel)).toEqual(["q3w9e7r1", "t5y8u2i6"]);
  });

  test("the update-needed line names an aliasless fleet by its id", () => {
    const rows = [
      fleet({
        name: null,
        fleet_id: "q3w9e7r1",
        current: false,
        update_available: true,
        status: "active",
      }),
    ];
    expect(otherFleetsNeedingUpdate(rows)).toEqual(["q3w9e7r1"]);
  });
});

/** A refusal outranks everything: a row that cannot be switched to says why. */
describe("switchability · a fleet frozen elsewhere", () => {
  test("names the attach command by fleet id, and stays disabled", () => {
    const f = fleet({ name: "sandbox", fleet_id: "sbx09qq1", local: false });
    expect(switchability(f).can).toBe(false);
    expect(switchability(f).reason).toContain("hermetic init --attach --fleet sbx09qq1");
  });
});
