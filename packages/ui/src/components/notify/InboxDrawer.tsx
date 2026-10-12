/**
 * The full inbox: a right-side drawer over whatever view is open (`⇧I`,
 * `Full inbox →`, Settings' `Open inbox`).
 *
 * The house drawer pattern — backdrop, Esc closes (or first drops a
 * selection), 3px left border — around three columns of the mockup: a rail of
 * views (with the server's counts), sources and agents (each agent with an
 * inline mute toggle); the list, with a filter, select boxes, shift-click
 * ranges and a bulk bar; and a foot carrying core's auto-clear rule, which is
 * shared with the CLI (`notifications.settings`).
 *
 * Snoozed and History are read on demand (`notifications.list({ view })`);
 * the other views are cuts of the inbox the page already holds.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import type { NotificationView } from "../../api/index.ts";
import {
  DRAWER_SOURCES,
  DRAWER_VIEWS,
  buildSections,
  drawerRows,
  filterCenter,
  flatCards,
  focusAfterRemoval,
  isUnread,
  markReadRows,
  moveFocus,
  rangeKeys,
} from "../../logic/inbox-logic.ts";
import type { DrawerFilter, DrawerView, InboxCard, InboxKeyAction } from "../../logic/inbox-logic.ts";
import { groupRow } from "../../logic/notification-logic.ts";
import { settingsHash } from "../../nav/settings-nav.ts";
import { useNotify } from "../../state/notify-state.tsx";
import { Dialog } from "../Dialog.tsx";
import {
  InboxSections,
  InboxZero,
  cardElement,
  openRulesVia,
  useInboxKeys,
  useInboxMenus,
} from "./InboxParts.tsx";
import { openNotification } from "./NotificationRow.tsx";

const AUTO_CLEAR = ["never", "1d", "7d", "30d"] as const;

export function InboxDrawer({
  onOpenAgent,
  onOpenSettings,
}: {
  onOpenAgent?: (name: string) => void;
  onOpenSettings?: (section: "notifications") => void;
}) {
  const notify = useNotify();
  const { drawerView, loadView, loadSettings, closeDrawer } = notify;
  const [filter, setFilter] = useState<DrawerFilter>({
    view: drawerView,
    source: null,
    agent: null,
    q: "",
  });
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const lastChecked = useRef<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const now = Date.now();

  // `openDrawer(view)` while it is already open re-points it.
  useEffect(() => {
    setFilter({ view: drawerView, source: null, agent: null, q: "" });
    setChecked(new Set());
  }, [drawerView]);
  useEffect(() => {
    if (filter.view === "snoozed" || filter.view === "history") void loadView(filter.view);
  }, [filter.view, loadView]);
  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const rows = useMemo(
    () => drawerRows(notify.items, notify.views, filter, now),
    [notify.items, notify.views, filter, now],
  );
  const sections = useMemo(() => buildSections(rows, now, { pinWaiting: false }), [rows, now]);
  const cards = flatCards(sections);
  const keys = cards.map((c) => c.key);
  const current = focus !== null && keys.includes(focus) ? focus : null;
  const selected = cards.filter((c) => checked.has(c.key));
  const selectedRows = selected.flatMap((c) => c.rows);
  // The rows a bulk verb may act on: whatever this view lists, minus History's
  // cleared rows. Snoozed rows count in the Snoozed view, and "Mark N read"
  // leaves resolved rows out so it agrees with the unread count (`markReadRows`).
  const live = rows.filter((n) => !n.cleared_at);
  const unreadLive = markReadRows(live);
  const readLive = live.filter((n) => !isUnread(n));

  const close = closeDrawer;
  const openRules = openRulesVia(onOpenSettings, close, settingsHash("notifications"));
  const menus = useInboxMenus({ onOpenRules: openRules });

  const setView = (view: DrawerView) => {
    setFilter((f) => ({ ...f, view, source: null, agent: null }));
    setChecked(new Set());
  };
  const toggleCheck = (key: string, range: boolean) => {
    // Read the anchor now: the updater below runs later, after it has moved.
    const anchor = lastChecked.current;
    setChecked((prev) => {
      const next = new Set(prev);
      if (range && anchor) for (const k of rangeKeys(keys, anchor, key)) next.add(k);
      else if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    lastChecked.current = key;
    setFocus(key);
  };
  const deselect = () => setChecked(new Set());
  const allChecked = cards.length > 0 && selected.length === cards.length;
  const toggleAll = () => setChecked(allChecked ? new Set() : new Set(keys));

  const routing = (card: InboxCard<NotificationView>) => ({
    onOpenAgent,
    onNavigated: close,
    onAck: (id: string) =>
      void (card.count === 1 ? notify.ack(id) : notify.ackMany(card.rows.map((r) => r.id))),
  });
  const targets = (): NotificationView[] => {
    if (selectedRows.length) return selectedRows;
    return cards.find((c) => c.key === current)?.rows ?? [];
  };
  const verbAndDeselect = (verb: "read" | "unread" | "clear", list: NotificationView[]) => {
    deselect();
    void notify.act({ verb }, list);
  };
  const muteAgents = (list: readonly NotificationView[]) => {
    const agents = [...new Set(list.map((n) => n.agent).filter((a): a is string => !!a))];
    deselect();
    for (const agent of agents) void notify.mute({ agent }, { undoable: true });
  };

  useInboxKeys(root, "drawer", (action: InboxKeyAction) => {
    const card = cards.find((c) => c.key === current);
    const list = targets();
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
        if (!list.length) return false;
        if (!selectedRows.length) setFocus(focusAfterRemoval(keys, current));
        verbAndDeselect("clear", list);
        return true;
      case "toggle_read":
        if (!list.length) return false;
        verbAndDeselect(list.every((n) => !isUnread(n)) ? "unread" : "read", list);
        return true;
      case "snooze": {
        if (!list.length) return false;
        const el = card ? cardElement(root.current, card.key) : root.current;
        if (el) menus.openSnooze(el.querySelector<HTMLElement>('[data-strip="snooze"]') ?? el, list);
        return true;
      }
      case "mute": {
        const el = card && cardElement(root.current, card.key);
        if (card && el)
          menus.openMute(el.querySelector<HTMLElement>('[data-strip="mute"]') ?? el, card.latest);
        return !!card;
      }
      case "undo":
        void notify.undoLast();
        return true;
      case "read_view":
        void notify.act({ verb: "read" }, unreadLive);
        return true;
      case "clear_read_view":
        void notify.act({ verb: "clear" }, readLive);
        return true;
      case "select":
        if (current) toggleCheck(current, false);
        return !!current;
      case "select_all":
        setChecked(new Set(keys));
        return true;
      default:
        return false;
    }
  });

  const viewLabel = DRAWER_VIEWS.find((v) => v.id === filter.view)?.label ?? "Inbox";
  const sourceLabel = DRAWER_SOURCES.find((s) => s.id === filter.source)?.label;
  const viewCount: Record<DrawerView, number> = {
    inbox: filterCenter(notify.items, "all", now).length,
    // What the view lists, as the centre's tab counts it: the server's
    // `needs_action` is unread-only, and the view keeps read demands too.
    needs_you: filterCenter(notify.items, "needs_you", now).length,
    unread: notify.unread,
    snoozed: notify.snoozed,
    history: notify.history,
  };
  const viewTone: Partial<Record<DrawerView, string>> = { needs_you: "warn", unread: "acc" };
  const inboxRows = filterCenter(notify.items, "all", now);
  const muted = new Set(notify.mutes.map((m) => m.target));
  const agents = [
    ...new Set(
      [...notify.items, ...(notify.views.snoozed ?? []), ...(notify.views.history ?? [])]
        .map((n) => n.agent)
        .filter((a): a is string => !!a),
    ),
  ].sort();
  const settings = notify.settings;

  return (
    <Dialog
      className="drawer nt-drawer"
      modal
      label="Inbox"
      onDismiss={() => (checked.size ? deselect() : close())}
      backdrop={{ className: "backdrop", onClose: close }}
    >
      <div className="nt-drawer-root" ref={root}>
        <div className="nt-dr-head">
          <div>
            <div className="kicker">Inbox · this laptop</div>
            <h1>
              {viewLabel}
              {sourceLabel ? ` · ${sourceLabel}` : ""}
              {filter.agent ? ` · ${filter.agent}` : ""}
            </h1>
            <p>
              What happened on the fleet, and what is still waiting on you. Clearing keeps a row in
              History for 30 days.
            </p>
          </div>
          <div className="r">
            <button
              type="button"
              className="nt-btn-s"
              disabled={readLive.length === 0}
              onClick={() => void notify.act({ verb: "clear" }, readLive)}
            >
              Clear read
            </button>
            <button
              type="button"
              className="nt-btn-p"
              disabled={unreadLive.length === 0}
              onClick={() => void notify.act({ verb: "read" }, unreadLive)}
            >
              ✓ Mark {unreadLive.length} read
            </button>
            <button
              type="button"
              className="nt-btn-x"
              aria-label="Close"
              title="Close  esc"
              onClick={close}
            >
              ✕
            </button>
          </div>
        </div>

        <div className="nt-dr-body">
          <nav className="nt-rail" aria-label="Inbox views">
            <span className="kicker">Views</span>
            {DRAWER_VIEWS.map((v) => (
              <button
                type="button"
                key={v.id}
                aria-pressed={filter.view === v.id && !filter.source && !filter.agent}
                onClick={() => setView(v.id)}
              >
                {v.label}
                <span className={`c ${viewTone[v.id] ?? ""}`}>{viewCount[v.id]}</span>
              </button>
            ))}
            <span className="kicker">Sources</span>
            {DRAWER_SOURCES.map((s) => (
              <button
                type="button"
                key={s.id}
                aria-pressed={filter.source === s.id}
                onClick={() => {
                  setFilter((f) => ({ ...f, source: f.source === s.id ? null : s.id, agent: null }));
                  deselect();
                }}
              >
                {s.label}
                <span className="c">{inboxRows.filter((n) => n.source === s.id).length}</span>
                {muted.has(`source:${s.id}`) ? (
                  <span className="mt" title="muted">
                    ⊘
                  </span>
                ) : null}
              </button>
            ))}
            <span className="kicker">Agents</span>
            {agents.map((a) => {
              const isMuted = muted.has(`agent:${a}`);
              const n = inboxRows.filter((r) => r.agent === a).length;
              return (
                <div
                  key={a}
                  className="nt-rail-agent"
                  data-pressed={filter.agent === a ? "true" : "false"}
                >
                  <button
                    type="button"
                    aria-pressed={filter.agent === a}
                    onClick={() => {
                      setFilter((f) => ({ ...f, agent: f.agent === a ? null : a, source: null }));
                      deselect();
                    }}
                  >
                    <span className={`agent${isMuted ? " muted" : ""}`}>{a}</span>
                    <span className="c">{n || ""}</span>
                  </button>
                  <button
                    type="button"
                    className="mt"
                    aria-label={`${isMuted ? "Unmute" : "Mute"} ${a}`}
                    title={`${isMuted ? "Unmute" : "Mute"} ${a}`}
                    onClick={() =>
                      void (isMuted
                        ? notify.unmute({ agent: a }, { undoable: true })
                        : notify.mute({ agent: a }, { undoable: true }))
                    }
                  >
                    {isMuted ? "⊘" : "○"}
                  </button>
                </div>
              );
            })}
          </nav>

          <div className="nt-dr-main">
            {selected.length ? (
              <div className="nt-bulk">
                <button
                  type="button"
                  className={`nt-ck ${allChecked ? "on" : "part"}`}
                  role="checkbox"
                  aria-checked={allChecked ? true : "mixed"}
                  aria-label="Select all"
                  onClick={toggleAll}
                >
                  {allChecked ? "✓" : "–"}
                </button>
                <span className="n">{selected.length} selected</span>
                <button type="button" onClick={() => verbAndDeselect("read", selectedRows)}>
                  ✓ Read <kbd>r</kbd>
                </button>
                <button type="button" onClick={() => verbAndDeselect("unread", selectedRows)}>
                  ● Unread
                </button>
                <button type="button" onClick={() => verbAndDeselect("clear", selectedRows)}>
                  ✕ Clear <kbd>e</kbd>
                </button>
                <button
                  type="button"
                  onClick={(e: MouseEvent<HTMLButtonElement>) =>
                    menus.openSnooze(e.currentTarget, selectedRows)
                  }
                >
                  ◷ Snooze <kbd>s</kbd>
                </button>
                <button type="button" onClick={() => muteAgents(selectedRows)}>
                  ⊘ Mute agents
                </button>
                <button type="button" className="r" onClick={deselect}>
                  Deselect <kbd>esc</kbd>
                </button>
              </div>
            ) : (
              <div className="nt-ibar">
                <button
                  type="button"
                  className="nt-ck"
                  role="checkbox"
                  aria-checked={false}
                  aria-label="Select all"
                  title="Select all  ⇧A"
                  disabled={cards.length === 0}
                  onClick={toggleAll}
                />
                <input
                  type="search"
                  aria-label="Filter the inbox"
                  placeholder="filter by title, agent, kind…"
                  value={filter.q}
                  onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))}
                  onKeyDown={(e) => {
                    // Escape leaves the field rather than the drawer.
                    if (e.key !== "Escape") return;
                    e.preventDefault();
                    e.stopPropagation();
                    e.currentTarget.blur();
                    root.current?.focus();
                  }}
                />
                <span className="r mono">
                  {rows.length} rows · <kbd>x</kbd> select · <kbd>⇧</kbd>click range
                </span>
              </div>
            )}
            <div className="nt-ilist">
              {cards.length === 0 ? (
                <InboxZero
                  big={
                    filter.view === "snoozed"
                      ? "Nothing snoozed"
                      : filter.view === "history"
                        ? "No history yet"
                        : "All clear"
                  }
                >
                  <div className="sm">Nothing here matches this view.</div>
                </InboxZero>
              ) : (
                <InboxSections
                  sections={sections}
                  now={now}
                  focus={current}
                  cardProps={(card) => ({
                    ...routing(card),
                    checked: checked.has(card.key),
                    onCheck: (range) => toggleCheck(card.key, range),
                    onBodyClick: (e) => {
                      if (!e.shiftKey && !e.metaKey) return false;
                      toggleCheck(card.key, e.shiftKey);
                      return true;
                    },
                    onToggleRead: () =>
                      void notify.act(
                        { verb: card.rows.some(isUnread) ? "read" : "unread" },
                        card.rows,
                      ),
                    onClear: () => {
                      setFocus(focusAfterRemoval(keys, card.key));
                      void notify.act({ verb: "clear" }, card.rows);
                    },
                    onSnooze: (el) => menus.openSnooze(el, card.rows),
                    onMute: (el) => menus.openMute(el, card.latest),
                    onRestore: () => void notify.act({ verb: "restore" }, card.rows),
                    onUnsnooze: () => void notify.act({ verb: "unsnooze" }, card.rows),
                  })}
                />
              )}
            </div>
          </div>
        </div>

        <div className="nt-dr-foot">
          <span className="set">
            Auto-clear read rows after
            <span className="nt-mseg" role="group" aria-label="Auto-clear read rows after">
              {AUTO_CLEAR.map((x) => (
                <button
                  type="button"
                  key={x}
                  aria-pressed={settings?.auto_clear_read === x}
                  disabled={settings === null}
                  onClick={() => void notify.saveSettings({ auto_clear_read: x })}
                >
                  {x}
                </button>
              ))}
            </span>
          </span>
          <label className="set">
            <input
              type="checkbox"
              checked={settings?.clear_resolved_on_read ?? false}
              disabled={settings === null}
              onChange={(e) => void notify.saveSettings({ clear_resolved_on_read: e.target.checked })}
            />
            Clear resolved conditions once read
          </label>
          <button type="button" className="note" onClick={openRules}>
            rules, quiet hours &amp; mutes → Settings · Notifications
          </button>
        </div>
      </div>
      {menus.node}
    </Dialog>
  );
}
