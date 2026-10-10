/**
 * The toast stack, bottom right.
 *
 * A toast is for an *event* — something that happened and is over. A condition
 * that persists gets a band or a pill instead (the events-toast rule), because
 * a toast that leaves takes the condition off screen with it; that rule is
 * enforced in `notification-logic.ts`, and this file only draws what it was
 * handed.
 *
 * Two kinds here. A dismissable one carries the life bar; a sticky one
 * (needs-you, or a failure) has no bar, because it is not going anywhere.
 *
 * A burst does not bury the page: at most three are drawn, newest first, with
 * the rest behind `+N more · show all`, and a stack of more than one gets a
 * head with `✓ Mark read` (reads every toasted row and dismisses the stack) and
 * `Dismiss all` (dismisses only — the rows stay unread in the inbox). Hovering
 * the stack pauses every life bar *and* its timer, so a toast never leaves
 * while it is being read. `✕` dismisses the toast, never the row.
 */
import { useEffect, useRef, useState } from "react";
import type { Toast } from "../../state/notify-state.tsx";
import { useNotify } from "../../state/notify-state.tsx";
import {
  TOAST_VISIBLE_MAX,
  actionHash,
  classColor,
  classGlyph,
  rowTone,
} from "../../logic/notification-logic.ts";
import type { NotificationClassName } from "../../logic/notification-logic.ts";

function ToastCard({
  toast,
  paused,
  onDismiss,
  onRead,
  onOpenAgent,
}: {
  toast: Toast;
  paused: boolean;
  onDismiss: (key: string) => void;
  onRead: (toast: Toast) => void;
  onOpenAgent?: (name: string) => void;
}) {
  const n = toast.notification;
  const cls = n.class as NotificationClassName;
  /** What is left of the dwell, carried across pauses. */
  const remaining = useRef(toast.dwellMs);

  useEffect(() => {
    if (remaining.current === null || paused) return;
    const started = Date.now();
    const t = setTimeout(() => onDismiss(toast.key), remaining.current);
    return () => {
      clearTimeout(t);
      if (remaining.current !== null)
        remaining.current = Math.max(0, remaining.current - (Date.now() - started));
    };
  }, [toast.key, paused, onDismiss]);

  return (
    <div className={`nt-toast ${rowTone(cls)}`} role="status" data-kind={n.kind}>
      <div className="nt-icon" style={{ borderColor: classColor(cls), color: classColor(cls) }}>
        {classGlyph(cls)}
      </div>
      <div className="nt-main">
        <div className="nt-title">{n.title}</div>
        {n.detail ? <div className="nt-sub">{n.detail}</div> : null}
        <div className="nt-actions">
          {n.actions.map((action) => (
            <button
              type="button"
              className="btn-mini"
              key={`${action.target}:${action.ref ?? ""}:${action.label}`}
              onClick={() => {
                onRead(toast);
                if (action.target === "agent") {
                  const name = action.ref ?? n.agent;
                  if (name) onOpenAgent?.(name);
                  return;
                }
                const hash = actionHash(action);
                if (hash) window.location.hash = hash;
              }}
            >
              {action.label}
            </button>
          ))}
          <button type="button" className="nt-lk" onClick={() => onRead(toast)}>
            mark read
          </button>
        </div>
      </div>
      <button
        type="button"
        className="nt-toast-x"
        aria-label={`Dismiss: ${n.title}`}
        title="Dismiss (stays unread in the inbox)"
        onClick={() => onDismiss(toast.key)}
      >
        ✕
      </button>
      {toast.dwellMs === null ? null : (
        <div className="nt-toast-life">
          <i style={{ animationDuration: `${toast.dwellMs}ms`, background: classColor(cls) }} />
        </div>
      )}
    </div>
  );
}

export function Toasts({ onOpenAgent }: { onOpenAgent?: (name: string) => void }) {
  const notify = useNotify();
  const [expanded, setExpanded] = useState(false);
  const [paused, setPaused] = useState(false);
  const { toasts, dismissToast, ackMany } = notify;
  useEffect(() => {
    if (toasts.length <= TOAST_VISIBLE_MAX) setExpanded(false);
    if (toasts.length === 0) setPaused(false);
  }, [toasts.length]);
  if (toasts.length === 0) return null;

  // Newest first: the stack is read top-down, and the newest is the news.
  const ordered = [...toasts].reverse();
  const shown = expanded ? ordered : ordered.slice(0, TOAST_VISIBLE_MAX);
  const more = ordered.length - shown.length;
  const readToast = (t: Toast) => {
    dismissToast(t.key);
    if (!t.notification.read_at) void ackMany([t.notification.id]);
  };
  const dismissAll = () => {
    for (const t of toasts) dismissToast(t.key);
  };
  const readAll = () => {
    const ids = [
      ...new Set(toasts.filter((t) => !t.notification.read_at).map((t) => t.notification.id)),
    ];
    dismissAll();
    if (ids.length) void ackMany(ids);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover only pauses the life bars; nothing is activated by it.
    <div
      className="nt-toasts"
      aria-live="polite"
      data-paused={paused ? "true" : "false"}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {toasts.length > 1 ? (
        <div className="nt-tstack-head">
          <span className="t">
            <b>{toasts.length}</b> new
          </span>
          <button type="button" className="nt-hbtn" onClick={readAll}>
            ✓ Mark read
          </button>
          <button type="button" className="nt-hbtn" onClick={dismissAll}>
            Dismiss all
          </button>
        </div>
      ) : null}
      {shown.map((t) => (
        <ToastCard
          key={t.key}
          toast={t}
          paused={paused}
          onDismiss={dismissToast}
          onRead={readToast}
          onOpenAgent={onOpenAgent}
        />
      ))}
      {more > 0 ? (
        <button type="button" className="nt-tmore" onClick={() => setExpanded(true)}>
          +{more} more · show all
        </button>
      ) : expanded && toasts.length > TOAST_VISIBLE_MAX ? (
        <button type="button" className="nt-tmore" onClick={() => setExpanded(false)}>
          collapse
        </button>
      ) : null}
    </div>
  );
}
