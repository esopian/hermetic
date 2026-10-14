/**
 * `hermetic files put` and `files decline` (§8.7): the plain-English closing
 * lines, the usage refusals made before anything is read, and the run log —
 * which must never hold a file's name or a text secret's value.
 *
 * A spawned CLI is a fresh fixture process with no open request slots (only
 * an agent's own `request_file` opens one), so the success lanes are covered
 * in core (`packages/core/test/files-put.test.ts`) and across the bridge
 * (`tests/files-put-bridge.test.ts`); here they are the line formatting.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { FilesPutInput, HermeticError, runRecorderFor } from "@hermetic/core";
import { declineLine, holdStdinSecret, putFlags, putLines, putRefusal } from "../src/commands/files.ts";
import { runningCommand, setGlobalFlags, setRunningCommand } from "../src/context.ts";
import { buildProgram } from "../src/program.ts";
import { cliBinary, seedFixtureHome } from "./cli-binary.ts";

const HOME = mkdtempSync(join(tmpdir(), "hermetic-cli-files-"));
beforeAll(() => seedFixtureHome(HOME));

const SHA = "41ab".padEnd(64, "0");
const VALUE = "ghp_FIXTUREcliStdinSecretValue0001";

async function run(args: string[], stdin?: string) {
  const proc = Bun.spawn([await cliBinary(), ...args], {
    stdin: stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HERMETIC_FIXTURE: "1", HERMETIC_NO_TTY: "1", HERMETIC_HOME: HOME },
  });
  if (stdin !== undefined && proc.stdin) {
    proc.stdin.write(stdin);
    await proc.stdin.end();
  }
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

describe("putLines", () => {
  test("a durable text secret names its keys, format and slot, never a value", () => {
    expect(
      putLines({
        type: "fulfilled",
        ssm_slot: "env-github",
        result: {
          request_id: "fr_4hd8aaaaaaaa",
          path: "/run/hermetic/files/github.env",
          sha256: SHA,
          bytes: 50,
          class: "secret",
          keys: ["GITHUB_TOKEN"],
          format: "dotenv",
        },
      }),
    ).toEqual([
      "  dotenv · 1 key: GITHUB_TOKEN ✓ (value not shown)",
      "✓ stored in SSM slot env-github · materialised to /run/hermetic/files/github.env",
    ]);
  });

  test("a secret sent once, and a plain file", () => {
    const base = { request_id: "fr_9pq2aaaaaaaa", sha256: SHA, bytes: 1700 };
    expect(
      putLines({
        type: "fulfilled",
        result: { ...base, path: "/run/hermetic/drop/fr_9pq2aaaaaaaa/key.pem", class: "secret" },
      }),
    ).toEqual([
      "✓ delivered for this once to /run/hermetic/drop/fr_9pq2aaaaaaaa/key.pem · contents never shown",
    ]);
    expect(
      putLines({
        type: "fulfilled",
        result: { ...base, path: "/data/hermes/inbox/2026-10-12/f_x/access.log", class: "file" },
      }),
    ).toEqual(["✓ delivered access.log · 1.7 KB · sha256 41ab00000000"]);
  });

  test("declineLine", () => {
    expect(
      declineLine("sindri", {
        request_id: "fr_7k2m4p9q3f9a",
        kind: "file",
        purpose: "x",
        accept: [],
        max_bytes: 1,
        sensitivity: "normal",
        durable: false,
        state: "declined",
        created_at: "2026-10-12T00:00:00.000Z",
        expires_at: "2026-10-12T02:00:00.000Z",
      }),
    ).toBe("✓ declined fr_7k2m4p9q3f9a · sindri was told");
  });
});

describe("holdStdinSecret", () => {
  test("registers the text marked as a text secret, then zeroes its own copy", () => {
    const calls: { name: string; bytes: Uint8Array; text: string; opts: unknown }[] = [];
    const id = holdStdinSecret(
      {
        registerBytes: (name, bytes, opts) => {
          calls.push({ name, bytes, text: new TextDecoder().decode(bytes), opts });
          return { upload_id: "up_FIXTURE" };
        },
      },
      VALUE,
    );
    expect(id).toBe("up_FIXTURE");
    expect(calls.map((c) => [c.name, c.text, c.opts])).toEqual([
      ["stdin", VALUE, { secretText: true }],
    ]);
    // The registry keeps its own copy; the CLI's is wiped once it has been handed over.
    expect(calls[0]?.bytes.every((b) => b === 0)).toBe(true);
  });
});

/**
 * `files put`'s flags through the real program's parse, the action swapped
 * for a recorder that builds the input the real action validates
 * (`putFlags`), against core's own schema. What is under test is argv to
 * request, not core.
 */
describe("files put --replace", () => {
  async function parse(argv: string[]): Promise<FilesPutInput> {
    let seen: unknown = null;
    const program = buildProgram();
    const files = program.commands.find((c) => c.name() === "files") as Command;
    const put = files.commands.find((c) => c.name() === "put") as Command;
    put.action((agent: string, path: string, opts: Record<string, unknown>) => {
      seen = FilesPutInput.parse({
        instance: agent,
        request_id: opts["request"],
        source: { path },
        ...putFlags(opts),
      });
    });
    program.exitOverride();
    const before = runningCommand();
    try {
      await program.parseAsync(argv, { from: "user" });
    } finally {
      setRunningCommand(before.command, before.args);
      setGlobalFlags({});
    }
    return seen as FilesPutInput;
  }

  test("--replace is the operator's confirmation, carried as replace: true", async () => {
    const input = await parse([
      "files",
      "put",
      "atlas",
      "/tmp/FIXTURE.pem",
      "--request",
      "fr_abcdefabcdef",
      "--replace",
    ]);
    expect(input.replace).toBe(true);
  });

  test("without it the input carries no replace at all", async () => {
    const input = await parse([
      "files",
      "put",
      "atlas",
      "/tmp/FIXTURE.pem",
      "--request",
      "fr_abcdefabcdef",
    ]);
    expect("replace" in input).toBe(false);
  });
});

describe("putRefusal", () => {
  test("core's head-neutral replace question gains the CLI's way to say yes", () => {
    const core = new HermeticError(
      "CONFLICT",
      "A stored secret file-deploy-pem already exists on atlas. Replace it?",
      { ssm_slot: "file-deploy-pem", replace_required: true },
    );
    const e = putRefusal(core) as HermeticError;
    expect(e instanceof HermeticError).toBe(true);
    expect(e.code).toBe("CONFLICT");
    expect(e.message).toBe(
      "A stored secret file-deploy-pem already exists on atlas. Replace it? Re-run with --replace to overwrite it.",
    );
    expect(e.details?.["replace_required"]).toBe(true);
  });

  test("any other error passes through as it was", () => {
    const other = new HermeticError("CONFLICT", "the file changed while it was being read");
    expect(putRefusal(other) === other).toBe(true);
    const plain = new Error("boom");
    expect(putRefusal(plain) === plain).toBe(true);
  });
});

describe("files put / decline (spawned)", () => {
  test("a path together with --secret-stdin is a usage error, before stdin is read", async () => {
    const { code, stderr } = await run([
      "files",
      "put",
      "atlas",
      "./FIXTURE.pem",
      "--request",
      "fr_abcdefabcdef",
      "--secret-stdin",
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain("not both");
  });

  test("neither a path nor --secret-stdin is a usage error", async () => {
    const { code, stderr } = await run(["files", "put", "atlas", "--request", "fr_abcdefabcdef"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--secret-stdin");
  });

  test("--as takes raw or env only", async () => {
    const { code } = await run(
      ["files", "put", "atlas", "--request", "fr_abcdefabcdef", "--secret-stdin", "--as", "yaml"],
      "x",
    );
    expect(code).toBe(2);
  });

  test("a stdin secret for a request the box does not have: refused, and the value is nowhere", async () => {
    const { code, stdout, stderr } = await run(
      ["files", "put", "atlas", "--request", "fr_abcdefabcdef", "--secret-stdin", "--as", "env"],
      `GITHUB_TOKEN=${VALUE}\n`,
    );
    expect(code).not.toBe(0);
    expect(stderr).toContain("FILE_NOT_FOUND");
    expect(`${stdout}${stderr}`).not.toContain(VALUE);
    const recorder = runRecorderFor({ home: HOME, fixture: true });
    try {
      const rows = await recorder.list({ limit: 50 });
      const row = rows.find((r) => r.command === "files put");
      expect(row).toBeDefined();
      expect(row?.args).toEqual(["atlas"]);
      expect(row?.log).toBe("[redacted]");
      for (const r of rows) expect(JSON.stringify(r)).not.toContain(VALUE);
    } finally {
      recorder.close();
    }
  });

  test("a path's name stays out of the run log", async () => {
    const { code } = await run([
      "files",
      "put",
      "atlas",
      "./FIXTURE-board-minutes.pdf",
      "--request",
      "fr_abcdefabcdef",
    ]);
    expect(code).not.toBe(0);
    const recorder = runRecorderFor({ home: HOME, fixture: true });
    try {
      for (const r of await recorder.list({ limit: 50 })) {
        expect(JSON.stringify(r)).not.toContain("FIXTURE-board-minutes");
      }
    } finally {
      recorder.close();
    }
  });

  test("decline of a request the box does not have is FILE_NOT_FOUND", async () => {
    const { code, stderr } = await run(["files", "decline", "atlas", "fr_abcdefabcdef"]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("FILE_NOT_FOUND");
  });
});
