/**
 * The command line tool shim.
 *
 * Nothing here touches `/usr/local/bin` or runs `osascript`. Both writes land
 * in a `mkdtemp` directory: the ordinary one through the injected `write`, and
 * the elevated one by taking the shell script `osascript` would have been given
 * and running it through a real `sh`. Asserting the resulting bytes rather than
 * a pinned argv string is deliberate — a pinned string agrees with whatever the
 * module currently emits, including a shim that `exec`s the wrong path.
 */
import { spawnSync } from "bun";
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isHermeticError } from "@hermetic/core";
import { DEFAULT_CLI_TARGET, installCli, shimContent } from "../../src/main/cli-install.ts";

/**
 * The inverse of the module's AppleScript quoting: strip the surrounding
 * `do shell script "…" with administrator privileges` and undo `\"` and `\\`,
 * which is exactly what AppleScript does before handing the string to `sh`.
 */
function unwrapAppleScriptLiteral(expression: string): string {
  const literal = expression.slice("do shell script ".length, -" with administrator privileges".length);
  // One pass, not two `replaceAll`s: unescaping quotes first would turn an
  // escaped backslash followed by a quote back into a quote of its own.
  return literal.slice(1, -1).replace(/\\(.)/g, "$1");
}

const BIN = "/Applications/Hermetic.app/Contents/Resources/app/bin";
const silentLog = { line: () => {} };

/** A filesystem error the way `node:fs` raises one, since that is what is sniffed. */
function eacces(): Error & { code: string } {
  return Object.assign(new Error("permission denied"), { code: "EACCES" });
}

function realWrite(path: string, content: string, mode: number): void {
  writeFileSync(path, content);
  chmodSync(path, mode);
}

describe("the shim", () => {
  test("is exactly the two lines the plan pins", () => {
    expect(shimContent(BIN)).toBe(
      `#!/bin/sh\nexec "/Applications/Hermetic.app/Contents/Resources/app/bin/hermetic" "$@"\n`,
    );
  });

  test("defaults to the path `which hermetic` looks at", () => {
    expect(DEFAULT_CLI_TARGET).toBe("/usr/local/bin/hermetic");
  });
});

describe("running from a mounted disk image", () => {
  test("is refused, and the message says to move the app first", async () => {
    const promise = installCli({
      bundleBin: "/Volumes/Hermetic 1.2/Hermetic.app/Contents/Resources/app/bin",
      target: "/tmp/never-written",
      write: () => {
        throw new Error("must not write");
      },
      spawn: async () => {
        throw new Error("must not elevate");
      },
      log: silentLog,
    });
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isHermeticError(error) && error.code).toBe("UNSUPPORTED");
    expect(isHermeticError(error) && error.message).toContain("/Applications");
  });

  test("a path that merely starts with the same letters is not one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hermetic-cli-"));
    const target = join(dir, "hermetic");
    const result = await installCli({
      bundleBin: "/Volumes2/Hermetic.app/bin",
      target,
      write: realWrite,
      spawn: async () => ({ exitCode: 1 }),
      log: silentLog,
    });
    expect(result).toEqual({ path: target, elevated: false });
  });
});

describe("the ordinary write", () => {
  test("lands the shim, executable, and reports that nobody was asked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hermetic-cli-"));
    const target = join(dir, "hermetic");
    const result = await installCli({
      bundleBin: BIN,
      target,
      write: realWrite,
      spawn: async () => {
        throw new Error("must not elevate");
      },
      log: silentLog,
    });

    expect(result).toEqual({ path: target, elevated: false });
    expect(readFileSync(target, "utf8")).toBe(shimContent(BIN));
    expect(statSync(target).mode & 0o777).toBe(0o755);
  });
});

describe("an unwritable target", () => {
  test("is retried once, through osascript, and writes the same bytes", async () => {
    // A path with a space, because the quoting is the whole risk here.
    const bin = "/Applications/Hermetic 1.2.app/Contents/Resources/app/bin";
    const target = join(mkdtempSync(join(tmpdir(), "hermetic-cli-")), "hermetic");
    const calls: string[][] = [];
    const result = await installCli({
      bundleBin: bin,
      target,
      write: () => {
        throw eacces();
      },
      spawn: async (argv) => {
        calls.push(argv);
        return { exitCode: 0 };
      },
      log: silentLog,
    });

    expect(result).toEqual({ path: target, elevated: true });
    expect(calls).toHaveLength(1);
    const argv = calls[0] ?? [];

    // Shape: the command is `osascript`, one `-e` expression, elevated, and it
    // names nothing but the two paths.
    expect(argv[0]).toBe("osascript");
    expect(argv[1]).toBe("-e");
    expect(argv).toHaveLength(3);
    const expression = argv[2] ?? "";
    expect(expression.startsWith("do shell script ")).toBe(true);
    expect(expression.endsWith(" with administrator privileges")).toBe(true);
    expect(expression.replaceAll(bin, "").replaceAll(target, "")).not.toContain("/Users");

    // The assertion that matters: the script AppleScript would hand to `sh`,
    // run through a real `sh`, has to produce `shimContent` byte for byte. A
    // pinned argv string would have gone stale silently; these bytes cannot.
    // `osascript` itself is never invoked — only the payload it would unwrap.
    const script = unwrapAppleScriptLiteral(expression);
    const run = spawnSync(["/bin/sh", "-c", script]);
    expect(run.exitCode).toBe(0);
    expect(readFileSync(target, "utf8")).toBe(shimContent(bin));
    expect(statSync(target).mode & 0o777).toBe(0o755);
  });

  test("refuses when the authorised attempt is refused too, without a third try", async () => {
    let attempts = 0;
    const error = await installCli({
      bundleBin: BIN,
      target: "/usr/local/bin/hermetic",
      write: () => {
        throw eacces();
      },
      spawn: async () => {
        attempts += 1;
        return { exitCode: 1 };
      },
      log: silentLog,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(attempts).toBe(1);
    expect(isHermeticError(error) && error.code).toBe("FORBIDDEN");
  });

  test("a failure that is not a permission problem is not answered with a password prompt", async () => {
    const error = await installCli({
      bundleBin: BIN,
      target: "/usr/local/bin/hermetic",
      write: () => {
        throw Object.assign(new Error("no such directory"), { code: "ENOENT" });
      },
      spawn: async () => {
        throw new Error("must not elevate");
      },
      log: silentLog,
    }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(Error);
    expect(isHermeticError(error)).toBe(false);
  });
});
