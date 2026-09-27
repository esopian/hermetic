/**
 * The one dialog surface. Every overlay that claims `role="dialog"` — drawer,
 * popover, receipt, Bot Mode form, quick jump — renders through here, so the
 * focus contract in `focus.ts` is owed once rather than reimplemented per
 * component:
 *
 *   - `role="dialog"` with an accessible name (`label` or `labelledBy`);
 *   - `aria-modal="true"` and a scroll lock only when `modal` — a popover has
 *     no backdrop and closes on an outside click, so it must not promise that
 *     the rest of the page is unreachable;
 *   - focus moves inside on open (`[data-autofocus]`, else the first focusable,
 *     else the root, which is why the root is `tabIndex={-1}`), Tab wraps, and
 *     focus returns to the opener on close;
 *   - Escape reaches the topmost dialog only, through the shared stack;
 *   - an optional backdrop wrapper whose own click (never a click inside the
 *     dialog) dismisses.
 *
 * Chrome is the caller's: `className`, `style`, the element type and the
 * children are passed through untouched, so each surface keeps the class names
 * and nesting its CSS and tests address.
 */
import { useRef } from "react";
import type { CSSProperties, MouseEvent, ReactNode, RefObject } from "react";
import { useFocusTrap } from "../lib/focus.ts";

export function Dialog({
  ref,
  as: Tag = "div",
  className,
  style,
  label,
  labelledBy,
  modal = false,
  onDismiss,
  backdrop,
  children,
}: {
  /** The caller's own ref, when it needs the root for measuring or hit-testing. */
  ref?: RefObject<HTMLDivElement | null>;
  as?: "div" | "section";
  className?: string;
  style?: CSSProperties;
  label?: string;
  labelledBy?: string;
  /** `aria-modal` plus the body scroll lock. */
  modal?: boolean;
  /** Escape. Leave undefined to swallow Escape without closing (a form mid-submit). */
  onDismiss?: () => void;
  /**
   * A wrapper around the dialog. `onClose` fires on a click that lands on the
   * wrapper itself, not on anything inside the dialog.
   */
  backdrop?: { className: string; onClose?: () => void };
  children: ReactNode;
}) {
  const own = useRef<HTMLDivElement>(null);
  const root = ref ?? own;
  useFocusTrap(root, true, onDismiss, modal);
  const dialog = (
    <Tag
      ref={root}
      className={className}
      role="dialog"
      aria-modal={modal ? "true" : undefined}
      aria-label={label}
      aria-labelledby={labelledBy}
      tabIndex={-1}
      style={style}
    >
      {children}
    </Tag>
  );
  if (!backdrop) return dialog;
  const onClick = backdrop.onClose
    ? (e: MouseEvent<HTMLDivElement>) => {
        if (e.target === e.currentTarget) backdrop.onClose?.();
      }
    : undefined;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop is decoration; Escape reaches the dialog through the shared focus stack.
    <div className={backdrop.className} role="presentation" onClick={onClick}>
      {dialog}
    </div>
  );
}
