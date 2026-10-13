import {
  type ConversationArrival,
  type ConversationTarget,
  type ConversationTransport,
  ConversationStore,
  accountsFor,
  insertByStamp,
  reconnectDelayMs,
  stillPending,
} from "../../src/client/conversation-store.ts";
import { HermeticError } from "@hermetic/core/chat-client";
import type { ChatMessage, ChatObserveEvent } from "@hermetic/core/chat-client";
import type { HistoryResult, SteerStatus, TurnRequest } from "../../src/client/chat-types.ts";
import { FakeTimers, flush } from "../helpers/fakes.ts";
import { approval, block, delta, done, errorFrame, msg, subagent, tool } from "../helpers/fixtures.ts";

const T: ConversationTarget = { instance: "atlas", bot: "scribe", session: null };

interface Deferred<V> {
  promise: Promise<V>;
  resolve: (v: V) => void;
  reject: (e: unknown) => void;
}
function deferred<V>(): Deferred<V> {
  let resolve!: (v: V) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<V>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup() {
  const timers = new FakeTimers();
  const history: HistoryResult = { instance: "atlas", bot: "scribe", session: "s-1", messages: [] };
  const calls: { method: string; input: unknown }[] = [];
  const starts: { turn: TurnRequest; d: Deferred<{ turn_id: string }> }[] = [];
  let steerStatus: SteerStatus = "redirected";
  let observer: {
    event: (e: ChatObserveEvent) => void;
    end: (e: { code: string; message: string } | null) => void;
  } | null = null;
  let historyFails = 0;
  let opens = 0;
  let historyFailCode = "CHAT_UNREACHABLE";
  let abortTurnAnswer: unknown = {};
  const transport: ConversationTransport = {
    history: async (input) => {
      calls.push({ method: "chat.history", input });
      if (historyFails > 0) {
        historyFails -= 1;
        throw new HermeticError(
          historyFailCode as "NOT_FOUND",
          historyFailCode === "NOT_FOUND" ? "Profile not found" : "offline",
        );
      }
      return { ...history, messages: [...history.messages] };
    },
    sessions: async (input) => {
      calls.push({ method: "chat.sessions", input });
      return { instance: "atlas", bot: "scribe", sessions: [] };
    },
    startTurn: (turn) => {
      calls.push({ method: "turn.start", input: turn });
      const d = deferred<{ turn_id: string }>();
      starts.push({ turn, d });
      return d.promise;
    },
    abortTurn: async (turn_id) => {
      calls.push({ method: "turn.abort", input: turn_id });
      return abortTurnAnswer;
    },
    abort: async (input) => {
      calls.push({ method: "chat.abort", input });
      return { instance: "atlas", bot: "scribe", aborted: true };
    },
    steer: async (input) => {
      calls.push({ method: "chat.steer", input });
      return { instance: "atlas", bot: "scribe", status: steerStatus };
    },
    respond: async (input) => {
      calls.push({ method: "chat.respond", input });
      return { status: "ok" };
    },
    forgetTurn: (turn_id) => {
      calls.push({ method: "forget", input: turn_id });
    },
    observe: (_target, handlers) => {
      observer = handlers;
      opens += 1;
      return () => {
        observer = null;
      };
    },
  };
  const settled: unknown[] = [];
  const requests: unknown[] = [];
  const arrivals: ConversationArrival[] = [];
  const store = new ConversationStore({
    transport,
    timers,
    onTurnSettled: (_t, outcome) => settled.push(outcome),
    onRequestOpened: (_t, r) => requests.push(r),
    onArrival: (_t, a) => arrivals.push(a),
  });
  return {
    store,
    timers,
    history,
    calls,
    starts,
    settled,
    requests,
    arrivals,
    view: () => store.view(T),
    setSteer: (s: SteerStatus) => {
      steerStatus = s;
    },
    setAbortTurn: (answer: unknown) => {
      abortTurnAnswer = answer;
    },
    failHistory: (n: number, code = "CHAT_UNREACHABLE") => {
      historyFails = n;
      historyFailCode = code;
    },
    observe: () => observer!,
    observing: () => observer !== null,
    opens: () => opens,
    method: (m: string) => calls.filter((c) => c.method === m),
  };
}

/** Send and let the transport answer with a turn id. */
async function started(s: ReturnType<typeof setup>, text = "hello", turn_id = "T1") {
  expect(s.store.send(T, text)).toBe(true);
  s.starts.at(-1)!.d.resolve({ turn_id });
  await flush();
}

describe("pure helpers", () => {
  test("reconnectDelayMs: 0, 1, 2, 4, 8 s", () => {
    expect([1, 2, 3, 4, 5, 6].map(reconnectDelayMs)).toEqual([0, 1000, 2000, 4000, 8000, 8000]);
  });

  test("accountsFor: same role and text, within -1 s / +5 min", () => {
    const local = msg({ id: "local:x", role: "user", text: "hi", at: "2026-10-13T10:00:00.000Z" });
    expect(
      accountsFor(msg({ role: "user", text: " hi ", at: "2026-10-13T10:00:00.500Z" }), local),
    ).toBe(true);
    expect(accountsFor(msg({ role: "user", text: "hi", at: "2026-10-13T09:59:58.000Z" }), local)).toBe(
      false,
    );
    expect(accountsFor(msg({ role: "user", text: "hi", at: "2026-10-13T10:05:01.000Z" }), local)).toBe(
      false,
    );
    expect(accountsFor(msg({ role: "bot", text: "hi" }), local)).toBe(false);
  });

  test("stillPending: one recorded row claims one placeholder", () => {
    const a = msg({ id: "local:a", role: "user", text: "same" });
    const b = msg({ id: "local:b", role: "user", text: "same", at: "2026-10-13T10:00:01.000Z" });
    const echo = msg({ id: "u1", role: "user", text: "same", at: "2026-10-13T10:00:00.200Z" });
    expect(stillPending([a, b], [echo]).map((m) => m.id)).toEqual(["local:b"]);
  });

  test("insertByStamp keeps time order", () => {
    const rows = insertByStamp(
      [
        msg({ id: "1", at: "2026-10-13T10:00:00.000Z" }),
        msg({ id: "3", at: "2026-10-13T10:00:02.000Z" }),
      ],
      [msg({ id: "2", at: "2026-10-13T10:00:01.000Z" })],
    );
    expect(rows.map((m) => m.id)).toEqual(["1", "2", "3"]);
  });
});

describe("sending and streaming", () => {
  test("optimistic prompt, then frames fold into live, then history replaces both", async () => {
    const s = setup();
    s.store.open(T);
    await flush();
    await started(s, "hello");
    let v = s.view();
    expect(v.sending).toBe(true);
    expect(v.activity).toBe("thinking");
    expect(v.messages.at(-1)).toMatchObject({
      role: "user",
      blocks: [{ kind: "text", markdown: "hello" }],
    });
    expect(v.messages.at(-1)!.id.startsWith("local:")).toBe(true);
    expect(v.turnId).toBe("T1");

    s.store.onTurnFrame("T1", 1, delta(0, "Hi "));
    s.store.onTurnFrame("T1", 2, delta(1, "there"));
    v = s.view();
    expect(v.activity).toBe("streaming");
    expect(v.live?.blocks).toEqual([{ kind: "text", markdown: "Hi there" }]);

    const at = new Date(s.timers.now()).toISOString();
    s.history.messages = [
      msg({ id: "u1", role: "user", text: "hello", at }),
      msg({ id: "m1", role: "bot", text: "Hi there", at }),
    ];
    s.store.onTurnFrame("T1", 3, done(2));
    s.store.onTurnEnd("T1", "done");
    await flush();
    v = s.view();
    expect(v.sending).toBe(false);
    expect(v.live).toBeNull();
    expect(v.messages.map((m) => m.id)).toEqual(["u1", "m1"]);
    expect(s.settled).toEqual([expect.objectContaining({ ok: true, turnId: "T1" })]);
  });

  test("a second send while a turn runs is refused", async () => {
    const s = setup();
    await started(s);
    expect(s.store.send(T, "again")).toBe(false);
    expect(s.store.send(T, "   ")).toBe(false);
  });

  test("frames that beat the turn.start answer are held and replayed", async () => {
    const s = setup();
    s.store.send(T, "hello");
    s.store.onTurnFrame("T1", 1, delta(0, "early"));
    s.starts[0]!.d.resolve({ turn_id: "T1" });
    await flush();
    expect(s.view().live?.blocks).toEqual([{ kind: "text", markdown: "early" }]);
  });

  test("tool running → ok, approval replay, subagent replace — through the store", async () => {
    const s = setup();
    await started(s);
    s.store.onTurnFrame("T1", 1, block(0, tool()));
    s.store.onTurnFrame("T1", 2, block(1, tool({ status: "ok" })));
    s.store.onTurnFrame("T1", 3, block(2, subagent()));
    s.store.onTurnFrame("T1", 4, block(3, subagent({ verdict: "done", status: "completed" })));
    s.store.onTurnFrame("T1", 5, block(4, approval()));
    s.store.onTurnFrame("T1", 6, block(4, approval()));
    const v = s.view();
    expect(v.live?.blocks.map((b) => b.kind)).toEqual(["tool", "subagent", "approval"]);
    expect(v.openRequests).toEqual(["r1"]);
    expect(s.requests).toHaveLength(1);
  });

  test("an error frame and turn.end error set turnError and park the queue", async () => {
    const s = setup();
    await started(s);
    s.store.enqueue(T, "next");
    s.store.onTurnFrame("T1", 1, errorFrame("RATE_LIMITED", "slow down"));
    s.store.onTurnEnd("T1", "error");
    await flush();
    const v = s.view();
    expect(v.turnError).toEqual({ code: "RATE_LIMITED", message: "slow down" });
    expect(v.sending).toBe(false);
    expect(v.queueParked).toBe(true);
    expect(s.method("turn.start")).toHaveLength(1);
  });

  test("a refused start surfaces its code", async () => {
    const s = setup();
    s.store.send(T, "hello");
    s.starts[0]!.d.reject(new HermeticError("VALIDATION", "atlas is not an agent of the paired fleet"));
    await flush();
    expect(s.view().turnError).toEqual({
      code: "VALIDATION",
      message: "atlas is not an agent of the paired fleet",
    });
  });

  test("a turn whose stream ended without saying how is never re-sent: history is re-read with backoff", async () => {
    const s = setup();
    await started(s);
    s.failHistory(2);
    s.store.onTurnGone("T1");
    await flush();
    expect(s.view().reconnecting).toBe(true);
    expect(s.view().dropped).toBe(true);
    s.timers.advance(0);
    await flush();
    expect(s.view().reconnectAttempt).toBe(2);
    s.timers.advance(1000);
    await flush();
    expect(s.view().reconnectAttempt).toBe(3);
    s.timers.advance(2000);
    await flush();
    expect(s.view().reconnecting).toBe(false);
    expect(s.method("turn.start")).toHaveLength(1);
  });

  test("a gone turn re-reads history", async () => {
    const s = setup();
    await started(s);
    s.store.onTurnGone("T1");
    await flush();
    expect(s.view().sending).toBe(false);
    s.timers.advance(0);
    await flush();
    expect(s.method("chat.history").length).toBeGreaterThan(0);
    expect(s.view().reconnecting).toBe(false);
  });

  test("a quiet turn is never dropped by a clock: no forget, no interrupt, still running", async () => {
    const s = setup();
    await started(s);
    s.store.onTurnFrame("T1", 1, block(0, tool()));
    s.timers.advance(60 * 60_000);
    await flush();
    expect(s.view().sending).toBe(true);
    expect(s.view().dropped).toBe(false);
    expect(s.method("forget")).toEqual([]);
    expect(s.method("turn.abort")).toEqual([]);
    expect(s.timers.pending()).toBe(0);
    s.store.onTurnFrame("T1", 2, done(1));
    s.store.onTurnEnd("T1", "done");
    await flush();
    expect(s.view().sending).toBe(false);
  });
});

describe("stop, steer, queue", () => {
  test("stop aborts by turn id, parks the queue, re-reads history", async () => {
    const s = setup();
    await started(s);
    s.store.enqueue(T, "after");
    await s.store.stop(T);
    expect(s.method("turn.abort")).toEqual([{ method: "turn.abort", input: "T1" }]);
    expect(s.method("forget")).toHaveLength(1);
    const v = s.view();
    expect(v.sending).toBe(false);
    expect(v.queue.map((q) => q.text)).toEqual(["after"]);
    expect(v.queueParked).toBe(true);
    // Late frames for the stopped turn are ignored.
    s.store.onTurnFrame("T1", 9, delta(9, "late"));
    expect(s.view().live?.blocks ?? []).not.toContainEqual({ kind: "text", markdown: "late" });
  });

  test("stop after suspend detached the turn goes by its session, never the pump", async () => {
    const s = setup();
    await started(s);
    s.store.onTurnSession("T1", "s-1");
    s.store.suspend();
    s.store.enqueue(T, "after");
    await s.store.stop(T);
    expect(s.method("turn.abort")).toEqual([]);
    expect(s.method("chat.abort").map((c) => c.input)).toEqual([
      { instance: "atlas", bot: "scribe", session: "s-1" },
    ]);
    expect(s.view()).toMatchObject({ sending: false, queueParked: true });
    expect(s.method("turn.start")).toHaveLength(1);
  });

  test("stop whose pump the transport no longer holds falls back to the session", async () => {
    const s = setup();
    await started(s);
    s.store.onTurnSession("T1", "s-1");
    s.setAbortTurn(false);
    await s.store.stop(T);
    expect(s.method("turn.abort")).toHaveLength(1);
    expect(s.method("chat.abort").map((c) => c.input)).toEqual([
      { instance: "atlas", bot: "scribe", session: "s-1" },
    ]);
  });

  test("stop before the turn id is known falls back to chat.abort by its session", async () => {
    const s = setup();
    s.store.open(T);
    await flush();
    s.store.send(T, "hello");
    await s.store.stop(T);
    expect(s.method("chat.abort").map((c) => c.input)).toEqual([
      { instance: "atlas", bot: "scribe", session: "s-1" },
    ]);
    // The transport answers afterwards: nobody follows that turn.
    s.starts[0]!.d.resolve({ turn_id: "T7" });
    await flush();
    expect(s.method("forget")).toEqual([{ method: "forget", input: "T7" }]);
  });

  test("stop with no session never sends an unscoped chat.abort", async () => {
    // Before the start answers: stopped by the id it answers with.
    const s = setup();
    s.store.send(T, "hello");
    await s.store.stop(T);
    expect(s.method("chat.abort")).toEqual([]);
    expect(s.view()).toMatchObject({ sending: false, turnError: null });
    s.starts[0]!.d.resolve({ turn_id: "T7" });
    await flush();
    expect(s.method("turn.abort").map((c) => c.input)).toEqual(["T7"]);
    expect(s.method("forget")).toEqual([]);

    // A pump the transport no longer holds: refused, with the reason.
    const p = setup();
    await started(p);
    p.setAbortTurn(false);
    await p.store.stop(T);
    expect(p.method("turn.abort")).toHaveLength(1);
    expect(p.method("chat.abort")).toEqual([]);
    expect(p.view().turnError).toEqual({
      code: "ABORT_FAILED",
      message: "This conversation has no session yet, so the turn cannot be stopped from here.",
    });
  });

  test("the queue drains one message at a time when the turn ends", async () => {
    const s = setup();
    await started(s);
    s.store.enqueue(T, "two");
    s.store.enqueue(T, "three");
    expect(s.view().queue).toHaveLength(2);
    s.store.onTurnEnd("T1", "done");
    await flush();
    expect(s.method("turn.start").map((c) => (c.input as TurnRequest).message)).toEqual([
      "hello",
      "two",
    ]);
    expect(s.view().queue.map((q) => q.text)).toEqual(["three"]);
  });

  test("a deliberate send unparks the queue", async () => {
    const s = setup();
    await started(s);
    s.store.enqueue(T, "queued");
    await s.store.stop(T);
    expect(s.view().queueParked).toBe(true);
    expect(s.store.sendMessage(T, "fresh")).toBe(true);
    expect(s.view().queueParked).toBe(false);
    s.starts.at(-1)!.d.resolve({ turn_id: "T2" });
    await flush();
    s.store.onTurnEnd("T2", "done");
    await flush();
    expect(s.method("turn.start").map((c) => (c.input as TurnRequest).message)).toEqual([
      "hello",
      "fresh",
      "queued",
    ]);
  });

  test("steer redirected: the reply so far closes and the steer prompt sits under it", async () => {
    const s = setup();
    await started(s);
    s.store.onTurnFrame("T1", 1, delta(0, "Working on it"));
    expect(await s.store.steer(T, "focus on tests")).toBe("redirected");
    const v = s.view();
    expect(v.live).toBeNull();
    const ids = v.messages.map((m) => m.id);
    expect(ids.some((id) => id === "m1~1")).toBe(true);
    expect(v.messages.at(-1)!.id.startsWith("local:steer:")).toBe(true);
    s.store.onTurnFrame("T1", 2, delta(1, "OK, tests."));
    expect(s.view().live?.blocks).toEqual([{ kind: "text", markdown: "OK, tests." }]);
  });

  test("a tool finishing after a steer lands on its own segment", async () => {
    const s = setup();
    await started(s);
    s.store.onTurnFrame("T1", 1, block(0, tool()));
    await s.store.steer(T, "also this");
    s.store.onTurnFrame("T1", 2, block(1, tool({ status: "ok" })));
    const v = s.view();
    expect(v.live).toBeNull();
    const segment = v.messages.find((m) => m.id === "m1~1");
    expect(segment?.blocks[0]).toMatchObject({ kind: "tool", status: "ok" });
  });

  test("send now while running: steer; rejected → head of queue, unpark, abort, drain", async () => {
    const s = setup();
    await started(s);
    s.store.enqueue(T, "later");
    s.setSteer("rejected");
    expect(await s.store.sendNow(T, "urgent")).toBe("rejected");
    expect(s.method("turn.abort")).toHaveLength(1);
    await flush();
    expect(s.method("turn.start").map((c) => (c.input as TurnRequest).message)).toEqual([
      "hello",
      "urgent",
    ]);
    expect(s.view().queue.map((q) => q.text)).toEqual(["later"]);
  });

  test("send now on a queued row while idle sends it and removes it", async () => {
    const s = setup();
    const row = s.store.enqueue(T, "queued");
    // Idle with nothing parked: enqueue drained it at once.
    expect(row).not.toBeNull();
    expect(s.method("turn.start")).toHaveLength(1);
  });

  test("send now idle → plain send", async () => {
    const s = setup();
    expect(await s.store.sendNow(T, "now")).toBe("sent");
    expect(s.method("turn.start")).toHaveLength(1);
  });
});

describe("requests", () => {
  test("respond sends chat.respond with the session and releases the request", async () => {
    const s = setup();
    s.store.open(T);
    await flush();
    await started(s);
    s.store.onTurnFrame("T1", 1, block(0, approval()));
    await s.store.respond(T, { request_id: "r1", kind: "approval", choice: "once" });
    expect(s.method("chat.respond")[0]!.input).toEqual({
      request_id: "r1",
      kind: "approval",
      choice: "once",
      instance: "atlas",
      bot: "scribe",
      session: "s-1",
    });
    expect(s.view().openRequests).toEqual([]);
    // The box replays the approval: it stays released.
    s.store.onTurnFrame("T1", 2, block(1, approval()));
    expect(s.view().openRequests).toEqual([]);
  });

  test("respond with no resolved session is refused here, and nothing is sent", async () => {
    const s = setup();
    expect(s.store.send(T, "hello")).toBe(true);
    s.store.onTurnFrame("T1", 1, block(0, approval()));
    await expect(
      s.store.respond(T, { request_id: "r1", kind: "approval", choice: "once" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(s.method("chat.respond")).toEqual([]);
  });
});

describe("observation", () => {
  test("a durable message replaces its optimistic placeholder instead of drawing twice", async () => {
    const s = setup();
    s.store.open(T);
    await flush();
    s.store.send(T, "hello");
    const at = new Date(s.timers.now()).toISOString();
    s.observe().event({
      type: "message",
      instance: "atlas",
      bot: "scribe",
      session: "s-1",
      message: msg({ id: "u1", role: "user", text: "hello", at }),
    });
    const users = s.view().messages.filter((m) => m.role === "user");
    expect(users.map((m) => m.id)).toEqual(["u1"]);
  });

  test("bot rows observed during the turn are held until it settles", async () => {
    const s = setup();
    s.store.open(T);
    await flush();
    await started(s);
    const at = new Date(s.timers.now()).toISOString();
    s.observe().event({
      type: "message",
      instance: "atlas",
      bot: "scribe",
      session: "s-1",
      message: msg({ id: "cron", role: "bot", text: "routine", at }),
    });
    expect(s.view().messages.some((m) => m.id === "cron")).toBe(false);
    // The re-read after the stop fails, so what is shown is the cache plus the released rows.
    s.failHistory(1);
    await s.store.stop(T);
    expect(s.view().messages.some((m) => m.id === "cron")).toBe(true);
  });

  test("a failed read keeps its code, and a good read clears it", async () => {
    const s = setup();
    s.failHistory(1, "NOT_FOUND");
    s.store.open(T);
    await flush();
    expect(s.view()).toMatchObject({
      history: "failed",
      historyCode: "NOT_FOUND",
      historyError: "Profile not found",
    });
    await s.store.reload(T);
    expect(s.view()).toMatchObject({ history: "ready", historyCode: null, historyError: null });
  });

  test("a snapshot on a new session rolls the conversation over", async () => {
    const s = setup();
    s.store.open(T);
    await flush();
    expect(s.view().resolvedSession).toBe("s-1");
    s.observe().event({
      type: "snapshot",
      instance: "atlas",
      bot: "scribe",
      session: "s-2",
      messages: [msg({ id: "x", session: "s-2" })],
      at: "2026-10-13T10:00:00.000Z",
    });
    const v = s.view();
    expect(v.resolvedSession).toBe("s-2");
    expect(v.rolledOverFrom).toBe("s-1");
    expect(v.messages.map((m) => m.id)).toEqual(["x"]);
  });

  test("messages observed before history are absorbed into it", async () => {
    const s = setup();
    s.store.open(T); // history in flight
    s.observe().event({
      type: "message",
      instance: "atlas",
      bot: "scribe",
      session: "s-1",
      message: msg({ id: "early", at: "2026-10-13T11:00:00.000Z" }),
    });
    await flush();
    expect(s.view().messages.map((m) => m.id)).toEqual(["early"]);
  });

  test("reconnect advisory decays to live after 10 s of quiet; error is terminal", async () => {
    const s = setup();
    s.store.open(T);
    s.observe().event({
      type: "reconnect",
      instance: "atlas",
      bot: "scribe",
      attempt: 1,
      delay_ms: 1000,
      code: "UPSTREAM",
      message: "retrying",
    });
    expect(s.view().observe).toBe("reconnecting");
    s.timers.advance(10_000);
    expect(s.view().observe).toBe("live");
    s.observe().event({
      type: "error",
      instance: "atlas",
      bot: "scribe",
      code: "NOT_LISTENING",
      message: "off",
    });
    expect(s.view().observe).toBe("failed");
    expect(s.view().observeError?.code).toBe("NOT_LISTENING");
  });

  test("a subagent event updates its block in the transcript", async () => {
    const s = setup();
    s.history.messages = [{ ...msg({ id: "m0" }), blocks: [subagent()] } as ChatMessage];
    s.store.open(T);
    await flush();
    s.observe().event({
      type: "subagent",
      instance: "atlas",
      bot: "scribe",
      session: "s-1",
      block: subagent({ verdict: "done", status: "completed", summary: "found it" }),
    });
    expect(s.view().messages[0]!.blocks[0]).toMatchObject({ verdict: "done", summary: "found it" });
  });

  test("leave parks the queue and closes the observation", async () => {
    const s = setup();
    s.store.open(T);
    await started(s);
    s.store.enqueue(T, "q");
    s.store.leave(T);
    expect(s.view().observe).toBe("off");
    expect(s.view().queueParked).toBe(true);
  });
});

describe("observation ends", () => {
  test("a terminal end fails the band, and opening again starts a new observation", async () => {
    const s = setup();
    s.store.open(T);
    await flush();
    const first = s.observe();
    first.end({ code: "CHAT_UNREACHABLE", message: "gone" });
    expect(s.view().observe).toBe("failed");
    expect(s.view().observeError?.code).toBe("CHAT_UNREACHABLE");
    s.store.open(T);
    expect(s.observe()).not.toBe(first);
    expect(s.view().observe).toBe("live");
  });

  test("open is idempotent while one runs; reopen restarts it whatever its state", async () => {
    const s = setup();
    s.store.open(T);
    s.store.open(T);
    expect(s.opens()).toBe(1);
    s.store.reopen(T);
    expect(s.opens()).toBe(2);
    expect(s.view().observe).toBe("live");
    s.observe().end({ code: "CHAT_UNREACHABLE", message: "gone" });
    expect(s.view().observe).toBe("failed");
    s.store.reopen(T);
    expect(s.opens()).toBe(3);
    expect(s.view()).toMatchObject({ observe: "live", observeError: null });
  });

  test("suspend closes every observation; resume re-opens only what is still on screen", async () => {
    const s = setup();
    const other: ConversationTarget = { instance: "atlas", bot: "other", session: null };
    s.store.open(T);
    s.store.open(other);
    s.store.leave(other);
    s.store.suspend();
    expect(s.observing()).toBe(false);
    expect(s.view().observe).toBe("off");
    const before = s.opens();
    s.store.resume();
    expect(s.opens()).toBe(before + 1);
    expect(s.view().observe).toBe("live");
    expect(s.store.view(other).observe).toBe("off");
  });

  test("endObservations ends without failing, says why, and resume brings it back", async () => {
    const s = setup();
    s.store.open(T);
    s.store.endObservations((t) => t.instance === "atlas", {
      code: "UNLISTENED",
      message: "not listening",
    });
    expect(s.observing()).toBe(false);
    expect(s.view()).toMatchObject({ observe: "off", observeError: { code: "UNLISTENED" } });
    s.store.resume((t) => t.instance === "atlas");
    expect(s.view()).toMatchObject({ observe: "live", observeError: null });
  });
});

describe("the Bots row, ahead of the roster", () => {
  test("a finished turn reports the recorded reply's words, role and box stamp", async () => {
    const s = setup();
    s.store.open(T);
    await flush();
    await started(s, "hello");
    s.store.onTurnFrame("T1", 1, delta(0, "Hi there"));
    s.history.messages = [
      msg({ id: "u1", role: "user", text: "hello", at: "2026-10-13T10:00:00.000Z" }),
      msg({ id: "m1", role: "bot", text: "Hi\nthere", at: "2026-10-13T10:00:05.000Z" }),
    ];
    s.store.onTurnFrame("T1", 2, done(1));
    s.store.onTurnEnd("T1", "done");
    await flush();
    expect(s.arrivals).toEqual([
      {
        at: "2026-10-13T10:00:05.000Z",
        unread: false,
        preview: { preview: "Hi there", preview_role: "bot" },
      },
    ]);
  });

  test("an observed message moves the row once per id; a named session moves only the time", async () => {
    const s = setup();
    s.store.open(T);
    await flush();
    const message = msg({
      id: "x1",
      role: "bot",
      text: "from the desktop",
      at: "2026-10-13T11:00:00.000Z",
    });
    const event = {
      type: "message" as const,
      instance: "atlas",
      bot: "scribe",
      session: "s-1",
      message,
    };
    s.observe().event(event);
    s.observe().event(event);
    expect(s.arrivals).toEqual([
      {
        at: "2026-10-13T11:00:00.000Z",
        unread: false,
        preview: { preview: "from the desktop", preview_role: "bot" },
      },
    ]);

    const named = { ...T, session: "s-2" };
    s.store.open(named);
    await flush();
    s.observe().event({ ...event, message: { ...message, id: "x2" } });
    expect(s.arrivals.at(-1)).toEqual({ at: "2026-10-13T11:00:00.000Z", unread: false, preview: null });
  });
});
