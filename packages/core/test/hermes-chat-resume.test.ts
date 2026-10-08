/**
 * Cursor-driven turn continuation: what a turn does when its socket dies.
 *
 * The harness here is deliberately not the one in `hermes-chat.test.ts`. Every
 * assertion below is about *which socket* saw what, so each dial is scripted
 * separately — the shared harness scripts a box, and a reconnect test needs to
 * script two boxes' worth of answers that differ only in being the second one.
 *
 * Nothing waits: the reconnect's backoff is injected, so a five-attempt budget
 * costs no wall-clock at all.
 */
import { describe, expect, test } from "bun:test";
import { createHermesChat } from "../src/chat/hermes/hermes-chat.ts";
import type {
  BoxAddress,
  ChatFetch,
  ChatSocket,
  HermesChatDeps,
} from "../src/chat/hermes/hermes-chat.ts";
import { CHAT_ERROR_CODES, CHAT_RECONNECT_BLOCK_KEY } from "../src/chat/hermes/hermes-chat-types.ts";
import { ChatFrame } from "../src/schema/index.ts";
import type { ChatBlock } from "../src/schema/index.ts";
import {
  DASHBOARD_HTML,
  eventFrame,
  PROMPT_SUBMIT_RESULT,
  SESSION_CREATE_RESULT,
  SESSION_ID,
} from "./fixtures/hermes-frames.ts";

const BOX: BoxAddress = {
  instance: "veronica",
  baseUrl: "https://fxtr0001-veronica.tail0000.ts.net/",
  fleet_id: "fxtr0001",
};
const NOW = "2026-09-19T12:00:00.000Z";
/** The gateway's process-lifetime id. A reconnect that sees another one gave up. */
const EPOCH = "epoch-1";
/** Where the session's sequence stood when the turn started. */
const BASELINE = 40;
/** More dials than any test here should need; past it the fake refuses. */
const MAX_DIALS = 12;

/* ── the double ───────────────────────────────────────────────────────────── */

interface Dial {
  /** RPC method → result. A method with no entry answers `{}`. */
  results?: Record<string, unknown>;
  /** RPC method → JSON-RPC error object. */
  errors?: Record<string, { code: number; message: string }>;
  /** RPC method → raw frames pushed straight after its reply. */
  after?: Record<string, readonly string[]>;
  /** Methods this socket accepts and never answers. */
  hang?: readonly string[];
  /** Called as the request is written, before any reply — for aborting mid-handshake. */
  onSend?: (method: string) => void;
  /** This dial is refused, the way a token that died with the dashboard looks. */
  refuse?: boolean;
  /** Methods after whose reply this socket drops — a gateway that accepts and dies. */
  dropAfter?: readonly string[];
  /** This dial never opens and never fails: a box that is simply off the tailnet. */
  hangOpen?: boolean;
}

interface FakeSocket extends ChatSocket {
  sent: { id: number; method: string; params: Record<string, unknown> }[];
  methods(): string[];
  isClosed(): boolean;
}

function queue<T>(): { push(v: T): void; close(): void; drain(): AsyncIterable<T> } {
  const buffer: T[] = [];
  let done = false;
  let wake: (() => void) | null = null;
  const nudge = (): void => {
    const w = wake;
    wake = null;
    w?.();
  };
  return {
    push: (v) => {
      buffer.push(v);
      nudge();
    },
    close: () => {
      done = true;
      nudge();
    },
    async *drain() {
      for (;;) {
        while (buffer.length > 0) {
          const head = buffer.shift();
          if (head !== undefined) yield head;
        }
        if (done) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

interface Harness {
  deps: HermesChatDeps;
  sockets: FakeSocket[];
  /** Every backoff the pump asked for, and whether the wait finished. */
  sleeps: { ms: number; settled: boolean }[];
}

/** One script per dial, in dial order; the last entry repeats. */
function harness(
  dials: Dial[],
  tuning: {
    slotWaitMs?: number;
    interruptMs?: number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  } = {},
): Harness {
  const sockets: FakeSocket[] = [];
  const sleeps: { ms: number; settled: boolean }[] = [];

  const fetchImpl: ChatFetch = (input) =>
    Promise.resolve(
      new Response(String(input).includes("/api/sessions/") ? "{}" : DASHBOARD_HTML, {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

  const openSocket = (
    url: string,
    opts: { signal?: AbortSignal | undefined; headers?: Record<string, string> | undefined },
  ): ChatSocket => {
    // A hard stop on dialling, so a budget that failed to bound itself fails an
    // assertion instead of hanging the suite.
    const script =
      sockets.length >= MAX_DIALS
        ? { refuse: true }
        : (dials[Math.min(sockets.length, dials.length - 1)] ?? {});
    const q = queue<string>();
    let closed = false;
    const sent: { id: number; method: string; params: Record<string, unknown> }[] = [];
    const socket: FakeSocket = {
      sent,
      methods: () => sent.map((s) => s.method),
      isClosed: () => closed,
      opened: script.hangOpen
        ? new Promise<void>(() => {})
        : script.refuse
          ? Promise.reject(new Error(`chat socket failed: ${url}`))
          : Promise.resolve(),
      frames: q.drain(),
      send(data: string) {
        const doc = JSON.parse(data) as {
          id: number;
          method: string;
          params: Record<string, unknown>;
        };
        sent.push(doc);
        script.onSend?.(doc.method);
        if (script.hang?.includes(doc.method)) return;
        const failure = script.errors?.[doc.method];
        if (failure) q.push(JSON.stringify({ jsonrpc: "2.0", id: doc.id, error: failure }));
        else
          q.push(
            JSON.stringify({ jsonrpc: "2.0", id: doc.id, result: script.results?.[doc.method] ?? {} }),
          );
        for (const frame of script.after?.[doc.method] ?? []) q.push(frame);
        if (script.dropAfter?.includes(doc.method)) socket.close();
      },
      close() {
        closed = true;
        q.close();
      },
    };
    void opts;
    sockets.push(socket);
    return socket;
  };

  /**
   * The backoff, spent instantly — but still cancellable, because a wait that
   * ignores its signal is exactly the dangling timer these tests are for.
   */
  const sleep = (ms: number, signal?: AbortSignal): Promise<void> => {
    const record = { ms, settled: false };
    sleeps.push(record);
    if (signal?.aborted) {
      record.settled = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const done = (): void => {
        record.settled = true;
        signal?.removeEventListener("abort", done);
        resolve();
      };
      signal?.addEventListener("abort", done, { once: true });
      queueMicrotask(done);
    });
  };

  return {
    deps: {
      fetch: fetchImpl,
      openSocket,
      now: () => NOW,
      slotWaitMs: tuning.slotWaitMs ?? 200,
      resumeTuning: {
        attempts: 3,
        baseMs: 1,
        maxMs: 4,
        interruptMs: tuning.interruptMs ?? 50,
        sleep: tuning.sleep ?? sleep,
      },
    },
    sockets,
    sleeps,
  };
}

/** The probe answer a healthy gateway gives before the prompt is submitted. */
const PROBE = { events: [], latest_seq: BASELINE, truncated: false, epoch: EPOCH, count: 0 };

/** The first dial of a turn that is about to lose its socket. */
function opening(frames: readonly string[], extra: Partial<Dial> = {}, probe: unknown = PROBE): Dial {
  return {
    results: {
      "session.create": SESSION_CREATE_RESULT,
      "prompt.submit": PROMPT_SUBMIT_RESULT,
      "session.events.since": probe,
    },
    after: { "prompt.submit": frames },
    ...extra,
  };
}

/** A replayed event, which is a live event's params dict and nothing else. */
function replayEvent(type: string, seq: number, payload: unknown): Record<string, unknown> {
  return { type, session_id: SESSION_ID, payload, seq };
}

/** Run a turn, dropping the named socket the `n`th time a delta arrives. */
async function runDropping(
  deps: HermesChatDeps,
  sockets: FakeSocket[],
  afterDeltas: number,
  opts: { signal?: AbortSignal } = {},
): Promise<ChatFrame[]> {
  const out: ChatFrame[] = [];
  let deltas = 0;
  for await (const frame of createHermesChat(deps).send(BOX, "d", "go", opts)) {
    out.push(ChatFrame.parse(frame));
    if (frame.type === "delta") {
      deltas += 1;
      if (deltas === afterDeltas) sockets[0]?.close();
    }
  }
  return out;
}

const deltas = (frames: ChatFrame[]): string[] =>
  frames.flatMap((f) => (f.type === "delta" ? [f.text] : []));
const dones = (frames: ChatFrame[]): ChatFrame[] => frames.filter((f) => f.type === "done");
const blocks = (frames: ChatFrame[]): ChatBlock[] =>
  frames.flatMap((f) => (f.type === "block" ? [f.block] : []));
const reconnectStates = (frames: ChatFrame[]): string[] =>
  blocks(frames).flatMap((b) =>
    b.kind === "activity" && b.key === CHAT_RECONNECT_BLOCK_KEY ? [b.state] : [],
  );
const reconnectDetail = (frames: ChatFrame[]): string | null | undefined =>
  blocks(frames).flatMap((b) =>
    b.kind === "activity" && b.key === CHAT_RECONNECT_BLOCK_KEY && b.state === "warning"
      ? [b.detail]
      : [],
  )[0];
const sinceCalls = (socket: FakeSocket | undefined): Record<string, unknown>[] =>
  (socket?.sent ?? []).flatMap((s) => (s.method === "session.events.since" ? [s.params] : []));

/* ── the turn continues ───────────────────────────────────────────────────── */

describe("hermes-chat · turn continuation", () => {
  test("a socket that drops mid-answer is rebuilt and the turn finishes on the new one", async () => {
    const h = harness([
      opening([
        eventFrame("message.delta", 41, { text: "one " }),
        eventFrame("message.delta", 42, { text: "two " }),
      ]),
      {
        results: {
          "session.resume": { session_id: SESSION_ID, running: true },
          "session.events.since": {
            events: [
              replayEvent("message.delta", 43, { text: "three " }),
              // No `text`: everything was streamed, so the completion carries
              // only the verdict. A replayed delta that goes missing therefore
              // stays missing — nothing downstream can reconstruct it.
              replayEvent("message.complete", 44, { status: "complete" }),
            ],
            latest_seq: 44,
            truncated: false,
            epoch: EPOCH,
          },
        },
      },
    ]);

    const frames = await runDropping(h.deps, h.sockets, 2);

    // It dialled again, attached before it read, and asked from the last event
    // it had actually applied.
    expect(h.sockets).toHaveLength(2);
    expect(h.sockets[1]?.methods()).toEqual([
      "client.capabilities",
      "session.resume",
      "session.events.since",
    ]);
    expect(sinceCalls(h.sockets[1])[0]?.last_seen).toBe(42);
    // The answer reads as one uninterrupted sentence, with nothing said twice.
    expect(deltas(frames)).toEqual(["one ", "two ", "three "]);
    expect(deltas(frames).join("")).toBe("one two three ");
    // And it ended once, completely: the turn never lost anything.
    expect(dones(frames)).toHaveLength(1);
    const last = frames.at(-1);
    expect(last?.type).toBe("done");
    expect(last?.type === "done" ? (last.incomplete ?? false) : true).toBe(false);
    // One block, two states: trying, then succeeded. A head replaces by key.
    expect(reconnectStates(frames)).toEqual(["running", "done"]);
  });

  test("the cursor starts where the session already was, so a drop replays nothing older", async () => {
    const h = harness([
      opening([]),
      {
        results: {
          "session.resume": { session_id: SESSION_ID, running: true },
          "session.events.since": {
            // `39` belongs to the turn before this one. A cursor initialized at
            // zero would render it as this turn's answer.
            events: [
              replayEvent("message.delta", 39, { text: "last turn's answer" }),
              replayEvent("message.delta", 41, { text: "this one's" }),
              replayEvent("message.complete", 42, { text: "this one's", status: "complete" }),
            ],
            latest_seq: 42,
            truncated: false,
            epoch: EPOCH,
          },
        },
      },
    ]);

    const out: ChatFrame[] = [];
    for await (const frame of createHermesChat(h.deps).send(BOX, "d", "go")) {
      out.push(ChatFrame.parse(frame));
      // Drop before a single event of this turn has arrived — the worst case
      // for a cursor, because nothing has moved it off its baseline yet.
      if (frame.type === "block" && frame.block.kind === "activity" && frame.block.key === "queue")
        h.sockets[0]?.close();
    }

    expect(sinceCalls(h.sockets[0])[0]?.last_seen).toBe(Number.MAX_SAFE_INTEGER);
    expect(sinceCalls(h.sockets[1])[0]?.last_seen).toBe(BASELINE);
    expect(deltas(out)).toEqual(["this one's"]);
  });

  test("a truncated replay ends the turn incomplete rather than resuming from a hole", async () => {
    const h = harness([
      opening([eventFrame("message.delta", 41, { text: "one " })]),
      {
        results: {
          "session.resume": { session_id: SESSION_ID, running: true },
          "session.events.since": {
            // The gateway evicted past the cursor. What it can still send is
            // not the missing middle, and pasting it in would fabricate one.
            truncated: true,
            events: [
              replayEvent("message.delta", 43, { text: "three " }),
              replayEvent("message.complete", 44, { status: "complete" }),
            ],
            latest_seq: 44,
            epoch: EPOCH,
          },
        },
      },
    ]);

    const frames = await runDropping(h.deps, h.sockets, 1);

    expect(deltas(frames)).toEqual(["one "]);
    const last = frames.at(-1);
    expect(last?.type).toBe("done");
    expect(last?.type === "done" ? last.incomplete : null).toBe(true);
    expect(reconnectStates(frames)).toEqual(["running", "warning"]);
    expect(reconnectDetail(frames)).toBe("log truncated");
  });

  test("a live event that races the replay is applied once, after it, in sequence order", async () => {
    const h = harness([
      opening([eventFrame("message.delta", 41, { text: "one " })]),
      {
        results: {
          "session.resume": { session_id: SESSION_ID, running: true },
          "session.events.since": {
            events: [replayEvent("message.delta", 42, { text: "two " })],
            latest_seq: 42,
            truncated: false,
            epoch: EPOCH,
          },
        },
        // Pushed the instant the replay is answered: the gateway had already
        // started sending to the newly attached socket. `42` is in both. Its
        // text differs here only so the assertion can say *which* copy won.
        after: {
          "session.events.since": [
            eventFrame("message.delta", 42, { text: "LIVE two " }),
            eventFrame("message.delta", 43, { text: "three " }),
            eventFrame("message.complete", 44, { text: "one two three ", status: "complete" }),
          ],
        },
      },
    ]);

    const frames = await runDropping(h.deps, h.sockets, 1);

    expect(deltas(frames)).toEqual(["one ", "two ", "three "]);
    expect(deltas(frames).join("")).not.toContain("LIVE");
    expect(dones(frames)).toHaveLength(1);
  });

  test("a gateway that restarted is a different session, and the turn is not continued onto it", async () => {
    const h = harness([
      opening([eventFrame("message.delta", 41, { text: "one " })]),
      {
        results: {
          "session.resume": { session_id: SESSION_ID, running: true },
          "session.events.since": {
            events: [replayEvent("message.delta", 42, { text: "two " })],
            latest_seq: 99,
            truncated: false,
            epoch: "epoch-2",
          },
        },
      },
    ]);

    const frames = await runDropping(h.deps, h.sockets, 1);

    expect(deltas(frames)).toEqual(["one "]);
    expect(reconnectStates(frames)).toEqual(["running", "warning"]);
    expect(reconnectDetail(frames)).toBe("gateway restarted");
    const last = frames.at(-1);
    expect(last?.type === "done" ? last.incomplete : null).toBe(true);
  });

  test("a gateway that cannot replay is asked once, and not again for the next turn", async () => {
    const h = harness([
      {
        ...opening([eventFrame("message.delta", 41, { text: "one " })]),
        errors: { "session.events.since": { code: -32601, message: "method not found" } },
      },
      {
        results: {
          "session.create": SESSION_CREATE_RESULT,
          "prompt.submit": PROMPT_SUBMIT_RESULT,
        },
        after: {
          "prompt.submit": [eventFrame("message.complete", 2, { text: "hi", status: "complete" })],
        },
      },
    ]);
    const chat = createHermesChat(h.deps);

    const first: ChatFrame[] = [];
    for await (const frame of chat.send(BOX, "d", "go")) {
      first.push(ChatFrame.parse(frame));
      if (frame.type === "delta") h.sockets[0]?.close();
    }

    // The turn behaves exactly as it did before continuation existed: no second
    // dial, no replay, and a lost socket ends it incomplete.
    expect(h.sockets).toHaveLength(1);
    const last = first.at(-1);
    expect(last?.type === "done" ? last.incomplete : null).toBe(true);
    expect(reconnectStates(first)).toEqual([]);

    const second: ChatFrame[] = [];
    for await (const frame of chat.send(BOX, "d", "again")) second.push(ChatFrame.parse(frame));
    expect(h.sockets).toHaveLength(2);
    // The verdict is remembered: the second turn spends no request learning it.
    expect(h.sockets[1]?.methods()).toEqual(["client.capabilities", "session.create", "prompt.submit"]);
    expect(second.at(-1)?.type).toBe("done");
  });

  test("an approval the dead socket announced is not shown twice, and one it never showed is", async () => {
    const request = (id: string): string =>
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "approval",
        params: { session_id: SESSION_ID, tool_name: "bash", command: `run ${id}` },
      });
    const h = harness([
      opening([eventFrame("message.delta", 41, { text: "one " }), request("r1")]),
      {
        results: {
          "session.resume": { session_id: SESSION_ID, running: true },
          "session.events.since": {
            events: [],
            latest_seq: 41,
            truncated: false,
            epoch: EPOCH,
            // Both are still open on the box. Only one of them was ever seen.
            open_requests: [
              { id: "r1", method: "approval", params: { tool_name: "bash", command: "run r1" } },
              { id: "r2", method: "approval", params: { tool_name: "bash", command: "run r2" } },
            ],
          },
        },
        after: {
          "session.events.since": [
            eventFrame("message.complete", 42, { text: "one ", status: "complete" }),
          ],
        },
      },
    ]);

    const frames = await runDropping(h.deps, h.sockets, 1);

    const ids = blocks(frames).flatMap((b) => (b.kind === "approval" ? [b.request_id] : []));
    expect(ids).toEqual(["r1", "r2"]);
  });

  test("a gateway that accepts the handshake and drops again spends the budget and stops", async () => {
    const h = harness([
      opening([eventFrame("message.delta", 41, { text: "one " })]),
      {
        results: {
          "session.resume": { session_id: SESSION_ID, running: true },
          // A clean handshake and an empty replay every time. Nothing new ever
          // arrives, so nothing ever proves the new socket is carrying the turn.
          "session.events.since": { events: [], latest_seq: 41, truncated: false, epoch: EPOCH },
        },
        dropAfter: ["session.events.since"],
      },
    ]);

    const frames = await runDropping(h.deps, h.sockets, 1);

    // The original, plus one dial per attempt, and not one more: a budget that
    // reset on a successful handshake would reconnect forever and the turn's
    // iterator would never return.
    expect(h.sockets).toHaveLength(4);
    expect(reconnectStates(frames)).toEqual([
      "running",
      "done",
      "running",
      "done",
      "running",
      "done",
      "warning",
    ]);
    expect(reconnectDetail(frames)).toBe("gave up after 3 attempts");
    const last = frames.at(-1);
    expect(last?.type === "done" ? last.incomplete : null).toBe(true);
  });

  test("a request left open before this turn started is not adopted by it", async () => {
    const h = harness([
      opening(
        [eventFrame("message.delta", 41, { text: "one " })],
        {},
        // `r0` was already waiting when the turn began — it belongs to whoever
        // asked for it, and this turn has no business rendering it.
        { ...PROBE, open_requests: [{ id: "r0", method: "approval", params: { tool_name: "bash" } }] },
      ),
      {
        results: {
          "session.resume": { session_id: SESSION_ID, running: true },
          "session.events.since": {
            events: [],
            latest_seq: 41,
            truncated: false,
            epoch: EPOCH,
            open_requests: [
              { id: "r0", method: "approval", params: { tool_name: "bash", command: "old" } },
              { id: "r1", method: "approval", params: { tool_name: "bash", command: "mine" } },
            ],
          },
        },
        after: {
          "session.events.since": [
            eventFrame("message.complete", 42, { text: "one ", status: "complete" }),
          ],
        },
      },
    ]);

    const frames = await runDropping(h.deps, h.sockets, 1);

    expect(blocks(frames).flatMap((b) => (b.kind === "approval" ? [b.request_id] : []))).toEqual([
      "r1",
    ]);
  });

  test("the wait for a turn's first frame is not extended by the reconnect", async () => {
    const h = harness([opening([]), { refuse: true }], {
      slotWaitMs: 60,
      // Longer than what is left of the deadline, which is the point: the
      // backoff must be spent *inside* the wait, not added to it.
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(ms, 90))),
    });

    const out: ChatFrame[] = [];
    for await (const frame of createHermesChat(h.deps).send(BOX, "d", "go")) {
      out.push(ChatFrame.parse(frame));
      if (frame.type === "block" && frame.block.kind === "activity" && frame.block.key === "queue")
        h.sockets[0]?.close();
    }

    // The deadline's own verdict, not the reconnect's: an error frame is what
    // `waitMs` produces, and a `done` is what a spent budget produces.
    const last = out.at(-1);
    expect(last?.type).toBe("error");
    // And it says what actually happened. `CHAT_NO_SLOT` claims the box is
    // running its limit of concurrent bots and sends the operator to go and
    // free one; a turn that spent the deadline reconnecting knows better.
    expect(last?.type === "error" ? last.code : null).toBe(CHAT_ERROR_CODES.TURN_FAILED);
  });
});

/* ── giving up, and being stopped ─────────────────────────────────────────── */

describe("hermes-chat · turn continuation, abandoned", () => {
  test("a reconnect that never lands spends its budget and stops", async () => {
    const h = harness([opening([eventFrame("message.delta", 41, { text: "one " })]), { refuse: true }]);

    const frames = await runDropping(h.deps, h.sockets, 1);

    // Three attempts, three "Reconnecting…" states, then the one warning that
    // stops a head animating a reconnect that is over. The dial count is the
    // connection layer's business — it retries a refused upgrade of its own.
    expect(h.sockets.length).toBeGreaterThan(1);
    expect(reconnectStates(frames)).toEqual(["running", "running", "running", "warning"]);
    expect(reconnectDetail(frames)).toBe("gave up after 3 attempts");
    expect(h.sleeps.map((s) => s.ms)).toEqual([1, 2, 4]);
    const last = frames.at(-1);
    expect(last?.type === "done" ? last.incomplete : null).toBe(true);
  });

  test("an abort during the backoff ends the turn there and dials nothing", async () => {
    const control = new AbortController();
    // The second dial is not a reconnect — the abort lands first — but the
    // socket the interrupt goes out on, so it answers like a working box.
    const h = harness([opening([eventFrame("message.delta", 41, { text: "one " })]), {}]);

    const out: ChatFrame[] = [];
    let dropped = false;
    for await (const frame of createHermesChat(h.deps).send(BOX, "d", "go", {
      signal: control.signal,
    })) {
      out.push(ChatFrame.parse(frame));
      if (frame.type === "delta" && !dropped) {
        dropped = true;
        h.sockets[0]?.close();
      }
      // The moment it says it is reconnecting, take the turn away from it.
      if (
        frame.type === "block" &&
        frame.block.kind === "activity" &&
        frame.block.key === CHAT_RECONNECT_BLOCK_KEY &&
        frame.block.state === "running"
      )
        control.abort();
    }

    // One extra dial, and only one: the socket the turn was reading is dead,
    // and an operator's stop still has to reach the box — a turn abandoned
    // without an interrupt keeps a warm slot and a provider bill running.
    expect(h.sockets).toHaveLength(2);
    expect(h.sockets[1]?.methods()).toEqual(["session.interrupt"]);
    expect(h.sockets[1]?.sent[0]?.params).toEqual({ session_id: SESSION_ID });
    expect(h.sockets[1]?.isClosed()).toBe(true);
    expect(reconnectStates(out)).toEqual(["running"]);
    const last = out.at(-1);
    expect(last?.type).toBe("done");
    expect(last?.type === "done" ? last.incomplete : null).toBe(true);
    // Nothing is left waiting: the injected sleep is asked for a signal and it
    // uses it, which is what keeps an abandoned turn from holding a timer.
    expect(h.sleeps.every((s) => s.settled)).toBe(true);
  });

  test("an abort mid-handshake still tells the box to stop, on the socket it was building", async () => {
    const control = new AbortController();
    const h = harness([
      opening([eventFrame("message.delta", 41, { text: "one " })]),
      {
        results: { "session.resume": { session_id: SESSION_ID, running: true } },
        hang: ["session.events.since"],
        // Abort exactly while the replay read is in flight: the new socket is
        // open and attached, and it is the only one that can carry the
        // interrupt the abort owes the box.
        onSend: (method) => {
          if (method === "session.events.since") control.abort();
        },
      },
    ]);

    const out = await runDropping(h.deps, h.sockets, 1, { signal: control.signal });

    expect(h.sockets).toHaveLength(2);
    expect(h.sockets[1]?.methods()).toContain("session.interrupt");
    const last = out.at(-1);
    expect(last?.type).toBe("done");
    expect(last?.type === "done" ? last.incomplete : null).toBe(true);
    expect(h.sockets[1]?.isClosed()).toBe(true);
  });

  test("a stop against an unreachable box is not held open by its own interrupt", async () => {
    const control = new AbortController();
    // The second dial — the one the interrupt goes out on — never opens and
    // never fails, which is what a box that fell off the tailnet looks like.
    const h = harness(
      [opening([eventFrame("message.delta", 41, { text: "one " })]), { hangOpen: true }],
      { interruptMs: 30 },
    );

    const started = Date.now();
    const out: ChatFrame[] = [];
    let dropped = false;
    for await (const frame of createHermesChat(h.deps).send(BOX, "d", "go", {
      signal: control.signal,
    })) {
      out.push(ChatFrame.parse(frame));
      if (frame.type === "delta" && !dropped) {
        dropped = true;
        h.sockets[0]?.close();
      }
      if (
        frame.type === "block" &&
        frame.block.kind === "activity" &&
        frame.block.key === CHAT_RECONNECT_BLOCK_KEY &&
        frame.block.state === "running"
      )
        control.abort();
    }

    // The operator got their answer. Without a bound on the dial this waits
    // for the OS to give up on the connection, with the `done` queued behind it.
    expect(Date.now() - started).toBeLessThan(2_000);
    const last = out.at(-1);
    expect(last?.type).toBe("done");
    expect(last?.type === "done" ? last.incomplete : null).toBe(true);
  });

  test("a reconnect dial that never opens still ends at the deadline, not never", async () => {
    // Nothing about this dial ever settles: no open, no failure. It is what a
    // box that falls off the tailnet mid-turn looks like from the laptop, and
    // an abort reaches the handshake's requests but never the open itself.
    const h = harness([opening([]), { hangOpen: true }], { slotWaitMs: 60 });

    const started = Date.now();
    const out: ChatFrame[] = [];
    for await (const frame of createHermesChat(h.deps).send(BOX, "d", "go")) {
      out.push(ChatFrame.parse(frame));
      if (frame.type === "block" && frame.block.kind === "activity" && frame.block.key === "queue")
        h.sockets[0]?.close();
    }

    // The generator returned, and it said why.
    expect(Date.now() - started).toBeLessThan(2_000);
    const last = out.at(-1);
    expect(last?.type).toBe("error");
    expect(last?.type === "error" ? last.code : null).toBe(CHAT_ERROR_CODES.TURN_FAILED);
  });
});
