/**
 * The return toast (issue #18): "Terminal · while you were away".
 *
 * A macOS banner brings the app forward when it is clicked, but Electrobun
 * does not say *which* banner it was, so the page cannot follow the click.
 * Instead, when the window comes back with terminal rows that interrupted
 * while it was hidden, this pinned toast offers the newest of them with its
 * `Open session ⏎` button already focused: the operator who clicked a banner
 * presses Enter and lands where the banner pointed. Esc dismisses it, and the
 * rows stay in the inbox either way.
 *
 * Pinned means no life bar and no timer: an operator who has just come back
 * from another app is the one person who has not read it yet.
 */
import { useEffect, useRef } from "react";
import type { KeyboardEvent } from "react";
import { useNotify } from "../../state/notify-state.tsx";
import { actionHash, classColor, classGlyph, rowTone } from "../../logic/notification-logic.ts";
import type { NotificationClassName } from "../../logic/notification-logic.ts";
import { agentHash } from "../../nav/agent-nav.ts";
import type { NotificationView } from "../../api/index.ts";

/** Where `Open session` goes: the row's terminal action, else its agent and session. */
function sessionHash(n: NotificationView): string | null {
  const action = n.actions.find((a) => a.target === "terminal");
  const hash = action ? actionHash(action) : null;
  if (hash) return hash;
  return n.agent ? agentHash(n.agent, "terminal", n.ref ?? null) : null;
}

export function ReturnToast() {
  const notify = useNotify();
  const { returnToast, dismissReturnToast, ackMany } = notify;
  const open = useRef<HTMLButtonElement | null>(null);
  const newestId = returnToast?.newest.id ?? null;

  // Focused on every new pick, so Enter is the whole gesture.
  useEffect(() => {
    if (newestId !== null) open.current?.focus();
  }, [newestId]);

  if (returnToast === null) return null;
  const { newest, also, more } = returnToast;
  const cls = newest.class as NotificationClassName;
  const hash = sessionHash(newest);

  const go = () => {
    dismissReturnToast();
    if (!newest.read_at) void ackMany([newest.id]);
    if (hash) window.location.hash = hash;
  };
  // Esc is this toast's while it has focus; the shell's own Esc (close a
  // drawer, leave a view) must not fire behind it.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    dismissReturnToast();
  };

  return (
    <div
      className={`nt-rtoast ${rowTone(cls)}`}
      role="alertdialog"
      aria-label="Terminal · while you were away"
      data-kind={newest.kind}
      onKeyDown={onKeyDown}
    >
      <div className="nt-icon" style={{ borderColor: classColor(cls), color: classColor(cls) }}>
        {classGlyph(cls)}
      </div>
      <div className="nt-main">
        <div className="nt-rtoast-k">Terminal · while you were away</div>
        <div className="nt-title">{newest.title}</div>
        {also ? (
          <div className="nt-sub">
            also: {also.title}
            {more > 0 ? ` · +${more} more` : ""}
          </div>
        ) : null}
      </div>
      <div className="nt-rtoast-acts">
        <button
          type="button"
          className="btn btn-primary btn-mini"
          ref={open}
          disabled={hash === null}
          onClick={go}
        >
          Open session ⏎
        </button>
        <button
          type="button"
          className="nt-toast-x"
          aria-label="Dismiss: while you were away"
          title="Dismiss (Esc) · the rows stay in the inbox"
          onClick={dismissReturnToast}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
