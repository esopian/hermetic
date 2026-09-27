/**
 * What the rails read off the inbox, and who they say is open.
 *
 * Two defects, both found in the running portal rather than here. The Unread
 * filter emptied the rail while the bell was lit about those very bots — the
 * roster's `unread` and this laptop's unacknowledged `chat.*` rows are two
 * different counts and only one of them was being asked. And opening one of a
 * bot's additional sessions dropped the rail's highlight altogether, so the
 * rail claimed nothing was open while a thread was on screen.
 */
import { cleanup, fireEvent, render, screen, userEvent, waitFor } from "./dom.ts";
import { afterEach, expect, test } from "bun:test";
import type { ReactNode } from "react";
import type { NotificationView, SessionView, SwarmView } from "../src/api/index.ts";
import { railUnread } from "../src/chat/chat-logic.ts";
import { Rail } from "../src/chat/components/Rail.tsx";
import { BotRail } from "../src/chat/components/BotRail.tsx";
import { NotifyProvider } from "../src/state/notify-state.tsx";
import type { NotifyApi } from "../src/state/notify-state.tsx";

afterEach(cleanup);

function chatRow(id: string, ref: string): NotificationView {
  return {
    id,
    at: "2026-09-19T10:00:00.000Z",
    source: "chat",
    kind: "chat.message",
    class: "info",
    title: "veronica has a new message",
    detail: null,
    agent: null,
    fleet_id: "fxtr0001",
    ref,
    key: null,
    actions: [],
    read_at: null,
    resolved_at: null,
    muted: false,
  } as unknown as NotificationView;
}

function inbox(rows: NotificationView[]): NotifyApi {
  return {
    fetchNotifications: () =>
      Promise.resolve({
        notifications: rows,
        unread: rows.length,
        needs_action: 0,
        mutes: [],
      } as never),
    ackNotification: () => Promise.resolve({ acked: 1 } as never),
    muteNotification: () => Promise.resolve({ mutes: [] } as never),
  };
}

const BOT = {
  instance: "veronica",
  name: "default",
  title: "the default bot",
  description: null,
  preview: null,
  is_default: true,
  section: null,
  avatar_seed: "seed",
  last_message_at: "2026-09-19T10:00:00.000Z",
  unread: 0,
  needs_action: false,
  muted: false,
  warm: true,
};

function swarms(over: Partial<SwarmView> = {}): SwarmView[] {
  return [
    {
      instance: "veronica",
      reachable: true,
      unreachable_reason: null,
      bots: [BOT],
      rooms: [],
      warm_slots: { used: 1, total: 3 },
      sections: [],
      ...over,
    } as unknown as SwarmView,
  ];
}

function classicRail(filter: "all" | "unread" | "needs", wrap: (node: ReactNode) => ReactNode) {
  render(
    wrap(
      <Rail
        swarms={swarms()}
        fleetId="fxtr0001"
        statusOf={() => "ready"}
        sessions={[]}
        scope={{ kind: "all" }}
        onScope={() => {}}
        filter={filter}
        onFilter={() => {}}
        query=""
        onQuery={() => {}}
        selection={null}
        onSelect={() => {}}
        now={Date.parse("2026-09-19T10:05:00.000Z")}
      />,
    ) as never,
  );
}

test("the two unread counts are the same messages: the larger wins, never the sum", () => {
  // One message the box has counted and this laptop has a row for is one
  // message. Adding them said "2" the moment the two observers agreed.
  expect(railUnread({ unread: 1 }, 1)).toBe(1);
  expect(railUnread({ unread: 0 }, 3)).toBe(3);
  expect(railUnread({ unread: 4 }, 1)).toBe(4);
  expect(railUnread({ unread: 0 })).toBe(0);
});

test("the rail's Unread filter keeps a bot the inbox has unread rows for", async () => {
  classicRail("unread", (node) => (
    <NotifyProvider api={inbox([chatRow("a", "veronica/default"), chatRow("b", "veronica/default")])}>
      {node}
    </NotifyProvider>
  ));

  // The roster says `unread: 0` for this bot; the inbox says two.
  await waitFor(() => expect(document.querySelectorAll(".ch-conv").length).toBe(1));
  expect(document.querySelector(".ch-conv")?.getAttribute("data-unread")).toBe("true");
  // Two rows, two messages: the roster's own zero does not add to them.
  expect(document.querySelector(".ch-unread")?.textContent).toBe("2");
});

test("with no inbox to read, the roster's own count is still the whole story", () => {
  classicRail("unread", (node) => node);
  // Nothing unread anywhere: the filter empties the rail, as it always did.
  expect(document.querySelectorAll(".ch-conv").length).toBe(0);
  expect(screen.getByText("nothing matches")).toBeTruthy();
});

function room(over: Record<string, unknown> = {}) {
  return {
    id: "pun-corner",
    name: "Pun Corner",
    instance: "veronica",
    members: [],
    needs_action: false,
    ...over,
  };
}

function botRail(props: Partial<Parameters<typeof BotRail>[0]> = {}) {
  render(
    <BotRail
      swarms={swarms({ rooms: [room()] } as never)}
      sessions={[]}
      selection={null}
      room={null}
      fleetId="fxtr0001"
      now={Date.parse("2026-09-19T10:05:00.000Z")}
      query=""
      onQuery={() => {}}
      onSelect={() => {}}
      onRoom={() => {}}
      onCreateBot={() => {}}
      onCreateRoom={() => {}}
      onNewSession={() => {}}
      statusOf={() => "ready"}
      activities={[]}
      {...props}
    />,
  );
}

test("a room with nothing pending is hidden under `Needs you`", async () => {
  botRail();
  expect(screen.getByText("Pun Corner")).toBeTruthy();

  const needs = screen.getByRole("button", { name: "Needs you" });
  needs.click();
  await screen.findByText("No rooms match this filter.");
  expect(screen.queryByText("Pun Corner")).toBeNull();
});

test("a room that is waiting on you survives `Needs you`", async () => {
  botRail({ swarms: swarms({ rooms: [room({ needs_action: true })] } as never) });
  screen.getByRole("button", { name: "Needs you" }).click();
  await screen.findByText("Pun Corner");
});

test("the rail keeps the owning bot lit while one of its other sessions is open", () => {
  const session = {
    id: "s-2",
    instance: "veronica",
    bot: "default",
    title: "a cron run",
    kind: "ordinary",
    origin: "routine",
    origin_detail: null,
    turn_count: 3,
    unread: 0,
    last_message_at: "2026-09-19T10:00:00.000Z",
  } as unknown as SessionView;
  botRail({
    sessions: [session],
    selection: { instance: "veronica", bot: "default", session: "s-2" },
  });

  const open = [...document.querySelectorAll(".ch-conv")].filter(
    (el) => el.getAttribute("aria-current") === "true",
  );
  expect(open.length).toBe(1);
  expect(open[0]?.textContent).toContain("the default bot");
});

/**
 * A live-portal repro claimed a scripted `element.click()` on the Sessions tab
 * did nothing while a manual click worked. Nothing in `BotRail` or `ChatShell`
 * gates the switch on anything but `onClick` — no capture-phase listener, no
 * `disabled`/`aria-disabled`, no overlay guard — so `fireEvent.click` here
 * should flip `aria-selected` same as a real click. This is the click path
 * itself, not that theory.
 */
test("clicking the Sessions tab switches the rail and flips aria-selected", async () => {
  const session = {
    id: "s-1",
    instance: "veronica",
    bot: "default",
    title: "a lone session",
    kind: "ordinary",
    origin: "routine",
    origin_detail: null,
    turn_count: 1,
    unread: 0,
    last_message_at: "2026-09-19T10:00:00.000Z",
  } as unknown as SessionView;
  botRail({ sessions: [session] });

  const bots = screen.getByRole("tab", { name: /Bots/ });
  const sessions = screen.getByRole("tab", { name: "Sessions" });
  expect(bots.getAttribute("aria-selected")).toBe("true");
  expect(sessions.getAttribute("aria-selected")).toBe("false");
  expect(screen.getByText("the default bot")).toBeTruthy();

  fireEvent.click(sessions);

  await waitFor(() => expect(sessions.getAttribute("aria-selected")).toBe("true"));
  expect(bots.getAttribute("aria-selected")).toBe("false");
  expect(screen.queryByText("the default bot")).toBeNull();
});

test("keyboard activation (Enter) switches tabs same as a click", async () => {
  botRail();
  const bots = screen.getByRole("tab", { name: /Bots/ });
  const sessions = screen.getByRole("tab", { name: "Sessions" });

  bots.focus();
  expect(document.activeElement).toBe(bots);

  const user = userEvent.setup();
  sessions.focus();
  await user.keyboard("{Enter}");

  await waitFor(() => expect(sessions.getAttribute("aria-selected")).toBe("true"));
});

test("ArrowRight/ArrowLeft move between tabs, per the tablist role", async () => {
  botRail();
  const bots = screen.getByRole("tab", { name: /Bots/ });
  const sessions = screen.getByRole("tab", { name: "Sessions" });
  const user = userEvent.setup();

  bots.focus();
  await user.keyboard("{ArrowRight}");
  await waitFor(() => expect(sessions.getAttribute("aria-selected")).toBe("true"));
  expect(document.activeElement).toBe(sessions);

  await user.keyboard("{ArrowLeft}");
  await waitFor(() => expect(bots.getAttribute("aria-selected")).toBe("true"));
  expect(document.activeElement).toBe(bots);
});
