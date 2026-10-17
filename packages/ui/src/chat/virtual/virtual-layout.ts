/**
 * Layout math for a virtualized transcript: which rows to mount for a scroll
 * position, how tall the unmounted ones are assumed to be, and how far the
 * content in view moved when a row was measured or rows were inserted above it.
 *
 * Framework-free and DOM-free, so it is tested as plain arithmetic
 * (`test/virtual-layout.test.ts`). `VirtualLog.tsx` is its only caller.
 *
 * Coordinates are "content" coordinates: 0 is the top of the first row, and the
 * scroller's own padding is the caller's business. Heights are keyed by the row
 * key, never by index, so a measurement survives the row being unmounted and
 * remounted, and rows inserted in front of it. A key that leaves the list is
 * evicted with its height.
 *
 * Cost: the prefix-offset array is rebuilt lazily, O(n), at most once per
 * change; every query after that is O(1) or O(log n). A few thousand rows is
 * the realistic ceiling for one conversation.
 */

/** The height assumed for a row nobody has measured yet. */
export const DEFAULT_ROW_ESTIMATE_PX = 96;

/** The rows to mount, `[start, end)`, and the space the rest stand in for. */
export interface VirtualRange {
  start: number;
  end: number;
  /** Height of the unmounted rows above `start`. */
  topPad: number;
  /** Height of the unmounted rows from `end` on. */
  bottomPad: number;
}

/** What one measurement changed. */
export interface Measurement {
  /** New height minus the height the layout held before (measured or estimated). */
  delta: number;
  /**
   * Whether the row lies wholly above the row at the given `scrollTop`, so the
   * caller must move `scrollTop` by `delta` to keep the content in view still.
   */
  above: boolean;
}

/** What replacing the key list changed. */
export interface KeySync {
  /** False when the list was identical: nothing else in this result moved. */
  changed: boolean;
  /** How many keys at the front are new (absent from the old list). */
  prepended: number;
  /** Their summed height (measured or estimated) — the classic prepend compensation. */
  prependShift: number;
  /**
   * How far the anchor row moved: its new offset minus its old one. When the
   * anchor itself left the list, the first surviving row after it stands in.
   * Zero with no anchor or no survivor.
   */
  shift: number;
  /** How many keys were dropped, with their heights. */
  evicted: number;
  /** Keys absent from the old list, in list order (the prepended run included). */
  added: readonly string[];
}

/**
 * What to draw, top to bottom: runs of mounted rows `[start, end)` and pads
 * standing in for the unmounted rows between them. The first and last entries
 * are always pads (possibly 0px high); a pad between two runs only appears when
 * rows lie between them.
 */
export type Segment =
  | { kind: "pad"; at: "top" | "gap" | "bottom"; start: number; end: number; height: number }
  | { kind: "rows"; start: number; end: number };

export class VirtualLayout {
  #estimate: number;
  #keys: string[] = [];
  #index = new Map<string, number>();
  #heights = new Map<string, number>();
  /** `#prefix[i]` is the offset of row `i`; `#prefix[n]` is the total. Null when stale. */
  #prefix: Float64Array | null = null;
  /** Sum and count of the measured heights, for `measuredMean`. */
  #measuredSum = 0;
  #measuredCount = 0;

  constructor(estimate: number = DEFAULT_ROW_ESTIMATE_PX) {
    this.#estimate = validHeight(estimate) ? estimate : DEFAULT_ROW_ESTIMATE_PX;
  }

  get size(): number {
    return this.#keys.length;
  }

  get estimate(): number {
    return this.#estimate;
  }

  /** Change the assumed height of unmeasured rows. */
  setEstimate(estimate: number): void {
    if (!validHeight(estimate) || estimate === this.#estimate) return;
    this.#estimate = estimate;
    this.#prefix = null;
  }

  keys(): readonly string[] {
    return this.#keys;
  }

  keyAt(index: number): string | undefined {
    return this.#keys[index];
  }

  indexOf(key: string): number {
    return this.#index.get(key) ?? -1;
  }

  has(key: string): boolean {
    return this.#index.has(key);
  }

  isMeasured(key: string): boolean {
    return this.#heights.has(key);
  }

  /** The measured height, else the estimate. */
  heightOf(key: string): number {
    return this.#heights.get(key) ?? this.#estimate;
  }

  /** The row's top in content coordinates, or null for an unknown key. */
  offsetOf(key: string): number | null {
    const index = this.#index.get(key);
    if (index === undefined) return null;
    return this.#offsets()[index] ?? null;
  }

  totalHeight(): number {
    const prefix = this.#offsets();
    return prefix[prefix.length - 1] ?? 0;
  }

  /**
   * The index of the row containing `y`, clamped to the list: a `y` above the
   * first row answers 0, one past the last row answers the last. -1 when empty.
   */
  indexAt(y: number): number {
    const n = this.#keys.length;
    if (n === 0) return -1;
    const prefix = this.#offsets();
    if (!(y > 0)) return 0;
    // The largest i in [0, n-1] with prefix[i] <= y.
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if ((prefix[mid] ?? 0) <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /**
   * The rows to mount for a viewport of `viewportHeight` at `scrollTop`, with
   * `overscanPx` of extra rows on either side.
   */
  window(scrollTop: number, viewportHeight: number, overscanPx: number): VirtualRange {
    const n = this.#keys.length;
    if (n === 0) return { start: 0, end: 0, topPad: 0, bottomPad: 0 };
    const prefix = this.#offsets();
    const overscan = Math.max(0, overscanPx);
    const top = Math.max(0, scrollTop) - overscan;
    const bottom = Math.max(0, scrollTop) + Math.max(0, viewportHeight) + overscan;
    const start = this.indexAt(top);
    const end = Math.max(start + 1, this.indexAt(bottom) + 1);
    return this.#range(start, Math.min(n, end), prefix);
  }

  /**
   * The window `range` plus single `held` rows outside it (a scroll target, the
   * row holding focus), as runs of rows and the pads between them. Held indices
   * out of bounds or already inside the window are ignored.
   */
  segments(range: VirtualRange, held: readonly number[] = []): Segment[] {
    const n = this.#keys.length;
    const prefix = this.#offsets();
    const runs: { start: number; end: number }[] = [];
    if (range.end > range.start) runs.push({ start: range.start, end: range.end });
    for (const index of held) {
      if (!Number.isInteger(index) || index < 0 || index >= n) continue;
      if (index >= range.start && index < range.end) continue;
      runs.push({ start: index, end: index + 1 });
    }
    runs.sort((a, b) => a.start - b.start);
    const merged: { start: number; end: number }[] = [];
    for (const run of runs) {
      const last = merged[merged.length - 1];
      if (last && run.start <= last.end) last.end = Math.max(last.end, run.end);
      else merged.push({ ...run });
    }
    const span = (start: number, end: number) => (prefix[end] ?? 0) - (prefix[start] ?? 0);
    const out: Segment[] = [];
    let cursor = 0;
    for (const [i, run] of merged.entries()) {
      if (i === 0 || run.start > cursor) {
        const at = i === 0 ? "top" : "gap";
        out.push({ kind: "pad", at, start: cursor, end: run.start, height: span(cursor, run.start) });
      }
      out.push({ kind: "rows", start: run.start, end: run.end });
      cursor = run.end;
    }
    if (merged.length === 0) out.push({ kind: "pad", at: "top", start: 0, end: 0, height: 0 });
    out.push({ kind: "pad", at: "bottom", start: cursor, end: n, height: span(cursor, n) });
    return out;
  }

  /** The mean of the measured heights, or null before any measurement. */
  measuredMean(): number | null {
    return this.#measuredCount === 0 ? null : this.#measuredSum / this.#measuredCount;
  }

  get measuredCount(): number {
    return this.#measuredCount;
  }

  /**
   * Record a row's measured height. `scrollTop` (content coordinates), when
   * given, is where the viewport's top sits, and decides `above`. A non-finite
   * or negative height, or an unknown key, changes nothing.
   */
  applyMeasurement(key: string, height: number, scrollTop?: number): Measurement {
    const index = this.#index.get(key);
    if (index === undefined || !validHeight(height)) return { delta: 0, above: false };
    const delta = height - this.heightOf(key);
    const above = scrollTop !== undefined && index < this.indexAt(scrollTop);
    this.#forget(key);
    this.#heights.set(key, height);
    this.#measuredSum += height;
    this.#measuredCount += 1;
    if (delta !== 0) this.#prefix = null;
    return { delta, above };
  }

  /**
   * Replace the key list. Heights of keys still present are kept, the rest are
   * evicted. `anchorKey` is the row the caller keeps still on screen (usually
   * the one at the viewport's top); `shift` says how far it moved, which is what
   * the caller adds to `scrollTop`.
   */
  setKeys(keys: readonly string[], anchorKey?: string | null): KeySync {
    const old = this.#keys;
    if (sameKeys(old, keys)) {
      return { changed: false, prepended: 0, prependShift: 0, shift: 0, evicted: 0, added: [] };
    }
    // Old offsets, read before anything moves.
    const oldPrefix = this.#offsets();
    const oldIndex = this.#index;

    const index = new Map<string, number>();
    for (const [i, key] of keys.entries()) index.set(key, i);

    let prepended = 0;
    let prependShift = 0;
    if (old.length > 0) {
      for (const key of keys) {
        if (oldIndex.has(key)) break;
        prepended += 1;
        prependShift += this.heightOf(key);
      }
    }

    // The anchor, or the first row after it that survives.
    let survivor: string | null = null;
    const anchorAt = anchorKey == null ? undefined : oldIndex.get(anchorKey);
    if (anchorAt !== undefined) {
      for (let i = anchorAt; i < old.length; i++) {
        const key = old[i];
        if (key !== undefined && index.has(key)) {
          survivor = key;
          break;
        }
      }
    }
    const oldOffset = survivor === null ? null : (oldPrefix[oldIndex.get(survivor) ?? 0] ?? null);

    let evicted = 0;
    for (const key of old) {
      if (index.has(key)) continue;
      evicted += 1;
      this.#forget(key);
    }
    const added = keys.filter((key) => !oldIndex.has(key));
    this.#keys = [...keys];
    this.#index = index;
    this.#prefix = null;

    const newOffset = survivor === null ? null : this.offsetOf(survivor);
    const shift = oldOffset === null || newOffset === null ? 0 : newOffset - oldOffset;
    return { changed: true, prepended, prependShift, shift, evicted, added };
  }

  /** Drop a key's measurement, keeping the running mean true. */
  #forget(key: string): void {
    const height = this.#heights.get(key);
    if (height === undefined) return;
    this.#heights.delete(key);
    this.#measuredSum -= height;
    this.#measuredCount -= 1;
  }

  #range(start: number, end: number, prefix: Float64Array): VirtualRange {
    const total = prefix[prefix.length - 1] ?? 0;
    const topPad = prefix[start] ?? 0;
    const bottomPad = total - (prefix[end] ?? total);
    return { start, end, topPad, bottomPad };
  }

  #offsets(): Float64Array {
    if (this.#prefix) return this.#prefix;
    const n = this.#keys.length;
    const prefix = new Float64Array(n + 1);
    let at = 0;
    for (let i = 0; i < n; i++) {
      prefix[i] = at;
      at += this.heightOf(this.#keys[i] ?? "");
    }
    prefix[n] = at;
    this.#prefix = prefix;
    return prefix;
  }
}

function validHeight(height: number): boolean {
  return Number.isFinite(height) && height >= 0;
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
