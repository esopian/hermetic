/**
 * A virtualized transcript: only the rows near the viewport are mounted, the
 * rest are stood in for by spacers. No dependency; the layout math is
 * `virtual-layout.ts`.
 *
 * ## Contract
 *
 * `VirtualLog` renders *inside* an existing scroller (the `.ch-log` element),
 * which the caller still owns and renders, as its direct children:
 *
 *   <div aria-hidden="true" data-vspacer="top" style="height: …" />
 *   <div data-vrow="<key>" [data-fresh=""]>…item.node…</div>   (mounted rows)
 *   <div aria-hidden="true" data-vspacer="gap" … />   (only around a held row)
 *   <div aria-hidden="true" data-vspacer="bottom" style="height: …" />
 *
 * The row wrapper *is* the row: pass what used to be inside the keyed `<div>`
 * as `node`, not another wrapper. Wrappers are `display: flow-root` so a
 * child's vertical margin cannot leak out of the measured box. Keys must be
 * unique and stable (a key that moves remounts the row and loses its height).
 *
 * Props: `items`, `scroller`, `pin`, and optionally `overscan` (px each side,
 * default 600), `estimate`, `viewport` (test seam, below), `onRange` (reports
 * the mounted range) and `ref` (`VirtualLogHandle`). Without `estimate`, an
 * unmeasured row is assumed 96px until four rows are measured, then the mean
 * measured height (re-adopted whenever the mean drifts more than 20% from it),
 * so rows mounting above the viewport correct `scrollTop` less often. With
 * `estimate`, that height is fixed.
 *
 * `data-fresh=""` marks a row whose key first appeared in `items` *after* this
 * instance's first commit, not in a prepended run (history loaded above), and
 * only for that row's first mount: the same key remounting after the reader
 * scrolled away and back has no `data-fresh`. A key that left `items` and comes
 * back counts as new. More than one key arriving into an empty list is the
 * history loading on open and is not fresh; a single key into an empty list
 * (the first message of a new conversation) is. Meant for entry animations
 * (`[data-fresh] > .ch-msg { animation: … }`), which then play for new rows and
 * not for every remount while scrolling. Rows of the first commit are not fresh.
 *
 * ## Scroll behaviour — this component is the one owner
 *
 * - Follows the live end through `pin` (`stick-to-bottom.ts`): while
 *   `pin.current.following`, every commit, every row resize and every image
 *   `load`/`error` re-pins to the bottom. The scroll-event rule that ends
 *   following is the shared `trackFollowing`.
 * - When not following, the content in view stays still: the row at the
 *   viewport's top is the anchor, and a row above it growing, rows inserted or
 *   removed above it (a history page prepended), or a new estimate for the
 *   unmeasured rows above it, moves `scrollTop` by exactly what the anchor
 *   moved. The scroller's `overflow-anchor` is set to `none` while mounted, so
 *   Chromium's own scroll anchoring cannot add a second correction that WebKit
 *   would not make.
 * - Rows are measured by one `ResizeObserver` (border box), heights kept per
 *   key, so a row scrolled out and back keeps its height and keys that leave
 *   `items` are evicted. Measurements are ignored while the scroller has no
 *   height (a hidden pane reports every row as 0).
 * - The row holding focus (`document.activeElement` inside it) stays mounted
 *   however far the reader scrolls, between `gap` spacers, so focus is not
 *   dropped to `body` and the keyboard keeps scrolling the log. It is released
 *   once focus leaves it. A `scrollToKey` target is held the same way until it
 *   is mounted.
 *
 * ## Degrade mode and the test seam
 *
 * A scroller with no layout (`clientHeight === 0`, which is every happy-dom
 * test) gets every row and no spacers, so DOM assertions over a transcript
 * see what they saw before. The pin rules still apply. Once a scroller has had
 * a height, a later 0 (a pane hidden with `display: none`) keeps the last
 * window rather than mounting everything. On the commit that creates the
 * scroller too, its ref is not attached yet when this component's layout
 * effect runs, so the first pin and viewport read reach the scroller through
 * the top spacer's `parentElement` (a bounded ~1200px window is drawn first,
 * corrected before paint). Listeners and the observer arrive in a passive
 * effect.
 *
 * `viewport={{ height }}` forces the viewport height for tests that exercise
 * windowing (with a fake `ResizeObserver` feeding row heights). The app passes
 * nothing.
 *
 * ## Integration notes (Thread / RoomConversation)
 *
 * - `pin`: keep Thread's `pin` ref and its open/send handlers that set
 *   `following = true` and call `pinToBottom`; pass the same ref here, and
 *   drop `useStickToBottom(log, pin)` for that scroller — two owners would
 *   fight. `useStickToBottom` stays for logs that are not virtualized.
 * - Mount `VirtualLog` with the scroller, even while it has no rows (render
 *   `Empty` beside it), so its viewport is known when the first rows arrive.
 * - Deep links (`ChatShell` hash, `Subagent` `jumpTo`) cannot query
 *   `[data-chat-message]` for a row that is not mounted. Map the message id to
 *   its row key (the turn's first source id, or the burst key), then
 *   `await handle.scrollToKey(key, { block: "center" })`, and find the
 *   `[data-chat-message]` inside the returned row to `focus({ preventScroll:
 *   true })`. The promise resolves after the row is in the DOM and scrolled
 *   to; null for an unknown key or an unmount.
 * - Find in page: Cmd-F only searches mounted rows; text in unmounted history
 *   is invisible to it. Conversation search (`conversation-search.ts`) plus
 *   `scrollToKey` is the way to reach it.
 * - `view-ack`'s `isAtBottom` keeps working: the spacers keep `scrollHeight`
 *   equal to the estimated full height.
 */
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode, Ref, RefObject } from "react";
import { pinToBottom, trackFollowing } from "../stick-to-bottom.ts";
import type { Pin } from "../stick-to-bottom.ts";
import { DEFAULT_ROW_ESTIMATE_PX, VirtualLayout } from "./virtual-layout.ts";
import type { Segment } from "./virtual-layout.ts";

/** Extra pixels of rows mounted above and below the viewport by default. */
export const DEFAULT_OVERSCAN_PX = 600;

/** The viewport assumed before the scroller exists to be asked. */
const BOOTSTRAP_VIEWPORT_PX = 1200;

/** Measured rows needed before their mean replaces the default estimate. */
const ESTIMATE_MIN_SAMPLES = 4;

/** How far (as a fraction) the mean must drift from the estimate in use to replace it. */
const ESTIMATE_DRIFT = 0.2;

const ROW_STYLE: CSSProperties = { display: "flow-root" };

export interface VirtualItem {
  key: string;
  node: ReactNode;
}

export type ScrollBlock = "start" | "center" | "end";

export interface VirtualLogHandle {
  /**
   * Scroll `key`'s row into view and mount it. Stops following. Resolves with
   * the row element (`[data-vrow]`) once it is in the DOM, or null when the key
   * is unknown, a later call supersedes this one, or the log unmounts.
   */
  scrollToKey(key: string, options?: { block?: ScrollBlock }): Promise<HTMLElement | null>;
  /** The mounted row element for `key`, or null when it is not mounted. */
  rowFor(key: string): HTMLElement | null;
}

export interface VirtualRangeReport {
  /** The window, `[start, end)`. */
  start: number;
  end: number;
  /** False in degrade mode, where every row is mounted. */
  windowed: boolean;
  /** Rows mounted outside the window: the focused row, a scroll target. Ascending. */
  held: readonly number[];
}

export interface VirtualLogProps {
  items: readonly VirtualItem[];
  /** The scrolling element this log renders into. */
  scroller: RefObject<HTMLElement | null>;
  /** Follow state, shared with the caller's open/send handlers. */
  pin: RefObject<Pin>;
  overscan?: number;
  /** A fixed height for unmeasured rows; omit to adapt to the measured mean. */
  estimate?: number;
  /** Test seam: a forced viewport height in place of `clientHeight`. */
  viewport?: { height: number };
  onRange?: (range: VirtualRangeReport) => void;
  ref?: Ref<VirtualLogHandle>;
}

interface Target {
  key: string;
  block: ScrollBlock;
  resolve: (row: HTMLElement | null) => void;
}

/** Everything the listeners and effects share, mutated in place. */
interface Mutable {
  layout: VirtualLayout;
  /** Model `scrollTop`, in the scroller's coordinates. */
  top: number;
  /** Null before it was read; 0 means no layout (degrade). */
  viewport: number | null;
  /** Whether viewport and origin were read from the real scroller yet. */
  primed: boolean;
  /** The scroller's padding-top: content coordinate 0 sits this far down. */
  origin: number;
  /** The last `scrollTop` this component wrote, to tell its own scrolls from the reader's. */
  written: number | null;
  /** A row held still in place of the top row after a `scrollToKey`, until the reader scrolls. */
  hold: string | null;
  /** The next commit must write `top` to the scroller. */
  writeTop: boolean;
  keysChanged: boolean;
  /** Set by the first commit: keys arriving after it can be fresh. */
  committed: boolean;
  /** Fresh keys: false until the row first mounts, true while that first mount lasts. */
  fresh: Map<string, boolean>;
  rendered: VirtualRangeReport | null;
  reported: VirtualRangeReport | null;
  target: Target | null;
  rows: Map<string, HTMLElement>;
  refs: Map<string, (el: HTMLDivElement | null) => void>;
  observer: ResizeObserver | null;
  /** The top spacer: the way to the scroller before the scroller's ref is attached. */
  topPad: HTMLDivElement | null;
  setTopPad: (el: HTMLDivElement | null) => void;
}

function sameRange(a: VirtualRangeReport | null, b: VirtualRangeReport): boolean {
  return (
    a !== null &&
    a.start === b.start &&
    a.end === b.end &&
    a.windowed === b.windowed &&
    a.held.length === b.held.length &&
    a.held.every((index, i) => index === b.held[i])
  );
}

function readOrigin(node: HTMLElement): number {
  const pad = Number.parseFloat(getComputedStyle(node).paddingTop);
  return Number.isFinite(pad) ? pad : 0;
}

function createState(estimate: number): Mutable {
  const state: Mutable = {
    layout: new VirtualLayout(estimate),
    top: 0,
    viewport: null,
    primed: false,
    origin: 0,
    written: null,
    hold: null,
    writeTop: false,
    keysChanged: false,
    committed: false,
    fresh: new Map(),
    rendered: null,
    reported: null,
    target: null,
    rows: new Map(),
    refs: new Map(),
    observer: null,
    topPad: null,
    setTopPad: (el) => {
      state.topPad = el;
    },
  };
  return state;
}

export function VirtualLog(props: VirtualLogProps) {
  const { items, scroller, pin, ref } = props;
  const latest = useRef(props);
  latest.current = props;

  const state = useRef<Mutable | null>(null);
  if (state.current === null) state.current = createState(props.estimate ?? DEFAULT_ROW_ESTIMATE_PX);
  const m = state.current;
  const { layout } = m;
  const [, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);

  /** The scroller, reached through the spacer or a row when its ref is not attached yet. */
  const scrollerNode = (): HTMLElement | null => {
    if (scroller.current) return scroller.current;
    const child = m.topPad ?? m.rows.values().next().value ?? null;
    return child?.parentElement ?? null;
  };

  const readViewport = (node: HTMLElement): number => {
    const forced = latest.current.viewport;
    if (forced) return Math.max(0, forced.height);
    const height = node.clientHeight;
    if (height > 0) return height;
    // A pane hidden after it had a height keeps its window.
    return m.viewport !== null && m.viewport > 0 ? m.viewport : 0;
  };

  const prime = (node: HTMLElement) => {
    m.origin = readOrigin(node);
    m.viewport = readViewport(node);
    m.primed = true;
  };

  const contentTop = () => m.top - m.origin;

  const anchorKey = (): string | null => m.hold ?? layout.keyAt(layout.indexAt(contentTop())) ?? null;

  /** The key of the mounted row holding focus, if any. */
  const focusedKey = (): string | null => {
    const node = scrollerNode();
    const active = typeof document === "undefined" ? null : document.activeElement;
    if (!node || !active || active === node || !node.contains(active)) return null;
    let el: Element | null = active;
    while (el && el.parentElement !== node) el = el.parentElement;
    return el instanceof HTMLElement ? (el.dataset.vrow ?? null) : null;
  };

  const plan = (): { segments: Segment[] | null; report: VirtualRangeReport } => {
    const viewport = m.viewport ?? BOOTSTRAP_VIEWPORT_PX;
    if (viewport <= 0) {
      return {
        segments: null,
        report: { start: 0, end: layout.size, windowed: false, held: [] },
      };
    }
    const top = pin.current.following ? Math.max(0, layout.totalHeight() - viewport) : contentTop();
    const range = layout.window(top, viewport, latest.current.overscan ?? DEFAULT_OVERSCAN_PX);
    const held: number[] = [];
    for (const key of [m.target?.key, focusedKey()]) {
      if (key == null) continue;
      const index = layout.indexOf(key);
      if (index < 0 || (index >= range.start && index < range.end) || held.includes(index)) continue;
      held.push(index);
    }
    held.sort((a, b) => a - b);
    return {
      segments: layout.segments(range, held),
      report: { start: range.start, end: range.end, windowed: true, held },
    };
  };

  /** Re-render when the rows that should be mounted are not the ones that are. */
  const syncRange = () => {
    if (!sameRange(m.rendered, plan().report)) bump();
  };

  /** The adaptive estimate to adopt now, or null to keep the one in use. */
  const estimateDue = (): number | null => {
    if (latest.current.estimate !== undefined) return null;
    const mean = layout.measuredMean();
    if (mean === null || layout.measuredCount < ESTIMATE_MIN_SAMPLES) return null;
    const next = Math.max(1, Math.round(mean));
    return Math.abs(next - layout.estimate) > ESTIMATE_DRIFT * layout.estimate ? next : null;
  };

  /** Keep the content in view still across a layout change above it (render time). */
  const shiftTop = (shift: number) => {
    if (shift === 0 || pin.current.following || (m.viewport ?? 0) <= 0) return;
    m.top += shift;
    m.writeTop = true;
  };

  const writeTop = (node: HTMLElement, top: number) => {
    node.scrollTop = top;
    m.top = node.scrollTop;
    m.written = m.top;
  };

  const pinNow = (node: HTMLElement) => {
    pinToBottom(node, pin.current);
    m.top = node.scrollTop;
    m.written = m.top;
  };

  const targetTop = (key: string, block: ScrollBlock): number => {
    const offset = layout.offsetOf(key) ?? 0;
    const height = layout.heightOf(key);
    const viewport = m.viewport ?? 0;
    const y =
      block === "start"
        ? offset
        : block === "end"
          ? offset + height - viewport
          : offset + height / 2 - viewport / 2;
    return Math.max(0, m.origin + y);
  };

  const rowRef = (key: string) => {
    let callback = m.refs.get(key);
    if (!callback) {
      callback = (el: HTMLDivElement | null) => {
        const prev = m.rows.get(key);
        if (prev && prev !== el) {
          m.observer?.unobserve(prev);
          m.rows.delete(key);
        }
        if (el) {
          m.rows.set(key, el);
          m.observer?.observe(el);
          if (m.fresh.get(key) === false) m.fresh.set(key, true);
        }
      };
      m.refs.set(key, callback);
    }
    return callback;
  };

  // ── render ────────────────────────────────────────────────────────────────

  if (props.estimate !== undefined) layout.setEstimate(props.estimate);
  if (props.viewport) m.viewport = Math.max(0, props.viewport.height);
  else if (!m.primed && scroller.current) {
    prime(scroller.current);
    m.top = scroller.current.scrollTop;
  }

  const sizeBefore = layout.size;
  // Idempotent: a second render of the same list (StrictMode) changes nothing.
  const sync = layout.setKeys(
    items.map((item) => item.key),
    anchorKey(),
  );
  if (sync.changed) {
    m.keysChanged = true;
    if (m.hold && !layout.has(m.hold)) m.hold = null;
    // Several rows landing in an empty log are its history loading on open,
    // not news; one row is the first message of a new conversation.
    const loading = sizeBefore === 0 && sync.added.length > 1;
    if (m.committed && !loading) {
      for (const key of sync.added) {
        // The prepended run is history arriving, not news.
        if (layout.indexOf(key) >= sync.prepended) m.fresh.set(key, false);
      }
    }
    shiftTop(sync.shift);
  }

  const estimate = estimateDue();
  if (estimate !== null) {
    const anchor = anchorKey();
    const before = anchor === null ? null : layout.offsetOf(anchor);
    layout.setEstimate(estimate);
    const after = anchor === null ? null : layout.offsetOf(anchor);
    if (before !== null && after !== null) shiftTop(after - before);
  }

  const { segments, report } = plan();
  m.rendered = report;

  const row = (item: VirtualItem) => (
    <div
      key={item.key}
      data-vrow={item.key}
      data-fresh={m.fresh.has(item.key) ? "" : undefined}
      ref={rowRef(item.key)}
      style={ROW_STYLE}
    >
      {item.node}
    </div>
  );

  const pad = (segment: Extract<Segment, { kind: "pad" }>) => (
    <div
      key={`\u0000vspacer:${segment.at}:${segment.at === "gap" ? segment.start : ""}`}
      aria-hidden="true"
      data-vspacer={segment.at}
      ref={segment.at === "top" ? m.setTopPad : undefined}
      style={{ height: segment.height }}
    />
  );

  /** After every commit: prune, pin or hold still, settle a scroll target. */
  const afterCommit = (node: HTMLElement) => {
    if (m.keysChanged) {
      m.keysChanged = false;
      for (const key of m.refs.keys()) if (!layout.has(key)) m.refs.delete(key);
    }
    for (const [key, mounted] of m.fresh) {
      if (!layout.has(key) || (mounted && !m.rows.has(key))) m.fresh.delete(key);
    }
    if (pin.current.following) pinNow(node);
    else if (m.writeTop) writeTop(node, m.top);
    m.writeTop = false;

    const target = m.target;
    if (target) {
      const el = m.rows.get(target.key);
      if (el) {
        m.target = null;
        if ((m.viewport ?? 0) > 0) {
          const height = el.getBoundingClientRect().height;
          if (height > 0) layout.applyMeasurement(target.key, height);
          m.hold = target.key;
          writeTop(node, targetTop(target.key, target.block));
        } else {
          el.scrollIntoView?.({ block: target.block });
        }
        target.resolve(el);
      } else if (!layout.has(target.key)) {
        m.target = null;
        target.resolve(null);
      }
    }

    const rendered = m.rendered;
    if (rendered && !sameRange(m.reported, rendered)) {
      m.reported = rendered;
      latest.current.onRange?.(rendered);
    }
    syncRange();
  };

  // ── effects ───────────────────────────────────────────────────────────────

  // Listeners and the observer, once per scroller. A passive effect: on the
  // commit that creates the scroller too, its ref is only attached after this
  // component's layout effects ran.
  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    prime(node);
    const overflowAnchor = node.style.overflowAnchor;
    node.style.overflowAnchor = "none";

    // Registered first, so `pin.following` is current when `onScroll` reads it.
    const stopTracking = trackFollowing(node, pin);
    const onScroll = () => {
      const top = node.scrollTop;
      // Not the offset we wrote: the reader scrolled, and a held row is let go.
      if (m.written === null || Math.abs(top - m.written) > 1) {
        m.hold = null;
        m.written = null;
      }
      m.top = top;
      syncRange();
    };
    const repin = () => {
      if (pin.current.following) pinNow(node);
    };
    // Focus moving out of a held row releases it once the move has settled
    // (during `focusout` the new focus is not in place yet).
    let focusTimer: ReturnType<typeof setTimeout> | undefined;
    const onFocusOut = () => {
      clearTimeout(focusTimer);
      focusTimer = setTimeout(syncRange, 0);
    };
    const onResize = (entries: ResizeObserverEntry[]) => {
      const anchor = anchorKey();
      const before = anchor === null ? null : layout.offsetOf(anchor);
      // A hidden pane measures every row as 0; taking that would lose the
      // reader's place when it is shown again.
      const hidden = !latest.current.viewport && node.clientHeight === 0;
      let measured = false;
      let resized = false;
      for (const entry of entries) {
        if (entry.target === node) {
          resized = true;
          continue;
        }
        if (hidden) continue;
        const el = entry.target;
        if (!(el instanceof HTMLElement) || !el.isConnected) continue;
        const key = el.dataset.vrow;
        if (key === undefined || m.rows.get(key) !== el) continue;
        const height = entry.borderBoxSize?.[0]?.blockSize ?? el.getBoundingClientRect().height;
        if (layout.applyMeasurement(key, height).delta !== 0) measured = true;
      }
      if (resized) prime(node);
      if (!measured && !resized) return;
      if (pin.current.following) pinNow(node);
      else if (measured && (m.viewport ?? 0) > 0 && anchor !== null && before !== null) {
        const after = layout.offsetOf(anchor);
        if (after !== null && after !== before) writeTop(node, m.top + (after - before));
      }
      // A new adaptive estimate is adopted at render time, where the spacers
      // that carry it and the `scrollTop` that compensates commit together.
      if (estimateDue() !== null) bump();
      syncRange();
    };

    node.addEventListener("scroll", onScroll, { passive: true });
    // `load`/`error` do not bubble but do capture: an image settling its size
    // re-pins even where there is no ResizeObserver.
    node.addEventListener("load", repin, true);
    node.addEventListener("error", repin, true);
    node.addEventListener("focusout", onFocusOut);
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(onResize) : null;
    m.observer = observer;
    if (observer) {
      observer.observe(node);
      for (const el of m.rows.values()) observer.observe(el);
    }
    afterCommit(node);

    return () => {
      stopTracking();
      clearTimeout(focusTimer);
      node.removeEventListener("scroll", onScroll);
      node.removeEventListener("load", repin, true);
      node.removeEventListener("error", repin, true);
      node.removeEventListener("focusout", onFocusOut);
      observer?.disconnect();
      m.observer = null;
      node.style.overflowAnchor = overflowAnchor;
      const target = m.target;
      m.target = null;
      target?.resolve(null);
    };
  }, [scroller, pin]);

  // Every commit. On the one that creates the scroller as well, its ref is not
  // attached yet; the spacer's parent is the scroller, so the first viewport
  // read and the first pin still land before paint.
  useLayoutEffect(() => {
    m.committed = true;
    const node = scrollerNode();
    if (!node) return;
    if (!m.primed) prime(node);
    afterCommit(node);
  });

  useImperativeHandle(
    ref,
    (): VirtualLogHandle => ({
      scrollToKey: (key, options) =>
        new Promise<HTMLElement | null>((resolve) => {
          const node = scrollerNode();
          if (!node || !layout.has(key)) {
            resolve(null);
            return;
          }
          const previous = m.target;
          const block = options?.block ?? "center";
          m.target = { key, block, resolve };
          previous?.resolve(null);
          // Navigating to a row is leaving the live end.
          pin.current.following = false;
          pin.current.pinnedTop = null;
          if ((m.viewport ?? 0) > 0) {
            m.hold = key;
            m.top = targetTop(key, block);
            m.writeTop = true;
          }
          bump();
        }),
      rowFor: (key) => m.rows.get(key) ?? null,
    }),
    [scroller, pin],
  );

  return (
    <>
      {segments
        ? // One flat keyed list, so a held row appearing does not shift the
          // window's rows to another slot and remount them.
          segments.flatMap((segment) =>
            segment.kind === "pad" ? [pad(segment)] : items.slice(segment.start, segment.end).map(row),
          )
        : items.map(row)}
    </>
  );
}
