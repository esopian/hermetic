/**
 * The session mirror (`mirror.ts`): the seq handoff between a snapshot and
 * the bytes after it, alternate-screen restore, resize, the valve, and what
 * it exposes to the activity and attention units.
 */
import { describe, expect, test } from "bun:test";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/headless";
import { Mirror, type ValveSignal } from "../../src/terminal/mirror.ts";

const enc = new TextEncoder();

/** Writes `data` into a fresh terminal and resolves once it is parsed. */
function restore(cols: number, rows: number, ...parts: (string | Uint8Array)[]): Promise<Terminal> {
  const term = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
  return new Promise((resolve) => {
    if (parts.length === 0) resolve(term);
    for (const [i, part] of parts.entries()) {
      term.write(part, i === parts.length - 1 ? () => resolve(term) : undefined);
    }
  });
}

function serialize(term: Terminal): string {
  const addon = new SerializeAddon();
  term.loadAddon(addon);
  return addon.serialize();
}

/** Coloured, numbered output lines, the kind a real session prints. */
function lines(from: number, count: number): Uint8Array {
  let s = "";
  for (let i = from; i < from + count; i++)
    s += `\x1b[3${i % 8}mline ${i}\x1b[0m ${"x".repeat(i % 50)}\r\n`;
  return enc.encode(s);
}

describe("Mirror", () => {
  test("seq trails received and catches up only through xterm's write callback", async () => {
    const mirror = new Mirror({ cols: 80, rows: 24 });
    const end = mirror.write(enc.encode("hello"));
    expect(end).toBe(5);
    expect(mirror.received).toBe(5);
    expect(mirror.seq).toBe(0);
    expect(mirror.backlog).toBe(5);
    expect(mirror.unparsed()).toEqual([{ bytes: enc.encode("hello"), end: 5 }]);
    await mirror.drained();
    expect(mirror.seq).toBe(5);
    expect(mirror.unparsed()).toEqual([]);
    mirror.dispose();
  });

  test("a snapshot plus the unparsed tail, taken mid-stream, restores the same screen", async () => {
    const mirror = new Mirror({ cols: 60, rows: 10 });
    let n = 0;
    const handoffs: { snap: ReturnType<Mirror["snapshot"]>; tail: Uint8Array[] }[] = [];
    // Parse progress is driven explicitly, never left to a scheduler slice. On
    // even rounds the mirror is drained first, so the round's chunks are all
    // unparsed when the snapshot is taken: xterm parses only in its own timer
    // callback, so a write and a synchronous snapshot can never interleave,
    // and the split lands exactly at the round's start — seq > 0, tail
    // non-empty, every time. Odd rounds take whatever split occurred.
    for (let round = 0; round < 12; round++) {
      const forced = round % 2 === 0;
      if (forced) await mirror.drained();
      const before = mirror.received;
      for (let k = 0; k < 5; k++) {
        mirror.write(lines(n, 7));
        n += 7;
      }
      const snap = mirror.snapshot();
      const tail = mirror.unparsed();
      if (forced) {
        expect(snap.seq).toBe(before);
        expect(tail).toHaveLength(5);
      }
      // Whatever the split, the tail starts exactly at the snapshot's seq and
      // runs contiguously to `received`: every byte is in exactly one of the two.
      let at = snap.seq;
      for (const chunk of tail) {
        expect(chunk.end - chunk.bytes.length).toBe(at);
        at = chunk.end;
      }
      expect(at).toBe(mirror.received);
      handoffs.push({ snap, tail: tail.map((c) => c.bytes) });
    }
    await mirror.drained();
    expect(handoffs.filter((h) => h.tail.length > 0 && h.snap.seq > 0).length).toBeGreaterThanOrEqual(
      5,
    );

    // Every byte the session printed, to replay what followed each handoff.
    const all = new Uint8Array(mirror.received);
    for (let i = 0, off = 0; i < n; i += 7) {
      const chunk = lines(i, 7);
      all.set(chunk, off);
      off += chunk.length;
    }
    const final = serialize(mirror.terminal);
    for (const { snap, tail } of handoffs) {
      // Restore from that moment: the screen, the tail, then everything after.
      const tailEnd = tail.reduce((sum, b) => sum + b.length, snap.seq);
      const term = await restore(snap.cols, snap.rows, snap.data, ...tail, all.subarray(tailEnd));
      expect(serialize(term)).toBe(final);
      term.dispose();
    }
    mirror.dispose();
  });

  test("an alternate screen survives the snapshot, and leaving it restores the normal one", async () => {
    const mirror = new Mirror({ cols: 40, rows: 6 });
    mirror.write(enc.encode("shell history\r\n$ vim\r\n"));
    mirror.write(enc.encode("\x1b[?1049h\x1b[H~ editing ~"));
    await mirror.drained();
    const snap = mirror.snapshot();
    const term = await restore(snap.cols, snap.rows, snap.data);
    expect(term.buffer.active.type).toBe("alternate");
    expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("~ editing ~");
    const back = await new Promise<Terminal>((r) => term.write("\x1b[?1049l", () => r(term)));
    expect(back.buffer.active.type).toBe("normal");
    expect(back.buffer.active.getLine(0)?.translateToString(true)).toBe("shell history");
    term.dispose();
    mirror.dispose();
  });

  test("resize resizes the mirror and the snapshot carries the new size", async () => {
    const mirror = new Mirror({ cols: 80, rows: 24 });
    mirror.resize(100, 30);
    const snap = mirror.snapshot();
    expect([snap.cols, snap.rows]).toEqual([100, 30]);
    mirror.dispose();
  });

  test("cursorLine reads the cursor's line; bell and title are reported", async () => {
    const mirror = new Mirror({ cols: 80, rows: 24 });
    let bells = 0;
    const titles: string[] = [];
    mirror.onBell(() => bells++);
    const off = mirror.onTitle((t) => titles.push(t));
    mirror.write(enc.encode("done\r\n\x1b]0;apt upgrade\x07Do you want to continue? [Y/n] \x07"));
    await mirror.drained();
    // Written blanks are kept; only cells nothing was written to are trimmed.
    expect(mirror.cursorLine()).toBe("Do you want to continue? [Y/n] ");
    expect(bells).toBe(1);
    expect(titles).toEqual(["apt upgrade"]);
    off();
    mirror.write(enc.encode("\x1b]2;other\x07"));
    await mirror.drained();
    expect(titles).toEqual(["apt upgrade"]);
    mirror.dispose();
  });

  test("the valve stops the session over the high mark and continues it under the low", async () => {
    const signals: ValveSignal[] = [];
    // A stand-in for the PTY's group signaller.
    const fakePty = { signalGroup: (sig: ValveSignal) => signals.push(sig) };
    const mirror = new Mirror({
      cols: 80,
      rows: 24,
      valve: (sig) => fakePty.signalGroup(sig),
      valveHigh: 64 * 1024,
      valveLow: 16 * 1024,
    });
    const block = enc.encode(`${"y".repeat(79)}\r\n`.repeat(100)); // 8.1 KB
    for (let i = 0; i < 7; i++) mirror.write(block);
    expect(signals).toEqual([]);
    for (let i = 0; i < 4; i++) mirror.write(block);
    expect(mirror.backlog).toBeGreaterThan(64 * 1024);
    // Once, however many writes pile on while stopped.
    expect(signals).toEqual(["SIGSTOP"]);
    expect(mirror.stopped).toBe(true);
    await mirror.drained();
    expect(signals).toEqual(["SIGSTOP", "SIGCONT"]);
    expect(mirror.stopped).toBe(false);
    mirror.dispose();
  });

  test("disposing a stopped mirror continues the session, so a hangup can land", () => {
    const signals: ValveSignal[] = [];
    const mirror = new Mirror({
      cols: 80,
      rows: 24,
      valve: (s) => signals.push(s),
      valveHigh: 10,
      valveLow: 1,
    });
    mirror.write(enc.encode("more than ten bytes"));
    expect(signals).toEqual(["SIGSTOP"]);
    mirror.dispose();
    expect(signals).toEqual(["SIGSTOP", "SIGCONT"]);
  });
});
