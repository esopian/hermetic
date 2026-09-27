/**
 * Settings → Notifications, the full inbox (§4.9).
 *
 * `notify-center.dom.test.tsx` owns the popover; this owns the one thing the
 * section decides for itself — what "unread only" means. It has to mean the
 * rows the unread count is counting, and core does not count a row whose
 * condition has cleared, so neither may this filter. The unfiltered list still
 * holds those rows, marked as history.
 */
import { cleanup, render, screen, userEvent } from "./dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import type { NotificationView } from "../src/api/index.ts";
import { NotificationsSection } from "../src/components/settings/NotificationsSection.tsx";
import { NotifyProvider } from "../src/state/notify-state.tsx";
import type { NotifyApi } from "../src/state/notify-state.tsx";

afterEach(cleanup);

function notification(over: Partial<NotificationView> = {}): NotificationView {
  return {
    id: "n1",
    at: new Date().toISOString(),
    source: "fleet",
    kind: "fleet.advisory",
    class: "info",
    title: "a condition",
    detail: null,
    agent: null,
    fleet_id: "fxtr0001",
    ref: null,
    key: null,
    actions: [],
    read_at: null,
    resolved_at: null,
    muted: false,
    ...over,
  } as unknown as NotificationView;
}

const ROWS: NotificationView[] = [
  notification({ id: "live", title: "vol-dorado has no agent" }),
  notification({
    id: "cleared",
    title: "Foundation update available",
    resolved_at: new Date(Date.now() - 20 * 60_000).toISOString(),
  }),
  notification({ id: "read", title: "granite create finished", read_at: new Date().toISOString() }),
];

function api(rows: NotificationView[]): NotifyApi {
  return {
    fetchNotifications: () =>
      Promise.resolve({
        notifications: rows,
        // Core's rule, mirrored: a cleared row is listed and counted nowhere.
        unread: rows.filter((r) => !r.read_at && !r.resolved_at).length,
        needs_action: rows.filter((r) => r.class === "needs_action" && !r.resolved_at).length,
        mutes: [],
      } as never),
    ackNotification: () => Promise.resolve({ acked: 0 } as never),
    muteNotification: () => Promise.resolve({ mutes: [] } as never),
  };
}

describe("Settings → Notifications", () => {
  test("`unread only` hides a cleared condition, and the full list keeps it as history", async () => {
    render(
      <NotifyProvider api={api(ROWS)}>
        <NotificationsSection />
      </NotifyProvider>,
    );
    await screen.findByText("Foundation update available");

    // Unfiltered: every row, with the cleared one drawn as history.
    expect(document.querySelectorAll(".nt-item").length).toBe(3);
    const row = document.querySelector('[data-resolved="true"]');
    expect(row?.textContent).toContain("cleared 20m ago");
    // The count agrees with what the filter is about to show: one unread row.
    expect(document.querySelector(".nt-inbox-bar .nt-inbox-count")?.textContent).toBe(
      "1 unread · 0 need you",
    );

    // The bar's own checkbox — the rules block below has one per group.
    await userEvent.click(document.querySelector(".nt-inbox-bar input") as HTMLInputElement);

    expect(document.querySelectorAll(".nt-item").length).toBe(1);
    expect(screen.getByText("vol-dorado has no agent")).toBeTruthy();
    expect(screen.queryByText("Foundation update available")).toBeNull();
  });
});
