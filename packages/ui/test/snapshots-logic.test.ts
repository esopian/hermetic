import { describe, expect, test } from "bun:test";
import { formIssue, formOf, patchOf } from "../src/logic/snapshots-logic.ts";

const DEFAULT = { enabled: true, retain: 7, interval_hours: 24 } as const;

describe("patchOf", () => {
  test("nothing moved is no plan to ask for", () => {
    expect(patchOf(DEFAULT, formOf(DEFAULT))).toBeNull();
  });

  test("names only the fields that moved", () => {
    expect(patchOf(DEFAULT, { ...formOf(DEFAULT), enabled: false })).toEqual({ enabled: false });
    expect(patchOf(DEFAULT, { ...formOf(DEFAULT), retain: "3", interval_hours: 12 })).toEqual({
      retain: 3,
      interval_hours: 12,
    });
  });

  test("an invalid retention plans nothing and says why", () => {
    for (const retain of ["", "0", "1001", "2.5"]) {
      const form = { ...formOf(DEFAULT), retain };
      expect(patchOf(DEFAULT, form)).toBeNull();
      expect(formIssue(form)).not.toBeNull();
    }
  });
});
