/**
 * The chat fan-in, driven (§9.2): the arrival.
 *
 * The acceptance criterion this file exists for is one sentence: an external
 * Desktop, CLI or routine message arrives without a two-minute wait. Everything
 * else here is the cost of that being true — a transcript that is told about a
 * message must not double it, must not repeat the operator's own prompt back at
 * them, and must say out loud when it has stopped being told anything at all.
 * What the stream does to the inbox and the rail, and how it reconciles with a
 * transcript already held, is in `chat-observe-rail.dom.test.tsx`; the doubles
 * are shared (`chat-observe-fixtures.tsx`).
 */
import { act, cleanup, screen, userEvent, waitFor } from "./dom.ts";
import { afterEach, describe, expect, jest, test } from "bun:test";
import type { ChatMessageView, ChatObserveView } from "../src/api/index.ts";
import {
  ATLAS,
  arrival,
  deliver,
  harness,
  holdHistory,
  messageOf,
  mount,
  mountHeld,
  mountPinnedToSession,
  shown,
  snapshot,
} from "./chat-observe-fixtures.tsx";

afterEach(cleanup);
afterEach(() => {
  jest.useRealTimers();
});

// The avatar entrance tween is left to run here. It used to be skipped by a
// module-scope `document.hidden` patch, and `setup.ts` owns that property now
// — owning it means `visibilityState` agrees with it, so a hidden page also
// stops the roster read every test below is built on. Measured both ways: the
// file is green and no slower with the tween left alone.

/* ── the headline: an external message, with nobody asking for it ────────── */

describe("a message nobody in this browser sent", () => {
  test("reaches the thread on the stream, with no local send and no re-read", async () => {
    const h = harness();
    const mounted = await mount(h);
    const reads = h.calls.history;

    await deliver(
      h,
      arrival(
        messageOf({
          id: "desktop-1",
          role: "user",
          author: "operator",
          blocks: [{ kind: "text", markdown: "sent from Hermes Desktop" }],
        }),
      ),
    );

    await waitFor(() => expect(shown(/sent from Hermes Desktop/)).toBe(1));
    // The point of the phase: no poll, no history read, no send. The frame is
    // the whole of how this browser learned about it.
    expect(h.calls.history).toBe(reads);
    expect(h.calls.send).toBe(0);
    expect(mounted.held.store?.observation.state).toBe("live");
  });

  test("the same message id twice is rendered once", async () => {
    const h = harness();
    await mount(h);
    const twice = messageOf({
      id: "desktop-2",
      blocks: [{ kind: "text", markdown: "delivered twice, drawn once" }],
    });

    await deliver(h, arrival(twice));
    await deliver(h, arrival(twice));

    await waitFor(() => expect(shown(/delivered twice, drawn once/)).toBe(1));
  });

  test("a snapshot replaces the transcript and a later message appends to it", async () => {
    const h = harness();
    await mount(h);
    await waitFor(() => expect(shown(/the complete answer, from the box/)).toBe(1));

    await deliver(
      h,
      snapshot([messageOf({ id: "s-1", blocks: [{ kind: "text", markdown: "the box's own copy" }] })]),
    );
    // Replaced, never merged (§9.2): the read this browser was holding
    // is a cache that is allowed to be wrong.
    await waitFor(() => expect(shown(/the box's own copy/)).toBe(1));
    expect(shown(/the complete answer, from the box/)).toBe(0);

    await deliver(
      h,
      arrival(messageOf({ id: "s-2", blocks: [{ kind: "text", markdown: "and then one more" }] })),
    );
    await waitFor(() => expect(shown(/and then one more/)).toBe(1));
    expect(shown(/the box's own copy/)).toBe(1);
  });
});

/* ── the canonical session moving out from under a held transcript ───────── */

/**
 * A `snapshot` naming a session other than the one the record is pinned to.
 *
 * Core emits one on the first read and again on every read whose session has
 * changed — a canonical rollover, this conversation archived and `chat.open`
 * establishing its replacement. The schema's instruction to the consumer is to
 * discard what it held for the previous session, and the identity is part of
 * what it held: a transcript replaced but still addressed to the retired
 * session sends every later turn into an archived conversation.
 */
function rollover(session: string | null, messages: ChatMessageView[]): ChatObserveView {
  return {
    type: "snapshot",
    instance: ATLAS.instance,
    bot: ATLAS.bot,
    session,
    messages,
    at: new Date().toISOString(),
  } as unknown as ChatObserveView;
}

describe("a snapshot for a session other than the one being held", () => {
  test("re-keys the conversation onto the session the box now answers from", async () => {
    const h = harness();
    const { held } = await mount(h);
    // The first read pinned this canonical conversation to `s1`, so the record
    // is reachable under both its canonical key and `s1`'s explicit one.
    await waitFor(() => expect(h.historyFor).toEqual([null]));

    await deliver(
      h,
      rollover("s2", [
        messageOf({
          id: "s2-1",
          session: "s2",
          blocks: [{ kind: "text", markdown: "the conversation that replaced it" }],
        }),
      ]),
    );
    await waitFor(() => expect(shown(/the conversation that replaced it/)).toBe(1));
    expect(shown(/the complete answer, from the box/)).toBe(0);

    // What the rollover is for: the next turn is addressed to `s2`. Before the
    // re-key the transcript showed `s2` while every write still named `s1`.
    await act(async () => {
      held.store?.send("and is it still you");
    });
    await waitFor(() => expect(h.calls.send).toBe(1));
    expect(h.sendFor).toEqual(["s2"]);

    // And `s1`'s key no longer resolves to this record: selecting the retired
    // session reads the retired session, not whatever the live one has moved on
    // to. A record still answering to both keys would read `s2` here.
    await act(async () => {
      held.store?.select("atlas", "atlas", "s1");
    });
    await waitFor(() => expect(h.historyFor.at(-1)).toBe("s1"));
  });

  test("moves only the retired session's alias, never the canonical one", async () => {
    const h = harness();
    const gate = holdHistory(h);
    const { held } = await mountPinnedToSession(h, gate);

    // Every alias, the canonical one included, now answers with a record whose
    // own `target.session` is `s1`. A sweep that spares "the record's own key"
    // spares `s1` and moves the canonical alias onto the frozen copy instead,
    // which is the live conversation going dark on the fan-in permanently.
    await deliver(
      h,
      rollover("s2", [
        messageOf({ id: "s2-1", session: "s2", blocks: [{ kind: "text", markdown: "carried on" }] }),
      ]),
    );

    // The canonical address still reaches the record the box is talking to, so
    // it reads and writes `s2`. Reaching the frozen copy would say `s1`.
    await act(async () => {
      held.store?.select("atlas", "atlas");
    });
    await waitFor(() => expect(h.historyFor.at(-1)).toBe("s2"));
    await act(async () => {
      held.store?.send("still the same thread");
    });
    await waitFor(() => expect(h.calls.send).toBe(1));
    expect(h.sendFor).toEqual(["s2"]);
  });

  test("drops a placeholder the archived session was still holding", async () => {
    const h = harness();
    const { held } = await mount(h);
    await act(async () => {
      held.store?.send("/compact");
    });
    await waitFor(() => expect(shown(/\/compact/)).toBe(1));

    // `/compact` archives the canonical conversation and opens its replacement
    // (design.md §9.2), so the turn that caused the rollover is the one the box
    // will never record under the new session. `accountsFor` cannot match it
    // against rows it did not produce, so keeping it pins it to the head of
    // this transcript for good — a phantom of the operator's own message.
    await deliver(
      h,
      rollover("s2", [
        messageOf({ id: "s2-1", session: "s2", blocks: [{ kind: "text", markdown: "compacted" }] }),
      ]),
    );
    await waitFor(() => expect(shown(/compacted/)).toBe(1));
    expect(shown(/\/compact$/)).toBe(0);
  });

  test("leaves the live record's in-flight read to the live record", async () => {
    const h = harness();
    const { held } = await mount(h);

    // A read in flight at the moment of the rollover. A shallow copy inherits
    // its controller and its `historyLoading`, and both belong to the record
    // that is still doing the work: the archived copy would either abort that
    // read or sit forever behind a spinner it does not own.
    const gate = holdHistory(h);
    await act(async () => {
      void held.store?.reloadHistory();
    });
    await waitFor(() => expect(gate.waiting()).toBe(1));
    await deliver(
      h,
      rollover("s2", [
        messageOf({ id: "s2-1", session: "s2", blocks: [{ kind: "text", markdown: "moved on" }] }),
      ]),
    );
    gate.open();

    const before = h.calls.history;
    await act(async () => {
      held.store?.select("atlas", "atlas", "s1");
    });
    // The archived copy reads for itself, addressed to the session it kept.
    await waitFor(() => expect(h.calls.history).toBe(before + 1));
    expect(h.historyFor.at(-1)).toBe("s1");
  });

  test("a session retired with nothing in its place stops being addressed", async () => {
    const h = harness();
    const { held } = await mount(h);

    // `chat.archive` retires the root and opens nothing (design.md §9.2), so
    // the box answers from no session at all. It is still a rollover, and the
    // easiest one to leave half-done: the transcript empties while every write
    // goes on naming the conversation that was just archived.
    await deliver(h, rollover(null, []));
    await waitFor(() => expect(shown(/the complete answer, from the box/)).toBe(0));

    await act(async () => {
      held.store?.send("anyone there");
    });
    await waitFor(() => expect(h.calls.send).toBe(1));
    expect(h.sendFor).toEqual([null]);
  });

  test("a record already holding the new session is merged, not discarded", async () => {
    const h = harness();
    const { held } = await mount(h);
    // The operator opened the replacement by hand and sent into it before the
    // fan-in said anything about a rollover, so the new session's key is taken
    // by a record with a turn in flight when the snapshot lands.
    await act(async () => {
      held.store?.select("atlas", "atlas", "s2");
    });
    await waitFor(() => expect(h.historyFor.at(-1)).toBe("s2"));
    await act(async () => {
      held.store?.send("the prompt I typed");
    });
    await waitFor(() => expect(h.calls.send).toBe(1));
    expect(shown(/the prompt I typed/)).toBe(1);

    await deliver(
      h,
      rollover("s2", [
        messageOf({
          id: "s2-1",
          session: "s2",
          blocks: [{ kind: "text", markdown: "what the box holds" }],
        }),
      ]),
    );
    await waitFor(() => expect(shown(/what the box holds/)).toBe(1));

    // The placeholder is the only copy of that prompt until the box records it,
    // and it was typed into this session, so the record that wins the identity
    // has to take it. "A send is never lost" is what `stillPending` is for.
    expect(shown(/the prompt I typed/)).toBe(1);
    // And the losing record's turn is stopped rather than left running where
    // no Stop button can reach it.
    expect(h.cancelled).toBe(1);
  });

  test("a retired session is not resurrected through the record's own target", async () => {
    const h = harness();
    const gate = holdHistory(h);
    const { held } = await mountPinnedToSession(h, gate);

    // This record's own `target.session` is `s1`, and every address in the
    // store is `resolvedSession ?? target.session`. Clearing only the first
    // leaves the second to answer with the session that was just archived.
    await deliver(h, rollover(null, []));

    await act(async () => {
      held.store?.select("atlas", "atlas");
    });
    await waitFor(() => expect(h.historyFor.at(-1)).toBe(null));
  });

  test("a first snapshot merging a record away keeps what was typed into it", async () => {
    const h = harness();
    const gate = holdHistory(h);
    const { held } = mountHeld(h);
    // The canonical read is still in flight, so this record has resolved no
    // session yet and the snapshot below is its *first* — a rollover with
    // nothing to retire, which reaches the other half of the reconciliation.
    await waitFor(() => expect(gate.waiting()).toBe(1));
    await act(async () => {
      held.store?.select("atlas", "atlas", "s2");
    });
    await waitFor(() => expect(gate.waiting()).toBe(2));
    await gate.release(1);
    await act(async () => {
      held.store?.send("typed into s2");
    });
    await waitFor(() => expect(h.calls.send).toBe(1));
    expect(shown(/typed into s2/)).toBe(1);

    await deliver(
      h,
      rollover("s2", [
        messageOf({
          id: "s2-1",
          session: "s2",
          blocks: [{ kind: "text", markdown: "what the box holds" }],
        }),
      ]),
    );
    await waitFor(() => expect(shown(/what the box holds/)).toBe(1));
    expect(shown(/typed into s2/)).toBe(1);
    expect(h.cancelled).toBe(1);
  });
});

/* ── a send in flight, observed ──────────────────────────────────────────── */

describe("the operator's own prompt, coming back on the stream", () => {
  test("a local send and its observed frame are one message, not two", async () => {
    const h = harness();
    const { container } = await mount(h);
    const input = await waitFor(() => {
      const node = container.querySelector(".ch-input") as HTMLTextAreaElement | null;
      expect(node).not.toBeNull();
      expect((node as HTMLTextAreaElement).disabled).toBe(false);
      return node as HTMLTextAreaElement;
    });
    await userEvent.type(input, "restart the indexer{Enter}");
    await waitFor(() => expect(h.calls.send).toBe(1));
    expect(shown(/restart the indexer/)).toBe(1);

    // The box records the prompt and the observation reports it. It is the same
    // message under the id the box gave it: "unknown delivery is not permission
    // to replay", and neither is known delivery.
    await deliver(
      h,
      arrival(
        messageOf({
          id: "upstream-user-1",
          role: "user",
          author: "operator",
          blocks: [{ kind: "text", markdown: "restart the indexer" }],
        }),
      ),
    );

    await waitFor(() => expect(shown(/restart the indexer/)).toBe(1));
  });

  test("a snapshot taken before the box recorded the prompt keeps it on screen", async () => {
    const h = harness();
    const { container } = await mount(h);
    const input = await waitFor(() => {
      const node = container.querySelector(".ch-input") as HTMLTextAreaElement | null;
      expect(node).not.toBeNull();
      return node as HTMLTextAreaElement;
    });
    await userEvent.type(input, "deploy the new stages{Enter}");
    await waitFor(() => expect(h.calls.send).toBe(1));

    // The observation's snapshot is authoritative about the box and says
    // nothing about a message the box has not written yet. Dropping the prompt
    // here would lose the only copy of it.
    await deliver(h, snapshot([messageOf({ id: "s-old" })]));
    await waitFor(() => expect(shown(/deploy the new stages/)).toBe(1));
  });
});

/* ── the three states the stream can be in ───────────────────────────────── */

describe("what the stream says about itself", () => {
  test("a reconnect reads as reconnecting rather than as a failure", async () => {
    const h = harness();
    const mounted = await mount(h);

    await deliver(h, {
      type: "reconnect",
      instance: "atlas",
      bot: "atlas",
      attempt: 2,
      delay_ms: 2000,
      code: "CHAT_UNREACHABLE",
      message: "the box did not answer",
    } as unknown as ChatObserveView);

    const band = await screen.findByText(/Reconnecting to this conversation/);
    expect(band.closest(".ch-band")?.getAttribute("role")).toBe("status");
    expect(shown(/attempt 2/)).toBe(1);
    // Not an error: the server is still trying, and the transcript on screen is
    // still the last thing the box said.
    expect(document.querySelector(".ch-band.bad") === null).toBe(true);
    expect(mounted.held.store?.observation.state).toBe("reconnecting");
  });

  test("a lost socket reads as reconnecting too, and a restored one clears it", async () => {
    const h = harness();
    const mounted = await mount(h);

    await act(async () => {
      h.streams[0]?.onConnected(false);
    });
    await screen.findByText(/Reconnecting to this conversation/);

    await act(async () => {
      h.streams[0]?.onConnected(true);
    });
    await waitFor(() => expect(mounted.held.store?.observation.state).toBe("live"));
    expect(shown(/Reconnecting to this conversation/)).toBe(0);
  });

  test("an error is terminal, said as one, and re-subscribed only when asked", async () => {
    const h = harness();
    const mounted = await mount(h);

    await deliver(h, {
      type: "error",
      instance: "atlas",
      bot: "atlas",
      code: "CHAT_OBSERVE_FAILED",
      message: "the retry budget was spent",
    } as unknown as ChatObserveView);

    const band = await screen.findByText(/no longer being watched/);
    expect(band.closest(".ch-band")?.getAttribute("role")).toBe("alert");
    expect(shown(/the retry budget was spent/)).toBe(1);
    // Terminal: nothing re-subscribes behind the operator's back.
    expect(h.resumes).toHaveLength(0);

    const reads = h.calls.history;
    await userEvent.click(screen.getByRole("button", { name: "Watch again" }));
    // One conversation, named by its *identity*: this thread is a bot's
    // canonical conversation, which the server keys on no session at all.
    // Then the transcript, because the gap is real.
    await waitFor(() =>
      expect(h.resumes).toEqual([{ instance: "atlas", bot: "atlas", session: null }]),
    );
    await waitFor(() => expect(h.calls.history).toBeGreaterThan(reads));
    await waitFor(() => expect(mounted.held.store?.observation.state).toBe("live"));
    expect(shown(/no longer being watched/)).toBe(0);
  });

  test("a dropped frame re-reads the transcript rather than hiding the gap", async () => {
    const h = harness();
    await mount(h);
    const reads = h.calls.history;

    h.history = [
      messageOf({ id: "after-gap", blocks: [{ kind: "text", markdown: "what was missed" }] }),
    ];
    await act(async () => {
      h.streams[0]?.onDropped(12);
    });

    await waitFor(() => expect(h.calls.history).toBeGreaterThan(reads));
    await waitFor(() => expect(shown(/what was missed/)).toBe(1));
  });
});
