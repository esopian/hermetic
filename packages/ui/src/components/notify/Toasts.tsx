/**
 * The toast stack, bottom right.
 *
 * A toast is for an *event* — something that happened and is over. A condition
 * that persists gets a band or a pill instead (the events-toast rule), because
 * a toast that leaves takes the condition off screen with it; that rule is
 * enforced in `notification-logic.ts`, and this file only draws what it was
 * handed.
 *
 * Two kinds here. A dismissable one carries the life bar, which is a CSS
 * animation rather than a React interval: the bar and the timer are then the
 * same clock, so a toast never vanishes with its bar half full. A sticky one
 * (needs-you, or a failure) has no bar, because it is not going anywhere.
 */
import { useEffect } from "react";
import type { Toast } from "../../state/notify-state.tsx";
import { useNotify } from "../../state/notify-state.tsx";
import { actionHash, classColor, classGlyph, rowTone } from "../../logic/notification-logic.ts";
import type { NotificationClassName } from "../../logic/notification-logic.ts";

function ToastCard({
  toast,
  onDismiss,
  onOpenAgent,
}: {
  toast: Toast;
  onDismiss: (key: string) => void;
  onOpenAgent?: (name: string) => void;
}) {
  const n = toast.notification;
  const cls = n.class as NotificationClassName;

  useEffect(() => {
    if (toast.dwellMs === null) return;
    const t = setTimeout(() => onDismiss(toast.key), toast.dwellMs);
    return () => clearTimeout(t);
  }, [toast.key, toast.dwellMs, onDismiss]);

  return (
    <div className={`nt-toast ${rowTone(cls)}`} role="status" data-kind={n.kind}>
      <div className="nt-icon" style={{ borderColor: classColor(cls), color: classColor(cls) }}>
        {classGlyph(cls)}
      </div>
      <div className="nt-main">
        <div className="nt-title">{n.title}</div>
        {n.detail ? <div className="nt-sub">{n.detail}</div> : null}
        {n.actions.length > 0 ? (
          <div className="nt-actions">
            {n.actions.map((action) => (
              <button
                type="button"
                className="btn-mini"
                key={`${action.target}:${action.ref ?? ""}:${action.label}`}
                onClick={() => {
                  onDismiss(toast.key);
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
          </div>
        ) : null}
      </div>
      <button
        type="button"
        className="nt-toast-x"
        aria-label={`Dismiss: ${n.title}`}
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
  if (notify.toasts.length === 0) return null;
  return (
    <div className="nt-toasts" aria-live="polite">
      {notify.toasts.map((t) => (
        <ToastCard key={t.key} toast={t} onDismiss={notify.dismissToast} onOpenAgent={onOpenAgent} />
      ))}
    </div>
  );
}
