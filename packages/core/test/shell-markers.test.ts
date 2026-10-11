/**
 * The marker grammar the desktop terminal reads out of a session (issue #18),
 * as pure functions. `tests/shell-markers.test.ts` runs the real script under a
 * real bash; this pins the parser and the program-name sanitizer against the
 * payloads that matter, including the ones the probe found wrong.
 */
import { describe, expect, test } from "bun:test";
import {
  DETACHABLE_PROGRAMS,
  SHELL_INTEGRATION_SCRIPT,
  SHELL_MARKER_OSC,
  SSH_LOGIN_USER,
  parseShellMarker,
  sanitizeProgramName,
} from "../src/shared/shell-markers.ts";
import * as schema from "../src/schema/index.ts";

describe("parseShellMarker", () => {
  test("a prompt marker carries its nonce, the trap heartbeat and the job count", () => {
    expect(parseShellMarker("A;hermetic=1;n=ab12;pre=1;jobs=2")).toEqual({
      kind: "A",
      nonce: "ab12",
      pre: true,
      jobs: 2,
    });
    expect(parseShellMarker("A;hermetic=1;n=ab12;pre=0;jobs=0")).toMatchObject({ pre: false, jobs: 0 });
  });

  test("a finished marker reads its positional exit status", () => {
    expect(parseShellMarker("D;100;n=ab12")).toEqual({ kind: "D", exit: 100, nonce: "ab12" });
    expect(parseShellMarker("D;0;n=ab12")).toMatchObject({ exit: 0 });
  });

  test("cmd= runs to the end, so a `;n=` inside a command line cannot re-pin the nonce", () => {
    const marker = parseShellMarker("C;n=real;cmd=echo a;n=forged;pre=0");
    expect(marker).toEqual({ kind: "C", nonce: "real", cmd: "echo a;n=forged;pre=0" });
  });

  test("a cmd= before the nonce leaves the marker without one", () => {
    // The script always puts `n=` first; a payload that does not is forged,
    // and the nonce check on the laptop then refuses it.
    expect(parseShellMarker("C;cmd=ls;n=forged")).toEqual({ kind: "C", cmd: "ls;n=forged" });
  });

  test("anything that is not A, C or D is not a marker", () => {
    expect(parseShellMarker("")).toBeNull();
    expect(parseShellMarker("B;n=x")).toBeNull();
    expect(parseShellMarker("a;n=x")).toBeNull();
    expect(parseShellMarker(";A;n=x")).toBeNull();
    expect(parseShellMarker("AA;n=x")).toBeNull();
  });

  test("malformed fields are dropped rather than guessed at", () => {
    expect(parseShellMarker("A;n=x;jobs=lots;pre")).toEqual({ kind: "A", nonce: "x" });
    expect(parseShellMarker("D;-1;n=x")).toEqual({ kind: "D", nonce: "x" });
    expect(parseShellMarker("D;1000;n=x")).toEqual({ kind: "D", nonce: "x" });
    // Only D has a positional field, and only in first place.
    expect(parseShellMarker("A;0;n=x")).toEqual({ kind: "A", nonce: "x" });
    expect(parseShellMarker("D;n=x;7")).toEqual({ kind: "D", nonce: "x" });
  });
});

describe("sanitizeProgramName", () => {
  test("the first word, or the second behind a wrapper", () => {
    expect(sanitizeProgramName("apt upgrade")).toBe("apt");
    // A flag is never a program name, and a flag can carry a secret.
    expect(sanitizeProgramName("-phunter2")).toBeNull();
    expect(sanitizeProgramName("sudo -u root apt")).toBeNull();
    expect(sanitizeProgramName("sudo apt upgrade")).toBe("apt");
    expect(sanitizeProgramName("time make -j8")).toBe("make");
    expect(sanitizeProgramName("nice python3 x.py")).toBe("python3");
    expect(sanitizeProgramName("nohup node server.js")).toBe("node");
    expect(sanitizeProgramName("  htop  ")).toBe("htop");
  });

  test("a bare wrapper is itself the program", () => {
    expect(sanitizeProgramName("sudo")).toBe("sudo");
  });

  test("an assignment keeps only the builtin, never the value", () => {
    expect(sanitizeProgramName("export TOKEN=x")).toBe("export");
  });

  test("anything that does not look like a program name is dropped", () => {
    expect(sanitizeProgramName("TOKEN=FIXTURE-secret make")).toBeNull();
    expect(sanitizeProgramName("FIXTURE_SENTINEL_VALUE")).toBeNull();
    expect(sanitizeProgramName("./deploy.sh")).toBeNull();
    expect(sanitizeProgramName("/usr/bin/env")).toBeNull();
    expect(sanitizeProgramName("$(curl evil)")).toBeNull();
    expect(sanitizeProgramName("a".repeat(33))).toBeNull();
    expect(sanitizeProgramName("sudo TOKEN=x")).toBeNull();
    expect(sanitizeProgramName("")).toBeNull();
    expect(sanitizeProgramName(null)).toBeNull();
    expect(sanitizeProgramName(undefined)).toBeNull();
  });
});

describe("the constants", () => {
  test("ssh lands as the AMI's default user, and the markers ride OSC 133", () => {
    expect(SSH_LOGIN_USER).toBe("hermes");
    expect(SHELL_MARKER_OSC).toBe(133);
    expect([...DETACHABLE_PROGRAMS]).toEqual(["tmux", "screen"]);
    expect(SHELL_INTEGRATION_SCRIPT).toContain("133;C;n=%s;cmd=%s");
  });

  test("the schema door opens onto the same values", () => {
    expect(schema.SSH_LOGIN_USER).toBe(SSH_LOGIN_USER);
    expect(schema.SHELL_INTEGRATION_SCRIPT).toBe(SHELL_INTEGRATION_SCRIPT);
    expect(schema.parseShellMarker).toBe(parseShellMarker);
  });
});
