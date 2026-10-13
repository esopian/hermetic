import {
  type BoxAddress,
  type ChatConversation,
  type ChatFrame,
  type ChatObserveHint,
  HermeticError,
  type HermesChatClient,
  type Swarm,
} from "@hermetic/core/chat-client";
import type { TurnState } from "../../src/client/chat-types.ts";
import { createGatewayTransport, type TurnSink } from "../../src/gateway/transport.ts";
import { flush } from "../helpers/fakes.ts";
import { block, delta, done, errorFrame, msg, swarm, bot } from "../helpers/fixtures.ts";

const NOW = "2026-10-13T10:00:00.000Z";

const canonical = (session = "s-1"): ChatConversation => ({
  instance: "atlas",
  bot: "scribe",
  root_session: session,
  session,
  kind: "canonical",
  created: false,
});

/** A scripted adapter: each method records its call and answers from the script. */
function fakeAdapter(script: {
  frames?: ChatFrame[];
  sendThrows?: unknown;
  conversation?: ChatConversation | null;
  history?: ReturnType<typeof msg>[];
  swarm?: (box: BoxAddress) => Promise<Swarm>;
  hints?: ChatObserveHint[];
  /** Hold the turn open until released. */
  hold?: boolean;
  /** Frames the box sends once a held turn is released. */
  after?: ChatFrame[];
}) {
  const calls: { method: string; args: unknown[] }[] = [];
  let release: (() => void) | null = null;
  /** Each send's signal, and whether its stream was closed (its `finally` ran). */
  const streams: { signal: AbortSignal | undefined; closed: boolean }[] = [];
  const client: HermesChatClient = {
    token: async () => "FIXTURE",
    swarm: async (box) => {
      calls.push({ method: "swarm", args: [box.instance] });
      if (script.swarm) return script.swarm(box);
      return swarm(box.instance, [bot()]);
    },
    sessions: async (box, b) => {
      calls.push({ method: "sessions", args: [box.instance, b] });
      return [];
    },
    history: async (box, b, opts) => {
      calls.push({
        method: "history",
        args: [box.instance, b, { session: opts?.session, limit: opts?.limit }],
      });
      return script.history ?? [];
    },
    conversation: async (box, b, opts) => {
      calls.push({
        method: "conversation",
        args: [
          box.instance,
          b,
          { create: opts?.create, session: opts?.session, new_session: opts?.new_session },
        ],
      });
      return script.conversation === undefined ? canonical() : script.conversation;
    },
    compact: async (box, b, opts) => {
      calls.push({ method: "compact", args: [box.instance, b, opts?.session] });
      return { compressed: true, status: "ok" } as never;
    },
    send: (box, b, text, opts) => {
      calls.push({ method: "send", args: [box.instance, b, text, opts?.session] });
      const stream = { signal: opts?.signal, closed: false };
      streams.push(stream);
      return (async function* () {
        try {
          if (script.sendThrows) throw script.sendThrows;
          for (const f of script.frames ?? []) yield f;
          if (script.hold) {
            await new Promise<void>((resolve) => {
              release = resolve;
              opts?.signal?.addEventListener("abort", () => resolve());
            });
          }
          for (const f of script.after ?? []) yield f;
        } finally {
          stream.closed = true;
        }
      })();
    },
    abort: async (box, b, opts) => {
      calls.push({ method: "abort", args: [box.instance, b, opts?.session] });
      release?.();
      return true;
    },
    steer: async (box, b, text, opts) => {
      calls.push({ method: "steer", args: [box.instance, b, text, opts?.session] });
      return "redirected";
    },
    respond: async (box, input) => {
      calls.push({ method: "respond", args: [box.instance, input] });
      return { status: "ok" };
    },
    observe: (box, b) => {
      calls.push({ method: "observe", args: [box.instance, b] });
      return (async function* () {
        for (const h of script.hints ?? []) yield h;
      })();
    },
  };
  return { client, calls, streams, release: () => release?.() };
}

function setup(script: Parameters<typeof fakeAdapter>[0] = {}, listening = ["atlas"]) {
  const adapter = fakeAdapter(script);
  const events: {
    type: "frame" | "end" | "gone";
    turn_id: string;
    frame?: ChatFrame;
    state?: TurnState;
  }[] = [];
  const sink: TurnSink = {
    frame: (turn_id, _n, frame) => events.push({ type: "frame", turn_id, frame }),
    end: (turn_id, state) => events.push({ type: "end", turn_id, state }),
    gone: (turn_id) => events.push({ type: "gone", turn_id }),
  };
  let listened = [...listening];
  const transport = createGatewayTransport({
    client: adapter.client,
    address: (instance) => {
      if (instance === "ghost")
        throw new HermeticError("VALIDATION", "ghost is not an agent of the paired fleet");
      return {
        instance,
        baseUrl: `https://fxtr0001-${instance}.hermetic.ts.net/`,
        fleet_id: "fxtr0001",
      };
    },
    listening: () => listened,
    setListening: (instance, on) => {
      listened = on ? [...new Set([...listened, instance])] : listened.filter((i) => i !== instance);
      return listened;
    },
    turns: () => sink,
    now: () => NOW,
    mintTurnId: (() => {
      let n = 0;
      return () => `T${++n}`;
    })(),
    observeTuning: { pollMs: 60_000, sleep: async () => {} },
  });
  return {
    ...adapter,
    transport,
    events,
    frames: () => events.filter((e) => e.type === "frame").map((e) => e.frame),
  };
}

const ATLAS = { instance: "atlas", bot: "scribe" };

describe("turns", () => {
  test("resolve the conversation, send into its session, pump frames, end done", async () => {
    const s = setup({ frames: [delta(1, "hi"), done(2)] });
    const { turn_id } = await s.transport.startTurn({ ...ATLAS, message: "hello" });
    expect(turn_id).toBe("T1");
    await flush();
    expect(s.calls.map((c) => c.method)).toEqual(["conversation", "send"]);
    expect(s.calls[0]!.args[2]).toEqual({ create: true, session: undefined, new_session: undefined });
    expect(s.calls[1]!.args).toEqual(["atlas", "scribe", "hello", "s-1"]);
    expect(s.frames()).toEqual([delta(1, "hi"), done(2)]);
    expect(s.events.at(-1)).toEqual({ type: "end", turn_id: "T1", state: "done" });
  });

  test("an error frame ends the turn in error, its text through the mask", async () => {
    const s = setup({ frames: [errorFrame("CHAT_TURN_FAILED", "boom password=FIXTURE-hunter2")] });
    await s.transport.startTurn({ ...ATLAS, message: "hello" });
    await flush();
    const frame = s.frames()[0] as Extract<ChatFrame, { type: "error" }>;
    expect(frame.code).toBe("CHAT_TURN_FAILED");
    expect(frame.message).not.toContain("FIXTURE-hunter2");
    expect(s.events.at(-1)).toMatchObject({ type: "end", state: "error" });
  });

  test("a throw becomes an error frame with the error's code", async () => {
    const s = setup({ sendThrows: new HermeticError("CHAT_UNREACHABLE", "atlas: no answer") });
    await s.transport.startTurn({ ...ATLAS, message: "hello" });
    await flush();
    expect(s.frames()).toEqual([
      { type: "error", code: "CHAT_UNREACHABLE", message: "atlas: no answer" },
    ]);
    expect(s.events.at(-1)).toMatchObject({ type: "end", state: "error" });
  });

  test("an incomplete done (the adapter's reconnect budget spent) is gone: history is the record", async () => {
    const s = setup({
      frames: [delta(1, "partial"), { type: "done", seq: 2, message: "m1", incomplete: true }],
    });
    await s.transport.startTurn({ ...ATLAS, message: "hello" });
    await flush();
    expect(s.events.at(-1)).toEqual({ type: "gone", turn_id: "T1" });
  });

  test("a stream that just stops is gone too", async () => {
    const s = setup({ frames: [delta(1, "partial")] });
    await s.transport.startTurn({ ...ATLAS, message: "hello" });
    await flush();
    expect(s.events.at(-1)).toEqual({ type: "gone", turn_id: "T1" });
  });

  test("abortTurn interrupts the turn's session on the box and ends it aborted", async () => {
    const s = setup({ frames: [delta(1, "working")], hold: true });
    await s.transport.startTurn({ ...ATLAS, message: "hello" });
    await flush();
    await s.transport.abortTurn("T1");
    await flush();
    expect(s.calls.find((c) => c.method === "abort")?.args).toEqual(["atlas", "scribe", "s-1"]);
    expect(s.events.at(-1)).toEqual({ type: "end", turn_id: "T1", state: "aborted" });
  });

  test("forgetTurn stops delivery without an end", async () => {
    const s = setup({ frames: [delta(1, "working")], hold: true });
    await s.transport.startTurn({ ...ATLAS, message: "hello" });
    await flush();
    s.transport.forgetTurn?.("T1");
    await flush();
    expect(s.events.filter((e) => e.type !== "frame")).toEqual([]);
  });

  test("forgetTurn never interrupts the box: the stream is left, not aborted", async () => {
    const s = setup({ frames: [delta(1, "working")], hold: true, after: [delta(2, " more"), done(3)] });
    await s.transport.startTurn({ ...ATLAS, message: "hello" });
    await flush();
    const delivered = s.events.length;
    s.transport.forgetTurn?.("T1");
    await flush();
    // An aborted signal is what makes the adapter send `session.interrupt`.
    expect(s.streams[0]?.signal?.aborted).toBe(false);
    expect(s.calls.some((c) => c.method === "abort")).toBe(false);
    // The box's next frame: the pump leaves the stream (closing its socket), delivering nothing.
    s.release();
    await flush();
    await flush();
    expect(s.streams[0]?.closed).toBe(true);
    expect(s.streams[0]?.signal?.aborted).toBe(false);
    expect(s.events).toHaveLength(delivered);
  });

  test("detachTurns forgets every running turn, interrupting none, and names them", async () => {
    const s = setup({ frames: [delta(1, "working")], hold: true });
    await s.transport.startTurn({ ...ATLAS, message: "one" });
    await s.transport.startTurn({ ...ATLAS, message: "two" });
    await flush();
    expect(s.transport.detachTurns().sort()).toEqual(["T1", "T2"]);
    expect(s.transport.detachTurns()).toEqual([]);
    expect(s.streams.every((st) => st.signal?.aborted === false)).toBe(true);
    expect(s.calls.some((c) => c.method === "abort")).toBe(false);
  });

  test("dispose detaches turns the same way: no interrupt", async () => {
    const s = setup({ frames: [delta(1, "working")], hold: true });
    await s.transport.startTurn({ ...ATLAS, message: "hello" });
    await flush();
    s.transport.dispose();
    await flush();
    expect(s.streams[0]?.signal?.aborted).toBe(false);
    expect(s.calls.some((c) => c.method === "abort")).toBe(false);
  });

  test("/compact in Bot Chat compacts instead of sending", async () => {
    const s = setup();
    await s.transport.startTurn({ ...ATLAS, message: "/compact" });
    await flush();
    expect(s.calls.map((c) => c.method)).toEqual(["conversation", "compact"]);
    expect(s.frames()).toEqual([
      block(0, { kind: "text", markdown: "✓ Context compression complete" }, "compact"),
      { type: "done", seq: 1, message: "compact" },
    ]);
    expect(s.events.at(-1)).toMatchObject({ state: "done" });
  });

  test("a start for an instance this phone does not know is refused at once", async () => {
    const s = setup();
    await expect(
      s.transport.startTurn({ instance: "ghost", bot: "x", message: "hi" }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });
});

describe("reads", () => {
  test("history composes the conversation and the transcript the way chat.history does", async () => {
    const s = setup({ history: [msg({ id: "h1" })] });
    const result = await s.transport.history({ ...ATLAS });
    expect(result).toMatchObject({ instance: "atlas", bot: "scribe", session: "s-1" });
    expect(result.messages.map((m) => m.id)).toEqual(["h1"]);
    expect(s.calls.find((c) => c.method === "history")?.args[2]).toEqual({
      session: "s-1",
      limit: undefined,
    });
  });

  test("a bot with no Bot Chat yet reads as empty, without a transcript read", async () => {
    const s = setup({ conversation: null });
    const result = await s.transport.history({ ...ATLAS });
    expect(result).toMatchObject({ session: null, messages: [], conversation: null });
    expect(s.calls.some((c) => c.method === "history")).toBe(false);
  });

  test("swarms asks every listened box; one that fails is an unreachable bucket", async () => {
    const s = setup(
      {
        swarm: async (box) => {
          if (box.instance === "corvid")
            throw new HermeticError("CHAT_UNREACHABLE", "corvid: no answer");
          return swarm(box.instance, [bot()]);
        },
      },
      ["atlas", "corvid"],
    );
    const { swarms } = await s.transport.swarms();
    expect(swarms.map((w) => [w.instance, w.reachable])).toEqual([
      ["atlas", true],
      ["corvid", false],
    ]);
    expect(swarms[1]?.unreachable_reason).toBe("CHAT_UNREACHABLE: corvid: no answer");
  });

  test("listening is the phone's own, and listen changes it", async () => {
    const s = setup();
    expect(await s.transport.listening()).toEqual({ instances: ["atlas"] });
    expect(await s.transport.listen("corvid", true)).toEqual({ instances: ["atlas", "corvid"] });
  });

  test("steer and respond go to the adapter with the conversation's session", async () => {
    const s = setup();
    expect(await s.transport.steer({ ...ATLAS, session: "s-1", text: "also this" })).toEqual({
      ...ATLAS,
      status: "redirected",
    });
    await s.transport.respond({
      ...ATLAS,
      session: "s-1",
      request_id: "r1",
      kind: "approval",
      choice: "once",
    });
    expect(s.calls.find((c) => c.method === "respond")?.args[1]).toMatchObject({
      request_id: "r1",
      session: "s-1",
    });
  });

  test("a response with no session is refused before it reaches the adapter", async () => {
    const s = setup();
    await expect(
      s.transport.respond({
        ...ATLAS,
        session: "",
        request_id: "r1",
        kind: "approval",
        choice: "once",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(s.calls.some((c) => c.method === "respond")).toBe(false);
  });
});

describe("observation", () => {
  test("a snapshot from history, then the events, until the closer", async () => {
    const s = setup({ history: [msg({ id: "h1" })] });
    const events: string[] = [];
    let ended = false;
    const close = s.transport.observe!(
      { ...ATLAS, session: null },
      { event: (e) => events.push(e.type), end: () => (ended = true) },
    );
    for (let i = 0; i < 10 && events.length === 0; i++) await flush();
    expect(events[0]).toBe("snapshot");
    close();
    await flush();
    expect(ended).toBe(false);
  });

  test("a terminal error ends the observation with its code", async () => {
    const s = setup();
    s.client.history = async () => {
      throw new HermeticError("NOT_FOUND", "no such bot");
    };
    s.client.conversation = undefined;
    let ended: unknown = "not yet";
    s.transport.observe!({ ...ATLAS, session: null }, { event: () => {}, end: (e) => (ended = e) });
    for (let i = 0; i < 20 && ended === "not yet"; i++) await flush();
    expect(ended).toMatchObject({ code: "NOT_FOUND" });
  });
});
