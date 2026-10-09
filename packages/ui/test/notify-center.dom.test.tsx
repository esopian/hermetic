/**
 * The notification centre, driven (§4.9, Inbox v2).
 *
 * `inbox-logic.test.ts` owns the rules; this owns the wiring — that the tabs
 * count and filter what the rules say, that every bulk verb is scoped to the
 * tab on screen and sent as one batch, that clicking a row reads it, that undo
 * puts back exactly what was there (and in an order core's auto-clear sweep
 * cannot undo again), that the keys work inside the centre, and that an empty
 * inbox says so.
 *
 * The api is a stateful fake (`inbox-fake.ts`) because the provider re-reads
 * after every verb, and a fake that answered with the seed would resurrect a
 * cleared row and make the test about itself.
 */
import { cleanup, render, screen, userEvent, waitFor, within } from "./dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { useRef } from "react";
import type { NotificationView } from "../src/api/index.ts";
import { NotificationCenter } from "../src/components/notify/Center.tsx";
import { NotifyProvider } from "../src/state/notify-state.tsx";
import type { NotifyApi } from "../src/state/notify-state.tsx";
import { fakeInbox, notification } from "./inbox-fake.ts";

afterEach(cleanup);

const SEED: NotificationView[] = [
  notification({
    id: "op-fail",
    class: "bad",
    kind: "operation.failed",
    title: "create failed · marrow",
    agent: "marrow",
  }),
  notification({
    id: "approval",
    class: "needs_action",
    source: "chat",
    kind: "chat.approval",
    title: "corvid wants to write /etc/nginx",
    agent: "corvid",
  }),
  notification({
    id: "advisory",
    class: "info",
    source: "fleet",
    kind: "fleet.advisory",
    title: "Foundation v8 is available",
    agent: null,
    read_at: new Date().toISOString(),
  }),
];

function Harness({ api }: { api: NotifyApi }) {
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <NotifyProvider api={api}>
      <button type="button" ref={anchor}>
        bell
      </button>
      <NotificationCenter anchor={anchor} onClose={() => {}} />
    </NotifyProvider>
  );
}

function tabs(): HTMLButtonElement[] {
  return [...document.querySelectorAll(".nt-tabs button")] as HTMLButtonElement[];
}

function rowOf(title: string): HTMLElement {
  const el = screen.getByText(title).closest(".nt-item");
  if (!(el instanceof HTMLElement)) throw new Error(`no row for ${title}`);
  return el;
}

describe("NotificationCenter", () => {
  test("pins `Waiting on you` above the time sections, with tone and unread state", async () => {
    const fake = fakeInbox(SEED);
    render(<Harness api={fake.api} />);
    await screen.findByText("create failed · marrow");

    const sections = [...document.querySelectorAll(".nt-sec")].map((s) =>
      s.firstChild?.textContent?.trim(),
    );
    expect(sections).toEqual(["Waiting on you", "Today"]);
    const rows = document.querySelectorAll(".nt-item");
    expect(rows.length).toBe(3);
    expect(rows[0]?.className).toContain("needs-action");
    expect(rows[0]?.getAttribute("data-unread")).toBe("true");
    expect(rowOf("Foundation v8 is available").getAttribute("data-unread")).toBe("false");
  });

  test("the tabs count and filter", async () => {
    const fake = fakeInbox(SEED);
    render(<Harness api={fake.api} />);
    await screen.findByText("create failed · marrow");

    await waitFor(() =>
      expect(tabs().map((t) => t.textContent)).toEqual(["Needs you 1", "Unread 2", "All 3"]),
    );
    await userEvent.click(tabs()[0]!);
    expect(document.querySelectorAll(".nt-item").length).toBe(1);
    await userEvent.click(tabs()[1]!);
    expect(document.querySelectorAll(".nt-item").length).toBe(2);
    expect(screen.queryByText("Foundation v8 is available")).toBeNull();
  });

  test("clicking a row with no action marks it read, through the API", async () => {
    const fake = fakeInbox(SEED);
    render(<Harness api={fake.api} />);
    await userEvent.click(
      await screen.findByRole("button", { name: "Mark read: create failed · marrow" }),
    );

    await waitFor(() =>
      expect(fake.writes()).toEqual([{ method: "notifications.ack", input: { id: "op-fail" } }]),
    );
    expect(rowOf("create failed · marrow").getAttribute("data-unread")).toBe("false");
  });

  test("`Mark N read` reads exactly the tab on screen, in one batch", async () => {
    const fake = fakeInbox(SEED);
    render(<Harness api={fake.api} />);
    await screen.findByText("create failed · marrow");

    await userEvent.click(tabs()[0]!);
    await userEvent.click(screen.getByRole("button", { name: /Mark 1 read/ }));

    // The unread failure is on another tab, and stays unread.
    await waitFor(() =>
      expect(fake.writes()).toEqual([{ method: "notifications.ack", input: { ids: ["approval"] } }]),
    );
    expect(fake.row("op-fail")?.read_at).toBeNull();
  });

  test("`Clear N read` takes the read rows out of the inbox, and undo brings them back", async () => {
    const fake = fakeInbox(SEED);
    render(<Harness api={fake.api} />);
    await screen.findByText("Foundation v8 is available");

    await userEvent.click(screen.getByRole("button", { name: /Clear 1 read/ }));
    await waitFor(() => expect(screen.queryByText("Foundation v8 is available")).toBeNull());
    expect(screen.getByRole("status").textContent).toContain("Cleared 1 notification");

    await userEvent.click(screen.getByRole("button", { name: /Undo/ }));
    await screen.findByText("Foundation v8 is available");
    expect(fake.writes().map((w) => w.input)).toEqual([
      { ids: ["advisory"] },
      { ids: ["advisory"], restore: true },
    ]);
  });

  test("undoing a clear of an unread row marks it unread *before* restoring it", async () => {
    const fake = fakeInbox(SEED);
    render(<Harness api={fake.api} />);
    await screen.findByText("create failed · marrow");

    await userEvent.click(
      within(rowOf("create failed · marrow")).getByRole("button", { name: "Clear" }),
    );
    await waitFor(() => expect(screen.queryByText("create failed · marrow")).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: /Undo/ }));

    await screen.findByText("create failed · marrow");
    // Clearing read the row; undo has to put the unread state back, and has to
    // do it first, or core's clear-resolved-on-read sweep re-clears the row.
    await waitFor(() =>
      expect(fake.writes()).toEqual([
        { method: "notifications.clear", input: { ids: ["op-fail"] } },
        { method: "notifications.ack", input: { ids: ["op-fail"], unread: true } },
        { method: "notifications.clear", input: { ids: ["op-fail"], restore: true } },
      ]),
    );
    await waitFor(() =>
      expect(rowOf("create failed · marrow").getAttribute("data-unread")).toBe("true"),
    );
  });

  test("the keys: j focuses, e clears the focused card, z undoes", async () => {
    const fake = fakeInbox(SEED);
    render(<Harness api={fake.api} />);
    await screen.findByText("create failed · marrow");
    const user = userEvent.setup();

    await user.keyboard("j");
    expect(document.querySelector('.nt-item[data-focus="true"]')?.textContent).toContain(
      "corvid wants to write",
    );
    await user.keyboard("e");
    await waitFor(() => expect(screen.queryByText("corvid wants to write /etc/nginx")).toBeNull());
    await user.keyboard("z");
    await screen.findByText("corvid wants to write /etc/nginx");
    expect(fake.writes()[0]).toEqual({ method: "notifications.clear", input: { ids: ["approval"] } });
  });

  test("a cleared condition is drawn as history, and left out of `needs you`", async () => {
    const resolved = notification({
      id: "resolved",
      class: "needs_action",
      source: "fleet",
      kind: "fleet.advisory",
      title: "Foundation update available",
      agent: null,
      key: "foundation:update",
      resolved_at: new Date(Date.now() - 20 * 60_000).toISOString(),
    });
    const fake = fakeInbox([...SEED, resolved]);
    render(<Harness api={fake.api} />);
    await screen.findByText("Foundation update available");

    const row = document.querySelector('[data-resolved="true"]');
    expect(row?.className).toContain("resolved");
    expect(row?.textContent).toContain("cleared 20m ago");
    // A resolved condition is no longer open.
    expect(row?.querySelector(".tag.open")).toBeNull();
    expect(row?.getAttribute("data-unread")).toBe("true");
    await waitFor(() =>
      expect(tabs().map((t) => t.textContent)).toEqual(["Needs you 1", "Unread 2", "All 4"]),
    );
  });

  test("an empty inbox says ALL CLEAR, and Needs you says nothing is waiting", async () => {
    const fake = fakeInbox([]);
    render(<Harness api={fake.api} />);

    await screen.findByText("All clear");
    expect(screen.getByText(/Inbox zero\./)).toBeTruthy();
    expect(screen.getByRole("button", { name: "View history →" })).toBeTruthy();
    await userEvent.click(tabs()[0]!);
    expect(screen.getByText("Nothing waiting on you")).toBeTruthy();
  });
});
