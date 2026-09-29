/**
 * The chat observation seam: the frames `packages/app` pushes and the ones
 * `packages/ui` reads, asserted from both ends at once.
 *
 * Phase 7 was built as three halves — core's observation service, the server's
 * ownership and transports, the browser's store — and each was tested with the
 * other two doubled. That leaves the join untested, which is the failure mode
 * `seams.test.ts` exists for: two sides can be wrong in the same way and every
 * suite stays green. Four joins had no test at all.
 *
 *   envelope         `chat.subscribe`'s `{conversation, event}` → `chatStream`'s decode
 *   error vs error   the server's named `error` event → the transport's own
 *   ordering         `snapshot` before `message`, on a join and on a reconnect
 *   two transports   the fan-in and the per-conversation route, same message
 *
 * ## What this file does prove
 *
 * Both halves are real. The head side is the real `chat.subscribe` pump from
 * `handlers/chat.ts`, reached through the real `rpc/bind.ts`; the page side is
 * the real `transport-rpc.ts`, the real `chatStream` decoder from
 * `packages/ui/src/api/index.ts` and the real `useConversations` store from
 * `packages/ui/src/chat/chat-conversations.ts`. The wire between them is the
 * one `packages/ui/test/flows/bridge.ts` builds and for the same reason: a
 * built `.app` is what normally carries a push from the one to the other, and
 * outside one the two ends have to be handed each other. No frame in this file
 * is hand-written on both sides, so a change to either end breaks it.
 *
 * ## What it does not prove
 *
 * It is not a network test (§11.6 forbids one) and there is no Electrobun
 * channel: `send` calls the page's message handlers directly, so nothing here
 * says a push survives serialisation across a real webview boundary.
 *
 * `chat-state.tsx`'s wiring of `chatStream` into the store is three lines and is
 * restated here rather than imported; `packages/ui/test/chat-observe.dom.test.tsx`
 * owns that. And `chat.observe` — the per-conversation subscription — has no
 * consumer in the UI today, the fan-in being the one the page opens, so the
 * second-transport test drives it through `dispatch` and hands its frames to
 * the same reducer a second consumer would have to use.
 *
 * This file is at the root, so it may import server and ui together, which
 * neither package may do.
 */
import { act, cleanup, render, waitFor } from "../packages/ui/test/dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { createElement, useEffect } from "../packages/ui/test/react-bridge.ts";

import type { Bot, ChatObserveEvent, Hermetic, Swarm } from "../packages/core/src/index.ts";
import {
  createChatOwner,
  type ChatOwner,
  type OwnedChatEvent,
} from "../packages/app/src/chat-owner.ts";
import type { HandlerContext } from "../packages/app/src/handlers/ctx.ts";
import { dispatch } from "../packages/app/src/handlers/dispatch.ts";
import {
  createStreamRegistry,
  KEEPALIVE_EVENT,
  type StreamFrame,
} from "../packages/app/src/handlers/streams.ts";
import { memoryLog } from "../packages/app/src/log.ts";
import { OpRegistry } from "../packages/app/src/ops.ts";
import { createRpcBinding, type RpcOptions, type SendMessage } from "../packages/app/src/rpc/bind.ts";
import { REQUEST_NAMES } from "../packages/app/src/rpc/schema.ts";
import { AppState, fixedInstance } from "../packages/app/src/state.ts";
import { chatStream } from "../packages/ui/src/api/index.ts";
import { installedTransport, setTransport } from "../packages/ui/src/api/transport.ts";
import {
  createRpcTransport,
  type ElectroviewLike,
  type RpcHandle,
  type RpcMessageHandlers,
} from "../packages/ui/src/api/transport-rpc.ts";
import { electrobunRequest } from "../packages/ui/test/electrobun-request.ts";
import { clearPageVisible } from "../packages/ui/src/lib/visibility.ts";
import type { ChatConversationView, ChatObserveView } from "../packages/ui/src/api/index.ts";
import { useConversations } from "../packages/ui/src/chat/chat-conversations.ts";
import type { ChatApi } from "../packages/ui/src/chat/chat-state.tsx";

const ROOT = new URL("..", import.meta.url).pathname;
const INSTANCE = "atlas";
const BOT = "default";

/* ── the core double ──────────────────────────────────────────────────────── */

/** One open `chat.observe` call, driven by the test. */
interface Channel {
  pending: ChatObserveEvent[];
  ended: boolean;
  wake: (() => void) | null;
}

function botRow(instance: string, name: string): Bot {
  return {
    instance,
    name,
    title: name,
    is_default: true,
    avatar_seed: `seam/${instance}/${name}`,
    unread: 0,
    needs_action: false,
    muted: false,
    warm: false,
  };
}

function swarmRow(instance: string, bots: string[]): Swarm {
  return {
    instance,
    reachable: true,
    bots: bots.map((name) => botRow(instance, name)),
    rooms: [],
    warm_slots: { used: 0, total: 3 },
    sections: [],
  };
}

/**
 * A `Hermetic` that is the three chat methods `chat-owner.ts` calls and nothing
 * else, with every observation drivable by name. Core's own guarantees are
 * core's tests; what this file needs is a hand on the events.
 */
function chatScript() {
  const channels: Channel[] = [];
  const chat = {
    listening: () => Promise.resolve({ instances: [INSTANCE] }),
    swarms: () => Promise.resolve({ swarms: [swarmRow(INSTANCE, [BOT])] }),
    observe: (
      _input: { instance: string; bot: string },
      opts: { signal?: AbortSignal } = {},
    ): AsyncIterable<ChatObserveEvent> => {
      const channel: Channel = { pending: [], ended: false, wake: null };
      channels.push(channel);
      const nudge = (): void => {
        const resume = channel.wake;
        channel.wake = null;
        resume?.();
      };
      return (async function* () {
        opts.signal?.addEventListener("abort", nudge, { once: true });
        try {
          for (;;) {
            while (channel.pending.length > 0) {
              const head = channel.pending.shift();
              if (head !== undefined) yield head;
            }
            if (channel.ended || opts.signal?.aborted === true) return;
            await new Promise<void>((resolve) => {
              channel.wake = resolve;
            });
          }
        } finally {
          opts.signal?.removeEventListener("abort", nudge);
        }
      })();
    },
  };
  return {
    hermetic: {
      chat,
      // §4.7: the head reads the instance's own target to bind the mutation guard.
      target: { account_id: "123456789012", region: "us-west-2", fleet_id: "fxtr0001" },
    } as unknown as Hermetic,
    push(event: ChatObserveEvent): void {
      for (const channel of channels) {
        channel.pending.push(event);
        const resume = channel.wake;
        channel.wake = null;
        resume?.();
      }
    },
  };
}

/* ── the events, built the way core builds them ───────────────────────────── */

const messageEvent = (id: string, text: string, role = "bot"): ChatObserveEvent => ({
  type: "message",
  instance: INSTANCE,
  bot: BOT,
  session: "s1",
  message: {
    id,
    session: "s1",
    role: role as "bot",
    at: "2026-09-18T12:00:00.000Z",
    blocks: [{ kind: "text", markdown: text }],
  },
});

const snapshotEvent = (ids: string[]): ChatObserveEvent => ({
  type: "snapshot",
  instance: INSTANCE,
  bot: BOT,
  session: "s1",
  messages: ids.map((id) => ({
    id,
    session: "s1",
    role: "bot" as const,
    at: "2026-09-18T12:00:00.000Z",
    blocks: [{ kind: "text", markdown: `recorded ${id}` }],
  })),
  at: "2026-09-18T12:00:00.000Z",
});

const reconnectEvent: ChatObserveEvent = {
  type: "reconnect",
  instance: INSTANCE,
  bot: BOT,
  attempt: 2,
  delay_ms: 2000,
  code: "CHAT_UNREACHABLE",
  message: "the box did not answer",
};

const errorEvent: ChatObserveEvent = {
  type: "error",
  instance: INSTANCE,
  bot: BOT,
  code: "CHAT_UNREACHABLE",
  message: "gave up after 5 attempts",
};

/* ── the head, real, behind the page's transport ──────────────────────────── */

const owners: ChatOwner[] = [];
const disposers: Array<() => void> = [];
const restorers: Array<() => void> = [];

/**
 * A `HandlerContext` over the scripted instance, with the page's transport
 * pointed at it through the two real halves of the bridge.
 *
 * The wire is `packages/ui/test/flows/bridge.ts`'s, and is rebuilt rather than
 * imported because that harness opens the *fixture backend* and this file needs
 * a hand on each observation event. What is not rebuilt is either end of the
 * translation: `rpc/bind.ts` turns a request name into `dispatch` and buffers a
 * streaming handler's frames until its `stream_id` is known, and
 * `transport-rpc.ts` turns the page's `Transport` verbs back into those names.
 * Re-implementing either would put a second copy of the part with the race in
 * it next to the one that ships.
 */
function realHead(options: { chatOwner?: ChatOwner } = {}) {
  const script = chatScript();
  const log = memoryLog();
  const owner = options.chatOwner ?? createChatOwner({ hermetic: () => script.hermetic, log });
  if (options.chatOwner === undefined) owners.push(owner);
  const state = new AppState({
    fixture: true,
    home: ":memory:",
    reopen: fixedInstance(script.hermetic),
    hermetic: script.hermetic,
    target: { account_id: "123456789012", region: "us-west-2", fleet_id: "fxtr0001" },
  });
  const ctx: HandlerContext = {
    state,
    hermetic: () => state.hermetic,
    ops: new OpRegistry(),
    poller: () => null,
    chatOwner: owner,
    fixture: true,
    opts: { fixture: true, log },
    log,
    streams: createStreamRegistry(),
  };

  /**
   * The app's pushes, and the page's handlers for them. Mutable and read at
   * push time because the two ends are built in order: the binding needs a
   * `send` before the transport exists to be sent to.
   */
  const messages: RpcMessageHandlers = {};
  const send: SendMessage = (name, payload) => {
    const handler = messages[name];
    (handler as ((p: typeof payload) => void) | undefined)?.(payload);
  };
  type RequestTable = Record<string, (params: never) => unknown>;
  const binding = createRpcBinding<RequestTable>({
    defineRPC: (rpcOptions: RpcOptions) => rpcOptions.handlers.requests,
    send,
    ctx,
  });
  const appRequests = binding.rpc as Record<string, (params: unknown) => Promise<unknown>>;

  const known = new Set<string>(REQUEST_NAMES);
  const handle = {
    request: electrobunRequest((name, params) =>
      known.has(name)
        ? (appRequests[name]?.(params) ?? Promise.reject(new Error(`no handler for ${name}`)))
        : Promise.reject(new Error(`no handler for ${name}`)),
    ),
  } as unknown as RpcHandle;
  const Electroview = class {
    constructor(readonly options: { rpc?: RpcHandle }) {}
    static defineRPC(defineOptions: {
      maxRequestTime?: number;
      handlers: { requests?: RequestTable; messages?: RpcMessageHandlers };
    }): RpcHandle {
      Object.assign(messages, defineOptions.handlers.messages ?? {});
      return handle;
    }
  } as unknown as ElectroviewLike;

  /**
   * The module singleton, put back exactly as it was found — never to `null`.
   *
   * `chatStream` reads `transport()` rather than taking one, so a real one has
   * to be installed for the decoder under test to be the real decoder. Bun runs
   * every file of a run in one process and `transport.ts` holds `current` in
   * module state, so clearing it here would leave the *next* file's DOM tests
   * with no transport at all — `packages/ui/test/setup.ts` installs a refusing
   * one once, at import, and nothing reinstalls it. The same rule
   * `test/fake-transport.ts` and `test/flows/bridge.ts` follow.
   */
  const priorTransport = installedTransport();
  setTransport(createRpcTransport({ Electroview }));
  restorers.push(() => {
    setTransport(priorTransport);
    binding.close();
    ctx.streams.closeAll();
  });

  return { script, owner, ctx, log };
}

/**
 * `chat.observe` driven straight through `dispatch`: the *other* transport of
 * the same events, with nothing of the page in the way.
 */
async function openObservation(ctx: HandlerContext) {
  const queue: StreamFrame[] = [];
  const { stream_id } = (await dispatch(
    ctx,
    "chat.observe",
    { instance: INSTANCE, bot: BOT },
    (frame) => {
      if (frame.event !== KEEPALIVE_EVENT) queue.push(frame);
    },
  )) as { stream_id: string };
  return {
    /** The next frame, or null on a deadline — never a hang. */
    async next(ms = 2000): Promise<StreamFrame | null> {
      const deadline = Date.now() + ms;
      for (;;) {
        const ready = queue.shift();
        if (ready !== undefined) return ready;
        if (Date.now() >= deadline) return null;
        await Bun.sleep(5);
      }
    },
    cancel(): void {
      ctx.streams.close(stream_id);
    },
  };
}

/**
 * No test may leave a read loop, a subscription or a retry timer armed — and
 * nothing it installed at module scope may outlive it either.
 *
 * `createRpcTransport` seeds `setPageVisible(true)` as it is built (the app's
 * webview reports `hidden` for the life of the window, so the head's answer is
 * the only true one there). That answer is module state in
 * `packages/ui/src/lib/visibility.ts` and outlives this file otherwise, which
 * would tell the next file's gated readers the page is visible when its own
 * `document` says otherwise. `afterEach(clearPageVisible)` is what
 * `packages/ui/test/transport-rpc.test.ts` does for the same reason.
 */
afterEach(async () => {
  cleanup();
  while (disposers.length > 0) disposers.pop()?.();
  while (restorers.length > 0) restorers.pop()?.();
  clearPageVisible();
  while (owners.length > 0) await owners.pop()?.stop();
});

/** Long enough for an abort or a hand-off to reach a read loop; never a wait for work. */
const settle = (ms = 25): Promise<void> => Bun.sleep(ms);

/* ── seam 1: the envelope ─────────────────────────────────────────────────── */

describe("seam: the envelope the fan-in writes is the one the UI reads", () => {
  test("every event name round-trips with its conversation and its payload intact", async () => {
    const { script, owner } = realHead();
    await owner.sync();

    const seen: Array<{ conversation: ChatConversationView; event: ChatObserveView }> = [];
    let connected: boolean | null = null;
    disposers.push(
      chatStream({
        onFrame: (conversation, event) => seen.push({ conversation, event }),
        onDropped: () => undefined,
        onConnected: (ok) => {
          connected = ok;
        },
      }),
    );
    await waitFor(() => expect(connected).toBe(true));

    const sent: ChatObserveEvent[] = [
      snapshotEvent(["m1"]),
      messageEvent("m2", "from the box"),
      reconnectEvent,
      errorEvent,
    ];
    for (const event of sent) script.push(event);

    await waitFor(() => expect(seen.length).toBe(sent.length), { timeout: 3000 });

    // The names on the wire are the events' own `type`, which is what lets a
    // reader route one without parsing every payload.
    expect(seen.map((f) => f.event.type)).toEqual(["snapshot", "message", "reconnect", "error"]);
    // Every frame carries the conversation it belongs to, which is the whole
    // reason the fan-in can be one subscription for a dozen bots.
    for (const frame of seen) {
      expect(frame.conversation).toEqual({ instance: INSTANCE, bot: BOT, session: null });
    }
    // And the payload is the event core emitted, field for field.
    expect(seen.map((f) => f.event)).toEqual(sent as unknown as ChatObserveView[]);
  });

  test("`dropped` is its own frame, carrying the size of the gap and no conversation", async () => {
    // The real pump, driven past its own bound. `CHAT_STREAM_MAX_QUEUED` is
    // only reachable with a producer faster than the writer, so the listener is
    // called synchronously — which is what a burst on a stalled reader is.
    // A holder rather than a `let`: the listener is captured inside a callback,
    // and a plain binding narrows to its initializer for the rest of the test.
    const sink: { emit: ((event: OwnedChatEvent) => void) | null } = { emit: null };
    const owner: ChatOwner = {
      sync: () => Promise.resolve(),
      owned: () => [],
      observing: () => [],
      join: () => (async function* () {})(),
      resume: (target) =>
        Promise.resolve({
          instance: target.instance,
          bot: target.bot,
          session: target.session ?? null,
          observing: false,
          restarted: false,
          listening: false,
        }),
      subscribe(listener: (event: OwnedChatEvent) => void) {
        sink.emit = listener;
        return () => {
          sink.emit = null;
        };
      },
      snapshots: () => [],
      reset: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    };
    realHead({ chatOwner: owner });

    const gaps: number[] = [];
    const frames: string[] = [];
    disposers.push(
      chatStream({
        onFrame: (_conversation, event) => frames.push(event.type),
        onDropped: (count) => gaps.push(count),
        onConnected: () => undefined,
      }),
    );
    await waitFor(() => expect(sink.emit).not.toBe(null));

    const overflow = 1100;
    for (let i = 0; i < overflow; i++) {
      sink.emit?.({
        conversation: { instance: INSTANCE, bot: BOT, session: null },
        event: messageEvent(`burst-${i}`, "burst"),
      });
    }

    await waitFor(() => expect(gaps.length).toBeGreaterThan(0), { timeout: 3000 });
    // Announced rather than hidden, and announced *before* the frames that
    // survived — a consumer told about a gap re-reads, and re-reading before
    // the gap is reported would leave it holding the gap.
    expect(gaps[0]).toBe(100);
    expect(frames.length).toBeLessThan(overflow);
  });
});

/* ── seam 2: two events called `error` ────────────────────────────────────── */

describe("seam: the head's `error` event is not the transport's", () => {
  test("a conversation's terminal error is delivered as a frame, and the feed lives", async () => {
    const { script, owner } = realHead();
    await owner.sync();

    const seen: ChatObserveView[] = [];
    const connections: boolean[] = [];
    disposers.push(
      chatStream({
        onFrame: (_conversation, event) => seen.push(event),
        onDropped: () => undefined,
        onConnected: (ok) => connections.push(ok),
      }),
    );
    await waitFor(() => expect(connections).toEqual([true]));

    script.push(errorEvent);
    await waitFor(() => expect(seen.length).toBe(1), { timeout: 3000 });

    expect(seen[0]).toEqual(errorEvent as unknown as ChatObserveView);
    // Not a disconnect: the observation ended, the feed did not.
    expect(connections).toEqual([true]);
  });
});

/* ── seam 3: snapshot before message ──────────────────────────────────────── */

describe("seam: a reader is handed the snapshot before the live messages", () => {
  test("the fan-in replays the held snapshot to a reader that connects late", async () => {
    const { script, owner } = realHead();
    await owner.sync();

    // The head has been watching for a while and holds a transcript.
    script.push(snapshotEvent(["m1"]));
    await settle();

    const order: Array<{ type: string; id: string | null }> = [];
    disposers.push(
      chatStream({
        onFrame: (_conversation, event) => {
          order.push({
            type: event.type,
            id: event.type === "message" ? event.message.id : null,
          });
        },
        onDropped: () => undefined,
        onConnected: () => undefined,
      }),
    );

    await waitFor(() => expect(order.length).toBe(1), { timeout: 3000 });
    script.push(messageEvent("m2", "after the snapshot"));
    await waitFor(() => expect(order.length).toBe(2), { timeout: 3000 });

    expect(order).toEqual([
      { type: "snapshot", id: null },
      { type: "message", id: "m2" },
    ]);
  });

  test("the per-conversation subscription replays it too, to a second reader", async () => {
    const { script, owner, ctx } = realHead();
    await owner.sync();
    script.push(snapshotEvent(["m1"]));
    await settle();

    const reader = await openObservation(ctx);
    const first = await reader.next();
    expect(first?.event).toBe("snapshot");

    script.push(messageEvent("m2", "after the snapshot"));
    const second = await reader.next();
    expect(second?.event).toBe("message");
    expect(second?.data).toEqual(messageEvent("m2", "after the snapshot"));
    reader.cancel();
  });

  /**
   * The ordering above is a property of an *absence*: both transports attach
   * their listener and read the held snapshot inside one synchronous run, so
   * nothing can be emitted between the two. A single `await` inserted into
   * either attach opens the window, loses whatever arrives in it, and breaks no
   * behavioural test — the window is too small for one to aim at. So it is
   * asserted against the source, the way `ci-contract.test.ts` asserts the
   * shape of a workflow. The argument in full is on `Subscription.snapshot` in
   * core's `observe-pool.ts`, which is where the head's `join` now lives.
   */
  test("neither attach has grown a suspension point between listener and snapshot", async () => {
    const between = (source: string, from: RegExp, to: RegExp): string => {
      const start = source.search(from);
      expect(start).toBeGreaterThan(-1);
      const rest = source.slice(start);
      const end = rest.search(to);
      expect(end).toBeGreaterThan(-1);
      return rest.slice(0, end);
    };

    // `chat.subscribe` in the handlers, which is where the fan-in's pump lives
    // now that there is no second head to share it with.
    const fanIn = await Bun.file(`${ROOT}packages/app/src/handlers/chat.ts`).text();
    const gap = between(fanIn, /owner\.subscribe\(/, /owner\.snapshots\(\)/);
    expect(gap).not.toMatch(/\bawait\b/);

    const ownerSource = await Bun.file(`${ROOT}packages/core/src/chat/observe-pool.ts`).text();
    const join = between(ownerSource, /sub\.listeners\.add\(listener\)/, /yield sub\.snapshot/);
    expect(join).not.toMatch(/\bawait\b/);
    // And the subscription records the read before it announces it, so the two
    // can never name different transcripts.
    const run = between(ownerSource, /sub\.snapshot = event/, /emit\(sub, event\)/);
    expect(run).not.toMatch(/\bawait\b/);
  });
});

/* ── seam 4: one message, two transports ──────────────────────────────────── */

/** The store, mounted the way `chat-state.tsx` mounts it, with nothing else attached. */
function mountStore(api: ChatApi) {
  const held: { store: ReturnType<typeof useConversations> | null } = { store: null };
  function Probe(): null {
    const store = useConversations(
      api,
      () => Promise.resolve(),
      () => null,
    );
    held.store = store;
    const { observe, observeDropped, observeTransport } = store;
    useEffect(
      () =>
        chatStream({
          onFrame: observe,
          onDropped: observeDropped,
          onConnected: observeTransport,
        }),
      [observe, observeDropped, observeTransport],
    );
    return null;
  }
  render(createElement(Probe));
  return held;
}

function emptyApi(): ChatApi {
  return {
    fetchSwarms: () => Promise.resolve({ swarms: [] } as never),
    fetchSessions: (instance: string, bot: string) =>
      Promise.resolve({ instance, bot, sessions: [] } as never),
    fetchHistory: (instance: string, bot: string) =>
      Promise.resolve({ instance, bot, session: "s1", messages: [] } as never),
    sendTurn: () => () => undefined,
    abortTurn: (instance: string, bot: string) =>
      Promise.resolve({ instance, bot, aborted: true } as never),
  };
}

describe("seam: the same message over both transports renders once", () => {
  test("the fan-in's copy and the per-conversation copy are one row", async () => {
    const { script, owner, ctx } = realHead();
    await owner.sync();

    const held = mountStore(emptyApi());
    await act(async () => {
      held.store?.select(INSTANCE, BOT);
    });
    await waitFor(() => expect(held.store?.historyRead).toBe(true));

    // One reader on each transport, both watching the same conversation. The
    // head holds one subscription and hands the events to both: it does not
    // deduplicate across transports, and is not the right place to.
    const direct = await openObservation(ctx);
    script.push(snapshotEvent([]));
    script.push(messageEvent("m9", "said once"));

    await waitFor(() => expect(held.store?.messages.length).toBe(1), { timeout: 3000 });

    // Now the *same* message, off the other transport's real frames, routed to
    // the same reducer a second consumer would have to route it to.
    let fromDirect: ChatObserveView | null = null;
    for (let i = 0; i < 4 && fromDirect === null; i++) {
      const frame = await direct.next();
      if (frame?.event === "message") fromDirect = frame.data as ChatObserveView;
    }
    expect(fromDirect).not.toBe(null);

    const conversation: ChatConversationView = { instance: INSTANCE, bot: BOT, session: null };
    await act(async () => {
      if (fromDirect) held.store?.observe(conversation, fromDirect);
    });

    expect(held.store?.messages.map((m) => m.id)).toEqual(["m9"]);
    direct.cancel();
  });
});

/* ── §8.3: what the head writes down about a failure ──────────────────────── */

/**
 * The app log is a file on the laptop, so §8.3 — "secrets never logged, echoed,
 * or written to disk on the laptop" — covers it. This is a seam because the
 * text in question is produced in one package and written to disk by another:
 * core redacts what it emits (`chat-observe.ts`), and the head redacts again on
 * the way into the log, because an adapter path core's door did not cover must
 * not be the one that reaches `app.log`.
 *
 * The event here is pushed past core's redaction on purpose — a core double
 * emits it raw — which is exactly the case the head's own masking exists for.
 */
describe("seam: an observation failure reaches the app log masked", () => {
  const SECRET = "sk-ant-FIXTUREANTHROPICKEY";

  test("a secret in a terminal error event is not what lands in the log", async () => {
    const { script, owner, log } = realHead();
    await owner.sync();

    script.push({
      type: "error",
      instance: INSTANCE,
      bot: BOT,
      code: "CHAT_UNREACHABLE",
      message: `the gateway refused ${SECRET}`,
    });
    await waitFor(() => expect(log.lines.some((l) => l.includes("observation failed"))).toBe(true));

    const said = log.lines.filter((l) => l.includes("observation failed")).join("\n");
    expect(said).not.toContain(SECRET);
    expect(said).toContain("[redacted]");
    // The code survives, because it is what an operator acts on.
    expect(said).toContain("CHAT_UNREACHABLE");
    // And nothing in the log carries the secret under any other line either.
    expect(log.lines.join("\n")).not.toContain(SECRET);
  });
});
