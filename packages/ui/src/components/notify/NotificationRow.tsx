/**
 * One row of the inbox, drawn the same in the centre's popover and in the full
 * inbox under Settings — there is one kind of notification, so there is one row
 * for it.
 *
 * Two channels, never mixed (the gold-outranks-orange rule): the *left rule*
 * is priority (gold needs-you, red failed, green done) and the *tint* is
 * unread. That is why the tone class and `data-unread` are separate
 * attributes rather than one state — "I have not read this" and "this is
 * blocked on me" are different facts and an operator has to be able to see
 * both at once.
 *
 * A third, quieter channel sits under those two: a row whose condition has
 * since cleared (`resolved_at`) is drawn as history — neutral rule, dimmed, and
 * a note saying when. It is a *removal* of emphasis, so it cannot be confused
 * with either of the other two.
 */
import type { NotificationActionView, NotificationView } from "../../api/index.ts";
import {
  actionHash,
  classColor,
  classGlyph,
  isResolved,
  inboxTime,
  resolvedLabel,
  rowTone,
  sourceLine,
} from "../../logic/notification-logic.ts";
import type { NotificationClassName } from "../../logic/notification-logic.ts";

export interface NotificationRowProps {
  n: NotificationView;
  /**
   * How many rows this one stands for, when the surface drawing it coalesced a
   * run of them (`groupNotifications`). `1`, or absent, is an ordinary row.
   */
  count?: number;
  /** Read once per render of the list, so every row in it agrees on the clock. */
  now?: number;
  /** Marks the row read. Called by a plain click and by every action button. */
  onAck?: (id: string) => void;
  /**
   * Opens the agent drawer. An action with `target: "agent"` has no hash to go
   * to — the drawer is `App.tsx` state — so it is routed by callback instead
   * (`actionHash` returns `null` for exactly that case).
   */
  onOpenAgent?: (name: string) => void;
  /** Navigates the hash. Defaults to writing `window.location.hash`. */
  onNavigate?: (hash: string) => void;
  /** Closes the surface the row is in, after an action has been taken. */
  onNavigated?: () => void;
}

export function NotificationRow({
  n,
  count = 1,
  now = Date.now(),
  onAck,
  onOpenAgent,
  onNavigate,
  onNavigated,
}: NotificationRowProps) {
  const cls = n.class as NotificationClassName;
  const unread = !n.read_at;
  /**
   * A third channel, under the other two: the condition this row reported has
   * since cleared. It is drawn by *removing* emphasis rather than by adding a
   * colour — the priority rule goes neutral, the row dims, and a note says when
   * — because a cleared condition is history and history should not compete
   * with the live rows around it for the eye.
   *
   * It is not the same as read: `resolved_at` is the world's fact and `read_at`
   * is the operator's, so the unread tint and the unread dot below stay exactly
   * as they were. A cleared row nobody has looked at still says so.
   */
  const resolved = isResolved(n);
  const tone = resolved ? "var(--line2)" : classColor(cls);

  const runAction = (action: NotificationActionView) => {
    onAck?.(n.id);
    if (action.target === "agent") {
      const name = action.ref ?? n.agent;
      if (name) {
        onOpenAgent?.(name);
        onNavigated?.();
      }
      return;
    }
    const hash = actionHash(action);
    if (!hash) return;
    if (onNavigate) onNavigate(hash);
    else window.location.hash = hash;
    onNavigated?.();
  };

  return (
    <div
      className={`nt-item ${rowTone(cls)}${resolved ? " resolved" : ""}`}
      data-unread={unread ? "true" : "false"}
      data-resolved={resolved ? "true" : "false"}
      data-kind={n.kind}
      data-count={count > 1 ? String(count) : undefined}
    >
      <div className="nt-icon" style={{ borderColor: tone, color: tone }}>
        {classGlyph(cls)}
      </div>
      <div className="nt-main">
        {/*
          The body of the row is one real button rather than a click handler on
          the container. Acknowledging is the row's primary action, so it has to
          be reachable by keyboard — and a `div` with an `onClick` is not, while
          a `role="button"` wrapping the action buttons below would nest one
          control inside another. The button covers the title, the detail and
          the source line; the action buttons sit outside it, as siblings.
        */}
        <button
          type="button"
          className="nt-hit"
          aria-label={unread ? `Mark read: ${n.title}` : n.title}
          onClick={() => onAck?.(n.id)}
        >
          <span className="nt-title">{n.title}</span>
          {n.detail ? <span className="nt-sub">{n.detail}</span> : null}
          <span className="nt-src">
            <i className="dot" style={{ background: tone }} />
            {sourceLine(n)}
            {resolved && n.resolved_at ? (
              <span className="nt-cleared">{resolvedLabel(n.resolved_at, now)}</span>
            ) : null}
          </span>
        </button>
        {n.actions.length > 0 ? (
          <div className="nt-actions">
            {n.actions.map((action) => (
              <button
                type="button"
                className="btn-mini"
                key={`${action.target}:${action.ref ?? ""}:${action.label}`}
                onClick={() => runAction(action)}
              >
                {action.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="nt-right">
        {count > 1 ? (
          // The count reuses the tab pill rather than inventing a badge: it is
          // the same thing — how many rows are behind this label.
          <span className="nt-tab-n" title={`${count} notifications`}>
            {count}
          </span>
        ) : null}
        <span className="ch-time mono">{inboxTime(n.at, now)}</span>
        {n.muted ? (
          <span className="nt-muted-icon" title="muted">
            ⊘
          </span>
        ) : null}
        {unread ? (
          <span className="nt-unread-dot" aria-hidden="true">
            ●
          </span>
        ) : null}
      </div>
    </div>
  );
}
