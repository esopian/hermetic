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
  onClose,
  onEscape = onClose,
  labelledBy,
  children,
}: {
  width: number;
  onClose: () => void;
  onEscape?: () => void;
  labelledBy?: string;
  children: ReactNode;
}) {
  return (
    <Dialog
      className="drawer"
      modal
      labelledBy={labelledBy}
      onDismiss={onEscape}
      backdrop={{ className: "backdrop", onClose }}
      style={{ width }}
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
