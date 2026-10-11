/**
 * A hand-advanced clock for the terminal suites: coalescing, resync throttles
 * and the fixture shell's `sleep` run in microseconds of real time.
 */
import type { TimerHandle, Timers } from "../../src/terminal/timers.ts";

interface Pending {
  id: number;
  at: number;
  fn: () => void;
}

export class FakeTimers implements Timers {
  private time = 0;
  private nextId = 1;
  private pending: Pending[] = [];

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    this.pending.push({ id, at: this.time + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(handle: TimerHandle): void {
    this.pending = this.pending.filter((p) => p.id !== handle);
  }

  /** How many timers are waiting. */
  get size(): number {
    return this.pending.length;
  }

  /** Moves the clock forward, firing every timer that falls due on the way, in order. */
  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const due = this.pending
        .filter((p) => p.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (due === undefined) break;
      this.pending = this.pending.filter((p) => p.id !== due.id);
      this.time = Math.max(this.time, due.at);
      due.fn();
    }
    this.time = target;
  }
}
