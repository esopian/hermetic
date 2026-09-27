import { describe, expect, test } from "bun:test";
import {
  ADJECTIVES,
  ANIMALS,
  COLORS,
  FIRST_WORDS,
  FLOWERS,
  INSECTS,
  SECOND_WORDS,
  STONES,
  randomAgentName,
} from "../src/logic/name-dictionary.ts";

/** §6.1's shape, the one the create drawer validates against. */
const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

const LISTS = {
  ADJECTIVES,
  COLORS,
  STONES,
  ANIMALS,
  FLOWERS,
  INSECTS,
} as const;

describe("name dictionary", () => {
  for (const [label, words] of Object.entries(LISTS)) {
    test(`${label}: at least 30 unique single lowercase words`, () => {
      expect(words.length).toBeGreaterThanOrEqual(30);
      expect(new Set(words).size).toBe(words.length);
      for (const w of words) expect(w).toMatch(/^[a-z]+$/);
    });
  }

  test("no word appears in two lists on the same side of the dash", () => {
    expect(new Set(FIRST_WORDS).size).toBe(FIRST_WORDS.length);
    expect(new Set(SECOND_WORDS).size).toBe(SECOND_WORDS.length);
  });

  test("every possible pairing is a valid agent name", () => {
    const longestFirst = [...FIRST_WORDS].sort((a, b) => b.length - a.length)[0]!;
    const longestSecond = [...SECOND_WORDS].sort((a, b) => b.length - a.length)[0]!;
    expect(`${longestFirst}-${longestSecond}`).toMatch(AGENT_NAME_RE);
  });
});

describe("randomAgentName", () => {
  test("generates valid <first>-<second> names", () => {
    for (let i = 0; i < 200; i++) {
      const name = randomAgentName();
      expect(name).toMatch(AGENT_NAME_RE);
      const [first, second, ...rest] = name.split("-");
      expect(rest).toEqual([]);
      expect(FIRST_WORDS).toContain(first!);
      expect(SECOND_WORDS).toContain(second!);
    }
  });

  test("avoids names already on the fleet", () => {
    const taken = new Set([`${FIRST_WORDS[0]}-${SECOND_WORDS[0]}`]);
    for (let i = 0; i < 100; i++) expect(taken.has(randomAgentName(taken))).toBe(false);
  });

  test("falls back to a numeric suffix when everything is taken", () => {
    const taken = new Set<string>();
    for (const a of FIRST_WORDS) for (const b of SECOND_WORDS) taken.add(`${a}-${b}`);
    const name = randomAgentName(taken);
    expect(name).toMatch(AGENT_NAME_RE);
    expect(name).toMatch(/-\d+$/);
    expect(taken.has(name)).toBe(false);
  });
});
