/**
 * The notification centre: a 500px popover under the header bell.
 *
 * A *triage* surface over the inbox, not the archive. Three tabs — `Needs
 * you | Unread | All` — over the inbox view (cleared and snoozed rows have
 * left it), `Waiting on you` pinned above the time sections, and every bulk
 * verb scoped to the tab on screen and counted on its button ("Mark 6 read",
 * "Clear 4 read"), so a press never reaches a row the operator cannot see.
 * Every verb leaves the 6-second undo bar. The archive — History, Snoozed,
 * sources, agents, multi-select — is the drawer behind `Full inbox →`.
 */
import { useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { NotificationView } from "../../api/index.ts";
import {
  CENTER_TABS,
  buildSections,
  centerTabCounts,
  markReadRows,
  drawerViewForTab,
  filterCenter,
  flatCards,
  focusAfterRemoval,
  inInbox,
  isUnread,
  moveFocus,
} from "../../logic/inbox-logic.ts";
import type { CenterTab, InboxCard, InboxKeyAction } from "../../logic/inbox-logic.ts";
import { groupRow, isResolved } from "../../logic/notification-logic.ts";
import { settingsHash } from "../../nav/settings-nav.ts";
import { INBOX_PAGE, useNotify } from "../../state/notify-state.tsx";
import { Popover } from "../Popover.tsx";
import {
  InboxSections,
  InboxZero,
  UndoBarView,
  cardElement,
  openRulesVia,
  useInboxKeys,
  useInboxMenus,
} from "./InboxParts.tsx";
import { openNotification } from "./NotificationRow.tsx";

export function NotificationCenter({
  anchor,
  onClose,
  onOpenAgent,
  onOpenSettings,
}: {
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  onOpenAgent?: (name: string) => void;
  /** Opens the Settings view on a named section, without a hash round trip. */
  onOpenSettings?: (section: "notifications") => void;
}) {
  const notify = useNotify();
  const [tab, setTab] = useState<CenterTab>("all");
  const [focus, setFocus] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const now = Date.now();

  const counts = centerTabCounts(notify.items, now, { unread: notify.unread });
  const rows = useMemo(() => filterCenter(notify.items, tab, now), [notify.items, tab, now]);
  const sections = useMemo(
    () => buildSections(rows, now, { pinWaiting: tab !== "needs_you", allPin: tab === "needs_you" }),
    [rows, tab, now],
  );
  const cards = flatCards(sections);
  const keys = cards.map((c) => c.key);
  const current = focus !== null && keys.includes(focus) ? focus : null;
  const unreadRows = markReadRows(rows);
  const readRows = rows.filter((n) => !isUnread(n));
  const resolvedRows = notify.items.filter((n) => inInbox(n, now) && isResolved(n));

  const openRules = openRulesVia(onOpenSettings, onClose, settingsHash("notifications"));
  const menus = useInboxMenus({ onOpenRules: openRules });

  const routing = (card: InboxCard<NotificationView>) => ({
    onOpenAgent,
    onNavigated: onClose,
    // A card stands for every row in its run, so opening it reads all of them.
    onAck: (id: string) =>
      void (card.count === 1 ? notify.ack(id) : notify.ackMany(card.rows.map((r) => r.id))),
  });
  const clearCard = (card: InboxCard<NotificationView>) => {
    setFocus(focusAfterRemoval(keys, card.key));
    void notify.act({ verb: "clear" }, card.rows);
  };
  const toggleRead = (card: InboxCard<NotificationView>) =>
    void notify.act({ verb: card.rows.some(isUnread) ? "read" : "unread" }, card.rows);
  const stripAnchor = (card: InboxCard<NotificationView>, strip: string): HTMLElement | null => {
    const el = cardElement(root.current, card.key);
    return el?.querySelector<HTMLElement>(`[data-strip="${strip}"]`) ?? el ?? null;
  };

  const openMore = (el: HTMLElement) =>
    menus.openMenu({
      anchor: el,
      label: "More",
      items: [
        {
          label: "Clear resolved conditions",
          hint: String(resolvedRows.length),
          disabled: resolvedRows.length === 0,
          run: () => void notify.act({ verb: "clear" }, resolvedRows),
        },
        {
          label: "Clear everything in this view",
          hint: String(rows.length),
          danger: true,
          disabled: rows.length === 0,
          run: () => void notify.act({ verb: "clear" }, rows),
        },
        "-",
        { label: "Snoozed", hint: String(notify.snoozed), run: () => notify.openDrawer("snoozed") },
        { label: "History", hint: String(notify.history), run: () => notify.openDrawer("history") },
        "-",
        { label: "Notification rules…", hint: "Settings", run: openRules },
      ],
    });

  useInboxKeys(root, "center", (action: InboxKeyAction) => {
    const card = cards.find((c) => c.key === current);
    switch (action) {
      case "down":
      case "up":
        setFocus(moveFocus(keys, current, action === "down" ? 1 : -1));
        return true;
      case "open":
        if (!card) return false;
        openNotification(groupRow(card), routing(card));
        return true;
      case "clear":
        if (card) clearCard(card);
        return !!card;
      case "toggle_read":
        if (card) toggleRead(card);
        return !!card;
      case "snooze": {
        const el = card && stripAnchor(card, "snooze");
        if (card && el) menus.openSnooze(el, card.rows);
        return !!card;
      }
      case "mute": {
        const el = card && stripAnchor(card, "mute");
        if (card && el) menus.openMute(el, card.latest);
        return !!card;
      }
      case "undo":
        void notify.undoLast();
        return true;
      case "read_view":
        void notify.act({ verb: "read" }, unreadRows);
        return true;
      case "clear_read_view":
        void notify.act({ verb: "clear" }, readRows);
        return true;
      case "tab_1":
      case "tab_2":
      case "tab_3": {
        const next = CENTER_TABS[Number(action.slice(4)) - 1];
        if (next) setTab(next.id);
        setFocus(null);
        return true;
      }
      case "close":
        onClose();
        return true;
      case "open_drawer":
        notify.openDrawer(drawerViewForTab(tab));
        return true;
      default:
        return false;
    }
  });

  const scope = tab === "all" ? "" : tab === "needs_you" ? " in Needs you" : " in Unread";

  return (
    <Popover
      anchor={anchor}
      onClose={onClose}
      maxWidth={500}
      label="Notifications"
      style={{ zIndex: 210 }}
    >
      <div className="nt-center" ref={root} tabIndex={-1} data-autofocus>
        <div className="popover-head">
          <span className="ph-title">Inbox</span>
          <span className="ph-count">
            {notify.unread} unread
            {notify.needsAction ? (
              <>
                {" · "}
                <b>{notify.needsAction} need you</b>
              </>
            ) : null}
          </span>
          <span className="ph-acts">
            <button
              type="button"
              className="nt-hbtn"
              disabled={unreadRows.length === 0}
              title={`Mark everything${scope} read  ⇧R`}
              onClick={() => void notify.act({ verb: "read" }, unreadRows)}
            >
              ✓ Mark {unreadRows.length || ""} read
            </button>
            <button
              type="button"
              className="nt-hbtn"
              disabled={readRows.length === 0}
              title={`Clear read rows${scope}  ⇧E`}
              onClick={() => void notify.act({ verb: "clear" }, readRows)}
            >
              Clear {readRows.length || ""} read
            </button>
            <button
              type="button"
              className="nt-hbtn icon"
              aria-label="More"
              title="More"
              onClick={(e) => openMore(e.currentTarget)}
            >
              ⋯
            </button>
          </span>
        </div>

        <div className="nt-tabs">
          {CENTER_TABS.map((t) => (
            <button
              type="button"
              key={t.id}
              aria-pressed={tab === t.id}
              onClick={() => {
                setTab(t.id);
                setFocus(null);
              }}
            >
              {t.label}{" "}
              <span
                className={
                  t.id === "needs_you"
                    ? "nt-tab-n warn"
                    : t.id === "unread"
                      ? "nt-tab-n acc"
                      : "nt-tab-n"
                }
              >
                {counts[t.id]}
              </span>
            </button>
          ))}
        </div>

        <div className="nt-list">
          {notify.error ? (
            <div className="nt-empty mono" role="alert">
              Could not read the inbox: {notify.error}
            </div>
          ) : null}
          {cards.length === 0 ? (
            tab === "needs_you" ? (
              <InboxZero big="Nothing waiting on you">
                <div className="sm">No approvals, no stuck updates. Gold rows land here first.</div>
              </InboxZero>
            ) : (
              <InboxZero big="All clear">
                <div className="sm">
                  {tab === "unread" ? "Nothing unread." : "Inbox zero."} {notify.history} in History ·
                  kept 30 days
                  <br />
                  New failures, health changes and advisories land here.
                </div>
                <button type="button" className="lk" onClick={() => notify.openDrawer("history")}>
                  View history →
                </button>
              </InboxZero>
            )
          ) : (
            <InboxSections
              sections={sections}
              now={now}
              focus={current}
              cardProps={(card) => ({
                ...routing(card),
                onToggleRead: () => toggleRead(card),
                onClear: () => clearCard(card),
                onSnooze: (el) => menus.openSnooze(el, card.rows),
                onMute: (el) => menus.openMute(el, card.latest),
              })}
            />
          )}
        </div>

        <div className="popover-foot nt-foot">
          <span className="nt-keys">
            <span>
              <kbd>j</kbd>
              <kbd>k</kbd> move
            </span>
            <span>
              <kbd>↵</kbd> open
            </span>
            <span>
              <kbd>e</kbd> clear
            </span>
            <span>
              <kbd>r</kbd> read
            </span>
            <span>
              <kbd>z</kbd> undo
            </span>
          </span>
          {notify.truncated ? (
            <span className="mono nt-retention">showing latest {INBOX_PAGE}</span>
          ) : null}
          <button
            type="button"
            className="btn-mini"
            onClick={() => notify.openDrawer(drawerViewForTab(tab))}
          >
            Full inbox →
          </button>
        </div>
        <UndoBarView placement="popover" />
        {menus.node}
      </div>
    </Popover>
  );
}
