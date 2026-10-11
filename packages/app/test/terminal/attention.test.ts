/**
 * The terminal attention rules (`src/terminal/attention.ts`, D10).
 *
 * The first block replays the eight scenarios of the docker probe
 * (`.context/issue-18-terminal/probe/notify-results.txt`) as transcripts on a
 * fake clock: the session's output and markers at the times the probe saw
 * them, the operator leaving and coming back. The probe's "expected" column is
 * the spec. The rest pin each rule and gate on its own.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { ShellMarker } from "@hermetic/core/shared";
import type { Activity, ActivitySource } from "../../src/terminal/activity.ts";
import {
  Attention,
  type AttentionEvent,
  EVENT_GAP_MS,
  GRACE_MS,
  PrintableScanner,
} from "../../src/terminal/attention.ts";
import type { TimerHandle, Timers } from "../../src/terminal/timers.ts";

class FakeTimers implements Timers {
  private t = 0;
  private seq = 0;
  private readonly pending = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    this.seq += 1;
    this.pending.set(this.seq, { at: this.t + ms, fn });
    return this.seq;
  }

  clearTimeout(handle: TimerHandle): void {
    this.pending.delete(handle as number);
  }

  /** Move the clock to `at`, running every timer that falls due on the way, in order. */
  advanceTo(at: number): void {
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of this.pending) if (next === null || entry[1].at < next[1].at) next = entry;
      if (next === null || next[1].at > at) break;
      this.pending.delete(next[0]);
      this.t = Math.max(this.t, next[1].at);
      next[1].fn();
    }
    this.t = Math.max(this.t, at);
  }
}

/** The parser's half, driven by hand: state first, then the accepted marker, as `ShellActivity` does. */
class FakeActivity implements ActivitySource {
  nonce: string | null = null;
  activity: Activity = { state: "unknown" };
  private readonly listeners = new Set<(m: ShellMarker) => void>();

  onMarker(cb: (m: ShellMarker) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  emit(marker: ShellMarker, next: Activity | null): void {
    if (marker.kind === "A" && this.nonce === null) this.nonce = "n0nce";
    if (next !== null) this.activity = next;
    for (const cb of this.listeners) cb(marker);
  }

  prompt(): void {
    this.emit({ kind: "A", nonce: "n0nce", pre: true, jobs: 0 }, { state: "idle" });
  }

  start(cmd: string): void {
    this.emit({ kind: "C", nonce: "n0nce", cmd }, { state: "busy", cmd });
  }

  finish(exit: number): void {
    this.emit({ kind: "D", nonce: "n0nce", exit }, null);
    this.prompt();
  }
}

function harness(opts: { integration?: boolean } = {}) {
  const timers = new FakeTimers();
  const activity = new FakeActivity();
  const raised: (AttentionEvent & { at: number })[] = [];
  let flushes = 0;
  let line = "";
  let alerts = true;
  const attention = new Attention({
    timers,
    activity,
    cursorLine: () => line,
    alertsOn: () => alerts,
    raise: (e) => raised.push({ ...e, at: timers.now() }),
    flush: () => {
      flushes += 1;
    },
  });
  if (opts.integration !== false) activity.prompt();
  const h = {
    timers,
    activity,
    attention,
    raised,
    flushes: () => flushes,
    setAlerts: (on: boolean) => {
      alerts = on;
    },
    at: (ms: number) => timers.advanceTo(ms),
    /** Printed output; the last line is what the cursor sits on. */
    out: (text: string) => {
      attention.output(new TextEncoder().encode(text));
      const lines = text.split(/\r?\n/);
      line = lines[lines.length - 1] ?? "";
    },
    look: () => attention.view(true),
    leave: () => attention.view(false),
    kinds: () => raised.map((e) => e.event),
  };
  return h;
}

type H = ReturnType<typeof harness>;

/** A command line typed and started: the echo, then its `C` marker. */
function run(h: H, cmd: string): void {
  h.out(`${cmd}\r\n`);
  h.activity.start(cmd.split(/\s+/).slice(0, 2).join(" "));
}

/** It ended: `D`, the next `A`, and the prompt it drew. */
function done(h: H, exit = 0): void {
  h.activity.finish(exit);
  h.out("\x1b[32mhermes@atlas\x1b[0m:~$ ");
}

describe("the probe's eight scenarios (notify-results.txt)", () => {
  test("1. idle shell, operator leaves for 6 s → nothing", () => {
    const h = harness();
    h.out("hermes@atlas:~$ ");
    h.at(400);
    h.leave();
    h.at(6400);
    expect(h.raised).toEqual([]);
  });

  test("2. types `ls`, leaves at once → nothing, inside the grace", () => {
    const h = harness();
    h.at(400);
    h.leave();
    h.at(420);
    run(h, "ls /");
    h.out("bin  boot  dev  etc  home  lib  usr  var\r\n");
    done(h);
    h.at(4400);
    expect(h.raised).toEqual([]);
  });

  test("3. sleep 12; echo done → output + finished", () => {
    const h = harness();
    run(h, "sleep 12; echo done");
    h.at(300);
    h.leave();
    h.at(12_010);
    h.out("done\r\n");
    done(h, 0);
    h.at(13_800);
    expect(h.raised).toEqual([
      { event: "output", program: "sleep", at: 12_010 },
      { event: "finished", program: "sleep", exit_code: 0, ran_ms: 12_010, at: 12_010 },
    ]);
    expect(h.flushes()).toBe(2);
  });

  test("4. a line every 1 s for 12 s → exactly one output (and the finish)", () => {
    const h = harness();
    run(h, "for i in $(seq 12); do date +%T; sleep 1; done");
    h.out("12:00:00\r\n");
    h.at(300);
    h.leave();
    for (let s = 1; s < 12; s += 1) {
      h.at(s * 1000);
      h.out(`12:00:${String(s).padStart(2, "0")}\r\n`);
    }
    h.at(12_020);
    done(h);
    h.at(12_800);
    expect(h.kinds().filter((k) => k === "output")).toHaveLength(1);
    expect(h.raised[0]).toEqual({ event: "output", program: "for", at: 3000 });
    expect(h.kinds()).toEqual(["output", "finished"]);
  });

  test("5. read -p 'Continue? [Y/n] ' → output + input", () => {
    const h = harness();
    run(h, "sleep 3; read -p 'Continue? [Y/n] ' x");
    h.at(300);
    h.leave();
    h.at(3010);
    h.out("Continue? [Y/n] ");
    h.at(8300);
    h.out("y\r\n");
    done(h);
    h.look();
    expect(h.raised).toEqual([
      { event: "output", program: "sleep", at: 3010 },
      { event: "input", program: "sleep", at: 6010 },
    ]);
  });

  test("6. read -s -p 'Password: ' → output + input", () => {
    const h = harness();
    run(h, "sleep 3; read -s -p 'Password: ' x; echo");
    h.at(300);
    h.leave();
    h.at(3010);
    h.out("Password: ");
    h.at(8300);
    // `-s`: the answer is not echoed, only the newline after it.
    h.out("\r\n");
    done(h);
    h.look();
    expect(h.kinds()).toEqual(["output", "input"]);
    expect(h.raised[1]?.at).toBe(6010);
  });

  test("7. sleep 3; printf '\\a' → bell", () => {
    const h = harness();
    run(h, "sleep 3; printf '\\a'");
    h.at(300);
    h.leave();
    h.at(3010);
    h.out("\x07");
    h.attention.bell();
    done(h);
    h.at(5300);
    expect(h.raised).toEqual([{ event: "bell", program: "sleep", at: 3010 }]);
  });

  test("8. back mid-stream, then away again → one output per absence (2)", () => {
    const h = harness();
    run(h, "for i in $(seq 10); do date +%T; sleep 1; done");
    h.out("12:00:00\r\n");
    h.at(300);
    h.leave();
    const tick = (s: number) => {
      h.at(s * 1000);
      h.out(`12:00:${String(s).padStart(2, "0")}\r\n`);
    };
    for (const s of [1, 2, 3, 4]) tick(s);
    h.at(4300);
    h.look();
    tick(5);
    h.at(5800);
    h.leave();
    for (const s of [6, 7, 8, 9]) tick(s);
    h.at(10_050);
    done(h);
    expect(h.raised).toEqual([
      { event: "output", program: "for", at: 3000 },
      { event: "output", program: "for", at: 8000 },
      { event: "finished", program: "for", exit_code: 0, ran_ms: 10_050, at: 10_050 },
    ]);
  });
});

describe("attention rules and gates", () => {
  let h: H;

  beforeEach(() => {
    h = harness();
  });

  test("grace: output under 2 s after leaving is ignored, at 2 s it counts", () => {
    run(h, "make");
    h.leave();
    h.at(GRACE_MS - 1);
    h.out("compiling\r\n");
    expect(h.raised).toEqual([]);
    h.at(GRACE_MS);
    h.out("linking\r\n");
    expect(h.kinds()).toEqual(["output"]);
  });

  test("with the integration live, a prompt redraw at idle is not news", () => {
    h.leave();
    h.at(5000);
    h.out("\r\x1b[Khermes@atlas:~$ ");
    expect(h.raised).toEqual([]);
  });

  test("with no integration, any printable output counts", () => {
    const bare = harness({ integration: false });
    bare.leave();
    bare.at(5000);
    bare.out("\x1b[2J\x1b]0;title\x07   \r\n");
    expect(bare.raised).toEqual([]);
    bare.out("hello");
    expect(bare.raised).toEqual([{ event: "output", program: null, at: 5000 }]);
  });

  test("view gating: nothing at all is raised while the session is shown", () => {
    run(h, "sleep 40");
    h.at(5000);
    h.out("Continue? ");
    h.attention.bell();
    h.at(45_000);
    done(h, 1);
    h.attention.exit({ clean: false });
    expect(h.raised).toEqual([]);
    expect(h.flushes()).toBe(0);
  });

  test("the terminal_alerts gate: off raises nothing; on again, the rules resume", () => {
    h.setAlerts(false);
    run(h, "apt upgrade");
    h.leave();
    h.at(3000);
    h.out("Do you want to continue? [Y/n] ");
    h.attention.bell();
    h.at(12_000);
    expect(h.raised).toEqual([]);
    expect(h.flushes()).toBe(0);

    // The once-per-absence latch was never spent, so turning alerts back on
    // still lets this absence's output through.
    h.setAlerts(true);
    h.out("more\r\n");
    expect(h.kinds()).toEqual(["output"]);
  });

  test("event kinds are throttled to one per 30 s per session", () => {
    h.leave();
    h.attention.bell();
    h.at(EVENT_GAP_MS - 1);
    h.attention.bell();
    expect(h.kinds()).toEqual(["bell"]);
    h.at(EVENT_GAP_MS);
    h.attention.bell();
    expect(h.kinds()).toEqual(["bell", "bell"]);

    // Finished, too: two long commands ending close together raise once.
    run(h, "sleep 10");
    h.at(EVENT_GAP_MS + 10_000);
    done(h);
    run(h, "sleep 10");
    h.at(EVENT_GAP_MS + 20_000);
    done(h);
    expect(h.kinds().filter((k) => k === "finished")).toHaveLength(1);
  });

  test("finished: only a command that ran at least 10 s", () => {
    run(h, "sleep 9");
    h.leave();
    h.at(9999);
    done(h);
    expect(h.raised).toEqual([]);
    run(h, "false");
    h.at(20_000);
    done(h, 1);
    expect(h.raised).toEqual([
      { event: "finished", program: "false", exit_code: 1, ran_ms: 10_001, at: 20_000 },
    ]);
  });

  test("input: once per command, and again for the next command", () => {
    const inputs = () => h.kinds().filter((k) => k === "input").length;
    run(h, "apt install");
    h.leave();
    h.at(1000);
    h.out("Do you want to continue? [Y/n] ");
    h.at(4000);
    expect(inputs()).toBe(1);
    // Still asking, more output, more quiet: the same command does not ask twice.
    h.out("\r\nDo you want to continue? [Y/n] ");
    h.at(20_000);
    expect(inputs()).toBe(1);
    done(h);

    run(h, "apt remove");
    h.at(40_000);
    h.out("Do you want to continue? [Y/n] ");
    h.at(43_000);
    expect(inputs()).toBe(2);
  });

  test("input: a quiet command on a line that is not a question raises nothing", () => {
    run(h, "tail -f");
    h.leave();
    h.out("GET /index.html 200");
    h.at(60_000);
    expect(h.raised).toEqual([]);
  });

  test("input: a question already on screen counts once nobody is looking", () => {
    run(h, "ssh-keygen");
    h.out("Enter passphrase (empty for no passphrase): ");
    h.at(10_000);
    expect(h.raised).toEqual([]);
    h.leave();
    h.at(10_000);
    expect(h.raised).toEqual([{ event: "input", program: "ssh-keygen", at: 10_000 }]);
  });

  test("disconnected: an unclean end while away; a clean exit or End is silent", () => {
    h.leave();
    h.attention.exit({ clean: true });
    expect(h.raised).toEqual([]);

    const away = harness();
    away.leave();
    away.attention.exit({ clean: false });
    expect(away.kinds()).toEqual(["disconnected"]);
    // After the end, nothing more.
    away.attention.bell();
    away.out("late bytes");
    expect(away.kinds()).toEqual(["disconnected"]);

    const watching = harness();
    watching.attention.exit({ clean: false });
    expect(watching.raised).toEqual([]);
  });
});

describe("PrintableScanner", () => {
  test("escape sequences, whitespace and C0 are not printable", () => {
    const s = new PrintableScanner();
    expect(s.scan("\x1b[?2004h\x1b[1;32m\x1b[0m\r\n\t \x07\x08")).toBe(false);
    expect(s.scan("\x1b]133;A;hermetic=1;n=abc;pre=1;jobs=0\x07")).toBe(false);
    expect(s.scan("\x1b]0;title\x1b\\")).toBe(false);
    expect(s.scan("\x1b(B\x1b=\x1b>")).toBe(false);
    expect(s.scan("\x1b[31mx")).toBe(true);
    expect(s.scan("é")).toBe(true);
  });

  test("a marker split across reads is not mistaken for text", () => {
    const s = new PrintableScanner();
    expect(s.scan("\x1b]133;A;hermetic=1;n=a")).toBe(false);
    expect(s.scan("bc;pre=1;jobs=0\x07")).toBe(false);
    expect(s.scan("\x1b[3")).toBe(false);
    expect(s.scan("1m")).toBe(false);
    expect(s.scan("ok")).toBe(true);
  });

  test("UTF-8 split across reads decodes whole", () => {
    const s = new PrintableScanner();
    const bytes = new TextEncoder().encode("✓");
    expect(s.scan(bytes.slice(0, 1))).toBe(false);
    expect(s.scan(bytes.slice(1))).toBe(true);
  });
});
