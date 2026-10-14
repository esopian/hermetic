/**
 * The text-secret seam (plan §06b): the laptop previews a paste with
 * `parseSecretEnv` and sends the canonical form; the box re-parses that form
 * authoritatively, and the Hermes plugin reads it in Python. All three must
 * agree on every row of `tests/fixtures/secret-env/cases.json`.
 *
 * Error and warning codes are compared as sorted lists, so a reader may report
 * them in any order but must report the same set. Byte-level cases JSON cannot
 * carry (invalid UTF-8, a lone surrogate, the size cap) live in
 * `packages/core/test/secret-env.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SECRET_ENV_ERROR_CODES,
  SECRET_ENV_WARNING_CODES,
  parseSecretEnv,
  readCanonicalSecretEnv,
} from "../packages/core/src/shared/index.ts";
import type {
  SecretEnvEntry,
  SecretFormat,
  SecretInputMode,
} from "../packages/core/src/shared/index.ts";

interface SecretEnvCase {
  name: string;
  input: string;
  mode: SecretInputMode;
  keys: string[];
  optional_keys?: string[];
  expect: {
    ok: boolean;
    format: SecretFormat | null;
    canonical?: string;
    entries?: SecretEnvEntry[];
    errors?: string[];
    warnings?: string[];
  };
}

const CASES_PATH = join(import.meta.dir, "fixtures/secret-env/cases.json");
const CASES = JSON.parse(readFileSync(CASES_PATH, "utf8")) as SecretEnvCase[];
const KNOWN_CODES = new Set<string>([...SECRET_ENV_ERROR_CODES, ...SECRET_ENV_WARNING_CODES]);

const sorted = (codes: readonly string[]): string[] => [...codes].sort();

describe("secret-env seam · cases.json is well formed", () => {
  test("names are unique and every expected code exists", () => {
    expect(new Set(CASES.map((c) => c.name)).size).toBe(CASES.length);
    for (const c of CASES) {
      for (const code of [...(c.expect.errors ?? []), ...(c.expect.warnings ?? [])]) {
        expect(KNOWN_CODES.has(code)).toBe(true);
      }
      if (!c.expect.ok) expect(c.expect.errors?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe("secret-env seam · TypeScript reader", () => {
  for (const c of CASES) {
    test(c.name, () => {
      const spec =
        c.optional_keys === undefined
          ? { keys: c.keys }
          : { keys: c.keys, optional_keys: c.optional_keys };
      const r = parseSecretEnv(c.input, spec, c.mode);
      expect(r.ok).toBe(c.expect.ok);
      expect(r.format).toBe(c.expect.format);
      expect(sorted(r.warnings.map((w) => w.code))).toEqual(sorted(c.expect.warnings ?? []));
      if (!r.ok) {
        expect(sorted(r.errors.map((e) => e.code))).toEqual(sorted(c.expect.errors ?? []));
        return;
      }
      if (c.expect.entries !== undefined) expect(r.entries).toEqual(c.expect.entries);
      if (c.expect.canonical !== undefined) expect(r.canonical).toBe(c.expect.canonical);
      // The box's two readers agree with the laptop's: the strict canonical
      // reader, and a dotenv re-parse of the canonical text — which must also
      // canonicalise back to the identical bytes (hermeticd's durable check).
      expect(readCanonicalSecretEnv(r.canonical)).toEqual(r.entries);
      const again = parseSecretEnv(r.canonical, spec, "dotenv");
      expect(again.ok).toBe(true);
      if (again.ok) {
        expect(again.entries).toEqual(r.entries);
        expect(again.canonical).toBe(r.canonical);
      }
    });
  }
});

// Python reader half: the hermetic-files plugin's `read_canonical_secret_env`
// (`packages/agentd/plugins/hermetic-files/__init__.py`), which reads what
// hermeticd wrote to scrub its values out of tool results. Each ok case's
// canonical text goes to a file, as on the box, and is read back in Python.

const PLUGIN_INIT = join(import.meta.dir, "../packages/agentd/plugins/hermetic-files/__init__.py");
const PYTHON = Bun.which("python3");

/** Load the plugin by path (its directory name is not an importable name) and read each file. */
const PY_READER = `
import importlib.util, json, sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("hermetic_files_plugin", sys.argv[1])
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)
out = []
for path in json.loads(sys.stdin.read()):
    with open(path, "rb") as f:
        entries = plugin.read_canonical_secret_env(f.read().decode("utf-8"))
    out.append(None if entries is None else [{"key": k, "value": v} for k, v in entries])
print(json.dumps(out))
`;

describe.skipIf(PYTHON === null)(
  `secret-env seam · Python reader${PYTHON === null ? " (skipped: no python3 on PATH)" : ""}`,
  () => {
    test("reads every ok case's canonical file to the same entries", () => {
      const dir = mkdtempSync(join(tmpdir(), "secret-env-seam-"));
      try {
        const rows: Array<{ name: string; path: string; entries: SecretEnvEntry[] }> = [];
        for (const [i, c] of CASES.entries()) {
          const spec =
            c.optional_keys === undefined
              ? { keys: c.keys }
              : { keys: c.keys, optional_keys: c.optional_keys };
          const r = parseSecretEnv(c.input, spec, c.mode);
          if (!r.ok) continue;
          const path = join(dir, `case-${i}.env`);
          writeFileSync(path, r.canonical);
          rows.push({ name: c.name, path, entries: r.entries });
        }
        expect(rows.length).toBeGreaterThan(0);
        const run = Bun.spawnSync([PYTHON as string, "-c", PY_READER, PLUGIN_INIT], {
          stdin: new TextEncoder().encode(JSON.stringify(rows.map((r) => r.path))),
        });
        if (run.exitCode !== 0)
          throw new Error(`python3 exited ${run.exitCode}\n${run.stderr.toString()}`);
        const read = JSON.parse(run.stdout.toString()) as Array<SecretEnvEntry[] | null>;
        expect(read.length).toBe(rows.length);
        for (const [i, row] of rows.entries()) {
          expect({ name: row.name, entries: read[i] }).toEqual({
            name: row.name,
            entries: row.entries,
          });
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("refuses what the TypeScript reader refuses", () => {
      const bad = [
        'A="x"',
        'A="x"\n\n',
        '# c\nA="x"\n',
        'A="x"\nA="y"\n',
        'A="\\t"\n',
        'A="\\n"\n',
        'A="$HOME"\n',
        'A="`id`"\n',
        '\uFEFFA="x"\n',
      ];
      for (const text of bad) expect(readCanonicalSecretEnv(text)).toBeNull();
      const dir = mkdtempSync(join(tmpdir(), "secret-env-seam-"));
      try {
        const paths = bad.map((text, i) => {
          const path = join(dir, `bad-${i}.env`);
          writeFileSync(path, text);
          return path;
        });
        const run = Bun.spawnSync([PYTHON as string, "-c", PY_READER, PLUGIN_INIT], {
          stdin: new TextEncoder().encode(JSON.stringify(paths)),
        });
        if (run.exitCode !== 0)
          throw new Error(`python3 exited ${run.exitCode}\n${run.stderr.toString()}`);
        expect(JSON.parse(run.stdout.toString())).toEqual(bad.map(() => null));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);
