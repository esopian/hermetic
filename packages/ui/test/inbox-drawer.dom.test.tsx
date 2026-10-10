/**
 * The full inbox drawer, driven (Inbox v2).
 *
 * What the drawer decides for itself: a shift-click selects a range, the bulk
 * bar's verbs act on exactly the selection in one batch, Escape drops a
 * selection before it closes anything, and the foot writes core's auto-clear
 * rule rather than a page preference.
 */
import { cleanup, fireEvent, render, screen, userEvent, waitFor, within } from "./dom.ts";
import { afterEach, expect, test } from "bun:test";
import { useEffect } from "react";
import { InboxDrawer } from "../src/components/notify/InboxDrawer.tsx";
import { NotifyProvider, useNotify } from "../src/state/notify-state.tsx";
import { fakeInbox, notification } from "./inbox-fake.ts";

afterEach(cleanup);

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function Open() {
  const notify = useNotify();
  const { openDrawer } = notify;
  useEffect(() => openDrawer(), [openDrawer]);
  return notify.drawerOpen ? <InboxDrawer /> : <span>shut</span>;
}

function mount() {
  const fake = fakeInbox([
    notification({
      id: "a",
      title: "alpha failed",
      class: "bad",
      kind: "operation.failed",
      at: minutesAgo(1),
    }),
    notification({
      id: "b",
      title: "bravo failed",
      class: "bad",
      kind: "operation.failed",
      at: minutesAgo(2),
    }),
    notification({
      id: "c",
      title: "charlie failed",
      class: "bad",
      kind: "operation.failed",
      at: minutesAgo(3),
    }),
  ]);
  render(
    <NotifyProvider api={fake.api}>
      <Open />
    </NotifyProvider>,
  );
  return fake;
}

test("shift-click selects a range; the bulk bar clears exactly the selection, in one write", async () => {
  const fake = mount();
  const user = userEvent.setup();
  await screen.findByText("alpha failed");

  await user.click(screen.getByRole("checkbox", { name: "Select: alpha failed" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select: charlie failed" }), { shiftKey: true });
  expect(screen.getByText("3 selected")).toBeTruthy();

  await user.click(screen.getByRole("checkbox", { name: "Select: bravo failed" }));
  expect(screen.getByText("2 selected")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: /Clear e/ }));

  await waitFor(() => expect(screen.queryByText("alpha failed")).toBeNull());
  expect(screen.getByText("bravo failed")).toBeTruthy();
  expect(fake.writes()).toEqual([{ method: "notifications.clear", input: { ids: ["a", "c"] } }]);
});

test("Escape drops the selection first, then closes the drawer", async () => {
  mount();
  const user = userEvent.setup();
  await screen.findByText("alpha failed");
  await user.click(screen.getByRole("checkbox", { name: "Select: alpha failed" }));

  await user.keyboard("{Escape}");
  expect(screen.queryByText("1 selected")).toBeNull();
  expect(screen.getByRole("dialog", { name: "Inbox" })).toBeTruthy();
  await user.keyboard("{Escape}");
  await screen.findByText("shut");
});

test("the foot writes core's auto-clear rule", async () => {
  const fake = mount();
  const group = await screen.findByRole("group", { name: "Auto-clear read rows after" });
  await waitFor(() =>
    expect(within(group).getByRole("button", { name: "7d" }).getAttribute("aria-pressed")).toBe("true"),
  );

  await userEvent.click(within(group).getByRole("button", { name: "30d" }));
  await waitFor(() =>
    expect(
      fake.calls.filter((c) => c.method === "notifications.settings").map((c) => c.input),
    ).toContainEqual({
      auto_clear_read: "30d",
    }),
  );
  expect(within(group).getByRole("button", { name: "30d" }).getAttribute("aria-pressed")).toBe("true");
});
