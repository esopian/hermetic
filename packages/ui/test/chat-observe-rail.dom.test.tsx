/**
 * The chat fan-in, driven (§9.2): the inbox, the rail, and the
 * transcript already held.
 *
 * Split from `chat-observe.dom.test.tsx`, which keeps the arrival itself; the
 * doubles are shared (`chat-observe-fixtures.tsx`). Here: one message is one
 * notification, two sends of the same words are two messages, a message that
 * outruns its transcript is kept, the rail moves on the stream rather than on
 * the roster's tick, a resume names one conversation, and the reconnecting
 * advisory says so and stops.
 */
import { act, cleanup, render, screen, userEvent, waitFor } from "./dom.ts";
import { afterEach, describe, expect, jest, test } from "bun:test";
import type {
  ChatHistoryResult,
  ChatMessageView,
  ChatObserveView,
  NotificationView,
} from "../src/api/index.ts";
import { OBSERVE_QUIET_MS } from "../src/chat/chat-conversations.ts";
import { ChatProvider, useChat } from "../src/chat/chat-state.tsx";
import type { Chat, ChatApi } from "../src/chat/chat-state.tsx";
import { ChatView } from "../src/chat/components/ChatView.tsx";
import { NotifyProvider, useNotify } from "../src/state/notify-state.tsx";
import type { Notify, NotifyApi } from "../src/state/notify-state.tsx";
import {
  ATLAS,
  arrival,
  arrivalFor,
  deliver,
  harness,
  messageOf,
  mount,
  probe,
  shown,
  snapshot,
  swarmWith,
} from "./chat-observe-fixtures.tsx";
import type { Harness } from "./chat-observe-fixtures.tsx";

afterEach(cleanup);
afterEach(() => {
  jest.useRealTimers();
});

// The avatar entrance tween is left to run here. It used to be skipped by a
// module-scope `document.hidden` patch, and `setup.ts` owns that property now
// — owning it means `visibilityState` agrees with it, so a hidden page also
// stops the roster read every test below is built on. Measured both ways: the
// file is green and no slower with the tween left alone.

/* ── one message, one notification ───────────────────────────────────────── */

describe("the inbox", () => {
  const row: NotificationView = {
    id: "n-chat-1",
    at: new Date().toISOString(),
    source: "chat",
    kind: "chat.message",
    class: "info",
    title: "atlas replied",
    detail: "the complete answer, from the box",
    agent: "atlas",
    fleet_id: "fxtr0001",
    ref: null,
    key: null,
    actions: [],
    read_at: null,
    resolved_at: null,
    muted: false,
  } as unknown as NotificationView;

  test("a message on the stream raises no notification of its own", async () => {
    const h = harness();
    const notifyApi: NotifyApi = {
      fetchNotifications: () =>
        Promise.resolve({
          notifications: [row],
          unread: 1,
          needs_action: 0,
          mutes: [],
        } as never),
      ackNotification: () => Promise.resolve({} as never),
      muteNotification: () => Promise.resolve({} as never),
    };
    const held: { chat: Chat | null; notify: Notify | null } = { chat: null, notify: null };
    function Probe() {
      held.chat = useChat();
      held.notify = useNotify();
      return null;
    }
    render(
      <NotifyProvider api={notifyApi}>
        <ChatProvider api={h.api}>
          <Probe />
          <ChatView />
        </ChatProvider>
      </NotifyProvider>,
    );
    await waitFor(() => expect(held.chat?.historyRead).toBe(true));
    await waitFor(() => expect(held.notify?.items).toHaveLength(1));

    // Core raised that row through the shared observation and the server
    // delivered it on the fleet stream. The same message arriving here is the
    // *transcript's* copy: N tabs are N renders of one message and one row.
    await deliver(
      h,
      arrival(
        messageOf({
          id: "n-chat-1-message",
          blocks: [{ kind: "text", markdown: "the complete answer, from the box" }],
        }),
      ),
    );
    await deliver(
      h,
      arrival(
        messageOf({
          id: "n-chat-1-message",
          blocks: [{ kind: "text", markdown: "the complete answer, from the box" }],
        }),
      ),
    );

    await waitFor(() => expect(shown(/the complete answer, from the box/)).toBeGreaterThan(0));
    expect(held.notify?.items).toHaveLength(1);
    expect(held.notify?.unread).toBe(1);
    // Nothing in the chat store may raise a toast: the inbox is the server's.
    expect(held.notify?.toasts).toHaveLength(0);
  });
});

/* ── reconciling what the box says with what this browser is holding ─────── */

/** The prose of a stored message, the way the store compares two of them. */
function textOf(message: ChatMessageView): string {
  return message.blocks.map((b) => (b.kind === "text" ? b.markdown : "")).join("");
}

/** What the selected conversation is holding, as prose. */
function transcript(held: { store: Chat | null }): string[] {
  return (held.store?.messages ?? []).map(textOf);
}

/** A transcript read that never answers, so the store keeps what it has. */
function stall(h: Harness, after = 0): void {
  let calls = 0;
  h.api.fetchHistory = ((instance: string, bot: string) => {
    if (calls++ >= after) return new Promise<never>(() => {});
    return Promise.resolve({
      instance,
      bot,
      session: "s1",
      messages: [],
    } as unknown as ChatHistoryResult);
  }) as ChatApi["fetchHistory"];
}

/** A turn that ends the instant it starts, so the next send is allowed. */
function instantTurn(h: Harness): void {
  h.api.sendTurn = ((
    _instance: string,
    _bot: string,
    _text: string,
    handlers: { onEnd: (ok: boolean, error: null) => void },
  ) => {
    h.calls.send++;
    queueMicrotask(() => handlers.onEnd(true, null));
    return () => {};
  }) as unknown as ChatApi["sendTurn"];
}

/** Mounted, selected, and not waiting for a transcript that may never arrive. */
async function mountUnread(h: Harness) {
  const { held, Probe } = probe();
  const view = render(
    <ChatProvider api={h.api}>
      <Probe />
      <ChatView />
    </ChatProvider>,
  );
  await waitFor(() => expect(h.streams.length).toBe(1));
  await waitFor(() => expect(held.store?.selection).not.toBeNull());
  return { ...view, held };
}

describe("two sends of the same words", () => {
  /**
   * Same role, same prose, overlapping windows: everything the placeholder
   * match looks at is identical, so the only thing that can tell the two apart
   * is that one recorded message stands for one send. A predicate applied row
   * by row could not, and the second send disappeared off the screen it had
   * been typed into while the box was still holding it.
   */
  test("one recorded copy accounts for one of them, not both", async () => {
    const h = harness();
    stall(h, 1);
    instantTurn(h);
    const { held } = await mountUnread(h);
    await waitFor(() => expect(held.store?.historyRead).toBe(true));

    await act(async () => {
      held.store?.send("ping");
    });
    await waitFor(() => expect(held.store?.sending).toBe(false));
    await act(async () => {
      held.store?.send("ping");
    });
    await waitFor(() => expect(transcript(held)).toEqual(["ping", "ping"]));

    // The box has recorded the first one and not yet the second.
    await deliver(
      h,
      snapshot([
        messageOf({
          id: "upstream-user-1",
          role: "user",
          at: new Date().toISOString(),
          blocks: [{ kind: "text", markdown: "ping" }],
        }),
      ]),
    );

    expect(transcript(held)).toEqual(["ping", "ping"]);
    expect(held.store?.messages[0]?.id).toBe("upstream-user-1");
    expect(held.store?.messages[1]?.id.startsWith("local:")).toBe(true);
  });

  /**
   * The window is bounded in both directions. A box whose clock runs an hour
   * fast reports a message far in this browser's future; without an upper bound
   * that message is a candidate for every placeholder ever made, which is the
   * same collapse by another route.
   */
  test("a recorded message from the far future does not stand for a live send", async () => {
    const h = harness();
    stall(h, 1);
    instantTurn(h);
    const { held } = await mountUnread(h);
    await waitFor(() => expect(held.store?.historyRead).toBe(true));

    await act(async () => {
      held.store?.send("pong");
    });
    await waitFor(() => expect(transcript(held)).toEqual(["pong"]));

    await deliver(
      h,
      snapshot([
        messageOf({
          id: "upstream-user-future",
          role: "user",
          at: new Date(Date.now() + 60 * 60_000).toISOString(),
          blocks: [{ kind: "text", markdown: "pong" }],
        }),
      ]),
    );

    expect(transcript(held)).toEqual(["pong", "pong"]);
  });
});

describe("a message that arrives before the transcript it belongs to", () => {
  /**
   * Core sends `snapshot` first, so this is a frame that normally cannot
   * happen. "Normally" is not a guarantee across a reconnect or a re-subscribe,
   * and the frame was being dropped: if the snapshot behind it was read before
   * the message, the message was gone for good and nothing would say so.
   */
  test("is held and folded into the snapshot that does not carry it", async () => {
    const h = harness();
    stall(h);
    const { held } = await mountUnread(h);
    expect(held.store?.historyRead).toBe(false);

    await deliver(
      h,
      arrival(messageOf({ id: "early-1", blocks: [{ kind: "text", markdown: "early" }] })),
    );
    // Dropped on arrival, correctly — there is no transcript to append it to.
    expect(transcript(held)).toEqual([]);

    // The snapshot behind it was read before that message existed.
    await deliver(
      h,
      snapshot([messageOf({ id: "older", blocks: [{ kind: "text", markdown: "older" }] })]),
    );

    expect(transcript(held)).toEqual(["older", "early"]);
    expect(held.store?.historyRead).toBe(true);
  });

  test("is not doubled when the snapshot does carry it", async () => {
    const h = harness();
    stall(h);
    const { held } = await mountUnread(h);

    await deliver(
      h,
      arrival(messageOf({ id: "early-2", blocks: [{ kind: "text", markdown: "early" }] })),
    );
    await deliver(
      h,
      snapshot([messageOf({ id: "early-2", blocks: [{ kind: "text", markdown: "early" }] })]),
    );

    expect(transcript(held)).toEqual(["early"]);
  });

  test("a history read folds it in too, not only a snapshot frame", async () => {
    const h = harness();
    stall(h);
    const { held } = await mountUnread(h);

    await deliver(
      h,
      arrival(messageOf({ id: "early-3", blocks: [{ kind: "text", markdown: "early" }] })),
    );
    expect(transcript(held)).toEqual([]);

    // The read that was stalled now answers, and it predates the frame above.
    h.api.fetchHistory = ((instance: string, bot: string) =>
      Promise.resolve({
        instance,
        bot,
        session: "s1",
        messages: [messageOf({ id: "older", blocks: [{ kind: "text", markdown: "older" }] })],
      } as unknown as ChatHistoryResult)) as ChatApi["fetchHistory"];
    await act(async () => {
      await held.store?.reloadHistory();
    });

    expect(transcript(held)).toEqual(["older", "early"]);
  });
});

/* ── the rail, ahead of the roster (Bug C) ───────────────────────────────── */

/** What the rail's badge says for one bot. `null` is "no badge", not a failure. */
function railBadge(name: string): string | null {
  const row = [...document.querySelectorAll<HTMLElement>(".ch-conv")].find(
    (button) => button.querySelector(".ch-conv-name b")?.textContent === name,
  );
  return row?.querySelector(".ch-unread")?.textContent ?? null;
}

describe("the rail moves on the stream, not on the roster's tick", () => {
  test("a message for a bot nobody is reading raises its badge at once", async () => {
    const h = harness();
    h.swarms = [swarmWith("atlas", ["atlas", "beta"])];
    const mounted = await mount(h);
    const reads = h.calls.swarms;
    expect(railBadge("beta")).toBe(null);

    await deliver(
      h,
      arrivalFor(
        { instance: "atlas", bot: "beta", session: "s-beta" },
        messageOf({ id: "beta-1", session: "s-beta" }),
      ),
      { instance: "atlas", bot: "beta", session: "s-beta" },
    );

    // The whole point: no roster read happened, and the badge is already up.
    await waitFor(() => expect(railBadge("beta")).toBe("1"));
    expect(h.calls.swarms).toBe(reads);
    expect(mounted.held.store?.observation.state).toBe("live");
  });

  test("a second message for the same bot counts twice, a replay counts once", async () => {
    const h = harness();
    h.swarms = [swarmWith("atlas", ["atlas", "beta"])];
    await mount(h);
    const beta = { instance: "atlas", bot: "beta", session: "s-beta" };

    await deliver(h, arrivalFor(beta, messageOf({ id: "beta-1", session: "s-beta" })), beta);
    await deliver(h, arrivalFor(beta, messageOf({ id: "beta-2", session: "s-beta" })), beta);
    await waitFor(() => expect(railBadge("beta")).toBe("2"));

    // The fan-in replays across a reconnect, and a replayed frame is not news.
    await deliver(h, arrivalFor(beta, messageOf({ id: "beta-2", session: "s-beta" })), beta);
    await waitFor(() => expect(railBadge("beta")).toBe("2"));
  });

  test("a message in the conversation on screen raises no badge for it", async () => {
    const h = harness();
    h.swarms = [swarmWith("atlas", ["atlas", "beta"])];
    await mount(h);

    await deliver(
      h,
      arrival(
        messageOf({ id: "atlas-live", blocks: [{ kind: "text", markdown: "read as it lands" }] }),
      ),
    );

    await waitFor(() => expect(shown(/read as it lands/)).toBe(1));
    // It is being read while it arrives. Badging the thread the operator is
    // looking at is the one thing this must not do.
    expect(railBadge("atlas")).toBe(null);
    expect(railBadge("beta")).toBe(null);
  });

  test("the operator's own prompt, echoed back by the box, is not unread", async () => {
    const h = harness();
    h.swarms = [swarmWith("atlas", ["atlas", "beta"])];
    await mount(h);
    const beta = { instance: "atlas", bot: "beta", session: "s-beta" };

    await deliver(
      h,
      arrivalFor(beta, messageOf({ id: "beta-user", session: "s-beta", role: "user" })),
      beta,
    );

    await waitFor(() => expect(h.streams).toHaveLength(1));
    expect(railBadge("beta")).toBe(null);
  });

  test("the roster read is authoritative and the local count does not double it", async () => {
    const h = harness();
    h.swarms = [swarmWith("atlas", ["atlas", "beta"])];
    const mounted = await mount(h);
    const beta = { instance: "atlas", bot: "beta", session: "s-beta" };

    await deliver(h, arrivalFor(beta, messageOf({ id: "beta-1", session: "s-beta" })), beta);
    await waitFor(() => expect(railBadge("beta")).toBe("1"));

    // The box has now counted the same message. The read that carries it was
    // decided after the bump, so the bump is spent — not added to it.
    const counted = swarmWith("atlas", ["atlas", "beta"]);
    counted.bots[1] = { ...counted.bots[1], unread: 1 } as (typeof counted.bots)[number];
    h.swarms = [counted];
    await act(async () => {
      await mounted.held.store?.refreshSwarms();
    });

    await waitFor(() => expect(railBadge("beta")).toBe("1"));
  });

  test("opening a badged conversation retracts the badge this browser raised", async () => {
    const h = harness();
    h.swarms = [swarmWith("atlas", ["atlas", "beta"])];
    const mounted = await mount(h);
    const beta = { instance: "atlas", bot: "beta", session: "s-beta" };

    await deliver(h, arrivalFor(beta, messageOf({ id: "beta-1", session: "s-beta" })), beta);
    await waitFor(() => expect(railBadge("beta")).toBe("1"));

    await act(async () => {
      mounted.held.store?.select("atlas", "beta");
    });
    await waitFor(() => expect(railBadge("beta")).toBe(null));
  });
});

/* ── resuming one conversation, not the whole box (Bug D) ────────────────── */

describe("a resume names one conversation", () => {
  async function failed(h: Harness) {
    const mounted = await mount(h);
    await deliver(h, {
      type: "error",
      instance: "atlas",
      bot: "atlas",
      code: "CHAT_OBSERVE_FAILED",
      message: "the retry budget was spent",
    } as unknown as ChatObserveView);
    await screen.findByText(/no longer being watched/);
    return mounted;
  }

  test("the targeted route is asked once, with this thread's own session", async () => {
    const h = harness();
    const mounted = await failed(h);
    const reads = h.calls.history;

    await userEvent.click(screen.getByRole("button", { name: "Watch again" }));

    await waitFor(() => expect(h.resumes).toHaveLength(1));
    // One conversation, named in the path. A listen write would have made the
    // server reconcile the whole box — nine observations for one click.
    expect(h.resumes[0]).toEqual({ instance: "atlas", bot: "atlas", session: null });
    await waitFor(() => expect(h.calls.history).toBeGreaterThan(reads));
    await waitFor(() => expect(mounted.held.store?.observation.state).toBe("live"));
  });

  test("a box nobody listens to is said out loud, not resumed behind the operator", async () => {
    const h = harness();
    h.resumeAnswer = { observing: false, listening: false };
    const mounted = await failed(h);
    const reads = h.calls.history;

    await userEvent.click(screen.getByRole("button", { name: "Watch again" }));

    await waitFor(() => expect(shown(/not listening to atlas/)).toBe(1));
    expect(mounted.held.store?.observation.state).toBe("failed");
    expect(mounted.held.store?.observation.error?.code).toBe("OBSERVE_NOT_LISTENING");
    // Nothing is re-read, and no listen preference is written from here.
    expect(h.calls.history).toBe(reads);
  });
});

/* ── a watch that degraded to polling is not a broken one ────────────────── */

describe("the reconnecting advisory", () => {
  test("decays back to live when nothing further is said", async () => {
    const h = harness();
    const mounted = await mount(h);
    jest.useFakeTimers();

    act(() => {
      h.streams[0]?.onFrame(ATLAS, {
        type: "reconnect",
        instance: "atlas",
        bot: "atlas",
        attempt: 1,
      } as unknown as ChatObserveView);
    });
    expect(mounted.held.store?.observation.state).toBe("reconnecting");

    // The upstream hint stream ended and the server degraded to polling. It is
    // healthy, and this conversation simply has nothing to say — which must not
    // read as "reconnecting" for as long as the quiet lasts.
    act(() => {
      jest.advanceTimersByTime(OBSERVE_QUIET_MS + 1);
    });

    expect(mounted.held.store?.observation.state).toBe("live");
    expect(shown(/Reconnecting to this conversation/)).toBe(0);
  });

  test("a retry that keeps saying so keeps the band up", async () => {
    const h = harness();
    const mounted = await mount(h);
    jest.useFakeTimers();
    const advisory = (attempt: number) =>
      act(() => {
        h.streams[0]?.onFrame(ATLAS, {
          type: "reconnect",
          instance: "atlas",
          bot: "atlas",
          attempt,
        } as unknown as ChatObserveView);
      });

    advisory(1);
    act(() => {
      jest.advanceTimersByTime(OBSERVE_QUIET_MS - 1);
    });
    advisory(2);
    act(() => {
      jest.advanceTimersByTime(OBSERVE_QUIET_MS - 1);
    });

    expect(mounted.held.store?.observation.state).toBe("reconnecting");
    expect(mounted.held.store?.observation.attempt).toBe(2);
  });
});
