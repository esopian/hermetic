/**
 * The hosted-room pane, driven.
 *
 * Two behaviours here are not visible in a snapshot and are the reason the file
 * exists.
 *
 * **A submission keeps its identity across navigation.** `event_id` is the
 * gateway's idempotency key, so a send that was accepted upstream but whose
 * answer was lost must be retried under the id the first attempt used —
 * including when the operator left the room and came back, which unmounts the
 * pane. The identity therefore lives in `BotWorkspace`, beside the per-room
 * drafts, and these tests drive the real workspace rather than a stand-in so
 * that the wiring between the two is what is under test.
 *
 * **Polling is incremental.** A tick asks for what comes after the cursor, not
 * for the transcript, and `event_id` dedupes a page the gateway replays. The
 * ticks here are provoked by a successful send (which refreshes the room)
 * rather than by waiting out the three-second timer.
 *
 * The room calls are stubbed at the transport (`fake-transport.ts`) because that is how
 * the rest of this suite fakes a server; the four chat calls are injected
 * through `ChatProvider`'s `api` prop, the way `chat-view.dom.test.tsx` does.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "./dom.ts";
import type { ChatSwarmsResult, SwarmView } from "../src/api/index.ts";
import { ChatProvider } from "../src/chat/chat-state.tsx";
import type { ChatApi } from "../src/chat/chat-state.tsx";
import { BotWorkspace } from "../src/chat/components/BotWorkspace.tsx";
import { errorBody, fakeServer } from "./fake-transport.ts";
import type { FakeServer, TransportCall } from "./fake-transport.ts";

afterEach(cleanup);
// The avatar entrance tween is left to run here. It used to be skipped by a
// module-scope `document.hidden` patch, and `setup.ts` owns that property now
// — owning it means `visibilityState` agrees with it, so a hidden page also
// stops the roster read every test below is built on. Measured both ways: the
// file is green and no slower with the tween left alone.

const AT = "2026-09-18T12:00:00Z";
const INSTANCE = "atlas";

interface RoomEvent {
  room_id: string;
  seq: number;
  event_id: string;
  kind: string;
  actor: { kind: string; id: string };
  text: string | null;
  member_id: string | null;
  created_at: string;
}

function eventOf(room: string, seq: number, id: string, text: string): RoomEvent {
  return {
    room_id: room,
    seq,
    event_id: id,
    kind: "message",
    actor: { kind: "user", id: "operator" },
    text,
    member_id: null,
    created_at: AT,
  };
}

function detailOf(room: string, name: string, latest_seq: number | null = 0) {
  return {
    instance: INSTANCE,
    id: room,
    name,
    members: [{ member_id: "atlas", profile: "atlas", handle: "atlas", display_name: "Atlas" }],
    revision: 1,
    latest_seq,
    created_at: AT,
    updated_at: AT,
    disbanded_at: null,
    working: false,
    blocked: false,
    pending_actions: [],
  };
}

function swarmOf(rooms: { id: string; name: string }[]): SwarmView {
  return {
    instance: INSTANCE,
    reachable: true,
    unreachable_reason: null,
    bots: [
      {
        instance: INSTANCE,
        name: INSTANCE,
        title: INSTANCE,
        description: "the box",
        is_default: true,
        model: null,
        section: null,
        avatar_seed: `${INSTANCE}/${INSTANCE}`,
        last_message_at: AT,
        unread: 0,
        needs_action: false,
        muted: false,
        warm: true,
      },
    ],
    rooms: rooms.map((room) => ({
      id: room.id,
      name: room.name,
      instance: INSTANCE,
      members: [{ instance: INSTANCE, bot: INSTANCE }],
      needs_action: false,
    })),
    warm_slots: { used: 1, total: 3 },
    sections: [],
  } as unknown as SwarmView;
}

const chatApi = (swarms: SwarmView[]): ChatApi => ({
  fetchSwarms: () => Promise.resolve({ swarms } as ChatSwarmsResult),
  fetchSessions: (instance: string, bot: string) =>
    Promise.resolve({ instance, bot, sessions: [] } as never),
  fetchHistory: (instance: string, bot: string) =>
    Promise.resolve({ instance, bot, session: null, messages: [] } as never),
  sendTurn: () => () => {},
  abortTurn: () => Promise.resolve({} as never),
});

interface Send {
  room: string;
  text: string;
  event_id: string;
}

interface Rooms {
  server: FakeServer;
  /** Every `rooms.send` the pane issued, in order. */
  sends: Send[];
  /** Every `rooms.history` read, in order, with the cursor it asked from. */
  reads: { room: string; since_seq: number }[];
  /**
   * How the gateway answers a send: `"fail"` loses the answer the way an
   * unreachable box does, `"duplicate"` recognises the `event_id` and returns
   * the event it already holds, `"conflict"` refuses an id already carrying
   * different content.
   */
  sendMode: "ok" | "fail" | "duplicate" | "conflict";
  /** What the next history read answers with, per room and per read. */
  pages: Map<string, { events: RoomEvent[]; cursor: number; has_more: boolean }[]>;
}

/**
 * Mounts the workspace over a fake gateway, with the given rooms in the rail,
 * and waits for the roster to settle. The wait is load-bearing: the workspace
 * drops the open room whenever the *bot* selection changes, and the provider
 * selects a bot of its own accord as the roster arrives, so a room opened
 * before then would be closed again by that selection.
 *
 * `latest_seq: null` sends the room detail with a literal `null` mark rather
 * than defaulting it to 0 — `detailOf`'s own default parameter only applies to
 * `undefined`, so passing `null` through reaches the pane as `null`, the way a
 * gateway reporting no high-water mark would.
 */
async function mount(
  rooms: { id: string; name: string; latest_seq?: number | null }[],
): Promise<Rooms> {
  const state: Rooms = {
    sends: [],
    reads: [],
    sendMode: "ok",
    pages: new Map(),
    server: {} as FakeServer,
  };
  const names = new Map(rooms.map((room) => [room.id, room.name]));
  const marks = new Map(rooms.map((room) => [room.id, room.latest_seq]));
  state.server = fakeServer({
    "rooms.get": (call: TransportCall) => {
      const body = call.params as { room: string };
      const mark = marks.get(body.room);
      return detailOf(body.room, names.get(body.room) ?? body.room, mark === undefined ? 0 : mark);
    },
    "rooms.history": (call: TransportCall) => {
      const body = call.params as { room: string; since_seq: number };
      state.reads.push({ room: body.room, since_seq: body.since_seq });
      const queued = state.pages.get(body.room);
      return queued?.shift() ?? { events: [], cursor: body.since_seq, has_more: false };
    },
    "rooms.send": (call: TransportCall) => {
      const body = call.params as { room: string; text: string; event_id: string };
      state.sends.push({ room: body.room, text: body.text, event_id: body.event_id });
      if (state.sendMode === "fail") return errorBody("CHAT_UNREACHABLE", "the box did not answer");
      if (state.sendMode === "conflict")
        return errorBody(
          "CONFLICT",
          `${body.room}: this message id already carries different content in this room; the message posted under it stands`,
        );
      return {
        accepted: true,
        event_id: body.event_id,
        duplicate: state.sendMode === "duplicate",
      };
    },
  });
  render(
    <ChatProvider api={chatApi([swarmOf(rooms)])}>
      <BotWorkspace withContext={false} />
    </ChatProvider>,
  );
  await screen.findByText(/Canonical Bot Chat/);
  return state;
}

/** Opens a room from the rail and waits for its pane to accept a message. */
async function open(name: string): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(name) }));
  await screen.findByLabelText("Message the room");
}

/** Types `text` and sends it, waiting for the send button to unlock first. */
async function send(text: string): Promise<void> {
  const input = screen.getByLabelText("Message the room") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: text } });
  const button = await waitFor(() => {
    const found = screen.getByRole("button", { name: /Send/ }) as HTMLButtonElement;
    expect(found.disabled).toBe(false);
    return found;
  });
  fireEvent.click(button);
}

describe("an uncertain room submission keeps its identity", () => {
  test("a retry after leaving the room and coming back reuses the first event id", async () => {
    const rooms = await mount([
      { id: "room-a", name: "Room A" },
      { id: "room-b", name: "Room B" },
    ]);
    await open("Room A");
    rooms.sendMode = "fail";
    await send("did this land");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("did not answer"));
    expect(rooms.sends).toHaveLength(1);

    // Away and back: the pane unmounts, so anything held in it is gone.
    await open("Room B");
    await open("Room A");
    rooms.sendMode = "ok";
    await send("did this land");
    await waitFor(() => expect(rooms.sends).toHaveLength(2));
    expect(rooms.sends[1]?.text).toBe("did this land");
    expect(rooms.sends[1]?.event_id).toBe(rooms.sends[0]?.event_id as string);
    rooms.server.restore();
  });

  test("a different message after a delivered one is a new submission", async () => {
    const rooms = await mount([{ id: "room-a", name: "Room A" }]);
    await open("Room A");
    await send("first");
    await waitFor(() => expect(rooms.sends).toHaveLength(1));
    await send("second");
    await waitFor(() => expect(rooms.sends).toHaveLength(2));
    expect(rooms.sends[1]?.event_id).not.toBe(rooms.sends[0]?.event_id);
    rooms.server.restore();
  });

  test("a delivered submission releases its id, so repeating the text posts anew", async () => {
    const rooms = await mount([
      { id: "room-a", name: "Room A" },
      { id: "room-b", name: "Room B" },
    ]);
    await open("Room A");
    await send("say it again");
    await waitFor(() => expect(rooms.sends).toHaveLength(1));
    await open("Room B");
    await open("Room A");
    await send("say it again");
    await waitFor(() => expect(rooms.sends).toHaveLength(2));
    expect(rooms.sends[1]?.event_id).not.toBe(rooms.sends[0]?.event_id);
    rooms.server.restore();
  });
});

describe("room polling reads forward, not from the top", () => {
  test("a later tick asks from the cursor and a replayed event renders once", async () => {
    const rooms = await mount([{ id: "room-a", name: "Room A" }]);
    rooms.pages.set("room-a", [
      {
        events: [eventOf("room-a", 1, "e1", "opening line"), eventOf("room-a", 2, "e2", "second line")],
        cursor: 2,
        has_more: false,
      },
      // The gateway replays the page's tail and adds one event after it.
      {
        events: [eventOf("room-a", 2, "e2", "second line"), eventOf("room-a", 3, "e3", "third line")],
        cursor: 3,
        has_more: false,
      },
    ]);
    await open("Room A");
    await waitFor(() => expect(screen.getByText("second line")).toBeDefined());
    expect(rooms.reads[0]?.since_seq).toBe(0);

    // A delivered send refreshes the room, which is the next poll tick.
    await send("and mine");
    await waitFor(() => expect(screen.getByText("third line")).toBeDefined());
    expect(rooms.reads.length).toBeGreaterThan(1);
    expect(rooms.reads[1]?.since_seq).toBe(2);
    expect(rooms.reads.slice(1).every((read) => read.since_seq > 0)).toBe(true);
    expect(screen.getAllByText("second line")).toHaveLength(1);
    rooms.server.restore();
  });

  test("a long room opens near its end, and says what it did not load", async () => {
    const rooms = await mount([{ id: "room-a", name: "Room A", latest_seq: 900 }]);
    rooms.pages.set("room-a", [
      { events: [eventOf("room-a", 900, "e900", "the current line")], cursor: 900, has_more: false },
    ]);
    await open("Room A");
    await waitFor(() => {
      expect(screen.getByText("the current line")).toBeDefined();
      expect(screen.getByText(/700 earlier events were not loaded/)).toBeDefined();
    });
    // 900 - TAIL_WINDOW: the first read aims at the recent end rather than
    // walking 900 events forward from zero over three-second ticks.
    expect(rooms.reads[0]?.since_seq).toBe(700);
    rooms.server.restore();
  });

  test("a room shorter than the window still loads from the top and shows all of it", async () => {
    const rooms = await mount([{ id: "room-a", name: "Room A", latest_seq: 12 }]);
    rooms.pages.set("room-a", [
      {
        events: [
          eventOf("room-a", 1, "e1", "the opening line"),
          eventOf("room-a", 12, "e12", "the closing line"),
        ],
        cursor: 12,
        has_more: false,
      },
    ]);
    await open("Room A");
    await waitFor(() => {
      expect(screen.getByText("the closing line")).toBeDefined();
      expect(screen.getByText("the opening line")).toBeDefined();
      expect(screen.queryByText(/not loaded/)).toBeNull();
    });
    expect(rooms.reads[0]?.since_seq).toBe(0);
    rooms.server.restore();
  });
});

function memberPost(
  room: string,
  seq: number,
  id: string,
  text: string,
  kind = "message.member",
): RoomEvent {
  return {
    ...eventOf(room, seq, id, text),
    kind,
    actor: { kind: "member", id: "atlas" },
    member_id: "atlas",
  };
}

describe("a member that chose not to answer", () => {
  test("a post that is only a silence token is the muted marker, never the token", async () => {
    const rooms = await mount([{ id: "room-a", name: "Room A" }]);
    rooms.pages.set("room-a", [
      {
        events: [
          memberPost("room-a", 1, "e1", " [SILENT] "),
          memberPost("room-a", 2, "e2", "NO_REPLY"),
          memberPost("room-a", 3, "e3", "a real answer"),
          eventOf("room-a", 4, "e4", "NO_REPLY"),
        ],
        cursor: 4,
        has_more: false,
      },
    ]);
    await open("Room A");
    await waitFor(() => expect(screen.getByText("a real answer")).toBeDefined());
    const markers = [...document.querySelectorAll<HTMLElement>(".ch-silent")];
    expect(markers).toHaveLength(2);
    expect(markers[0]?.textContent).toMatch(/atlas stayed silent/);
    expect(markers[0]?.getAttribute("title")).toBe("replied [SILENT] — Hermes suppresses delivery");
    expect(document.body.textContent).not.toContain("[SILENT]");
    // The operator's own `NO_REPLY` is their words, drawn as a bubble.
    const bubbles = [...document.querySelectorAll<HTMLElement>(".ch-msg")];
    expect(bubbles.map((b) => b.querySelector(".bm-pre")?.textContent)).toEqual([
      "a real answer",
      "NO_REPLY",
    ]);
    expect(bubbles[1]?.querySelector(".ch-avatar.me")).not.toBeNull();
    rooms.server.restore();
  });

  test("a member event that is not a message keeps its literal text", async () => {
    const rooms = await mount([{ id: "room-a", name: "Room A" }]);
    rooms.pages.set("room-a", [
      {
        events: [memberPost("room-a", 1, "e1", "NO_REPLY", "error.member")],
        cursor: 1,
        has_more: false,
      },
    ]);
    await open("Room A");
    await waitFor(() => expect(screen.getByText("NO_REPLY")).toBeDefined());
    expect(document.querySelector(".ch-silent")).toBeNull();
    rooms.server.restore();
  });
});

describe("an unknown delivery is reconciled, not replayed", () => {
  test("a retry the gateway recognises reads as delivered, once", async () => {
    const rooms = await mount([{ id: "room-a", name: "Room A" }]);
    await open("Room A");
    rooms.sendMode = "fail";
    await send("did this land");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("did not answer"));

    // The first attempt did reach the gateway; only its answer was lost. The
    // room holds one copy, and the retry carries the id that posted it.
    rooms.pages.set("room-a", [
      { events: [eventOf("room-a", 1, "e1", "did this land")], cursor: 1, has_more: false },
    ]);
    rooms.sendMode = "duplicate";
    await send("did this land");
    // Both assertions wait together: the roster the workspace polls can close
    // and reopen the pane between two reads of the DOM, and a message counted
    // in one render and a notice read from the next would be a race, not a
    // fact. The count is the point — a retry that was recognised must leave one
    // message, not a second beside it.
    await waitFor(() => {
      expect(screen.getAllByText("did this land")).toHaveLength(1);
      expect(screen.getByRole("status").textContent).toContain("Already delivered");
      expect(screen.queryByRole("alert")).toBeNull();
    });
    expect(rooms.sends).toHaveLength(2);
    expect(rooms.sends[1]?.event_id).toBe(rooms.sends[0]?.event_id as string);
    rooms.server.restore();
  });

  test("an id already holding different text reports the conflict, not a transport failure", async () => {
    const rooms = await mount([{ id: "room-a", name: "Room A" }]);
    await open("Room A");
    rooms.sendMode = "conflict";
    await send("a message under a taken id");
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("already carries different text"),
    );
    // The id is retired: retrying it could only conflict again, so the next
    // attempt is a new submission.
    rooms.sendMode = "ok";
    await send("a message under a taken id");
    await waitFor(() => expect(rooms.sends).toHaveLength(2));
    expect(rooms.sends[1]?.event_id).not.toBe(rooms.sends[0]?.event_id);
    rooms.server.restore();
  });
});

describe("a missing high-water mark does not wreck the first read", () => {
  test("a room whose detail carries no latest_seq still loads and asks from a real, non-negative cursor", async () => {
    // The gateway's high-water mark can come back `null` rather than a number
    // — `detailOf`'s own default only covers the key being left off entirely,
    // not the pane's own arithmetic, so this exercises the value the pane
    // actually has to do `latest_seq - TAIL_WINDOW` on.
    const rooms = await mount([{ id: "room-a", name: "Room A", latest_seq: null }]);
    rooms.pages.set("room-a", [
      { events: [eventOf("room-a", 1, "e1", "hello there")], cursor: 1, has_more: false },
    ]);
    await open("Room A");
    await waitFor(() => expect(screen.getByText("hello there")).toBeDefined());
    const since = rooms.reads[0]?.since_seq;
    expect(typeof since).toBe("number");
    expect(Number.isNaN(since)).toBe(false);
    expect(since).toBeGreaterThanOrEqual(0);
    rooms.server.restore();
  });
});

describe("a regressed cursor from the gateway cannot pull the read backwards", () => {
  test("a later page reporting a cursor behind what was already consumed does not rewind the next request or duplicate events", async () => {
    const rooms = await mount([{ id: "room-a", name: "Room A" }]);
    rooms.pages.set("room-a", [
      {
        events: [eventOf("room-a", 1, "e1", "one"), eventOf("room-a", 2, "e2", "two")],
        cursor: 2,
        has_more: false,
      },
      // A later page regresses: it reports a cursor behind what the previous
      // page already reached, and replays an event already shown rather than
      // adding anything past it.
      { events: [eventOf("room-a", 2, "e2", "two")], cursor: 1, has_more: false },
    ]);
    await open("Room A");
    await waitFor(() => expect(screen.getByText("two")).toBeDefined());
    expect(rooms.reads[0]?.since_seq).toBe(0);

    // A delivered send is the next poll tick: it reads the regressed page.
    // The read the send triggers lands after the send itself resolves, so the
    // wait is on the read — waiting only for `sends` reads a `reads` entry that
    // a slower machine has not written yet.
    await send("three");
    await waitFor(() => expect(rooms.sends).toHaveLength(1));
    await waitFor(() => expect(rooms.reads).toHaveLength(2));
    expect(rooms.reads[1]?.since_seq).toBe(2);

    // A second delivered send is the tick after that. If the regressed page
    // had pulled the cursor back to 1, this request would ask from 1 instead
    // of holding at 2.
    await send("four");
    await waitFor(() => expect(rooms.sends).toHaveLength(2));
    await waitFor(() => expect(rooms.reads).toHaveLength(3));
    expect(rooms.reads[2]?.since_seq).toBe(2);
    expect(screen.getAllByText("two")).toHaveLength(1);
    rooms.server.restore();
  });
});

/**
 * The header in a narrow desktop window.
 *
 * The workspace draws `Members` in an absolutely positioned
 * bar over the top of the pane under 1180px. The bot side clears it with the
 * strip above its thread header; the room side has no strip above it, so the
 * header carries the clearance itself — and the soft skin's
 * `[data-skin="soft"] .ch-thead` padding outranked the rule that used to do it,
 * which put the toolbar on top of the room title with Manage and Stop behind
 * it. jsdom applies no stylesheet, so the two halves are checked separately:
 * the header's three blocks in the DOM, and the rules that lay them out in the
 * CSS the browser actually loads.
 */
describe("the room header at narrow widths", () => {
  test("the title and the actions are separate blocks under the header", async () => {
    const rooms = await mount([{ id: "room-a", name: "Pun Corner" }]);
    await open("Pun Corner");
    const head = document.querySelector(".ch-thead.bm-room-head");
    expect(head).not.toBeNull();
    const blocks = [...(head?.children ?? [])].map((n) => n.className);
    expect(blocks).toEqual(["bm-room-icon", "ch-thead-id", "ch-thead-actions"]);

    const title = head?.querySelector(".ch-thead-id > .ch-thead-name");
    expect(title?.textContent).toContain("Pun Corner");
    // The actions are a sibling of the identity block, never inside it: the
    // header's grid lays them out by that relationship.
    expect(head?.querySelector(".ch-thead-id .ch-thead-actions")).toBeNull();
    expect(head?.querySelector(".ch-thead-actions")?.textContent).toContain("Manage");
    expect(head?.querySelector(".ch-thead-actions")?.textContent).toContain("Stop");
    rooms.server.restore();
  });

  test("the narrow rules clear the floating toolbar", async () => {
    const css = await Bun.file(new URL("../src/chat/styles/chat.css", import.meta.url).pathname).text();
    const wide = css.slice(css.indexOf("@media (max-width: 1180px)"));
    // At a specificity the soft skin cannot outrank — a bare `.ch-thead`
    // padding in a media query would lose to `[data-skin="soft"] .ch-thead`.
    expect(wide).toContain('[data-skin="soft"] .ch-thead.bm-room-head');
    expect(wide).toContain("padding-top: 42px");
  });
});
