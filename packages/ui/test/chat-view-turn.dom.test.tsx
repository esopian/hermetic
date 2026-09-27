/**
 * The chat view, driven: a turn, and the reconnect under it.
 *
 * Split from `chat-view.dom.test.tsx`, which keeps the rail, banners and
 * states; the harness is shared (`chat-fixtures.tsx`). The behaviour worth
 * calling out by name:
 *
 * **The reconnect path re-reads and never merges** (§9.2).
 * The browser's own stream dropping mid-turn must throw the half-built message
 * away and read the transcript again from the box, because the box is
 * authoritative and anything held here is a cache that is allowed to be wrong.
 * Merging would look like it works, which is why it is worth a test rather
 * than a comment. The drop below this one — the portal's socket to the box —
 * is continued from a cursor in core instead (§9.2) and only reaches these
 * tests once core has given up, as an ordinary `done incomplete`.
 */
import { act, cleanup, fireEvent, render, screen, userEvent, waitFor, within } from "./dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import type { ChatBlockView, ChatFrameView, ChatTurnHandlers } from "../src/api/index.ts";
import { ChatProvider, reconnectDelayMs, useChat } from "../src/chat/chat-state.tsx";
import type { Chat } from "../src/chat/chat-state.tsx";
import { harness, messageOf, mount, sendable, swarmOf } from "./chat-fixtures.tsx";
import type { Turn } from "./chat-fixtures.tsx";

afterEach(cleanup);

// The avatar entrance tween is left to run here. It used to be skipped by a
// module-scope `document.hidden` patch, and `setup.ts` owns that property now
// — owning it means `visibilityState` agrees with it, so a hidden page also
// stops the roster read every test below is built on. Measured both ways: the
// file is green and no slower with the tween left alone.

/* ── the turn, and the reconnect ─────────────────────────────────────────── */

describe("a turn", () => {
  test("the operator's message appears immediately and the stream is opened", async () => {
    const h = harness();
    const { container } = mount(h);
    await userEvent.type(await sendable(container), "how is /data?");
    await userEvent.click(screen.getByTitle(/Send/));

    expect(h.calls.send).toBe(1);
    expect(screen.getByText("how is /data?")).toBeDefined();
  });

  test("frames assemble into a live message, and a clean `done` re-reads the box", async () => {
    const h = harness();
    const { container } = mount(h);
    await userEvent.type(await sendable(container), "hello");
    await userEvent.click(screen.getByTitle(/Send/));

    const turn = h.turn as ChatTurnHandlers;
    await act(async () => {
      turn.onFrame({ type: "delta", seq: 1, message: "m2", text: "partial answ" } as ChatFrameView);
    });
    expect(screen.getByText(/partial answ/)).toBeDefined();

    const before = h.calls.history;
    await act(async () => {
      turn.onFrame({ type: "done", seq: 2, message: "m2" } as ChatFrameView);
      turn.onEnd(true, null);
    });
    // Even a clean turn re-reads: the box is what is true, and the assembled
    // message is only a copy of what the box already wrote down.
    await waitFor(() => expect(h.calls.history).toBe(before + 1));
  });

  test("a dropped stream re-reads and does NOT merge the half-built turn", async () => {
    // §9.2, and the reason it is in the risk register: merging looks
    // like it works. The assembled fragment must be gone after the re-read,
    // replaced by the box's copy rather than sitting above or beside it.
    const h = harness();
    const { container } = mount(h);
    await userEvent.type(await sendable(container), "hello");
    await userEvent.click(screen.getByTitle(/Send/));

    const turn = h.turn as ChatTurnHandlers;
    await act(async () => {
      turn.onFrame({
        type: "delta",
        seq: 1,
        message: "m2",
        text: "I'll start by listing the largest subtrees so you can see what gets remo",
      } as ChatFrameView);
    });
    expect(screen.getByText(/gets remo/)).toBeDefined();

    // The box's own copy of the turn, complete, as a reconnect would read it.
    h.defaultHistory = [
      messageOf({
        id: "m2",
        blocks: [
          { kind: "text", markdown: "I'll start by listing the largest subtrees, all of them." },
        ],
      }),
    ];
    const before = h.calls.history;
    await act(async () => {
      turn.onEnd(false, null);
    });

    await waitFor(() => expect(h.calls.history).toBe(before + 1));
    await waitFor(() => expect(screen.queryByText(/gets remo/)).toBeNull());
    expect(screen.getByText(/all of them/)).toBeDefined();
  });

  test("a dropped stream the box never wrote down keeps the partial, marked incomplete", async () => {
    // The other half of the re-read rule (§9.2). Re-reading is right and
    // merging is wrong, but *discarding* is wrong too: when the box's copy does
    // not contain the turn — it died before it could write one, or the
    // transcript has not caught up — the fragment on screen is the only copy of
    // the answer anybody has. It is kept outside the cached transcript and
    // marked as cut off, which is what `incomplete` renders.
    const h = harness();
    const { container } = mount(h);
    await userEvent.type(await sendable(container), "hello");
    await userEvent.click(screen.getByTitle(/Send/));

    const turn = h.turn as ChatTurnHandlers;
    await act(async () => {
      turn.onFrame({
        type: "delta",
        seq: 1,
        message: "m2",
        text: "38 GiB older than 30 days. I'll list the largest subtrees so you can see what gets remo",
      } as ChatFrameView);
    });

    // The box answers, and nothing it has is newer than the start of this turn:
    // it died before it wrote the reply down, or its transcript has not caught
    // up. Deliberately not "the ids differ" — that is true either way.
    h.defaultHistory = [messageOf({ id: "20260916_114000_zz99yy", at: "2026-09-16T11:40:00Z" })];
    const before = h.calls.history;
    await act(async () => {
      turn.onEnd(false, null);
    });
    await waitFor(() => expect(h.calls.history).toBe(before + 1));

    // Still there, and now saying so.
    expect(screen.getByText(/gets remo/)).toBeDefined();
    await waitFor(() => expect(screen.getAllByText(/incomplete/i).length).toBeGreaterThan(0));
  });

  test("the same drop, once the box has the turn, hands over — across two id namespaces", async () => {
    /**
     * The reconciliation, with the namespace mismatch *in* the test rather than
     * assumed away.
     *
     * A frame's `message` id is minted by the adapter for the life of one
     * stream — `<instance>:<timestamp>` — while a transcript row carries
     * whatever upstream stored. The two can never be equal, so an
     * id-to-id match is a condition that is false forever: the complete reply
     * would land in the transcript, the fragment would stay below it labelled
     * "cut off", and the answer would render twice until the operator switched
     * threads. Hence the test is on what both copies do agree about — the box
     * has a message that is not the operator's own and is at least as new as
     * the moment the turn started.
     */
    const h = harness();
    const { container } = mount(h);
    const startedAt = Date.now();
    await userEvent.type(await sendable(container), "hello");
    await userEvent.click(screen.getByTitle(/Send/));

    const turn = h.turn as ChatTurnHandlers;
    await act(async () => {
      turn.onFrame({
        // The adapter's own mint (`hermes-chat.ts`), not a transcript id.
        type: "delta",
        seq: 1,
        message: `atlas:${new Date(startedAt).toISOString()}`,
        text: "half a sent",
      } as ChatFrameView);
    });

    // What the box stored: upstream's row id, and its own timestamp.
    h.defaultHistory = [
      messageOf({
        id: "20260916_115000_aa11bb",
        at: new Date(startedAt + 1_000).toISOString(),
        blocks: [{ kind: "text", markdown: "half a sentence, whole" }],
      }),
    ];
    await act(async () => {
      turn.onEnd(false, null);
    });

    await waitFor(() => expect(screen.getAllByText(/whole/)).toHaveLength(1));
    // The fragment is gone, and nothing is labelled cut off.
    expect(screen.queryByText(/half a sent$/)).toBeNull();
    expect(screen.queryByText(/incomplete/i)).toBeNull();
  });

  test("the first re-read is immediate and later ones back off", () => {
    // The curve is a pure function so the shape can be asserted without four
    // real timers. The first entry is the one that matters: a socket that drops
    // because the turn already finished is the common case, and a second of
    // "reconnecting…" before asking would be a second of lying.
    expect(reconnectDelayMs(1)).toBe(0);
    expect(reconnectDelayMs(2)).toBe(1_000);
    expect(reconnectDelayMs(3)).toBe(2_000);
    // Past the end of the table it holds rather than growing.
    expect(reconnectDelayMs(9)).toBe(8_000);
  });

  test("a second turn during a reconnect is not wiped by the re-read it interrupted", async () => {
    /**
     * Cancelling the reconnect's *timer* does not stop a fetch that has already
     * gone out. It lands seconds later and commits against the turn that has
     * since started — `setMessages` erasing the optimistic user message,
     * `setLive` wiping the new turn's accumulated text — for a window of up to
     * the whole backoff plus a round trip.
     *
     * Driven against the store rather than through the composer, because the
     * composer is deliberately disabled while a thread is in the `dropped`
     * state. The window is still reachable — a box that is still bootstrapping
     * keeps an enabled composer through a reconnect (`threadState` ranks
     * `bootstrapping` above it), and Phase 8's entry points call `send` without
     * a composer at all — and it is the store's invariant either way.
     */
    const h = harness();
    // A holder rather than a bare `let`, so the compiler does not narrow a
    // variable only ever assigned from inside a component it cannot see called.
    // Captured on every render, so the test always holds the current store.
    const held: { store: Chat | null } = { store: null };
    function Probe() {
      held.store = useChat();
      return null;
    }
    render(
      <ChatProvider api={h.api}>
        <Probe />
      </ChatProvider>,
    );
    await waitFor(() => expect(held.store?.selection).not.toBeNull());
    await waitFor(() => expect(held.store?.historyRead).toBe(true));

    await act(async () => {
      (held.store as Chat).send("first");
    });
    await act(async () => {
      (h.turn as ChatTurnHandlers).onFrame({
        type: "delta",
        seq: 1,
        message: "t1",
        text: "cut off here",
      } as ChatFrameView);
    });

    // Drop the stream, and hold the reconnect's transcript read open.
    h.historyMode = "hang";
    await act(async () => {
      (h.turn as ChatTurnHandlers).onEnd(false, null);
    });
    await waitFor(() => expect(h.releaseHistory).not.toBeNull());

    // A second turn starts while that read is still in flight.
    h.historyMode = "resolve";
    await act(async () => {
      (held.store as Chat).send("second");
    });
    await act(async () => {
      (h.turn as ChatTurnHandlers).onFrame({
        type: "delta",
        seq: 1,
        message: "t2",
        text: "the new answer",
      } as ChatFrameView);
    });

    // The stale read lands.
    await act(async () => {
      h.releaseHistory?.();
      await Promise.resolve();
    });

    // Both halves of the new turn survive it.
    const sent = (held.store as Chat).messages.filter((m) => m.role === "user");
    expect(sent.some((m) => JSON.stringify(m.blocks).includes("second"))).toBe(true);
    expect(JSON.stringify((held.store as Chat).live?.blocks ?? [])).toContain("the new answer");
  });

  test("an error frame names the code on a card rather than dropping the turn", async () => {
    const h = harness();
    h.defaultHistory = [messageOf({ id: "m2", error: "CHAT_NO_SLOT", incomplete: true })];
    const { container } = mount(h);
    await userEvent.type(await sendable(container), "hello");
    await userEvent.click(screen.getByTitle(/Send/));

    await act(async () => {
      (h.turn as ChatTurnHandlers).onEnd(false, { code: "CHAT_NO_SLOT", message: "no warm slot" });
    });
    await waitFor(() => expect(screen.getByText("CHAT_NO_SLOT")).toBeDefined());
    expect(screen.getByText(/no warm backend/)).toBeDefined();
  });
});

/* ── the three the review named ──────────────────────────────────────────── */

describe("two consecutive turns in one session", () => {
  test("Enter keeps draft focus through streaming and the completion destination refresh", async () => {
    const h = harness();
    const { container } = mount(h);
    const input = await sendable(container);
    await userEvent.type(input, "first{Enter}next draft");
    expect(h.turns[0]!.message).toBe("first");
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("next draft");

    // Enter while the turn runs *queues* (§9.2: one active turn, sending
    // waits). Nothing goes on the wire, the caret stays where it was, and the
    // draft leaves the box because the operator is done with that text —
    // finding it still there is how the same message gets sent twice.
    await userEvent.keyboard("{Enter}");
    expect(h.calls.send).toBe(1);
    expect(input.value).toBe("");
    expect(document.querySelectorAll(".ch-queue-row")).toHaveLength(1);
    expect(document.querySelector(".ch-queue-row")?.textContent).toContain("next draft");
    expect(document.activeElement).toBe(input);

    // The turn ends and the queue drains it: one send, in order, and the row
    // goes with it. The destination read behind it is still hanging, which is
    // the case this test exists for.
    h.sessionsMode = "hang";
    await act(async () => h.turns[0]!.handlers.onEnd(true, null));
    expect(h.releaseSessions).not.toBeNull();
    expect(h.calls.send).toBe(2);
    expect(h.turns[1]!.message).toBe("next draft");
    expect(document.querySelectorAll(".ch-queue-row")).toHaveLength(0);
    expect(input.disabled).toBe(false);
    expect(document.activeElement).toBe(input);

    // A half-typed draft is still not blanked by an Enter that cannot send:
    // the destination is unresolved, so the composer is disabled and the key
    // neither sends nor queues.
    await userEvent.keyboard(" continued{Enter}");
    expect(input.value).toBe(" continued");
    expect(h.calls.send).toBe(2);
    expect(document.querySelectorAll(".ch-queue-row")).toHaveLength(0);
    expect((screen.getByTitle(/Send/) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => h.releaseSessions?.());
    expect(document.activeElement).toBe(input);
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}new line");
    expect(input.value).toBe(" continued\nnew line");
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(h.calls.send).toBe(2);
    expect(input.value).toBe(" continued\nnew line");

    // The drained turn ends with the destination reads answering again, so the
    // composer is live and Enter means Enter.
    h.sessionsMode = "resolve";
    await act(async () => h.turns[1]!.handlers.onEnd(true, null));
    await waitFor(() => expect((screen.getByTitle(/Send/) as HTMLButtonElement).disabled).toBe(false));
    expect(document.activeElement).toBe(input);
    await userEvent.keyboard("{Enter}");
    expect(h.turns[2]!.message).toBe("continued\nnew line");
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("");
  });

  test("turn two gets its own bubble and the box's copy of turn one appears once", async () => {
    // The defect this catches: `live` survived a clean `done`, so turn two's
    // first frame folded into turn one's message — same id, blocks appended —
    // and rendered inside turn one's bubble, while the box's copy of turn one
    // was already in `messages` under that same id. Two rows, one React key.
    //
    // The assertions are on the *streamed* fragment rather than on the box's
    // wording, because those are the two things that must never be on screen
    // together: once the box has answered, the assembled copy is gone.
    const h = harness();
    const { container } = mount(h);
    const input = await sendable(container);

    await userEvent.type(input, "first");
    await userEvent.click(screen.getByTitle(/Send/));
    const first = h.turns[0] as Turn;
    await act(async () => {
      first.handlers.onFrame({ type: "delta", seq: 1, message: "m2", text: "TURN-ONE-STREAMED" });
      first.handlers.onFrame({ type: "done", seq: 2, message: "m2" });
    });
    expect(screen.getByText(/TURN-ONE-STREAMED/)).toBeDefined();

    h.defaultHistory = [
      messageOf({ id: "m2", blocks: [{ kind: "text", markdown: "TURN-ONE-FROM-BOX" }] }),
    ];
    await act(async () => {
      first.handlers.onEnd(true, null);
    });
    // Scoped to the thread: the rail legitimately quotes the reply as its
    // preview, so the whole document holds the text twice.
    const thread = () => within(container.querySelector(".ch-log")!);
    await waitFor(() => expect(thread().getByText("TURN-ONE-FROM-BOX")).toBeDefined());
    // The assembled copy is gone rather than sitting beside the box's under the
    // same id. This is the assertion the bug fails.
    // `outerHTML` so a failure prints one line, not a happy-dom node.
    expect(thread().queryByText(/TURN-ONE-STREAMED/)?.outerHTML ?? null).toBeNull();
    expect(thread().queryAllByText("TURN-ONE-FROM-BOX")).toHaveLength(1);

    await userEvent.type(input, "second");
    await userEvent.click(screen.getByTitle(/Send/));
    const second = h.turns[1] as Turn;
    expect(second.message).toBe("second");
    await act(async () => {
      second.handlers.onFrame({ type: "delta", seq: 1, message: "m3", text: "TURN-TWO-STREAMED" });
    });

    const bubbles = [...container.querySelectorAll(".ch-msg")].map((n) => n.textContent ?? "");
    const withTwo = bubbles.filter((t) => t.includes("TURN-TWO-STREAMED"));
    expect(withTwo).toHaveLength(1);
    // Turn two in a bubble of its own: not folded into turn one's message, and
    // not sharing a row with the box's copy of it.
    expect(withTwo[0]).not.toContain("TURN-ONE-STREAMED");
    expect(withTwo[0]).not.toContain("TURN-ONE-FROM-BOX");
    expect(bubbles.filter((t) => t.includes("TURN-ONE-FROM-BOX"))).toHaveLength(1);
  });

  test("a frame replayed at or below the last `seq` does not append its text twice", async () => {
    // `seq` is upstream's own ordering and a `delta` is an append, so a frame
    // delivered twice used to leave a stutter in the transcript that nothing
    // downstream could explain.
    const h = harness();
    const { container } = mount(h);
    await userEvent.type(await sendable(container), "hello");
    await userEvent.click(screen.getByTitle(/Send/));
    const turn = h.turns[0] as Turn;
    await act(async () => {
      turn.handlers.onFrame({ type: "delta", seq: 1, message: "m2", text: "ONCE" });
      turn.handlers.onFrame({ type: "delta", seq: 1, message: "m2", text: "ONCE" });
      turn.handlers.onFrame({ type: "delta", seq: 0, message: "m2", text: "ONCE" });
    });
    const live = [...container.querySelectorAll(".ch-msg")]
      .map((n) => n.textContent ?? "")
      .find((t) => t.includes("ONCE")) as string;
    expect(live.match(/ONCE/g)).toHaveLength(1);
  });
});

test("completed tool calls remain expandable after durable replacement, revisiting and reload", async () => {
  const h = harness({ swarms: [swarmOf("atlas"), swarmOf("granite")] });
  h.history["granite/granite"] = [];
  const tool: ChatBlockView = {
    kind: "tool",
    tool_id: "call_FIXTURE_completed",
    name: "terminal",
    server: null,
    args: { command: "printf [redacted]" },
    result: { output: "FIXTURE tool output", exit_code: 0 },
    status: "ok",
    render: "terminal",
    exit_code: 0,
    duration_ms: 12,
  };
  let root = mount(h);
  await userEvent.type(await sendable(root.container), "Run the fixture command");
  await userEvent.click(screen.getByTitle(/Send/));
  const turn = h.turns[0]!;
  await act(async () => {
    turn.handlers.onFrame({
      type: "block",
      seq: 1,
      message: "live-reply",
      block: { ...tool, status: "running", result: null },
    });
    turn.handlers.onFrame({ type: "block", seq: 2, message: "live-reply", block: tool });
    turn.handlers.onFrame({ type: "delta", seq: 3, message: "live-reply", text: "Fixture answer" });
  });
  expect(root.container.querySelectorAll(".ch-activity-step")).toHaveLength(1);

  // Hermes stores a separate system tool-result row. Its durable ID differs
  // from the live message ID, so this verifies the actual replacement lifecycle.
  h.defaultHistory = [
    messageOf({ id: "stored:56", role: "system", blocks: [tool] }),
    messageOf({ id: "stored:57", blocks: [{ kind: "text", markdown: "Fixture answer" }] }),
  ];
  await act(async () => {
    turn.handlers.onFrame({ type: "done", seq: 4, message: "live-reply", usage: null });
    turn.handlers.onEnd(true, null);
  });

  async function expandStoredTool() {
    await waitFor(() =>
      // The tool row and the prose row are one turn, addressed by the last id.
      expect(root.container.querySelector('[data-chat-message="stored:57"]')).not.toBeNull(),
    );
    const group = root.container.querySelector<HTMLDetailsElement>(".ch-activity")!;
    const step = group.querySelector<HTMLDetailsElement>(".ch-activity-step")!;
    expect(group.open).toBe(false);
    expect(step.open).toBe(false);
    expect(group.querySelector("summary")?.textContent).toContain("Tools complete");
    await userEvent.click(group.querySelector("summary")!);
    expect(group.open).toBe(true);
    await userEvent.click(step.querySelector("summary")!);
    expect(group.open).toBe(true);
    expect(step.open).toBe(true);
    // The durable turn and the assembled copy overlap for a commit; the counts
    // below are about what is left once the replacement has actually happened.
    await waitFor(() =>
      expect(
        root.container.querySelector('[data-chat-message="live-reply"]')?.outerHTML ?? null,
      ).toBeNull(),
    );
    expect(step.textContent).toContain("Arguments");
    expect(step.textContent).toContain("printf [redacted]");
    expect(step.textContent).toContain("Result");
    expect(step.textContent).toContain("FIXTURE tool output");
    expect(step.querySelectorAll(".ch-redacted").length).toBeGreaterThan(0);
    expect(root.container.querySelectorAll(".ch-activity-step")).toHaveLength(1);
    // Counted in the transcript, not in the document: the rail now previews the
    // conversation's last message, so the answer legitimately appears there too.
    // What must not happen twice is the turn itself — the assembled live copy
    // and the durable one both drawn.
    expect(
      [...root.container.querySelectorAll(".ch-msg-body")].filter((el) =>
        el.textContent?.includes("Fixture answer"),
      ),
    ).toHaveLength(1);
    expect(
      root.container.querySelector('[data-chat-message="live-reply"]')?.outerHTML ?? null,
    ).toBeNull();
  }
  await expandStoredTool();
  const choose = async (name: string) => {
    const row = [...root.container.querySelectorAll<HTMLButtonElement>(".ch-conv")].find((button) =>
      button.textContent?.includes(name),
    )!;
    await userEvent.click(row);
    await sendable(root.container);
  };
  await choose("granite");
  expect(root.container.querySelector(".ch-activity")).toBeNull();
  await choose("atlas");
  await expandStoredTool();

  // A fresh provider has no browser-assembled reply to fall back to. Reopening
  // therefore proves that the stored tool is sufficient for both disclosures.
  root.unmount();
  root = mount(h);
  await sendable(root.container);
  await expandStoredTool();
  expect(h.calls.send).toBe(1);
});

describe("switching bot while a turn is in flight", () => {
  test("switching keeps the original pipe alive and displays the selected transcript", async () => {
    const h = harness({
      swarms: [swarmOf("ember"), swarmOf("granite")],
    });
    h.history["ember/ember"] = [
      messageOf({ id: "e1", blocks: [{ kind: "text", markdown: "EMBER TRANSCRIPT" }] }),
    ];
    h.history["granite/granite"] = [
      messageOf({ id: "g1", blocks: [{ kind: "text", markdown: "GRANITE TRANSCRIPT" }] }),
    ];
    const { container } = mount(h);
    await waitFor(() => expect(screen.getByText("EMBER TRANSCRIPT")).toBeDefined());

    await userEvent.type(await sendable(container), "how is /data?");
    await userEvent.click(screen.getByTitle(/Send/));
    const turn = h.turns[0] as Turn;
    await act(async () => {
      turn.handlers.onFrame({ type: "delta", seq: 1, message: "m2", text: "EMBER MID-TURN" });
    });
    expect(screen.getByText(/EMBER MID-TURN/)).toBeDefined();

    const granite = [...container.querySelectorAll("button.ch-conv")].find((b) =>
      (b.textContent ?? "").includes("granite"),
    ) as HTMLElement;
    await userEvent.click(granite);
    expect(turn.cancelled).toBe(false);
    // Thread-scoped: the rail keeps quoting ember's last line as its preview.
    const thread = () => within(container.querySelector(".ch-log")!);
    expect(thread().queryByText(/EMBER MID-TURN/)?.outerHTML ?? null).toBeNull();
    await waitFor(() => expect(thread().getByText("GRANITE TRANSCRIPT")).toBeDefined());
    await act(async () => turn.handlers.onEnd(true, null));
    expect(thread().getByText("GRANITE TRANSCRIPT")).toBeDefined();
    expect(thread().queryByText("EMBER TRANSCRIPT")?.outerHTML ?? null).toBeNull();
  });
});
