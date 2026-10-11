/**
 * The fixture's canned shell (`pty-fixture.ts`): the prompt, echo, the
 * commands it answers, and OSC 133 markers in the grammar the real
 * integration prints (`parseShellMarker` reads them back).
 */
import { describe, expect, test } from "bun:test";
import { type ShellMarker, parseShellMarker } from "@hermetic/core/shared";
import type { PtyLike } from "../../src/terminal/pty.ts";
import { createFixturePty, fixturePtySpawner } from "../../src/terminal/pty-fixture.ts";
import { FakeTimers } from "./fake-timers.ts";

const ESC = "\x1b";
const BEL = "\x07";
/** One OSC 133 marker, BEL-terminated as the integration prints it. */
const OSC_133 = new RegExp(`${ESC}\\]133;([^${BEL}]*)${BEL}`, "g");

function open(timers = new FakeTimers()): {
  pty: PtyLike;
  timers: FakeTimers;
  out(): string;
  markers(): ShellMarker[];
} {
  const pty = createFixturePty({ host: "atlas", cols: 80, rows: 24, timers, nonce: "abc123" });
  const decoder = new TextDecoder();
  let text = "";
  pty.onData((bytes) => {
    text += decoder.decode(bytes, { stream: true });
  });
  return {
    pty,
    timers,
    out: () => text,
    markers: () =>
      [...text.matchAll(OSC_133)].map((m) => parseShellMarker(m[1] ?? "")).filter((m) => m !== null),
  };
}

/** The visible text: markers stripped. */
const visible = (s: string): string => s.replace(OSC_133, "");

describe("fixture pty", () => {
  test("logs in to a prompt preceded by an A marker with the nonce, pre=1 and jobs=0", () => {
    const { out, markers } = open();
    expect(visible(out())).toEndWith("hermes@atlas:~$ ");
    expect(markers()).toEqual([{ kind: "A", nonce: "abc123", pre: true, jobs: 0 }]);
  });

  test("echoes typed input, runs the line, and brackets it with C and D", () => {
    const { pty, out, markers } = open();
    pty.write("whoami\r");
    expect(visible(out())).toContain("$ whoami\r\nhermes\r\nhermes@atlas:~$ ");
    expect(markers().map((m) => m.kind)).toEqual(["A", "C", "D", "A"]);
    expect(markers()[1]).toEqual({ kind: "C", nonce: "abc123", cmd: "whoami" });
    expect(markers()[2]).toEqual({ kind: "D", exit: 0, nonce: "abc123" });
  });

  test("hostname, ls, uptime, df and help answer; an unknown command is 127", () => {
    const { pty, out, markers } = open();
    pty.write("hostname\rls\ruptime\rdf -h /data\rhelp\rfrobnicate\r");
    const text = visible(out());
    expect(text).toContain("hostname\r\natlas\r\n");
    expect(text).toContain("load average");
    expect(text).toContain("/data");
    expect(text).toContain("fixture shell:");
    expect(text).toContain("-bash: frobnicate: command not found");
    expect(markers().find((m) => m.kind === "C" && m.cmd === "df -h")).toBeDefined();
    expect(
      markers()
        .filter((m) => m.kind === "D")
        .map((m) => m.exit),
    ).toEqual([0, 0, 0, 0, 0, 127]);
  });

  test("backspace edits the line; Ctrl-C at the prompt abandons it with no C or D", () => {
    const { pty, out, markers } = open();
    pty.write("whoamx\x7fi\r");
    expect(visible(out())).toContain("whoamx\b \bi\r\nhermes");
    pty.write("partial\x03");
    expect(visible(out())).toEndWith("partial^C\r\nhermes@atlas:~$ ");
    expect(markers().map((m) => m.kind)).toEqual(["A", "C", "D", "A", "A"]);
  });

  test("an empty line draws a prompt with no command markers", () => {
    const { pty, markers } = open();
    pty.write("\r");
    expect(markers().map((m) => m.kind)).toEqual(["A", "A"]);
  });

  test("sleep N is busy for N seconds of the injected clock, then D", () => {
    const { pty, timers, markers } = open();
    pty.write("sleep 2\r");
    expect(markers().map((m) => m.kind)).toEqual(["A", "C"]);
    timers.advance(1999);
    expect(markers().map((m) => m.kind)).toEqual(["A", "C"]);
    timers.advance(1);
    expect(markers().map((m) => m.kind)).toEqual(["A", "C", "D", "A"]);
  });

  test("Ctrl-C interrupts a sleep with status 130 and discards the typeahead", () => {
    const { pty, timers, out, markers } = open();
    pty.write("sleep 60\rxyz\x03");
    expect(markers().at(-2)).toEqual({ kind: "D", exit: 130, nonce: "abc123" });
    expect(visible(out())).not.toContain("xyz");
    timers.advance(60_000);
    expect(markers().filter((m) => m.kind === "D")).toHaveLength(1);
  });

  test("keys typed during a sleep run after it", () => {
    const { pty, timers, out, markers } = open();
    pty.write("sleep 1\rhost");
    pty.write("name\r");
    expect(visible(out())).not.toContain("hostname");
    timers.advance(1000);
    expect(visible(out())).toEndWith("$ hostname\r\natlas\r\nhermes@atlas:~$ ");
    expect(markers().map((m) => (m.kind === "C" ? m.cmd : m.kind))).toEqual([
      "A",
      "sleep 1",
      "D",
      "A",
      "hostname",
      "D",
      "A",
    ]);
  });

  test("printf '\\a' rings the bell and clear clears the screen", () => {
    const { pty, out } = open();
    pty.write("printf '\\a'\r");
    expect(out()).toContain("\r\n\x1b]133;C;n=abc123;cmd=printf '\\a'\x07\x07");
    pty.write("clear\r");
    expect(out()).toContain("\x1b[H\x1b[2J\x1b[3J");
  });

  test("exit ends with its status; Ctrl-D on an empty line ends with 0", async () => {
    const first = open();
    first.pty.write("exit 3\r");
    expect(visible(first.out())).toEndWith("logout\r\n");
    expect(await first.pty.exited).toEqual({ code: 3, signal: null });
    first.pty.write("whoami\r");
    expect(visible(first.out())).not.toContain("hermes\r\n");

    const second = open();
    second.pty.write("\x04");
    expect(await second.pty.exited).toEqual({ code: 0, signal: null });
  });

  test("SIGSTOP holds output until SIGCONT; SIGHUP and close end it by signal", async () => {
    const { pty, out } = open();
    pty.signalGroup("SIGSTOP");
    pty.write("whoami\r");
    expect(visible(out())).not.toContain("whoami");
    pty.signalGroup("SIGCONT");
    expect(visible(out())).toContain("whoami\r\nhermes");
    pty.signalGroup("SIGHUP");
    expect(await pty.exited).toEqual({ code: null, signal: "SIGHUP" });

    const other = open();
    other.pty.close();
    expect(await other.pty.exited).toEqual({ code: null, signal: "SIGHUP" });
  });

  test("the spawner reads the host off the ssh argv", () => {
    const pty = fixturePtySpawner({ timers: new FakeTimers() })(["tailscale", "ssh", "hermes@corvid"], {
      cols: 80,
      rows: 24,
    });
    let text = "";
    pty.onData((b) => {
      text += new TextDecoder().decode(b);
    });
    expect(text).toEndWith("hermes@corvid:~$ ");
  });
});
