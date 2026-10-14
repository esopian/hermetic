/**
 * One socket per conversation, held across turns (issue #60,
 * `hermes-chat-session-socket.ts`).
 *
 * The double here is a *stateful* gateway rather than a per-dial script,
 * because the bug is a property of the gateway's state: it counts the sockets
 * attached to each session, arms a reap when the last one closes, and the reap
 * kills the session's background processes. A turn that hangs up between
 * prompts is only visible as a process that died — so the fake keeps sessions,
 * attachments, reap timers and processes, and every assertion below reads that
 * state rather than a transcript.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHermesChat, disposeChatRequestPools } from "../src/chat/hermes/hermes-chat.ts";
import type {
  BoxAddress,
  ChatFetch,
  ChatSocket,
  HermesChatClient,
} from "../src/chat/hermes/hermes-chat.ts";
import { dialDetached, type Rpc, untilAbort } from "../src/chat/hermes/hermes-chat-rpc.ts";
import {
  createSessionSockets,
  type SessionSocketTuning,
  trackedSessionSockets,
} from "../src/chat/hermes/hermes-chat-session-socket.ts";
import type { ChatObserveHint } from "../src/chat/chat-observe.ts";
import type { ChatFrame } from "../src/schema/index.ts";
import { eventFrame } from "./fixtures/hermes-frames.ts";

afterEach(() => disposeChatRequestPools());

const BOX: BoxAddress = {
  instance: "veronica",
  baseUrl: "https://fxtr0001-veronica.tail0000.ts.net/",
  fleet_id: "fxtr0001",
};
const BOT = "default";
const STORED = "stored-FIXTURE-1";
const TOKEN_PAGE = '<script>window.__HERMES_SESSION_TOKEN__="FIXTURE-token"</script>';
/** The gateway's orphan grace, shrunk from twenty seconds. */
const GRACE_MS = 40;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, ms = 1_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(2);
  }
}

/* ── the fake gateway ─────────────────────────────────────────────────────── */

interface Proc {
  id: string;
  cmd: string;
  stored: string;
  alive: boolean;
  exit: { code: number; source: string } | null;
}

interface Session {
  stored: string;
  /** Null while the session is not live in the gateway (never resumed, or reaped). */
  runtime: string | null;
  attached: Set<FakeSocket>;
  reap: ReturnType<typeof setTimeout> | null;
  reaped: number;
  seq: number;
  log: { seq: number; frame: string }[];
  /** A turn started with `HOLD` in its prompt, waiting for `finishTurn`. */
  running: boolean;
}

interface FakeSocket extends ChatSocket {
  index: number;
  sent: { method: string; params: Record<string, unknown> }[];
  methods(): string[];
  push(frame: string): void;
  /** The box dropping the connection: the client's reader sees the end. */
  serverClose(): void;
  isClosed(): boolean;
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
      if (done) return;
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

function gateway() {
  const sessions = new Map<string, Session>();
  const processes = new Map<string, Proc>();
  const sockets: FakeSocket[] = [];
  let refusals = 0;
  let runtimes = 0;
  let created = 0;
  let compressions = 0;
  /** The Bot Chat's root and current tip, when the test registered one. */
  let botChat: { root: string; tip: string } | null = null;
  /** A method whose next reply is the last frame its socket carries. */
  let dropAfter: string | null = null;
  /** While set, a new socket's open waits on it. */
  let gate: Promise<void> | null = null;
  /** A method whose next call is acted on but never answered. */
  let hang: string | null = null;

  function session(stored: string): Session {
    let found = sessions.get(stored);
    if (!found) {
      found = {
        stored,
        runtime: null,
        attached: new Set(),
        reap: null,
        reaped: 0,
        seq: 0,
        log: [],
        running: false,
      };
      sessions.set(stored, found);
    }
    return found;
  }

  function byRuntime(runtime: unknown): Session | undefined {
    return [...sessions.values()].find((s) => s.runtime !== null && s.runtime === runtime);
  }

  function attach(s: Session, socket: FakeSocket): void {
    if (s.runtime === null) s.runtime = `rt-${++runtimes}`;
    if (s.reap !== null) clearTimeout(s.reap);
    s.reap = null;
    s.attached.add(socket);
  }

  /** `agent.close()`: the runtime goes, and every process it started with it. */
  function reap(s: Session): void {
    if (s.reap !== null) clearTimeout(s.reap);
    s.reap = null;
    for (const p of processes.values()) {
      if (p.stored !== s.stored || !p.alive) continue;
      p.alive = false;
      p.exit = { code: -15, source: "agent_close" };
    }
    s.runtime = null;
    s.running = false;
    s.reaped += 1;
  }

  /** `session_lifecycle.py`'s ws orphan reap, armed when the last socket leaves. */
  function detachAll(socket: FakeSocket): void {
    for (const s of sessions.values()) {
      if (!s.attached.delete(socket) || s.attached.size > 0 || s.runtime === null) continue;
      s.reap = setTimeout(() => {
        s.reap = null;
        if (s.attached.size === 0) reap(s);
      }, GRACE_MS);
    }
  }

  /** A background process finishing: `status.update` to every attached socket. */
  function notice(s: Session, cmd: string): void {
    for (const socket of s.attached)
      socket.push(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "event",
          params: {
            type: "status.update",
            session_id: s.runtime,
            payload: { kind: "process", text: `Background Process Finished: ${cmd}` },
          },
        }),
      );
  }

  /** One session event, logged for replay and fanned out to every attached socket. */
  function emit(s: Session, type: string, payload: unknown): void {
    s.seq += 1;
    const frame = eventFrame(type, s.seq, payload, s.runtime ?? "");
    s.log.push({ seq: s.seq, frame });
    for (const socket of s.attached) socket.push(frame);
  }

  function finishTurn(s: Session, text: string): void {
    s.running = false;
    emit(s, "message.delta", { text });
    emit(s, "message.complete", { text, status: "complete" });
  }

  /**
   * `_sync_session_key_after_compress`: the same runtime carries on under a new
   * stored id, and so do the processes it started.
   */
  function compress(s: Session): string {
    const next = `${s.stored}-c${++compressions}`;
    for (const p of processes.values()) if (p.stored === s.stored) p.stored = next;
    if (botChat?.tip === s.stored) botChat.tip = next;
    sessions.delete(s.stored);
    s.stored = next;
    sessions.set(next, s);
    return next;
  }

  function answer(socket: FakeSocket, method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case "client.capabilities":
        return {};
      case "session.create": {
        const s = session(`stored-created-${++created}`);
        attach(s, socket);
        return { session_id: s.runtime, stored_session_id: s.stored, info: {} };
      }
      case "session.resume": {
        // A live runtime id re-attaches too: that is how a turn's pump resumes.
        const s = byRuntime(params.session_id) ?? session(String(params.session_id));
        attach(s, socket);
        return { session_id: s.runtime, stored_session_id: s.stored, running: s.running, info: {} };
      }
      case "session.events.since": {
        const s = byRuntime(params.session_id);
        const after = Number(params.last_seen);
        return {
          events: (s?.log ?? [])
            .filter((row) => row.seq > after)
            .map((row) => (JSON.parse(row.frame) as { params: unknown }).params),
          latest_seq: s?.seq ?? 0,
          epoch: "e1",
          truncated: false,
          open_requests: [],
        };
      }
      case "subagent.list":
        return { subagents: [] };
      case "session.list":
        return {
          sessions: botChat ? [{ id: botChat.root, title: "Bot Chat", resolved_id: botChat.tip }] : [],
        };
      case "session.interrupt": {
        const s = byRuntime(params.session_id);
        if (s) s.running = false;
        return { status: "interrupted" };
      }
      case "session.compress": {
        const s = byRuntime(params.session_id);
        if (!s) return { status: "unknown" };
        compress(s);
        return { status: "compressed", compressed: true };
      }
      default:
        return {};
    }
  }

  /** What `prompt.submit` does once its reply is on the wire. */
  function run(params: Record<string, unknown>): void {
    const s = byRuntime(params.session_id);
    if (!s) return;
    const text = String(params.text);
    s.running = true;
    emit(s, "message.start", {});
    const started = /START (\S+)/.exec(text)?.[1];
    if (started) start(s.stored, started);
    if (text.includes("HOLD")) emit(s, "message.delta", { text: "partial " });
    else finishTurn(s, "ok");
    // In the same batch as the completion, so it lands after the turn's last read.
    if (text.includes("NOTICE")) notice(s, "sleep-1");
  }

  function start(stored: string, cmd: string): string {
    const id = `proc-${processes.size + 1}`;
    processes.set(id, { id, cmd, stored, alive: true, exit: null });
    return id;
  }

  function openSocket(_url: string, opts: { signal?: AbortSignal | undefined } = {}): ChatSocket {
    const q = queue<string>();
    let closed = false;
    const refused = refusals > 0;
    if (refused) refusals -= 1;
    const sent: FakeSocket["sent"] = [];
    const shut = (): void => {
      if (closed) return;
      closed = true;
      q.close();
      detachAll(socket);
    };
    const socket: FakeSocket = {
      index: sockets.length,
      sent,
      methods: () => sent.map((s) => s.method),
      push: (frame) => q.push(frame),
      serverClose: shut,
      isClosed: () => closed,
      opened: refused ? Promise.reject(new Error("refused")) : (gate ?? Promise.resolve()),
      frames: q.drain(),
      send(data: string) {
        if (closed) return;
        const doc = JSON.parse(data) as { id: number; method: string; params: Record<string, unknown> };
        sent.push({ method: doc.method, params: doc.params });
        if (doc.method === "ping") return;
        if (hang === doc.method) {
          hang = null;
          // The box acts on it; only the reply is lost.
          if (doc.method === "prompt.submit") run(doc.params);
          return;
        }
        q.push(
          JSON.stringify({
            jsonrpc: "2.0",
            id: doc.id,
            result: answer(socket, doc.method, doc.params),
          }),
        );
        if (dropAfter === doc.method) {
          dropAfter = null;
          shut();
          return;
        }
        if (doc.method === "prompt.submit") run(doc.params);
      },
      close: shut,
    };
    if (refused) {
      closed = true;
      q.close();
    } else {
      sockets.push(socket);
      // As the runtime's socket does (`chat-transport.ts`): the dial's signal
      // is the socket's lifetime, and its abort closes it.
      opts.signal?.addEventListener("abort", shut, { once: true });
    }
    return socket;
  }

  return {
    sockets,
    sessions,
    processes,
    openSocket,
    session,
    /** Refuse the next `n` socket opens; zero stops refusing. */
    refuseNext(n: number) {
      refusals = n;
    },
    /** Hold every socket opened from now on until the returned function runs. */
    gateOpens(): () => void {
      let open = (): void => {};
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      return () => {
        gate = null;
        open();
      };
    },
    /** Act on the next call of `method` but never answer it. */
    hang(method: string) {
      hang = method;
    },
    /** Drop the connection that next calls `method`, right after its reply. */
    dropAfter(method: string) {
      dropAfter = method;
    },
    /**
     * Compress `stored` on the gateway's own initiative — upstream's post-turn
     * auto-compression, or a compact from another process — so the runtime
     * carries on under a new stored id this client was never told about.
     */
    rotate(stored: string): string {
      const s = sessions.get(stored);
      if (!s) throw new Error(`no session ${stored}`);
      return compress(s);
    },
    /** Reap `stored` now, as if its grace had already run out. */
    reapNow(stored: string) {
      const s = sessions.get(stored);
      if (s) reap(s);
    },
    /** Register `root` as the bot's Bot Chat, so the canonical reads find it. */
    botChat(root: string) {
      session(root);
      botChat = { root, tip: root };
    },
    startProcess(stored: string, cmd: string): string {
      return start(stored, cmd);
    },
    /** A background process finishing: `status.update` to every attached socket. */
    completeProcess(id: string): void {
      const p = processes.get(id);
      const s = p ? sessions.get(p.stored) : undefined;
      if (!p || !s) return;
      p.alive = false;
      p.exit = { code: 0, source: "exit" };
      notice(s, p.cmd);
    },
    finishTurn(stored: string): void {
      const s = sessions.get(stored);
      if (s) finishTurn(s, "done");
    },
    reapArmed(stored: string): boolean {
      return sessions.get(stored)?.reap != null;
    },
  };
}

type Gateway = ReturnType<typeof gateway>;

function client(
  gw: Gateway,
  opts: { sessionTuning?: SessionSocketTuning; archiveOk?: boolean } = {},
): HermesChatClient {
  const archived = opts.archiveOk ?? true;
  const fetchImpl: ChatFetch = (_input, init) =>
    Promise.resolve(
      init?.method === "PATCH"
        ? new Response(JSON.stringify({ ok: archived, archived }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : new Response(TOKEN_PAGE, { status: 200, headers: { "content-type": "text/html" } }),
    );
  return createHermesChat({
    fetch: fetchImpl,
    openSocket: gw.openSocket,
    now: () => "2026-10-13T10:00:00.000Z",
    slotWaitMs: 500,
    pooled: false,
    sessionTuning: opts.sessionTuning ?? { sleep: async () => {}, attempts: 2 },
    resumeTuning: { sleep: async () => {}, attempts: 2 },
  });
}

async function collect(stream: AsyncIterable<ChatFrame>): Promise<ChatFrame[]> {
  const out: ChatFrame[] = [];
  for await (const frame of stream) out.push(frame);
  return out;
}

function completed(frames: ChatFrame[]): boolean {
  const last = frames.at(-1);
  return last?.type === "done" && last.incomplete !== true;
}

/** `pending`'s hint, or null if none arrives within `ms`. */
async function within(
  pending: Promise<IteratorResult<ChatObserveHint>>,
  ms: number,
): Promise<ChatObserveHint | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), ms));
  return Promise.race([pending.then((r) => (r.done === true ? null : r.value)), timeout]);
}

/* ── the tests ────────────────────────────────────────────────────────────── */

describe("hermes-chat · held session sockets", () => {
  test("two turns on one conversation share one socket and one runtime session", async () => {
    const gw = gateway();
    gw.session(STORED);
    const chat = client(gw);

    expect(completed(await collect(chat.send(BOX, BOT, "one", { session: STORED })))).toBe(true);
    const runtime = gw.sessions.get(STORED)?.runtime;
    expect(runtime).toBe("rt-1");
    expect(completed(await collect(chat.send(BOX, BOT, "two", { session: STORED })))).toBe(true);

    expect(gw.sockets).toHaveLength(1);
    expect(gw.sockets[0]?.isClosed()).toBe(false);
    expect(gw.sessions.get(STORED)?.runtime).toBe(runtime);
    // The second turn re-attached on the held socket rather than dialling.
    expect(gw.sockets[0]?.methods().filter((m) => m === "session.resume")).toHaveLength(2);
    const submits = gw.sockets[0]?.sent.filter((s) => s.method === "prompt.submit") ?? [];
    expect(submits.map((s) => s.params.session_id)).toEqual([runtime, runtime]);
  });

  test("a turn ending leaves the session attached; release and archive end it", async () => {
    const gw = gateway();
    gw.session(STORED);
    const chat = client(gw);

    await collect(chat.send(BOX, BOT, "one", { session: STORED }));
    await sleep(GRACE_MS * 2);
    expect(gw.reapArmed(STORED)).toBe(false);
    expect(gw.sessions.get(STORED)?.reaped).toBe(0);

    expect(chat.release?.(BOX, BOT, STORED)).toBe(true);
    expect(gw.sockets[0]?.isClosed()).toBe(true);
    expect(gw.reapArmed(STORED)).toBe(true);
    await until(() => gw.sessions.get(STORED)?.reaped === 1);
    expect(chat.release?.(BOX, BOT, STORED)).toBe(false);

    // Archive closes the hold too, once the gateway has confirmed it.
    await collect(chat.send(BOX, BOT, "again", { session: STORED }));
    const held = gw.sockets.at(-1);
    expect(held?.isClosed()).toBe(false);
    await chat.archive?.(BOX, BOT, STORED);
    expect(held?.isClosed()).toBe(true);
    await until(() => gw.sessions.get(STORED)?.reaped === 2);
  });

  test("a background process outlives the next turn, and its completion reaches the watch", async () => {
    const gw = gateway();
    gw.session(STORED);
    const chat = client(gw);

    await collect(chat.send(BOX, BOT, "START sleep-60", { session: STORED }));
    const [proc] = [...gw.processes.values()];
    await collect(chat.send(BOX, BOT, "two", { session: STORED }));
    await sleep(GRACE_MS * 2);
    expect(proc?.alive).toBe(true);

    // Pinned to the stored id, as a pane's watch is: the event names the
    // runtime id, and the hold is what maps it back.
    const watch = chat
      .observe?.(BOX, BOT, { session: STORED, sessions: () => [STORED] })
      [Symbol.asyncIterator]();
    if (!watch) throw new Error("observe missing");
    // One pending read for the whole test: an abandoned `next()` would take
    // the hint itself. The watch subscribes to the held sockets as it starts,
    // before its own dial resolves, so a process finishing while that dial is
    // still opening reaches it.
    const opens = gw.gateOpens();
    const pending = watch.next();
    await until(() => gw.sockets.length === 2);
    gw.completeProcess(proc?.id ?? "");
    // A macrotask turn: every microtask between the frame and the bus has run,
    // so the event is published while the watch's socket is still opening.
    await new Promise((resolve) => setTimeout(resolve, 0));
    opens();
    const hint = await within(pending, 500);
    expect(hint).toEqual({ session: STORED });
    // It came over the held socket's idle events: the passive socket (the
    // first one dialled after the held one) is not attached to the session,
    // and this gateway does not broadcast to it.
    const observer = gw.sockets[1];
    expect(observer).toBeDefined();
    expect(observer?.sent).toEqual([]);
    await watch.return?.(undefined);
  });

  test("an idle socket that drops is redialled and re-attached within the grace", async () => {
    const gw = gateway();
    gw.session(STORED);
    const chat = client(gw);

    await collect(chat.send(BOX, BOT, "START sleep-60", { session: STORED }));
    const [proc] = [...gw.processes.values()];
    gw.sockets[0]?.serverClose();
    // The redial lands at once (the backoff's sleep is stubbed); the grace
    // then passes, and only a re-attach on the new socket stops the reap.
    await until(() => gw.sockets.length === 2);
    await sleep(GRACE_MS * 2);
    expect(proc?.alive).toBe(true);
    expect(gw.sessions.get(STORED)?.reaped).toBe(0);
    expect(gw.sockets[1]?.sent.find((s) => s.method === "session.resume")?.params).toEqual({
      session_id: STORED,
      profile: BOT,
      source: "hermetic",
      defer_history: true,
      omit_messages: true,
    });

    // The next turn rides the redialled socket.
    expect(completed(await collect(chat.send(BOX, BOT, "two", { session: STORED })))).toBe(true);
    expect(gw.sockets).toHaveLength(2);
    expect(gw.sockets[1]?.methods().filter((m) => m === "prompt.submit")).toHaveLength(1);
  });

  test("an idle socket whose redials are refused is let go, and the gateway reaps", async () => {
    const gw = gateway();
    gw.session(STORED);
    const chat = client(gw);

    await collect(chat.send(BOX, BOT, "START sleep-60", { session: STORED }));
    const [proc] = [...gw.processes.values()];
    gw.refuseNext(100);
    gw.sockets[0]?.serverClose();
    await until(() => gw.sessions.get(STORED)?.reaped === 1);
    expect(proc?.exit).toEqual({ code: -15, source: "agent_close" });
    // The budget was spent before the grace was, so the hold is already gone.
    expect(chat.release?.(BOX, BOT, STORED)).toBe(false);

    // Evicted, so the next turn dials fresh and resumes the durable session.
    gw.refuseNext(0);
    expect(completed(await collect(chat.send(BOX, BOT, "two", { session: STORED })))).toBe(true);
    expect(gw.sockets).toHaveLength(2);
    expect(gw.sessions.get(STORED)?.runtime).toBe("rt-2");
  });

  test("a turn whose socket dropped hands its reconnected socket to the hold", async () => {
    const gw = gateway();
    gw.session(STORED);
    const chat = client(gw);

    const frames: ChatFrame[] = [];
    let dropped = false;
    for await (const frame of chat.send(BOX, BOT, "HOLD", { session: STORED })) {
      frames.push(frame);
      if (!dropped && frame.type === "delta") {
        dropped = true;
        gw.sockets[0]?.serverClose();
        // Once the pump has re-attached, the box finishes the turn.
        void until(() => gw.sockets[1]?.methods().includes("session.events.since") === true).then(() =>
          gw.finishTurn(STORED),
        );
      }
    }
    expect(completed(frames)).toBe(true);
    expect(gw.sockets).toHaveLength(2);
    expect(gw.sockets[1]?.isClosed()).toBe(false);

    expect(completed(await collect(chat.send(BOX, BOT, "two", { session: STORED })))).toBe(true);
    expect(gw.sockets).toHaveLength(2);
    expect(gw.sockets[1]?.methods().filter((m) => m === "prompt.submit")).toHaveLength(1);
  });

  test("an idle held socket stops answering prompts until the next turn leases it", async () => {
    const gw = gateway();
    gw.session(STORED);
    const chat = client(gw);

    await collect(chat.send(BOX, BOT, "one", { session: STORED }));
    await collect(chat.send(BOX, BOT, "two", { session: STORED }));
    const flips = (gw.sockets[0]?.sent ?? [])
      .filter((s) => s.method === "client.capabilities")
      .map((s) => s.params.server_requests);
    expect(flips).toEqual([true, false, true, false]);
  });

  test("a frame behind the turn's last read reaches the watch rather than being dropped", async () => {
    const gw = gateway();
    gw.session(STORED);
    const chat = client(gw);

    const watch = chat
      .observe?.(BOX, BOT, { session: STORED, sessions: () => [STORED] })
      [Symbol.asyncIterator]();
    if (!watch) throw new Error("observe missing");
    const pending = watch.next();
    // The process notice arrives in the same batch as `message.complete`.
    expect(completed(await collect(chat.send(BOX, BOT, "NOTICE", { session: STORED })))).toBe(true);
    expect(await within(pending, 500)).toEqual({ session: STORED });
    await watch.return?.(undefined);
  });

  test("compaction keeps the hold under the new tip, and the processes with it", async () => {
    const gw = gateway();
    gw.botChat(STORED);
    const chat = client(gw);

    await collect(chat.send(BOX, BOT, "START sleep-60", { session: STORED }));
    const [proc] = [...gw.processes.values()];
    const held = gw.sockets[0];
    const result = await chat.compact?.(BOX, BOT, { session: STORED });
    const tip = result?.conversation.session;
    expect(tip).toBe(`${STORED}-c1`);
    expect(held?.isClosed()).toBe(false);
    await sleep(GRACE_MS * 2);
    expect(proc?.alive).toBe(true);
    expect(gw.sessions.get(tip ?? "")?.reaped).toBe(0);

    // The next turn names the tip and rides the same socket.
    const dials = gw.sockets.length;
    expect(completed(await collect(chat.send(BOX, BOT, "two", { session: tip })))).toBe(true);
    expect(gw.sockets).toHaveLength(dials);
    expect(held?.methods().filter((m) => m === "prompt.submit")).toHaveLength(2);
    expect(chat.release?.(BOX, BOT, STORED)).toBe(false);
    expect(chat.release?.(BOX, BOT, tip ?? "")).toBe(true);
  });

  test("a refused archive leaves the conversation held", async () => {
    const gw = gateway();
    gw.session(STORED);
    const chat = client(gw, { archiveOk: false });

    await collect(chat.send(BOX, BOT, "one", { session: STORED }));
    await expect(chat.archive?.(BOX, BOT, STORED)).rejects.toThrow();
    expect(gw.sockets[0]?.isClosed()).toBe(false);
    expect(chat.release?.(BOX, BOT, STORED)).toBe(true);
  });

  test("a held socket that drops before the turn's pump exists is redialled after the turn", async () => {
    const gw = gateway();
    gw.session(STORED);
    const chat = client(gw);

    await collect(chat.send(BOX, BOT, "START sleep-60", { session: STORED }));
    const [proc] = [...gw.processes.values()];
    // The second turn re-attaches, and the box drops it before the prompt.
    gw.dropAfter("session.resume");
    const frames = await collect(chat.send(BOX, BOT, "two", { session: STORED }));
    expect(completed(frames)).toBe(false);
    expect(gw.sockets[0]?.isClosed()).toBe(true);
    // The prompt may have landed before the socket died, so the turn tells the
    // box to stop on a dial of its own, which hangs up once it has said so.
    const parting = gw.sockets.find((s) => s.methods().includes("session.interrupt"));
    expect(parting?.isClosed()).toBe(true);
    // The hold then redials and re-attaches on a socket it keeps.
    const revived = () =>
      gw.sockets.find((s) => s !== gw.sockets[0] && s.methods().includes("session.resume"));
    await until(() => revived() !== undefined);
    await sleep(GRACE_MS * 2);
    expect(proc?.alive).toBe(true);
    expect(gw.sessions.get(STORED)?.reaped).toBe(0);
    expect(revived()?.isClosed()).toBe(false);

    // Re-held, so the next turn rides the redialled socket.
    const before = gw.sockets.length;
    expect(completed(await collect(chat.send(BOX, BOT, "three", { session: STORED })))).toBe(true);
    expect(gw.sockets).toHaveLength(before);
  });

  test("an idle redial that outlasts its deadline gives the hold up", async () => {
    const gw = gateway();
    gw.session(STORED);
    // A real sleep, so the first backoff runs past the deadline.
    const chat = client(gw, { sessionTuning: { graceMs: 10, baseMs: 1_000, attempts: 2 } });

    await collect(chat.send(BOX, BOT, "one", { session: STORED }));
    expect(trackedSessionSockets()).toBe(1);
    gw.sockets[0]?.serverClose();
    await until(() => trackedSessionSockets() === 0, 500);
    // Given up without dialling: the next turn starts fresh.
    expect(gw.sockets).toHaveLength(1);
    expect(chat.release?.(BOX, BOT, STORED)).toBe(false);
  });

  test("an idle redial that finds a different runtime gives the hold up", async () => {
    const gw = gateway();
    gw.session(STORED);
    // The gateway reaps during the backoff, and the resume recreates the session.
    const chat = client(gw, {
      sessionTuning: { attempts: 2, sleep: async () => gw.reapNow(STORED) },
    });

    await collect(chat.send(BOX, BOT, "one", { session: STORED }));
    expect(gw.sessions.get(STORED)?.runtime).toBe("rt-1");
    gw.sockets[0]?.serverClose();
    await until(() => trackedSessionSockets() === 0);
    expect(gw.sockets).toHaveLength(2);
    expect(gw.sockets[1]?.methods()).toContain("session.resume");
    expect(gw.sockets[1]?.isClosed()).toBe(true);
    expect(chat.release?.(BOX, BOT, STORED)).toBe(false);
  });

  test("overlapping turns leave exactly one hold, even when the first one's is lost", async () => {
    const gw = gateway();
    gw.session(STORED);
    const chat = client(gw);

    const first = chat.send(BOX, BOT, "HOLD", { session: STORED })[Symbol.asyncIterator]();
    const second = chat.send(BOX, BOT, "HOLD", { session: STORED })[Symbol.asyncIterator]();
    const untilDelta = async (it: AsyncIterator<ChatFrame>): Promise<void> => {
      for (;;) {
        const next = await it.next();
        if (next.done === true) throw new Error("turn ended early");
        if (next.value.type === "delta") return;
      }
    };
    const rest = async (it: AsyncIterator<ChatFrame>): Promise<ChatFrame[]> => {
      const out: ChatFrame[] = [];
      for (;;) {
        const next = await it.next();
        if (next.done === true) return out;
        out.push(next.value);
      }
    };
    await untilDelta(first);
    // The first turn holds the conversation, so the second dials its own.
    await untilDelta(second);
    expect(gw.sockets).toHaveLength(2);

    // The first turn's socket drops for good: its pump and the hold's redial
    // are both refused, and the hold is let go while the second turn runs.
    gw.refuseNext(100);
    gw.sockets[0]?.serverClose();
    expect(completed(await rest(first))).toBe(false);
    await until(() => trackedSessionSockets() === 0);
    gw.refuseNext(0);

    gw.finishTurn(STORED);
    expect(completed(await rest(second))).toBe(true);
    // The second turn's socket took the hold over instead of closing.
    expect(trackedSessionSockets()).toBe(1);
    expect(gw.sockets[1]?.isClosed()).toBe(false);
    await sleep(GRACE_MS * 2);
    expect(gw.sessions.get(STORED)?.attached.size).toBe(1);
    expect(gw.sessions.get(STORED)?.reaped).toBe(0);
    expect(completed(await collect(chat.send(BOX, BOT, "three", { session: STORED })))).toBe(true);
    expect(gw.sockets).toHaveLength(2);
  });

  test("a turn's signal aborting after the turn leaves the held socket attached", async () => {
    const gw = gateway();
    gw.session(STORED);
    const chat = client(gw);

    // The app aborts each turn's signal once the turn is over; here the first
    // one goes at the `done` frame, before the generator has unwound.
    const first = new AbortController();
    const frames: ChatFrame[] = [];
    for await (const frame of chat.send(BOX, BOT, "START sleep-60", {
      session: STORED,
      signal: first.signal,
    })) {
      frames.push(frame);
      if (frame.type === "done") first.abort();
    }
    expect(completed(frames)).toBe(true);
    const [proc] = [...gw.processes.values()];
    await sleep(GRACE_MS * 2);
    expect(gw.sockets[0]?.isClosed()).toBe(false);
    expect(proc?.alive).toBe(true);

    // The second one after the generator has returned.
    const second = new AbortController();
    expect(
      completed(await collect(chat.send(BOX, BOT, "two", { session: STORED, signal: second.signal }))),
    ).toBe(true);
    second.abort();
    await sleep(GRACE_MS * 2);
    expect(gw.sockets).toHaveLength(1);
    expect(gw.sockets[0]?.isClosed()).toBe(false);
    expect(gw.sockets[0]?.methods().filter((m) => m === "prompt.submit")).toHaveLength(2);
    expect(proc?.alive).toBe(true);
    expect(gw.sessions.get(STORED)?.reaped).toBe(0);
  });

  test("a stop mid-stream interrupts the box on the held socket, and keeps it", async () => {
    const gw = gateway();
    gw.session(STORED);
    const chat = client(gw);

    const control = new AbortController();
    const frames: ChatFrame[] = [];
    for await (const frame of chat.send(BOX, BOT, "HOLD START sleep-60", {
      session: STORED,
      signal: control.signal,
    })) {
      frames.push(frame);
      if (frame.type === "delta") control.abort();
    }
    const last = frames.at(-1);
    expect(last?.type === "done" ? last.incomplete : null).toBe(true);
    const held = gw.sockets[0];
    expect(gw.sockets).toHaveLength(1);
    expect(held?.methods()).toContain("session.interrupt");
    expect(held?.isClosed()).toBe(false);
    const [proc] = [...gw.processes.values()];
    await sleep(GRACE_MS * 2);
    expect(proc?.alive).toBe(true);
    expect(gw.sessions.get(STORED)?.reaped).toBe(0);

    expect(completed(await collect(chat.send(BOX, BOT, "two", { session: STORED })))).toBe(true);
    expect(gw.sockets).toHaveLength(1);
    expect(held?.methods().filter((m) => m === "prompt.submit")).toHaveLength(2);
  });

  test("a stop while prompt.submit is unanswered still interrupts the box", async () => {
    const gw = gateway();
    gw.session(STORED);
    const chat = client(gw);

    // The box takes the prompt and starts the turn; its reply never arrives.
    gw.hang("prompt.submit");
    const control = new AbortController();
    const pending = collect(
      chat.send(BOX, BOT, "HOLD START sleep-60", { session: STORED, signal: control.signal }),
    );
    await until(() => gw.sockets[0]?.methods().includes("prompt.submit") === true);
    control.abort();
    const frames = await pending;
    expect(frames.at(-1)).toMatchObject({ type: "error", code: "ABORTED" });
    const held = gw.sockets[0];
    expect(held?.methods()).toContain("session.interrupt");
    expect(gw.sessions.get(STORED)?.running).toBe(false);
    expect(held?.isClosed()).toBe(false);
    const [proc] = [...gw.processes.values()];
    await sleep(GRACE_MS * 2);
    expect(proc?.alive).toBe(true);

    expect(completed(await collect(chat.send(BOX, BOT, "two", { session: STORED })))).toBe(true);
    expect(gw.sockets).toHaveLength(1);
  });

  test("a consumer that stops reading mid-turn interrupts the box on the held socket", async () => {
    const gw = gateway();
    gw.session(STORED);
    const chat = client(gw);

    for await (const frame of chat.send(BOX, BOT, "HOLD", { session: STORED })) {
      if (frame.type === "delta") break;
    }
    const held = gw.sockets[0];
    expect(held?.methods()).toContain("session.interrupt");
    expect(gw.sessions.get(STORED)?.running).toBe(false);
    expect(held?.isClosed()).toBe(false);

    // A consumer that stops at the turn's last frame owes the box nothing.
    for await (const frame of chat.send(BOX, BOT, "two", { session: STORED })) {
      if (frame.type === "done") break;
    }
    expect(held?.methods().filter((m) => m === "session.interrupt")).toHaveLength(1);
  });

  test("a dial that never opens is closed when the turn is stopped", async () => {
    const gw = gateway();
    gw.session(STORED);
    const chat = client(gw);

    // A box off the tailnet: the socket neither opens nor fails.
    const opens = gw.gateOpens();
    try {
      const control = new AbortController();
      const pending = collect(chat.send(BOX, BOT, "one", { session: STORED, signal: control.signal }));
      await until(() => gw.sockets.length === 1);
      control.abort();
      expect((await pending).at(-1)).toMatchObject({ type: "error", code: "ABORTED" });
      expect(gw.sockets[0]?.isClosed()).toBe(true);
      expect(trackedSessionSockets()).toBe(0);
    } finally {
      opens();
    }
  });

  test("a socket that opens after its turn was stopped is closed, not held", async () => {
    const gw = gateway();
    gw.session(STORED);
    const chat = client(gw);

    const opens = gw.gateOpens();
    const control = new AbortController();
    const pending = collect(chat.send(BOX, BOT, "one", { session: STORED, signal: control.signal }));
    await until(() => gw.sockets.length === 1);
    control.abort();
    expect((await pending).at(-1)).toMatchObject({ type: "error", code: "ABORTED" });
    opens();
    await sleep(10);
    expect(gw.sockets[0]?.isClosed()).toBe(true);
    expect(gw.sockets[0]?.sent).toEqual([]);
    expect(trackedSessionSockets()).toBe(0);
    expect(chat.release?.(BOX, BOT, STORED)).toBe(false);
  });

  test("a revived socket outlives the redial's deadline and is not redialled", async () => {
    const gw = gateway();
    gw.session(STORED);
    // A deadline shorter than the wait below: the revived socket must survive it.
    const chat = client(gw, { sessionTuning: { sleep: async () => {}, attempts: 2, graceMs: 20 } });

    await collect(chat.send(BOX, BOT, "START sleep-60", { session: STORED }));
    const [proc] = [...gw.processes.values()];
    gw.sockets[0]?.serverClose();
    await until(() => gw.sockets[1]?.methods().includes("session.resume") === true);
    await sleep(100);
    expect(gw.sockets).toHaveLength(2);
    expect(gw.sockets[1]?.isClosed()).toBe(false);
    expect(gw.sessions.get(STORED)?.attached.size).toBe(1);
    expect(gw.sessions.get(STORED)?.reaped).toBe(0);
    expect(proc?.alive).toBe(true);
  });

  test("a reconnected socket adopted at release survives the turn's signal aborting", async () => {
    const gw = gateway();
    gw.session(STORED);
    const chat = client(gw);

    const signal = new AbortController();
    const frames: ChatFrame[] = [];
    let dropped = false;
    for await (const frame of chat.send(BOX, BOT, "HOLD", { session: STORED, signal: signal.signal })) {
      frames.push(frame);
      if (!dropped && frame.type === "delta") {
        dropped = true;
        gw.sockets[0]?.serverClose();
        void until(() => gw.sockets[1]?.methods().includes("session.events.since") === true).then(() =>
          gw.finishTurn(STORED),
        );
      }
    }
    expect(completed(frames)).toBe(true);
    signal.abort();
    await sleep(GRACE_MS * 2);
    expect(gw.sockets).toHaveLength(2);
    expect(gw.sockets[1]?.isClosed()).toBe(false);
    expect(gw.sessions.get(STORED)?.reaped).toBe(0);

    expect(completed(await collect(chat.send(BOX, BOT, "two", { session: STORED })))).toBe(true);
    expect(gw.sockets).toHaveLength(2);
  });

  test("a stored id rotated behind the client's back merges into one hold", async () => {
    const gw = gateway();
    gw.session(STORED);
    const chat = client(gw);

    await collect(chat.send(BOX, BOT, "START sleep-60", { session: STORED }));
    const [proc] = [...gw.processes.values()];
    // Upstream compresses after the turn: same runtime, new stored id.
    const rotated = gw.rotate(STORED);
    expect(completed(await collect(chat.send(BOX, BOT, "two", { session: rotated })))).toBe(true);
    // The second turn dialled for the new id; the old hold on the same runtime
    // was folded into it rather than left attached beside it.
    expect(gw.sockets).toHaveLength(2);
    expect(gw.sockets[0]?.isClosed()).toBe(true);
    expect(gw.sockets[1]?.isClosed()).toBe(false);
    await sleep(GRACE_MS * 2);
    expect(gw.sessions.get(rotated)?.attached.size).toBe(1);
    expect(proc?.alive).toBe(true);
    expect(chat.release?.(BOX, BOT, STORED)).toBe(false);

    await chat.archive?.(BOX, BOT, rotated);
    expect(gw.sockets.every((s) => s.isClosed())).toBe(true);
    expect(gw.sessions.get(rotated)?.attached.size).toBe(0);
    expect(trackedSessionSockets()).toBe(0);
  });

  test("archiving a Bot Chat by its root closes the hold under its compressed tip", async () => {
    const gw = gateway();
    gw.botChat(STORED);
    const chat = client(gw);

    await collect(chat.send(BOX, BOT, "one", { session: STORED }));
    const result = await chat.compact?.(BOX, BOT, { session: STORED });
    expect(result?.conversation.session).toBe(`${STORED}-c1`);
    const held = gw.sockets[0];
    expect(held?.isClosed()).toBe(false);

    const archived = await chat.archive?.(BOX, BOT, STORED);
    expect(archived?.session).toBe(STORED);
    expect(held?.isClosed()).toBe(true);
    expect(trackedSessionSockets()).toBe(0);
  });

  test("dispose closes every hold, and a release for an unknown conversation is false", async () => {
    const gw = gateway();
    gw.session(STORED);
    gw.session("stored-FIXTURE-2");
    const chat = client(gw);

    await collect(chat.send(BOX, BOT, "one", { session: STORED }));
    await collect(chat.send(BOX, BOT, "one", { session: "stored-FIXTURE-2" }));
    // A create names its durable id, which is enough to hold it.
    await collect(chat.send(BOX, BOT, "fresh"));
    expect(gw.sockets).toHaveLength(3);
    expect(gw.sockets.every((s) => !s.isClosed())).toBe(true);
    expect(trackedSessionSockets()).toBeGreaterThan(0);

    expect(chat.release?.(BOX, BOT, "stored-unknown")).toBe(false);
    expect(chat.release?.(BOX, "other-bot", STORED)).toBe(false);

    disposeChatRequestPools();
    expect(gw.sockets.every((s) => s.isClosed())).toBe(true);
    expect(trackedSessionSockets()).toBe(0);
  });
});

describe("hermes-chat · held session sockets, against a scripted socket", () => {
  /**
   * A socket whose event stream ends the moment `end` runs, with no transport
   * in between: the gap between a socket ending and the hold hearing of it is
   * a microtask or two, which the fake gateway's layers cannot hit.
   */
  function scripted(onUnref?: () => void): Rpc & { end(): void; ended(): boolean } {
    let ended = false;
    let finish: (() => void) | null = null;
    const end = (): void => {
      ended = true;
      finish?.();
    };
    return {
      request: (method) => Promise.resolve(method === "session.resume" ? { session_id: "rt-1" } : {}),
      events: {
        [Symbol.asyncIterator]: () => ({
          next: () =>
            ended
              ? Promise.resolve({ done: true as const, value: undefined })
              : new Promise<IteratorResult<Record<string, unknown>>>((resolve) => {
                  finish = () => resolve({ done: true, value: undefined });
                }),
        }),
      },
      arrived: () => 0,
      unref: () => onUnref?.(),
      close: end,
      end,
      ended: () => ended,
    };
  }

  test("a revived socket that ends as soon as it is adopted is redialled again", async () => {
    const dials: ReturnType<typeof scripted>[] = [];
    const sockets = createSessionSockets({
      connect: () => {
        // The first redial's socket ends right after the hold adopts it (its
        // `unref` is the adopt's last step); every other socket stays up.
        const rpc: ReturnType<typeof scripted> =
          dials.length === 1 ? scripted(() => rpc.end()) : scripted();
        dials.push(rpc);
        return Promise.resolve(rpc);
      },
      tuning: { sleep: async () => {}, attempts: 2 },
    });
    try {
      const lease = await sockets.lease(BOX, BOT, null, undefined);
      lease.keep(STORED, "rt-1");
      lease.release(lease.rpc);
      dials[0]?.end();
      await until(() => dials.length >= 2);
      await sleep(20);
      expect(dials).toHaveLength(3);
      expect(sockets.peek(BOX, BOT, STORED)?.runtime).toBe("rt-1");
    } finally {
      sockets.dispose();
    }
  });

  test("a turn whose hold was folded into another's leaves that one held", async () => {
    const dials: ReturnType<typeof scripted>[] = [];
    const sockets = createSessionSockets({
      connect: () => {
        const rpc = scripted();
        dials.push(rpc);
        return Promise.resolve(rpc);
      },
      tuning: { sleep: async () => {}, attempts: 2 },
    });
    try {
      const first = await sockets.lease(BOX, BOT, null, undefined);
      first.keep(STORED, "rt-1");
      first.release(first.rpc);
      // Turn A leases the hold and is still inside its resume when turn B,
      // naming a rotated id on the same runtime, registers a hold that folds
      // A's into it.
      const a = await sockets.lease(BOX, BOT, STORED, undefined);
      const b = await sockets.lease(BOX, BOT, null, undefined);
      b.keep(`${STORED}-c1`, "rt-1");
      a.keep(STORED, "rt-1");
      a.release(a.rpc);
      b.release(b.rpc);
      expect(sockets.peek(BOX, BOT, `${STORED}-c1`)?.runtime).toBe("rt-1");
      expect(dials[1]?.ended()).toBe(false);
      expect(dials[0]?.ended()).toBe(true);
      expect(sockets.peek(BOX, BOT, STORED)).toBeNull();
      expect(trackedSessionSockets()).toBe(1);
    } finally {
      sockets.dispose();
    }
  });

  test("a compaction re-keying onto a hold a turn is still reading closes it only on release", async () => {
    const dials: ReturnType<typeof scripted>[] = [];
    const sockets = createSessionSockets({
      connect: () => {
        const rpc = scripted();
        dials.push(rpc);
        return Promise.resolve(rpc);
      },
      tuning: { sleep: async () => {}, attempts: 2 },
    });
    try {
      const older = await sockets.lease(BOX, BOT, null, undefined);
      older.keep(STORED, "rt-1");
      older.release(older.rpc);
      // A turn already holds the new id, and is mid-read when the rekey lands.
      const reading = await sockets.lease(BOX, BOT, null, undefined);
      reading.keep(`${STORED}-c1`, "rt-2");
      expect(sockets.rekey(BOX, BOT, STORED, `${STORED}-c1`)).toBe(true);
      expect(dials[1]?.ended()).toBe(false);
      expect(sockets.peek(BOX, BOT, `${STORED}-c1`)?.runtime).toBe("rt-1");
      reading.release(reading.rpc);
      expect(dials[1]?.ended()).toBe(true);
      expect(dials[0]?.ended()).toBe(false);
    } finally {
      sockets.dispose();
    }
  });
});

describe("hermes-chat · dialling a socket that outlives its caller", () => {
  /** Every unhandled rejection while `body` runs and a few ticks after it. */
  async function unhandled(body: () => Promise<void>): Promise<unknown[]> {
    const seen: unknown[] = [];
    const probe = (reason: unknown): void => {
      seen.push(reason);
    };
    process.on("unhandledRejection", probe);
    try {
      await body();
      await sleep(10);
    } finally {
      process.off("unhandledRejection", probe);
    }
    return seen;
  }

  function deferred<T>() {
    let resolve: (value: T) => void = () => {};
    let reject: (reason: unknown) => void = () => {};
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  test("a socket that lands after the caller hung up is closed", async () => {
    const control = new AbortController();
    const late = deferred<{ close(): void }>();
    let closed = 0;
    // A transport that ignores its signal, so only the late close can end it.
    const pending = dialDetached(() => late.promise, control.signal);
    control.abort();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
    late.resolve({ close: () => (closed += 1) });
    await sleep(1);
    expect(closed).toBeGreaterThanOrEqual(1);
  });

  test("a dial that fails after the caller hung up is not an unhandled rejection", async () => {
    const seen = await unhandled(async () => {
      const control = new AbortController();
      const late = deferred<{ close(): void }>();
      const pending = dialDetached(() => late.promise, control.signal);
      control.abort();
      await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
      late.reject(new Error("refused"));
    });
    expect(seen).toEqual([]);
  });

  test("the socket that results is not closed by the caller's later abort", async () => {
    const control = new AbortController();
    let dialSignal: AbortSignal | null = null;
    const socket = await dialDetached((signal) => {
      dialSignal = signal;
      return Promise.resolve({ close: () => {} });
    }, control.signal);
    expect(socket).toBeDefined();
    control.abort();
    expect((dialSignal as AbortSignal | null)?.aborted).toBe(false);
  });

  test("an already-aborted wait does not leave the promise's rejection unhandled", async () => {
    const seen = await unhandled(async () => {
      const late = deferred<number>();
      await expect(untilAbort(late.promise, AbortSignal.abort())).rejects.toMatchObject({
        code: "ABORTED",
      });
      late.reject(new Error("late"));
    });
    expect(seen).toEqual([]);
  });
});
