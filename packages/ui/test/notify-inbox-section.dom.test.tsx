/**
 * Settings → Notifications, the `Inbox` block (§4.9, Inbox v2).
 *
 * The archive moved out of this page into the full inbox drawer; what is left
 * here is the way there. The block has to say how much is in the inbox — with
 * the server's counts, the same ones the bell shows — and `Open inbox` has to
 * open the drawer rather than a second copy of it.
 */
import { cleanup, render, screen, userEvent, waitFor } from "./dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { NotificationsSection } from "../src/components/settings/NotificationsSection.tsx";
import { NotifyProvider, useNotify } from "../src/state/notify-state.tsx";
import { fakeInbox, notification } from "./inbox-fake.ts";

afterEach(cleanup);

function DrawerFlag() {
  return <span data-testid="drawer">{useNotify().drawerOpen ? "open" : "shut"}</span>;
}

describe("Settings → Notifications", () => {
  test("the Inbox block counts the inbox and opens the drawer", async () => {
    const fake = fakeInbox([
      notification({ id: "live", title: "vol-dorado has no agent", class: "info" }),
      notification({ id: "gold", title: "Foundation update available", class: "needs_action" }),
      notification({
        id: "gone",
        title: "granite create finished",
        cleared_at: new Date().toISOString(),
      }),
    ]);
    render(
      <NotifyProvider api={fake.api}>
        <NotificationsSection />
        <DrawerFlag />
      </NotifyProvider>,
    );

    await waitFor(() => expect(screen.getByText(/2 unread · 1 need you · 1 in History/)).toBeTruthy());
    // The rows themselves are not drawn here any more.
    expect(document.querySelectorAll(".nt-item").length).toBe(0);
    expect(screen.getByTestId("drawer").textContent).toBe("shut");

    await userEvent.click(screen.getByRole("button", { name: "Open inbox" }));
    expect(screen.getByTestId("drawer").textContent).toBe("open");
  });
});
