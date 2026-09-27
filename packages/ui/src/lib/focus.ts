/**
 * The focus contract every dialog surface owes. `components/Dialog.tsx` is the
 * one caller; the surfaces built on it inherit the contract.
 *
 * The drawer is `aria-modal` — a promise to assistive technology that nothing
 * outside it is reachable while it is open — and it kept none of it: Tab walked
 * straight out into the fleet behind it, and closing one dropped focus onto
 * `<body>`, so the next keystroke went nowhere. The popover borrows the trap
 * for the convenience of not tabbing out of a menu, without claiming to be
 * modal (it has no backdrop and closes on an outside click).
 *
 * Three behaviours, one hook:
 *   - on open, focus moves inside — the element marked `data-autofocus`, else
 *     the first focusable, else the dialog itself (which is why callers give
 *     their root `tabIndex={-1}`);
 *   - Tab and Shift+Tab wrap at the ends instead of leaving;
 *   - on close, focus returns to whatever had it before.
 *
 * One document listener routes Escape to the topmost trap, including overlays
 * owned locally by Settings. App only handles Escape when no overlay is open.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";

/**
 * Everything the browser would stop at on Tab. `[data-focus-skip]` is the
 * escape hatch for a control that must not be a Tab stop or the dialog's
 * landing spot. Copy controls remain ordinary, keyboard-reachable buttons.
 *
 * `iframe` is here because the browser stops at one and the trap has to agree:
 * the desktop viewer's frame is the only way a keyboard reaches the agent's own
 * screen, and a trap that did not list it would skip past the one element in
 * the drawer the operator came to type into.
 */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "iframe",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
]
  .map((s) => `${s}:not([data-focus-skip])`)
  .join(",");

/**
 * Everything the browser would *not* stop at even though the selector matched:
 * a subtree the page has marked unreachable, or one that is laid out but not
 * painted. `visibility: hidden` is the one the `offsetParent` check below
 * misses entirely — such an element still has a layout box, so it reads as
 * present and would silently become the drawer's landing spot.
 */
function isUnreachable(el: HTMLElement): boolean {
  // `inert` and `aria-hidden` are the two ways this app (and any portal library
  // it grows) says "this subtree is behind something".
  if (el.closest("[inert]") !== null) return true;
  if (el.closest('[aria-hidden="true"]') !== null) return true;
  if (typeof getComputedStyle !== "function") return false;
  const style = getComputedStyle(el);
  return style.visibility === "hidden" || style.display === "none";
}

/** Tab stops inside `root`, in document order, skipping anything unreachable. */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
    // Whatever currently holds focus is a Tab stop by definition, whatever the
    // computed styles say — that is where the browser is.
    if (el === document.activeElement) return true;
    return !isUnreachable(el);
  });
}

/**
 * Every trap currently mounted, innermost last. Two can be open at once — the
 * `?` sheet is deliberately reachable from inside a drawer — and without a
 * stack both would install a document-level recovery handler, with the *outer*
 * one winning on registration order and pulling focus out of the sheet the
 * operator just opened.
 */
const stack: { root: HTMLElement; previous: HTMLElement | null; dismiss: () => void }[] = [];
let modalCount = 0;
let bodyOverflow = "";

export function hasOpenOverlay(): boolean {
  return stack.length > 0;
}

/** Is this the innermost trap, and therefore the one that owns stray focus? */
export function isTopmostOverlay(root: HTMLElement | null): boolean {
  return stack[stack.length - 1]?.root === root;
}

function dismissTopmost(e: KeyboardEvent) {
  if (
    e.key !== "Escape" ||
    e.defaultPrevented ||
    e.isComposing ||
    e.repeat ||
    e.ctrlKey ||
    e.metaKey ||
    e.altKey ||
    e.shiftKey
  )
    return;
  const top = stack[stack.length - 1];
  if (!top) return;
  e.preventDefault();
  e.stopPropagation();
  top.dismiss();
}

/**
 * Where Tab should go, as arithmetic rather than as DOM.
 *
 * `index` is the position of the currently focused element among the trap's
 * focusables, or `-1` when focus is on the dialog root itself (or has escaped).
 * `null` means "the browser's own Tab is already correct, do not intervene" —
 * the common case, and the reason a trap does not have to move focus on every
 * keystroke.
 */
export function nextTrapTarget(count: number, index: number, shift: boolean): number | null {
  if (count === 0) return null;
  if (shift) return index <= 0 ? count - 1 : null;
  // `index === -1` going forward is focus sitting on the root: the next stop is
  // the first focusable, which is also what the browser would do, so leave it.
  return index === count - 1 ? 0 : null;
}

/**
 * Traps focus inside `ref` while `active`, and restores it on unmount. The
 * caller owns the ref because both primitives already have one (`Popover`
 * measures itself with it, `Drawer` stops the backdrop click with it).
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active = true,
  onDismiss?: () => void,
  modal = false,
): void {
  const dismiss = useRef(onDismiss);
  useLayoutEffect(() => {
    dismiss.current = onDismiss;
    // A form or receipt can replace the focused control without closing.
    // Recover after that render, but never steal focus from nested help.
    const root = ref.current;
    if (!root || !isTopmostOverlay(root) || root.contains(document.activeElement)) return;
    (root.querySelector<HTMLElement>("[data-autofocus]") ?? focusableWithin(root)[0] ?? root).focus({
      preventScroll: true,
    });
  });
  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;

    const entry = {
      root,
      previous: document.activeElement instanceof HTMLElement ? document.activeElement : null,
      dismiss: () => dismiss.current?.(),
    };
    if (stack.length === 0) document.addEventListener("keydown", dismissTopmost);
    stack.push(entry);
    if (modal && modalCount++ === 0) {
      bodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }

    // Callers mark initial fields instead of React autoFocus, so the opener
    // above is captured before focus moves into the dialog.
    if (!root.contains(document.activeElement)) {
      const marked = root.querySelector<HTMLElement>("[data-autofocus]");
      const target = marked ?? focusableWithin(root)[0] ?? root;
      target.focus({ preventScroll: true });
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !isTopmostOverlay(root)) return;
      const items = focusableWithin(root);
      if (items.length === 0) {
        // Nothing to tab between: hold focus on the dialog rather than letting
        // it walk out into the page the dialog claims to have covered.
        e.preventDefault();
        root.focus({ preventScroll: true });
        return;
      }
      const active_ = document.activeElement;
      const index = active_ instanceof HTMLElement ? items.indexOf(active_) : -1;
      const next = nextTrapTarget(items.length, index, e.shiftKey);
      if (next === null) return;
      e.preventDefault();
      items[next]?.focus({ preventScroll: true });
    };

    /**
     * Focus fell out of the dialog without the dialog closing: a drawer that
     * swapped its form for a progress view took the focused element with it, and
     * the browser dropped focus onto `<body>`. A keydown there never reaches the
     * dialog, so it is caught at the document — and only in that one state, so
     * two open traps cannot fight over a focus that is legitimately inside one
     * of them.
     */
    const onOrphanedKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      // Only the innermost trap recovers; see `stack`.
      if (!isTopmostOverlay(root)) return;
      const active_ = document.activeElement;
      if (root.contains(active_)) return;
      const items = focusableWithin(root);
      e.preventDefault();
      (items.length === 0 ? root : e.shiftKey ? items[items.length - 1] : items[0])?.focus({
        preventScroll: true,
      });
    };

    root.addEventListener("keydown", onKeyDown);
    document.addEventListener("keydown", onOrphanedKeyDown);
    return () => {
      const wasTopmost = isTopmostOverlay(root);
      const at = stack.indexOf(entry);
      if (at !== -1) stack.splice(at, 1);
      // A parent can disappear while help stays open. Carry its opener forward
      // rather than later restoring focus into the detached parent.
      for (const child of stack) {
        if (child.previous && root.contains(child.previous)) child.previous = entry.previous;
      }
      if (stack.length === 0) document.removeEventListener("keydown", dismissTopmost);
      if (modal && --modalCount === 0) document.body.style.overflow = bodyOverflow;
      root.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keydown", onOrphanedKeyDown);
      // The element that opened the dialog may itself be gone by now (a
      // tombstone card whose volume was just deleted), in which case there is
      // nothing to return to and the browser's default is right.
      if (!wasTopmost) return;
      const parent = stack[stack.length - 1]?.root;
      const previous = entry.previous;
      if (previous?.isConnected && (!parent || parent.contains(previous))) {
        previous.focus({ preventScroll: true });
      } else if (parent?.isConnected) {
        (focusableWithin(parent)[0] ?? parent).focus({ preventScroll: true });
      }
    };
  }, [ref, active, modal]);
}
