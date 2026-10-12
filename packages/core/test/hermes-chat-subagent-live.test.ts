/**
 * Delegated children on the live adapter: the turn mapper, the observation
 * stream, the roster reconcile when that stream reopens, and child control
 * (`subagent.steer` / `subagent.interrupt` over a resumed socket, D25).
 *
 * One scripted dial per socket, in dial order, so every assertion can say
 * which socket carried what — control and reconcile each open a socket of
 * their own, and the observation's must stay passive.
 */
import { describe, expect, test } from "bun:test";
import { createHermesChat } from "../src/chat/hermes/hermes-chat.ts";
import type {
  BoxAddress,
  ChatFetch,
  ChatSocket,
  HermesChatClient,
  ObserveOptions,
} from "../src/chat/hermes/hermes-chat.ts";
import type { ChatObserveHint } from "../src/chat/chat-observe.ts";
import {
  SUBAGENT_TERMINAL_MAX,
  createSubagentLedger,
} from "../src/chat/hermes/hermes-chat-subagent.ts";
import {
  SUBAGENT_SESSIONS_MAX,
  createSubagentLedgers,
  subagentTurn,
} from "../src/chat/hermes/hermes-chat-subagent-ledgers.ts";
import { ChatBlock } from "../src/schema/index.ts";
import type { ChatFrame, SubagentBlock } from "../src/schema/index.ts";
import {
  DASHBOARD_HTML,
  eventFrame,
  PROMPT_SUBMIT_RESULT,
  SESSION_CREATE_RESULT,
  SESSION_ID,
  STORED_SESSION_ID,
} from "./fixtures/hermes-frames.ts";

const BOX: BoxAddress = {
  instance: "veronica",
  baseUrl: "https://fxtr0001-veronica.tail0000.ts.net/",
  fleet_id: "fxtr0001",
};
const BOT = "default";

/* ── the double ───────────────────────────────────────────────────────────── */

interface Dial {
  results?: Record<string, unknown>;
  errors?: Record<string, { code: number; message: string }>;
  /** Frames pushed straight after a method's reply. */
  after?: Record<string, readonly string[]>;
  /** Frames already waiting when the socket opens. */
  initial?: readonly string[];
}

interface FakeSocket extends ChatSocket {
  sent: { method: string; params: Record<string, unknown> }[];
  methods(): string[];
  push(frame: string): void;
}

function queue<T>() {
  const buffer: T[] = [];
  let done = false;
  let wake: (() => void) | null = null;
  const nudge = (): void => {
    const w = wake;
    wake = null;
    w?.();
  };
  return {
    push(v: T) {
      buffer.push(v);
      nudge();
    },
    close() {
      done = true;
      nudge();
    },
    async *drain(): AsyncIterable<T> {
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

function harness(dials: Dial[]): { client: HermesChatClient; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  const fetchImpl: ChatFetch = () =>
    Promise.resolve(
      new Response(DASHBOARD_HTML, { status: 200, headers: { "content-type": "text/html" } }),
    );
  const openSocket = (): ChatSocket => {
    const script = dials[sockets.length] ?? {};
    const q = queue<string>();
    const sent: FakeSocket["sent"] = [];
    const socket: FakeSocket = {
      sent,
      methods: () => sent.map((s) => s.method),
      push: (frame) => q.push(frame),
      opened: Promise.resolve(),
      frames: q.drain(),
      send(data: string) {
        const doc = JSON.parse(data) as { id: number; method: string; params: Record<string, unknown> };
        sent.push({ method: doc.method, params: doc.params });
        const failure = script.errors?.[doc.method];
        q.push(
          JSON.stringify(
            failure
              ? { jsonrpc: "2.0", id: doc.id, error: failure }
              : { jsonrpc: "2.0", id: doc.id, result: script.results?.[doc.method] ?? {} },
          ),
        );
        for (const frame of script.after?.[doc.method] ?? []) q.push(frame);
      },
      close: () => q.close(),
    };
    for (const frame of script.initial ?? []) q.push(frame);
    sockets.push(socket);
    return socket;
  };
  const client = createHermesChat({
    fetch: fetchImpl,
    openSocket,
    now: () => "2026-10-12T10:00:00.000Z",
    slotWaitMs: 500,
    pooled: false,
  });
  return { client, sockets };
}

/** Upstream always sends goal, task_count and task_index (`_progress_subagent`). */
const child = (extra: Record<string, unknown> = {}) => ({
  subagent_id: "sa-1",
  goal: "Audit volumes",
  task_index: 0,
  task_count: 1,
  delegation_id: "deleg-1",
  depth: 0,
  ...extra,
});

/** A turn that delegated one task and is still waiting on it as it ends. */
const DELEGATING_TURN = [
  eventFrame("tool.start", 1, {
    tool_id: "call-1",
    name: "delegate_task",
    args: { goal: "Audit volumes" },
  }),
  eventFrame("subagent.spawn_requested", 2, child()),
  eventFrame("subagent.start", 3, child({ model: "claude-haiku-5" })),
  eventFrame("tool.complete", 4, {
    tool_id: "call-1",
    name: "delegate_task",
    result: '{"status":"dispatched","delegation_id":"deleg-1","goals":["Audit volumes"]}',
  }),
  eventFrame("message.complete", 5, { text: "Dispatched.", status: "complete" }),
];

const turnDial = (frames: readonly string[]): Dial => ({
  results: { "session.create": SESSION_CREATE_RESULT, "prompt.submit": PROMPT_SUBMIT_RESULT },
  after: { "prompt.submit": frames },
});

async function frames(client: HermesChatClient, text = "audit"): Promise<ChatFrame[]> {
  const out: ChatFrame[] = [];
  for await (const frame of client.send(BOX, BOT, text)) out.push(frame);
  return out;
}

const subagents = (out: ChatFrame[]): SubagentBlock[] =>
  out.flatMap((f) => (f.type === "block" && f.block.kind === "subagent" ? [f.block] : []));

/**
 * The canonical watch on the turn's conversation: unpinned, answering for the
 * durable session its last read resolved to — what `chat-observe.ts` passes.
 */
const CANONICAL: ObserveOptions = { sessions: () => [STORED_SESSION_ID] };

/** Pull hints until `count` have arrived, then hang up. */
async function hints(
  client: HermesChatClient,
  count: number,
  during: (pushed: number) => void = () => undefined,
  watch: ObserveOptions = CANONICAL,
): Promise<ChatObserveHint[]> {
  const controller = new AbortController();
  const out: ChatObserveHint[] = [];
  const stream = client.observe?.(BOX, BOT, { ...watch, signal: controller.signal });
  if (!stream) throw new Error("no observe");
  const it = stream[Symbol.asyncIterator]();
  while (out.length < count) {
    const next = await it.next();
    if (next.done) break;
    out.push(next.value);
    during(out.length);
  }
  controller.abort();
  await it.return?.();
  return out;
}

/* ── the turn ─────────────────────────────────────────────────────────────── */

describe("subagents in a turn", () => {
  test("every subagent event on the parent session is the child's whole block, tied to its call", async () => {
    const { client } = harness([
      turnDial([
        eventFrame("tool.start", 1, {
          tool_id: "call-1",
          name: "delegate_task",
          args: { tasks: [{ goal: "Audit volumes" }, { goal: "Read logs" }] },
        }),
        eventFrame("subagent.spawn_requested", 2, child({ task_count: 2 })),
        eventFrame("subagent.start", 3, child({ task_count: 2 })),
        eventFrame(
          "subagent.tool",
          4,
          child({ task_count: 2, tool_name: "terminal", tool_preview: "ls /srv" }),
        ),
        eventFrame(
          "subagent.tool",
          5,
          child({ task_count: 2, tool_name: "read_file", tool_preview: "/srv/a" }),
        ),
        // A child's own session mirrors the vocabulary: still an unknown block.
        eventFrame("message.delta", 6, { text: "child text" }, "child-1"),
        eventFrame("message.complete", 7, { text: "ok", status: "complete" }),
      ]),
    ]);
    const out = await frames(client);
    const blocks = subagents(out);
    expect(blocks).toHaveLength(4);
    // One row: every block carries the same key and the call it came from.
    expect(new Set(blocks.map((b) => b.subagent_id))).toEqual(new Set(["sa-1"]));
    expect(blocks.every((b) => b.tool_id === "call-1")).toBe(true);
    // Whole-block emit: the second tool does not lose the first.
    expect(blocks.at(-1)?.tools).toEqual([
      { name: "terminal", preview: "ls /srv" },
      { name: "read_file", preview: "/srv/a" },
    ]);
    for (const block of blocks) expect(ChatBlock.parse(block)).toBeTruthy();
    const unknown = out.find((f) => f.type === "block" && f.block.kind === "unknown");
    expect(unknown?.type === "block" && unknown.block.kind === "unknown" && unknown.block.name).toBe(
      "subagent",
    );
    // No activity row stands in for the child any more.
    expect(
      out.some(
        (f) => f.type === "block" && f.block.kind === "activity" && f.block.key.startsWith("subagent:"),
      ),
    ).toBe(false);
    expect(out.at(-1)).toMatchObject({ type: "done" });
  });

  test("a child whose goal matches no call has no tool_id", async () => {
    const { client } = harness([
      turnDial([
        eventFrame("tool.start", 1, {
          tool_id: "call-1",
          name: "delegate_task",
          args: { goal: "Something else" },
        }),
        eventFrame("subagent.start", 2, child()),
        eventFrame("message.complete", 3, { text: "ok", status: "complete" }),
      ]),
    ]);
    const [block] = subagents(await frames(client));
    expect(block?.subagent_id).toBe("sa-1");
    expect(block?.tool_id).toBeUndefined();
  });
});

/* ── the observation ──────────────────────────────────────────────────────── */

describe("subagents on the observation stream", () => {
  test("parent done → child progress → child completion → results turn", async () => {
    const { client, sockets } = harness([
      turnDial(DELEGATING_TURN),
      {}, // the observation's own socket
      {
        // the reconcile's: the child is still on the roster
        results: {
          "session.resume": { session_id: SESSION_ID },
          "subagent.list": { subagents: [{ subagent_id: "sa-1", status: "running", tool_count: 0 }] },
        },
      },
    ]);
    const turn = await frames(client);
    expect(subagents(turn).at(-1)).toMatchObject({ status: "running", tool_id: "call-1" });

    const got = await hints(client, 4, (n) => {
      if (n !== 1) return;
      const observing = sockets[1];
      observing?.push(eventFrame("subagent.progress", 6, child({ text: "two volumes left" })));
      observing?.push(
        eventFrame(
          "subagent.complete",
          7,
          child({ status: "completed", summary: "All fine", duration_seconds: 3 }),
        ),
      );
      observing?.push(eventFrame("message.start", 8, {}));
    });
    expect(got[0]?.subagent).toMatchObject({ origin: "replay", status: "running" });
    expect(got[1]?.subagent).toMatchObject({ progress: "two volumes left", tool_id: "call-1" });
    expect(got[2]?.subagent).toMatchObject({
      status: "completed",
      verdict: "done",
      summary: "All fine",
    });
    // The results turn is a plain hint: the durable read carries it.
    expect(got[3]).toEqual({ session: SESSION_ID });
    // The observation socket stayed passive; the reconcile's did the asking.
    expect(sockets[1]?.methods()).toEqual([]);
    expect(sockets[2]?.methods()).toEqual(["session.resume", "session.events.since", "subagent.list"]);
    expect(sockets[2]?.sent[0]?.params).toMatchObject({
      session_id: STORED_SESSION_ID,
      profile: BOT,
      defer_history: true,
      omit_messages: true,
    });
  });

  test("a child event for a session no turn here registered stays a bare hint", async () => {
    const { client } = harness([
      { initial: [eventFrame("subagent.start", 1, child(), "someone-elses")] },
    ]);
    const got = await hints(client, 1);
    expect(got).toEqual([{ session: "someone-elses" }]);
  });
});

/* ── the reconcile ────────────────────────────────────────────────────────── */

describe("roster reconcile when the stream reopens", () => {
  test("a child that finished during the disconnect is unobserved, never inferred done", async () => {
    const { client } = harness([
      turnDial(DELEGATING_TURN),
      {},
      { results: { "session.resume": { session_id: SESSION_ID }, "subagent.list": { subagents: [] } } },
    ]);
    await frames(client);
    const [hint] = await hints(client, 1);
    expect(hint?.subagent).toMatchObject({
      subagent_id: "sa-1",
      status: "unobserved",
      verdict: "unknown",
    });
  });

  test("a session the gateway no longer has lists nobody", async () => {
    const { client } = harness([
      turnDial(DELEGATING_TURN),
      {},
      { errors: { "session.resume": { code: 4007, message: "session not found" } } },
    ]);
    await frames(client);
    const [hint] = await hints(client, 1);
    expect(hint?.subagent).toMatchObject({ status: "unobserved", verdict: "unknown" });
  });

  test("an event newer than the snapshot wins, and a snapshot cannot undo a completion", async () => {
    const { client } = harness([
      turnDial(DELEGATING_TURN),
      // The completion is already on the observation socket when the stale
      // roster comes back: it is applied after the snapshot, and wins.
      { initial: [eventFrame("subagent.complete", 9, child({ status: "completed" }))] },
      {
        results: {
          "session.resume": { session_id: SESSION_ID },
          "subagent.list": { subagents: [{ subagent_id: "sa-1", status: "running", tool_count: 5 }] },
        },
      },
    ]);
    await frames(client);
    const got = await hints(client, 2);
    expect(got[0]?.subagent).toMatchObject({ origin: "replay", status: "running", tool_count: 5 });
    expect(got[1]?.subagent).toMatchObject({ status: "completed", verdict: "done" });

    const ledger = createSubagentLedger();
    ledger.apply("subagent.start", child());
    ledger.apply("subagent.complete", child({ status: "failed" }));
    expect(ledger.replay([{ subagent_id: "sa-1", status: "running" }])).toEqual([]);
    expect(ledger.get("sa-1")).toMatchObject({ status: "failed", origin: "live" });
  });
});

/* ── child control ────────────────────────────────────────────────────────── */

describe("child control over a resumed socket (D25)", () => {
  const resumed = (sid: string, extra: Record<string, unknown> = {}): Dial => ({
    results: { "session.resume": { session_id: sid }, ...extra },
  });

  test("steer and stop resume the stored session, check the runtime, then ask on the same socket", async () => {
    const { client, sockets } = harness([
      turnDial(DELEGATING_TURN),
      resumed(SESSION_ID, {
        "subagent.steer": { status: "queued", subagent_id: "sa-1", text: "focus" },
      }),
      resumed(SESSION_ID, { "subagent.interrupt": { found: true, subagent_id: "sa-1" } }),
    ]);
    await frames(client);
    expect(await client.subagentSteer?.(BOX, BOT, "sa-1", "focus on gp3")).toBe("queued");
    expect(sockets[1]?.methods()).toEqual(["session.resume", "subagent.steer"]);
    expect(sockets[1]?.sent[0]?.params).toEqual({
      session_id: STORED_SESSION_ID,
      profile: BOT,
      source: "hermetic",
      defer_history: true,
      omit_messages: true,
    });
    expect(sockets[1]?.sent[1]?.params).toEqual({
      session_id: SESSION_ID,
      subagent_id: "sa-1",
      text: "focus on gp3",
    });
    // No prompt, no redirect: the transcript gains nothing.
    expect(await client.subagentInterrupt?.(BOX, BOT, "sa-1")).toBe(true);
    expect(sockets[2]?.methods()).toEqual(["session.resume", "subagent.interrupt"]);
    expect(sockets[2]?.sent[1]?.params).toEqual({ session_id: SESSION_ID, subagent_id: "sa-1" });
  });

  test("a rebuilt session (different runtime id) is rejected with no control RPC", async () => {
    const { client, sockets } = harness([
      turnDial(DELEGATING_TURN),
      resumed("rebuilt"),
      resumed("rebuilt"),
    ]);
    await frames(client);
    expect(await client.subagentSteer?.(BOX, BOT, "sa-1", "focus")).toBe("rejected");
    expect(sockets[1]?.methods()).toEqual(["session.resume"]);
    expect(await client.subagentInterrupt?.(BOX, BOT, "sa-1")).toBe(false);
    expect(sockets[2]?.methods()).toEqual(["session.resume"]);
  });

  test("a process that never saw the child (a CLI) resumes the named session and lets the gateway decide", async () => {
    const { client, sockets } = harness([
      resumed("rt-other", { "subagent.steer": { status: "queued" } }),
      resumed("rt-other", { "subagent.interrupt": { found: true } }),
    ]);
    const opts = { session: "stored-other" };
    expect(await client.subagentSteer?.(BOX, BOT, "sa-9", "focus", opts)).toBe("queued");
    expect(sockets[0]?.methods()).toEqual(["session.resume", "subagent.steer"]);
    expect(sockets[0]?.sent[0]?.params).toMatchObject({ session_id: "stored-other", profile: BOT });
    // No local runtime to compare: the gateway's membership check is the guard.
    expect(sockets[0]?.sent[1]?.params).toEqual({
      session_id: "rt-other",
      subagent_id: "sa-9",
      text: "focus",
    });
    expect(await client.subagentInterrupt?.(BOX, BOT, "sa-9", opts)).toBe(true);
    expect(sockets[1]?.sent[1]?.params).toEqual({ session_id: "rt-other", subagent_id: "sa-9" });
  });

  test("with no session named, the bot's Bot Chat is the one resumed; none at all is rejected unasked", async () => {
    const { client, sockets } = harness([{ results: { "session.list": { sessions: [] } } }]);
    expect(await client.subagentSteer?.(BOX, BOT, "sa-9", "focus")).toBe("rejected");
    // One socket, for the lookup; no resume, no control RPC.
    expect(sockets.map((socket) => socket.methods())).toEqual([["session.list"]]);
  });

  test("found:false, a rejected steer and 4001 are outcomes, not errors", async () => {
    const gone = { code: 4001, message: "session not found or not owned by this transport" };
    const { client } = harness([
      turnDial(DELEGATING_TURN),
      resumed(SESSION_ID, { "subagent.interrupt": { found: false } }),
      resumed(SESSION_ID, { "subagent.steer": { status: "rejected" } }),
      { ...resumed(SESSION_ID), errors: { "subagent.steer": gone } },
      { ...resumed(SESSION_ID), errors: { "subagent.interrupt": gone } },
      { errors: { "session.resume": gone } },
    ]);
    await frames(client);
    expect(await client.subagentInterrupt?.(BOX, BOT, "sa-1")).toBe(false);
    expect(await client.subagentSteer?.(BOX, BOT, "sa-1", "x")).toBe("rejected");
    expect(await client.subagentSteer?.(BOX, BOT, "sa-1", "x")).toBe("rejected");
    expect(await client.subagentInterrupt?.(BOX, BOT, "sa-1")).toBe(false);
    expect(await client.subagentSteer?.(BOX, BOT, "sa-1", "x")).toBe("rejected");
  });
});

/* ── review round 1 regressions ───────────────────────────────────────────── */

describe("subagent observation: attribution and ordering", () => {
  /** A second conversation's turn, resumed from its durable id, delegating too. */
  const OTHER = "stored-b";
  const OTHER_RUNTIME = "rt-b";
  const otherTurn = (): Dial => ({
    results: { "session.resume": { session_id: OTHER_RUNTIME }, "prompt.submit": PROMPT_SUBMIT_RESULT },
    after: {
      "prompt.submit": [
        eventFrame(
          "subagent.start",
          1,
          child({ subagent_id: "sa-b", goal: "B's task" }),
          OTHER_RUNTIME,
        ),
        eventFrame("message.complete", 2, { text: "ok", status: "complete" }, OTHER_RUNTIME),
      ],
    },
  });

  test("watching B never receives A's child, from the reconcile or the stream", async () => {
    const { client, sockets } = harness([
      turnDial(DELEGATING_TURN), // A: sa-1 running
      otherTurn(), // B: sa-b running
      // The observation's socket: A's child reports on it.
      { initial: [eventFrame("subagent.progress", 9, child({ text: "A's progress" }))] },
      // One reconcile, B's only: its roster no longer lists sa-b.
      {
        results: {
          "session.resume": { session_id: OTHER_RUNTIME },
          "subagent.list": { subagents: [] },
        },
      },
    ]);
    await frames(client);
    for await (const _ of client.send(BOX, BOT, "go", { session: OTHER })) void _;
    // B's canonical watch: unpinned, answering for B's durable session.
    const got = await hints(client, 2, () => undefined, { sessions: () => [OTHER] });
    expect(got[0]).toMatchObject({
      session: OTHER,
      subagent: { subagent_id: "sa-b", status: "unobserved" },
    });
    // A's event reached the socket, but only as a bare hint, not as A's block.
    expect(got[1]).toEqual({ session: SESSION_ID });
    expect(sockets).toHaveLength(4);
    expect(sockets[3]?.sent[0]?.params).toMatchObject({ session_id: OTHER });
  });

  test("children that first report after the turn ended still appear, tied to their call", async () => {
    const { client, sockets } = harness([
      turnDial([
        eventFrame("tool.start", 1, {
          tool_id: "call-1",
          name: "delegate_task",
          args: { goal: "Audit volumes" },
        }),
        eventFrame("tool.complete", 2, {
          tool_id: "call-1",
          name: "delegate_task",
          result: '{"status":"dispatched","delegation_id":"deleg-1","goals":["Audit volumes"]}',
        }),
        eventFrame("message.complete", 3, { text: "Dispatched.", status: "complete" }),
      ]),
      {
        initial: [
          eventFrame("subagent.spawn_requested", 4, child()),
          eventFrame("subagent.start", 5, child()),
          eventFrame("subagent.progress", 6, child({ text: "first look" })),
        ],
      },
    ]);
    expect(subagents(await frames(client))).toEqual([]);
    const got = await hints(client, 3);
    expect(got.map((h) => h.subagent?.status)).toEqual(["queued", "running", "running"]);
    expect(got.every((h) => h.session === STORED_SESSION_ID && h.subagent?.tool_id === "call-1")).toBe(
      true,
    );
    // Nothing was pending when the stream opened, so nothing was reconciled.
    expect(sockets).toHaveLength(2);
  });

  test("an event buffered before the roster snapshot cannot move the row backwards", async () => {
    const stale = eventFrame("subagent.tool", 10, child({ tool_name: "old_tool", tool_count: 1 }));
    for (const latest of [{ latest_seq: 20 }, {}]) {
      const { client } = harness([
        turnDial(DELEGATING_TURN),
        { initial: [stale] },
        {
          results: {
            "session.resume": { session_id: SESSION_ID },
            "session.events.since": latest,
            "subagent.list": {
              subagents: [{ subagent_id: "sa-1", status: "running", tool_count: 5, last_tool: "grep" }],
            },
          },
        },
      ]);
      await frames(client);
      const got = await hints(client, 2);
      expect(got[0]?.subagent).toMatchObject({ origin: "replay", tool_count: 5 });
      // With a watermark (`seq` 10 ≤ 20) or without one (1 call < 5), the
      // buffered event is older than the snapshot and changes nothing.
      expect(got[1]?.subagent?.tool_count).toBe(5);
      expect(got[1]?.subagent?.tools.map((t) => t.name)).toEqual(["grep"]);
    }
    const ledger = createSubagentLedger();
    ledger.apply("subagent.start", child());
    ledger.replay([{ subagent_id: "sa-1", status: "running", tool_count: 5 }], 20);
    const newer = ledger.apply("subagent.tool", child({ tool_name: "next", tool_count: 6 }), 21);
    expect(newer).toMatchObject({ tool_count: 6, tools: [{ name: "next", preview: "" }] });
    // Monotonic with no snapshot at all: a late event counting fewer calls.
    const late = ledger.apply("subagent.progress", child({ text: "late", tool_count: 2 }), 22);
    expect(late?.tool_count).toBe(6);
  });
});

/* ── review round 2 regressions ───────────────────────────────────────────── */

describe("subagent ledgers: snapshots, eviction and retention", () => {
  test("a snapshot older than an applied event changes nothing, with or without a watermark", () => {
    for (const watermark of [20, null]) {
      const ledger = createSubagentLedger();
      ledger.apply("subagent.start", child());
      ledger.apply("subagent.tool", child({ tool_name: "new", tool_count: 6 }), 21);
      ledger.replay(
        [{ subagent_id: "sa-1", status: "queued", tool_count: 5, last_tool: "old" }],
        watermark,
      );
      expect(ledger.get("sa-1")).toMatchObject({
        status: "running",
        tool_count: 6,
        tools: [{ name: "new", preview: "" }],
      });
    }
  });

  test("a session a turn is attached to, or with a child running, is never evicted", () => {
    const ledgers = createSubagentLedgers();
    const turn = subagentTurn(ledgers, { box: BOX, bot: BOT, runtime: "rt-a", stored: "stored-a" });
    const crowd = (prefix: string) => {
      for (let i = 0; i <= SUBAGENT_SESSIONS_MAX; i += 1)
        ledgers.session(BOX, BOT, `${prefix}-${i}`, `stored-${prefix}-${i}`);
    };
    crowd("idle");
    // Attached: still registered after a crowd of newer sessions.
    const before = ledgers.existing(BOX, "rt-a");
    expect(before).not.toBeNull();
    // The turn's events land in the registered ledger, the one control reads.
    expect(turn.event("subagent.start", child(), 1)).toMatchObject({ status: "running" });
    expect(ledgers.existing(BOX, "rt-a")).toBe(before);
    expect(ledgers.existing(BOX, "rt-a")?.ledger.get("sa-1")).toMatchObject({ status: "running" });
    turn.close();
    crowd("more");
    // Detached, but its child still runs: kept.
    expect(ledgers.existing(BOX, "rt-a")?.ledger.get("sa-1")).toMatchObject({ status: "running" });
    ledgers.existing(BOX, "rt-a")?.ledger.apply("subagent.complete", child({ status: "completed" }), 2);
    crowd("last");
    expect(ledgers.existing(BOX, "rt-a")).toBeNull();
  });

  test("finished children are bounded per session; running ones are all kept", () => {
    const ledger = createSubagentLedger();
    ledger.apply("subagent.start", child({ subagent_id: "running" }));
    const total = SUBAGENT_TERMINAL_MAX + 50;
    for (let i = 0; i < total; i += 1) {
      ledger.apply("subagent.start", child({ subagent_id: `done-${i}` }));
      ledger.apply(
        "subagent.complete",
        child({ subagent_id: `done-${i}`, status: "completed" }),
        1000 + i,
      );
    }
    const kept = ledger.all();
    expect(kept).toHaveLength(SUBAGENT_TERMINAL_MAX + 1);
    expect(ledger.get("running")).toMatchObject({ status: "running" });
    expect(ledger.get("done-0")).toBeNull();
    // A retained child's replayed completion is still recognised.
    const last = `done-${total - 1}`;
    expect(
      ledger.apply(
        "subagent.complete",
        child({ subagent_id: last, status: "completed" }),
        1000 + total - 1,
      ),
    ).toMatchObject({ subagent_id: last, status: "completed" });
  });
});
