/**
 * The shell-integration seam (issue #18, spec §3): the box half and the laptop
 * half of the OSC 133 markers, run against each other.
 *
 * The box sources core's `SHELL_INTEGRATION_SCRIPT` into every interactive
 * bash (`packages/agentd/src/apply/shell.ts`); the desktop app parses what it
 * prints with `ShellActivity` (`packages/app/src/terminal/activity.ts`). Neither
 * package may import the other, so this is where the two meet: the real script
 * under a local `bash --noprofile --rcfile <tmp> -i` in a Bun PTY, its output
 * through a headless xterm and the real parser.
 *
 * It must pass on macOS's `/bin/bash` 3.2 and on Linux bash 5. No network, no
 * real home: the rcfile and `HOME` are a fresh temp directory.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHELL_INTEGRATION_SCRIPT } from "@hermetic/core/shared";
import {
  type Activity,
  ShellActivity,
  createHeadlessTerminal,
} from "../packages/app/src/terminal/activity.ts";

const BASH = ["/bin/bash", "/usr/bin/bash"].find((p) => existsSync(p)) ?? null;
const FORGED_NONCE = "0000";

/** Waits for `pred`, polling; fails with `label` at the deadline. */
async function until(pred: () => boolean, label: string, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await Bun.sleep(25);
  }
}

describe.skipIf(BASH === null)("shell integration under a real bash (no bash: skipped)", () => {
  let home: string;
  let proc: ReturnType<typeof Bun.spawn>;
  let activity: ShellActivity;
  const seen: string[] = [];
  const state = (): Activity => activity.activity;
  const send = (text: string) => proc.terminal?.write(text);

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "hermetic-shell-markers-"));
    const rcfile = join(home, "shell-integration.bash");
    writeFileSync(rcfile, SHELL_INTEGRATION_SCRIPT);
    const term = createHeadlessTerminal(100, 30);
    activity = new ShellActivity(term);
    // Registered after the parser, so xterm asks it first; returning false
    // passes every marker on. It records what arrived, accepted or not.
    term.parser.registerOscHandler(133, (data) => {
      seen.push(data);
      return false;
    });
    proc = Bun.spawn([BASH as string, "--noprofile", "--rcfile", rcfile, "-i"], {
      cwd: home,
      env: { PATH: "/usr/bin:/bin", HOME: home, TERM: "xterm-256color" },
      terminal: { cols: 100, rows: 30, data: (_t, bytes) => term.write(bytes) },
    });
  });

  afterAll(async () => {
    proc.kill("SIGKILL");
    await proc.exited;
    rmSync(home, { recursive: true, force: true });
  });

  test("idle → busy → idle, background jobs, a forged marker, trap removal", async () => {
    await until(() => activity.nonce !== null && state().state === "idle", "the first prompt");
    expect(activity.nonce).toMatch(/^[0-9a-f]{18}$/);

    send("sleep 1\r");
    await until(() => state().state === "busy", "sleep 1 to start");
    expect(state()).toEqual({ state: "busy", cmd: "sleep 1" });
    expect(activity.busyForQuit()).toEqual({ busy: true, label: "sleep 1" });
    await until(() => state().state === "idle", "sleep 1 to finish", 3000);

    send("sleep 30 &\r");
    await until(() => state().jobs === 1, "the background job");
    expect(state()).toEqual({ state: "busy", jobs: 1 });
    send("kill %1\r");
    // bash reaps the killed job on the prompt after next.
    await until(() => {
      if (state().state !== "idle") send("\r");
      return state().state === "idle";
    }, "the job to be gone");

    // A running command prints a prompt marker claiming idle, under a nonce
    // it made up. The session must stay busy.
    send(`printf '\\033]133;A;hermetic=1;n=${FORGED_NONCE};pre=1;jobs=0\\007'; sleep 1\r`);
    await until(() => seen.some((d) => d.includes(`n=${FORGED_NONCE};pre=1`)), "the forged marker");
    // The forged marker was parsed before this point; the parser ignored it.
    expect(state().state).toBe("busy");
    expect(state().cmd?.startsWith("printf")).toBe(true);
    expect(activity.nonce).not.toBe(FORGED_NONCE);
    await until(() => state().state === "idle", "the forged-marker command to finish", 3000);

    // Something replaced the DEBUG trap: the next prompt says `pre=0`.
    send("trap - DEBUG\r");
    await until(() => state().state === "unknown", "unknown after trap removal");

    send("exit\r");
    await proc.exited;
  }, 15_000);
});
