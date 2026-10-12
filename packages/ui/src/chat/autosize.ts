/**
 * The composer's height follows what is typed in it.
 *
 * A textarea does not grow by itself in WebKit (`field-sizing: content` is not
 * something the shipped renderer can be relied on for), so the height is set
 * from `scrollHeight`: collapse to `auto`, read how tall the text is, then set
 * that — up to a cap, past which the box stops growing and scrolls. The cap is
 * twelve lines or 40% of the window, whichever is smaller, so a long draft
 * never pushes the transcript it answers off the screen.
 *
 * The textarea this runs on carries no padding or border of its own (the box
 * around it has them), so `scrollHeight` is exactly the text's height.
 */
import { useEffect, useLayoutEffect } from "react";
import type { RefObject } from "react";

/** Lines the composer grows to before it scrolls. */
export const AUTOSIZE_MAX_LINES = 12;
/** The share of the window's height the composer may take before it scrolls. */
export const AUTOSIZE_MAX_VIEWPORT = 0.4;

/** The tallest the input may grow, in pixels: never less than one line. */
export function autosizeMax(lineHeight: number, viewportHeight: number): number {
  const byLines = Math.ceil(lineHeight * AUTOSIZE_MAX_LINES);
  const byViewport = Math.floor(viewportHeight * AUTOSIZE_MAX_VIEWPORT);
  return Math.max(Math.ceil(lineHeight), Math.min(byLines, byViewport));
}

/** The computed line height in pixels, with a fallback for `normal` or a missing style. */
function lineHeightOf(el: HTMLElement): number {
  const style = window.getComputedStyle(el);
  const line = Number.parseFloat(style.lineHeight);
  if (Number.isFinite(line) && line > 0) return line;
  const font = Number.parseFloat(style.fontSize);
  return (Number.isFinite(font) && font > 0 ? font : 14) * 1.6;
}

/** Fit `el` to its text, clamped to `autosizeMax`; scroll inside it past that. */
export function autosize(el: HTMLTextAreaElement): void {
  const max = autosizeMax(lineHeightOf(el), window.innerHeight);
  // Collapsing to `auto` clamps the scroll offset; put it back afterwards so a
  // draft taller than the cap does not jump while it is being edited.
  const top = el.scrollTop;
  el.style.height = "auto";
  const content = el.scrollHeight;
  el.style.height = `${Math.min(content, max)}px`;
  el.style.overflowY = content > max ? "auto" : "hidden";
  el.scrollTop = top;
}

/**
 * Keep `ref`'s textarea fitted: on every change of `value` (typing, a restored
 * draft, the clear after a send, a mention inserted), when the window resizes,
 * and when the textarea's own width changes (a pane opening beside the thread
 * rewraps the text without resizing the window).
 */
export function useAutosize(ref: RefObject<HTMLTextAreaElement | null>, value: string): void {
  useLayoutEffect(() => {
    if (ref.current) autosize(ref.current);
  }, [ref, value]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const refit = () => {
      if (ref.current) autosize(ref.current);
    };
    window.addEventListener("resize", refit);
    // Width only: the height is what this sets, and reacting to it would loop.
    let width = el.clientWidth;
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (el.clientWidth === width) return;
            width = el.clientWidth;
            refit();
          });
    observer?.observe(el);
    return () => {
      window.removeEventListener("resize", refit);
      observer?.disconnect();
    };
  }, [ref]);
}
