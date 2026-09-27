/** Real provider lifecycle with independent pipes, deferred reads, and abort replies. */
import { afterEach, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "./dom.ts";
import { ChatProvider, useChat } from "../src/chat/chat-state.tsx";
import { activityFor } from "../src/chat/chat-activity.ts";
import type { Chat, ChatApi } from "../src/chat/chat-state.tsx";
import type {
  ChatFrameView,
  ChatHistoryResult,
  ChatMessageView,
  ChatObserveView,
  ChatStreamHandlers,
  ChatTurnHandlers,
} from "../src/api/index.ts";
import { turnRows } from "../src/chat/chat-turns.ts";

afterEach(cleanup);
function message(id: string, text: string): ChatMessageView {
  return {
    id,
    session: id,
    role: "bot",
    author: null,
    at: new Date().toISOString(),
    blocks: [{ kind: "text", markdown: text }],
    usage: null,
    error: null,
    incomplete: null,
  } as ChatMessageView;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  let current!: Chat;
  let canonical: string | null = "A";
  let available = ["A", "B"];
  const transcripts = new Map<string, ChatMessageView[]>([
    ["A", []],
    ["B", []],
  ]);
  const reads: string[] = [];
  const held = new Map<string, ReturnType<typeof deferred<ChatHistoryResult>>>();
  const turns: { session?: string; handlers: ChatTurnHandlers; cancelled: boolean }[] = [];
  const aborts: (string | null | undefined)[] = [];
  const abortReplies = new Map<string, ReturnType<typeof deferred<unknown>>>();
  const streams: ChatStreamHandlers[] = [];
  const api: ChatApi = {
    chatStream: (handlers: ChatStreamHandlers) => {
      streams.push(handlers);
      return () => {};
    },
    fetchSwarms: async () => ({ swarms: [] }) as never,
    fetchSessions: async () =>
      ({
        sessions: available.map((id) => ({
          id,
          instance: "atlas",
          bot: "default",
          origin: "portal",
          origin_detail: null,
        })),
      }) as never,
    fetchHistory: async (_instance, _bot, opts) => {
      const session = opts?.session ?? canonical;
      reads.push(session ?? "(new)");
      const pending = held.get(session ?? "");
      if (pending) return pending.promise;
      return { session, messages: transcripts.get(session ?? "") ?? [] } as ChatHistoryResult;
    },
    sendTurn: (_instance, _bot, _text, handlers, opts) => {
      const turn = { session: opts?.session, handlers, cancelled: false };
      turns.push(turn);
      return () => {
        turn.cancelled = true;
      };
    },
    abortTurn: async (_instance, _bot, session) => {
      aborts.push(session);
      await abortReplies.get(session ?? "")?.promise;
      return { aborted: true } as never;
    },
  };
  function Controls() {
    current = useChat();
    return (
      <>
        <button type="button" onClick={() => current.select("atlas", "default", "A")}>
          A
        </button>
        <button type="button" onClick={() => current.select("atlas", "default", "B")}>
          B
        </button>
        <button type="button" onClick={() => current.select("atlas", "default")}>
          Canonical
        </button>
        <button type="button" onClick={() => current.send(current.draft)}>
          Send
        </button>
        <button type="button" onClick={() => void current.abort()}>
          Abort
        </button>
        <button type="button" onClick={() => void current.reloadHistory()}>
          Reload
        </button>
        <input
          aria-label="Draft"
          value={current.draft}
          onChange={(event) => current.setDraft(event.target.value)}
        />
      </>
    );
  }
  const root = render(
    <ChatProvider api={api} eager={false}>
      <Controls />
    </ChatProvider>,
  );
  const choose = async (label: string) => {
    fireEvent.click(screen.getByRole("button", { name: label }));
    await waitFor(() => expect(current.historyRead).toBe(true));
  };
  const click = (label: string) => fireEvent.click(screen.getByRole("button", { name: label }));
  const draft = (text: string) =>
    fireEvent.change(screen.getByLabelText("Draft"), { target: { value: text } });
  const frame = async (index: number, text: string, seq = 1) => {
    await act(async () =>
      turns[index]!.handlers.onFrame({ type: "delta", message: `reply-${index}`, seq, text }),
    );
  };
  /** One fan-in frame, routed at the conversation the way the server delivers it. */
  const deliver = async (session: string | null, event: ChatObserveView) => {
    await act(async () => {
      streams[0]?.onFrame({ instance: "atlas", bot: "default", session }, event);
    });
  };
  return {
    get current() {
      return current;
    },
    root,
    deliver,
    choose,
    click,
    draft,
    frame,
    turns,
    transcripts,
    reads,
    held,
    aborts,
    abortReplies,
    available: (sessions: string[]) => {
      available = sessions;
    },
    canonical: (session: string | null) => {
      canonical = session;
    },
  };
}

test("concurrent sessions retain independent drafts, streaming text and out-of-order results", async () => {
  const h = setup();
  await h.choose("A");
  h.draft("ask A");
  h.click("Send");
  h.draft("next A");
  await h.frame(0, "partial A");
  await h.choose("B");
  expect(h.current.live).toBeNull();
  expect(h.current.sending).toBe(false);
  expect(h.current.selectionError).toBeNull();
  expect(h.current.draft).toBe("");
  h.draft("ask B");
  h.click("Send");
  h.draft("next B");
  await h.frame(1, "partial B");
  await h.frame(0, " continues", 2);
  expect(h.current.live?.blocks).toEqual([{ kind: "text", markdown: "partial B" }]);
  expect(h.turns.map((turn) => turn.session)).toEqual(["A", "B"]);
  expect(h.turns.every((turn) => !turn.cancelled)).toBe(true);
  await h.choose("A");
  expect(h.current.live?.blocks).toEqual([{ kind: "text", markdown: "partial A continues" }]);
  expect(h.current.draft).toBe("next A");
  expect(h.current.sending).toBe(true);
  h.transcripts.set("B", [message("stored-B", "complete B")]);
  await act(async () => h.turns[1]!.handlers.onEnd(true, null));
  expect(h.current.sending).toBe(true);
  expect(h.current.messages.some((m) => m.id === "stored-B")).toBe(false);
  await act(async () => h.turns[0]!.handlers.onEnd(false, { code: "FAILED", message: "A failed" }));
  expect(h.current.turnError?.message).toBe("A failed");
  expect(h.current.live?.incomplete).toBe(true);
  await h.choose("B");
  expect(h.current.turnError).toBeNull();
  expect(h.current.sending).toBe(false);
  expect(h.current.messages.map((m) => m.id)).toEqual(["stored-B"]);
  expect(h.current.draft).toBe("next B");
  await h.frame(1, "late after completion", 3);
  expect(h.current.live).toBeNull();
});

test("canonical and explicit aliases share one pinned record and cannot open duplicate pipes", async () => {
  const h = setup();
  await h.choose("Canonical");
  h.draft("canonical draft");
  h.click("Send");
  await h.frame(0, "same pipe");
  const reads = h.reads.length;
  await h.choose("A");
  expect(h.current.draft).toBe("canonical draft");
  expect(h.current.sending).toBe(true);
  h.click("Send");
  expect(h.turns).toHaveLength(1);
  expect(h.reads).toHaveLength(reads);
  h.canonical("B");
  await h.choose("Canonical");
  h.click("Reload");
  expect(h.current.live?.blocks).toEqual([{ kind: "text", markdown: "same pipe" }]);
  expect(h.turns[0]!.session).toBe("A");
  await act(async () => h.turns[0]!.handlers.onEnd(true, null));
  expect(h.reads.at(-1)).toBe("A");
  h.click("Send");
  expect(h.turns[1]!.session).toBe("A");
});

test("canonical resolution adopts an already active explicit conversation", async () => {
  const h = setup();
  await h.choose("A");
  h.draft("explicit draft");
  h.click("Send");
  await h.frame(0, "explicit live");
  await h.choose("Canonical");
  await waitFor(() => expect(h.current.sending).toBe(true));
  expect(h.current.draft).toBe("explicit draft");
  expect(h.current.live?.blocks).toEqual([{ kind: "text", markdown: "explicit live" }]);
  h.click("Send");
  expect(h.turns).toHaveLength(1);
});

test("abort awaiting its response owns only its session while another sends and finishes", async () => {
  const h = setup();
  const stop = deferred<unknown>();
  h.abortReplies.set("A", stop);
  await h.choose("A");
  h.draft("A");
  h.click("Send");
  h.click("Abort");
  await act(async () => h.turns[0]!.handlers.onEnd(true, null));
  expect(h.current.sending).toBe(true);
  await h.choose("B");
  h.draft("B");
  h.click("Send");
  await h.frame(1, "B alive");
  await act(async () => stop.resolve({}));
  expect(h.aborts).toEqual(["A"]);
  expect(h.turns[0]!.cancelled).toBe(true);
  expect(h.turns[1]!.cancelled).toBe(false);
  expect(h.current.sending).toBe(true);
  expect(h.current.live?.blocks).toEqual([{ kind: "text", markdown: "B alive" }]);
  await h.choose("A");
  expect(h.current.sending).toBe(false);
  h.click("Send");
  expect(h.turns.map((turn) => turn.session)).toEqual(["A", "B", "A"]);
  await h.frame(0, "stale A", 9);
  expect(h.current.live).toBeNull();
});

test("a stale background history response cannot erase a newer turn", async () => {
  const h = setup();
  await h.choose("A");
  h.draft("first");
  h.click("Send");
  const history = deferred<ChatHistoryResult>();
  h.held.set("A", history);
  await act(async () => h.turns[0]!.handlers.onEnd(true, null));
  await h.choose("B");
  await h.choose("A");
  h.draft("second");
  h.click("Send");
  await h.frame(1, "new live");
  await act(async () =>
    history.resolve({ session: "A", messages: [message("stale", "old")] } as ChatHistoryResult),
  );
  expect(h.current.messages.some((m) => m.id === "stale")).toBe(false);
  expect(h.current.live?.blocks).toEqual([{ kind: "text", markdown: "new live" }]);
});

test("fleet teardown cancels all background pipes and rejects their delayed callbacks", async () => {
  const h = setup();
  await h.choose("A");
  h.draft("A");
  h.click("Send");
  await h.choose("B");
  h.draft("B");
  h.click("Send");
  const reads = h.reads.length;
  h.root.unmount();
  expect(h.turns.every((turn) => turn.cancelled)).toBe(true);
  await act(async () => {
    h.turns[0]!.handlers.onEnd(false, null);
    h.turns[1]!.handlers.onEnd(true, null);
  });
  expect(h.reads).toHaveLength(reads);
});

test("the first newly created session refreshes destination evidence before the second send", async () => {
  const h = setup();
  h.canonical(null);
  h.available([]);
  await h.choose("Canonical");
  await waitFor(() =>
    expect(h.current.destination).toEqual({ state: "known", origin: "portal", detail: null }),
  );
  h.draft("first");
  h.click("Send");
  expect(h.turns[0]!.session).toBeUndefined();
  h.canonical("NEW");
  h.available(["NEW"]);
  await act(async () => h.turns[0]!.handlers.onEnd(true, null));
  await waitFor(() => expect(h.current.session?.id).toBe("NEW"));
  expect(h.current.destination).toEqual({ state: "known", origin: "portal", detail: null });
  h.draft("second");
  h.click("Send");
  expect(h.turns[1]!.session).toBe("NEW");
});

test("observed phases follow accepted frames and independent background conversations", async () => {
  const h = setup();
  await h.choose("A");
  h.draft("ask A");
  h.click("Send");
  expect(h.current.activity).toBe("thinking");
  await h.frame(0, " ", 1);
  expect(h.current.activity).toBe("thinking");
  await h.frame(0, "Answer", 2);
  expect(h.current.activity).toBe("streaming");
  const block = async (
    seq: number,
    value: Parameters<ChatTurnHandlers["onFrame"]>[0] & { type: "block" },
  ) => {
    await act(async () => h.turns[0]!.handlers.onFrame({ ...value, seq }));
  };
  const snapshot = {
    type: "block",
    message: "reply-0",
    seq: 0,
    block: { kind: "activity", category: "usage", key: "usage", state: "done", title: "Usage" },
  } as const;
  await block(3, snapshot);
  expect(h.current.activity).toBe("streaming");
  await block(1, { ...snapshot, block: { kind: "reasoning", text: "Stale reasoning" } });
  expect(h.current.activity).toBe("streaming");
  await block(4, {
    ...snapshot,
    block: {
      kind: "tool",
      tool_id: "call-1",
      name: "terminal",
      status: "running",
      args: {},
      result: null,
      render: "terminal",
    },
  });
  expect(h.current.activity).toBe("thinking");
  await block(5, {
    ...snapshot,
    block: { kind: "question", request_id: "q1", prompt: "Choose", choices: [] },
  });
  expect(h.current.activity).toBe("idle");
  await block(6, {
    ...snapshot,
    block: {
      kind: "activity",
      category: "notice",
      key: "request:q1",
      request_id: "q1",
      state: "done",
      title: "Request withdrawn",
    },
  });
  expect(h.current.activity).toBe("thinking");
  await h.choose("Canonical");
  expect(h.current.turnActivities).toHaveLength(1);
  await h.choose("B");
  expect(h.current.activity).toBe("idle");
  expect(activityFor(h.current.turnActivities, "atlas", "default")).toBe("thinking");
  expect(activityFor(h.current.turnActivities, "other", "default")).toBe("idle");
  h.draft("ask B");
  h.click("Send");
  await h.frame(1, "B output");
  expect(activityFor(h.current.turnActivities, "atlas")).toBe("streaming");
  await act(async () =>
    h.turns[0]!.handlers.onFrame({ type: "done", seq: 7, message: "reply-0", usage: null }),
  );
  expect(h.current.turnActivities).toHaveLength(1);
  expect(h.current.activity).toBe("streaming");
  await h.choose("A");
  expect(h.current.sending).toBe(true);
  expect(h.current.activity).toBe("idle");
  await h.frame(0, "Late output after done", 8);
  expect(h.current.activity).toBe("idle");
  expect(activityFor(h.current.turnActivities, "atlas", "default")).toBe("streaming");
  await act(async () => h.turns[0]!.handlers.onEnd(true, null));
  await h.choose("B");
  await act(async () => h.turns[1]!.handlers.onEnd(false, { code: "FAILED", message: "Failed B" }));
  expect(h.current.activity).toBe("idle");
  expect(h.current.turnActivities).toEqual([]);
  h.draft("retry B");
  h.click("Send");
  expect(h.current.activity).toBe("thinking");
  h.click("Abort");
  await waitFor(() => expect(h.current.sending).toBe(false));
  expect(h.current.activity).toBe("idle");
  expect(h.current.turnActivities).toEqual([]);
});

/**
 * `Watch again` names a *subscription*, and the server keys a bot's canonical
 * one on no session at all (`chat-owner.ts` `keyOf`).
 *
 * Every other address in this store is `resolvedSession ?? target.session`
 * because those calls *read* a conversation, and a read wants the concrete
 * session. Sending that here asked the server for a conversation it does not
 * hold: it pinned a second upstream observation of one conversation, left the
 * canonical key's remembered failure standing so the band never cleared, and
 * lost the new subscription again at the next reconcile.
 */
test("a canonical thread resumes by its identity, not by the session it resolved", async () => {
  const resumes: Array<string | null | undefined> = [];
  let current!: Chat;
  const api: ChatApi = {
    fetchSwarms: async () => ({ swarms: [] }) as never,
    fetchSessions: async () => ({ sessions: [] }) as never,
    // The read resolves a session id, which is what fills `resolvedSession`.
    fetchHistory: async () =>
      ({ instance: "atlas", bot: "default", session: "s1", messages: [] }) as ChatHistoryResult,
    sendTurn: () => () => {},
    abortTurn: async () => ({ aborted: true }) as never,
    resumeObservation: async (instance: string, bot: string, session?: string | null) => {
      resumes.push(session);
      return {
        instance,
        bot,
        session: session ?? null,
        observing: true,
        restarted: true,
        listening: true,
      } as never;
    },
  };
  function Probe() {
    current = useChat();
    return null;
  }
  render(
    <ChatProvider api={api} eager={false}>
      <Probe />
    </ChatProvider>,
  );
  await act(async () => {
    current.select("atlas", "default");
  });
  await waitFor(() => expect(current.historyRead).toBe(true));

  await act(async () => {
    await current.resumeObservation();
  });

  expect(resumes).toEqual([null]);
});

/**
 * A row the box wrote down for the turn that is streaming, shaped like the ones
 * a real fleet box delivered mid-turn: an id of its own (never the live
 * message's), the box's own stamp, and a turn split across a `bot` row that
 * opened a tool call, a `system` row that closed it and prose at the end.
 */
function durable(
  id: string,
  role: "user" | "bot" | "system",
  at: number,
  blocks: unknown[],
  session = "A",
): ChatMessageView {
  return {
    id,
    session,
    role,
    author: null,
    at: new Date(at).toISOString(),
    blocks,
    usage: null,
    error: null,
    incomplete: null,
  } as unknown as ChatMessageView;
}

const TOOL = { kind: "tool", name: "terminal", args: { command: "ls" }, state: "done" };

/** Ids the box named, in order. The optimistic prompt is not one of them. */
const recorded = (messages: readonly ChatMessageView[]) =>
  messages.filter((m) => !m.id.startsWith("local:")).map((m) => m.id);

test("rows the box records while a turn streams wait for the turn to end", async () => {
  const h = setup();
  await h.choose("A");
  const base = Date.now();
  h.draft("ask A");
  h.click("Send");
  await h.frame(0, "working on it");
  // The box's copy of the prompt comes back first — already accounted for by
  // the placeholder — and then the turn it is writing down as it runs.
  await h.deliver("A", {
    type: "message",
    message: durable("341", "user", base + 250, [{ kind: "text", markdown: "ask A" }]),
  } as ChatObserveView);
  await h.deliver("A", {
    type: "message",
    message: durable("342", "bot", base + 5_000, []),
  } as ChatObserveView);
  await h.deliver("A", {
    type: "message",
    message: durable("343", "system", base + 5_200, [TOOL]),
  } as ChatObserveView);
  expect(recorded(h.current.messages)).toEqual(["341"]);
  expect(h.current.live?.blocks).toEqual([{ kind: "text", markdown: "working on it" }]);
  // One turn, one group: the defect was the held rows and the live message
  // drawing the same reply twice under one avatar.
  const live = h.current.live!;
  const rows = turnRows([...h.current.messages, live], Date.now(), { breakBefore: live.id });
  expect(rows.filter((row) => row.message.role !== "user")).toHaveLength(1);
  h.transcripts.set("A", [
    durable("341", "user", base + 250, [{ kind: "text", markdown: "ask A" }]),
    durable("342", "bot", base + 5_000, []),
    durable("343", "system", base + 5_200, [TOOL]),
    durable("344", "bot", base + 7_700, [{ kind: "text", markdown: "done" }]),
  ]);
  await act(async () => h.turns[0]!.handlers.onEnd(true, null));
  await waitFor(() => expect(recorded(h.current.messages)).toEqual(["341", "342", "343", "344"]));
  expect(h.current.live).toBeNull();
});

test("a dropped turn gives its held rows back even when no re-read answers", async () => {
  const h = setup();
  await h.choose("A");
  const base = Date.now();
  h.draft("ask A");
  h.click("Send");
  await h.frame(0, "half an answer");
  await h.deliver("A", {
    type: "message",
    message: durable("352", "bot", base + 5_000, []),
  } as ChatObserveView);
  await h.deliver("A", {
    type: "message",
    message: durable("353", "system", base + 5_200, [TOOL]),
  } as ChatObserveView);
  expect(recorded(h.current.messages)).toEqual([]);
  // The re-read the settle fires never answers, so the released rows are the
  // only copy this browser holds of what the box recorded.
  h.held.set("A", deferred<ChatHistoryResult>());
  await act(async () =>
    h.turns[0]!.handlers.onEnd(false, { code: "STREAM_DROPPED", message: "dropped" }),
  );
  expect(recorded(h.current.messages)).toEqual(["352", "353"]);
  expect(h.current.live?.incomplete).toBe(true);
});

/**
 * A turn whose box socket drops now continues from its cursor (design.md §9.2):
 * core reconnects, replays what the stream missed and keeps emitting into the
 * same reply, telling the operator so through a replaceable status block. That
 * is not this browser's drop, and nothing here may treat it as one — the turn
 * has not ended, so the held rows stay held, no transcript read fires, and the
 * one read that does happen is the one at the turn's true end.
 */
test("a reconnect status mid-turn is a snapshot, not an ending", async () => {
  const h = setup();
  await h.choose("A");
  const base = Date.now();
  const reads = h.reads.length;
  h.draft("ask A");
  h.click("Send");
  await h.frame(0, "half an ", 1);
  await h.frame(0, "answer", 2);
  await h.deliver("A", {
    type: "message",
    message: durable("381", "bot", base + 5_000, []),
  } as ChatObserveView);
  const status = (state: "running" | "done" | "warning", title: string, detail: string | null) =>
    act(async () =>
      h.turns[0]!.handlers.onFrame({
        type: "block",
        message: "reply-0",
        seq: 2,
        block: {
          kind: "activity",
          category: "connection",
          key: "connection:reconnect",
          role: "status",
          state,
          title,
          detail,
          request_id: null,
        },
      } as ChatFrameView),
    );
  await status("running", "Reconnecting\u2026", "attempt 1 of 5");
  expect(h.current.sending).toBe(true);
  expect(h.current.reconnecting).toBe(false);
  // `dropped` is not a view field; the mark it leaves on the reply is.
  expect(h.current.live?.incomplete ?? null).toBeNull();
  // The row the box recorded is still held: the live message has not stopped
  // speaking for it, because the turn has not stopped.
  expect(recorded(h.current.messages)).toEqual([]);
  expect(h.reads.length).toBe(reads);
  const statusBlock = h.current.live?.blocks.find((block) => block.kind === "activity");
  expect(statusBlock).toMatchObject({ key: "connection:reconnect", state: "running" });
  // The continuation: one snapshot replacing the other on the same key, then
  // the rest of the reply on the socket that came back.
  await status("done", "Reconnected", null);
  await h.frame(0, " at last", 3);
  expect(h.current.live?.blocks.filter((block) => block.kind === "activity")).toHaveLength(1);
  expect(h.current.live?.blocks.find((block) => block.kind === "activity")).toMatchObject({
    state: "done",
  });
  h.transcripts.set("A", [durable("381", "bot", base + 5_000, [])]);
  await act(async () =>
    h.turns[0]!.handlers.onFrame({ type: "done", message: "reply-0", seq: 4 } as ChatFrameView),
  );
  await act(async () => h.turns[0]!.handlers.onEnd(true, null));
  await waitFor(() => expect(recorded(h.current.messages)).toEqual(["381"]));
  // Exactly one read, at the true end — the status frames bought none of their own.
  expect(h.reads.length).toBe(reads + 1);
  expect(h.current.reconnecting).toBe(false);
  expect(h.current.sending).toBe(false);
});

test("a row well before the turn is appended while it streams, not held", async () => {
  const h = setup();
  await h.choose("A");
  const base = Date.now();
  h.draft("ask A");
  h.click("Send");
  await h.frame(0, "working on it");
  await h.deliver("A", {
    type: "message",
    // Older than `HOLD_BEHIND_MS`, which is wide on purpose: the window has to
    // survive a box whose clock disagrees with this laptop's by a lot.
    message: durable("300", "bot", base - 10 * 60_000, [{ kind: "text", markdown: "earlier" }]),
  } as ChatObserveView);
  expect(recorded(h.current.messages)).toEqual(["300"]);
});

test("aborting mid-turn hands the held rows back, with no re-read to recover them", async () => {
  const h = setup();
  await h.choose("A");
  const base = Date.now();
  h.draft("ask A");
  h.click("Send");
  await h.frame(0, "half an answer");
  await h.deliver("A", {
    type: "message",
    message: durable("362", "bot", base + 5_000, []),
  } as ChatObserveView);
  await h.deliver("A", {
    type: "message",
    message: durable("363", "system", base + 5_200, [TOOL]),
  } as ChatObserveView);
  expect(recorded(h.current.messages)).toEqual([]);
  // The transcript read the abort fires never answers, so anything the abort
  // path drops is gone for good.
  h.held.set("A", deferred<ChatHistoryResult>());
  h.click("Abort");
  await act(async () => {});
  expect(h.current.sending).toBe(false);
  expect(recorded(h.current.messages)).toEqual(["362", "363"]);
});

test("a snapshot mid-hold does not double the rows it already carries", async () => {
  const h = setup();
  await h.choose("A");
  const base = Date.now();
  h.draft("ask A");
  h.click("Send");
  await h.frame(0, "half an answer");
  await h.deliver("A", {
    type: "message",
    message: durable("372", "bot", base + 5_000, []),
  } as ChatObserveView);
  await h.deliver("A", {
    type: "message",
    message: durable("373", "system", base + 5_200, [TOOL]),
  } as ChatObserveView);
  // The box's own snapshot, taken after the first held row and before the
  // second: one of the two is already in it.
  await h.deliver("A", {
    type: "snapshot",
    session: "A",
    messages: [durable("372", "bot", base + 5_000, [])],
  } as ChatObserveView);
  h.held.set("A", deferred<ChatHistoryResult>());
  await act(async () => h.turns[0]!.handlers.onEnd(false, { code: "DROPPED", message: "gone" }));
  // Once each: the snapshot's copy is not appended a second time by the
  // release, and the row the snapshot missed is not lost by it either.
  expect(recorded(h.current.messages)).toEqual(["372", "373"]);
});

test("a rollover mid-hold leaves the rows with the session they were recorded in", async () => {
  const h = setup();
  await h.choose("A");
  const base = Date.now();
  h.draft("ask A");
  h.click("Send");
  await h.frame(0, "half an answer");
  await h.deliver("A", {
    type: "message",
    message: durable("382", "bot", base + 5_000, []),
  } as ChatObserveView);
  await h.deliver("A", {
    type: "message",
    message: durable("383", "system", base + 5_200, [TOOL]),
  } as ChatObserveView);
  // The box archives `A` and answers from `B` while the turn is still running.
  await h.deliver("A", {
    type: "snapshot",
    session: "B",
    messages: [durable("400", "bot", base + 6_000, [{ kind: "text", markdown: "new room" }], "B")],
  } as ChatObserveView);
  // The selection still names `A`, which now resolves to the copy the rollover
  // archived — and that copy has the rows, once each.
  expect(recorded(h.current.messages)).toEqual(["382", "383"]);
  // `B` is what the record went on to hold, and `A`'s rows did not follow it
  // there. Its read is held open, so this is what the rollover left rather than
  // what a later read fetched.
  h.held.set("B", deferred<ChatHistoryResult>());
  await h.choose("B");
  expect(recorded(h.current.messages)).toEqual(["400"]);
});
