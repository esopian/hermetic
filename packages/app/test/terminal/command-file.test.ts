/**
 * "Open in Terminal ↗" (`src/terminal/command-file.ts`, D6): `shellQuote`
 * against hostile strings, read back by a real `/bin/sh`; the file and its
 * directory are private; the file goes away after 60 s.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isHermeticError } from "@hermetic/core";
import {
  COMMAND_FILE_TTL_MS,
  commandFileContent,
  openInTerminal,
  shellQuote,
} from "../../src/terminal/command-file.ts";

const HOSTILE = [
  "",
  "plain",
  "it's",
  "'",
  "''",
  "a b\tc",
  "line\nbreak\n",
  "$(touch /tmp/hermetic-pwned)",
  "`id`",
  "${HOME}",
  "$HOME",
  "*",
  "~",
  "-rf",
  "FOO=bar",
  "\\'\\\\",
  ";exit 1;",
  "a|b&c>d<e",
  "é ✓ \x1b[31m",
  "!!",
];

/** What `/bin/sh` makes of `printf %s <quoted>`. */
function roundTrip(arg: string): string {
  const out = Bun.spawnSync(["/bin/sh", "-c", `printf %s ${shellQuote(arg)}`], {
    env: { PATH: "/usr/bin:/bin" },
  });
  expect(out.exitCode).toBe(0);
  return out.stdout.toString();
}

describe("shellQuote", () => {
  test("every hostile string comes back verbatim through /bin/sh", () => {
    for (const arg of HOSTILE) expect(roundTrip(arg)).toBe(arg);
  });

  test("a whole argv survives as separate words", () => {
    const argv = ["printf", "[%s]", "a b", "it's", "$(id)", "x\ny"];
    const out = Bun.spawnSync(["/bin/sh", "-c", argv.map(shellQuote).join(" ")]);
    expect(out.stdout.toString()).toBe("[a b][it's][$(id)][x\ny]");
  });

  test("NUL is refused", () => {
    let caught: unknown;
    try {
      shellQuote("a\0b");
    } catch (e) {
      caught = e;
    }
    expect(isHermeticError(caught) && caught.code === "VALIDATION").toBe(true);
  });

  test("the script execs the quoted argv", () => {
    expect(commandFileContent(["/Applications/Tailscale.app/x", "ssh", "hermes@atlas"])).toBe(
      "#!/bin/sh\n# Opened by Hermetic; removed shortly after it starts.\n" +
        "exec '/Applications/Tailscale.app/x' 'ssh' 'hermes@atlas'\n",
    );
  });
});

describe("openInTerminal", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function deps(code = 0) {
    const root = mkdtempSync(join(tmpdir(), "hermetic-cmdfile-test-"));
    roots.push(root);
    const ran: string[][] = [];
    const timers: { fn: () => void; ms: number }[] = [];
    return {
      root,
      ran,
      timers,
      deps: {
        tmpRoot: root,
        run: async (argv: string[]) => {
          ran.push(argv);
          return code;
        },
        timers: {
          setTimeout: (fn: () => void, ms: number) => {
            timers.push({ fn, ms });
            return timers.length;
          },
        },
      },
    };
  }

  test("writes a private 0700 file, opens it, removes it after 60 s", async () => {
    const d = deps();
    const { path } = await openInTerminal(["tailscale", "ssh", "hermes@atlas"], d.deps);

    expect(path.endsWith(".command")).toBe(true);
    expect(dirname(dirname(path))).toBe(d.root);
    expect(statSync(path).mode & 0o777).toBe(0o700);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(readFileSync(path, "utf8")).toContain("exec 'tailscale' 'ssh' 'hermes@atlas'\n");
    expect(d.ran).toEqual([["open", path]]);

    expect(d.timers.map((t) => t.ms)).toEqual([COMMAND_FILE_TTL_MS]);
    expect(COMMAND_FILE_TTL_MS).toBe(60_000);
    d.timers[0]?.fn();
    // The removal is async; give it a turn.
    for (let i = 0; i < 50 && existsSync(dirname(path)); i += 1) await Bun.sleep(5);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(dirname(path))).toBe(false);
  });

  test("a failed open removes the file at once and throws", async () => {
    const d = deps(1);
    const failed = await openInTerminal(["tailscale", "ssh", "hermes@atlas"], d.deps).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isHermeticError(failed)).toBe(true);
    expect(d.timers).toEqual([]);
    const opened = d.ran[0]?.[1] ?? "";
    expect(existsSync(opened)).toBe(false);
    expect(existsSync(dirname(opened))).toBe(false);
  });

  test("an argv with a NUL never reaches the disk", async () => {
    const d = deps();
    await expect(openInTerminal(["ssh", "a\0b"], d.deps)).rejects.toThrow();
    expect(d.ran).toEqual([]);
    expect(Bun.spawnSync(["ls", "-A", d.root]).stdout.toString()).toBe("");
  });
});
