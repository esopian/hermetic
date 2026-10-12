/**
 * The inbox's small menus — snooze, mute, and the centre's `⋯` — anchored to
 * the control that opened them.
 *
 * A `Dialog` like every other overlay, so it joins the shared focus stack:
 * while it is open it is the topmost trap, Escape closes it rather than the
 * centre under it, and the centre's own keys stand down (they only answer
 * while the centre is topmost). Portalled to `<body>` so the popover's
 * scrolling list cannot clip it.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { isTopmostOverlay } from "../../lib/focus.ts";
import { Dialog } from "../Dialog.tsx";

export interface MenuItem {
  label: ReactNode;
  /** The mono note at the right: a time, a count, a key. */
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  run: () => void;
}

/** A rule between groups. */
export type MenuEntry = MenuItem | "-";

export function InboxMenu({
  anchor,
  title,
  label,
  items,
  onClose,
}: {
  anchor: HTMLElement;
  title?: string;
  /** The accessible name when there is no visible title. */
  label?: string;
  items: readonly MenuEntry[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: -9999, left: -9999 });

  // Right-aligned to the anchor, below it unless there is no room.
  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const el = ref.current;
    const w = el?.offsetWidth ?? 230;
    const h = el?.offsetHeight ?? 0;
    setPos({
      left: Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w)),
      top: r.bottom + h + 8 > window.innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4,
    });
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const el = ref.current;
      if (
        el &&
        isTopmostOverlay(el) &&
        !el.contains(e.target as Node) &&
        !anchor.contains(e.target as Node)
      )
        onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [anchor, onClose]);

  return createPortal(
    <Dialog
      ref={ref}
      className="nt-menu"
      label={title ?? label ?? "Menu"}
      onDismiss={onClose}
      style={pos}
    >
      {title ? <div className="nt-menu-head">{title}</div> : null}
      {items.map((it, i) =>
        it === "-" ? (
          <hr key={`rule-${i}`} />
        ) : (
          <button
            type="button"
            key={i}
            className={it.danger ? "danger" : undefined}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.run();
            }}
          >
            {it.label}
            {it.hint ? <span className="h">{it.hint}</span> : null}
          </button>
        ),
      )}
    </Dialog>,
    document.body,
  );
}
