/**
 * The notification centre, driven (§4.9).
 *
 * `notification-logic.test.ts` owns the rules; this owns the wiring — that the
 * rows the provider was seeded with are the rows drawn, that the tabs count and
 * filter what the rules say they do, that clicking a row acknowledges it
 * through the API rather than only in the DOM, and that an inbox with nothing
 * in it says so instead of drawing an empty box.
 *
 * The three calls are injected (`NotifyProvider`'s `api` prop) rather than
 * stubbed on `fetch`: this is a test about the provider's state machine, and a
 * fake that records its own calls is what makes "the ack reached the server"
 * assertable.
 */
import { cleanup, render, screen, userEvent, waitFor } from "./dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { useRef } from "react";
import type { NotificationView } from "../src/api/index.ts";
import { CENTER_EMPTY, NotificationCenter } from "../src/components/notify/Center.tsx";
import { NotifyProvider } from "../src/state/notify-state.tsx";
import type { NotifyApi } from "../src/state/notify-state.tsx";

afterEach(cleanup);

/**
 * `kind` is the one field typed wider than the record: core's
 * `NotificationKind` is exactly the four Phase 1–3 kinds, and `chat.*` joins it
 * with the phase that raises it (Phase 10 for `chat.approval`). `class`, on the
 * other hand, already carries `needs_action` today — so the centre has to
 * count, filter and draw that class *before* any shipping kind produces one,
 * and the row proving it can only name the kind that will. Widening `kind` here
 * rather than dropping the row keeps that coverage; the rest of the record
 * stays typed, so a real field going stale still fails this test.
 */
function notification(
  over: Partial<Omit<NotificationView, "kind">> & { kind?: string } = {},
): NotificationView {
  return {
    id: "n1",
    at: new Date().toISOString(),
    source: "operation",
    kind: "operation.done",
    class: "ok",
    title: "oriole finished bootstrapping",
    detail: "6 stages · 7m41s · ready.",
    agent: "oriole",
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

interface Recorder {
  api: NotifyApi;
  acks: Array<{ id?: string; all?: true }>;
}

function recorder(rows: NotificationView[]): Recorder {
  const acks: Array<{ id?: string; all?: true }> = [];
  return {
    acks,
    api: {
      fetchNotifications: () =>
        Promise.resolve({
          notifications: rows,
          unread: rows.filter((r) => !r.read_at && !r.resolved_at).length,
          // Core's own rule, mirrored: a row whose condition has cleared is
          // returned in the list and counted in neither total (§4.9).
          needs_action: rows.filter((r) => r.class === "needs_action" && !r.resolved_at).length,
          mutes: [],
        } as never),
      ackNotification: (input) => {
        acks.push(input as { id?: string; all?: true });
        return Promise.resolve({ acked: 1 } as never);
      },
      muteNotification: () => Promise.resolve({ mutes: [] } as never),
    },
  };
}

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

describe("NotificationCenter", () => {
  test("draws every seeded row, with its tone and its unread state", async () => {
    const r = recorder(SEED);
    render(<Harness api={r.api} />);

    await screen.findByText("create failed · marrow");
    expect(screen.getByText("corvid wants to write /etc/nginx")).toBeTruthy();
    expect(screen.getByText("Foundation v8 is available")).toBeTruthy();

    const rows = document.querySelectorAll(".nt-item");
    expect(rows.length).toBe(3);
    expect(rows[0]?.className).toContain("bad");
    expect(rows[1]?.className).toContain("needs-action");
    // Priority is the class; unread is its own attribute, and the read row says so.
    expect(rows[1]?.getAttribute("data-unread")).toBe("true");
    expect(rows[2]?.getAttribute("data-unread")).toBe("false");
  });

  test("the tabs count and filter", async () => {
    const r = recorder(SEED);
    render(<Harness api={r.api} />);
    await screen.findByText("create failed · marrow");

    const tabs = [...document.querySelectorAll(".nt-tabs button")] as HTMLButtonElement[];
    expect(tabs.map((t) => t.textContent)).toEqual(["All 3", "Needs you 1", "Fleet 2"]);

    await userEvent.click(tabs[1]!);
    expect(document.querySelectorAll(".nt-item").length).toBe(1);
    expect(screen.getByText("corvid wants to write /etc/nginx")).toBeTruthy();

    // `fleet` is the fleet's own sources — the chat approval is not one of them.
    await userEvent.click(tabs[2]!);
    expect(document.querySelectorAll(".nt-item").length).toBe(2);
    expect(screen.queryByText("corvid wants to write /etc/nginx")).toBeNull();
  });

  test("clicking a row acknowledges it, through the API and on screen", async () => {
    const r = recorder(SEED);
    render(<Harness api={r.api} />);
    const hit = await screen.findByRole("button", { name: "Mark read: create failed · marrow" });

    await userEvent.click(hit);

    await waitFor(() => expect(r.acks).toEqual([{ id: "op-fail" }]));
    expect(document.querySelector(".nt-item")?.getAttribute("data-unread")).toBe("false");
  });

  test("`mark all read` clears every row in one call", async () => {
    const r = recorder(SEED);
    render(<Harness api={r.api} />);
    await screen.findByText("create failed · marrow");

    await userEvent.click(screen.getByRole("button", { name: "mark all read" }));

    await waitFor(() => expect(r.acks).toEqual([{ all: true }]));
    for (const row of document.querySelectorAll(".nt-item")) {
      expect(row.getAttribute("data-unread")).toBe("false");
    }
  });

  test("a cleared condition is drawn as history, and left out of `needs you`", async () => {
    const cleared = notification({
      id: "cleared",
      class: "needs_action",
      source: "fleet",
      kind: "fleet.advisory",
      title: "Foundation update available",
      agent: null,
      resolved_at: new Date(Date.now() - 20 * 60_000).toISOString(),
    });
    const r = recorder([...SEED, cleared]);
    render(<Harness api={r.api} />);
    await screen.findByText("Foundation update available");

    const row = document.querySelector('[data-resolved="true"]');
    expect(row).toBeTruthy();
    // Neutral, not gold: the class it was raised at no longer drives the rule.
    expect(row?.className).toContain("resolved");
    expect(row?.textContent).toContain("cleared 20m ago");
    // Nobody acknowledged it, so it is still unread — the two are not the same.
    expect(row?.getAttribute("data-unread")).toBe("true");

    const tabs = [...document.querySelectorAll(".nt-tabs button")] as HTMLButtonElement[];
    expect(tabs.map((t) => t.textContent)).toEqual(["All 4", "Needs you 1", "Fleet 3"]);
    await userEvent.click(tabs[1]!);
    expect(screen.queryByText("Foundation update available")).toBeNull();
  });

  test("an empty inbox says what would land in it, rather than drawing an empty box", async () => {
    const r = recorder([]);
    render(<Harness api={r.api} />);

    await screen.findByText(CENTER_EMPTY);
    expect(document.querySelectorAll(".nt-item").length).toBe(0);
    // The foot is still there: the retention line is the answer to "is it broken".
    expect(screen.getByText("kept 30 days · shared with the CLI's run log")).toBeTruthy();
  });
});
