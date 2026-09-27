/**
 * What a second message does while the first turn is still running.
 *
 * §9.2 gives a conversation one active turn and says sending waits. A composer
 * that refuses the keystroke makes the operator hold the thought instead; a
 * composer that sends anyway hands the box a mid-turn interruption it will
 * queue, redirect or steer depending on a busy-mode nobody here chose. So the
 * portal holds it: the button becomes Queue, the message sits above the input,
 * and it goes out by itself the moment the turn ends.
 *
 * The two rules that are not obvious are both about *not* sending. Stopping a
 * turn parks the queue rather than draining it — an operator who just
 * interrupted the agent did not thereby authorise firing the backlog at it —
 * and a failed turn parks for the same reason. Nothing is ever dropped; the
 * rows stay, and the next deliberate send releases them.
 *
 * The second half of this file is about a frame arriving twice. Server
 * requests are unsequenced, so a reattach replays the outstanding approval,
 * and a transcript that appends on replay asks the same question twice with no
 * way to tell which card is live.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "./dom.ts";
import { ChatProvider, applyFrame, useChat } from "../src/chat/chat-state.tsx";
import type { Chat, ChatApi } from "../src/chat/chat-state.tsx";
import type { ChatBlockView, ChatFrameView, ChatTurnHandlers } from "../src/api/index.ts";
import { Composer } from "../src/chat/components/Composer.tsx";

afterEach(cleanup);

function setup() {
  let current!: Chat;
  const turns: ChatTurnHandlers[] = [];
  /** Every prompt this browser actually put on the wire, in order. */
  const sent: string[] = [];
  let aborts = 0;
  /** A never-answered abort, so `aborting` — which refuses a send — is observable. */
  let abortHangs = false;

  const api: ChatApi = {
    fetchSwarms: async () => ({ swarms: [] }) as never,
    fetchSessions: async () =>
      ({
        sessions: [
          { id: "S", instance: "atlas", bot: "default", origin: "portal", origin_detail: null },
        ],
      }) as never,
    fetchHistory: async () =>
      ({ instance: "atlas", bot: "default", session: "S", messages: [] }) as never,
    sendTurn: (_instance, _bot, text, handlers) => {
      sent.push(text);
      turns.push(handlers);
      return () => {};
    },
    abortTurn: async () => {
      aborts += 1;
      if (abortHangs) await new Promise<void>(() => {});
      return { aborted: true } as never;
    },
  };

  function Harness() {
    current = useChat();
    return (
      <>
        <button type="button" onClick={() => current.select("atlas", "default", null)}>
          pick
        </button>
        <button type="button" onClick={() => current.select("atlas", "default", "other")}>
          pick other
        </button>
        <Composer
          destination={{ state: "known", origin: "portal", detail: null }}
          placeholder="Message…"
          enabled
          sending={current.sending}
          onSend={current.send}
          onAbort={current.abort}
        />
      </>
    );
  }

  render(
    <ChatProvider api={api} eager={false}>
      <Harness />
    </ChatProvider>,
  );

  const input = () => screen.getByLabelText("Message…") as HTMLTextAreaElement;
  const type = (text: string) => fireEvent.change(input(), { target: { value: text } });
  const enter = () => fireEvent.keyDown(input(), { key: "Enter" });
  return {
    get current() {
      return current;
    },
    get aborts() {
      return aborts;
    },
    sent,
    turns,
    input,
    type,
    enter,
    open: async (label = "pick") => {
      fireEvent.click(screen.getByRole("button", { name: label }));
      await waitFor(() => expect(current.historyRead).toBe(true));
    },
    hangAborts: () => {
      abortHangs = true;
    },
    // Inside `act`: the park a refused send schedules is a state update, and
    // one that landed outside `act` would surface as a warning, not a render.
    settle: () =>
      act(async () => {
        await new Promise((done) => setTimeout(done, 30));
      }),
    say: async (text: string) => {
      type(text);
      enter();
    },
    rows: () => document.querySelectorAll(".ch-queue-row"),
    foot: () => document.querySelector(".ch-queue-foot")?.textContent ?? "",
    send: () => document.querySelector(".ch-send") as HTMLButtonElement,
    end: async (ok = true) => {
      await act(async () => {
        turns[turns.length - 1]?.onEnd(ok, null);
      });
    },
  };
}

/** A turn in flight, with one message already queued behind it. */
async function queuedBehindATurn() {
  const h = setup();
  await h.open();
  await h.say("first");
  await waitFor(() => expect(h.current.sending).toBe(true));
  await h.say("second");
  await waitFor(() => expect(h.rows()).toHaveLength(1));
  return h;
}

describe("the send queue", () => {
  test("Enter while a turn runs queues the message instead of sending it", async () => {
    const h = await queuedBehindATurn();
    // One row above the composer, one prompt on the wire: the second message
    // is held, not fired at a session that is mid-turn.
    expect(h.rows()).toHaveLength(1);
    expect(h.rows()[0]?.textContent).toContain("second");
    expect(h.sent).toEqual(["first"]);
    // And it left the input, so pressing Enter again cannot double it.
    expect(h.input().value).toBe("");
  });

  test("the Send button becomes Queue while the turn is in flight, and stays live", async () => {
    const h = setup();
    await h.open();
    await h.say("first");
    await waitFor(() => expect(h.current.sending).toBe(true));
    h.type("second");
    await waitFor(() => expect(h.send().disabled).toBe(false));
    expect(h.send().title).toBe("Queue (⌘↵ or Enter)");
    fireEvent.click(h.send());
    await waitFor(() => expect(h.rows()).toHaveLength(1));
    expect(h.sent).toEqual(["first"]);
  });

  test("the end of a turn drains exactly one queued message", async () => {
    const h = await queuedBehindATurn();
    await h.say("third");
    await waitFor(() => expect(h.rows()).toHaveLength(2));

    await h.end();

    // One goes out, in order, and its row leaves with it. The other waits for
    // the turn it just started — the box runs one at a time.
    await waitFor(() => expect(h.sent).toEqual(["first", "second"]));
    await waitFor(() => expect(h.rows()).toHaveLength(1));
    expect(h.rows()[0]?.textContent).toContain("third");
    expect(h.turns).toHaveLength(2);

    await h.end();
    await waitFor(() => expect(h.sent).toEqual(["first", "second", "third"]));
    await waitFor(() => expect(h.rows()).toHaveLength(0));
  });

  test("stopping the turn parks the queue rather than draining it", async () => {
    const h = await queuedBehindATurn();

    fireEvent.keyDown(h.input(), { key: "Escape" });
    await waitFor(() => expect(h.aborts).toBe(1));
    await waitFor(() => expect(h.current.sending).toBe(false));

    // The interrupted agent is not handed the backlog, and the backlog is not
    // thrown away either: the row is still there to send or to remove.
    await new Promise((done) => setTimeout(done, 20));
    expect(h.sent).toEqual(["first"]);
    expect(h.rows()).toHaveLength(1);

    // A deliberate send is what says "carry on", and the parked queue follows.
    await h.say("after the stop");
    await waitFor(() => expect(h.sent).toEqual(["first", "after the stop"]));
    await h.end();
    await waitFor(() => expect(h.sent).toEqual(["first", "after the stop", "second"]));
  });

  test("a turn that dropped parks the queue instead of draining into a re-read", async () => {
    const h = await queuedBehindATurn();

    // The socket died: `end(false, null)` — no error to show, `sending` false,
    // and the transcript being read again behind a band. It looks idle and it
    // is not, and a queued message must not land in the middle of it.
    await h.end(false);
    await waitFor(() => expect(h.current.reconnecting).toBe(true));
    await h.settle();
    expect(h.sent).toEqual(["first"]);
    expect(h.rows()).toHaveLength(1);

    // Still parked once the re-read has finished, because nothing since has
    // said to carry on.
    await waitFor(() => expect(h.current.reconnecting).toBe(false), { timeout: 4000 });
    await h.settle();
    expect(h.sent).toEqual(["first"]);
    expect(h.rows()).toHaveLength(1);
  });

  test("a send the store refuses keeps its row rather than destroying the message", async () => {
    const h = setup();
    await h.open();
    // An abort with no answer leaves the conversation `aborting`, which is one
    // of the states the store's own `send` returns from without a word. The
    // deliberate send in between is only there to clear the park that stopping
    // put on the queue, so that the drain really is what gets refused.
    h.hangAborts();
    await act(async () => {
      void h.current.abort();
    });
    await waitFor(() => expect(h.aborts).toBe(1));
    await act(async () => {
      h.current.send("cleared the park");
    });
    await act(async () => {
      h.current.queueMessage("must not be lost");
    });

    await h.settle();
    expect(h.sent).toEqual([]);
    expect(h.rows()).toHaveLength(1);
    expect(h.rows()[0]?.textContent).toContain("must not be lost");
  });

  test("a queue left behind does not fire by itself when the thread is re-opened", async () => {
    const h = await queuedBehindATurn();

    await h.open("pick other");
    expect(h.rows()).toHaveLength(0);
    await h.end();
    await h.open();

    // The backlog is still there, still the operator's to send or to remove —
    // and it did not go out because they came back to read the thread.
    await h.settle();
    expect(h.rows()).toHaveLength(1);
    expect(h.sent).toEqual(["first"]);

    await h.say("carry on");
    await waitFor(() => expect(h.sent).toEqual(["first", "carry on"]));
    await h.end();
    await waitFor(() => expect(h.sent).toEqual(["first", "carry on", "second"]));
  });

  test("a parked queue says so, and stops saying so when it is released", async () => {
    const h = await queuedBehindATurn();
    expect(h.foot()).toContain("1 queued");
    expect(h.foot()).toContain("sends when the agent is free");

    fireEvent.keyDown(h.input(), { key: "Escape" });
    await waitFor(() => expect(h.current.sending).toBe(false));

    // The rows look identical whether they are waiting or being held, so the
    // difference has to be said: a stopped turn will not drain them.
    await waitFor(() => expect(h.foot()).toContain("paused"));
    expect(h.current.queueParked).toBe(true);

    await h.say("carry on");
    await waitFor(() => expect(h.current.sending).toBe(true));
    expect(h.foot()).not.toContain("paused");
    expect(h.current.queueParked).toBe(false);
  });

  test("a queued message can be taken back before it goes out", async () => {
    const h = await queuedBehindATurn();
    fireEvent.click(screen.getByRole("button", { name: "Remove queued message" }));
    await waitFor(() => expect(h.rows()).toHaveLength(0));

    await h.end();
    await new Promise((done) => setTimeout(done, 20));
    expect(h.sent).toEqual(["first"]);
  });
});

/* ── redelivered server requests ─────────────────────────────────────────── */

const block = (value: Record<string, unknown>): ChatBlockView => value as unknown as ChatBlockView;
const frame = (value: Record<string, unknown>): ChatFrameView =>
  ({ type: "block", seq: 0, message: "m1", block: block(value) }) as ChatFrameView;
const seed = { session: "S", at: "2026-09-19T12:00:00Z" };

function fold(...blocks: Record<string, unknown>[]) {
  let live = null;
  for (const value of blocks) live = applyFrame(live, frame(value), seed);
  return live?.blocks ?? [];
}

describe("an unsequenced server request arriving twice", () => {
  const approval = { kind: "approval", tool: "bash", summary: "rm -rf /data", request_id: "r1" };
  const ask = (prompt: string, request_id = "r2") => ({
    kind: "question",
    prompt,
    choices: ["yes", "no"],
    request_id,
  });

  test("the same approval replaces its card instead of appending a second", () => {
    const blocks = fold(approval, { ...approval, summary: "rm -rf /data (retried)" });
    expect(blocks).toHaveLength(1);
    // The replay wins: it is the box's current view of a request still open.
    expect(blocks[0]).toMatchObject({ summary: "rm -rf /data (retried)" });
  });

  test("two questions of one batch are two cards, and a replay of one is still two", () => {
    const first = ask("Which box?");
    const second = ask("Which fleet?");
    expect(fold(first, second)).toHaveLength(2);
    const blocks = fold(first, second, first);
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => (b.kind === "question" ? b.prompt : ""))).toEqual([
      "Which box?",
      "Which fleet?",
    ]);
  });

  test("the same question under two request ids stays two cards", () => {
    expect(fold(ask("Which box?", "r2"), ask("Which box?", "r3"))).toHaveLength(2);
  });

  test("a request with no id appends, because there is nothing to key it on", () => {
    const anonymous = { kind: "approval", tool: "bash", summary: "ls", request_id: null };
    expect(fold(anonymous, anonymous)).toHaveLength(2);
  });
});
