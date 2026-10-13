/**
 * The context-window figure belongs to the conversation's record (§9.2).
 *
 * The box's stored rows carry no window, so the figure a turn reported has to
 * outlive the re-read that replaces the turn's live copy, and it has to follow
 * the conversation — not a session id — through the first read that names a
 * new conversation's session, through a rollover, and through the operator
 * looking elsewhere and coming back. It must also never appear on a
 * conversation it did not describe. Driven through the real store and
 * `ChatView`, with the transport injected (`chat-observe-fixtures.tsx`).
 */
import { act, cleanup, screen, waitFor } from "./dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import type {
  ChatFrameView,
  ChatHistoryResult,
  ChatObserveView,
  ChatSessionsResult,
} from "../src/api/index.ts";
import { ATLAS, deliver, harness, messageOf, mount, sessionOf } from "./chat-observe-fixtures.tsx";
import type { Harness } from "./chat-observe-fixtures.tsx";

afterEach(cleanup);

interface Turn {
  onFrame: (frame: ChatFrameView) => void;
  onEnd: (ok: boolean, error: { code: string; message: string } | null) => void;
}

/** Hand every turn's handlers to the test, so it can play the frames itself. */
function captureTurns(h: Harness): Turn[] {
  const turns: Turn[] = [];
  h.api.sendTurn = ((
    _i: string,
    _b: string,
    _m: string,
    handlers: Turn,
    opts: { session?: string } = {},
  ) => {
    h.calls.send++;
    h.sendFor.push(opts.session ?? null);
    turns.push(handlers);
    return () => {};
  }) as unknown as Harness["api"]["sendTurn"];
  return turns;
}

const usage = (used: number) => ({
  input_tokens: used,
  output_tokens: 10,
  cost_usd: null,
  model: "m",
  context_used: used,
  context_max: 200_000,
  context_percent: Math.round((used / 200_000) * 100),
});

/** A live `session.usage` tick, as core frames one. */
const tick = (seq: number, used: number): ChatFrameView => ({
  type: "block",
  seq,
  message: "live-1",
  block: {
    kind: "activity",
    category: "usage",
    key: "usage",
    title: "Current usage",
    state: "running",
    detail: null,
    payload: { usage: { context_used: used, context_max: 200_000 } },
  } as never,
});

const done = (seq: number, used: number): ChatFrameView => ({
  type: "done",
  seq,
  message: "live-1",
  usage: usage(used),
});

async function frame(turn: Turn | undefined, f: ChatFrameView) {
  await act(async () => turn?.onFrame(f));
}

async function settle(turn: Turn | undefined) {
  await act(async () => turn?.onEnd(true, null));
}

const meter = () => screen.queryByRole("meter");

function rollover(
  session: string | null,
  messages = [
    messageOf({
      id: "s2-1",
      session: "s2",
      blocks: [{ kind: "text", markdown: "the compacted conversation" }],
    }),
  ],
): ChatObserveView {
  return {
    type: "snapshot",
    instance: ATLAS.instance,
    bot: ATLAS.bot,
    session,
    messages,
    at: new Date().toISOString(),
  } as unknown as ChatObserveView;
}

describe("the figure a turn reported", () => {
  test("outlives the re-read whose rows carry none", async () => {
    const h = harness();
    const turns = captureTurns(h);
    const { held } = await mount(h);
    expect(meter()).toBeNull();

    await act(async () => {
      held.store?.send("how full is it");
    });
    await waitFor(() => expect(turns.length).toBe(1));
    await frame(turns[0], done(1, 170_000));
    await waitFor(() => expect(meter()?.textContent).toBe("85%"));
    const reads = h.calls.history;
    await settle(turns[0]);
    await waitFor(() => expect(h.calls.history).toBeGreaterThan(reads));
    await waitFor(() => expect(held.store?.live).toBeNull());
    expect(meter()?.textContent).toBe("85%");
  });

  test("survives the read that first names a new conversation's session", async () => {
    const h = harness();
    // A bot with no conversation yet: no sessions, and the box answers from none.
    let named = false;
    h.api.fetchSessions = ((instance: string, bot: string) =>
      Promise.resolve({
        instance,
        bot,
        sessions: named ? [sessionOf()] : [],
      } as unknown as ChatSessionsResult)) as Harness["api"]["fetchSessions"];
    h.api.fetchHistory = ((instance: string, bot: string, input: { session?: string } = {}) => {
      h.calls.history++;
      h.historyFor.push(input.session ?? null);
      return Promise.resolve({
        instance,
        bot,
        session: named ? "s1" : null,
        messages: named ? [messageOf({ id: "reply", session: "s1" })] : [],
      } as unknown as ChatHistoryResult);
    }) as Harness["api"]["fetchHistory"];
    const turns = captureTurns(h);
    const { held } = await mount(h);
    expect(h.historyFor).toEqual([null]);

    await act(async () => {
      held.store?.send("first words");
    });
    await waitFor(() => expect(turns.length).toBe(1));
    expect(h.sendFor).toEqual([null]);
    await frame(turns[0], done(1, 170_000));
    named = true;
    await settle(turns[0]);
    await waitFor(() => expect(h.calls.history).toBe(2));
    await waitFor(() => expect(held.store?.live).toBeNull());
    expect(held.store?.messages.at(-1)?.session).toBe("s1");
    expect(meter()?.textContent).toBe("85%");
  });

  test("is found again after looking at another conversation, which shows none", async () => {
    const h = harness();
    const turns = captureTurns(h);
    const { held } = await mount(h);
    await act(async () => {
      held.store?.send("how full is it");
    });
    await waitFor(() => expect(turns.length).toBe(1));
    await frame(turns[0], done(1, 170_000));
    await settle(turns[0]);
    await waitFor(() => expect(held.store?.live).toBeNull());

    await act(async () => {
      held.store?.select("atlas", "atlas", "s9");
    });
    await waitFor(() => expect(h.historyFor.at(-1)).toBe("s9"));
    await waitFor(() => expect(held.store?.historyRead).toBe(true));
    expect(held.store?.context).toBeNull();
    expect(meter()).toBeNull();

    await act(async () => {
      held.store?.select("atlas", "atlas");
    });
    await waitFor(() => expect(meter()?.textContent).toBe("85%"));
  });

  test("never reaches another conversation of the same bot picked mid-turn", async () => {
    const h = harness();
    const turns = captureTurns(h);
    const { held } = await mount(h);
    await act(async () => {
      held.store?.send("how full is it");
    });
    await waitFor(() => expect(turns.length).toBe(1));
    await frame(turns[0], tick(1, 120_000));
    await waitFor(() => expect(meter()?.textContent).toBe("60%"));

    await act(async () => {
      held.store?.select("atlas", "atlas", "s9");
    });
    await waitFor(() => expect(h.historyFor.at(-1)).toBe("s9"));
    // The turn on s1 keeps reporting while the operator reads s9.
    await frame(turns[0], tick(2, 150_000));
    await frame(turns[0], done(3, 170_000));
    await settle(turns[0]);
    expect(held.store?.context).toBeNull();
    expect(meter()).toBeNull();

    // And the turn's figure was kept for s1 though nobody was looking at it.
    await act(async () => {
      held.store?.select("atlas", "atlas");
    });
    await waitFor(() => expect(meter()?.textContent).toBe("85%"));
  });
});

describe("a rollover", () => {
  test("leaves the old figure with the retired session and takes the new one from the turn", async () => {
    const h = harness();
    const turns = captureTurns(h);
    const { held } = await mount(h);
    await act(async () => {
      held.store?.send("compact and carry on");
    });
    await waitFor(() => expect(turns.length).toBe(1));
    await frame(turns[0], tick(1, 190_000));
    await waitFor(() => expect(meter()?.textContent).toBe("95%"));

    // The box compacts mid-turn: the canonical conversation is now s2.
    await deliver(h, rollover("s2"));
    await waitFor(() => expect(screen.queryAllByText(/the compacted conversation/).length).toBe(1));
    // The new conversation's record starts with nothing; what is drawn now is
    // only the live copy's own pre-rollover tick, until the turn says more.
    expect(held.store?.context).toBeNull();
    await frame(turns[0], tick(2, 30_000));
    await waitFor(() => expect(meter()?.textContent).toBe("15%"));
    await frame(turns[0], done(3, 32_000));
    await settle(turns[0]);
    await waitFor(() => expect(held.store?.live).toBeNull());
    expect(meter()?.textContent).toBe("16%");

    // The retired conversation keeps what it last reported.
    await act(async () => {
      held.store?.select("atlas", "atlas", "s1");
    });
    await waitFor(() => expect(h.historyFor.at(-1)).toBe("s1"));
    await waitFor(() => expect(held.store?.context?.usage.percent).toBe(95));
  });
});

describe("a new conversation", () => {
  test("an archive's replacement starts with no figure", async () => {
    const h = harness();
    let current = "s1";
    h.api.openConversation = (({ instance, bot }: { instance: string; bot: string }) =>
      Promise.resolve({
        instance,
        bot,
        session: current,
      } as never)) as Harness["api"]["openConversation"];
    h.api.fetchHistory = ((instance: string, bot: string, input: { session?: string } = {}) => {
      h.calls.history++;
      h.historyFor.push(input.session ?? null);
      return Promise.resolve({
        instance,
        bot,
        session: input.session ?? current,
        messages: [messageOf({ id: `${input.session}-1`, session: input.session })],
      } as unknown as ChatHistoryResult);
    }) as Harness["api"]["fetchHistory"];
    const turns = captureTurns(h);
    const { held } = await mount(h);
    await act(async () => {
      held.store?.send("how full is it");
    });
    await waitFor(() => expect(turns.length).toBe(1));
    await frame(turns[0], done(1, 170_000));
    await settle(turns[0]);
    await waitFor(() => expect(held.store?.live).toBeNull());
    expect(meter()?.textContent).toBe("85%");

    // Archived: the box opens a new canonical conversation, s2.
    current = "s2";
    await act(async () => {
      await held.store?.reloadHistory();
    });
    await waitFor(() => expect(h.historyFor.at(-1)).toBe("s2"));
    await waitFor(() => expect(held.store?.messages.at(-1)?.session).toBe("s2"));
    expect(held.store?.context).toBeNull();
    expect(meter()).toBeNull();
  });
});
