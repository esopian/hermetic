/**
 * The adapter, driven by the frames a real box actually sent.
 *
 * Nothing here opens a socket or makes a request: `deps.fetch` and
 * `deps.openSocket` are the two injected seams, and the fake below answers
 * JSON-RPC out of `fixtures/hermes-frames.ts`. That is not a convenience — the
 * repo forbids network in tests, and an adapter whose tests needed a box would
 * only ever be run by whoever had one.
 *
 * What is asserted is deliberately lopsided. The mapping from upstream's
 * vocabulary to `ChatFrame` gets the most attention, because it is the part
 * that has to keep working across a `hermes_ref` bump nobody reviews; the
 * transport gets the rest, because its failure modes (a dead box, a token that
 * died with the dashboard process, a gateway with no warm slot) are the ones an
 * operator meets.
 */
import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  createHermesChat,
  mapHistory,
  mapSessions,
  mapSwarm,
  WARM_SLOTS_PER_GATEWAY,
} from "../src/chat/hermes/hermes-chat.ts";
import type {
  BoxAddress,
  ChatFetch,
  ChatSocket,
  HermesChatDeps,
} from "../src/chat/hermes/hermes-chat.ts";
import { DURABLE_TOOL_ROWS, SESSION_HISTORY_PARAM_KEYS } from "./fixtures/hermes-history-contract.ts";
import { HermeticError } from "../src/errors.ts";
import { Bot, ChatFrame } from "../src/schema/index.ts";
import type { ChatBlock } from "../src/schema/index.ts";
import {
  AGENTS_LIST_RESULT,
  BLANK_FRAME,
  DASHBOARD_HTML,
  DASHBOARD_HTML_NO_TOKEN,
  DOUBLE_FRAME,
  eventFrame,
  FIXTURE_SESSION_TOKEN,
  GROUPS_LIST_RESULT,
  LIVE_AGENTS_LIST,
  LIVE_BOT_WATERMARK,
  LIVE_GROUPS_LIST,
  LIVE_NEWEST_SESSION_START,
  LIVE_PROFILES_LIST,
  LIVE_REASONING,
  LIVE_SESSION_LIST,
  LIVE_TURN,
  PROFILES_LIST_RESULT,
  PROMPT_SUBMIT_RESULT,
  RECORDED_MESSAGE_COMPLETE,
  RECORDED_MESSAGE_DELTA_1,
  RECORDED_MESSAGE_DELTA_2,
  RECORDED_TURN,
  SESSION_CREATE_RESULT,
  SESSION_ID,
  SESSION_LIST_POPULATED,
  SESSION_LIST_RESULT,
  TRUNCATED_FRAME,
  UNKNOWN_EVENT,
  UNKNOWN_TOOL_COMPLETE,
  UNKNOWN_TOOL_START,
} from "./fixtures/hermes-frames.ts";

/* ── the double ───────────────────────────────────────────────────────────── */

const BOX: BoxAddress = {
  instance: "veronica",
  baseUrl: "https://fxtr0001-veronica.tail0000.ts.net/",
  fleet_id: "fxtr0001",
};

/** Fixed, so every message id in the assertions below is the same string. */
const NOW = "2026-09-16T19:48:41.000Z";

interface BoxScript {
  /** What `GET /` answers. Defaults to the SPA page with a token in it. */
  html?: string;
  htmlStatus?: number;
  /** `GET /` throws instead of answering. */
  htmlThrows?: boolean;
  /** Durable REST rows, paged like the recorded upstream route. */
  history?: readonly unknown[];
  /** Override the durable read response for auth and protocol failures. */
  historyReply?: (url: URL) => { status?: number; json: unknown };
  /** RPC method → result. A method with no entry answers `{}`. */
  results?: Record<string, unknown>;
  /** RPC method → one result per call, in order; the last repeats. Beats `results`. */
  sequence?: Record<string, readonly unknown[]>;
  /** RPC method → JSON-RPC error object. */
  errors?: Record<string, { code: number; message: string }>;
  /** Source-derived closed parameter contracts, enforced before returning canned data. */
  allowedParams?: Record<string, readonly string[]>;
  /** RPC method → event frames pushed straight after its reply. */
  after?: Record<string, readonly string[]>;
  /** RPC method → raw frames pushed *before* its reply, to exercise ordering. */
  before?: Record<string, readonly string[]>;
  /** How many socket opens to refuse before the first one succeeds. */
  refuseOpens?: number;
  /** Overrides the harness default, for the two tests that want a real wait. */
  slotWaitMs?: number;
}

/** A one-producer/one-consumer queue, the same shape the adapter's own reader uses. */
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

interface FakeSocket extends ChatSocket {
  url: string;
  headers: Record<string, string> | undefined;
  sent: { id: number; method: string; params: Record<string, unknown> }[];
  isClosed(): boolean;
}

interface Harness {
  deps: HermesChatDeps;
  fetches: { url: string; headers: Record<string, string> }[];
  sockets: FakeSocket[];
  /** Refuse the next `n` socket opens — what a token that died with the dashboard looks like. */
  refuse(n: number): void;
}

function harness(script: BoxScript = {}): Harness {
  const fetches: { url: string; headers: Record<string, string> }[] = [];
  const sockets: FakeSocket[] = [];
  let refusals = script.refuseOpens ?? 0;

  const fetchImpl: ChatFetch = (input, init) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k] = v;
    }
    fetches.push({ url: String(input), headers });
    if (script.htmlThrows) return Promise.reject(new Error("getaddrinfo ENOTFOUND"));
    const url = new URL(String(input));
    if (url.pathname.startsWith("/api/sessions/")) {
      const rows = script.history ?? [];
      const limit = Number(url.searchParams.get("limit"));
      const offset = Number(url.searchParams.get("offset"));
      const page =
        url.searchParams.get("order") === "latest"
          ? rows.slice(Math.max(0, rows.length - offset - limit), rows.length - offset)
          : rows.slice(offset, offset + limit);
      const reply = script.historyReply?.(url) ?? {
        json: {
          session_id: "stored",
          profile: url.searchParams.get("profile"),
          messages: page,
          pagination: { returned: page.length, limit, offset },
        },
      };
      return Promise.resolve(
        new Response(JSON.stringify(reply.json), {
          status: reply.status ?? 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return Promise.resolve(
      new Response(script.html ?? DASHBOARD_HTML, {
        status: script.htmlStatus ?? 200,
        headers: { "content-type": "text/html" },
      }),
    );
  };

  const openSocket = (
    url: string,
    opts: { signal?: AbortSignal | undefined; headers?: Record<string, string> | undefined },
  ): ChatSocket => {
    const q = queue<string>();
    let closed = false;
    const calls = new Map<string, number>();
    const sent: { id: number; method: string; params: Record<string, unknown> }[] = [];
    const refuse = refusals > 0;
    if (refuse) refusals -= 1;

    const socket: FakeSocket = {
      url,
      headers: opts.headers,
      sent,
      isClosed: () => closed,
      // The message a refused upgrade actually carries, verbatim from
      // `chat.ts`'s `runtimeSocket` — and therefore carrying the live session
      // token in its query string. The adapter must not let it through.
      opened: refuse ? Promise.reject(new Error(`chat socket failed: ${url}`)) : Promise.resolve(),
      frames: q.drain(),
      send(data: string) {
        const doc = JSON.parse(data) as {
          id: number;
          method: string;
          params: Record<string, unknown>;
        };
        sent.push(doc);
        for (const frame of script.before?.[doc.method] ?? []) q.push(frame);
        const allowed = script.allowedParams?.[doc.method];
        const extra = allowed
          ? Object.keys(doc.params).find((key) => !allowed.includes(key))
          : undefined;
        const failure = extra
          ? {
              code: 4000,
              message: `invalid params for ${doc.method}: ${extra}: Extra inputs are not permitted`,
            }
          : script.errors?.[doc.method];
        if (failure) {
          q.push(JSON.stringify({ jsonrpc: "2.0", id: doc.id, error: failure }));
        } else {
          const queued = script.sequence?.[doc.method];
          let result: unknown;
          if (queued && queued.length > 0) {
            const seen = calls.get(doc.method) ?? 0;
            calls.set(doc.method, seen + 1);
            result = queued[Math.min(seen, queued.length - 1)];
          } else {
            result = script.results?.[doc.method] ?? {};
          }
          q.push(JSON.stringify({ jsonrpc: "2.0", id: doc.id, result }));
        }
        for (const frame of script.after?.[doc.method] ?? []) q.push(frame);
      },
      close() {
        closed = true;
        q.close();
      },
    };
    sockets.push(socket);
    return socket;
  };

  return {
    // 50 ms rather than thirty seconds: the fake answers in the same tick, so
    // the only test this number changes is the one that *wants* the deadline.
    deps: { fetch: fetchImpl, openSocket, now: () => NOW, slotWaitMs: script.slotWaitMs ?? 50 },
    fetches,
    sockets,
    refuse: (n: number) => {
      refusals = n;
    },
  };
}

/** A turn script: create a session, accept the prompt, then push `frames`. */
function turnScript(frames: readonly string[]): BoxScript {
  return {
    results: {
      "session.create": SESSION_CREATE_RESULT,
      "prompt.submit": PROMPT_SUBMIT_RESULT,
    },
    after: { "prompt.submit": frames },
  };
}

async function collect(stream: AsyncIterable<ChatFrame>): Promise<ChatFrame[]> {
  const out: ChatFrame[] = [];
  for await (const frame of stream) out.push(ChatFrame.parse(frame));
  return out;
}

/** Drops the two adapter-minted status frames, which every turn opens with. */
function body(frames: ChatFrame[]): ChatFrame[] {
  return frames.filter(
    (f) =>
      !(
        f.type === "block" &&
        f.block.kind === "activity" &&
        ["connection", "queue"].includes(f.block.category)
      ),
  );
}

function blocks(frames: ChatFrame[]): ChatBlock[] {
  return frames.flatMap((f) => (f.type === "block" ? [f.block] : []));
}

/* ── the recorded turn ────────────────────────────────────────────────────── */

describe("hermes-chat · prompt capability", () => {
  /**
   * From Hermes `v2026.9.21` the gateway sends approvals and clarifications
   * only to a client that has said it answers them, and withdraws them at once
   * otherwise. The turn socket says so first, before the session exists.
   */
  test("the turn socket advertises server requests before it creates the session", async () => {
    const h = harness(turnScript(RECORDED_TURN));
    await collect(createHermesChat(h.deps).send(BOX, "default", "hi"));
    const sent = h.sockets[0]?.sent ?? [];
    expect(sent[0]).toMatchObject({ method: "client.capabilities", params: { server_requests: true } });
    expect(sent[1]?.method).toBe("session.create");
  });

  /**
   * Upstream stores an explicit `source` verbatim and lists it back on every
   * `session.list` row; with none, every websocket client is stamped `tui` and
   * hermetic's sessions read as the box's own terminal. Both doors into a
   * session carry it.
   */
  test("session.create and session.resume both carry source: hermetic", async () => {
    const created = harness(turnScript(RECORDED_TURN));
    await collect(createHermesChat(created.deps).send(BOX, "default", "hi"));
    const create = created.sockets[0]?.sent.find((call) => call.method === "session.create");
    expect(create?.params).toMatchObject({ profile: "default", source: "hermetic" });

    const resumed = harness({
      results: {
        "session.resume": { session_id: "runtime-1", running: false, info: {} },
        "prompt.submit": PROMPT_SUBMIT_RESULT,
      },
    });
    const turn = createHermesChat(resumed.deps)
      .send(BOX, "default", "again", { session: "durable-1" })
      [Symbol.asyncIterator]();
    await turn.next();
    await turn.next();
    await turn.return?.();
    const resume = resumed.sockets[0]?.sent.find((call) => call.method === "session.resume");
    expect(resume?.params).toMatchObject({ session_id: "durable-1", source: "hermetic" });
    expect(resumed.sockets[0]?.sent.some((call) => call.method === "session.create")).toBe(false);
  });

  test("a gateway that predates the method still runs the turn", async () => {
    const h = harness({
      ...turnScript(RECORDED_TURN),
      errors: { "client.capabilities": { code: -32601, message: "Method not found" } },
    });
    const frames = await collect(createHermesChat(h.deps).send(BOX, "default", "hi"));
    expect(frames.some((f) => f.type === "error")).toBe(false);
    expect(frames.at(-1)?.type).toBe("done");
  });
});

describe("hermes-chat · the recorded turn", () => {
  test("replays the probed turn as the frame sequence a head renders", async () => {
    const h = harness(turnScript(RECORDED_TURN));
    const chat = createHermesChat(h.deps);
    const frames = await collect(chat.send(BOX, "default", "Reply with the single word pong."));

    // Every frame carries the same adapter-minted message id, because nothing
    // upstream sends names a message and a head has to group them somehow.
    const ids = new Set(frames.map((f) => (f.type === "error" ? null : f.message)));
    expect(ids).toEqual(new Set([`veronica:${NOW}`]));

    expect(frames.map((f) => f.type)).toEqual([
      "block", // chat.status connecting
      "block", // chat.status submitted
      "block", // thinking begins before its text is flushed
      "block", // thinking complete
      "block", // reasoning, flushed by message.start
      "block", // the text block the deltas append to
      "delta",
      "delta",
      "block", // thinking resumes after output
      "block", // thinking complete
      "block", // reasoning, flushed by reasoning.available
      "done",
    ]);

    // Thinking snapshots are status, not steps: a head must not list them.
    const thinkingActivity = blocks(body(frames)).filter(
      (block) =>
        block.kind === "activity" && block.category === "generation" && block.key === "reasoning",
    );
    expect(thinkingActivity.length).toBeGreaterThan(0);
    for (const block of thinkingActivity)
      expect(block.kind === "activity" && block.role).toBe("status");

    const rendered = blocks(body(frames)).filter((block) => block.kind !== "activity");
    expect(rendered[0]).toEqual({
      kind: "reasoning",
      text: "The user wants one word and no tools.",
      duration_ms: null,
      tokens: null,
    });
    expect(rendered[1]).toEqual({ kind: "text", markdown: "" });
    expect(rendered[2]).toEqual({ kind: "reasoning", text: " Done.", duration_ms: null, tokens: null });

    const deltas = frames.flatMap((f) => (f.type === "delta" ? [f] : []));
    expect(deltas.map((d) => d.text)).toEqual(["p", "ong"]);
    // Upstream's own ordering, passed through rather than re-derived.
    expect(deltas.map((d) => d.seq)).toEqual([6, 7]);

    const done = frames.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type !== "done") throw new Error("unreachable");
    expect(done.seq).toBe(10);
    expect(done.usage).toEqual({
      input_tokens: 13300,
      output_tokens: 4,
      // Upstream ships no cost, and hermetic does not multiply tokens by a
      // price it guessed (`ChatUsage`).
      cost_usd: null,
      model: "deepseek/deepseek-v4.1-flash",
    });
    expect(done.incomplete).toBeNull();
  });

  test("the warm-slot wait is a frame from the first second, not a silence", async () => {
    const h = harness(turnScript(RECORDED_TURN));
    const chat = createHermesChat(h.deps);
    const frames = await collect(chat.send(BOX, "default", "hi"));
    const status = blocks(frames).filter(
      (b) => b.kind === "activity" && ["connection", "queue"].includes(b.category),
    );
    expect(status).toHaveLength(2);
    expect(status.map((b) => (b.kind === "activity" ? b.payload : null))).toEqual([
      { state: "connecting", warm_slots: WARM_SLOTS_PER_GATEWAY },
      // `streaming` upstream — the gateway took the prompt on a quiet session.
      { state: "submitted", warm_slots: WARM_SLOTS_PER_GATEWAY },
    ]);
  });

  test("the second status frame is prompt.submit's own answer, not a guess", async () => {
    // Upstream's four replies (`methods_prompt.py`, `session_auto_continue.py`)
    // plus the two shapes this build must not fall over on.
    const cases = [
      [{ status: "streaming" }, "submitted"],
      [{ status: "queued" }, "queued"],
      [{ status: "redirected" }, "redirected"],
      [{ status: "steered" }, "steered"],
      [{}, "submitted"],
      [{ status: "teleported" }, "submitted"],
    ] as const;
    for (const [reply, expected] of cases) {
      const h = harness({
        results: { "session.create": SESSION_CREATE_RESULT, "prompt.submit": reply },
        after: { "prompt.submit": RECORDED_TURN },
      });
      const frames = await collect(createHermesChat(h.deps).send(BOX, "default", "hi"));
      const states = blocks(frames).flatMap((b) =>
        b.kind === "activity" && ["connection", "queue"].includes(b.category)
          ? [(b.payload as { state: string }).state]
          : [],
      );
      expect(states).toEqual(["connecting", expected]);
    }
  });

  test("chatter upstream sends five of per turn never reaches the transcript", async () => {
    const h = harness(turnScript(RECORDED_TURN));
    const chat = createHermesChat(h.deps);
    const names = blocks(body(await collect(chat.send(BOX, "default", "hi")))).map((b) =>
      b.kind === "unknown" ? b.name : b.kind,
    );
    expect(names).not.toContain("sessions.changed");
    expect(names).not.toContain("session.title");
    expect(names).not.toContain("session.info");
    expect(names).not.toContain("gateway.ready");
  });

  test("a turn whose text arrives only on message.complete still renders", async () => {
    // Upstream coalesces deltas on a 33 ms timer; a short, fast answer can land
    // entirely inside `message.complete` with no delta before it.
    const h = harness(turnScript([RECORDED_MESSAGE_COMPLETE]));
    const frames = body(await collect(createHermesChat(h.deps).send(BOX, "default", "hi")));
    const deltas = frames.flatMap((f) => (f.type === "delta" ? [f.text] : []));
    expect(deltas).toEqual(["pong"]);
  });
});

/* ── the live turn ────────────────────────────────────────────────────────── */

describe("hermes-chat · the live 0.21.3 turn", () => {
  /**
   * The live-box capture, replayed. Three separate defects showed up in this one
   * four-token exchange and none of them were reachable from the probe's
   * recording, so this is the regression that holds all three down.
   */
  test("replays the live turn with no empty bubble and no echoed reasoning", async () => {
    const h = harness(turnScript(LIVE_TURN));
    const frames = await collect(createHermesChat(h.deps).send(BOX, "default", "ping"));

    expect(
      frames.map((f) => [
        f.type === "block" ? `block:${f.block.kind}` : f.type,
        f.type === "error" ? -1 : f.seq,
      ]),
    ).toEqual([
      ["block:activity", 0], // chat.status connecting
      ["block:activity", 0], // chat.status submitted
      ["block:activity", 3], // thinking begins
      ["block:activity", 6], // thinking complete
      ["block:reasoning", 6],
      ["block:text", 6],
      ["delta", 6],
      ["done", 10],
    ]);

    // The genuine thinking, once, as itself.
    const reasoning = blocks(frames).filter((b) => b.kind === "reasoning");
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]?.kind === "reasoning" ? reasoning[0].text : null).toBe(LIVE_REASONING);
    // And the answer nowhere near it.
    expect(JSON.stringify(reasoning)).not.toContain("pong");
  });

  /**
   * `message.start` at `seq: 2` used to open a text block that the reasoning
   * flush at `seq: 6` then closed, leaving it empty for the life of the
   * transcript — an empty bubble above every answer that had any thinking.
   */
  test("no text block is emitted that never receives content", async () => {
    const h = harness(turnScript(LIVE_TURN));
    const frames = await collect(createHermesChat(h.deps).send(BOX, "default", "ping"));
    const indexes = frames.flatMap((f, i) =>
      f.type === "block" && f.block.kind === "text" ? [i] : [],
    );
    expect(indexes).toHaveLength(1);
    // The one that is emitted is the placeholder the very next frame fills.
    for (const i of indexes) expect(frames[i + 1]?.type).toBe("delta");
  });

  test("a turn that produces no text at all produces no text block", async () => {
    const h = harness(
      turnScript([
        eventFrame("message.start", 2, {}),
        eventFrame("message.complete", 4, { text: "", status: "complete" }),
      ]),
    );
    const frames = body(await collect(createHermesChat(h.deps).send(BOX, "d", "go")));
    expect(frames.map((f) => f.type)).toEqual(["done"]);
  });

  /**
   * On the live box this event's `text` was the model's *answer*, already
   * streamed as a delta. Reading it reprinted the whole reply labelled as
   * private thinking, which an operator reads as something the model did not
   * mean to say.
   */
  test("reasoning.available supplies accounting, never words", async () => {
    const h = harness(
      turnScript([
        eventFrame("message.delta", 3, { text: "the answer" }),
        eventFrame("reasoning.available", 4, { text: "the answer", tokens: 12, duration_ms: 900 }),
        eventFrame("message.complete", 5, { text: "the answer", status: "complete" }),
      ]),
    );
    const frames = body(await collect(createHermesChat(h.deps).send(BOX, "d", "go")));
    expect(blocks(frames).some((b) => b.kind === "reasoning")).toBe(false);
  });

  test("reasoning.available still closes a genuine reasoning stream, with its accounting", async () => {
    const h = harness(
      turnScript([
        eventFrame("thinking.delta", 3, { text: "weighing it up" }),
        eventFrame("reasoning.available", 4, { tokens: 12, duration_ms: 900 }),
        eventFrame("message.complete", 5, { text: "done", status: "complete" }),
      ]),
    );
    const frames = body(await collect(createHermesChat(h.deps).send(BOX, "d", "go")));
    expect(blocks(frames).find((b) => b.kind === "reasoning")).toEqual({
      kind: "reasoning",
      text: "weighing it up",
      duration_ms: 900,
      tokens: 12,
    });
  });

  /**
   * The backstop for the next event that echoes the answer, whatever it turns
   * out to be called.
   */
  test("a reasoning buffer that is only the answer again is dropped", async () => {
    const h = harness(
      turnScript([
        eventFrame("message.delta", 3, { text: "pong" }),
        eventFrame("thinking.delta", 4, { text: "pong" }),
        eventFrame("message.complete", 5, { text: "pong", status: "complete" }),
      ]),
    );
    const frames = body(await collect(createHermesChat(h.deps).send(BOX, "d", "go")));
    expect(blocks(frames).some((b) => b.kind === "reasoning")).toBe(false);
  });

  /**
   * Upstream's `seq` is per *event*, and one event can produce three frames.
   * Passing it through unchanged is deliberate — it is upstream's replay
   * marker, not a frame counter — so a fixture that increments once per frame
   * certifies something the wire never does.
   */
  test("several frames legitimately share one seq", async () => {
    const h = harness(turnScript(LIVE_TURN));
    const frames = await collect(createHermesChat(h.deps).send(BOX, "default", "ping"));
    const bySeq = new Map<number, number>();
    for (const f of frames) if (f.type !== "error") bySeq.set(f.seq, (bySeq.get(f.seq) ?? 0) + 1);
    expect(bySeq.get(0)).toBe(2);
    expect(bySeq.get(6)).toBe(4);
    // And the gaps are upstream's, not smoothed over.
    expect([...bySeq.keys()].sort((a, b) => a - b)).toEqual([0, 3, 6, 10]);
  });
});

/* ── the unknown contract ─────────────────────────────────────────────────── */

describe("hermes-chat · nothing upstream sends is dropped", () => {
  test("a tool this build has never heard of keeps its name, args and result", async () => {
    const h = harness(
      turnScript([UNKNOWN_TOOL_START, UNKNOWN_TOOL_COMPLETE, RECORDED_MESSAGE_COMPLETE]),
    );
    const tools = blocks(body(await collect(createHermesChat(h.deps).send(BOX, "d", "go")))).filter(
      (b) => b.kind === "tool",
    );
    expect(tools).toHaveLength(2);
    const [running, complete] = tools;
    if (running?.kind !== "tool" || complete?.kind !== "tool") throw new Error("unreachable");

    expect(running.name).toBe("frobnicate_widget");
    expect(running.status).toBe("running");
    // The recognised arguments, *plus* everything else the frame carried that
    // has nowhere better to go — `context` here. Keeping only the keys this
    // build knows gives the same blank render the `unknown` contract exists to
    // prevent, one field at a time instead of all at once.
    expect(running.args).toEqual({
      context: "frobnicate_widget(target=fixture)",
      target: "fixture",
      depth: 2,
    });
    // `tool_id` is the exception: it has a field of its own, because it is how
    // a head matches this running card to the completion that supersedes it.
    // Left among the arguments it would render as something the agent passed.
    expect(running.tool_id).toBe("tc_FIXTURE_1");
    expect(complete.tool_id).toBe("tc_FIXTURE_1");
    // No renderer is claimed for a tool nobody has heard of. `render` is a hint
    // whose absence means "draw the raw payload", which is what makes a
    // `hermes_ref` bump that adds fifty tools cost nothing.
    expect(running.render).toBeNull();
    expect(running.server).toBeNull();

    expect(complete.status).toBe("ok");
    expect(complete.result).toBe("widget frobnicated");
    expect(complete.duration_ms).toBe(812);
  });

  test("an event type from a newer Hermes survives as an unknown block", async () => {
    const h = harness(turnScript([UNKNOWN_EVENT, RECORDED_MESSAGE_COMPLETE]));
    const unknown = blocks(body(await collect(createHermesChat(h.deps).send(BOX, "d", "go")))).find(
      (b) => b.kind === "unknown",
    );
    expect(unknown).toEqual({
      kind: "unknown",
      name: "vault.entry.revealed",
      payload: { entry: "fixture-entry", detail: { nested: ["a", "b"] } },
    });
  });

  test("an MCP tool name is split into server and tool", async () => {
    const h = harness(
      turnScript([
        eventFrame("tool.complete", 3, {
          name: "mcp__linear__create_issue",
          args: { title: "x" },
          result: "ok",
        }),
        RECORDED_MESSAGE_COMPLETE,
      ]),
    );
    const tool = blocks(body(await collect(createHermesChat(h.deps).send(BOX, "d", "go")))).find(
      (b) => b.kind === "tool",
    );
    expect(tool?.kind === "tool" ? tool.server : null).toBe("linear");
  });
});

/* ── tolerating a wire nobody controls ────────────────────────────────────── */

describe("hermes-chat · malformed input", () => {
  test("a truncated document, a blank line and a doubled frame do not end the turn", async () => {
    const h = harness(
      turnScript([TRUNCATED_FRAME, BLANK_FRAME, DOUBLE_FRAME, RECORDED_MESSAGE_COMPLETE]),
    );
    const frames = body(await collect(createHermesChat(h.deps).send(BOX, "d", "go")));
    // The doubled frame carried `message.start` and the first delta; the
    // remainder of "pong" arrives from `message.complete`, which is the same
    // recovery a coalesced turn needs.
    expect(frames.map((f) => f.type)).toEqual(["block", "delta", "delta", "done"]);
    expect(frames.flatMap((f) => (f.type === "delta" ? [f.text] : []))).toEqual(["p", "ong"]);
    expect(frames.some((f) => f.type === "error")).toBe(false);
  });

  test("an event with no type is skipped", async () => {
    const h = harness(turnScript([eventFrame("", 3, {}), RECORDED_MESSAGE_COMPLETE]));
    const frames = body(await collect(createHermesChat(h.deps).send(BOX, "d", "go")));
    expect(frames.flatMap((f) => (f.type === "delta" ? [f.text] : []))).toEqual(["pong"]);
  });

  /**
   * A subagent turn mirrors the same vocabulary onto a *child* session id. It
   * cannot be rendered inline — hermetic has no delegated-turn renderer yet —
   * but dropping it means a turn that delegated all its work renders
   * as nothing at all, which is the same failure the `unknown` contract exists
   * to prevent.
   */
  test("a frame addressed to a subagent session is kept whole, not dropped", async () => {
    const h = harness(
      turnScript([
        eventFrame("message.delta", 4, { text: "child" }, "subagent-9"),
        RECORDED_MESSAGE_COMPLETE,
      ]),
    );
    const frames = body(await collect(createHermesChat(h.deps).send(BOX, "d", "go")));
    // Not mixed into this transcript's text…
    expect(frames.flatMap((f) => (f.type === "delta" ? [f.text] : []))).toEqual(["pong"]);
    // …and not lost either.
    expect(blocks(frames).find((b) => b.kind === "unknown")).toEqual({
      kind: "unknown",
      name: "subagent",
      payload: {
        session: "subagent-9",
        type: "message.delta",
        seq: 4,
        payload: { text: "child" },
      },
    });
  });

  /**
   * Upstream writes `""` where it means "not set", and `ChatMessage.id`,
   * `Session.id`, `Bot.name` and `ToolBlock.name` are all `.min(1)` in the
   * schema — so an empty string reaching one of them is a `ZodError` at
   * whichever head parses it, not a cosmetic problem.
   */
  test("an empty string from the box is absence, and falls through to the fallback", async () => {
    const h = harness(
      turnScript([
        eventFrame("tool.complete", 3, { name: "", args: {}, result: "ok" }),
        RECORDED_MESSAGE_COMPLETE,
      ]),
    );
    const frames = body(await collect(createHermesChat(h.deps).send(BOX, "d", "go")));
    const tool = blocks(frames).find((b) => b.kind === "tool");
    expect(tool?.kind === "tool" ? tool.name : null).toBe("tool");

    const mapped = mapHistory(BOX, SESSION_ID, { messages: [{ id: "", role: "" }] });
    expect(mapped[0]?.id).toMatch(new RegExp(`^${SESSION_ID}:h[0-9a-f]{16}$`));
    expect(mapSessions(BOX, "default", { sessions: [{ session_id: "s1", title: "" }] })[0]?.title).toBe(
      "s1",
    );
  });

  /**
   * The fallback, not the rule: a box that cannot replay from a cursor is the
   * one case where a lost socket still ends the turn where it stopped.
   * `hermes-chat-resume.test.ts` covers the box that can.
   */
  test("a socket that closes mid-turn ends it incomplete when the box cannot replay", async () => {
    const h = harness({
      ...turnScript([eventFrame("message.delta", 3, { text: "half a sen" })]),
      errors: { "session.events.since": { code: -32601, message: "method not found" } },
    });
    const chat = createHermesChat(h.deps);
    const stream = chat.send(BOX, "d", "go");
    const out: ChatFrame[] = [];
    for await (const frame of stream) {
      out.push(frame);
      // Pull the socket out from under the turn mid-sentence.
      if (frame.type === "delta") h.sockets[0]?.close();
    }
    const last = out.at(-1);
    expect(last?.type).toBe("done");
    expect(last?.type === "done" ? last.incomplete : null).toBe(true);
    // No second dial: the gateway said `-32601`, so there is nothing to resume
    // onto and the turn does not spend an outage's worth of attempts finding
    // that out again.
    expect(h.sockets).toHaveLength(1);
  });
});

/* ── the wire, and the things that arrive on it wrong ─────────────────────── */

describe("hermes-chat · frame boundaries", () => {
  /**
   * A WebSocket frame is not a message. The protocol is newline-delimited JSON,
   * so one document may arrive in two frames — and splitting each frame in
   * isolation drops *both* halves: the head does not parse and the tail arrives
   * with no head. When the split document is `message.complete`, the turn never
   * ends.
   */
  test("a document split across two frames is reassembled", async () => {
    const cut = Math.floor(RECORDED_MESSAGE_COMPLETE.length / 2);
    const h = harness(
      turnScript([RECORDED_MESSAGE_COMPLETE.slice(0, cut), RECORDED_MESSAGE_COMPLETE.slice(cut)]),
    );
    const frames = body(await collect(createHermesChat(h.deps).send(BOX, "d", "go")));
    expect(frames.map((f) => f.type)).toEqual(["block", "delta", "done"]);
    expect(frames.flatMap((f) => (f.type === "delta" ? [f.text] : []))).toEqual(["pong"]);
  });

  test("a document split three ways, with a newline boundary in the middle", async () => {
    const start = eventFrame("message.start", 5, {});
    const whole = `${start}\n${RECORDED_MESSAGE_COMPLETE}`;
    const a = whole.slice(0, 20);
    const b = whole.slice(20, start.length + 30);
    const c = whole.slice(start.length + 30);
    const h = harness(turnScript([a, b, c]));
    const frames = body(await collect(createHermesChat(h.deps).send(BOX, "d", "go")));
    expect(frames.at(-1)?.type).toBe("done");
    expect(frames.flatMap((f) => (f.type === "delta" ? [f.text] : []))).toEqual(["pong"]);
  });

  /**
   * Since 0.21.3 upstream sends genuine server→client *requests* for the
   * approval round-trip (§8.2), and those carry both an `id` and a `method`.
   * Both id counters start at 1, so a collision is the normal case rather than
   * an edge one — and treating the inbound request as a response resolved
   * `session.create` with `undefined`.
   */
  test("a server→client request whose id collides with ours is not a response", async () => {
    const h = harness({
      results: {
        "session.create": SESSION_CREATE_RESULT,
        "prompt.submit": PROMPT_SUBMIT_RESULT,
      },
      before: {
        "session.create": [
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "approval.request",
            params: { tool: "bash" },
          }),
        ],
      },
      after: { "prompt.submit": [RECORDED_MESSAGE_COMPLETE] },
    });
    const frames = await collect(createHermesChat(h.deps).send(BOX, "d", "go"));
    expect(frames.some((f) => f.type === "error")).toBe(false);
    expect(frames.at(-1)?.type).toBe("done");
  });

  /**
   * `seq` is monotonic per session and exists for reconnect catch-up, so a
   * frame at or below the highest one already handled is a replay. Without the
   * guard a retransmitted delta doubles a word mid-sentence and nothing notices.
   */
  test("a retransmitted frame is not applied twice", async () => {
    const h = harness(
      turnScript([
        eventFrame("message.start", 5, {}),
        RECORDED_MESSAGE_DELTA_1,
        RECORDED_MESSAGE_DELTA_1,
        RECORDED_MESSAGE_DELTA_2,
        RECORDED_MESSAGE_COMPLETE,
      ]),
    );
    const frames = body(await collect(createHermesChat(h.deps).send(BOX, "d", "go")));
    expect(frames.flatMap((f) => (f.type === "delta" ? [f.text] : []))).toEqual(["p", "ong"]);
  });
});

/* ── block ordering ───────────────────────────────────────────────────────── */

describe("hermes-chat · block ordering", () => {
  /**
   * `DeltaFrame` appends to the *last text block*, so a text block still
   * considered open after a tool renders the agent's next sentence above the
   * tool it was commenting on. Text → tool → text is the ordinary shape of a
   * turn, which made this the ordinary case rather than an edge one.
   */
  test("prose after a tool call opens a new text block", async () => {
    const h = harness(
      turnScript([
        eventFrame("message.start", 3, {}),
        eventFrame("message.delta", 4, { text: "Checking." }),
        eventFrame("tool.complete", 5, { name: "bash", args: {}, result: "ok" }),
        eventFrame("message.delta", 6, { text: " It is masked." }),
        eventFrame("message.complete", 7, { text: "Checking. It is masked.", status: "complete" }),
      ]),
    );
    const frames = body(await collect(createHermesChat(h.deps).send(BOX, "d", "go")));
    expect(frames.map((f) => (f.type === "block" ? `block:${f.block.kind}` : f.type))).toEqual([
      "block:text",
      "delta",
      "block:tool",
      "block:text",
      "delta",
      "done",
    ]);
  });

  test("a reasoning block also closes the open paragraph", async () => {
    const h = harness(
      turnScript([
        eventFrame("message.start", 3, {}),
        eventFrame("message.delta", 4, { text: "one" }),
        eventFrame("thinking.delta", 5, { text: "hmm" }),
        eventFrame("message.delta", 6, { text: "two" }),
        eventFrame("message.complete", 7, { text: "onetwo", status: "complete" }),
      ]),
    );
    const frames = body(await collect(createHermesChat(h.deps).send(BOX, "d", "go")));
    expect(frames.map((f) => (f.type === "block" ? `block:${f.block.kind}` : f.type))).toEqual([
      "block:text",
      "delta",
      "block:activity",
      "block:activity",
      "block:reasoning",
      "block:text",
      "delta",
      "done",
    ]);
  });

  /**
   * When upstream's final text merely normalises what it streamed — a trimmed
   * lead, rewrapped markdown, a stripped newline — `startsWith` fails, and an
   * earlier version then appended the entire answer a second time.
   */
  test("a normalised final text does not duplicate the answer", async () => {
    const h = harness(
      turnScript([
        eventFrame("message.start", 3, {}),
        eventFrame("message.delta", 4, { text: "  Hello there\n" }),
        eventFrame("message.complete", 5, { text: "Hello there", status: "complete" }),
      ]),
    );
    const frames = body(await collect(createHermesChat(h.deps).send(BOX, "d", "go")));
    expect(frames.flatMap((f) => (f.type === "delta" ? [f.text] : []))).toEqual(["  Hello there\n"]);
  });

  test("a final text that genuinely extends the stream is appended once", async () => {
    const h = harness(
      turnScript([
        eventFrame("message.start", 3, {}),
        eventFrame("message.delta", 4, { text: "Hello" }),
        eventFrame("message.complete", 5, { text: "Hello there", status: "complete" }),
      ]),
    );
    const frames = body(await collect(createHermesChat(h.deps).send(BOX, "d", "go")));
    expect(frames.flatMap((f) => (f.type === "delta" ? [f.text] : []))).toEqual(["Hello", " there"]);
  });
});

/* ── abort ────────────────────────────────────────────────────────────────── */

describe("hermes-chat · abort", () => {
  test("an AbortSignal stops the turn, interrupts the box and reports incomplete", async () => {
    const h = harness(turnScript(RECORDED_TURN));
    const control = new AbortController();
    const out: ChatFrame[] = [];
    for await (const frame of createHermesChat(h.deps).send(BOX, "d", "go", {
      signal: control.signal,
    })) {
      out.push(frame);
      if (frame.type === "delta") control.abort();
    }
    const last = out.at(-1);
    expect(last?.type).toBe("done");
    expect(last?.type === "done" ? last.incomplete : null).toBe(true);
    // The box is told. A turn abandoned without an interrupt keeps burning a
    // warm slot and a provider bill on a box nobody is watching.
    expect(h.sockets[0]?.sent.map((s) => s.method)).toContain("session.interrupt");
    // And only the deltas that arrived before the stop are in the transcript.
    expect(out.flatMap((f) => (f.type === "delta" ? [f.text] : []))).toEqual(["p"]);
  });

  /**
   * An operator who pressed stop generally pressed it *because* of what the
   * thinking said. Throwing the buffer away throws away the answer to "why did
   * I stop this".
   */
  test("aborting keeps the reasoning buffered so far", async () => {
    const h = harness({
      ...turnScript([eventFrame("thinking.delta", 3, { text: "this is going badly" })]),
      slotWaitMs: 2_000,
    });
    const control = new AbortController();
    const timer = setTimeout(() => control.abort(), 20);
    const out = await collect(
      createHermesChat(h.deps).send(BOX, "d", "go", { signal: control.signal }),
    );
    clearTimeout(timer);
    expect(blocks(body(out)).filter((block) => block.kind === "reasoning")).toEqual([
      { kind: "reasoning", text: "this is going badly", duration_ms: null, tokens: null },
    ]);
    expect(out.at(-1)?.type).toBe("done");
  });

  test("an idle bot abort is a no-op, with no create or interrupt", async () => {
    const h = harness({ results: { "session.list": { sessions: [] } } });
    expect(await createHermesChat(h.deps).abort(BOX, "default")).toBe(false);
    expect(h.sockets[0]?.sent.map((call) => call.method)).toEqual(["session.list"]);
  });

  test("external abort resumes the exact profile and stops only an explicitly running runtime", async () => {
    for (const running of [true, false]) {
      const h = harness({
        results: {
          "session.resume": {
            session_id: "runtime-other",
            running,
            status: running ? "working" : "idle",
            info: {},
          },
          "session.interrupt": { status: "interrupted" },
        },
      });
      expect(await createHermesChat(h.deps).abort(BOX, "research", { session: SESSION_ID })).toBe(
        running,
      );
      const calls = h.sockets[0]?.sent ?? [];
      expect(calls[0]?.params).toEqual({
        session_id: SESSION_ID,
        profile: "research",
        source: "hermetic",
        lazy: true,
        omit_messages: true,
      });
      expect(calls.slice(1).map((call) => call.params)).toEqual(
        running ? [{ session_id: "runtime-other", profile: "research" }] : [],
      );
    }
  });

  test("a live session the box has not written down yet can still be stopped", async () => {
    /**
     * Upstream's `_resume_live_unpersisted` (`methods_session.py`) answers for
     * every Bot Chat until its first flush: no `running` key at all, a
     * `stored_session_id`, and `info.lazy` marking the attach rather than a
     * child watch. Requiring a boolean `running` made a cross-process
     * `chat.abort` against a fresh Bot Chat a protocol error, and reading
     * `lazy` before that made it a child watch.
     */
    const h = harness({
      results: {
        "session.resume": {
          session_id: "live-unpersisted",
          stored_session_id: SESSION_ID,
          message_count: 0,
          messages: [],
          info: { model: "m", lazy: true, profile_name: "research" },
        },
        "session.interrupt": { status: "interrupted" },
      },
    });
    expect(await createHermesChat(h.deps).abort(BOX, "research", { session: SESSION_ID })).toBe(true);
    expect(h.sockets[0]?.sent.map((call) => call.method)).toEqual([
      "session.resume",
      "session.interrupt",
    ]);
    expect(h.sockets[0]?.sent[1]?.params).toEqual({
      session_id: "live-unpersisted",
      profile: "research",
    });
  });

  test("a resume that is neither running nor the unpersisted shape is a protocol error", async () => {
    // No `running`, and no `stored_session_id`/`info.lazy` either: the adapter
    // must not guess that silence means live.
    const h = harness({
      results: { "session.resume": { session_id: "runtime-other", info: {} } },
    });
    await expect(
      createHermesChat(h.deps).abort(BOX, "research", { session: SESSION_ID }),
    ).rejects.toMatchObject({ code: "CHAT_PROTOCOL" });
    expect(h.sockets[0]?.sent.map((call) => call.method)).toEqual(["session.resume"]);
  });

  test("a relayed running child watch never gets warmed by interrupt", async () => {
    const h = harness({
      results: {
        "session.resume": {
          session_id: "watch-runtime",
          running: true,
          status: "streaming",
          info: { lazy: true },
        },
      },
    });
    await expect(
      createHermesChat(h.deps).abort(BOX, "research", { session: SESSION_ID }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(h.sockets[0]?.sent.map((call) => call.method)).toEqual(["session.resume"]);
  });
});

/* ── the token ────────────────────────────────────────────────────────────── */

describe("hermes-chat · the session token", () => {
  test("is scraped from the SPA page and carried on the socket URL", async () => {
    const h = harness(turnScript([RECORDED_MESSAGE_COMPLETE]));
    await collect(createHermesChat(h.deps).send(BOX, "d", "go"));
    expect(h.fetches[0]?.url).toBe(BOX.baseUrl);
    // `Origin` and **only** `Origin`, on both hops. Serve's nginx already
    // rewrites `Host`; sending one from here is not belt-and-braces, it is a
    // request aimed at the laptop's own loopback. See `DIRECT_DIAL_HEADERS`.
    expect(h.fetches[0]?.headers).toEqual({ Origin: "http://127.0.0.1:9119" });
    expect(h.sockets[0]?.headers).toEqual({ Origin: "http://127.0.0.1:9119" });
    expect(Object.keys(h.fetches[0]?.headers ?? {})).not.toContain("Host");
    const url = new URL(h.sockets[0]?.url ?? "");
    expect(url.protocol).toBe("wss:");
    expect(url.pathname).toBe("/api/ws");
    expect(url.searchParams.get("token")).toBe(FIXTURE_SESSION_TOKEN);
  });

  test("is scraped once and reused across calls", async () => {
    const h = harness({ results: { "profiles.list": PROFILES_LIST_RESULT } });
    const chat = createHermesChat(h.deps);
    await chat.swarm(BOX);
    await chat.swarm(BOX);
    expect(h.fetches).toHaveLength(1);
  });

  test("is re-scraped when a cached one is refused — it dies with the dashboard", async () => {
    const h = harness({ results: { "profiles.list": PROFILES_LIST_RESULT } });
    const chat = createHermesChat(h.deps);
    await chat.swarm(BOX);
    expect(h.fetches).toHaveLength(1);

    // The box restarted `hermes-dashboard.service`: the cached token is now a
    // token for a process that no longer exists, and the upgrade is refused.
    h.refuse(1);
    const swarm = await chat.swarm(BOX);

    // Scraped again, and the call succeeded on the retry rather than reporting
    // a box that is perfectly healthy as unreachable.
    expect(h.fetches).toHaveLength(2);
    expect(swarm.reachable).toBe(true);
    expect(h.sockets).toHaveLength(3);
  });

  test("a token scraped one line ago and then refused is not retried forever", async () => {
    const h = harness({ results: { "profiles.list": PROFILES_LIST_RESULT }, refuseOpens: 5 });
    const swarm = await createHermesChat(h.deps).swarm(BOX);
    expect(swarm.reachable).toBe(false);
    // One dial, no retry: nothing was cached, so a refusal is the box saying no.
    expect(h.sockets).toHaveLength(1);
  });

  /**
   * The token rides in the socket's query string, so the URL is a live
   * credential — and the `ChatSocket` implementations that reject `opened`
   * build their message out of that URL. Letting it through put the token in
   * `~/.hermetic/portal.log`, in the JSON error body a head returns, and in the
   * `runs` table: three places it outlives the process it belongs to.
   */
  test("a refused socket never puts the session token in the error", async () => {
    const h = harness({ refuseOpens: 5 });
    const err = await createHermesChat(h.deps)
      .sessions(BOX, "default")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HermeticError);
    const thrown = err as HermeticError;

    // The dial really did carry the token, or this test proves nothing.
    expect(h.sockets[0]?.url).toContain(FIXTURE_SESSION_TOKEN);
    expect(thrown.message).not.toContain(FIXTURE_SESSION_TOKEN);
    expect(JSON.stringify(thrown.details ?? {})).not.toContain(FIXTURE_SESSION_TOKEN);
    // It still names the box, by origin rather than by the URL that was dialled.
    expect(thrown.message).toContain("https://fxtr0001-veronica.tail0000.ts.net");
    expect(thrown.message).toContain("[redacted]");
  });

  test("a turn against a refused socket does not leak the token into its error frame", async () => {
    const h = harness({ refuseOpens: 5 });
    const frames = await collect(createHermesChat(h.deps).send(BOX, "d", "go"));
    const last = frames.at(-1);
    expect(last?.type).toBe("error");
    expect(JSON.stringify(frames)).not.toContain(FIXTURE_SESSION_TOKEN);
  });

  test("a page with no token is CHAT_NO_TOKEN, not a crash", async () => {
    const h = harness({ html: DASHBOARD_HTML_NO_TOKEN });
    await expect(createHermesChat(h.deps).sessions(BOX, "default")).rejects.toMatchObject({
      code: "CHAT_NO_TOKEN",
    });
  });

  test("CHAT_NO_TOKEN reaches a turn as an error frame, not as a rejection", async () => {
    const h = harness({ html: DASHBOARD_HTML_NO_TOKEN });
    const frames = await collect(createHermesChat(h.deps).send(BOX, "d", "go"));
    const last = frames.at(-1);
    expect(last?.type).toBe("error");
    expect(last?.type === "error" ? last.code : null).toBe("CHAT_NO_TOKEN");
  });

  test("a dashboard that does not answer is CHAT_UNREACHABLE", async () => {
    const h = harness({ htmlThrows: true });
    const err = await createHermesChat(h.deps)
      .sessions(BOX, "default")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HermeticError);
    expect((err as HermeticError).code).toBe("CHAT_UNREACHABLE");
  });

  test("a dashboard answering 5xx is CHAT_UNREACHABLE too", async () => {
    const h = harness({ htmlStatus: 502 });
    await expect(createHermesChat(h.deps).sessions(BOX, "default")).rejects.toMatchObject({
      code: "CHAT_UNREACHABLE",
    });
  });
});

/* ── warm slots ───────────────────────────────────────────────────────────── */

describe("hermes-chat · warm slots", () => {
  test.each(["thinking.delta", "reasoning.delta"])(
    "%s announces live thinking before buffered text and keeps the turn alive",
    async (type) => {
      const h = harness({
        ...turnScript([eventFrame(type, 3, { text: "Considering the answer" })]),
        slotWaitMs: 10,
      });
      const control = new AbortController();
      const out: ChatFrame[] = [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        for await (const frame of createHermesChat(h.deps).send(BOX, "d", "go", {
          signal: control.signal,
        })) {
          out.push(frame);
          if (
            frame.type === "block" &&
            frame.block.kind === "activity" &&
            frame.block.key === "reasoning" &&
            frame.block.state === "running"
          ) {
            expect(blocks(out).some((block) => block.kind === "reasoning")).toBe(false);
            timer = setTimeout(() => control.abort(), 40);
          }
        }
      } finally {
        clearTimeout(timer);
      }
      expect(control.signal.aborted).toBe(true);
      expect(out.at(-1)).toMatchObject({ type: "done", incomplete: true });
      expect(
        blocks(out).filter((block) => block.kind === "activity" && block.key === "reasoning"),
      ).toMatchObject([
        { category: "generation", state: "running" },
        { category: "generation", state: "done" },
      ]);
    },
  );

  test("nothing at all after prompt.submit is CHAT_NO_SLOT, and the box is told", async () => {
    // `prompt.submit` is accepted and then nothing arrives — upstream waiting
    // for one of the gateway's three warm backends (§9.2).
    const h = harness(turnScript([]));
    const frames = await collect(createHermesChat(h.deps).send(BOX, "d", "go"));
    const last = frames.at(-1);
    expect(last?.type).toBe("error");
    if (last?.type !== "error") throw new Error("unreachable");
    expect(last.code).toBe("CHAT_NO_SLOT");
    expect(last.message).toContain("warm backend slot");
    // A turn nobody is reading still holds the slot and still bills the
    // provider, so the timeout interrupts exactly like the abort path does.
    expect(h.sockets[0]?.sent.map((c) => c.method)).toContain("session.interrupt");
  });

  /**
   * A model that thinks for thirty-one seconds before its first token looks
   * identical from up here. Claiming `CHAT_NO_SLOT` for it sends an operator
   * off to free a warm slot that was never the problem, so the claim is only
   * made when the gateway said nothing whatsoever after the prompt.
   */
  test("a gateway that was talking does not get blamed for a full slot", async () => {
    const h = harness(turnScript([eventFrame("sessions.changed", 3, {})]));
    const frames = await collect(createHermesChat(h.deps).send(BOX, "d", "go"));
    const last = frames.at(-1);
    expect(last?.type).toBe("error");
    expect(last?.type === "error" ? last.code : null).toBe("CHAT_TURN_FAILED");
    expect(h.sockets[0]?.sent.map((c) => c.method)).toContain("session.interrupt");
  });

  test("a long tool call after the first frame is not a timeout", async () => {
    const h = harness(turnScript([eventFrame("message.delta", 3, { text: "working" })]));
    const chat = createHermesChat(h.deps);
    const stream = chat.send(BOX, "d", "go");
    const out: ChatFrame[] = [];
    for await (const frame of stream) {
      out.push(frame);
      if (frame.type === "delta") {
        // Far longer than the 50 ms deadline, which must no longer apply.
        await new Promise((r) => setTimeout(r, 120));
        h.sockets[0]?.close();
      }
    }
    expect(out.some((f) => f.type === "error")).toBe(false);
  });
});

/* ── the roster ───────────────────────────────────────────────────────────── */

describe("hermes-chat · swarm", () => {
  test("maps the probed box: a swarm of one, reachable, no rooms", async () => {
    const h = harness({
      results: {
        "profiles.list": PROFILES_LIST_RESULT,
        "groups.list": GROUPS_LIST_RESULT,
        "agents.list": AGENTS_LIST_RESULT,
      },
    });
    const swarm = await createHermesChat(h.deps).swarm(BOX);
    expect(swarm.reachable).toBe(true);
    expect(swarm.rooms).toEqual([]);
    expect(swarm.warm_slots).toEqual({ used: 0, total: WARM_SLOTS_PER_GATEWAY });
    expect(swarm.bots).toHaveLength(1);
    const bot = swarm.bots[0];
    expect(bot?.name).toBe("default");
    expect(bot?.is_default).toBe(true);
    // `display_name` came back as the empty string, which is absent, not a title.
    expect(bot?.title).toBe("default");
    // §9.2: seeded from fleet/instance/bot, never from the display name.
    expect(bot?.avatar_seed).toBe("fxtr0001/veronica/default");
  });

  test("a bot's title follows Desktop's precedence: Bot Mode title, display name, profile name", async () => {
    const row = (name: string, extra: Record<string, unknown>) => ({ name, ...extra });
    const h = harness({
      results: {
        "profiles.list": {
          profiles: [
            row("scribe", {
              display_name: "Core name",
              ui_meta: { "hermes-bots": { title: " Marshall ", custom: true } },
            }),
            row("auditor", { display_name: "Core name", ui_meta: { "hermes-bots": { title: "  " } } }),
            row("clio", { display_name: "", ui_meta: { "hermes-bots": { custom: true } } }),
          ],
        },
        "groups.list": GROUPS_LIST_RESULT,
        "agents.list": AGENTS_LIST_RESULT,
      },
    });
    const swarm = await createHermesChat(h.deps).swarm(BOX);
    expect(swarm.bots.map((b) => [b.name, b.title])).toEqual([
      ["scribe", "Marshall"],
      ["auditor", "Core name"],
      ["clio", "clio"],
    ]);
  });

  test("an unreachable box is a value the rail can draw, not a thrown error", async () => {
    const h = harness({ htmlThrows: true });
    const swarm = await createHermesChat(h.deps).swarm(BOX);
    expect(swarm.reachable).toBe(false);
    expect(swarm.unreachable_reason).toContain("did not answer");
    expect(swarm.bots).toEqual([]);
  });

  test("a box that refuses groups.list still has a roster", async () => {
    const h = harness({
      results: { "profiles.list": PROFILES_LIST_RESULT },
      errors: { "groups.list": { code: -32601, message: "Method not found" } },
    });
    const swarm = await createHermesChat(h.deps).swarm(BOX);
    expect(swarm.reachable).toBe(true);
    expect(swarm.bots).toHaveLength(1);
  });

  test("a live process marks its profile warm", () => {
    const swarm = mapSwarm(
      BOX,
      { profiles: [{ name: "default", is_default: true }, { name: "granite" }] },
      { rooms: [{ id: "r1", name: "Ops", members: ["default", { bot: "granite" }] }] },
      { processes: [{ profile: "granite" }] },
      null,
    );
    expect(swarm.bots.map((b) => [b.name, b.warm])).toEqual([
      ["default", false],
      ["granite", true],
    ]);
    expect(swarm.warm_slots).toEqual({ used: 1, total: WARM_SLOTS_PER_GATEWAY });
    expect(swarm.rooms[0]?.members).toEqual([
      { instance: "veronica", bot: "default" },
      { instance: "veronica", bot: "granite" },
    ]);
  });

  test("a profile row missing every optional field still produces a bot", () => {
    const swarm = mapSwarm(BOX, { profiles: [{ name: "sparse" }, {}, "junk"] }, null, null, null);
    expect(swarm.bots).toHaveLength(1);
    expect(swarm.bots[0]).toMatchObject({
      name: "sparse",
      title: "sparse",
      description: null,
      is_default: false,
      model: null,
      warm: false,
    });
  });

  /**
   * The field the `chat.message` source diffs against a watermark on every
   * roster read.
   *
   * It was hardcoded null, which is not "unknown" — it is "this bot has never
   * spoken", for every bot, forever, so the observer's `if (at == null) continue`
   * fired on every read and no notification could ever be raised. Every test that
   * should have caught it faked `deps.hermes.swarm` and handed back a bot with a
   * timestamp the real mapper could not produce. So this one goes through the
   * real `mapSwarm`.
   */
  test("a bot carries when it last spoke, mapped from the box's own session list", () => {
    const swarm = mapSwarm(
      BOX,
      { profiles: [{ name: "default", is_default: true }, { name: "granite" }] },
      null,
      null,
      SESSION_LIST_POPULATED,
    );
    const at = Object.fromEntries(swarm.bots.map((b) => [b.name, b.last_message_at]));
    expect(at.default).not.toBeNull();
    // The most recent of a bot's sessions wins, not the first or the last listed.
    expect(at.granite).toBe("2026-09-17T10:15:00.000Z");
  });

  test("a session naming no profile lands on the bot that is $HERMES_HOME", () => {
    const swarm = mapSwarm(
      BOX,
      { profiles: [{ name: "default", is_default: true }, { name: "granite" }] },
      null,
      null,
      SESSION_LIST_POPULATED,
    );
    // The unattributed row is 2026-09-17T11:00:00Z — later than `default`'s own
    // session — so if it were dropped the watermark would be the older one.
    expect(swarm.bots.find((b) => b.name === "default")?.last_message_at).toBe(
      new Date(1789642800 * 1000).toISOString(),
    );
  });

  /**
   * The diff the `chat.message` source actually performs: read, store, read again, notice.
   */
  test("a later read is detectable as newer than the watermark before it", () => {
    const profiles = { profiles: [{ name: "granite" }] };
    const before = mapSwarm(BOX, profiles, null, null, {
      sessions: [{ id: "s1", bot: "granite", last_message_at: "2026-09-17T10:15:00.000Z" }],
    });
    const after = mapSwarm(BOX, profiles, null, null, {
      sessions: [
        { id: "s1", bot: "granite", last_message_at: "2026-09-17T10:15:00.000Z" },
        { id: "s2", bot: "granite", last_message_at: "2026-09-17T11:42:00.000Z" },
      ],
    });
    const watermark = before.bots[0]?.last_message_at ?? null;
    const now = after.bots[0]?.last_message_at ?? null;
    expect(watermark).toBe("2026-09-17T10:15:00.000Z");
    expect(now).toBe("2026-09-17T11:42:00.000Z");
    // `Iso` is UTC with milliseconds, so the observer's comparison is lexical.
    expect(now !== null && watermark !== null && now > watermark).toBe(true);
  });

  test("a bot nobody has spoken to reports no watermark rather than a zero", () => {
    const swarm = mapSwarm(BOX, PROFILES_LIST_RESULT, null, null, SESSION_LIST_RESULT);
    expect(swarm.bots[0]?.last_message_at).toBeNull();
  });

  /**
   * The cost argument, asserted rather than claimed. §9.2 requires that reading
   * another bot's history must not take one of the gateway's three warm backend
   * slots; `session.list` is a metadata read that opens no backend, and there is
   * one of it however many bots the box has.
   */
  test("the roster read stays one session.list, not one per bot", async () => {
    const h = harness({
      results: {
        "profiles.list": {
          profiles: [{ name: "default", is_default: true }, { name: "granite" }, { name: "atlas" }],
        },
        "session.list": SESSION_LIST_POPULATED,
      },
    });
    const swarm = await createHermesChat(h.deps).swarm(BOX);
    expect(swarm.bots).toHaveLength(3);
    const calls = h.sockets[0]?.sent.map((c) => c.method) ?? [];
    expect(calls.filter((m) => m === "session.list")).toHaveLength(1);
    // Unscoped: one read covering every bot, rather than one scoped read each.
    expect(h.sockets[0]?.sent.find((c) => c.method === "session.list")?.params).toEqual({});
    // And no turn was started, so no warm slot was taken.
    expect(calls).not.toContain("prompt.submit");
    expect(calls).not.toContain("session.create");
    expect(swarm.bots.find((b) => b.name === "granite")?.last_message_at).toBe(
      "2026-09-17T10:15:00.000Z",
    );
  });

  test("a box that refuses session.list still has a roster, without watermarks", async () => {
    const h = harness({
      results: { "profiles.list": PROFILES_LIST_RESULT },
      errors: { "session.list": { code: -32601, message: "Method not found" } },
    });
    const swarm = await createHermesChat(h.deps).swarm(BOX);
    expect(swarm.reachable).toBe(true);
    expect(swarm.bots).toHaveLength(1);
    expect(swarm.bots[0]?.last_message_at).toBeNull();
  });

  test("a swarm with no fleet id still seeds a stable avatar", () => {
    const swarm = mapSwarm(
      { instance: "veronica", baseUrl: "" },
      PROFILES_LIST_RESULT,
      null,
      null,
      null,
    );
    expect(swarm.bots[0]?.avatar_seed).toBe("veronica/default");
  });
});

/* ── the captured roster ──────────────────────────────────────────────────── */

/**
 * Everything here runs against `fixtures/probe-session-list.json` — the four
 * roster RPCs as a live 0.21.3 box answered them — and not against anything this
 * repo made up.
 *
 * That distinction is the whole reason the block exists. The previous watermark
 * tests were written from invented field names, passed, and certified a mapper
 * that returned null for every row a real box sends.
 */

/** The capture with each profile's `last_session` removed, as an older Hermes answers. */
function withoutLastSession(profiles: unknown): unknown {
  const rows = (profiles as { profiles: Record<string, unknown>[] }).profiles;
  return {
    profiles: rows.map(({ last_session: _dropped, ...rest }) => rest),
  };
}

describe("hermes-chat · the captured roster", () => {
  /**
   * The test that was missing. `last_message_at` was hardcoded null, then
   * mapped from field names no box uses; both times the suite was green and the
   * box said nothing. This asserts the real payload produces a real instant.
   */
  test("a bot's watermark comes back non-null from the real profiles.list", () => {
    const swarm = mapSwarm(BOX, LIVE_PROFILES_LIST, LIVE_GROUPS_LIST, LIVE_AGENTS_LIST, null);
    expect(swarm.bots).toHaveLength(1);
    const bot = swarm.bots[0];
    expect(bot?.name).toBe("default");
    expect(bot?.last_message_at).not.toBeNull();
    // `last_session.last_active`, which is the field that means what this means.
    expect(bot?.last_message_at).toBe(LIVE_BOT_WATERMARK);
  });

  test("the watermark is last_active, not the session's start", () => {
    // The capture's `last_session` carries both, three seconds apart. Taking
    // `started_at` would make a bot mid-conversation look quieter than it is.
    expect(LIVE_BOT_WATERMARK > LIVE_NEWEST_SESSION_START).toBe(true);
    const swarm = mapSwarm(BOX, LIVE_PROFILES_LIST, null, null, null);
    expect(swarm.bots[0]?.last_message_at).toBe(LIVE_BOT_WATERMARK);
  });

  /**
   * Free, from the roster read that was already happening. §9.2 rules out the
   * alternative — a history read per bot per repaint takes a warm slot.
   */
  test("a bot's preview comes off the same last_session as its watermark", () => {
    const swarm = mapSwarm(BOX, LIVE_PROFILES_LIST, LIVE_GROUPS_LIST, LIVE_AGENTS_LIST, null);
    expect(swarm.bots[0]?.preview).toBe("pong");
  });

  /**
   * §9.2: the rail's Bots entries *are* the canonical Bot Chat, so the words
   * under one have to come from Bot Chat and not from whatever the bot last
   * did somewhere else.
   *
   * The shapes below are the live 2026-09-19 `profiles.list` for
   * `silent-crane/clown`, which is the box that showed the bug: a rail quoting
   * "Received loud and clear, five by five…" from a CLI thread above a Bot Chat
   * whose `message_count` is 0.
   */
  describe("the canonical Bot Chat is what a rail entry describes", () => {
    const CLI_SESSION = {
      id: "20260918_030522_7d8894",
      title: "Confirm receipt and socket joke",
      preview: "Received loud and clear, five by five, and plugged in.",
      started_at: 1789700726.12188,
      last_active: 1789700730.1766882,
      message_count: 2,
    };
    const profiles = (canonical: unknown) => ({
      profiles: [{ name: "clown", last_session: CLI_SESSION, canonical_session: canonical }],
      bot_mode_protocol: true,
    });

    test("preview quotes Bot Chat, never the bot's latest other session", () => {
      const swarm = mapSwarm(
        BOX,
        profiles({
          id: "20260918_155526_cf677c",
          root_title: "Bot Chat",
          title: "Bot Chat",
          preview: "pong",
          started_at: 1789746927.0123281,
          last_active: 1789804274.5808601,
          message_count: 66,
        }),
        null,
        null,
        null,
      );
      expect(swarm.bots[0]?.preview).toBe("pong");
      // The canonical session is the newer of the two, and the watermark says so.
      expect(swarm.bots[0]?.last_message_at).toBe("2026-09-19T07:51:14.580Z");
    });

    test("an empty Bot Chat previews as nothing, not as the CLI thread's words", () => {
      const swarm = mapSwarm(
        BOX,
        profiles({
          id: "20260919_032022_09754d",
          root_title: "Bot Chat",
          title: "Bot Chat",
          preview: "",
          started_at: 1789788022.289907,
          last_active: 1789788022.289907,
          message_count: 0,
        }),
        null,
        null,
        null,
      );
      expect(swarm.bots[0]?.preview).toBeNull();
      // An empty session's `last_active` is when the portal created it, which is
      // not this bot speaking: the watermark stays on the session it did speak
      // in, so the `chat.message` source raises nothing for a conversation with nothing in it.
      expect(swarm.bots[0]?.last_message_at).toBe("2026-09-18T03:05:30.176Z");
    });

    test("a gateway that names no canonical session keeps the last_session preview", () => {
      const swarm = mapSwarm(BOX, profiles(null), null, null, null);
      expect(swarm.bots[0]?.preview).toBe(CLI_SESSION.preview);
      expect(swarm.bots[0]?.last_message_at).toBe("2026-09-18T03:05:30.176Z");
    });
  });

  test("a bot on a Hermes with no last_session has a null preview, not somebody else's", async () => {
    const h = harness({
      results: {
        "profiles.list": withoutLastSession(LIVE_PROFILES_LIST),
        "session.list": LIVE_SESSION_LIST,
      },
    });
    const swarm = await createHermesChat(h.deps).swarm(BOX);
    // The fallback fold supplies a watermark, because a session row has a time.
    // It supplies no preview, because a session row names no profile and
    // attributing one bot's words to another is worse than showing none.
    expect(swarm.bots[0]?.last_message_at).toBe(LIVE_NEWEST_SESSION_START);
    expect(swarm.bots[0]?.preview).toBeNull();
  });

  test("a real session row maps its float-of-seconds started_at", () => {
    const sessions = mapSessions(BOX, "default", LIVE_SESSION_LIST);
    expect(sessions).toHaveLength(4);
    // Every row, not merely the first: the failure this replaces was uniform.
    expect(sessions.every((row) => row.last_message_at !== null)).toBe(true);
    const newest = sessions
      .map((row) => row.last_message_at ?? "")
      .sort()
      .at(-1);
    expect(newest).toBe(LIVE_NEWEST_SESSION_START);
    expect(sessions[0]?.id).toBe("20260917_164150_c64654");
    expect(sessions[0]?.title).toBe("Reply with pong #2");
    expect(sessions[0]?.turn_count).toBe(2);
  });

  test("a real session row carries the box's own preview, truncated by the box", () => {
    const sessions = mapSessions(BOX, "default", LIVE_SESSION_LIST);
    expect(sessions[0]?.preview).toBe("Reply with exactly the word: pong");
    // Upstream's own cut, ellipsis and all — not this adapter's.
    expect(sessions[2]?.preview).toBe(
      "I'm trying to test the remote browser setup.  can you open t...",
    );
    expect(sessions.every((row) => row.preview !== null)).toBe(true);
  });

  test("a session list with no preview field leaves it null", () => {
    expect(mapSessions(BOX, "default", { sessions: [{ id: "s1" }] })[0]?.preview).toBeNull();
  });

  /**
   * `portal` is the one origin that suppresses the composer's restatement of
   * where a reply is going, so it has to be positively identified — and nothing
   * upstream sends can identify it. Every captured row says `source: "tui"`.
   */
  test("upstream's source is mapped deliberately and never to portal", () => {
    const captured = mapSessions(BOX, "default", LIVE_SESSION_LIST);
    expect(captured.map((row) => row.origin)).toEqual(["cli", "cli", "cli", "cli"]);

    const spread = mapSessions(BOX, "default", {
      sessions: [
        { id: "a", source: "tui" },
        { id: "b", source: "cron" },
        { id: "c", source: "slack" },
        { id: "d", source: "bot" },
        { id: "e", source: "web" },
        { id: "f", source: "bot_room" },
        { id: "g", source: "something-this-build-has-never-seen" },
        // Upstream uses this word for its Vercel integration, not for hermetic's
        // portal. Trusting it would switch off the safety restatement.
        { id: "h", source: "portal" },
        { id: "i", origin: "portal" },
        { id: "j" },
        // What hermetic itself stamps on create/resume: some hermetic opened
        // it, which is foreign — not *this* laptop's `portal`.
        { id: "k", source: "hermetic" },
        // The gateway's Platform enum: the box's own CLI, and two channels.
        { id: "l", source: "local" },
        { id: "m", source: "matrix" },
        { id: "n", source: "api_server" },
      ],
    });
    expect(spread.map((row) => row.origin)).toEqual([
      "cli",
      "routine",
      "channel",
      "peer",
      "desktop",
      "room",
      "cli",
      "cli",
      "cli",
      "cli",
      "hermetic",
      "cli",
      "channel",
      "channel",
    ]);
    expect(spread.some((row) => row.origin === "portal")).toBe(false);
  });

  /**
   * The box has no live bot processes, and the key is present and empty rather
   * than missing — so a zero here is the observed case, not a shape mismatch
   * being read as one.
   */
  test("the empty agents.list is the empty case, not an unread shape", () => {
    expect(Object.keys(LIVE_AGENTS_LIST as object)).toEqual(["processes"]);
    expect((LIVE_AGENTS_LIST as { processes: unknown[] }).processes).toEqual([]);
    const swarm = mapSwarm(BOX, LIVE_PROFILES_LIST, LIVE_GROUPS_LIST, LIVE_AGENTS_LIST, null);
    expect(swarm.warm_slots).toEqual({ used: 0, total: WARM_SLOTS_PER_GATEWAY });
    expect(swarm.bots[0]?.warm).toBe(false);
  });

  test("the real roster read never asks for a session list", async () => {
    const h = harness({
      results: {
        "profiles.list": LIVE_PROFILES_LIST,
        "groups.list": LIVE_GROUPS_LIST,
        "agents.list": LIVE_AGENTS_LIST,
      },
    });
    const swarm = await createHermesChat(h.deps).swarm(BOX);
    expect(swarm.bots[0]?.last_message_at).toBe(LIVE_BOT_WATERMARK);
    // The watermark rode in on a call the bot list needed anyway: three round
    // trips, not four, and no read scoped to a bot.
    const calls = h.sockets[0]?.sent.map((c) => c.method) ?? [];
    expect(calls).toEqual(["profiles.list", "groups.list", "agents.list"]);
  });

  test("an older Hermes with no last_session falls back to one session.list", async () => {
    const h = harness({
      results: {
        "profiles.list": withoutLastSession(LIVE_PROFILES_LIST),
        "groups.list": LIVE_GROUPS_LIST,
        "agents.list": LIVE_AGENTS_LIST,
        "session.list": LIVE_SESSION_LIST,
      },
    });
    const swarm = await createHermesChat(h.deps).swarm(BOX);
    // A real session row names no profile, so the fold lands on the bot that is
    // `$HERMES_HOME` — which on this box is the only bot there is.
    expect(swarm.bots[0]?.last_message_at).toBe(LIVE_NEWEST_SESSION_START);
    const calls = h.sockets[0]?.sent.map((c) => c.method) ?? [];
    expect(calls.filter((m) => m === "session.list")).toHaveLength(1);
    // Still no turn, so still no warm slot (§9.2).
    expect(calls).not.toContain("prompt.submit");
  });

  test("a box with neither source reports no watermark rather than a zero", async () => {
    const h = harness({
      results: {
        "profiles.list": withoutLastSession(LIVE_PROFILES_LIST),
        "session.list": { sessions: [] },
      },
    });
    const swarm = await createHermesChat(h.deps).swarm(BOX);
    expect(swarm.bots[0]?.last_message_at).toBeNull();
  });
});

describe("hermes-chat · groups.list paging", () => {
  test("next_offset null is one call, as the live box answers", async () => {
    const h = harness({
      results: { "profiles.list": LIVE_PROFILES_LIST, "groups.list": LIVE_GROUPS_LIST },
    });
    await createHermesChat(h.deps).swarm(BOX);
    const calls = h.sockets[0]?.sent.filter((c) => c.method === "groups.list") ?? [];
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toEqual({});
  });

  /**
   * `next_offset` is in the payload, so reading page one and calling it the
   * roster would be the silent version of the watermark bug.
   */
  test("a paged answer is followed and concatenated", async () => {
    const h = harness({
      results: { "profiles.list": LIVE_PROFILES_LIST },
      sequence: {
        "groups.list": [
          { rooms: [{ id: "r1", name: "One" }], next_offset: 1 },
          { rooms: [{ id: "r2", name: "Two" }], next_offset: 2 },
          { rooms: [{ id: "r3", name: "Three" }], next_offset: null },
        ],
      },
    });
    const swarm = await createHermesChat(h.deps).swarm(BOX);
    expect(swarm.rooms.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
    const calls = h.sockets[0]?.sent.filter((c) => c.method === "groups.list") ?? [];
    expect(calls.map((c) => c.params)).toEqual([{}, { offset: 1 }, { offset: 2 }]);
  });

  test("an offset that does not advance stops rather than spinning", async () => {
    const h = harness({
      results: {
        "profiles.list": LIVE_PROFILES_LIST,
        // Every page says "there is more, from here" — from the same place.
        "groups.list": { rooms: [{ id: "r1", name: "One" }], next_offset: 1 },
      },
    });
    const swarm = await createHermesChat(h.deps).swarm(BOX);
    expect(swarm.rooms).toHaveLength(2);
    expect(h.sockets[0]?.sent.filter((c) => c.method === "groups.list")).toHaveLength(2);
  });
});

/* ── sessions and history ─────────────────────────────────────────────────── */

describe("hermes-chat · sessions", () => {
  test("the probed box's empty list maps to an empty list", async () => {
    const h = harness({ results: { "session.list": SESSION_LIST_RESULT } });
    expect(await createHermesChat(h.deps).sessions(BOX, "default")).toEqual([]);
  });

  test("lists hidden sessions while retaining explicit profile scope", async () => {
    const h = harness({
      results: { "session.list": { sessions: [{ session_id: "s1", title: "T" }] } },
      errors: {},
    });
    // First call carries the profile; the fake accepts it, so assert the shape.
    await createHermesChat(h.deps).sessions(BOX, "granite");
    expect(h.sockets[0]?.sent[0]?.params).toEqual({ profile: "granite", include_hidden: true });
  });

  test("an unknown origin defaults to cli, never to portal", () => {
    const mapped = mapSessions(BOX, "default", {
      sessions: [
        { session_id: "s1", title: "Ops", message_count: 4 },
        { session_id: "s2", origin: "channel", origin_detail: "#acme-support" },
        { session_id: "s3", source: "cron" },
        { id: "s4", kind: "thread", updated_at: 1758051000 },
        { title: "no id at all" },
      ],
    });
    expect(mapped.map((s) => [s.id, s.origin, s.kind])).toEqual([
      // `portal` is the one origin that suppresses the composer's restatement of
      // where a reply is going; a guess must never land on it.
      ["s1", "cli", "thread"],
      ["s2", "channel", "thread"],
      ["s3", "routine", "thread"],
      ["s4", "cli", "thread"],
    ]);
    expect(mapped[0]?.turn_count).toBe(4);
    expect(mapped[0]?.title).toBe("Ops");
    expect(mapped[3]?.last_message_at).toBe(new Date(1758051000 * 1000).toISOString());
    // Unread is per-operator state in local SQLite (§9.2); the box cannot know it.
    expect(mapped.every((s) => s.unread === 0)).toBe(true);
  });
});

describe("hermes-chat · a notice in a preview", () => {
  test("a session and a bot whose preview opens with a notice read as the event", () => {
    // Upstream's own cut: 60 characters, newlines flattened, `...` appended.
    const cut = "[IMPORTANT: Background process proc_3be1c0a4d2e1 completed n...";
    const [session] = mapSessions(BOX, "default", {
      sessions: [{ session_id: "s1", title: "Bot Chat", preview: cut }],
    });
    expect(session?.preview).toBe("proc_3be1c0a4d2e1 completed");
    const swarm = mapSwarm(
      BOX,
      {
        profiles: [
          { name: "default", is_default: true, canonical_session: { id: "s1", preview: cut } },
        ],
      },
      null,
      null,
      null,
    );
    expect(swarm.bots[0]?.preview).toBe("proc_3be1c0a4d2e1 completed");
    // Anything else passes through untouched.
    const [plain] = mapSessions(BOX, "default", {
      sessions: [{ session_id: "s2", title: "t", preview: "why is it down?" }],
    });
    expect(plain?.preview).toBe("why is it down?");
  });
});

describe("hermes-chat · who wrote a bot's preview", () => {
  const roleOf = (preview: string) =>
    mapSwarm(
      BOX,
      { profiles: [{ name: "default", is_default: true, canonical_session: { id: "s1", preview } }] },
      null,
      null,
      null,
    ).bots[0];

  test("upstream's own preview names no role, so neither does the bot's", () => {
    // `_latest_message_preview` selects the newest user/assistant row's
    // content alone: a bare `No reply` could be either side's.
    expect(roleOf("No reply")).toMatchObject({ preview: "No reply", preview_role: null });
  });

  test("a preview rewritten from a row hermetic recognised carries that row's role", () => {
    expect(roleOf("Message from 🤖 Marshall (@scribe): NO_REPLY")).toMatchObject({
      preview: "Marshall: NO_REPLY",
      preview_role: "user",
    });
    expect(roleOf("[IMPORTANT: Background process proc_3be1c0a4d2e1 completed n...")).toMatchObject({
      preview: "proc_3be1c0a4d2e1 completed",
      preview_role: "system",
    });
  });

  test("a roster row from before the field still parses", () => {
    const [bot] = mapSwarm(BOX, LIVE_PROFILES_LIST, null, null, null).bots;
    const { preview_role: _, ...old } = bot as NonNullable<typeof bot>;
    expect(Bot.safeParse(old).success).toBe(true);
  });
});

describe("hermes-chat · history", () => {
  test("maps roles, parts and usage, and keeps an unrecognised part whole", () => {
    const messages = mapHistory(BOX, SESSION_ID, {
      messages: [
        { id: "m1", role: "user", at: "2026-09-16T19:48:00.000Z", content: "why is it down?" },
        {
          role: "assistant",
          timestamp: "2026-09-16T19:48:10.000Z",
          parts: [
            { type: "thinking", text: "check the unit" },
            { type: "tool_use", name: "bash", args: { cmd: "systemctl status" } },
            { type: "text", text: "It is masked." },
            { type: "citation_group", refs: ["a"] },
          ],
          usage: { input_tokens: 10, output_tokens: 3, model: "m" },
        },
      ],
    });
    expect(messages.map((m) => m.role)).toEqual(["user", "bot"]);
    expect(messages[0]?.blocks).toEqual([{ kind: "text", markdown: "why is it down?" }]);
    expect(messages[1]?.id).toMatch(new RegExp(`^${SESSION_ID}:h[0-9a-f]{16}$`));
    expect(messages[1]?.blocks.map((b) => b.kind)).toEqual(["reasoning", "tool", "text", "unknown"]);
    const tool = messages[1]?.blocks[1];
    expect(tool?.kind === "tool" ? tool.render : null).toBe("terminal");
    const unknown = messages[1]?.blocks[3];
    expect(unknown).toEqual({
      kind: "unknown",
      name: "citation_group",
      payload: { type: "citation_group", refs: ["a"] },
    });
    expect(messages[1]?.usage).toEqual({
      input_tokens: 10,
      output_tokens: 3,
      cost_usd: null,
      model: "m",
    });
  });

  test("live durable tool rows restore the completed card and its arguments", async () => {
    const h = harness({ history: [...DURABLE_TOOL_ROWS] });
    const messages = await createHermesChat(h.deps).history(BOX, "default", { session: SESSION_ID });
    expect(messages[0]?.blocks).toEqual([]);
    expect(messages[1]?.id).toBe(`${SESSION_ID}:56`);
    expect(messages[1]?.blocks).toEqual([
      expect.objectContaining({
        kind: "tool",
        tool_id: "call_FIXTURE",
        name: "terminal",
        render: "terminal",
        args: { command: "printf FIXTURE" },
        result: { output: "FIXTURE\n", exit_code: 0, error: null },
        status: "ok",
        exit_code: 0,
      }),
    ]);
    expect(h.sockets).toHaveLength(0);
  });

  test("same-name parallel tools pair by call ID and retain failed result details", () => {
    const messages = mapHistory(BOX, SESSION_ID, [
      {
        role: "assistant",
        tool_calls: [
          { id: "a", function: { name: "terminal", arguments: '{"command":"first"}' } },
          { id: "b", function: { name: "terminal", arguments: '{"command":"second"}' } },
        ],
      },
      {
        role: "tool",
        tool_call_id: "b",
        tool_name: "terminal",
        content: '{"output":"failed","exit_code":2,"error":"denied","future":{"x":1}}',
      },
      { role: "tool", tool_call_id: "a", tool_name: "terminal", content: "plain result" },
    ]);
    expect(messages[1]?.blocks[0]).toMatchObject({
      kind: "tool",
      tool_id: "b",
      args: { command: "second" },
      status: "bad",
      exit_code: 2,
      result: { output: "failed", error: "denied", future: { x: 1 } },
    });
    expect(messages[2]?.blocks[0]).toMatchObject({
      kind: "tool",
      tool_id: "a",
      args: { command: "first" },
      result: "plain result",
    });
  });

  test("a result outside the loaded call range never borrows another tool's arguments", () => {
    const messages = mapHistory(BOX, SESSION_ID, [DURABLE_TOOL_ROWS[1]]);
    expect(messages[0]?.blocks[0]).toMatchObject({
      kind: "tool",
      tool_id: "call_FIXTURE",
      name: "terminal",
      args: null,
      status: "ok",
    });
  });

  test("unmatched and unfamiliar durable calls remain inspectable", () => {
    const future = { type: "future_tool", payload: { detail: "retained" } };
    const messages = mapHistory(BOX, SESSION_ID, [
      {
        role: "assistant",
        tool_calls: [{ id: "a", function: { name: "new_tool", arguments: "malformed JSON" } }, future],
      },
    ]);
    expect(messages[0]?.blocks).toEqual([
      expect.objectContaining({
        kind: "tool",
        tool_id: "a",
        name: "new_tool",
        args: "malformed JSON",
        result: null,
        status: "warn",
        render: null,
      }),
      { kind: "unknown", name: "tool_call", payload: future },
    ]);
  });

  test("tool arguments survive a durable REST page boundary", async () => {
    const h = harness({
      history: [
        ...Array.from({ length: 499 }, (_, id) => ({ id, role: "user", content: "fixture" })),
        ...DURABLE_TOOL_ROWS,
      ],
    });
    const messages = await createHermesChat(h.deps).history(BOX, "default", { session: SESSION_ID });
    expect(messages.at(-1)?.blocks[0]).toMatchObject({
      kind: "tool",
      args: { command: "printf FIXTURE" },
    });
    expect(messages.at(-2)?.blocks).toEqual([]);
  });

  test("a message with no timestamp reads the same twice, whatever the clock says", () => {
    // The laptop clock used to fill this in, so every poll re-dated the row and
    // minted a new inbox key for it. Two reads of one row must agree.
    const row = { messages: [{ role: "user" }] };
    const [first] = mapHistory(BOX, SESSION_ID, row);
    const [second] = mapHistory(BOX, SESSION_ID, row);
    expect(first?.at).toBe(second?.at ?? "");
    expect(first?.id).toBe(second?.id ?? "");
    expect(first?.at).toBe("1970-01-01T00:00:00.000Z");
    expect(first?.blocks).toEqual([]);
  });

  test("an unstamped row carries the timestamp of the row before it", () => {
    const [, second] = mapHistory(BOX, SESSION_ID, {
      messages: [
        { role: "user", at: "2026-09-16T19:48:00.000Z", content: "why is it down?" },
        { role: "assistant", content: "looking" },
      ],
    });
    expect(second?.at).toBe("2026-09-16T19:48:00.000Z");
  });

  test("a minted id ignores sidecars and key order, but not the words", () => {
    // A row picks up `usage` when the turn settles, and a JSON object has no
    // guaranteed key order. Neither makes it a different message.
    const plain = mapHistory(BOX, SESSION_ID, {
      messages: [{ role: "assistant", content: "it is masked", at: "2026-09-16T19:48:00.000Z" }],
    });
    const decorated = mapHistory(BOX, SESSION_ID, {
      messages: [
        {
          at: "2026-09-16T19:48:00.000Z",
          content: "it is masked",
          reasoning: "checked the unit",
          usage: { input_tokens: 10, output_tokens: 3 },
          incomplete: null,
          role: "assistant",
        },
      ],
    });
    expect(decorated[0]?.id).toBe(plain[0]?.id ?? "");

    const different = mapHistory(BOX, SESSION_ID, {
      messages: [{ role: "assistant", content: "it is running", at: "2026-09-16T19:48:00.000Z" }],
    });
    expect(different[0]?.id).not.toBe(plain[0]?.id);
  });

  test("a durable row_id is used before anything is minted", () => {
    const [message] = mapHistory(BOX, SESSION_ID, {
      messages: [{ role: "user", row_id: "rw-4211", content: "why is it down?" }],
    });
    expect(message?.id).toBe(`${SESSION_ID}:rw-4211`);
  });

  test("a background-process notice is a system event, not the operator, and keeps its id", () => {
    const notice =
      "[IMPORTANT: Background process proc_77aa19b3c5f0 exited (exit code 1).\nCommand: bun test packages/ui\nOutput:\n611 pass\n1 fail]";
    const stamped = "2026-09-29T00:24:30.000Z";
    const [minted, durable, spoken] = mapHistory(BOX, SESSION_ID, {
      messages: [
        { role: "user", content: notice, at: stamped },
        { role: "user", id: 4211, content: notice, at: stamped },
        // Quoting a notice is still the operator talking.
        { role: "user", content: `what does this mean? ${notice}`, at: stamped },
      ],
    });
    expect(minted?.role).toBe("system");
    expect(minted?.author).toBeNull();
    expect(minted?.blocks).toHaveLength(1);
    expect(minted?.blocks[0]).toMatchObject({
      kind: "process_event",
      event: "completion",
      outcome: "failed",
      process_id: "proc_77aa19b3c5f0",
      exit_code: 1,
      output_tail: "611 pass\n1 fail",
      raw: notice,
    });
    // The id is the one this row had before notices were recognised: the same
    // hash of session, role, author, words and stamp that `rowId` has always
    // taken — role still `user`, as the box stored it — so an observation's
    // cursor does not see an old notice as a new message.
    const digest = createHash("sha256")
      .update([SESSION_ID, "user", "", notice, stamped].join("\u0000"))
      .digest("hex");
    expect(minted?.id).toBe(`${SESSION_ID}:h${digest.slice(0, 16)}`);
    expect(durable?.id).toBe(`${SESSION_ID}:4211`);
    expect(durable?.role).toBe("system");
    expect(spoken?.role).toBe("user");
    expect(spoken?.blocks[0]?.kind).toBe("text");
  });

  test("an id the box did not give survives the window sliding under it", () => {
    // `order=latest` slides: the same message is the 7th row on one read and the
    // 6th on the next, and an index-derived id would call that a new message.
    const rows = [
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
    ];
    const wide = mapHistory(BOX, SESSION_ID, { messages: rows });
    const narrow = mapHistory(BOX, SESSION_ID, { messages: [rows[1]] });
    expect(narrow[0]?.id).toBe(wide[1]?.id ?? "");
    expect(wide[0]?.id).not.toBe(wide[1]?.id);
  });

  test("a bot with no sessions has no transcript, and that is not an error", async () => {
    const h = harness({ results: { "session.list": SESSION_LIST_RESULT } });
    expect(await createHermesChat(h.deps).history(BOX, "default")).toEqual([]);
  });

  /**
   * The RPC that must never be called. `session.history` wants a *live runtime*
   * id, resumes the session to answer and takes one of the box's three warm
   * slots — and it rejects `limit`, which is how a paged read of it failed
   * against the real box (`invalid params for session.history: limit`). The
   * transcript is REST, so no socket may ever carry that method, including on
   * the canonical path where one is opened for `session.list`.
   */
  test("no transport ever calls session.history over the socket", async () => {
    const h = harness({
      results: { "session.list": { sessions: [{ id: SESSION_ID, title: "Bot Chat" }] } },
      history: [{ id: 1, role: "user", content: "question" }],
    });
    const adapter = createHermesChat(h.deps);
    await adapter.history(BOX, "default");
    await adapter.history(BOX, "default", { session: SESSION_ID, limit: 2 });
    const methods = h.sockets.flatMap((socket) => socket.sent.map((frame) => frame.method));
    expect(methods.length).toBeGreaterThan(0);
    expect(methods).not.toContain("session.history");
  });

  test("durable history uses authenticated REST without opening or warming a runtime", async () => {
    const h = harness({
      history: [
        { id: 11, role: "user", content: "old question" },
        { id: 12, role: "assistant", content: "old answer" },
        { id: 13, role: "user", content: "physical wrapper", display_content: "new question" },
        { id: 14, role: "assistant", content: "new answer" },
      ],
      allowedParams: { "session.history": SESSION_HISTORY_PARAM_KEYS },
      errors: { "session.history": { code: 4001, message: "session not found" } },
    });
    const adapter = createHermesChat(h.deps);
    const full = await adapter.history(BOX, "research", { session: SESSION_ID });
    const tail = await adapter.history(BOX, "research", { session: SESSION_ID, limit: 2 });
    expect(full).toHaveLength(4);
    expect(tail).toEqual(full.slice(-2));
    expect(tail.map((message) => message.id)).toEqual([`${SESSION_ID}:13`, `${SESSION_ID}:14`]);
    expect(tail[0]?.blocks).toEqual([{ kind: "text", markdown: "new question" }]);
    expect(h.sockets).toHaveLength(0);
    const read = h.fetches.at(-1)!;
    const url = new URL(read.url);
    expect(url.pathname).toBe(`/api/sessions/${SESSION_ID}/messages`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      profile: "research",
      limit: "2",
      offset: "0",
      order: "latest",
    });
    expect(read.headers["X-Hermes-Session-Token"]).toBe(FIXTURE_SESSION_TOKEN);
    expect(read.headers.Origin).toBe("http://127.0.0.1:9119");
    expect(read.url).not.toContain(FIXTURE_SESSION_TOKEN);
  });

  test("unbounded durable history follows pages and keeps numeric row IDs stable", async () => {
    const h = harness({
      history: Array.from({ length: 1001 }, (_, id) => ({
        id: id + 1,
        role: "user",
        content: `row ${id}`,
      })),
    });
    const result = await createHermesChat(h.deps).history(BOX, "research", { session: SESSION_ID });
    expect(result).toHaveLength(1001);
    expect(result.at(-1)?.id).toBe(`${SESSION_ID}:1001`);
    expect(
      h.fetches
        .filter((read) => read.url.includes("/messages"))
        .map((read) => new URL(read.url).searchParams.get("offset")),
    ).toEqual(["0", "500", "1000"]);
  });

  test("canonical history resolves its durable session without a live resume", async () => {
    const h = harness({
      history: [
        { id: "old", role: "user" },
        { id: "new", role: "assistant" },
      ],
      results: { "session.list": { sessions: [{ id: SESSION_ID, title: "Bot Chat" }] } },
    });
    const tail = await createHermesChat(h.deps).history(BOX, "research", { limit: 1 });
    expect(tail.map((message) => message.id)).toEqual(["new"]);
    expect(h.sockets[0]?.sent.map(({ method, params }) => ({ method, params }))).toEqual([
      {
        method: "session.list",
        params: { profile: "research", title: "Bot Chat", include_hidden: true, limit: 100 },
      },
    ]);
  });

  test("hidden REST display rows stay hidden", async () => {
    const h = harness({
      history: [
        { id: 1, role: "user", content: "internal wrapper", display_kind: "hidden" },
        { id: 2, role: "assistant", content: "visible" },
      ],
    });
    const result = await createHermesChat(h.deps).history(BOX, "default", { session: SESSION_ID });
    expect(result.map((message) => message.id)).toEqual([`${SESSION_ID}:2`]);
  });

  test("a stale cached REST token refreshes once, without leaking it through errors", async () => {
    let requests = 0;
    const h = harness({
      historyReply: () =>
        ++requests === 2 ? { status: 401, json: { error: "expired" } } : { json: { messages: [] } },
    });
    const adapter = createHermesChat(h.deps);
    await adapter.history(BOX, "default", { session: SESSION_ID });
    await adapter.history(BOX, "default", { session: SESSION_ID });
    expect(requests).toBe(3);
    expect(h.fetches.filter((read) => read.url === BOX.baseUrl)).toHaveLength(2);
    const failed = harness({
      historyReply: () => ({ status: 403, json: { detail: FIXTURE_SESSION_TOKEN } }),
    });
    await expect(
      createHermesChat(failed.deps).history(BOX, "default", { session: SESSION_ID }),
    ).rejects.toMatchObject({
      code: "CHAT_PROTOCOL",
      message: `${BOX.instance}: history answered HTTP 403`,
    });
  });
});

/** These cases use distinct durable and runtime IDs, which the original happy-path fixture did not. */
describe("hermes-chat · durable addressing", () => {
  test("send resumes the named profile and abort uses its exact runtime over a separate socket", async () => {
    const h = harness({
      results: {
        "session.resume": {
          session_id: "runtime-research",
          session_key: "durable-research",
          running: false,
          info: {},
        },
        "prompt.submit": PROMPT_SUBMIT_RESULT,
        "session.interrupt": { status: "interrupted" },
      },
    });
    const adapter = createHermesChat(h.deps);
    const turn = adapter
      .send(BOX, "research", "continue here", { session: "durable-research" })
      [Symbol.asyncIterator]();
    await turn.next();
    await turn.next();
    expect(h.sockets[0]?.sent.map(({ method, params }) => ({ method, params }))).toEqual([
      // The turn socket answers prompts, so it says so before anything else.
      { method: "client.capabilities", params: { server_requests: true } },
      {
        method: "session.resume",
        params: {
          session_id: "durable-research",
          profile: "research",
          source: "hermetic",
          defer_history: true,
          omit_messages: true,
        },
      },
      // The continuation baseline, taken before the prompt: the cursor a
      // dropped socket would resume from is the session's sequence *now*.
      {
        method: "session.events.since",
        params: { session_id: "runtime-research", last_seen: Number.MAX_SAFE_INTEGER },
      },
      {
        method: "prompt.submit",
        params: { session_id: "runtime-research", profile: "research", text: "continue here" },
      },
    ]);
    expect(await adapter.abort(BOX, "research", { session: "durable-research" })).toBe(true);
    expect(h.sockets[1]?.sent.map(({ method, params }) => ({ method, params }))).toEqual([
      { method: "session.interrupt", params: { session_id: "runtime-research", profile: "research" } },
    ]);
    await turn.return?.();
    expect(await adapter.abort(BOX, "research", { session: "durable-research" })).toBe(false);
    expect(h.sockets[2]?.sent.map((call) => call.method)).toEqual(["session.resume"]);
  });

  test("a new nondefault bot turn creates inside its profile and supports abort before the browser knows its stored ID", async () => {
    const h = harness(turnScript([]));
    const adapter = createHermesChat(h.deps);
    const turn = adapter.send(BOX, "research", "hello")[Symbol.asyncIterator]();
    await turn.next();
    await turn.next();
    expect(h.sockets[0]?.sent[1]?.params).toEqual({ profile: "research", source: "hermetic" });
    expect(await adapter.abort(BOX, "research")).toBe(true);
    expect(h.sockets[1]?.sent[0]?.params).toEqual({ session_id: SESSION_ID, profile: "research" });
    await turn.return?.();
  });

  test("two unaddressed active turns are ambiguous instead of stopping whichever was newest", async () => {
    const h = harness(turnScript([]));
    const adapter = createHermesChat(h.deps);
    const first = adapter.send(BOX, "research", "one")[Symbol.asyncIterator]();
    const second = adapter.send(BOX, "research", "two")[Symbol.asyncIterator]();
    await first.next();
    await first.next();
    await second.next();
    await second.next();
    await expect(adapter.abort(BOX, "research")).rejects.toMatchObject({ code: "VALIDATION" });
    expect(h.sockets).toHaveLength(2);
    await first.return?.();
    await second.return?.();
  });

  test("message.complete status:error preserves partial text and ends with an error, never success", async () => {
    const h = harness(
      turnScript([
        eventFrame("message.delta", 1, { text: "partial reply" }),
        eventFrame("message.complete", 2, {
          status: "error",
          text: "partial reply plus context",
          error: "provider refused this turn",
        }),
      ]),
    );
    const frames = await collect(createHermesChat(h.deps).send(BOX, "default", "go"));
    expect(frames.flatMap((frame) => (frame.type === "delta" ? [frame.text] : [])).join("")).toBe(
      "partial reply plus context",
    );
    expect(frames.at(-1)).toEqual({
      type: "error",
      code: "CHAT_TURN_FAILED",
      message: "provider refused this turn",
    });
    expect(frames.some((frame) => frame.type === "done")).toBe(false);
  });
});

describe("semantic live activity and requests", () => {
  test("real requests stay distinct from RPC responses and retain read-only prompts", async () => {
    const h = harness(
      turnScript([
        eventFrame("tool.generating", 3, { name: "clarify" }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: "srv-1",
          method: "clarify",
          params: {
            session_id: SESSION_ID,
            question: "Which region?",
            choices: ["west", "east"],
          },
        }),
        JSON.stringify({
          jsonrpc: "2.0",
          id: "srv-2",
          method: "approval",
          params: {
            session_id: SESSION_ID,
            tool_name: "terminal",
            command: "deploy",
            choices: ["once", "deny"],
          },
        }),
        eventFrame("request.cancel", 4, { id: "srv-1", method: "clarify", reason: "resolved" }),
        RECORDED_MESSAGE_COMPLETE,
      ]),
    );
    const frames = await collect(createHermesChat(h.deps).send(BOX, "default", "go"));
    expect(blocks(frames)).toContainEqual(
      expect.objectContaining({
        kind: "question",
        request_id: "srv-1",
        prompt: "Which region?",
        choices: ["west", "east"],
      }),
    );
    expect(blocks(frames)).toContainEqual(
      expect.objectContaining({ kind: "approval", request_id: "srv-2", summary: "deploy" }),
    );
    expect(blocks(frames)).toContainEqual(
      expect.objectContaining({ kind: "activity", request_id: "srv-1", state: "done" }),
    );
    expect(frames.at(-1)?.type).toBe("done");
    expect(
      frames.find((frame) => frame.type === "block" && frame.block.kind === "question"),
    ).toMatchObject({ seq: 3 });
    expect(h.sockets[0]?.sent.map((call) => call.method)).toEqual([
      "client.capabilities",
      "session.create",
      "session.events.since",
      "prompt.submit",
    ]);
  });

  test("global events are never invented child messages; actual child events cannot end this turn", async () => {
    const h = harness(
      turnScript([
        eventFrame("notice", 1000, { message: "Capabilities refreshed" }, ""),
        eventFrame("skin.changed", 1001, { name: "future skin" }, ""),
        eventFrame("session.reclaimed", 0, { session_id: "other-runtime", reason: "idle_timeout" }, ""),
        eventFrame(
          "message.complete",
          9999,
          { text: "child only", status: "complete" },
          "other-runtime",
        ),
        RECORDED_MESSAGE_COMPLETE,
      ]),
    );
    const frames = await collect(createHermesChat(h.deps).send(BOX, "default", "go"));
    expect(blocks(frames)).toContainEqual(
      expect.objectContaining({ kind: "activity", title: "Capabilities refreshed" }),
    );
    expect(blocks(frames)).toContainEqual(
      expect.objectContaining({ kind: "unknown", name: "skin.changed" }),
    );
    expect(
      blocks(frames).some((block) => block.kind === "activity" && block.key === "session:reclaimed"),
    ).toBe(false);
    expect(
      blocks(frames).filter((block) => block.kind === "unknown" && block.name === "subagent"),
    ).toHaveLength(1);
    expect(frames.filter((frame) => frame.type === "done")).toHaveLength(1);
    expect(frames.flatMap((frame) => (frame.type === "delta" ? [frame.text] : []))).toEqual(["pong"]);
  });

  test("interim prose is sealed once and usage ticks do not split the final sentence", async () => {
    const h = harness(
      turnScript([
        eventFrame("message.interim", 1, { text: "Checking now.", already_streamed: false }),
        eventFrame("message.delta", 2, { text: "po" }),
        eventFrame("session.usage", 3, { usage: { input: 4, output: 1 } }),
        eventFrame("message.delta", 4, { text: "ng" }),
        eventFrame("message.interim", 5, { text: "pong", already_streamed: true }),
        RECORDED_MESSAGE_COMPLETE,
      ]),
    );
    const frames = await collect(createHermesChat(h.deps).send(BOX, "default", "go"));
    expect(blocks(frames).filter((block) => block.kind === "text")).toEqual([
      { kind: "text", markdown: "Checking now." },
      { kind: "text", markdown: "" },
    ]);
    expect(frames.flatMap((frame) => (frame.type === "delta" ? [frame.text] : []))).toEqual([
      "po",
      "ng",
    ]);
    const done = frames.at(-1);
    expect(done?.type === "done" && done.usage?.input_tokens).toBeGreaterThan(4);
  });
});
