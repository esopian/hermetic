/**
 * Page → session keystrokes, in order (issue #18).
 *
 * `terminal.input` is a fire-and-forget message, and a paste arrives as many
 * of them, so each carries `in_seq`: the sender's count of chunks sent to this
 * session, from 0. The sequencer applies chunks in that order and reports,
 * rather than guesses at, anything it cannot place:
 *
 * - `INPUT_TOO_LARGE`: a chunk over `INPUT_CHUNK_MAX`. It is skipped, its
 *   place in the sequence consumed, so the chunks after it still apply.
 * - `INPUT_GAP`: a chunk never arrived and the sequencer stopped waiting for
 *   it — more than `INPUT_REORDER_WINDOW` later chunks are held. Reported
 *   once, naming the first missing `in_seq`; the held chunks then apply.
 * - `INPUT_STALE`: a chunk at or below one already applied, i.e. a duplicate.
 *   Dropped.
 *
 * `in_seq` 0 starts a new sequence: a page that reloaded counts from 0 again,
 * and its first keystroke must not be refused as stale. Two windows typing
 * into one session at once share one counter space and would collide; they
 * get no ordering guarantee beyond the bridge's own.
 */

/** Largest chunk applied: UTF-16 code units for text, bytes for binary. */
export const INPUT_CHUNK_MAX = 16 * 1024;
/** Out-of-order chunks held while waiting for a missing one. */
export const INPUT_REORDER_WINDOW = 64;

export type InputErrorCode = "INPUT_TOO_LARGE" | "INPUT_GAP" | "INPUT_STALE";

export interface InputSequencerOptions {
  /** Writes one chunk to the PTY. */
  apply(data: string | Uint8Array): void;
  /** Reports a chunk that was not applied; the host turns it into an `input_error` frame. */
  error(inSeq: number, code: InputErrorCode): void;
}

export class InputSequencer {
  private next = 0;
  /** Waiting for an earlier chunk. `null` holds the place of an oversize one, not its bytes. */
  private readonly held = new Map<number, string | Uint8Array | null>();

  constructor(private readonly options: InputSequencerOptions) {}

  accept(inSeq: number, data: string | Uint8Array): void {
    if (!Number.isSafeInteger(inSeq) || inSeq < 0) return;
    if (inSeq === 0 && this.next > 0) {
      // A new sender epoch: what was held belongs to the old one.
      this.held.clear();
      this.next = 0;
    }
    if (inSeq < this.next || this.held.has(inSeq)) {
      this.options.error(inSeq, "INPUT_STALE");
      return;
    }
    const size = typeof data === "string" ? data.length : data.byteLength;
    this.held.set(inSeq, size > INPUT_CHUNK_MAX ? null : data);
    this.drain();
    if (this.held.size > INPUT_REORDER_WINDOW) {
      // Stop waiting: report the first missing chunk and resume at the oldest
      // held one. One report, not one per missing chunk, so a sender that
      // jumps its counter cannot make this loop for as long as it likes.
      const oldest = Math.min(...this.held.keys());
      this.options.error(this.next, "INPUT_GAP");
      this.next = oldest;
      this.drain();
    }
  }

  private drain(): void {
    for (let data = this.held.get(this.next); data !== undefined; data = this.held.get(this.next)) {
      const inSeq = this.next;
      this.held.delete(inSeq);
      this.next++;
      if (data === null) this.options.error(inSeq, "INPUT_TOO_LARGE");
      else this.options.apply(data);
    }
  }
}
