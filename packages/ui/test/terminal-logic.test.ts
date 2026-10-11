/**
 * The Terminal section's page-side rules (issue #18, `logic/terminal-logic.ts`):
 * keystroke chunking, the ack cadence, which frames a screen keeps, and the
 * labels a remote-controlled title is allowed to become.
 */
import { describe, expect, test } from "bun:test";
import {
  ACK_EVERY,
  AttachLedger,
  INPUT_CHUNK,
  TITLE_MAX,
  bytesOf,
  chunkBinary,
  chunkText,
  endedLine,
  sanitizeTitle,
  sessionHint,
  sessionLabel,
  skippedNote,
  terminalSubline,
} from "../src/logic/terminal-logic.ts";
import { commandOf } from "../src/components/agent/useSshCommand.ts";
import { linkHandlerFor } from "../src/components/agent/xterm-adapter.ts";

describe("chunkText", () => {
  test("a keystroke is one chunk; nothing is none", () => {
    expect(chunkText("a")).toEqual(["a"]);
    expect(chunkText("")).toEqual([]);
  });

  test("a paste is cut at the limit, in order, losing nothing", () => {
    const paste = "x".repeat(INPUT_CHUNK * 2 + 5);
    const chunks = chunkText(paste);
    expect(chunks.map((c) => c.length)).toEqual([INPUT_CHUNK, INPUT_CHUNK, 5]);
    expect(chunks.join("")).toBe(paste);
  });

  test("a surrogate pair at the cut stays whole", () => {
    const paste = `${"x".repeat(INPUT_CHUNK - 1)}😀tail`;
    const chunks = chunkText(paste);
    expect(chunks[0]?.length).toBe(INPUT_CHUNK - 1);
    expect(chunks[1]?.startsWith("😀")).toBe(true);
    expect(chunks.join("")).toBe(paste);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(INPUT_CHUNK);
  });
});

describe("chunkBinary", () => {
  test("byte strings go out as base64 chunks of at most the limit", () => {
    const bytes = String.fromCharCode(0x1b, 0x5b, 0x4d, 0xff, 0x80);
    expect(chunkBinary(bytes)).toEqual([btoa(bytes)]);
    const big = "\x01".repeat(INPUT_CHUNK + 1);
    const chunks = chunkBinary(big);
    expect(chunks.map((c) => atob(c).length)).toEqual([INPUT_CHUNK, 1]);
  });

  test("bytesOf reverses base64 to the exact bytes", () => {
    expect([...bytesOf(btoa("\x00\xff\x1b"))]).toEqual([0, 255, 27]);
  });
});

describe("AttachLedger", () => {
  test("acks only once ACK_EVERY has been parsed since the last ack", () => {
    const ledger = new AttachLedger();
    expect(ledger.snapshot(0, 1000).draw).toBe(true);
    expect(ledger.data(0, 1000 + ACK_EVERY - 1)).toBe(true);
    expect(ledger.parsed(0, 1000 + ACK_EVERY - 1)).toBeNull();
    expect(ledger.data(0, 1000 + ACK_EVERY)).toBe(true);
    expect(ledger.parsed(0, 1000 + ACK_EVERY)).toBe(1000 + ACK_EVERY);
    // The next ack is a whole window later, not one byte later.
    expect(ledger.parsed(0, 1000 + ACK_EVERY + 10)).toBeNull();
    expect(ledger.parsed(0, 1000 + 2 * ACK_EVERY)).toBe(1000 + 2 * ACK_EVERY);
  });

  test("frames from an older generation are dropped, and so are their acks", () => {
    const ledger = new AttachLedger();
    ledger.snapshot(1, 0);
    expect(ledger.data(0, 10)).toBe(false);
    expect(ledger.snapshot(0, 50).draw).toBe(false);
    expect(ledger.generation).toBe(1);
    ledger.snapshot(2, 100);
    // A parse callback for gen 1 landing after the resync acks nothing.
    expect(ledger.parsed(1, 100 + ACK_EVERY)).toBeNull();
  });

  test("a resync reports the bytes it skipped; the first snapshot skips none", () => {
    const ledger = new AttachLedger();
    expect(ledger.snapshot(0, 4096).skipped).toBe(0);
    ledger.data(0, 8192);
    const resync = ledger.snapshot(1, 8192 + 600 * 1024);
    expect(resync).toEqual({ draw: true, skipped: 600 * 1024 });
    expect(skippedNote(resync.skipped)).toBe("[skipped 600 KiB to catch up]");
    expect(skippedNote(1536)).toBe("[skipped 1.5 KiB to catch up]");
  });
});

describe("sanitizeTitle", () => {
  test("controls and bidi overrides go; whitespace collapses", () => {
    expect(sanitizeTitle("hermes@atlas:\u0007 ~\u001b")).toBe("hermes@atlas: ~");
    expect(sanitizeTitle("‮evil‬  name")).toBe("evil name");
  });

  test("capped at TITLE_MAX with an ellipsis", () => {
    const title = sanitizeTitle("a".repeat(40));
    expect([...(title ?? "")].length).toBe(TITLE_MAX);
    expect(title?.endsWith("…")).toBe(true);
  });

  test("nothing printable left is no title", () => {
    expect(sanitizeTitle("\u0007\u001b ")).toBeNull();
  });
});

describe("labels", () => {
  const live = { index: 1, state: "live" as const };
  test("idle reads the title, busy reads the program and never its arguments", () => {
    expect(sessionLabel({ ...live, activity: { state: "idle" } }, null)).toBe("1 · bash");
    expect(sessionLabel({ ...live, activity: { state: "idle" } }, "htop")).toBe("1 · htop");
    expect(
      sessionLabel({ ...live, activity: { state: "busy", cmd: "sudo apt upgrade -y" } }, "x"),
    ).toBe("1 · apt ●");
    expect(sessionLabel({ index: 2, state: "ended", activity: { state: "idle" } }, "x")).toBe(
      "2 · ended",
    );
  });

  test("unknown activity says so on hover", () => {
    expect(sessionHint({ state: "live", activity: { state: "unknown" } })).toBe("activity unknown");
    expect(sessionHint({ state: "live", activity: { state: "idle" } })).toBeUndefined();
  });

  test("the ended line names how it ended", () => {
    expect(endedLine({ code: 0, signal: null, reason: "exited" }, 192_000)).toBe(
      "[session ended · exit 0 · 3m 12s]",
    );
    expect(endedLine({ code: 255, signal: null, reason: "acl_denied" }, null)).toBe(
      "[session ended · denied by tailnet policy]",
    );
    expect(endedLine({ code: 0, signal: null, reason: "no_login_shell" }, 2_000)).toBe(
      "[session ended · no login shell for hermes · 2s]",
    );
  });

  test("the ssh command quotes only what needs it", () => {
    expect(commandOf(["tailscale", "ssh", "hermes@atlas.tail4b7e2.ts.net"])).toBe(
      "tailscale ssh hermes@atlas.tail4b7e2.ts.net",
    );
    expect(commandOf(["a b", "it's"])).toBe(`'a b' 'it'\\''s'`);
  });
});

describe("terminalSubline", () => {
  const row = (
    over: Partial<{ state: "live" | "ended"; unseen: boolean; cmd: string; busy: boolean }>,
  ) => ({
    state: over.state ?? ("live" as const),
    unseen: over.unseen ?? false,
    activity: over.busy ? { state: "busy", cmd: over.cmd } : { state: "idle" },
  });

  test("every form the nav names", () => {
    expect(terminalSubline({ status: "ready", sessions: [], problem: null })).toEqual({
      text: "tailscale ssh · no session",
      accent: false,
    });
    expect(terminalSubline({ status: "stopped", sessions: [row({})], problem: null }).text).toBe(
      "instance stopped",
    );
    expect(terminalSubline({ status: "ready", sessions: [], problem: "TAILSCALE_MISSING" }).text).toBe(
      "tailscale not found",
    );
    expect(terminalSubline({ status: "ready", sessions: [row({})], problem: null })).toEqual({
      text: "1 session",
      accent: true,
    });
    expect(
      terminalSubline({
        status: "ready",
        sessions: [row({ busy: true, cmd: "apt upgrade" })],
        problem: null,
      }).text,
    ).toBe("running: apt");
    expect(
      terminalSubline({ status: "ready", sessions: [row({}), row({ unseen: true })], problem: null })
        .text,
    ).toBe("2 sessions · 1 new output");
  });
});

describe("linkHandlerFor", () => {
  test("an OSC 8 link goes to the app's door, and xterm is told http(s) only", () => {
    const opened: string[] = [];
    const handler = linkHandlerFor((url) => opened.push(url));
    handler.activate({} as MouseEvent, "https://login.tailscale.com/a/abc");
    expect(opened).toEqual(["https://login.tailscale.com/a/abc"]);
    expect(handler.allowNonHttpProtocols).toBe(false);
  });
});
