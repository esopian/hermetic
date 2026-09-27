import { describe, expect, test } from "bun:test";
import { isValidName, validateName } from "../src/shared/naming.ts";
import { HermeticError } from "../src/errors.ts";

const INVALID: Array<[string, unknown]> = [
  ["empty", ""],
  ["leading hyphen", "-atlas"],
  ["leading underscore", "_atlas"],
  ["the reserved fleet key", "_fleet"],
  ["uppercase", "Atlas"],
  ["mixed case", "atLas"],
  ["underscore inside", "atlas_one"],
  ["a space", "atlas one"],
  ["leading space", " atlas"],
  ["trailing space", "atlas "],
  ["a dot", "atlas.one"],
  ["a slash", "atlas/one"],
  ["a colon", "atlas:one"],
  ["unicode", "atlás"],
  ["emoji", "atlas-🚀"],
  ["exactly 32 characters", "a".repeat(32)],
  ["longer than 32 characters", "a".repeat(40)],
  ["32 chars with hyphens", "a" + "-b".repeat(16)],
  ["a newline", "atlas\n"],
  ["a tab", "atlas\t"],
  ["only a hyphen", "-"],
  ["only an underscore", "_"],
  ["not a string: null", null],
  ["not a string: undefined", undefined],
  ["not a string: number", 42],
  ["not a string: object", { name: "atlas" }],
];

const VALID = [
  "a",
  "0",
  "atlas",
  "atlas-1",
  "research-1",
  "a-b-c-d",
  "corvid2",
  "9lives",
  "a".repeat(31),
  "a" + "-".repeat(30),
];

describe("validateName", () => {
  for (const [why, value] of INVALID) {
    test(`rejects ${why}`, () => {
      expect(() => validateName(value)).toThrow(HermeticError);
      try {
        validateName(value);
      } catch (e) {
        expect((e as HermeticError).code).toBe("NAME_INVALID");
      }
      expect(isValidName(value)).toBe(false);
    });
  }

  for (const name of VALID) {
    test(`accepts ${JSON.stringify(name)}`, () => {
      expect(validateName(name)).toBe(name);
      expect(isValidName(name)).toBe(true);
    });
  }

  test("31 characters is the longest allowed name", () => {
    expect(isValidName("a".repeat(31))).toBe(true);
    expect(isValidName("a".repeat(32))).toBe(false);
  });
});
