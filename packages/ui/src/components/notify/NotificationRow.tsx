/**
 * One card of the inbox, drawn the same in the centre's popover and in the full
 * inbox drawer — there is one kind of notification, so there is one row for it.
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
 *
 * Clicking the body *does* the row: it opens the first action and marks the
 * card read (a row with no action just marks read). The verbs that are not
 * reading — snooze, mute, clear, and reading's own undo, unread — sit in a
 * hover strip at the right, shown on hover and on keyboard focus, and the
 * unread square is a toggle. Every verb is optional: a surface that passes no
 * handlers gets the read-only row.
 */
import { useState } from "react";
import type { MouseEvent } from "react";
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
import {
  clockTime,
  isCleared,
  isOpenCondition,
  isSnoozed,
  snoozeLabel,
} from "../../logic/inbox-logic.ts";
import type { CardKind } from "../../logic/inbox-logic.ts";

export interface ActionRouting {
  /** Marks the card read. Called by a body click and by every action button. */
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

/** Runs one action button: marks read, then goes where it points. */
export function runNotificationAction(
  n: NotificationView,
  action: NotificationActionView,
  routing: ActionRouting,
): void {
  routing.onAck?.(n.id);
  if (action.target === "agent") {
    const name = action.ref ?? n.agent;
    if (name) {
      routing.onOpenAgent?.(name);
      routing.onNavigated?.();
    }
    return;
  }
  const hash = actionHash(action);
  if (!hash) return;
  if (routing.onNavigate) routing.onNavigate(hash);
  else window.location.hash = hash;
  routing.onNavigated?.();
}

/** What a body click (and `↵`) does: the first action, or just reading. */
export function openNotification(n: NotificationView, routing: ActionRouting): void {
  const first = n.actions[0];
  if (first) runNotificationAction(n, first, routing);
  else routing.onAck?.(n.id);
}

export interface NotificationRowProps extends ActionRouting {
  n: NotificationView;
  /**
   * How many rows this one stands for, when the surface drawing it coalesced a
   * run of them. `1`, or absent, is an ordinary row.
   */
  count?: number;
  /** The rows behind a coalesced card, newest first, for its expandable list. */
  kids?: readonly NotificationView[];
  kind?: CardKind;
  /** Read once per render of the list, so every row in it agrees on the clock. */
  now?: number;
  /** Keyboard focus (`j`/`k`): drawn as an outline, and shows the strip. */
  focused?: boolean;
  /** Defined in the drawer, where every card has a select box. */
  checked?: boolean;
  onCheck?: (range: boolean) => void;
  /** Gets the body click first; `true` means it was a selection gesture, not an open. */
  onBodyClick?: (e: MouseEvent) => boolean;
  onToggleRead?: () => void;
  onClear?: () => void;
  onSnooze?: (anchor: HTMLElement) => void;
  onMute?: (anchor: HTMLElement) => void;
  onRestore?: () => void;
  onUnsnooze?: () => void;
  /** The card's key, so a key handler can find its strip to anchor a menu. */
  cardKey?: string;
}

/** `granite create finished` → `granite create`, for the run's one-line summary. */
function shortTitle(title: string): string {
  return title.replace(/\s+finished$/, "");
}

export function NotificationRow({
  n,
  count = 1,
  kids,
  kind = "single",
  now = Date.now(),
  focused = false,
  checked,
  onCheck,
  onBodyClick,
  onToggleRead,
  onClear,
  onSnooze,
  onMute,
  onRestore,
  onUnsnooze,
  cardKey,
  ...routing
}: NotificationRowProps) {
  const [expanded, setExpanded] = useState(false);
  const cls = n.class as NotificationClassName;
  const unread = !n.read_at;
  /**
   * The condition this row reported has since cleared. It is drawn by
   * *removing* emphasis rather than by adding a colour, and it is not the same
   * as read: `resolved_at` is the world's fact and `read_at` is the
   * operator's, so the unread tint stays exactly as it was.
   */
  const resolved = isResolved(n);
  const cleared = isCleared(n);
  const snoozed = isSnoozed(n, now);
  const open = isOpenCondition(n) && !cleared;
  const tone = resolved ? "var(--line2)" : classColor(cls);
  const title = kind === "operations" ? `${count} operations finished` : n.title;
  const detail =
    kind === "operations" && kids ? kids.map((k) => shortTitle(k.title)).join(" · ") : n.detail;
  const select = checked !== undefined;

  const bodyLabel = n.actions.length > 0 ? `Open: ${title}` : unread ? `Mark read: ${title}` : title;

  return (
    <div
      className={`nt-item ${rowTone(cls)}${resolved ? " resolved" : ""}${n.muted ? " muted" : ""}${select ? " sel-col" : ""}`}
      data-unread={unread ? "true" : "false"}
      data-resolved={resolved ? "true" : "false"}
      data-focus={focused ? "true" : "false"}
      data-checked={checked ? "true" : "false"}
      data-kind={n.kind}
      data-card={cardKey}
      data-count={count > 1 ? String(count) : undefined}
    >
      {select ? (
        <div className="nt-ck-cell">
          <button
            type="button"
            className={`nt-ck${checked ? " on" : ""}`}
            role="checkbox"
            aria-checked={checked}
            aria-label={`Select: ${title}`}
            onClick={(e) => onCheck?.(e.shiftKey)}
          >
            {checked ? "✓" : ""}
          </button>
        </div>
      ) : null}
      <div className="nt-icon" style={{ borderColor: tone, color: tone }}>
        {classGlyph(cls)}
      </div>
      <div className="nt-main">
        {/*
          The body of the row is one real button rather than a click handler on
          the container, so the row's primary action is reachable by keyboard
          without nesting one control inside another. The action buttons sit
          outside it, as siblings.
        */}
        <button
          type="button"
          className="nt-hit"
          aria-label={bodyLabel}
          onClick={(e) => {
            if (onBodyClick?.(e)) return;
            openNotification(n, routing);
          }}
        >
          <span className="nt-title">{title}</span>
          {detail ? <span className="nt-sub">{detail}</span> : null}
          <span className="nt-src">
            <i className="dot" style={{ background: tone }} />
            {sourceLine(n)}
            {open ? <span className="tag open">open</span> : null}
            {resolved && n.resolved_at ? (
              <span className="nt-cleared">{resolvedLabel(n.resolved_at, now)}</span>
            ) : null}
            {snoozed && n.snoozed_until ? (
              <span className="nt-snz">◷ until {snoozeLabel(n.snoozed_until, now)}</span>
            ) : null}
            {cleared ? <span className="tag">in history</span> : null}
          </span>
        </button>
        {kids && kids.length > 1 ? (
          <>
            <button
              type="button"
              className="nt-expand"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "▾ hide" : "▸ show"} {kids.length}
            </button>
            {expanded ? (
              <div className="nt-kids">
                {kids.map((k) => (
                  <span key={k.id}>
                    {clockTime(k.at)} · <b>{k.title}</b>
                  </span>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
        {n.actions.length > 0 ? (
          <div className="nt-actions">
            {n.actions.map((action, i) => (
              <button
                type="button"
                className={`btn-mini${i === 0 && cls === "needs_action" && !resolved ? " pri" : ""}`}
                key={`${action.target}:${action.ref ?? ""}:${action.label}`}
                onClick={() => runNotificationAction(n, action, routing)}
              >
                {action.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      <div className="nt-right">
        {count > 1 ? (
          <span className="nt-count" title={`${count} notifications`}>
            {count}
          </span>
        ) : null}
        <span className="ch-time mono">{inboxTime(n.at, now)}</span>
        {n.muted ? (
          <span className="nt-muted-icon" title="muted">
            ⊘
          </span>
        ) : null}
        {onToggleRead && !cleared && !snoozed ? (
          <button
            type="button"
            className={`nt-dotbtn${unread ? "" : " read"}`}
            aria-label={`Toggle read: ${title}`}
            aria-pressed={!unread}
            title={unread ? "Mark read" : "Mark unread"}
            onClick={onToggleRead}
          >
            <i />
          </button>
        ) : unread ? (
          <span className="nt-unread-dot" aria-hidden="true">
            ●
          </span>
        ) : null}
      </div>
      <HoverStrip
        cleared={cleared}
        snoozed={snoozed}
        unread={unread}
        open={open}
        onToggleRead={onToggleRead}
        onClear={onClear}
        onSnooze={onSnooze}
        onMute={onMute}
        onRestore={onRestore}
        onUnsnooze={onUnsnooze}
      />
    </div>
  );
}

function HoverStrip({
  cleared,
  snoozed,
  unread,
  open,
  onToggleRead,
  onClear,
  onSnooze,
  onMute,
  onRestore,
  onUnsnooze,
}: {
  cleared: boolean;
  snoozed: boolean;
  unread: boolean;
  open: boolean;
} & Pick<
  NotificationRowProps,
  "onToggleRead" | "onClear" | "onSnooze" | "onMute" | "onRestore" | "onUnsnooze"
>) {
  const buttons = cleared
    ? [
        onRestore
          ? { id: "restore", glyph: "↺", tip: "Move back to inbox", run: () => onRestore() }
          : null,
      ]
    : snoozed
      ? [
          onUnsnooze ? { id: "unsnooze", glyph: "◷", tip: "Unsnooze", run: () => onUnsnooze() } : null,
          onClear ? { id: "clear", glyph: "✕", tip: "Clear  e", run: () => onClear() } : null,
        ]
      : [
          onToggleRead
            ? {
                id: "read",
                glyph: unread ? "✓" : "●",
                tip: unread ? "Mark read  r" : "Mark unread  r",
                run: () => onToggleRead(),
              }
            : null,
          onSnooze
            ? { id: "snooze", glyph: "◷", tip: "Snooze  s", run: (el: HTMLElement) => onSnooze(el) }
            : null,
          onMute
            ? { id: "mute", glyph: "⊘", tip: "Mute  m", run: (el: HTMLElement) => onMute(el) }
            : null,
          onClear
            ? {
                id: "clear",
                glyph: "✕",
                tip: open ? "Clear · hides until it changes  e" : "Clear  e",
                run: () => onClear(),
              }
            : null,
        ];
  const shown = buttons.filter((b): b is NonNullable<typeof b> => b !== null);
  if (shown.length === 0) return null;
  return (
    <div className="nt-hover">
      {shown.map((b) => (
        <button
          type="button"
          key={b.id}
          className={b.id === "clear" ? "x" : undefined}
          data-strip={b.id}
          data-tip={b.tip}
          aria-label={b.tip.replace(/\s{2}\S+$/, "")}
          onClick={(e) => b.run(e.currentTarget)}
        >
          {b.glyph}
        </button>
      ))}
    </div>
  );
}
