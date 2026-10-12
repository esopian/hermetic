/**
 * The real PTY (`pty-bun.ts`): a real `/bin/cat` behind `Bun.spawn({ terminal })`.
 *
 * Skipped where the runtime has no PTY support (`Bun.Terminal` absent, or
 * Windows): there is nothing there for the terminal to run on, and the rest of
 * the transport is covered against the fixture PTY.
 */
import { describe, expect, test } from "bun:test";
import type { PtyLike, PtySignal } from "../../src/terminal/pty.ts";
import { ptyEnv, signalProcessGroup, spawnBunPty } from "../../src/terminal/pty-bun.ts";

const PTY_SUPPORTED = typeof Bun.Terminal === "function" && process.platform !== "win32";
if (!PTY_SUPPORTED) {
  // The reason a suite skipped belongs in its output.
  console.warn("pty-bun.test.ts: skipped — this runtime cannot spawn a process behind a PTY");
}

/** Collects output until `predicate` holds over the decoded text, or fails after `ms`. */
function collect(pty: PtyLike): {
  text(): string;
  until(predicate: (s: string) => boolean, ms?: number): Promise<string>;
} {
  const decoder = new TextDecoder();
  let text = "";
  const waiters: (() => void)[] = [];
  pty.onData((bytes) => {
    text += decoder.decode(bytes, { stream: true });
    for (const w of waiters.splice(0)) w();
  });
  return {
    text: () => text,
    async until(predicate, ms = 5000) {
      const deadline = Date.now() + ms;
      while (!predicate(text)) {
        if (Date.now() > deadline) throw new Error(`timed out; got ${JSON.stringify(text)}`);
        await Promise.race([new Promise<void>((r) => waiters.push(r)), Bun.sleep(50)]);
      }
      return text;
    },
  };
}

describe.skipIf(!PTY_SUPPORTED)("spawnBunPty", () => {
  test("echoes what is written and reports the exit code from the process", async () => {
    const pty = spawnBunPty(["/bin/cat"], { cols: 80, rows: 24 });
    const out = collect(pty);
    pty.write("hello pty\r");
    // Once by the line discipline's echo, once by cat itself.
    await out.until((s) => s.split("hello pty").length - 1 >= 2);
    pty.write("\x04");
    expect(await pty.exited).toEqual({ code: 0, signal: null });
    pty.close();
  });

  test("a group signal ends the process and is reported as the signal, not a code", async () => {
    const pty = spawnBunPty(["/bin/sleep", "30"], { cols: 80, rows: 24 });
    pty.signalGroup("SIGHUP");
    expect(await pty.exited).toEqual({ code: null, signal: "SIGHUP" });
    // The group is gone now: signalling it again is not an error.
    expect(() => pty.signalGroup("SIGKILL")).not.toThrow();
    pty.close();
  });

  test("after the exit, a group signal is never sent: the pgid may belong to someone else now", async () => {
    const sent: [number, PtySignal][] = [];
    const pty = spawnBunPty(
      ["/bin/sleep", "30"],
      { cols: 80, rows: 24 },
      {
        kill: (pid, sig) => {
          sent.push([pid, sig]);
          process.kill(pid, sig);
        },
      },
    );
    pty.signalGroup("SIGHUP");
    await pty.exited;
    pty.signalGroup("SIGHUP");
    pty.signalGroup("SIGKILL");
    expect(sent).toEqual([[-pty.pid, "SIGHUP"]]);
    pty.close();
  });

  test("resize reaches the PTY", async () => {
    const pty = spawnBunPty(["/bin/sh", "-c", "read _; stty size"], { cols: 80, rows: 24 });
    const out = collect(pty);
    pty.resize(132, 40);
    pty.write("\r");
    await out.until((s) => s.includes("40 132"));
    await pty.exited;
    pty.close();
  });

  test("the child sees the PATH-safe environment, not the app's", async () => {
    // Keep the shell alive until its output is consumed. A short-lived env
    // leader can deadlock Bun 1.4's PTY exit wait in the full test process.
    const pty = spawnBunPty(
      ["/bin/sh", "-c", "/usr/bin/env; read _"],
      { cols: 80, rows: 24, env: { HERMETIC_EXTRA: "yes" } },
      { env: { PATH: "/usr/bin:/bin", AWS_SECRET_ACCESS_KEY: "FIXTURE_SECRET", LC_ALL: "C" } },
    );
    const out = collect(pty);
    const text = await out.until((s) => s.includes("HERMETIC_EXTRA"));
    expect(text).toContain("TERM=xterm-256color");
    expect(text).toContain("LC_ALL=C");
    expect(text).not.toContain("FIXTURE_SECRET");
    pty.write("\r");
    await pty.exited;
    pty.close();
  });
});

describe("ptyEnv", () => {
  test("keeps only PATH, HOME, USER, LANG, SHELL and LC_*, then TERM, then the extras", () => {
    const env = ptyEnv(
      {
        PATH: "/bin",
        HOME: "/h",
        USER: "u",
        LANG: "en_US.UTF-8",
        SHELL: "/bin/zsh",
        LC_CTYPE: "UTF-8",
        TERM: "dumb",
        AWS_PROFILE: "FIXTURE",
        GITHUB_TOKEN: "FIXTURE",
        UNSET: undefined,
      },
      { EXTRA: "1" },
    );
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/h",
      USER: "u",
      LANG: "en_US.UTF-8",
      SHELL: "/bin/zsh",
      LC_CTYPE: "UTF-8",
      TERM: "xterm-256color",
      EXTRA: "1",
    });
  });
});

describe("signalProcessGroup", () => {
  test("signals the negated pid and swallows only ESRCH", () => {
    const calls: [number, PtySignal][] = [];
    signalProcessGroup(42, "SIGSTOP", (pid, sig) => calls.push([pid, sig]));
    expect(calls).toEqual([[-42, "SIGSTOP"]]);

    const gone = Object.assign(new Error("no such process"), { code: "ESRCH" });
    expect(() =>
      signalProcessGroup(42, "SIGHUP", () => {
        throw gone;
      }),
    ).not.toThrow();
    const denied = Object.assign(new Error("not permitted"), { code: "EPERM" });
    expect(() =>
      signalProcessGroup(42, "SIGHUP", () => {
        throw denied;
      }),
    ).toThrow("not permitted");
  });
});
