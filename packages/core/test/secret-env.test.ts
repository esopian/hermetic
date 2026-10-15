/**
 * `shared/secret-env.ts` (plan §06b): the text-secret parser. The rows the
 * Python reader must also pass live in `tests/fixtures/secret-env/cases.json`
 * (`tests/secret-env-seam.test.ts`); this file holds what JSON cannot carry —
 * raw bytes, the size cap, chips, line numbers, message hygiene, the canonical
 * form's strictness — and the judgement calls the module documents.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HermeticError } from "../src/errors.ts";
import {
  SECRET_ENV_ERROR_CODES,
  SECRET_ENV_WARNING_CODES,
  SECRET_KEY_RE,
  SECRET_TEXT_MAX_BYTES,
  canonicalSecretEnv,
  detectSecretFormat,
  parseSecretEnv,
  readCanonicalSecretEnv,
} from "../src/shared/index.ts";
import type {
  SecretEnvEntry,
  SecretEnvIssue,
  SecretEnvResult,
  SecretEnvSpec,
  SecretInputMode,
} from "../src/shared/index.ts";

const ONE: SecretEnvSpec = { keys: ["API_TOKEN"] };
const TWO: SecretEnvSpec = { keys: ["A_KEY", "B_KEY"] };
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function codes(issues: readonly SecretEnvIssue[]): string[] {
  return issues.map((i) => i.code);
}
function errorsOf(r: SecretEnvResult): SecretEnvIssue[] {
  return r.ok ? [] : r.errors;
}
function messages(r: SecretEnvResult): string[] {
  return [...errorsOf(r), ...r.warnings].map((i) => i.message);
}

describe("secret-env · constants", () => {
  test("key pattern and cap", () => {
    expect(SECRET_TEXT_MAX_BYTES).toBe(65536);
    expect(SECRET_KEY_RE.test("API_TOKEN")).toBe(true);
    expect(SECRET_KEY_RE.test("_X1")).toBe(true);
    expect(SECRET_KEY_RE.test("api_token")).toBe(false);
    expect(SECRET_KEY_RE.test("1KEY")).toBe(false);
    expect(SECRET_KEY_RE.test("K".repeat(64))).toBe(true);
    expect(SECRET_KEY_RE.test("K".repeat(65))).toBe(false);
  });
  test("error and warning codes are disjoint", () => {
    const errs = new Set<string>(SECRET_ENV_ERROR_CODES);
    for (const w of SECRET_ENV_WARNING_CODES) expect(errs.has(w)).toBe(false);
  });
});

describe("secret-env · detectSecretFormat", () => {
  test.each([
    ["FIXTURE-token", "raw"],
    ["API_TOKEN=FIXTURE", "dotenv"],
    ["export API_TOKEN=FIXTURE", "dotenv"],
    ["  API_TOKEN = FIXTURE", "dotenv"],
    ["# only a comment\n", "raw"],
    ["", "raw"],
    ["A_KEY=FIXTURE\nnot an assignment", "raw"],
    ['A_KEY="FIXTURE\nstill the value\n=also the value"\nB_KEY=FIXTURE', "dotenv"],
    ["A_KEY='FIXTURE'\r\nB_KEY=FIXTURE\r\n", "dotenv"],
    ["﻿A_KEY=FIXTURE", "dotenv"],
    ["RklYVFVSRQ==", "raw"],
    ["dGVzdDE=", "raw"],
    ["api_token=FIXTURE", "raw"],
    ["# creds\napi_token=FIXTURE", "dotenv"],
    ["-----BEGIN PRIVATE KEY-----\nFIXTURE==\n-----END PRIVATE KEY-----", "raw"],
  ])("%j → %s", (text, want) => {
    expect(detectSecretFormat(text)).toBe(want as "raw" | "dotenv");
  });
});

describe("secret-env · input decoding", () => {
  test("bytes decode like the same string", () => {
    const text = "﻿API_TOKEN=FIXTURE-ü-token\r\n";
    const a = parseSecretEnv(text, ONE);
    const b = parseSecretEnv(enc(text), ONE);
    expect(b).toEqual(a);
    expect(b.ok && b.entries[0]?.value).toBe("FIXTURE-ü-token");
  });

  test("invalid UTF-8 bytes", () => {
    const r = parseSecretEnv(new Uint8Array([0x46, 0x49, 0xff, 0x58]), ONE);
    expect(r.ok).toBe(false);
    expect(r.format).toBeNull();
    expect(codes(errorsOf(r))).toEqual(["INVALID_UTF8"]);
    expect(r.bytes).toBe(4);
    expect(r.chips).toEqual([{ key: "API_TOKEN", state: "missing" }]);
  });

  test("a truncated multi-byte sequence is invalid", () => {
    expect(codes(errorsOf(parseSecretEnv(new Uint8Array([0x41, 0xc3]), ONE)))).toEqual([
      "INVALID_UTF8",
    ]);
  });

  test("a string with a lone surrogate is invalid", () => {
    expect(codes(errorsOf(parseSecretEnv("FIXTURE\uD800x", ONE)))).toEqual(["INVALID_UTF8"]);
    expect(parseSecretEnv("FIXTURE-\u{1F511}", ONE).ok).toBe(true);
  });

  test("a BOM-only byte stream is empty input", () => {
    expect(codes(errorsOf(parseSecretEnv(new Uint8Array([0xef, 0xbb, 0xbf]), ONE)))).toEqual([
      "EMPTY_INPUT",
    ]);
  });

  test("NUL as a byte", () => {
    const r = parseSecretEnv(new Uint8Array([0x46, 0x00, 0x58, 0x0a]), ONE);
    expect(codes(errorsOf(r))).toEqual(["CONTROL_CHARACTER"]);
    expect(errorsOf(r)[0]).toMatchObject({ key: "API_TOKEN", line: 1 });
  });
});

describe("secret-env · size cap", () => {
  const filler = (n: number) => "F".repeat(n);

  test("exactly 64 KiB passes, one byte more is TOO_LARGE", () => {
    expect(parseSecretEnv(filler(SECRET_TEXT_MAX_BYTES), ONE).ok).toBe(true);
    const r = parseSecretEnv(filler(SECRET_TEXT_MAX_BYTES + 1), ONE);
    expect(codes(errorsOf(r))).toEqual(["TOO_LARGE"]);
    expect(r.bytes).toBe(SECRET_TEXT_MAX_BYTES + 1);
    expect(r.format).toBeNull();
  });

  test("the cap counts UTF-8 bytes, not characters", () => {
    const twoByte = "é".repeat(SECRET_TEXT_MAX_BYTES / 2);
    expect(parseSecretEnv(twoByte, ONE).ok).toBe(true);
    expect(codes(errorsOf(parseSecretEnv(`${twoByte}x`, ONE)))).toEqual(["TOO_LARGE"]);
  });

  test("bytes over the cap are refused before decoding", () => {
    const big = new Uint8Array(SECRET_TEXT_MAX_BYTES + 1).fill(0xff);
    expect(codes(errorsOf(parseSecretEnv(big, ONE)))).toEqual(["TOO_LARGE"]);
  });

  test("spec.maxBytes overrides the default", () => {
    expect(
      codes(errorsOf(parseSecretEnv("FIXTURE-abc", { keys: ["API_TOKEN"], maxBytes: 5 }))),
    ).toEqual(["TOO_LARGE"]);
    expect(parseSecretEnv("FIXTU", { keys: ["API_TOKEN"], maxBytes: 5 }).ok).toBe(true);
  });
});

describe("secret-env · lines, bytes, chips", () => {
  test("lines and bytes describe the input", () => {
    const text = "# c\nA_KEY=FIXTURE-a\r\nB_KEY=FIXTURE-b";
    const r = parseSecretEnv(text, TWO);
    expect(r.lines).toBe(3);
    expect(r.bytes).toBe(enc(text).length);
    expect(parseSecretEnv("A_KEY=FIXTURE-a\nB_KEY=FIXTURE-b\n", TWO).lines).toBe(2);
  });

  test("chips: required, optional, unrequested; lengths in code points", () => {
    const r = parseSecretEnv("A_KEY=FIXTURE-\u{1F511}\nZ_KEY=FIXTURE-z\n", {
      keys: ["A_KEY", "B_KEY"],
      optional_keys: ["C_KEY", "D_KEY"],
    });
    expect(r.ok).toBe(false);
    expect(r.chips).toEqual([
      { key: "A_KEY", state: "ok", length: 9 },
      { key: "B_KEY", state: "missing" },
      { key: "C_KEY", state: "missing", optional: true },
      { key: "D_KEY", state: "missing", optional: true },
      { key: "key on line 2", state: "unrequested", line: 2 },
    ]);
  });

  test("an unrequested chip names the key only when its upper-case form was requested", () => {
    const r = parseSecretEnv("api_token=FIXTURE-a\nextra=FIXTURE-b\n", ONE);
    expect(r.chips).toEqual([
      { key: "API_TOKEN", state: "missing" },
      { key: "api_token", state: "unrequested", line: 1 },
      { key: "key on line 2", state: "unrequested", line: 2 },
    ]);
  });

  test("chips never carry a value", () => {
    const r = parseSecretEnv("API_TOKEN=FIXTURE-chip-value\n", ONE);
    expect(JSON.stringify(r.chips)).not.toContain("FIXTURE-chip-value");
  });
});

describe("secret-env · D10: an unrequested key blocks the whole paste", () => {
  test("no entries, no canonical, the line named but not the pasted key", () => {
    const r = parseSecretEnv("API_TOKEN=FIXTURE-a\nEXTRA_KEY=FIXTURE-b\n", ONE);
    expect(r.ok).toBe(false);
    expect("entries" in r).toBe(false);
    expect("canonical" in r).toBe(false);
    expect(errorsOf(r)).toEqual([
      {
        code: "UNREQUESTED_KEY",
        line: 2,
        message: "Line 2 sets a key that was not requested; remove it.",
      },
    ]);
  });

  test("a lower-case spelling of a requested key is named", () => {
    const r = parseSecretEnv("api_token=FIXTURE-a\n", ONE, "dotenv");
    expect(errorsOf(r)).toContainEqual({
      code: "UNREQUESTED_KEY",
      key: "api_token",
      line: 1,
      message: "Line 1: api_token was not requested; remove it.",
    });
  });

  test("an optional key is not unrequested", () => {
    expect(
      parseSecretEnv("API_TOKEN=FIXTURE-a\nEXTRA_KEY=FIXTURE-b\n", {
        keys: ["API_TOKEN"],
        optional_keys: ["EXTRA_KEY"],
      }).ok,
    ).toBe(true);
  });
});

describe("secret-env · errors name the line", () => {
  test("mixed lines", () => {
    const r = parseSecretEnv("A_KEY=FIXTURE-a\nB_KEY=FIXTURE-b\nstray\n", TWO, "dotenv");
    expect(errorsOf(r)).toEqual([
      { code: "NOT_DOTENV_LINE", line: 3, message: "Line 3 is neither KEY=value nor a comment." },
    ]);
  });

  test("a multi-line value moves the line count on", () => {
    const r = parseSecretEnv('A_KEY="FIXTURE\nmore\nmore"\nB_KEY=FIXTURE\nB_KEY=FIXTURE\n', TWO);
    expect(errorsOf(r)).toEqual([
      expect.objectContaining({ code: "DUPLICATE_KEY", key: "B_KEY", line: 5 }),
    ]);
  });

  test("unexpected text is reported on the closing quote's line", () => {
    const r = parseSecretEnv('API_TOKEN="FIXTURE\nend" junk\n', ONE);
    expect(errorsOf(r)).toEqual([expect.objectContaining({ code: "UNEXPECTED_TEXT", line: 2 })]);
  });

  test("a key whose line is malformed is not found: no ok chip beside its error, and not also missing", () => {
    for (const text of ['API_TOKEN="FIXTURE-open\n', 'API_TOKEN="FIXTURE" junk\n']) {
      const r = parseSecretEnv(text, ONE);
      expect(codes(errorsOf(r))).toEqual([
        text.includes("junk") ? "UNEXPECTED_TEXT" : "UNTERMINATED_QUOTE",
      ]);
      expect(r.chips).toEqual([{ key: "API_TOKEN", state: "missing" }]);
    }
  });

  test("a malformed line then a good one for the same key is a repeat, not a found key", () => {
    const r = parseSecretEnv('API_TOKEN="FIXTURE" junk\nAPI_TOKEN=FIXTURE\n', ONE);
    expect(codes(errorsOf(r))).toEqual(["UNEXPECTED_TEXT", "DUPLICATE_KEY"]);
    expect(r.chips).toEqual([{ key: "API_TOKEN", state: "missing" }]);
  });

  test("a control character in a comment line has no key", () => {
    const r = parseSecretEnv("# c\u0007\nAPI_TOKEN=FIXTURE\n", ONE);
    expect(errorsOf(r)).toEqual([
      { code: "CONTROL_CHARACTER", line: 1, message: "Line 1 contains a control character." },
    ]);
  });

  test("a control character inside a multi-line value is attributed to its key", () => {
    const r = parseSecretEnv('A_KEY=FIXTURE\nB_KEY="FIXTURE\nx\u007fy"\n', TWO);
    expect(errorsOf(r)).toEqual([
      expect.objectContaining({ code: "CONTROL_CHARACTER", key: "B_KEY", line: 3 }),
    ]);
  });

  test.each([
    ["\u0000"],
    ["\u0008"],
    ["\u000b"],
    ["\u000c"],
    ["\u001f"],
    ["\u007f"],
    ["\u0085"],
    ["\u009f"],
  ])("control %j is refused", (c) => {
    expect(codes(errorsOf(parseSecretEnv(`FIXTURE${c}x`, ONE)))).toEqual(["CONTROL_CHARACTER"]);
  });

  test("tab is allowed, in raw and in values", () => {
    expect(parseSecretEnv("FIXTURE\tx", ONE).ok).toBe(true);
    expect(parseSecretEnv("API_TOKEN='FIXTURE\tx'", ONE).ok).toBe(true);
  });

  test("a key over 64 characters", () => {
    const r = parseSecretEnv(`${"K".repeat(65)}=FIXTURE\n# x\n`, ONE, "dotenv");
    expect(codes(errorsOf(r))).toEqual(["BAD_KEY_NAME", "MISSING_KEY"]);
  });
});

describe("secret-env · raw", () => {
  test("interior newlines kept, exactly one trailing newline trimmed", () => {
    const r = parseSecretEnv("FIXTURE\n\nmiddle\n", ONE);
    expect(r.ok && r.entries).toEqual([{ key: "API_TOKEN", value: "FIXTURE\n\nmiddle" }]);
  });

  test("raw fills the one optional key when nothing is required", () => {
    const r = parseSecretEnv("FIXTURE-token", { keys: [], optional_keys: ["API_TOKEN"] });
    expect(r.ok && r.entries).toEqual([{ key: "API_TOKEN", value: "FIXTURE-token" }]);
    expect(r.chips).toEqual([{ key: "API_TOKEN", state: "ok", optional: true, length: 13 }]);
  });

  test("one required plus optionals: raw fills the required key", () => {
    const r = parseSecretEnv("FIXTURE-token", { keys: ["API_TOKEN"], optional_keys: ["OTHER_KEY"] });
    expect(r.ok && r.entries).toEqual([{ key: "API_TOKEN", value: "FIXTURE-token" }]);
  });

  test("forced raw with two keys", () => {
    const r = parseSecretEnv("A_KEY=FIXTURE\nB_KEY=FIXTURE\n", TWO, "raw");
    expect(codes(errorsOf(r))).toEqual(["RAW_NEEDS_ONE_KEY"]);
    expect(messages(r)[0]).toContain("KEY=value");
  });

  test("forced dotenv on a raw token", () => {
    expect(codes(errorsOf(parseSecretEnv("FIXTURE-token", ONE, "dotenv")))).toEqual([
      "NOT_DOTENV_LINE",
      "MISSING_KEY",
    ]);
  });
});

describe("secret-env · warnings", () => {
  test.each([
    ["changeme"],
    ["CHANGE_ME"],
    ["xxx"],
    ["XXXXXXXX"],
    ["sk-xxxxxxxx"],
    ["<token>"],
    ["<...>"],
    ["your-api-key"],
    ["your_token_here"],
    ["put-key-here"],
    ["aaaaaaaa"],
    ["********"],
    ["placeholder"],
  ])("placeholder %j", (value) => {
    const r = parseSecretEnv(`API_TOKEN=${value}`, ONE);
    expect(r.ok).toBe(true);
    expect(codes(r.warnings)).toEqual(["PLACEHOLDER_VALUE"]);
  });

  test.each([["FIXTURE-real-looking"], ["ab"], ["xylophone"], ["hereditary"]])(
    "not a placeholder %j",
    (value) => {
      expect(parseSecretEnv(`API_TOKEN=${value}`, ONE).warnings).toEqual([]);
    },
  );

  test("whitespace: leading, trailing, none for quoted or comment padding", () => {
    expect(codes(parseSecretEnv("API_TOKEN= FIXTURE", ONE).warnings)).toEqual(["VALUE_WHITESPACE"]);
    expect(codes(parseSecretEnv("API_TOKEN=FIXTURE  ", ONE).warnings)).toEqual(["VALUE_WHITESPACE"]);
    expect(parseSecretEnv("API_TOKEN=FIXTURE    # aligned comment", ONE).warnings).toEqual([]);
    const q = parseSecretEnv('API_TOKEN=" FIXTURE "', ONE);
    expect(q.warnings).toEqual([]);
    expect(q.ok && q.entries[0]?.value).toBe(" FIXTURE ");
    expect(codes(parseSecretEnv(" FIXTURE", ONE).warnings)).toEqual(["VALUE_WHITESPACE"]);
  });

  test("lower-case key suggests the requested name", () => {
    const r = parseSecretEnv("# c\napi_token=FIXTURE\n", ONE);
    const w = r.warnings[0];
    expect(w).toMatchObject({ code: "LOWERCASE_KEY", key: "api_token", line: 2 });
    expect(w?.message).toContain("Did you mean API_TOKEN?");
  });

  test("raw whose first line names another key: unnamed unless requested", () => {
    const r = parseSecretEnv("export OTHER_NAME=FIXTURE\n", ONE, "raw");
    expect(r.warnings).toEqual([expect.objectContaining({ code: "RAW_LOOKS_LIKE_OTHER_KEY" })]);
    expect(r.warnings[0]?.message).not.toContain("OTHER_NAME");
    const named = parseSecretEnv(
      "export OTHER_NAME=FIXTURE\n",
      { keys: ["API_TOKEN"], optional_keys: ["OTHER_NAME"] },
      "raw",
    );
    expect(named.warnings).toEqual([
      expect.objectContaining({
        code: "RAW_LOOKS_LIKE_OTHER_KEY",
        message: expect.stringContaining("OTHER_NAME"),
      }),
    ]);
  });

  test("raw base64 with padding does not suggest a key", () => {
    expect(parseSecretEnv("FIXTUREABC==", ONE, "raw").warnings).toEqual([]);
    expect(parseSecretEnv("FIXTUREAB=", ONE, "raw").warnings).toEqual([]);
  });

  test.each([
    ["GITHUB_TOKEN", "sk-ant-FIXTURE-0000", true],
    ["GITHUB_TOKEN", "ghp_FIXTURE00000000000000000000000000000", false],
    ["GITHUB_TOKEN", "github_pat_FIXTURE0000", false],
    ["GH_TOKEN", "gho_FIXTURE0000", false],
    ["ANTHROPIC_API_KEY", "sk-FIXTURE-0000", true],
    ["ANTHROPIC_API_KEY", "sk-ant-FIXTURE-0000", false],
    ["OPENAI_API_KEY", "sk-ant-FIXTURE-0000", true],
    ["OPENAI_API_KEY", "sk-proj-FIXTURE-0000", false],
    ["OPENROUTER_API_KEY", "sk-or-v1-FIXTURE-0000", false],
    ["SLACK_BOT_TOKEN", "ghp_FIXTURE0000", true],
    ["SLACK_BOT_TOKEN", "xoxb-FIXTURE-0000", false],
    ["AWS_ACCESS_KEY_ID", "AKIAFIXTURE000000000", false],
    ["GITLAB_TOKEN", "AKIAFIXTURE000000000", true],
    ["GITLAB_TOKEN", "glpat-FIXTURE0000", false],
    ["API_TOKEN", "sk-ant-FIXTURE-0000", false],
    ["GITHUB_TOKEN", "FIXTURE-unknown-shape", false],
  ])("token shape: %s = %s → warn %p", (key, value, warn) => {
    const r = parseSecretEnv(`${key}=${value}`, { keys: [key] });
    expect(r.ok).toBe(true);
    expect(codes(r.warnings)).toEqual(warn ? ["TOKEN_SHAPE_MISMATCH"] : []);
  });
});

describe("secret-env · messages never carry a value", () => {
  const VALUE = "FIXTURE-never-in-a-message";
  const rows: ReadonlyArray<[string, SecretEnvSpec, SecretInputMode]> = [
    [`API_TOKEN=${VALUE}\nEXTRA_KEY=${VALUE}`, ONE, "auto"],
    [`API_TOKEN=${VALUE}\nAPI_TOKEN=${VALUE}`, ONE, "auto"],
    [`API_TOKEN="${VALUE}`, ONE, "auto"],
    [`API_TOKEN="${VALUE}" ${VALUE}`, ONE, "auto"],
    [`A_KEY=${VALUE}\n${VALUE}`, TWO, "auto"],
    [`${VALUE}-with=equals\n${VALUE}`, TWO, "auto"],
    [`API_TOKEN=  ${VALUE}\u0000  `, ONE, "auto"],
    [`GITHUB_TOKEN=sk-ant-${VALUE}`, { keys: ["GITHUB_TOKEN"] }, "auto"],
    [`OTHER_NAME=${VALUE}`, ONE, "raw"],
    [`${VALUE}-xxxx`, ONE, "auto"],
  ];
  test.each(rows)("%j", (text, spec, mode) => {
    const r = parseSecretEnv(text, spec, mode);
    expect([...errorsOf(r), ...r.warnings].length).toBeGreaterThan(0);
    for (const m of messages(r)) expect(m).not.toContain(VALUE);
  });
});

/**
 * A padded base64 secret parses as `KEY=` with its body as the "key": issues,
 * warnings and chips must never echo a name the request did not give, or the
 * secret reaches CLI stderr, the app and the box's `rejected.message`.
 */
describe("secret-env · a pasted name the request did not give is never echoed", () => {
  const b64 = (s: string): string => Buffer.from(s).toString("base64");
  const VALUES = [
    b64("FIXTURE-b64-se"), // 20 chars, =
    b64("FIXTURE-b64-secret-1"), // 28 chars, =
    b64("FIXTURE-b64-secret-0001"), // 32 chars, =
    b64("FIXTURE-b64-secret-value-0002"), // 40 chars, =
    b64("FIXTURE-b64-secret-value-000003"), // 44 chars, ==
    b64("FIXTURE-b64-secret-value-0006-a-long-padded-00"), // 64 chars, ==
    "FIXTUREZQK7ABCDEFGHJKLMNPQRSTUVW0123456789=", // upper-case alphabet, env-shaped body
    "FIXTUREZQK7ABCDEFGH==",
  ];
  const SPECS: ReadonlyArray<[string, SecretEnvSpec]> = [
    ["one key", { keys: ["API_TOKEN"] }],
    ["two keys", { keys: ["API_TOKEN", "DB_PASSWORD"] }],
    ["one key + optional", { keys: ["API_TOKEN"], optional_keys: ["DB_PASSWORD"] }],
  ];
  const MODES: readonly SecretInputMode[] = ["auto", "raw", "dotenv"];
  const shapes = (v: string): string[] => [
    v,
    `${v}\n`,
    `${v}\n${v}\n`,
    `${v}\u0007`,
    `${v}x`,
    `${v}"x`,
    `${v}'x`,
    `export ${v}`,
    `${v.toUpperCase()}`,
    `API_TOKEN=FIXTURE-ok\n${v}\n`,
    `${v}\nAPI_TOKEN=FIXTURE-ok\n`,
  ];
  const rows = VALUES.flatMap((v) => shapes(v).map((text): [string, string] => [v, text]));

  test("every value is 20–64 base64 characters with `=` padding", () => {
    for (const v of VALUES) {
      expect(v.length).toBeGreaterThanOrEqual(20);
      expect(v.length).toBeLessThanOrEqual(64);
      expect(v).toMatch(/^[A-Za-z0-9+/]+=+$/);
    }
  });

  for (const [label, spec] of SPECS) {
    for (const mode of MODES) {
      test(`${label}, ${mode}`, () => {
        for (const [v, text] of rows) {
          const r = parseSecretEnv(text, spec, mode);
          const said = JSON.stringify({
            issues: [...errorsOf(r), ...r.warnings],
            chips: r.chips,
          });
          for (const body of [v, v.toUpperCase()]) {
            for (let i = 0; i + 6 <= body.length; i++) {
              const fragment = body.slice(i, i + 6);
              if (said.includes(fragment)) {
                throw new Error(`${JSON.stringify(text)} (${mode}) echoed ${fragment}: ${said}`);
              }
            }
          }
        }
      });
    }
  }
});

describe("secret-env · canonical form", () => {
  const ALPHABET = [
    '"',
    "\\",
    "\n",
    "\t",
    "'",
    "#",
    "=",
    " ",
    "n",
    "a",
    "Z",
    "é",
    "\u{1F511}",
    "$",
    "`",
    "(",
    "{",
    "}",
    "1",
  ];

  /** Deterministic: the same values every run. */
  function* values(): Generator<string> {
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let i = 0; i < 300; i++) {
      const len = 1 + (next() % 24);
      let s = "";
      for (let j = 0; j < len; j++) s += ALPHABET[next() % ALPHABET.length];
      yield s;
    }
  }

  test("round-trips through both box readers", () => {
    for (const value of values()) {
      const entries = [
        { key: "A_KEY", value },
        { key: "B_KEY", value: `FIXTURE${value}` },
      ];
      const text = canonicalSecretEnv(entries);
      expect(readCanonicalSecretEnv(text)).toEqual(entries);
      const again = parseSecretEnv(text, TWO, "dotenv");
      expect(errorsOf(again)).toEqual([]);
      expect(again.ok && again.entries).toEqual(entries);
      expect(again.ok && again.canonical).toBe(text);
    }
  });

  test("escapes exactly backslash, quote, dollar and backtick; newlines stay real", () => {
    expect(canonicalSecretEnv([{ key: "K", value: 'a"b\\c\nd\te$f`g' }])).toBe(
      'K="a\\"b\\\\c\nd\te\\$f\\`g"\n',
    );
    expect(canonicalSecretEnv([])).toBe("");
    expect(readCanonicalSecretEnv("")).toEqual([]);
  });

  test.each([
    ['K="v"'],
    ['# c\nK="v"\n'],
    ['K="v" \n'],
    ["K=v\n"],
    ["K='v'\n"],
    ['k="v"\n'],
    ['export K="v"\n'],
    ['K="a\\tb"\n'],
    ['K="a\\nb"\n'],
    ['K="a\\\nb"\n'],
    ['K="$HOME"\n'],
    ['K="a`id`"\n'],
    ['K="a"b"\n'],
    ['K="a\\"\n'],
    ['K="v"\nK="w"\n'],
    ['K="\u0000"\n'],
    ['K="v"\r\n'],
    ["\n"],
    [`${"K".repeat(65)}="v"\n`],
  ])("strict reader refuses %j", (text) => {
    expect(readCanonicalSecretEnv(text)).toBeNull();
  });

  test.each([
    [[{ key: "bad-key", value: "v" }]],
    [[{ key: "lower", value: "v" }]],
    [[{ key: "K", value: "a\rb" }]],
    [[{ key: "K", value: "\u0000" }]],
    [
      [
        { key: "K", value: "a" },
        { key: "K", value: "b" },
      ],
    ],
  ])("canonicalSecretEnv refuses %j", (entries) => {
    expect(() => canonicalSecretEnv(entries)).toThrow(HermeticError);
  });
});

describe("secret-env · a malformed spec throws", () => {
  test.each([
    [{ keys: [] }],
    [{ keys: ["lower"] }],
    [{ keys: ["A_KEY", "A_KEY"] }],
    [{ keys: ["A_KEY"], optional_keys: ["A_KEY"] }],
    [{ keys: ["A_KEY"], maxBytes: 0 }],
    [{ keys: ["A_KEY"], maxBytes: 1.5 }],
  ] as const)("%j", (spec) => {
    try {
      parseSecretEnv("FIXTURE", spec);
      throw new Error("did not throw");
    } catch (e) {
      expect(e).toBeInstanceOf(HermeticError);
      expect((e as HermeticError).code).toBe("VALIDATION");
    }
  });

  test("an unknown mode throws", () => {
    expect(() => parseSecretEnv("FIXTURE", ONE, "yaml" as "raw")).toThrow(HermeticError);
  });
});

/**
 * The box sources the canonical file with `set -a; . <file>; set +a`, so sh
 * itself is the last reader: nothing may expand or run, and every byte must
 * survive. Skipped where there is no `/bin/sh`.
 */
describe.skipIf(!existsSync("/bin/sh"))("secret-env · canonical form under /bin/sh", () => {
  const SOURCE = 'set -a; . "$0"; set +a; ';

  function sourced(text: string, script: string): Uint8Array {
    const dir = mkdtempSync(join(tmpdir(), "secret-env-sh-"));
    try {
      const file = join(dir, "secret.env");
      writeFileSync(file, text);
      const run = Bun.spawnSync(["/bin/sh", "-c", SOURCE + script, file], {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/nonexistent-home" },
      });
      if (run.exitCode !== 0) throw new Error(`sh exited ${run.exitCode}: ${run.stderr.toString()}`);
      return run.stdout;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("hostile values come back byte for byte and run nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "secret-env-pwn-"));
    const pwned = join(dir, "pwned");
    try {
      const hostile = [
        `FIXTURE-$(touch ${pwned})`,
        `FIXTURE-\`touch ${pwned}\``,
        "FIXTURE-$1-$0-$$-$@",
        "FIXTURE-${HOME}-$HOME",
        'FIXTURE-"double"',
        "FIXTURE-'single'",
        "FIXTURE-back\\slash-\\n-\\$",
        "FIXTURE-trailing\\",
        "FIXTURE-backslash-newline\\\nnext",
        "-----BEGIN OPENSSH PRIVATE KEY-----\nFIXTUREFIXTURE\nFIXTURE==\n-----END OPENSSH PRIVATE KEY-----",
        "FIXTURE-ends-in-newline\n",
        "FIXTURE\ttab é \u{1F511}",
      ];
      for (const value of hostile) {
        const text = canonicalSecretEnv([{ key: "KEY", value }]);
        const out = sourced(text, 'printf %s "$KEY"');
        expect(new TextDecoder().decode(out)).toBe(value);
        expect(existsSync(pwned)).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("every fuzz value survives sh, many keys in one file", () => {
    const entries: SecretEnvEntry[] = [];
    let seed = 11;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    const alphabet = [
      '"',
      "\\",
      "\n",
      "\t",
      "'",
      "$",
      "`",
      "(",
      ")",
      "{",
      "}",
      "1",
      "#",
      " ",
      "a",
      "é",
      "*",
      "!",
    ];
    for (let i = 0; i < 200; i++) {
      let value = "FIXTURE";
      const len = next() % 24;
      for (let j = 0; j < len; j++) value += alphabet[next() % alphabet.length];
      entries.push({ key: `V${i}`, value });
    }
    const text = canonicalSecretEnv(entries);
    const script = `printf '%s\\0' ${entries.map((e) => `"$${e.key}"`).join(" ")}`;
    const parts = new TextDecoder().decode(sourced(text, script)).split("\0");
    expect(parts.pop()).toBe("");
    expect(parts).toEqual(entries.map((e) => e.value));
  });
});
