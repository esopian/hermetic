/**
 * The main process's copy of one terminal session's screen (issue #18, D2).
 *
 * Every byte a session prints is written into a headless xterm here, so the
 * session outlives the page: a page that attaches — the first time, after a
 * reload, or after falling too far behind — is sent a serialized snapshot of
 * this screen and then the live bytes after it, rather than a replay of
 * everything ever printed.
 *
 * ## Two counters, one byte space
 *
 * Offsets are bytes of PTY output since the session started.
 *
 * - `received` counts bytes handed to `write`. It moves synchronously.
 * - `seq` counts bytes xterm has *parsed*. xterm parses asynchronously, in its
 *   own timer slices, so `seq` moves only in `write`'s callback, one whole
 *   chunk at a time.
 *
 * The screen xterm holds at any moment is exactly the first `seq` bytes, so
 * `snapshot()` is stamped `seq`, not `received`. The bytes in between —
 * received but not yet parsed — are not on the snapshot's screen, and must
 * still reach a page after it: `unparsed()` returns them, as the chunks they
 * arrived in, each with the offset it ends at. An attach takes both in one
 * synchronous step (`channel.ts`), so no chunk can be parsed, or arrive,
 * between the two reads.
 *
 * One known blur: xterm keeps an escape sequence or UTF-8 character that
 * straddles a chunk boundary in parser state, which a serialized screen does
 * not carry. A page restoring from a snapshot taken at that exact boundary
 * shows the sequence's tail as text. Chunks are whole PTY reads, so this is
 * rare and costs a few characters, once.
 *
 * ## The valve
 *
 * A session can print faster than xterm parses (the probe measured a flood at
 * hundreds of MB/s). When the parse backlog passes `VALVE_HIGH`, the valve
 * stops the session's whole process group (SIGSTOP); once the backlog falls
 * under `VALVE_LOW` it continues it. The PTY has no pause of its own, and
 * this is backpressure that reaches the source: a stopped `tailscale ssh`
 * stops reading the network, and the remote side blocks on its own write.
 */
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/headless";

/** Lines of scrollback the mirror (and so a snapshot) keeps. In memory only. */
export const MIRROR_SCROLLBACK = 5000;
/** Parse backlog above which the session is stopped. */
export const VALVE_HIGH = 8 * 1024 * 1024;
/** Parse backlog below which a stopped session is continued. */
export const VALVE_LOW = 2 * 1024 * 1024;

/** A chunk of output and the byte offset just past it. */
export interface MirrorChunk {
  bytes: Uint8Array;
  end: number;
}

/** The screen after exactly `seq` bytes, as escape sequences that redraw it. */
export interface MirrorSnapshot {
  seq: number;
  cols: number;
  rows: number;
  data: string;
}

/** What the channel needs from a mirror to start, or restart, a page. */
export interface SnapshotSource {
  snapshot(): MirrorSnapshot;
  /** Received but not yet parsed, in order: the bytes after the snapshot's `seq`. */
  unparsed(): readonly MirrorChunk[];
}

export type ValveSignal = "SIGSTOP" | "SIGCONT";

export interface MirrorOptions {
  cols: number;
  rows: number;
  scrollback?: number;
  /**
   * Stops or continues the session. The host passes the PTY's
   * `signalGroup`; absent, the backlog is unbounded.
   */
  valve?: (sig: ValveSignal) => void;
  valveHigh?: number;
  valveLow?: number;
}

export class Mirror implements SnapshotSource {
  /**
   * The emulator itself, for the units that read the session as it parses:
   * `activity.ts` registers its OSC 133 handler on `terminal.parser`.
   */
  readonly terminal: Terminal;
  private readonly serializer = new SerializeAddon();
  private readonly valve: ((sig: ValveSignal) => void) | undefined;
  private readonly valveHigh: number;
  private readonly valveLow: number;
  /** Handed to xterm, not yet parsed. `head` indexes the oldest, so a dequeue is O(1). */
  private pending: MirrorChunk[] = [];
  private head = 0;
  private waiters: (() => void)[] = [];
  private _received = 0;
  private _seq = 0;
  private _stopped = false;
  private disposed = false;

  constructor(options: MirrorOptions) {
    this.terminal = new Terminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: options.scrollback ?? MIRROR_SCROLLBACK,
      allowProposedApi: true,
    });
    this.terminal.loadAddon(this.serializer);
    this.valve = options.valve;
    this.valveHigh = options.valveHigh ?? VALVE_HIGH;
    this.valveLow = options.valveLow ?? VALVE_LOW;
  }

  /** Bytes handed to `write` so far. */
  get received(): number {
    return this._received;
  }

  /** Bytes xterm has parsed so far. The screen is exactly these. */
  get seq(): number {
    return this._seq;
  }

  /** Received but not yet parsed. */
  get backlog(): number {
    return this._received - this._seq;
  }

  /** Whether the valve currently holds the session stopped. */
  get stopped(): boolean {
    return this._stopped;
  }

  /** Feeds one chunk of PTY output. Returns the offset just past it — the `end` the channel sends. */
  write(bytes: Uint8Array): number {
    if (this.disposed || bytes.length === 0) return this._received;
    this._received += bytes.length;
    const chunk: MirrorChunk = { bytes, end: this._received };
    this.pending.push(chunk);
    this.terminal.write(bytes, () => this.parsed(chunk));
    if (!this._stopped && this.backlog > this.valveHigh && this.valve !== undefined) {
      this._stopped = true;
      this.valve("SIGSTOP");
    }
    return chunk.end;
  }

  private parsed(chunk: MirrorChunk): void {
    // xterm calls back in write order, so the chunk parsed is always the oldest.
    this._seq = chunk.end;
    this.head++;
    if (this.head > 1024 && this.head * 2 > this.pending.length) {
      this.pending = this.pending.slice(this.head);
      this.head = 0;
    }
    if (this._stopped && this.backlog < this.valveLow && !this.disposed) {
      this._stopped = false;
      this.valve?.("SIGCONT");
    }
    if (this.backlog === 0 && this.waiters.length > 0) {
      const waiters = this.waiters;
      this.waiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  snapshot(): MirrorSnapshot {
    return {
      seq: this._seq,
      cols: this.terminal.cols,
      rows: this.terminal.rows,
      data: this.serializer.serialize(),
    };
  }

  unparsed(): readonly MirrorChunk[] {
    return this.pending.slice(this.head);
  }

  /** Settles once everything received so far has been parsed (or the mirror is disposed). */
  drained(): Promise<void> {
    if (this.backlog === 0 || this.disposed) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    this.terminal.resize(cols, rows);
  }

  /** BEL, as xterm parses it. Returns the unsubscribe. */
  onBell(cb: () => void): () => void {
    const sub = this.terminal.onBell(cb);
    return () => sub.dispose();
  }

  /** OSC 0/2 window titles, as xterm parses them. Returns the unsubscribe. */
  onTitle(cb: (title: string) => void): () => void {
    const sub = this.terminal.onTitleChange(cb);
    return () => sub.dispose();
  }

  /**
   * The text of the line the cursor is on, cells nothing was ever written to
   * trimmed (a prompt's own trailing space is kept). Read from
   * the screen on each call and never kept: it may be a password prompt, and
   * the attention rules only need to look at it.
   */
  cursorLine(): string {
    const buffer = this.terminal.buffer.active;
    return buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) ?? "";
  }

  /**
   * Frees the emulator. A session the valve stopped is continued first, so
   * the hangup the host sends next is not held by a stopped process.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this._stopped) {
      this._stopped = false;
      this.valve?.("SIGCONT");
    }
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
    this.terminal.dispose();
  }
}
