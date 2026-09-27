/**
 * The notification centre: a 470px popover under the header bell.
 *
 * It is a *summary* surface, not the archive — the last hundred rows, three
 * tabs, and a way out to the full inbox under Settings. The archive lives in
 * Settings because that is where a thing you scroll belongs, and because the
 * popover is a focus trap: a list long enough to need paging is a trap long
 * enough to be one.
 */
import { useMemo, useState } from "react";
import type { RefObject } from "react";
import {
  NOTIFICATION_TABS,
  centerCounts,
  filterTab,
  groupNotifications,
  groupRow,
} from "../../logic/notification-logic.ts";
import type { NotificationTab } from "../../logic/notification-logic.ts";
import { settingsHash } from "../../nav/settings-nav.ts";
import { INBOX_PAGE, useNotify } from "../../state/notify-state.tsx";
import { Popover } from "../Popover.tsx";
import { NotificationRow } from "./NotificationRow.tsx";

export const CENTER_EMPTY =
  "Nothing yet. Failed and finished operations, health changes and fleet advisories land here.";

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
  const [tab, setTab] = useState<NotificationTab>("all");
  const now = Date.now();
  /**
   * `needs you` is the server's number, not a count of what this popover holds
   * (see `centerCounts`): the bell and the drawer were counting two different
   * things and disagreeing about the same inbox at the same instant.
   */
  const counts = useMemo(
    () => centerCounts(notify.items, { needsAction: notify.needsAction }),
    [notify.items, notify.needsAction],
  );
  const rows = useMemo(() => filterTab(notify.items, tab), [notify.items, tab]);
  /**
   * A run of rows about one conversation draws as one card. The rows are
   * untouched — §4.9 keys them on their own timestamps and the unread count is
   * still per row — this is only what the drawer shows.
   */
  const groups = useMemo(() => groupNotifications(rows), [rows]);
  /**
   * `all` and `fleet` count what is held, so say when that is a page. The flag
   * comes from the first read rather than from the current length: the stream
   * appends past the initial page, and a list that has *grown* to `INBOX_PAGE`
   * rows would otherwise start claiming to be a truncated view of itself.
   */
  const truncated = notify.truncated;

  const openSettings = () => {
    onClose();
    if (onOpenSettings) onOpenSettings("notifications");
    else window.location.hash = settingsHash("notifications");
  };

  return (
    <Popover
      anchor={anchor}
      onClose={onClose}
      maxWidth={470}
      label="Notifications"
      style={{ zIndex: 210 }}
    >
      <div className="nt-center">
        <div className="popover-head">
          <span>Notifications</span>
          <span className="nt-head-actions">
            <button type="button" onClick={() => void notify.ackAll()}>
              mark all read
            </button>
            <button type="button" onClick={openSettings}>
              settings
            </button>
          </span>
        </div>

        <div className="nt-tabs">
          {NOTIFICATION_TABS.map((t) => (
            <button type="button" key={t.id} aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}{" "}
              <span className={t.id === "needs_you" ? "nt-tab-n warn" : "nt-tab-n"}>
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
          {rows.length === 0 ? (
            <div className="nt-empty mono">{CENTER_EMPTY}</div>
          ) : (
            groups.map((group) => (
              <NotificationRow
                key={group.key}
                n={groupRow(group)}
                count={group.count}
                now={now}
                // A card stands for every row in its run, so acking it — by a
                // click on the body or by one of its action buttons — clears
                // all of them rather than the one that happened to be drawn.
                onAck={(id) =>
                  void (group.count === 1
                    ? notify.ack(id)
                    : notify.ackMany(group.rows.map((r) => r.id)))
                }
                onOpenAgent={onOpenAgent}
                onNavigated={onClose}
              />
            ))
          )}
        </div>

        <div className="popover-foot nt-foot">
          <span className="mono nt-retention">
            {truncated
              ? `showing latest ${INBOX_PAGE} · kept 30 days`
              : "kept 30 days · shared with the CLI's run log"}
          </span>
          <button type="button" className="btn-mini" onClick={openSettings}>
            Open full inbox →
          </button>
        </div>
      </div>
    </Popover>
  );
}
