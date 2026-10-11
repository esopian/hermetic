/**
 * Session output to the pages watching it, with flow control (issue #18, D5).
 *
 * One session, any number of attaches — a page per window, a page that
 * reloaded — each its own stream over the bridge. The `TerminalBroadcaster`
 * is the session's end: the host feeds it every chunk the mirror was written
 * (`push`), and it keeps one `Attach` per stream with that stream's own queue
 * and credits, so a slow page falls behind alone.
 *
 * ## Frames
 *
 * - `snapshot {gen, seq, cols, rows, b64}` first on every attach and every
 *   resync: the mirror's screen after `seq` bytes (`mirror.ts`).
 * - `data {gen, end, b64}`: raw output, contiguous from the snapshot's `seq`;
 *   `end` is the offset just past the chunk. The received-but-unparsed tail
 *   at snapshot time goes out first, as data, so no byte is lost or doubled.
 * - `input_error {in_seq, code}`: a keystroke chunk was refused (`input.ts`).
 * - `exit {code, signal, reason}`: always the last frame of a stream.
 * - `keepalive`: after `KEEPALIVE_MS` of quiet.
 *
 * ## Coalescing
 *
 * Leading edge: the first bytes after `COALESCE_MS` of quiet go out at once,
 * so a keystroke's echo is never held. Within a burst, bytes queue for up to
 * `COALESCE_MS` and go out in frames of at most `FRAME_MAX` raw bytes; a full
 * frame's worth goes out without waiting. Each frame costs a bridge message
 * and an encrypt/decrypt on both sides, so a flood sent byte for byte would
 * cost far more than its payload.
 *
 * ## Credits
 *
 * The page acks (`ack(gen, upto)`) the offsets it has parsed. A data frame is
 * sent only while it keeps `sent − acked` within `CREDIT_WATERMARK`; one that
 * would not stalls the attach: its queue is dropped and live output is not
 * queued. Once the page has caught up to within `RESUME_BELOW` — acks need
 * not land on the last byte, a page acks every ~32 KiB — the attach resyncs:
 * a fresh snapshot under a new `gen`, at most once per `RESYNC_MIN_MS`. Acks
 * carrying an older `gen` are for a screen the page has thrown away and are
 * ignored. The snapshot is not counted against credits: it is bounded by the
 * mirror's scrollback, and counting it could stall the attach it restarts.
 *
 * The tail sent after any snapshot is subject to the same credits, which is
 * what caps a page's first delivery (the "pre-attach buffer") at the
 * watermark however much the mirror had yet to parse.
 */
import type { StreamSink } from "../handlers/streams.ts";
import type { InputErrorCode } from "./input.ts";
import type { MirrorChunk, SnapshotSource } from "./mirror.ts";
import type { TimerHandle, Timers } from "./timers.ts";
import { realTimers } from "./timers.ts";

/** Unacked bytes above which an attach stops receiving deltas. */
export const CREDIT_WATERMARK = 512 * 1024;
/** Unacked bytes at or below which a stalled attach resyncs. */
export const RESUME_BELOW = 128 * 1024;
/** How long a burst's bytes may wait to share a frame. */
export const COALESCE_MS = 16;
/** Most raw bytes in one data frame. */
export const FRAME_MAX = 32 * 1024;
/** Least time between two snapshots to one attach. */
export const RESYNC_MIN_MS = 1000;
/** Quiet before a keepalive. */
export const KEEPALIVE_MS = 5000;

export type TerminalExitReason =
  | "exited"
  | "closed"
  | "shutdown"
  | "acl_denied"
  | "no_login_shell"
  | "disconnected";

export interface TerminalExitInfo {
  code: number | null;
  signal: string | null;
  reason: TerminalExitReason;
}

export interface SnapshotFrameData {
  gen: number;
  seq: number;
  cols: number;
  rows: number;
  b64: string;
}

export interface DataFrameData {
  gen: number;
  end: number;
  b64: string;
}

export type TerminalFrame =
  | { event: "snapshot"; data: SnapshotFrameData }
  | { event: "data"; data: DataFrameData }
  | { event: "input_error"; data: { in_seq: number; code: InputErrorCode } }
  | { event: "exit"; data: TerminalExitInfo }
  | { event: "keepalive"; data: null };

/**
 * The send side of one attach. The bridge implements it over a `StreamSink`
 * (`bridgeChannel`); a dedicated socket could implement it later without the
 * broadcaster changing. `send` throwing means the channel is gone, and the
 * attach closes.
 */
export interface TerminalChannel {
  send(frame: TerminalFrame): void;
}

/** A channel over the bridge's stream sink. A sink that rejects later is a dead page; that is not ours to report. */
export function bridgeChannel(sink: StreamSink): TerminalChannel {
  return {
    send(frame) {
      const result = sink(frame);
      if (result instanceof Promise) result.catch(() => {});
    },
  };
}

export interface ChannelLimits {
  watermark: number;
  resumeBelow: number;
  coalesceMs: number;
  frameMax: number;
  resyncMinMs: number;
  keepaliveMs: number;
}

const DEFAULT_LIMITS: ChannelLimits = {
  watermark: CREDIT_WATERMARK,
  resumeBelow: RESUME_BELOW,
  coalesceMs: COALESCE_MS,
  frameMax: FRAME_MAX,
  resyncMinMs: RESYNC_MIN_MS,
  keepaliveMs: KEEPALIVE_MS,
};

/** One page's stream, as the host holds it. */
export interface TerminalAttach {
  readonly id: number;
  /** The current screen generation; acks for any other are ignored. */
  readonly gen: number;
  ack(gen: number, upto: number): void;
  /** Stops sending. No frame follows, not even `exit`. Idempotent. */
  close(): void;
  /** Settles when the attach is closed or has sent `exit`. Never rejects. */
  readonly done: Promise<void>;
}

/** What a test (or a debugging host) can read about one attach. */
export interface AttachState {
  gen: number;
  sent: number;
  acked: number;
  queued: number;
  stalled: boolean;
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

function concat(chunks: Uint8Array[], length: number): Uint8Array {
  if (chunks.length === 1 && chunks[0] !== undefined) return chunks[0];
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

export interface BroadcasterOptions {
  source: SnapshotSource;
  timers?: Timers;
  limits?: Partial<ChannelLimits>;
}

/**
 * One session's fan-out. The host writes each chunk to the mirror first and
 * then pushes it here with the offset the mirror returned, so an attach's
 * snapshot-plus-tail and the live pushes after it meet exactly.
 */
export class TerminalBroadcaster {
  readonly limits: ChannelLimits;
  readonly timers: Timers;
  readonly source: SnapshotSource;
  private readonly attaches = new Set<Attach>();
  private nextId = 1;
  private exitInfo: TerminalExitInfo | null = null;

  constructor(options: BroadcasterOptions) {
    this.source = options.source;
    this.timers = options.timers ?? realTimers;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
  }

  /** The session's exit, once it has one. */
  get exited(): TerminalExitInfo | null {
    return this.exitInfo;
  }

  get attachCount(): number {
    return this.attaches.size;
  }

  /** Starts a stream: a snapshot now, then live output, or the final screen and `exit` if the session is over. */
  attach(channel: TerminalChannel): TerminalAttach & { state(): AttachState } {
    const attach = new Attach(this.nextId++, channel, this, () => this.attaches.delete(attach));
    this.attaches.add(attach);
    attach.start(this.exitInfo);
    return attach;
  }

  /** One chunk of output, ending at offset `end` (the mirror's `write` return). */
  push(bytes: Uint8Array, end: number): void {
    if (this.exitInfo !== null) return;
    for (const attach of this.attaches) attach.push({ bytes, end });
  }

  inputError(inSeq: number, code: InputErrorCode): void {
    if (this.exitInfo !== null) return;
    for (const attach of this.attaches)
      attach.sendNow({ event: "input_error", data: { in_seq: inSeq, code } });
  }

  /**
   * The session ended. Every attach gets what it has queued, then `exit`, and
   * ends. The host should await the mirror's `drained()` first, so the final
   * snapshot an attach that had stalled is sent is the whole screen.
   */
  exit(info: TerminalExitInfo): void {
    if (this.exitInfo !== null) return;
    this.exitInfo = info;
    for (const attach of [...this.attaches]) attach.finish(info);
  }

  /** Closes every attach without an `exit` frame. */
  closeAll(): void {
    for (const attach of [...this.attaches]) attach.close();
  }
}

class Attach implements TerminalAttach {
  private _gen = 0;
  /** Offset just past the last byte sent (or the snapshot's `seq`). */
  private sent = 0;
  private acked = 0;
  private queue: MirrorChunk[] = [];
  private queued = 0;
  private stalled = false;
  private ended = false;
  private lastDataAt = Number.NEGATIVE_INFINITY;
  private lastSnapshotAt = Number.NEGATIVE_INFINITY;
  private flushTimer: TimerHandle | null = null;
  private resyncTimer: TimerHandle | null = null;
  private keepaliveTimer: TimerHandle | null = null;
  private resolveDone: () => void = () => {};
  readonly done = new Promise<void>((resolve) => {
    this.resolveDone = resolve;
  });

  constructor(
    readonly id: number,
    private readonly channel: TerminalChannel,
    private readonly owner: TerminalBroadcaster,
    private readonly detach: () => void,
  ) {}

  get gen(): number {
    return this._gen;
  }

  private get limits(): ChannelLimits {
    return this.owner.limits;
  }

  private get timers(): Timers {
    return this.owner.timers;
  }

  state(): AttachState {
    return {
      gen: this._gen,
      sent: this.sent,
      acked: this.acked,
      queued: this.queued,
      stalled: this.stalled,
    };
  }

  start(exit: TerminalExitInfo | null): void {
    this.snapshot();
    if (exit !== null) this.finish(exit);
  }

  ack(gen: number, upto: number): void {
    if (this.ended || gen !== this._gen || !Number.isFinite(upto)) return;
    const at = Math.min(upto, this.sent);
    if (at > this.acked) this.acked = at;
    if (this.stalled && this.sent - this.acked <= this.limits.resumeBelow) this.requestResync();
  }

  push(chunk: MirrorChunk): void {
    if (this.ended || this.stalled) return;
    this.enqueue(chunk);
    if (this.stalled) return;
    const now = this.timers.now();
    if (this.queued >= this.limits.frameMax) this.flush(false);
    if (this.queued === 0 || this.flushTimer !== null) return;
    const wait = this.lastDataAt + this.limits.coalesceMs - now;
    if (wait <= 0) this.flush(true);
    else this.flushTimer = this.timers.setTimeout(() => this.flush(true), wait);
  }

  /** Sends a frame outside the data stream (`input_error`, `exit`, `keepalive`). */
  sendNow(frame: TerminalFrame): void {
    if (this.ended) return;
    try {
      this.channel.send(frame);
    } catch {
      this.close();
      return;
    }
    this.armKeepalive();
  }

  finish(info: TerminalExitInfo): void {
    if (this.ended) return;
    this.cancel("flush");
    this.cancel("resync");
    // A stalled attach would end on a screen it never caught up to: restart it
    // once more, throttle and credits aside, so the ended session shows its
    // last screen.
    if (!this.stalled) this.flush(true);
    if (this.stalled) this.snapshot(true);
    this.sendNow({ event: "exit", data: info });
    this.end();
  }

  close(): void {
    this.end();
  }

  private end(): void {
    if (this.ended) return;
    this.ended = true;
    this.cancel("flush");
    this.cancel("resync");
    this.cancel("keepalive");
    this.queue = [];
    this.queued = 0;
    this.detach();
    this.resolveDone();
  }

  /** Appends a chunk, trimming any part already covered: the tail and a push can overlap by design. */
  private enqueue(chunk: MirrorChunk): void {
    const last = this.queue[this.queue.length - 1];
    const from = last === undefined ? this.sent : last.end;
    if (chunk.end <= from) return;
    const start = chunk.end - chunk.bytes.length;
    if (start > from) {
      // Bytes went missing between the two. Never send a screen with a hole
      // in it: start over from a snapshot, once the page has caught up.
      this.stall();
      return;
    }
    const bytes = start === from ? chunk.bytes : chunk.bytes.subarray(from - start);
    this.queue.push({ bytes, end: chunk.end });
    this.queued += bytes.length;
  }

  /**
   * Sends queued bytes in frames of at most `frameMax`. `all` false sends only
   * full frames and leaves the remainder for the coalescing timer; `force`
   * sends regardless of credits (the final tail at exit).
   */
  private flush(all: boolean, force = false): void {
    this.cancel("flush");
    const max = this.limits.frameMax;
    while (this.queued > 0 && !this.ended && !this.stalled && (all || this.queued >= max)) {
      const size = Math.min(max, this.queued);
      if (!force && this.sent - this.acked + size > this.limits.watermark) {
        this.stall();
        return;
      }
      const parts: Uint8Array[] = [];
      let taken = 0;
      while (taken < size) {
        const head = this.queue[0];
        if (head === undefined) break;
        const want = size - taken;
        if (head.bytes.length <= want) {
          parts.push(head.bytes);
          taken += head.bytes.length;
          this.queue.shift();
        } else {
          parts.push(head.bytes.subarray(0, want));
          this.queue[0] = { bytes: head.bytes.subarray(want), end: head.end };
          taken += want;
        }
      }
      this.queued -= taken;
      this.sent += taken;
      this.lastDataAt = this.timers.now();
      this.sendNow({
        event: "data",
        data: { gen: this._gen, end: this.sent, b64: b64(concat(parts, taken)) },
      });
    }
    if (this.queued > 0 && !this.ended && !this.stalled && this.flushTimer === null) {
      this.flushTimer = this.timers.setTimeout(() => this.flush(true), this.limits.coalesceMs);
    }
  }

  /** Over the watermark: drop what is queued and take nothing more until a resync. */
  private stall(): void {
    this.stalled = true;
    this.queue = [];
    this.queued = 0;
    this.cancel("flush");
    // Already caught up: no ack is coming to wake it, so resync on the throttle alone.
    if (this.sent - this.acked <= this.limits.resumeBelow) this.requestResync();
  }

  private requestResync(): void {
    if (this.resyncTimer !== null || this.ended) return;
    const wait = this.lastSnapshotAt + this.limits.resyncMinMs - this.timers.now();
    if (wait <= 0) this.snapshot();
    else
      this.resyncTimer = this.timers.setTimeout(() => {
        this.resyncTimer = null;
        this.snapshot();
      }, wait);
  }

  /**
   * A fresh screen under a new `gen`, then the unparsed tail. Credits restart
   * from the snapshot's `seq`. `force` (at exit) sends the whole tail.
   */
  private snapshot(force = false): void {
    if (this.ended) return;
    this.cancel("resync");
    this.cancel("flush");
    const snap = this.owner.source.snapshot();
    this._gen++;
    this.lastSnapshotAt = this.timers.now();
    this.stalled = false;
    this.queue = [];
    this.queued = 0;
    this.sent = snap.seq;
    this.acked = snap.seq;
    const { gen } = this;
    this.sendNow({
      event: "snapshot",
      data: {
        gen,
        seq: snap.seq,
        cols: snap.cols,
        rows: snap.rows,
        b64: b64(Buffer.from(snap.data, "utf8")),
      },
    });
    for (const chunk of this.owner.source.unparsed()) this.enqueue(chunk);
    this.flush(true, force);
  }

  private armKeepalive(): void {
    this.cancel("keepalive");
    if (this.ended) return;
    this.keepaliveTimer = this.timers.setTimeout(() => {
      this.keepaliveTimer = null;
      this.sendNow({ event: "keepalive", data: null });
    }, this.limits.keepaliveMs);
  }

  private cancel(which: "flush" | "resync" | "keepalive"): void {
    const key = `${which}Timer` as const;
    const handle = this[key];
    if (handle !== null) this.timers.clearTimeout(handle);
    this[key] = null;
  }
}
