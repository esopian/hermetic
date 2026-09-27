/**
 * Two contracts a script depends on and neither of which core can hold up:
 *
 * - a *usage* error (unknown command, missing argument, unknown option) exits
 *   `EXIT_VALIDATION`, not 1. Commander used to exit 1 itself, which is the
 *   status `exit-codes.ts` reserves for `INTERNAL` — "the tool broke" — so a
 *   typo was indistinguishable from a bug;
 * - in `--json` mode stdout carries exactly one machine document and nothing
 *   else, on the success path and on every error path, while the human half
 *   goes to stderr (§4.7).
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_OK, EXIT_VALIDATION } from "../src/exit-codes.ts";
import { cliBinary, seedFixtureHome } from "./cli-binary.ts";

const HOME = mkdtempSync(join(tmpdir(), "hermetic-cli-usage-"));
beforeAll(() => seedFixtureHome(HOME));

async function run(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([await cliBinary(), ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HERMETIC_FIXTURE: "1", HERMETIC_NO_TTY: "1", HERMETIC_HOME: HOME },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/**
 * "Exactly one JSON document" is a parse, not an eyeball: two documents
 * concatenated, or one document with a line of prose after it, both make
 * `JSON.parse` throw on the whole stream. That is the property `| jq` needs.
 */
function soleDocument(stdout: string): unknown {
  expect(stdout.length).toBeGreaterThan(0);
  expect(stdout.endsWith("\n")).toBe(true);
  return JSON.parse(stdout);
}

describe.concurrent("Commander's own usage errors", () => {
  const usage: Array<{ label: string; argv: string[]; says: string }> = [
    { label: "an unknown command", argv: ["nope"], says: "unknown command" },
    { label: "an unknown subcommand", argv: ["agent", "nope"], says: "unknown command" },
    {
      label: "a missing required argument",
      argv: ["agent", "status"],
      says: "missing required argument",
    },
    { label: "an unknown option", argv: ["agent", "ps", "--bogus"], says: "unknown option" },
    // No command at all: Commander prints the help to stderr and refuses.
    { label: "no command at all", argv: [], says: "Usage: hermetic" },
  ];

  for (const c of usage) {
    test(`${c.label} exits EXIT_VALIDATION and explains itself on stderr`, async () => {
      const { code, stdout, stderr } = await run(...c.argv);
      expect(code).toBe(EXIT_VALIDATION);
      expect(stderr).toContain(c.says);
      // Nothing on stdout: no `--json`, so there is no document to write, and
      // a script reading stdout must not read prose.
      expect(stdout).toBe("");
    });

    test(`${c.label} still owes stdout one JSON document under --json`, async () => {
      const { code, stdout, stderr } = await run(...c.argv, "--json");
      expect(code).toBe(EXIT_VALIDATION);
      expect(soleDocument(stdout)).toMatchObject({ error: { code: "VALIDATION" } });
      const message = (soleDocument(stdout) as { error: { message: string } }).error.message;
      expect(message.length).toBeGreaterThan(0);
      // The prefix belongs to the terminal line, not to a field called message.
      expect(message.startsWith("error: ")).toBe(false);
      expect(stderr.length).toBeGreaterThan(0);
    });
  }

  /**
   * The one place `--json` does not mean "stdout is a document": help. It is
   * not a result, it is the text the operator asked to read, and wrapping it in
   * a JSON envelope would make it neither readable nor useful — `hermetic
   * --help --json | jq` is not a thing anyone runs. Pinned here so the carve-out
   * is a decision rather than an oversight.
   */
  test("--json --help is help, on stdout, exit 0", async () => {
    const { code, stdout } = await run("--help", "--json");
    expect(code).toBe(EXIT_OK);
    expect(stdout).toContain("Usage: hermetic");
    expect(() => JSON.parse(stdout) as unknown).toThrow();
  });

  test("--help and --version are not errors", async () => {
    const help = await run("--help");
    expect(help.code).toBe(EXIT_OK);
    expect(help.stdout).toContain("Usage: hermetic");
    const version = await run("--version");
    expect(version.code).toBe(EXIT_OK);
    expect(version.stdout.trim().length).toBeGreaterThan(0);
  });
});

/**
 * Help text is documentation that ships inside the binary, and the way it goes
 * wrong is that it outlives the command it names: §8.3 removed `providers set
 * --no-secret`, and `secrets rm` went on telling operators to run it. A pointer
 * to a command this build does not have is worse than no pointer at all.
 */
describe.concurrent("help text names only commands this build has", () => {
  test("`secrets rm --help` points at commands that exist", async () => {
    const { code, stdout } = await run("secrets", "rm", "--help");
    expect(code).toBe(EXIT_OK);
    expect(stdout).not.toContain("--no-secret");
    expect(stdout).toContain("--provider-profile");
    expect(stdout).toContain("providers rm");
  });

  test("and the commands it points at answer", async () => {
    for (const argv of [
      ["agent", "set", "--help"],
      ["providers", "rm", "--help"],
    ]) {
      const { code, stdout } = await run(...argv);
      expect(code).toBe(EXIT_OK);
      expect(stdout).toContain("Usage: hermetic");
    }
  });
});

describe.concurrent("--json keeps stdout to one document", () => {
  test("on the success path", async () => {
    const { code, stdout, stderr } = await run("agent", "ps", "--json");
    expect(code).toBe(EXIT_OK);
    expect(Array.isArray(soleDocument(stdout))).toBe(true);
    // The account header is the human half, and it is on the other stream.
    expect(stderr).toContain("▸ main · acme-dev");
    expect(stdout).not.toContain("▸");
  });

  test("on a core error path", async () => {
    const { code, stdout, stderr } = await run("agent", "status", "nosuchagent", "--json");
    // NOT_FOUND, from the table in `exit-codes.ts`.
    expect(code).toBe(6);
    expect(soleDocument(stdout)).toEqual({
      error: { code: "NOT_FOUND", message: expect.any(String) },
    });
    expect(stderr).toContain("error: NOT_FOUND");
  });

  test("on a schema-validation path", async () => {
    const { code, stdout } = await run("agent", "status", "BAD_NAME", "--json");
    expect(code).toBe(EXIT_VALIDATION);
    expect(soleDocument(stdout)).toMatchObject({ error: { code: "VALIDATION" } });
  });
});
