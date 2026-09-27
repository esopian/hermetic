/**
 * The notification centre, coalescing.
 *
 * One conversation moved forty times is forty rows in the store and one card in
 * the drawer. `inbox-coalesce.test.ts` owns the fold itself; this owns the
 * wiring — that the card is drawn once with its count, that acking it clears
 * every row behind it rather than the one on screen, and that the drawer's
 * `needs you` is the same number the bell is showing.
 */
import { cleanup, render, screen, userEvent, waitFor } from "./dom.ts";
import { afterEach, expect, test } from "bun:test";
import { useRef } from "react";
import type { NotificationView } from "../src/api/index.ts";
import { NotificationCenter } from "../src/components/notify/Center.tsx";
import { NotifyProvider, useNotify } from "../src/state/notify-state.tsx";
import type { NotifyApi } from "../src/state/notify-state.tsx";

afterEach(cleanup);

/**
 * `kind` is widened the way `notify-center.dom.test.tsx` widens it: `chat.approval`
 * is a Phase 10 kind and `class: needs_action` has to be countable before any
 * shipping kind produces one.
 */
function chatRow(
  id: string,
  minute: number,
  over: Partial<Omit<NotificationView, "kind">> & { kind?: string } = {},
): NotificationView {
  return {
    id,
    at: `2026-09-19T10:${String(minute).padStart(2, "0")}:00.000Z`,
    source: "chat",
    kind: "chat.message",
    class: "info",
    title: "veronica has a new message",
    detail: null,
    agent: "veronica",
    fleet_id: "fxtr0001",
    ref: "veronica/default",
    key: null,
    actions: [],
    read_at: null,
    resolved_at: null,
    muted: false,
    ...over,
  } as unknown as NotificationView;
}

function harness(rows: NotificationView[], needsAction = 0) {
  const acks: Array<{ id?: string; all?: true }> = [];
  const api: NotifyApi = {
    fetchNotifications: () =>
      Promise.resolve({
        notifications: rows,
        unread: rows.filter((r) => !r.read_at).length,
        needs_action: needsAction,
        mutes: [],
      } as never),
    ackNotification: (input) => {
      acks.push(input as { id?: string });
      return Promise.resolve({ acked: 1 } as never);
    },
    muteNotification: () => Promise.resolve({ mutes: [] } as never),
  };
  function Bell() {
    // The header's own number, so a badge that moved by the wrong amount is
    // assertable rather than invisible.
    const notify = useNotify();
    return <span data-testid="unread">{notify.unread}</span>;
  }
  function Harness() {
    const anchor = useRef<HTMLButtonElement>(null);
    return (
      <NotifyProvider api={api}>
        <button type="button" ref={anchor}>
          bell
        </button>
        <Bell />
        <NotificationCenter anchor={anchor} onClose={() => {}} />
      </NotifyProvider>
    );
  }
  render(<Harness />);
  return { acks };
}

test("a run of one conversation's rows draws as one card with its count", async () => {
  harness([chatRow("a", 3), chatRow("b", 2), chatRow("c", 1)]);
  await screen.findByText("veronica has a new message");

  const items = document.querySelectorAll(".nt-item");
  expect(items.length).toBe(1);
  expect(items[0]?.getAttribute("data-count")).toBe("3");
  expect(screen.getAllByText("veronica has a new message").length).toBe(1);
});

test("a different conversation breaks the run rather than joining the card", async () => {
  harness([
    chatRow("a", 4),
    chatRow("b", 3),
    chatRow("x", 2, { agent: "atlas", ref: "atlas/default", title: "atlas has a new message" }),
    chatRow("c", 1),
  ]);
  await screen.findByText("atlas has a new message");

  const items = [...document.querySelectorAll(".nt-item")];
  expect(items.map((i) => i.getAttribute("data-count"))).toEqual(["2", null, null]);
});

test("acking the card acks every row behind it", async () => {
  const h = harness([chatRow("a", 3), chatRow("b", 2), chatRow("c", 1)]);
  const hit = await screen.findByRole("button", { name: "Mark read: veronica has a new message" });

  await userEvent.click(hit);

  await waitFor(() => expect(h.acks.length).toBe(3));
  expect(h.acks.map((a) => a.id).sort()).toEqual(["a", "b", "c"]);
  expect(document.querySelector(".nt-item")?.getAttribute("data-unread")).toBe("false");
});

test("a card is unread while any row behind it is, however new the top one is", async () => {
  harness([chatRow("a", 3, { read_at: "2026-09-19T10:04:00.000Z" }), chatRow("b", 2)]);
  await screen.findByText("veronica has a new message");
  expect(document.querySelector(".nt-item")?.getAttribute("data-unread")).toBe("true");
});

test("`needs you` in the drawer is the count the bell is showing", async () => {
  // Four outstanding in the whole inbox; this page of it holds one.
  harness([chatRow("a", 3, { class: "needs_action", kind: "chat.approval" })], 4);
  await screen.findByText("veronica has a new message");

  const tabs = [...document.querySelectorAll(".nt-tabs button")] as HTMLButtonElement[];
  expect(tabs[1]?.textContent).toBe("Needs you 4");
});

test("acking a card moves the badge by the number of rows it cleared, once", async () => {
  // Four unrelated rows sit under the card, so the badge has room to be wrong:
  // a decrement applied twice would land on 1 rather than on 4, and the clamp
  // at zero would not hide it.
  harness([
    chatRow("a", 3),
    chatRow("b", 2),
    chatRow("c", 1),
    ...Array.from({ length: 4 }, (_v, i) =>
      chatRow(`other${i}`, 1, { ref: `bot${i}/default`, title: `bot${i} has a new message` }),
    ),
  ]);
  await waitFor(() => expect(screen.getByTestId("unread").textContent).toBe("7"));

  await userEvent.click(screen.getByRole("button", { name: "Mark read: veronica has a new message" }));

  // Three unread rows cleared: three off the badge, not six.
  await waitFor(() => expect(screen.getByTestId("unread").textContent).toBe("4"));
});

test("acking a card counts only the rows that were unread", async () => {
  harness([
    chatRow("a", 3),
    chatRow("b", 2, { read_at: "2026-09-19T10:04:00.000Z" }),
    chatRow("c", 1),
    ...Array.from({ length: 3 }, (_v, i) =>
      chatRow(`other${i}`, 1, { ref: `bot${i}/default`, title: `bot${i} has a new message` }),
    ),
  ]);
  await waitFor(() => expect(screen.getByTestId("unread").textContent).toBe("5"));

  await userEvent.click(screen.getByRole("button", { name: "Mark read: veronica has a new message" }));

  // The already-read member is not counted a second time.
  await waitFor(() => expect(screen.getByTestId("unread").textContent).toBe("3"));
});

test("`showing latest` is the first read's answer, not the length of the list", async () => {
  // A short inbox never claims to be a page of a longer one.
  harness([chatRow("a", 3), chatRow("b", 2)]);
  await screen.findByText("veronica has a new message");
  expect(document.querySelector(".nt-retention")?.textContent).toContain("shared with the CLI");

  cleanup();

  // A full first page says so, and goes on saying so as the stream appends.
  harness(Array.from({ length: 100 }, (_v, i) => chatRow(`r${i}`, 1, { ref: `bot${i}/default` })));
  await waitFor(() =>
    expect(document.querySelector(".nt-retention")?.textContent).toContain("showing latest 100"),
  );
});
