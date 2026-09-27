/**
 * What a `dropped` frame costs.
 *
 * The frame names nobody, so every transcript this browser holds is suspect and
 * every one of them has to be read again. The reads are therefore *queued*
 * rather than all fired at once: a browser watching a dozen conversations must
 * not spend its whole connection budget recovering from one overflow, and the
 * boxes answer one read at a time regardless.
 *
 * A conversation with a turn in flight is the exception, in both directions. It
 * is not read now — the half-built reply is what would be lost — and it is not
 * queued for later either, because its own settle point re-reads the transcript
 * anyway. Doing both is how the same transcript gets read twice.
 */
import { afterEach, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "./dom.ts";
import { ChatProvider, useChat } from "../src/chat/chat-state.tsx";
import type { Chat, ChatApi } from "../src/chat/chat-state.tsx";
import type { ChatHistoryResult, ChatStreamHandlers, ChatTurnHandlers } from "../src/api/index.ts";

afterEach(cleanup);

const SESSIONS = ["A", "B", "C", "D", "E"] as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup() {
  let current!: Chat;
  /** Every history read, in order, by the session it was addressed to. */
  const reads: string[] = [];
  /** Sessions whose next read is held open, so concurrency is observable. */
  const held = new Set<string>();
  const pending: { session: string; resolve: (value: ChatHistoryResult) => void }[] = [];
  const streams: ChatStreamHandlers[] = [];
  const turns: ChatTurnHandlers[] = [];

  const api: ChatApi = {
    fetchSwarms: async () => ({ swarms: [] }) as never,
    fetchSessions: async () =>
      ({
        sessions: SESSIONS.map((id) => ({
          id,
          instance: "atlas",
          bot: "default",
          origin: "portal",
          origin_detail: null,
        })),
      }) as never,
    fetchHistory: async (_instance, _bot, opts) => {
      const session = opts?.session ?? "A";
      reads.push(session);
      const answer = { instance: "atlas", bot: "default", session, messages: [] };
      if (!held.has(session)) return answer as ChatHistoryResult;
      const gate = deferred<ChatHistoryResult>();
      pending.push({ session, resolve: gate.resolve });
      return gate.promise;
    },
    sendTurn: (_instance, _bot, _text, handlers) => {
      turns.push(handlers);
      return () => {};
    },
    abortTurn: async () => ({ aborted: true }) as never,
    chatStream: (handlers: ChatStreamHandlers) => {
      streams.push(handlers);
      return () => {};
    },
  };

  function Controls() {
    current = useChat();
    return (
      <>
        {SESSIONS.map((id) => (
          <button key={id} type="button" onClick={() => current.select("atlas", "default", id)}>
            {id}
          </button>
        ))}
        <button type="button" onClick={() => current.send("hello")}>
          Send
        </button>
      </>
    );
  }
  render(
    <ChatProvider api={api} eager={false}>
      <Controls />
    </ChatProvider>,
  );

  const choose = async (label: string) => {
    fireEvent.click(screen.getByRole("button", { name: label }));
    await waitFor(() => expect(current.historyRead).toBe(true));
  };
  const countOf = (session: string) => reads.filter((row) => row === session).length;
  return {
    get current() {
      return current;
    },
    choose,
    click: (label: string) => fireEvent.click(screen.getByRole("button", { name: label })),
    reads,
    countOf,
    hold: (...sessions: string[]) => {
      for (const s of sessions) held.add(s);
    },
    release: async () => {
      const waiting = pending.splice(0, pending.length);
      await act(async () => {
        for (const row of waiting)
          row.resolve({
            instance: "atlas",
            bot: "default",
            session: row.session,
            messages: [],
          } as ChatHistoryResult);
      });
    },
    inFlight: () => pending.length,
    drop: async () => {
      await act(async () => {
        streams[0]?.onDropped(12);
      });
    },
    turns,
  };
}

test("a dropped frame re-reads idle transcripts two at a time, each of them once", async () => {
  const h = setup();
  for (const id of SESSIONS) await h.choose(id);
  const before = Object.fromEntries(SESSIONS.map((id) => [id, h.countOf(id)]));

  // Every re-read now hangs, so what is outstanding at once is the queue width.
  h.hold(...SESSIONS);
  await h.drop();

  await waitFor(() => expect(h.inFlight()).toBe(2));
  expect(h.inFlight()).toBe(2);
  await h.release();
  await waitFor(() => expect(h.inFlight()).toBe(2));
  await h.release();
  await waitFor(() => expect(h.inFlight()).toBe(1));
  await h.release();

  // Five conversations, five re-reads: the queue staggers them, it does not
  // lose one and it does not read one twice.
  await waitFor(() =>
    expect(SESSIONS.every((id) => h.countOf(id) === (before[id] ?? 0) + 1)).toBe(true),
  );
});

test("a dropped frame during a turn defers that transcript's re-read until it settles", async () => {
  const h = setup();
  await h.choose("A");
  await h.choose("B");
  h.click("Send");
  await waitFor(() => expect(h.current.sending).toBe(true));
  const sent = h.countOf("B");
  const idle = h.countOf("A");

  await h.drop();

  // The idle conversation is read; the one mid-turn is not, because the read
  // would take the half-built reply with it.
  await waitFor(() => expect(h.countOf("A")).toBe(idle + 1));
  expect(h.countOf("B")).toBe(sent);

  await act(async () => {
    h.turns[0]?.onEnd(true, null);
  });

  // The debt is paid exactly once at the settle point.
  await waitFor(() => expect(h.countOf("B")).toBe(sent + 1));
  await new Promise((done) => setTimeout(done, 20));
  expect(h.countOf("B")).toBe(sent + 1);
});
