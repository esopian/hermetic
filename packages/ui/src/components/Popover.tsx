/**
 * A popover anchored under its trigger, clamped to the viewport. Chrome is
 * the design's: 3px side and bottom borders, no top border — it hangs off the
 * strip above it.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import { isTopmostOverlay } from "../lib/focus.ts";
import { Dialog } from "./Dialog.tsx";

export function Popover({
  anchor,
  onClose,
  children,
  maxWidth = 620,
  label,
  style,
}: {
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
  maxWidth?: number;
  label?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState({ top: 12, left: 12, width: 420, maxHeight: 600 });

  useLayoutEffect(() => {
    const place = () => {
      /*
       * The strip a popover hangs off is the header when its trigger sits in
       * one (the bell), not the trigger itself: the bell is a 40px box centred
       * in a 64px header, so hanging off the bell left the popover's
       * borderless top floating a dozen pixels above the header's seam.
       * Horizontally it still lines up with the trigger.
       */
      const trigger = anchor.current?.getBoundingClientRect();
      const strip = anchor.current?.closest(".header")?.getBoundingClientRect();
      const r =
        trigger && strip ? { top: strip.top, bottom: strip.bottom, left: trigger.left } : trigger;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const width = Math.max(0, Math.min(maxWidth, vw - 24));
      const height = Math.max(
        ref.current?.getBoundingClientRect().height ?? 0,
        ref.current?.scrollHeight ?? 0,
      );
      const below = Math.max(0, vh - (r?.bottom ?? 12) - 12);
      const above = Math.max(0, (r?.top ?? 12) - 12);
      const flip = !!r && height > below && above > below;
      const maxHeight = Math.max(0, Math.min(vh - 24, flip ? above : below));
      const top = flip ? r.top - Math.min(height, maxHeight) : (r?.bottom ?? 12);
      const next = {
        top: Math.max(12, Math.min(top, vh - Math.min(height, maxHeight) - 12)),
        left: Math.max(12, Math.min(r?.left ?? vw - width - 12, vw - width - 12)),
        width,
        maxHeight,
      };
      setRect((old) =>
        old.top === next.top &&
        old.left === next.left &&
        old.width === next.width &&
        old.maxHeight === next.maxHeight
          ? old
          : next,
      );
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    const observer = new ResizeObserver(place);
    if (ref.current) {
      observer.observe(ref.current);
      for (const child of ref.current.children) observer.observe(child);
    }
    if (anchor.current) observer.observe(anchor.current);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      observer.disconnect();
    };
  }, [anchor, maxWidth]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const el = ref.current;
      if (
        el &&
        isTopmostOverlay(el) &&
        !el.contains(e.target as Node) &&
        !anchor.current?.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [anchor, onClose]);

  // Focus in on open, Tab wraps, focus back to the trigger on close — which for
  // a popover is the button it hangs off.
  //
  // Deliberately not modal: this has no backdrop, does not make the page
  // inert, and closes on an outside click, so claiming the rest of the
  // document is unavailable would be a promise it does not keep. The trap is
  // the convenience of not tabbing out of a menu; the dialog role and the
  // label are the semantics.
  return (
    <Dialog
      ref={ref}
      className="popover"
      label={label}
      onDismiss={onClose}
      style={{ ...rect, minWidth: 0, overflowY: "auto", boxSizing: "border-box", ...style }}
    >
      {children}
    </Dialog>
  );
}
