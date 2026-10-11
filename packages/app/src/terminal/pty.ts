/**
 * What a terminal session runs on: a process behind a pseudo-terminal
 * (issue #18).
 *
 * Two implementations: `pty-bun.ts` spawns the real `tailscale ssh` under
 * `Bun.spawn({ terminal })`, and `pty-fixture.ts` is a canned shell that
 * spawns nothing, for fixture mode. The host (`host.ts`) only ever sees this
 * interface, so the mirror, the activity parser and the channel cannot tell
 * the two apart — which is what lets the fixture exercise all of them.
 */

/** The signals the host and the mirror's valve send. Always to the whole process group. */
export type PtySignal = "SIGHUP" | "SIGKILL" | "SIGSTOP" | "SIGCONT";

/**
 * How the process ended. `code` is null when a signal ended it, and `signal`
 * is null when it exited on its own — never both set.
 */
export interface PtyExit {
  code: number | null;
  signal: string | null;
}

export interface PtyLike {
  readonly pid: number;
  /** Bytes for the process's stdin, as if typed. Ignored once the process has exited. */
  write(data: string | Uint8Array): void;
  resize(cols: number, rows: number): void;
  /**
   * Signals the process group the PTY child leads, so a pipeline running in
   * it stops or dies as a whole. A group that is already gone is not an error.
   */
  signalGroup(sig: PtySignal): void;
  /** Closes the PTY. The process sees a hangup if it is still running. */
  close(): void;
  /**
   * Output, in arrival order. Bytes that arrive before the first listener is
   * registered are held and handed to it, so nothing printed between spawn
   * and wiring is lost.
   */
  onData(cb: (bytes: Uint8Array) => void): void;
  /** Settles once, when the process has exited. Never rejects. */
  readonly exited: Promise<PtyExit>;
}

export interface PtySpawnOptions {
  cols: number;
  rows: number;
  /** Added to (and overriding) the PATH-safe base environment. */
  env?: Record<string, string>;
}

/** Starts `argv` behind a PTY. Throws when the process cannot be started at all. */
export type PtySpawner = (argv: string[], opts: PtySpawnOptions) => PtyLike;

/**
 * The listener half every implementation shares: held output until the first
 * listener, then straight through to each listener in order.
 */
export class DataListeners {
  private readonly listeners: ((bytes: Uint8Array) => void)[] = [];
  private held: Uint8Array[] = [];

  add(cb: (bytes: Uint8Array) => void): void {
    this.listeners.push(cb);
    if (this.listeners.length === 1 && this.held.length > 0) {
      const held = this.held;
      this.held = [];
      for (const bytes of held) cb(bytes);
    }
  }

  emit(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    if (this.listeners.length === 0) {
      this.held.push(bytes);
      return;
    }
    for (const cb of this.listeners) cb(bytes);
  }
}
