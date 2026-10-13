/**
 * Right-hand slide-over. The backdrop closes; the shared focus stack owns Esc
 * so the topmost overlay wins. Focus is trapped in `Dialog` rather than in
 * each drawer: `aria-modal="true"` is a promise about the whole page, and
 * every drawer in the app comes through this one component.
 */
import type { ReactNode } from "react";
import { Dialog } from "./Dialog.tsx";

export function Drawer({
  width,
  className,
  onClose,
  onEscape = onClose,
  labelledBy,
  children,
}: {
  /**
   * Pixels, as an inline style. `null` leaves the width to a stylesheet rule on
   * `className` — the agent drawer's maximized width is a `max()`/`calc()`.
   */
  width: number | null;
  /** Added to `drawer`. */
  className?: string;
  onClose: () => void;
  onEscape?: () => void;
  labelledBy?: string;
  children: ReactNode;
}) {
  return (
    <Dialog
      className={className ? `drawer ${className}` : "drawer"}
      modal
      labelledBy={labelledBy}
      onDismiss={onEscape}
      backdrop={{ className: "backdrop", onClose }}
      style={width === null ? undefined : { width }}
    >
      {children}
    </Dialog>
  );
}

export function DrawerHead({
  kicker,
  title,
  sub,
  titleId,
  onClose,
}: {
  kicker: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  titleId?: string;
  onClose: () => void;
}) {
  return (
    <div className="drawer-head">
      <div style={{ minWidth: 0 }}>
        <div className="kicker">{kicker}</div>
        <div className="drawer-title" id={titleId}>
          {title}
        </div>
        {sub}
      </div>
      <button type="button" className="btn btn-box" onClick={onClose} aria-label="Close">
        ×
      </button>
    </div>
  );
}
