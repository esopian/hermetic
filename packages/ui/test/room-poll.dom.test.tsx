/**
 * What an open hosted room costs while nobody is looking at it.
 *
 * The pane used to re-read `rooms.get` *and* walk `rooms.history` every three
 * seconds, for as long as the tab existed. The room detail is the name, the
 * roster and the flags — none of which a tick was learning anything new about —
 * so it is now read on mount and after this pane's own mutations, and the tick
 * is the incremental history read alone. That tick stops while the page is
 * hidden, because a background tab polling a gateway over the tailnet is work
 * nobody asked for, and resumes with an immediate read when the page comes
 * back rather than after a further three seconds of staleness.
 *
 * The waits here are real. Faking the clock would leave the assertion about the
 * one thing that matters — that no timer was armed — resting on the fake. Each
 * wait, and each visibility flip, is inside `act()`, so a read that lands in
 * the window is flushed into the tree rather than surfacing as a warning.
 *
 * Real time means no test may sit between two thresholds and hope the runner
 * is quick: a loaded CI box stretches a 5 ms wait into tens of milliseconds.
 * So every test drives the two timings itself (`pollMs`, `returnReadMinAgeMs`,
 * seams on `RoomConversation`) and sets whichever one it is not measuring to
 * `NEVER` — a value no run can reach. A test that expects a read waits for it
 * with `waitFor` rather than for a fixed span; a test that expects none has
 * arranged for none to be possible however slow the box is.
 */
import {
  act,
  cleanup,
  fireEvent,
  flipPageHidden,
  render,
  screen,
  setPageHidden,
  waitFor,
} from "./dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import type { ChatSwarmsResult, SwarmView } from "../src/api/index.ts";
import { ChatProvider } from "../src/chat/chat-state.tsx";
import type { ChatApi } from "../src/chat/chat-state.tsx";
import { BotWorkspace } from "../src/chat/components/BotWorkspace.tsx";
import { fakeServer } from "./fake-transport.ts";
import type { FakeServer, TransportCall } from "./fake-transport.ts";

const AT = "2026-09-18T12:00:00Z";
const INSTANCE = "atlas";
const ROOM = "room-a";
/** The poll cadence a test that wants ticks runs at. */
const TICK_MS = 30;
/** Longer than any run of this file: a threshold that can never be crossed. */
const NEVER_MS = 600_000;

let server: FakeServer | undefined;
afterEach(() => {
  server?.restore();
  server = undefined;
  // A visible page, back for the next file: the reset is each suite's own (`setup.ts`).
  setPageHidden(false);
  cleanup();
});

function swarmOf(): SwarmView {
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
    rooms: [
      {
        id: ROOM,
        name: "Room A",
        instance: INSTANCE,
        members: [{ instance: INSTANCE, bot: INSTANCE }],
        needs_action: false,
      },
    ],
    warm_slots: { used: 1, total: 3 },
    sections: [],
  } as unknown as SwarmView;
}

const chatApi = (): ChatApi => ({
  fetchSwarms: () => Promise.resolve({ swarms: [swarmOf()] } as ChatSwarmsResult),
  fetchSessions: (instance: string, bot: string) =>
    Promise.resolve({ instance, bot, sessions: [] } as never),
  fetchHistory: (instance: string, bot: string) =>
    Promise.resolve({ instance, bot, session: null, messages: [] } as never),
  sendTurn: () => () => {},
  abortTurn: () => Promise.resolve({} as never),
});

const GET = "rooms.get";
const HISTORY = "rooms.history";

async function openRoom({
  pollMs = TICK_MS,
  returnReadMinAgeMs = NEVER_MS,
}: {
  pollMs?: number;
  returnReadMinAgeMs?: number;
} = {}) {
  server = fakeServer({
    [GET]: (call: TransportCall) => ({
      instance: INSTANCE,
      id: (call.params as { room: string }).room,
      name: "Room A",
      members: [{ member_id: INSTANCE, profile: INSTANCE, handle: INSTANCE, display_name: "Atlas" }],
      revision: 1,
      latest_seq: 0,
      created_at: AT,
      updated_at: AT,
      disbanded_at: null,
      working: false,
      blocked: false,
      pending_actions: [],
    }),
    [HISTORY]: (call: TransportCall) => ({
      events: [],
      cursor: (call.params as { since_seq: number }).since_seq,
      has_more: false,
    }),
  });
  render(
    <ChatProvider api={chatApi()}>
      <BotWorkspace withContext={false} roomPollMs={pollMs} returnReadMinAgeMs={returnReadMinAgeMs} />
    </ChatProvider>,
  );
  await screen.findByText(/Canonical Bot Chat/);
  fireEvent.click(await screen.findByRole("button", { name: /Room A/ }));
  await screen.findByLabelText("Message the room");
  await waitFor(() => expect(server!.to(HISTORY).length).toBeGreaterThan(0));
}

const wait = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

/** Flip the page's visibility and let the store's answer land. */
const visibility = (next: boolean) =>
  act(async () => {
    flipPageHidden(next);
  });

describe("an open room polls its history and nothing else", () => {
  test("the detail is read once however many history ticks go by", async () => {
    await openRoom({ pollMs: TICK_MS });
    expect(server!.to(GET).length).toBe(1);
    const first = server!.to(HISTORY).length;
    await waitFor(() => expect(server!.to(HISTORY).length).toBeGreaterThan(first));
    const second = server!.to(HISTORY).length;
    await waitFor(() => expect(server!.to(HISTORY).length).toBeGreaterThan(second));
    // Three reads of the transcript, one read of the room.
    expect(server!.to(GET).length).toBe(1);
  }, 12_000);

  test("a hidden page polls nothing", async () => {
    // The return floor is out of reach, so the only thing that could read here
    // is the tick — and the tick is what being hidden is supposed to stop.
    await openRoom({ pollMs: TICK_MS, returnReadMinAgeMs: NEVER_MS });
    await visibility(true);
    const paused = server!.to(HISTORY).length;
    await wait(TICK_MS * 5);
    expect(server!.to(HISTORY).length).toBe(paused);

    // The last read (the mount's own) is younger than the floor, so a return
    // right away must not cost a read either — see `onReturnVisible`.
    await visibility(false);
    await wait(TICK_MS * 5);
    expect(server!.to(HISTORY).length).toBe(paused);
    expect(server!.to(GET).length).toBe(1);
  }, 20_000);

  test("a return reads once the last read is older than the floor", async () => {
    // No tick at all: the read this asserts on can only have come from the
    // return, whatever the runner's timing.
    await openRoom({ pollMs: NEVER_MS, returnReadMinAgeMs: 1 });
    const before = server!.to(HISTORY).length;
    await visibility(true);
    await wait(20);
    await visibility(false);
    await waitFor(() => expect(server!.to(HISTORY).length).toBeGreaterThan(before));
    expect(server!.to(GET).length).toBe(1);
  }, 20_000);

  test("a flapping page reads nothing", async () => {
    // Both thresholds out of reach: every read counted here is a read the
    // helper was supposed to suppress. A regression that bypassed it (reading
    // on every hidden→visible transition) adds ten.
    await openRoom({ pollMs: NEVER_MS, returnReadMinAgeMs: NEVER_MS });
    const before = server!.to(HISTORY).length;
    for (let i = 0; i < 10; i++) {
      await visibility(true);
      await wait(5);
      await visibility(false);
      await wait(5);
    }
    expect(server!.to(HISTORY).length).toBe(before);
  }, 12_000);
});
