/**
 * The terminal transport end to end, short of the host: the broadcaster's
 * frames, coalescing and credit flow control (`channel.ts`), keystroke
 * ordering (`input.ts`), and a fixture session run through PTY → mirror →
 * broadcaster with `Bun.spawn` stubbed to throw.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { parseShellMarker } from "@hermetic/core/shared";
import {
  CREDIT_WATERMARK,
  FRAME_MAX,
  KEEPALIVE_MS,
  RESYNC_MIN_MS,
  TerminalBroadcaster,
  type TerminalFrame,
  bridgeChannel,
} from "../../src/terminal/channel.ts";
import { INPUT_CHUNK_MAX, InputSequencer, INPUT_REORDER_WINDOW } from "../../src/terminal/input.ts";
import { Mirror, type MirrorChunk, type SnapshotSource } from "../../src/terminal/mirror.ts";
import { fixturePtySpawner } from "../../src/terminal/pty-fixture.ts";
import type { StreamFrame } from "../../src/handlers/streams.ts";
import { FakeTimers } from "./fake-timers.ts";

/** A mirror stand-in whose parse progress the test moves by hand. */
class FakeSource implements SnapshotSource {
  seq = 0;
  received = 0;
  tail: MirrorChunk[] = [];
  snapshots = 0;
  snapshot() {
    this.snapshots++;
    return { seq: this.seq, cols: 80, rows: 24, data: `screen@${this.seq}` };
  }
  unparsed() {
    return this.tail;
  }
  /** Receives `size` bytes (not yet parsed) and returns the chunk the host would push. */
  receive(size: number): MirrorChunk {
    const bytes = new Uint8Array(size).fill(0x61);
    this.received += size;
    const chunk = { bytes, end: this.received };
    this.tail.push(chunk);
    return chunk;
  }
  parseAll(): void {
    this.seq = this.received;
    this.tail = [];
  }
}

function setup(limits = {}) {
  const timers = new FakeTimers();
  const source = new FakeSource();
  const bc = new TerminalBroadcaster({ source, timers, limits });
  const frames: TerminalFrame[] = [];
  const attach = bc.attach({ send: (f) => frames.push(f) });
  const feed = (size: number): void => {
    const chunk = source.receive(size);
    bc.push(chunk.bytes, chunk.end);
  };
  const data = () => frames.filter((f) => f.event === "data").map((f) => f.data);
  return { timers, source, bc, frames, attach, feed, data };
}

const size = (b64: string): number => Buffer.from(b64, "base64").length;

describe("TerminalBroadcaster", () => {
  test("an attach starts with a gen-1 snapshot, then the unparsed tail contiguous from its seq", () => {
    const timers = new FakeTimers();
    const source = new FakeSource();
    source.receive(100);
    source.parseAll();
    source.receive(30);
    source.receive(20);
    const bc = new TerminalBroadcaster({ source, timers });
    const frames: TerminalFrame[] = [];
    bc.attach({ send: (f) => frames.push(f) });
    expect(frames[0]).toEqual({
      event: "snapshot",
      data: { gen: 1, seq: 100, cols: 80, rows: 24, b64: Buffer.from("screen@100").toString("base64") },
    });
    expect(
      frames.slice(1).map((f) => f.event === "data" && [f.data.gen, f.data.end, size(f.data.b64)]),
    ).toEqual([[1, 150, 50]]);
  });

  test("leading edge: the first bytes after quiet go at once; a burst waits out the window together", () => {
    const { timers, feed, data } = setup();
    feed(10);
    expect(data().map((d) => d.end)).toEqual([10]);
    timers.advance(5);
    feed(10);
    feed(10);
    expect(data()).toHaveLength(1);
    timers.advance(10);
    expect(data()).toHaveLength(1);
    timers.advance(1); // 16 ms after the first frame
    expect(data().map((d) => [d.end, size(d.b64)])).toEqual([
      [10, 10],
      [30, 20],
    ]);
    // Quiet again: the next byte is not held.
    timers.advance(100);
    feed(1);
    expect(data().at(-1)?.end).toBe(31);
  });

  test("coalescing caps: no frame over FRAME_MAX, full frames go without waiting, ends are contiguous", () => {
    const { timers, feed, data, attach } = setup();
    for (let i = 0; i < 100; i++) feed(1024);
    // The first KiB on the leading edge, then every full frame at once.
    expect(data().map((d) => size(d.b64))).toEqual([1024, FRAME_MAX, FRAME_MAX, FRAME_MAX]);
    timers.advance(16);
    const sizes = data().map((d) => size(d.b64));
    expect(Math.max(...sizes)).toBeLessThanOrEqual(FRAME_MAX);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(100 * 1024);
    let at = 0;
    for (const d of data()) {
      at += size(d.b64);
      expect(d.end).toBe(at);
    }
    expect(attach.state().queued).toBe(0);
  });

  test("watermark: past CREDIT_WATERMARK unacked, deltas stop and the queue is dropped", () => {
    const { timers, feed, data, attach } = setup();
    for (let i = 0; i < 40; i++) {
      feed(32 * 1024);
      timers.advance(16);
    }
    const sent = data().reduce((sum, d) => sum + size(d.b64), 0);
    expect(sent).toBeLessThanOrEqual(CREDIT_WATERMARK);
    expect(sent).toBeGreaterThan(CREDIT_WATERMARK - FRAME_MAX);
    expect(attach.state()).toMatchObject({ stalled: true, queued: 0, sent });
    // Live output is not queued while stalled.
    feed(100);
    timers.advance(100);
    expect(data().reduce((sum, d) => sum + size(d.b64), 0)).toBe(sent);
  });

  test("resync: once acks catch up, a fresh snapshot under a new gen, then deltas in that gen", () => {
    const { timers, source, feed, frames, data, attach } = setup();
    for (let i = 0; i < 20; i++) feed(32 * 1024);
    timers.advance(16);
    expect(attach.state().stalled).toBe(true);
    source.parseAll();
    timers.advance(RESYNC_MIN_MS);
    // An ack that leaves too much outstanding does not resume.
    attach.ack(1, 64 * 1024);
    expect(frames.filter((f) => f.event === "snapshot")).toHaveLength(1);
    attach.ack(1, attach.state().sent - 32 * 1024);
    const snaps = frames.filter((f) => f.event === "snapshot");
    expect(snaps).toHaveLength(2);
    expect(snaps[1]?.data).toMatchObject({ gen: 2, seq: source.received });
    expect(attach.gen).toBe(2);
    expect(attach.state()).toMatchObject({
      stalled: false,
      sent: source.received,
      acked: source.received,
    });
    feed(5);
    expect(data().at(-1)).toMatchObject({ gen: 2, end: source.received });
  });

  test("resync throttle: at most one snapshot per RESYNC_MIN_MS", () => {
    const { timers, source, feed, frames, attach } = setup();
    for (let i = 0; i < 20; i++) feed(32 * 1024);
    timers.advance(16);
    source.parseAll();
    attach.ack(1, attach.state().sent);
    // Caught up 16 ms after the attach's own snapshot: held until a second has passed.
    expect(frames.filter((f) => f.event === "snapshot")).toHaveLength(1);
    timers.advance(RESYNC_MIN_MS - 17);
    expect(frames.filter((f) => f.event === "snapshot")).toHaveLength(1);
    timers.advance(1);
    expect(frames.filter((f) => f.event === "snapshot")).toHaveLength(2);
    expect(frames.at(-1)?.event).toBe("snapshot");
  });

  test("acks for an older gen are ignored", () => {
    const { timers, source, feed, attach } = setup();
    for (let i = 0; i < 20; i++) feed(32 * 1024);
    timers.advance(RESYNC_MIN_MS);
    source.parseAll();
    attach.ack(1, attach.state().sent);
    expect(attach.gen).toBe(2);
    feed(1000);
    const before = attach.state().acked;
    attach.ack(1, source.received);
    expect(attach.state().acked).toBe(before);
    attach.ack(2, source.received);
    expect(attach.state().acked).toBe(source.received);
    // An ack past what was sent is clamped to it.
    attach.ack(2, source.received + 10_000);
    expect(attach.state().acked).toBe(source.received);
  });

  test("pre-attach cap: a large unparsed tail sends at most the watermark, then resyncs", () => {
    const timers = new FakeTimers();
    const source = new FakeSource();
    for (let i = 0; i < 64; i++) source.receive(32 * 1024); // 2 MiB not yet parsed
    const bc = new TerminalBroadcaster({ source, timers });
    const frames: TerminalFrame[] = [];
    const attach = bc.attach({ send: (f) => frames.push(f) });
    const sent = frames.filter((f) => f.event === "data").reduce((s, f) => s + size(f.data.b64), 0);
    expect(sent).toBeLessThanOrEqual(CREDIT_WATERMARK);
    expect(attach.state().stalled).toBe(true);
    source.parseAll();
    attach.ack(1, attach.state().sent);
    timers.advance(RESYNC_MIN_MS);
    expect(frames.at(-1)).toMatchObject({ event: "snapshot", data: { gen: 2, seq: 2 * 1024 * 1024 } });
  });

  test("exit is last: queued bytes flush first, nothing follows, and a later attach gets screen then exit", async () => {
    const { timers, source, bc, frames, feed, attach } = setup();
    feed(10);
    timers.advance(1);
    feed(10); // queued behind the coalescing window
    bc.exit({ code: 0, signal: null, reason: "exited" });
    expect(frames.map((f) => f.event)).toEqual(["snapshot", "data", "data", "exit"]);
    expect(frames.at(-1)?.data).toEqual({ code: 0, signal: null, reason: "exited" });
    await attach.done;
    feed(10);
    bc.inputError(3, "INPUT_GAP");
    timers.advance(KEEPALIVE_MS * 2);
    expect(frames.at(-1)?.event).toBe("exit");
    expect(bc.attachCount).toBe(0);

    source.parseAll();
    const late: TerminalFrame[] = [];
    const lateAttach = bc.attach({ send: (f) => late.push(f) });
    expect(late.map((f) => f.event)).toEqual(["snapshot", "exit"]);
    await lateAttach.done;
  });

  test("a stalled attach still ends on the final screen at exit", () => {
    const { timers, source, bc, frames, feed, attach } = setup();
    for (let i = 0; i < 20; i++) feed(32 * 1024);
    expect(attach.state().stalled).toBe(true);
    source.parseAll();
    bc.exit({ code: null, signal: "SIGHUP", reason: "closed" });
    expect(frames.slice(-2).map((f) => f.event)).toEqual(["snapshot", "exit"]);
    expect(frames.at(-2)?.data).toMatchObject({ gen: 2, seq: source.received });
    timers.advance(RESYNC_MIN_MS * 2);
    expect(frames.at(-1)?.event).toBe("exit");
  });

  test("keepalive after quiet; input errors reach every attach; close sends nothing more", () => {
    const { timers, bc, frames, attach } = setup();
    const other: TerminalFrame[] = [];
    bc.attach({ send: (f) => other.push(f) });
    timers.advance(KEEPALIVE_MS);
    expect(frames.at(-1)?.event).toBe("keepalive");
    bc.inputError(7, "INPUT_TOO_LARGE");
    expect(frames.at(-1)).toEqual({
      event: "input_error",
      data: { in_seq: 7, code: "INPUT_TOO_LARGE" },
    });
    expect(other.at(-1)).toEqual(frames.at(-1) as TerminalFrame);
    attach.close();
    const count = frames.length;
    bc.exit({ code: 0, signal: null, reason: "exited" });
    timers.advance(KEEPALIVE_MS * 2);
    expect(frames).toHaveLength(count);
    expect(other.at(-1)?.event).toBe("exit");
  });

  test("one slow attach stalls alone", () => {
    const { timers, bc, feed, attach } = setup();
    const fast: TerminalFrame[] = [];
    const fastAttach = bc.attach({ send: (f) => fast.push(f) });
    for (let i = 0; i < 40; i++) {
      feed(32 * 1024);
      timers.advance(16);
      fastAttach.ack(1, fastAttach.state().sent);
    }
    expect(attach.state().stalled).toBe(true);
    expect(fastAttach.state()).toMatchObject({ stalled: false, sent: 40 * 32 * 1024 });
  });

  test("a channel that throws closes its attach", async () => {
    const { bc, feed } = setup();
    let calls = 0;
    const broken = bc.attach({
      send: () => {
        calls++;
        if (calls > 1) throw new Error("page gone");
      },
    });
    feed(10);
    await broken.done;
    expect(bc.attachCount).toBe(1);
  });

  test("bridgeChannel hands frames to the stream sink and swallows a late rejection", async () => {
    const seen: StreamFrame[] = [];
    const channel = bridgeChannel((frame) => {
      seen.push(frame);
      return Promise.reject(new Error("window closed"));
    });
    channel.send({ event: "keepalive", data: null });
    await Bun.sleep(0);
    expect(seen).toEqual([{ event: "keepalive", data: null }]);
  });
});

describe("InputSequencer", () => {
  function sequencer() {
    const applied: string[] = [];
    const errors: [number, string][] = [];
    const seq = new InputSequencer({
      apply: (d) => applied.push(typeof d === "string" ? d : `<${d.byteLength}b>`),
      error: (n, code) => errors.push([n, code]),
    });
    return { seq, applied, errors };
  }

  test("applies chunks in in_seq order whatever order they arrive in", () => {
    const { seq, applied, errors } = sequencer();
    seq.accept(2, "c");
    seq.accept(0, "a");
    expect(applied).toEqual(["a"]);
    seq.accept(1, "b");
    seq.accept(3, new Uint8Array([1, 2]));
    expect(applied).toEqual(["a", "b", "c", "<2b>"]);
    expect(errors).toEqual([]);
  });

  test("oversize chunks are refused in place; duplicates are stale", () => {
    const { seq, applied, errors } = sequencer();
    seq.accept(0, "x".repeat(INPUT_CHUNK_MAX));
    seq.accept(1, "y".repeat(INPUT_CHUNK_MAX + 1));
    seq.accept(2, "z");
    seq.accept(2, "z");
    expect(applied.map((a) => a.length)).toEqual([INPUT_CHUNK_MAX, 1]);
    expect(errors).toEqual([
      [1, "INPUT_TOO_LARGE"],
      [2, "INPUT_STALE"],
    ]);
  });

  test("a chunk that never arrives is reported once and the held ones apply", () => {
    const { seq, applied, errors } = sequencer();
    seq.accept(0, "a");
    for (let i = 2; i <= INPUT_REORDER_WINDOW + 2; i++) seq.accept(i, String(i));
    expect(errors).toEqual([[1, "INPUT_GAP"]]);
    expect(applied).toHaveLength(INPUT_REORDER_WINDOW + 2);
    expect(applied.at(-1)).toBe(String(INPUT_REORDER_WINDOW + 2));
  });

  test("in_seq 0 starts a new sequence (a reloaded page)", () => {
    const { seq, applied, errors } = sequencer();
    seq.accept(0, "a");
    seq.accept(1, "b");
    seq.accept(0, "fresh");
    seq.accept(1, "again");
    expect(applied).toEqual(["a", "b", "fresh", "again"]);
    expect(errors).toEqual([]);
  });
});

describe("a fixture session end to end", () => {
  afterEach(() => {
    spawnSpy?.mockRestore();
  });
  let spawnSpy: ReturnType<typeof spyOn> | undefined;

  test("runs through PTY → mirror → broadcaster without spawning anything", async () => {
    spawnSpy = spyOn(Bun, "spawn").mockImplementation(() => {
      throw new Error("fixture mode must never spawn");
    });
    const timers = new FakeTimers();
    const pty = fixturePtySpawner({ timers })(["tailscale", "ssh", "hermes@atlas"], {
      cols: 80,
      rows: 24,
    });
    const mirror = new Mirror({ cols: 80, rows: 24, valve: (sig) => pty.signalGroup(sig) });
    const bc = new TerminalBroadcaster({ source: mirror, timers });
    const markers: string[] = [];
    mirror.terminal.parser.registerOscHandler(133, (payload) => {
      const m = parseShellMarker(payload);
      if (m !== null)
        markers.push(m.kind === "C" ? `C:${m.cmd}` : m.kind === "D" ? `D:${m.exit}` : m.kind);
      return true;
    });
    let bells = 0;
    mirror.onBell(() => bells++);
    // The host's wiring: the mirror first, then the broadcaster with the mirror's offset.
    pty.onData((bytes) => bc.push(bytes, mirror.write(bytes)));
    const input = new InputSequencer({
      apply: (d) => pty.write(d),
      error: (n, code) => bc.inputError(n, code),
    });

    const frames: TerminalFrame[] = [];
    const attach = bc.attach({ send: (f) => frames.push(f) });
    input.accept(0, "whoami\r");
    input.accept(2, "printf '\\a'\r");
    input.accept(1, "sleep 2\r");
    await mirror.drained();
    expect(markers).toEqual(["A", "C:whoami", "D:0", "A", "C:sleep 2"]);
    timers.advance(2000);
    await mirror.drained();
    expect(markers.slice(5)).toEqual(["D:0", "A", "C:printf '\\a'", "D:0", "A"]);
    expect(bells).toBe(1);
    input.accept(3, "exit\r");
    const exit = await pty.exited;
    expect(exit).toEqual({ code: 0, signal: null });
    await mirror.drained();
    bc.exit({ ...exit, reason: "exited" });
    await attach.done;

    // The page's view: snapshot, then data contiguous from its seq, then exit last.
    const snap = frames[0];
    expect(snap?.event).toBe("snapshot");
    let at = snap?.event === "snapshot" ? snap.data.seq : -1;
    let text = snap?.event === "snapshot" ? Buffer.from(snap.data.b64, "base64").toString() : "";
    for (const f of frames.slice(1, -1)) {
      if (f.event !== "data") continue;
      const bytes = Buffer.from(f.data.b64, "base64");
      expect(f.data.end).toBe(at + bytes.length);
      at = f.data.end;
      text += bytes.toString();
    }
    expect(at).toBe(mirror.received);
    expect(text).toContain("whoami\r\n");
    expect(text).toContain("hermes\r\n");
    expect(text).toContain("logout");
    expect(frames.at(-1)).toEqual({ event: "exit", data: { code: 0, signal: null, reason: "exited" } });
    expect(spawnSpy).not.toHaveBeenCalled();
    mirror.dispose();
  });
});
