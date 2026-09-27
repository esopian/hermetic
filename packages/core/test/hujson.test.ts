import { describe, expect, test } from "bun:test";
import {
  HERMETIC_BLOCK_BEGIN,
  HERMETIC_BLOCK_END,
  applyManagedBlocks,
  locateManagedBlocks,
  parseHujson,
  readManagedBlocks,
  removeManagedBlocks,
  topLevelMembers,
  type ManagedBlock,
} from "../src/fleet/hujson.ts";
import { HermeticError } from "../src/errors.ts";

/**
 * A policy file in the shape operators actually keep in git: prose comments,
 * aligned values, a block comment, trailing commas on some members and not
 * others, and a last member (`nodeAttrs`) with no trailing comma at all.
 */
const POLICY = `// Tailscale policy for acme.example.ts.net.
// Reviewed by the platform team; the comments are load-bearing.
{
  // Groups first, because everything below refers to them.
  "groups": {
    "group:ops": ["alice@example.com", "bob@example.com"],
    "group:eng": ["carol@example.com"],
  },

  /* Tags are owned by groups, never by individual users. */
  "tagOwners": {
    "tag:prod":  ["group:ops"],
    "tag:build": ["group:eng"], // build boxes are disposable
  },

  "acls": [
    {
      // Everyone in eng can reach the prod jumphost.
      "action": "accept",
      "src":    ["group:eng"],
      "dst":    ["tag:prod:22"],
    },
  ],

  "grants": [
    { "src": ["autogroup:member"], "dst": ["tag:build"], "ip": ["*"] },
  ],

  "ssh": [
    {
      "action": "check",
      "src":    ["autogroup:member"],
      "dst":    ["autogroup:self"],
      "users":  ["autogroup:nonroot", "root"],
    },
  ],

  // No node attributes yet.
  "nodeAttrs": []
}
`;

const TABBED = POLICY.replace(/^( +)/gm, (m) => "\t".repeat(m.length / 2));
const CRLF = POLICY.replace(/\n/g, "\r\n");

const TAG_OWNERS: ManagedBlock = {
  key: "tagOwners",
  container: "object",
  body: `"tag:hermetic": ["autogroup:admin"],`,
};

const GRANTS: ManagedBlock = {
  key: "grants",
  container: "array",
  body: [
    `{`,
    `  "src": ["autogroup:member"],`,
    `  "dst": ["tag:hermetic"],`,
    `  "ip":  ["443"],`,
    `},`,
  ].join("\n"),
};

/** Everything except the marker-fenced regions — what must survive untouched. */
function outsideBlocks(text: string): string[] {
  const kept: string[] = [];
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === HERMETIC_BLOCK_BEGIN) {
      inside = true;
      continue;
    }
    if (trimmed === HERMETIC_BLOCK_END) {
      inside = false;
      continue;
    }
    if (!inside) kept.push(line);
  }
  return kept;
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof HermeticError ? e.code : `not-a-HermeticError: ${String(e)}`;
  }
  return "no-throw";
}

function message(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return "no-throw";
}

describe("parseHujson", () => {
  test("plain JSON still parses to the same value", () => {
    const json = `{"a":1,"b":[true,false,null],"c":{"d":"e"}}`;
    expect(parseHujson(json)).toEqual(JSON.parse(json));
  });

  test("line and block comments are dropped", () => {
    const text = `{
      // a leading note
      "a": 1, /* between */ "b": 2, // trailing
      /* multi
         line */
      "c": 3
    }`;
    expect(parseHujson(text)).toEqual({ a: 1, b: 2, c: 3 });
  });

  test("a comment marker inside a string is just text", () => {
    expect(parseHujson(`{"note": "// not a comment /* nor this */"}`)).toEqual({
      note: "// not a comment /* nor this */",
    });
  });

  test("trailing commas in objects and arrays", () => {
    expect(parseHujson(`{"a": [1, 2, 3,], "b": {"c": 1,},}`)).toEqual({ a: [1, 2, 3], b: { c: 1 } });
  });

  test("numbers, booleans and null", () => {
    expect(parseHujson(`[0, -1, 1.5, -2.25e3, 1E+2, true, false, null]`)).toEqual([
      0,
      -1,
      1.5,
      -2250,
      100,
      true,
      false,
      null,
    ]);
  });

  test("string escapes decode", () => {
    expect(parseHujson(String.raw`{"s": "a\"b\\c\/d\n\tA"}`)).toEqual({ s: 'a"b\\c/d\n\tA' });
  });

  test("nesting", () => {
    expect(parseHujson(`{"a": [{"b": [{"c": [1]}]}]}`)).toEqual({ a: [{ b: [{ c: [1] }] }] });
  });

  test("the realistic policy parses", () => {
    const value = parseHujson(POLICY) as Record<string, unknown>;
    expect(Object.keys(value)).toEqual(["groups", "tagOwners", "acls", "grants", "ssh", "nodeAttrs"]);
    expect(value["nodeAttrs"]).toEqual([]);
  });

  test("tabs and CRLF parse to the same value", () => {
    expect(parseHujson(TABBED)).toEqual(parseHujson(POLICY));
    expect(parseHujson(CRLF)).toEqual(parseHujson(POLICY));
  });

  describe("refusals name line:column", () => {
    test("a missing value", () => {
      expect(message(() => parseHujson(`{\n  "a": }\n`))).toContain("2:8");
      expect(code(() => parseHujson(`{\n  "a": }\n`))).toBe("VALIDATION");
    });

    test("an unexpected character", () => {
      expect(message(() => parseHujson(`{\n  "a": @\n}`))).toBe(`unexpected character "@" at 2:8`);
    });

    test("an unterminated string", () => {
      expect(message(() => parseHujson(`{\n  "a": "oops\n}`))).toBe("unterminated string at 2:8");
    });

    test("an unterminated block comment", () => {
      expect(message(() => parseHujson(`{\n  /* forever\n`))).toBe("unterminated block comment at 2:3");
    });

    test("a missing key", () => {
      expect(message(() => parseHujson(`{ 1: 2 }`))).toBe(`expected an object key, found "1" at 1:3`);
    });

    test("trailing content after the document", () => {
      expect(message(() => parseHujson(`{} {}`))).toBe(`unexpected "{" after the document at 1:4`);
    });

    test("empty input", () => {
      expect(message(() => parseHujson("   \n"))).toBe("unexpected end of input at 2:1");
    });

    test("an unterminated array", () => {
      expect(code(() => parseHujson(`{"a": [1, 2`))).toBe("VALIDATION");
    });

    test("a bad escape", () => {
      expect(message(() => parseHujson(String.raw`{"a": "\q"}`))).toBe(`invalid escape "\\q" at 1:8`);
      expect(message(() => parseHujson(String.raw`{"a": "\u12"}`))).toBe("invalid \\u escape at 1:8");
    });
  });
});

describe("readManagedBlocks", () => {
  test("no blocks is an empty record", () => {
    expect(readManagedBlocks(POLICY)).toEqual({});
  });

  test("bodies come back dedented", () => {
    const { text } = applyManagedBlocks(POLICY, [TAG_OWNERS, GRANTS]);
    expect(readManagedBlocks(text)).toEqual({
      tagOwners: TAG_OWNERS.body,
      grants: GRANTS.body,
    });
  });

  test("an empty block reads as an empty string", () => {
    const { text } = applyManagedBlocks(POLICY, [{ key: "grants", container: "array", body: "" }]);
    expect(readManagedBlocks(text)).toEqual({ grants: "" });
  });

  test("a string that looks like a marker is not one", () => {
    const text = `{
  "grants": [
    { "note": "${HERMETIC_BLOCK_BEGIN}" },
  ],
}
`;
    expect(readManagedBlocks(text)).toEqual({});
  });

  test("markers survive tabs and CRLF", () => {
    for (const source of [TABBED, CRLF]) {
      const { text } = applyManagedBlocks(source, [GRANTS]);
      expect(readManagedBlocks(text)).toEqual({ grants: GRANTS.body });
    }
  });
});

describe("applyManagedBlocks", () => {
  test("inserts at the end of a non-empty container", () => {
    const { text, changed } = applyManagedBlocks(POLICY, [GRANTS]);
    expect(changed).toBe(true);
    expect(text).toContain(`    ${HERMETIC_BLOCK_BEGIN}\n    {\n      "src": ["autogroup:member"],`);
    // The operator's own grant is still the first element, still verbatim.
    expect(text).toContain(
      `    { "src": ["autogroup:member"], "dst": ["tag:build"], "ip": ["*"] },\n    ${HERMETIC_BLOCK_BEGIN}`,
    );
    expect(parseHujson(text)).toBeDefined();
  });

  test("inserts into an object container at the container's own indent", () => {
    const { text } = applyManagedBlocks(POLICY, [TAG_OWNERS]);
    expect(text).toContain(
      [
        `    "tag:build": ["group:eng"], // build boxes are disposable`,
        `    ${HERMETIC_BLOCK_BEGIN}`,
        `    "tag:hermetic": ["autogroup:admin"],`,
        `    ${HERMETIC_BLOCK_END}`,
        `  },`,
      ].join("\n"),
    );
  });

  test("everything outside the block is byte-identical", () => {
    const { text } = applyManagedBlocks(POLICY, [TAG_OWNERS, GRANTS]);
    expect(outsideBlocks(text)).toEqual(POLICY.split("\n"));
  });

  test("a repeat call changes nothing", () => {
    const first = applyManagedBlocks(POLICY, [TAG_OWNERS, GRANTS]);
    const second = applyManagedBlocks(first.text, [TAG_OWNERS, GRANTS]);
    expect(second.changed).toBe(false);
    expect(second.text).toBe(first.text);
  });

  test("a caller's indentation is normalised away", () => {
    const sloppy: ManagedBlock = {
      key: "grants",
      container: "array",
      body: `\n        {\n          "dst": ["tag:hermetic"],\n        },\n\n`,
    };
    const tidy: ManagedBlock = {
      key: "grants",
      container: "array",
      body: `{\n  "dst": ["tag:hermetic"],\n},`,
    };
    expect(applyManagedBlocks(POLICY, [sloppy]).text).toBe(applyManagedBlocks(POLICY, [tidy]).text);
  });

  test("upserts an existing block without moving its markers", () => {
    const first = applyManagedBlocks(POLICY, [TAG_OWNERS]).text;
    const updated: ManagedBlock = {
      ...TAG_OWNERS,
      body: `"tag:hermetic": ["autogroup:admin"],\n"tag:hermetic-build": ["group:ops"],`,
    };
    const { text, changed } = applyManagedBlocks(first, [updated]);
    expect(changed).toBe(true);
    expect(readManagedBlocks(text)).toEqual({ tagOwners: updated.body });
    // Outside the fence the two versions are the same file.
    expect(outsideBlocks(text)).toEqual(outsideBlocks(first));
  });

  test("shrinking a block back to empty leaves the markers", () => {
    const filled = applyManagedBlocks(POLICY, [GRANTS]).text;
    const { text } = applyManagedBlocks(filled, [{ key: "grants", container: "array", body: "" }]);
    expect(text).toContain(`    ${HERMETIC_BLOCK_BEGIN}\n    ${HERMETIC_BLOCK_END}`);
    expect(readManagedBlocks(text)).toEqual({ grants: "" });
  });

  test("adds the trailing comma a previous last entry lacked", () => {
    const source = `{
  "grants": [
    { "dst": ["tag:prod"] } // no comma here
  ]
}
`;
    const { text } = applyManagedBlocks(source, [GRANTS]);
    expect(text).toContain(`    { "dst": ["tag:prod"] }, // no comma here`);
    expect(parseHujson(text)).toBeDefined();
  });

  test("opens up an empty array container", () => {
    const source = `{
  "acls": [],
}
`;
    const { text } = applyManagedBlocks(source, [
      { key: "acls", container: "array", body: `{ "action": "accept" },` },
    ]);
    expect(text).toBe(`{
  "acls": [
    ${HERMETIC_BLOCK_BEGIN}
    { "action": "accept" },
    ${HERMETIC_BLOCK_END}
  ],
}
`);
  });

  test("opens up an empty object container", () => {
    const source = `{
  "tagOwners": {}
}
`;
    const { text } = applyManagedBlocks(source, [TAG_OWNERS]);
    expect(text).toBe(`{
  "tagOwners": {
    ${HERMETIC_BLOCK_BEGIN}
    "tag:hermetic": ["autogroup:admin"],
    ${HERMETIC_BLOCK_END}
  }
}
`);
  });

  test("creates a missing top-level key at the end of the root", () => {
    const { text } = applyManagedBlocks(POLICY, [
      { key: "ssh", container: "array", body: `{ "action": "accept" },` },
      { key: "autoApprovers", container: "object", body: `"exitNode": ["tag:hermetic"],` },
    ]);
    // The previously-last member gains the comma the new member needs.
    expect(text).toContain(`  "nodeAttrs": [],\n  "autoApprovers": {`);
    expect(text.trimEnd().endsWith("}")).toBe(true);
    expect(text).toContain(
      [
        `  "autoApprovers": {`,
        `    ${HERMETIC_BLOCK_BEGIN}`,
        `    "exitNode": ["tag:hermetic"],`,
        `    ${HERMETIC_BLOCK_END}`,
        `  },`,
        `}`,
      ].join("\n"),
    );
    expect(parseHujson(text)).toBeDefined();
  });

  test("creates a key in a root that is a bare pair of braces", () => {
    const { text } = applyManagedBlocks(`{}\n`, [TAG_OWNERS]);
    expect(text).toBe(`{
  "tagOwners": {
    ${HERMETIC_BLOCK_BEGIN}
    "tag:hermetic": ["autogroup:admin"],
    ${HERMETIC_BLOCK_END}
  },
}
`);
    expect(parseHujson(text)).toEqual({ tagOwners: { "tag:hermetic": ["autogroup:admin"] } });
  });

  test("several blocks in one call", () => {
    const { text, changed } = applyManagedBlocks(POLICY, [
      TAG_OWNERS,
      GRANTS,
      { key: "autoApprovers", container: "object", body: `"exitNode": ["tag:hermetic"],` },
    ]);
    expect(changed).toBe(true);
    expect(Object.keys(readManagedBlocks(text)).sort()).toEqual([
      "autoApprovers",
      "grants",
      "tagOwners",
    ]);
    expect(applyManagedBlocks(text, [TAG_OWNERS, GRANTS]).changed).toBe(false);
  });

  test("tabs stay tabs; the caller's own inner indent is left alone", () => {
    const { text } = applyManagedBlocks(TABBED, [GRANTS]);
    // The markers and each body line are shifted to the container's tab indent;
    // the two spaces the caller used inside its entry are the caller's business.
    expect(text).toContain(`\t\t${HERMETIC_BLOCK_BEGIN}\n\t\t{\n\t\t  "src": ["autogroup:member"],`);
    expect(text).toContain(`\t\t${HERMETIC_BLOCK_END}\n\t],`);
    expect(text).not.toContain("  //");
  });

  test("CRLF stays CRLF", () => {
    const { text } = applyManagedBlocks(CRLF, [GRANTS]);
    expect(text).not.toMatch(/[^\r]\n/);
    expect(text).toContain(`\r\n    ${HERMETIC_BLOCK_BEGIN}\r\n`);
    expect(applyManagedBlocks(text, [GRANTS]).changed).toBe(false);
  });

  test("refuses a root that is not an object", () => {
    expect(code(() => applyManagedBlocks(`[1, 2]`, [GRANTS]))).toBe("VALIDATION");
    expect(message(() => readManagedBlocks(`"just a string"`))).toContain("root must be a JSON object");
  });

  test("refuses a container of the wrong kind", () => {
    expect(message(() => applyManagedBlocks(POLICY, [{ ...GRANTS, container: "object" }]))).toContain(
      `"grants" is a JSON array, not a object`,
    );
    expect(message(() => applyManagedBlocks(`{"grants": "nope"}`, [GRANTS]))).toContain(
      `"grants" is a JSON scalar, not a array`,
    );
  });
});

describe("removeManagedBlocks", () => {
  test("apply then remove is byte-identical when the container was non-empty", () => {
    for (const source of [POLICY, TABBED, CRLF]) {
      const applied = applyManagedBlocks(source, [TAG_OWNERS, GRANTS]).text;
      const removed = removeManagedBlocks(applied, ["tagOwners", "grants"]);
      expect(removed.changed).toBe(true);
      expect(removed.text).toBe(source);
    }
  });

  test("removing keys that were never managed changes nothing", () => {
    const removed = removeManagedBlocks(POLICY, ["grants", "tagOwners", "autoApprovers"]);
    expect(removed.changed).toBe(false);
    expect(removed.text).toBe(POLICY);
  });

  test("the container survives when the operator still has entries in it", () => {
    const applied = applyManagedBlocks(POLICY, [GRANTS]).text;
    const { text } = removeManagedBlocks(applied, ["grants"]);
    expect(text).toContain(`  "grants": [`);
    expect(readManagedBlocks(text)).toEqual({});
  });

  test("a container left with nothing in it goes, key and all", () => {
    const applied = applyManagedBlocks(POLICY, [
      { key: "nodeAttrs", container: "array", body: `{ "target": ["tag:hermetic"] },` },
    ]).text;
    expect(applied).toContain(`"nodeAttrs": [`);
    const { text } = removeManagedBlocks(applied, ["nodeAttrs"]);
    expect(text).not.toContain("nodeAttrs");
    // The operator's comment sat outside the container, so it is not ours to take.
    expect(text).toBe(POLICY.replace(`  "nodeAttrs": []\n`, ""));
  });

  test("a container the operator left a comment in survives", () => {
    const source = `{
  "grants": [
    // hermetic's block goes here
  ],
}
`;
    const applied = applyManagedBlocks(source, [GRANTS]).text;
    const { text } = removeManagedBlocks(applied, ["grants"]);
    expect(text).toBe(source);
  });

  test("a created key is removed again", () => {
    const applied = applyManagedBlocks(POLICY, [
      { key: "autoApprovers", container: "object", body: `"exitNode": ["tag:hermetic"],` },
    ]).text;
    const { text } = removeManagedBlocks(applied, ["autoApprovers"]);
    // Only deviation 1 remains: `"nodeAttrs": []` picked up a trailing comma.
    expect(text).toBe(POLICY.replace(`  "nodeAttrs": []\n`, `  "nodeAttrs": [],\n`));
  });

  test("removing one block leaves the other alone", () => {
    const applied = applyManagedBlocks(POLICY, [TAG_OWNERS, GRANTS]).text;
    const { text } = removeManagedBlocks(applied, ["grants"]);
    expect(Object.keys(readManagedBlocks(text))).toEqual(["tagOwners"]);
    expect(text).toBe(applyManagedBlocks(POLICY, [TAG_OWNERS]).text);
  });
});

describe("malformed blocks are refusals, not repairs", () => {
  const cases: Record<string, string> = {
    "a begin with no end": `{
  "grants": [
    ${HERMETIC_BLOCK_BEGIN}
  ],
}
`,
    "an end with no begin": `{
  "grants": [
    ${HERMETIC_BLOCK_END}
  ],
}
`,
    "a begin inside a begin": `{
  "grants": [
    ${HERMETIC_BLOCK_BEGIN}
    ${HERMETIC_BLOCK_BEGIN}
    ${HERMETIC_BLOCK_END}
  ],
}
`,
    "a block two levels down": `{
  "acls": [
    {
      "dst": [
        ${HERMETIC_BLOCK_BEGIN}
        "tag:hermetic:443",
        ${HERMETIC_BLOCK_END}
      ],
    },
  ],
}
`,
    "a block straddling the root": `{
  ${HERMETIC_BLOCK_BEGIN}
  "grants": [],
  ${HERMETIC_BLOCK_END}
}
`,
    "markers in different containers": `{
  "grants": [
    ${HERMETIC_BLOCK_BEGIN}
  ],
  "acls": [
    ${HERMETIC_BLOCK_END}
  ],
}
`,
    "two blocks under one key": `{
  "grants": [
    ${HERMETIC_BLOCK_BEGIN}
    ${HERMETIC_BLOCK_END}
    ${HERMETIC_BLOCK_BEGIN}
    ${HERMETIC_BLOCK_END}
  ],
}
`,
    "a marker cutting an entry in half": `{
  "acls": [
    {
      ${HERMETIC_BLOCK_BEGIN}
      "action": "accept",
      ${HERMETIC_BLOCK_END}
    },
  ],
}
`,
  };

  for (const [name, text] of Object.entries(cases)) {
    test(name, () => {
      expect(code(() => readManagedBlocks(text))).toBe("VALIDATION");
      expect(code(() => applyManagedBlocks(text, [GRANTS]))).toBe("VALIDATION");
      expect(code(() => removeManagedBlocks(text, ["grants"]))).toBe("VALIDATION");
    });
  }

  test("a refusal points at the marker", () => {
    expect(message(() => readManagedBlocks(cases["a begin with no end"]!))).toBe(
      "hermetic:managed begin without an end at 3:5",
    );
  });
});

/**
 * Property-ish: twenty small policies with randomly placed comments and randomly
 * present trailing commas. Apply then remove must give the file back, up to the
 * one documented deviation — a trailing comma before a closing bracket.
 */
describe("apply then remove is the identity, up to trailing commas", () => {
  function mulberry(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const KEYS = ["groups", "tagOwners", "acls", "grants", "ssh", "nodeAttrs", "autoApprovers"];

  function generate(rand: () => number): { text: string; keys: string[] } {
    const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
    const keys = [...KEYS].sort(() => rand() - 0.5).slice(0, 2 + Math.floor(rand() * 3));
    const lines: string[] = [];
    if (rand() < 0.4) lines.push("// a policy with a header comment");
    lines.push("{");
    keys.forEach((key, i) => {
      const isArray = rand() < 0.5;
      if (rand() < 0.4) lines.push(`  // notes about ${key}`);
      lines.push(`  "${key}": ${isArray ? "[" : "{"}`);
      const count = 1 + Math.floor(rand() * 3);
      for (let n = 0; n < count; n += 1) {
        if (rand() < 0.35) lines.push(`    // why entry ${n} exists`);
        const entry = isArray ? `{ "dst": ["tag:${key}${n}"] }` : `"tag:${key}${n}": ["group:ops"]`;
        // The last entry's comma is a coin flip: that is the deviation under test.
        const comma = n === count - 1 ? (rand() < 0.5 ? "," : "") : ",";
        lines.push(`    ${entry}${comma}`);
      }
      const closer = isArray ? "]" : "}";
      lines.push(`  ${closer}${i === keys.length - 1 && rand() < 0.5 ? "" : ","}`);
      if (rand() < 0.2) lines.push("");
    });
    lines.push("}");
    return { text: lines.join(pick(["\n", "\r\n"])) + "\n", keys };
  }

  /** A trailing comma before a closer is legal either way; ignore it when comparing. */
  function normalise(text: string): string {
    return text.replace(/,(\s*[}\]])/g, "$1").replace(/\r\n/g, "\n");
  }

  for (let seed = 1; seed <= 20; seed += 1) {
    test(`seed ${seed}`, () => {
      const rand = mulberry(seed);
      const { text, keys } = generate(rand);
      expect(parseHujson(text)).toBeDefined();

      const managed = keys.slice(0, 1 + Math.floor(rand() * keys.length));
      const blocks: ManagedBlock[] = managed.map((key) => ({
        key,
        container: Array.isArray((parseHujson(text) as Record<string, unknown>)[key])
          ? "array"
          : "object",
        body: Array.isArray((parseHujson(text) as Record<string, unknown>)[key])
          ? `{ "dst": ["tag:hermetic"] },`
          : `"tag:hermetic": ["autogroup:admin"],`,
      }));

      const applied = applyManagedBlocks(text, blocks);
      expect(applied.changed).toBe(true);
      expect(parseHujson(applied.text)).toBeDefined();
      expect(applyManagedBlocks(applied.text, blocks).changed).toBe(false);
      expect(Object.keys(readManagedBlocks(applied.text)).sort()).toEqual([...managed].sort());

      const removed = removeManagedBlocks(applied.text, managed);
      expect(normalise(removed.text)).toBe(normalise(text));
    });
  }
});

/**
 * A byte-order mark is something an editor puts there, not something hermetic
 * may quietly take away: this module's whole claim is that every byte it does
 * not own comes back the way it went in.
 */
describe("a leading BOM", () => {
  const BOM = "﻿";
  const DOC = `${BOM}{\n  "acls": [\n    { "action": "accept" },\n  ],\n}\n`;
  const BLOCK: ManagedBlock = {
    key: "acls",
    container: "array",
    body: `{ "dst": ["tag:hermetic:22"] },`,
  };

  test("parses rather than refusing", () => {
    expect(parseHujson(DOC)).toEqual({ acls: [{ action: "accept" }] });
  });

  test("survives an apply → remove round trip", () => {
    const applied = applyManagedBlocks(DOC, [BLOCK]);
    expect(applied.changed).toBe(true);
    expect(applied.text.startsWith(BOM)).toBe(true);
    expect(readManagedBlocks(applied.text)["acls"]).toContain("tag:hermetic:22");
    expect(removeManagedBlocks(applied.text, ["acls"]).text).toBe(DOC);
  });

  /** Only the first byte is a mark; anywhere else it is a character nobody typed. */
  test("is not skipped in the middle of a document", () => {
    expect(() => parseHujson(`{${BOM}}`)).toThrow(HermeticError);
  });
});

/**
 * Tailscale resolves a repeated top-level key last-wins, and a splice goes into
 * the first one — so a write into a duplicated key is a write nothing reads,
 * and `readManagedBlocks` would then report a block that reaches no node.
 * Refusing is the only answer that does not involve guessing which container
 * the operator meant.
 */
describe("a duplicated top-level key", () => {
  const DUPE = `{\n  "acls": [\n    { "action": "accept" },\n  ],\n  "ssh": [],\n  "acls": [\n    { "action": "check" },\n  ],\n}\n`;
  const BLOCK: ManagedBlock = { key: "acls", container: "array", body: `{ "a": 1 },` };

  function codeOf(fn: () => unknown): string {
    try {
      fn();
      return "no-throw";
    } catch (e) {
      return e instanceof HermeticError ? `${e.code}: ${e.message}` : `not-hermetic: ${String(e)}`;
    }
  }

  test("is refused by apply, by name", () => {
    expect(codeOf(() => applyManagedBlocks(DUPE, [BLOCK]))).toBe(
      'VALIDATION: top-level key "acls" appears twice; fix the policy file first',
    );
  });

  test("is refused by remove", () => {
    expect(codeOf(() => removeManagedBlocks(DUPE, ["acls"]))).toContain("appears twice");
  });

  /** And a block that already landed in one of them is refused on read, too. */
  test("is refused on read once a block is in it", () => {
    const withBlock = `{\n  "acls": [\n    ${HERMETIC_BLOCK_BEGIN}\n    { "a": 1 },\n    ${HERMETIC_BLOCK_END}\n  ],\n  "acls": [],\n}\n`;
    expect(codeOf(() => readManagedBlocks(withBlock))).toContain("appears twice");
  });

  /** A key hermetic has no opinion about is the operator's problem, not ours. */
  test("an unrelated duplicate is left alone", () => {
    const other = `{\n  "ssh": [],\n  "acls": [],\n  "ssh": [],\n}\n`;
    expect(applyManagedBlocks(other, [BLOCK]).changed).toBe(true);
  });
});

/** The structural queries `policy.ts` reports and diffs from. */
describe("topLevelMembers and locateManagedBlocks", () => {
  const OWNED = `{\n  "tagOwners": {\n    "tag:prod": ["group:ops"],\n    ${HERMETIC_BLOCK_BEGIN}\n    "tag:hermetic": ["autogroup:admin"],\n    ${HERMETIC_BLOCK_END}\n  },\n}\n`;

  test("says which members are hermetic's", () => {
    expect(topLevelMembers(OWNED, "tagOwners")).toEqual([
      { key: "tag:prod", start: expect.any(Number), end: expect.any(Number), inManagedBlock: false },
      {
        key: "tag:hermetic",
        start: expect.any(Number),
        end: expect.any(Number),
        inManagedBlock: true,
      },
    ]);
  });

  test("an absent key, or one that is not an object, has no members", () => {
    expect(topLevelMembers(OWNED, "acls")).toEqual([]);
    expect(topLevelMembers(`{\n  "acls": [],\n}\n`, "acls")).toEqual([]);
  });

  test("the located range is exactly the markers and what is between them", () => {
    const [range] = locateManagedBlocks(OWNED);
    expect(range!.key).toBe("tagOwners");
    const text = OWNED.slice(range!.start, range!.end);
    expect(text.trimStart().startsWith(HERMETIC_BLOCK_BEGIN)).toBe(true);
    expect(text.endsWith(HERMETIC_BLOCK_END)).toBe(true);
    expect(text).toContain("tag:hermetic");
    expect(text).not.toContain("tag:prod");
  });
});
