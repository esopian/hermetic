/**
 * The page's reducer notes (§9.2 "Developer tools", T3): what the page's turn
 * reducer did with each frame — a new block, a replacement and its version, an
 * appended delta, a frame dropped as stale or duplicate, a live message
 * replaced by a transcript read. Only the page can see this, so it is recorded
 * here rather than by core's capture.
 *
 * Module state rather than React state: the chat store's frame handler
 * (`chat-conversations.ts`) is a hot path outside any component, and a note
 * must be recorded whether or not an inspector is drawing it (with
 * `capture: "always"` the inspector opens with history already in it). Every
 * call site sits behind one boolean, `devtap.on`, so with the tools off a frame
 * costs one property read and nothing else.
 *
 * The merge key a block replaces on is the store's own (`blockKey`,
 * `chat-state.tsx`), registered with `setMergeKey` rather than imported: the store
 * imports this module, and a block counts as replaced exactly when
 * `mergeBlock` replaced it.
 *
 * Bounded per conversation to the same `keep` core's ring uses
 * (`state/devtools-store.ts` configures it from the settings row).
 */
import {
  conversationKey,
  type ConversationRef,
  type PageNote,
  type ReducerOutcome,
} from "./inspector-logic.ts";

export type Capture = "always" | "while_open";

/** The slice of a turn frame a note reads. */
interface FrameLike {
  type: string;
  seq?: number;
  block?: unknown;
  text?: string;
}

const NOTIFY_MS = 16;

export class PageCapture {
  /** The one thing a frame handler reads while the tools are off. */
  on = false;
  private enabled = false;
  private capture: Capture = "always";
  private keep = 5000;
  private watched = new Map<string, number>();
  private notes = new Map<string, PageNote[]>();
  /** Per conversation, per `message key`: how many versions of a keyed block it has seen. */
  private versions = new Map<string, Map<string, number>>();
  /** Per conversation: messages some of whose notes have fallen off the ring. */
  private truncated = new Map<string, Set<string>>();
  private listeners = new Map<string, Set<() => void>>();
  private pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private next = 0;
  private keyOf: (block: never) => string | null = () => null;
  private origin = typeof performance === "undefined" ? 0 : performance.timeOrigin;

  /** The store's merge key, so a replacement here is a replacement there. */
  setMergeKey(keyOf: (block: never) => string | null): void {
    this.keyOf = keyOf;
  }

  configure(settings: { enabled: boolean; capture?: Capture; keep?: number }): void {
    this.enabled = settings.enabled;
    if (settings.capture !== undefined) this.capture = settings.capture;
    if (settings.keep !== undefined) this.keep = settings.keep;
    if (!this.enabled) {
      this.notes.clear();
      this.versions.clear();
      this.truncated.clear();
    } else {
      for (const [key, list] of this.notes)
        if (list.length > this.keep) this.evict(key, list, list.length - this.keep);
    }
    this.recompute();
  }

  private recompute(): void {
    this.on = this.enabled && (this.capture === "always" || this.watched.size > 0);
  }

  private wants(key: string): boolean {
    return this.enabled && (this.capture === "always" || this.watched.has(key));
  }

  /** An inspector is open on this conversation. Returns the release. */
  watch(conversation: ConversationRef): () => void {
    const key = conversationKey(conversation);
    this.watched.set(key, (this.watched.get(key) ?? 0) + 1);
    this.recompute();
    return () => {
      const n = (this.watched.get(key) ?? 1) - 1;
      if (n <= 0) this.watched.delete(key);
      else this.watched.set(key, n);
      this.recompute();
    };
  }

  /** Drop the oldest `count` notes, remembering whose they were. */
  private evict(key: string, list: PageNote[], count: number): void {
    const gone = list.splice(0, count);
    const set = this.truncated.get(key) ?? new Set<string>();
    for (const note of gone) {
      if (note.message === null) continue;
      set.delete(note.message);
      set.add(note.message);
    }
    // Bounded like the notes: a message with no note left needs no marker.
    while (set.size > this.keep) {
      const oldest = set.values().next();
      if (oldest.done === true) break;
      set.delete(oldest.value);
    }
    this.truncated.set(key, set);
  }

  /** Messages whose oldest notes were evicted: the State view marks them partial. */
  truncatedFor(conversation: ConversationRef): ReadonlySet<string> {
    return this.truncated.get(conversationKey(conversation)) ?? EMPTY_SET;
  }

  notesFor(conversation: ConversationRef): readonly PageNote[] {
    return this.notes.get(conversationKey(conversation)) ?? EMPTY_NOTES;
  }

  subscribe(conversation: ConversationRef, fn: () => void): () => void {
    const key = conversationKey(conversation);
    const set = this.listeners.get(key) ?? new Set();
    set.add(fn);
    this.listeners.set(key, set);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.listeners.delete(key);
    };
  }

  clear(conversation?: ConversationRef): void {
    if (conversation === undefined) {
      const keys = [...this.notes.keys()];
      this.notes.clear();
      this.versions.clear();
      this.truncated.clear();
      for (const key of keys) this.changed(key);
      return;
    }
    const key = conversationKey(conversation);
    this.notes.delete(key);
    this.versions.delete(key);
    this.truncated.delete(key);
    this.changed(key);
  }

  private add(conversation: ConversationRef, note: Omit<PageNote, "id" | "at" | "mono">): void {
    const key = conversationKey(conversation);
    if (!this.wants(key)) return;
    const mono = typeof performance === "undefined" ? Date.now() : performance.now();
    const full: PageNote = { id: `p${++this.next}`, at: this.origin + mono, mono, ...note };
    const list = this.notes.get(key) ?? [];
    list.push(full);
    if (list.length > this.keep) this.evict(key, list, list.length - this.keep);
    this.notes.set(key, list);
    this.changed(key);
  }

  private changed(key: string): void {
    if (!this.listeners.has(key)) return;
    this.pending.add(key);
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const keys = [...this.pending];
      this.pending.clear();
      for (const k of keys) for (const fn of this.listeners.get(k) ?? []) fn();
    }, NOTIFY_MS);
  }

  /** A frame the reducer refused: older than the last it applied, or the same delta twice. */
  dropped(
    conversation: ConversationRef,
    frame: FrameLike,
    reason: "seq_lt_last" | "dup",
    message: string | null,
  ): void {
    this.add(conversation, {
      type: frame.type,
      seq: frame.seq ?? null,
      outcome: { kind: "dropped", reason },
      message,
      key: null,
    });
  }

  /** A frame the reducer folded into the live message `message`. */
  applied(conversation: ConversationRef, frame: FrameLike, message: string | null): void {
    if (!this.wants(conversationKey(conversation))) return;
    let outcome: ReducerOutcome;
    let key: string | null = null;
    if (frame.type === "block" && frame.block !== undefined) {
      key = this.keyOf(frame.block as never);
      if (key === null) outcome = { kind: "new_block" };
      else {
        const convKey = conversationKey(conversation);
        const seen = this.versions.get(convKey) ?? new Map<string, number>();
        this.versions.set(convKey, seen);
        const slot = `${message ?? ""}\u0000${key}`;
        const version = (seen.get(slot) ?? 0) + 1;
        // Re-inserted so the map's order is recency, and bounded like the
        // notes: a key older than `keep` notes has no note left to number.
        seen.delete(slot);
        seen.set(slot, version);
        while (seen.size > this.keep) {
          const oldest = seen.keys().next();
          if (oldest.done === true) break;
          seen.delete(oldest.value);
        }
        outcome = version === 1 ? { kind: "new_block" } : { kind: "replaced", version };
      }
    } else if (frame.type === "delta") outcome = { kind: "appended" };
    else if (frame.type === "error") outcome = { kind: "failed" };
    else outcome = { kind: "applied" };
    this.add(conversation, {
      type: frame.type,
      seq: frame.seq ?? null,
      outcome,
      message,
      key,
      ...(frame.type === "block" ? { block: frame.block } : {}),
      ...(frame.type === "delta" && typeof frame.text === "string" ? { text: frame.text } : {}),
    });
  }

  /**
   * A steer closed the live message `from` off as the part `to`: its blocks,
   * and the version count of each, now belong to `to`, so a block that later
   * lands on that part is numbered as the replacement it is.
   */
  segment(conversation: ConversationRef, from: string, to: string): void {
    const key = conversationKey(conversation);
    if (!this.wants(key)) return;
    const seen = this.versions.get(key);
    if (seen !== undefined) {
      const prefix = `${from}\u0000`;
      for (const [slot, version] of [...seen]) {
        if (!slot.startsWith(prefix)) continue;
        seen.delete(slot);
        seen.set(`${to}\u0000${slot.slice(prefix.length)}`, version);
      }
    }
    if (this.truncated.get(key)?.has(from)) this.truncated.get(key)?.add(to);
    this.add(conversation, {
      type: "segment",
      seq: null,
      outcome: { kind: "segment", from },
      message: to,
      key: null,
    });
  }

  /** A transcript read replaced the live message this page assembled. */
  history(conversation: ConversationRef, message: string): void {
    this.add(conversation, {
      type: "history",
      seq: null,
      outcome: { kind: "history" },
      message,
      key: null,
    });
  }
}

export const EMPTY_NOTES: readonly PageNote[] = [];
const EMPTY_SET: ReadonlySet<string> = new Set();

export const devtap = new PageCapture();
