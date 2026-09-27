/**
 * The pooled request socket Bot Mode's RPCs share (`hermes-chat-pool.ts`).
 *
 * Driven through the real `createChatConnection`, not a stub of it, because
 * half of what is asserted here is *its* behaviour seen from the other side:
 * that a dial which fails re-scrapes the token exactly once, and that nothing
 * the pool does turns one refused connection into two.
 *
 * The socket double below never answers on its own. Every reply is pushed by
 * the test, which is the only way to hold two requests open on one socket at
 * once and then settle them in the wrong order — the case a naive
 * "one socket, one request" pool gets wrong and a per-RPC socket could never
 * reach at all.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createChatConnection } from "../src/chat/hermes/hermes-chat-connect.ts";
import {
  createRequestPool,
  disposeChatRequestPools,
  trackedChatRequestPools,
} from "../src/chat/hermes/hermes-chat-pool.ts";
import type { BoxAddress, ChatFetch, ChatSocket } from "../src/chat/hermes/hermes-chat-types.ts";

/**
 * The pool registry is process-wide (`disposeChatRequestPools`), so a pool this
 * file leaves holding an idle socket would still be in it when the next case
 * counts. Every test starts from an empty one.
 */
afterEach(disposeChatRequestPools);

const box = (instance: string): BoxAddress => ({
  instance,
  baseUrl: `https://${instance}.example.ts.net/`,
});

const ATLAS = box("atlas");
const CORVID = box("corvid");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A one-producer queue, the same shape `chat.ts`'s runtime socket uses. */
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
    push(v) {
      buffer.push(v);
      nudge();
    },
    close() {
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

interface Fake extends ChatSocket {
  url: string;
  sent: { id: number; method: string }[];
  /** Answer one of the documents this socket was sent. */
  reply(id: number, result: unknown): void;
  /** An unsolicited broadcast, which a request-only socket has nobody for. */
  event(payload: Record<string, unknown>): void;
  /** The box hanging up, as a restart looks from here. */
  end(): void;
  closed: boolean;
  unrefs: number;
}

interface Harness {
  sockets: Fake[];
  /** How many times the dashboard HTML was scraped for a token. */
  scrapes(): number;
  /** Refuse the next `n` socket opens, which is what a dead token looks like. */
  refuse(n: number): void;
  pool: ReturnType<typeof createRequestPool>;
}

function harness(opts: { idleMs?: number; waitMs?: number } = {}): Harness {
  const sockets: Fake[] = [];
  let scrapes = 0;
  let refusals = 0;

  const fetchImpl: ChatFetch = () => {
    scrapes += 1;
    return Promise.resolve(
      new Response(`<script>window.__HERMES_SESSION_TOKEN__="tok-${scrapes}"</script>`, {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
  };

  const openSocket = (url: string): ChatSocket => {
    const q = queue<string>();
    const refuse = refusals > 0;
    if (refuse) refusals -= 1;
    const socket: Fake = {
      url,
      sent: [],
      closed: false,
      unrefs: 0,
      opened: refuse ? Promise.reject(new Error(`chat socket failed: ${url}`)) : Promise.resolve(),
      frames: q.drain(),
      send(data: string) {
        const doc = JSON.parse(data) as { id: number; method: string };
        socket.sent.push({ id: doc.id, method: doc.method });
      },
      reply(id: number, result: unknown) {
        q.push(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
      },
      event(payload: Record<string, unknown>) {
        q.push(`${JSON.stringify({ jsonrpc: "2.0", method: "event", params: payload })}\n`);
      },
      end() {
        socket.closed = true;
        q.close();
      },
      unref() {
        socket.unrefs += 1;
      },
      close() {
        socket.closed = true;
        q.close();
      },
    };
    sockets.push(socket);
    return socket;
  };

  const connection = createChatConnection({
    fetch: fetchImpl,
    openSocket,
    waitMs: opts.waitMs ?? 1_000,
  });
  const pool = createRequestPool({
    connect: connection.connect,
    idleMs: opts.idleMs ?? 10_000,
  });
  return {
    sockets,
    scrapes: () => scrapes,
    refuse: (n: number) => {
      refusals = n;
    },
    pool,
  };
}

/** Wait until the pool has dialled at least `n` sockets and sent `sent` documents. */
async function settle(h: Harness, sockets: number, sent: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const live = h.sockets[sockets - 1];
    if (live && live.sent.length >= sent) return;
    await sleep(1);
  }
  throw new Error(
    `timed out: ${h.sockets.length} sockets, ${h.sockets[sockets - 1]?.sent.length ?? 0} sent`,
  );
}

describe("pooled Bot Mode requests", () => {
  test("sequential calls reuse one dial and one token scrape", async () => {
    const h = harness();
    const first = h.pool.request(ATLAS, "profiles.list", {});
    await settle(h, 1, 1);
    h.sockets[0]?.reply(1, { profiles: [] });
    expect(await first).toEqual({ profiles: [] });

    const second = h.pool.request(ATLAS, "groups.capabilities", {});
    await settle(h, 1, 2);
    h.sockets[0]?.reply(2, { protocol_version: 2 });
    expect(await second).toEqual({ protocol_version: 2 });

    expect(h.sockets).toHaveLength(1);
    expect(h.scrapes()).toBe(1);
    expect(h.sockets[0]?.closed).toBe(false);
    // Belt and braces: a pooled socket is asked to stop holding the loop open.
    expect(h.sockets[0]?.unrefs).toBe(1);
  });

  test("concurrent calls share one socket and replies find their own caller", async () => {
    const h = harness();
    const a = h.pool.request(ATLAS, "profiles.list", {});
    const b = h.pool.request(ATLAS, "groups.capabilities", {});
    await settle(h, 1, 2);
    expect(h.sockets).toHaveLength(1);
    const sent = h.sockets[0]?.sent ?? [];
    expect(sent.map((d) => d.method)).toEqual(["profiles.list", "groups.capabilities"]);

    // Reversed on purpose: the box answers in whatever order it finishes.
    h.sockets[0]?.reply(sent[1]?.id ?? 0, { which: "groups" });
    h.sockets[0]?.reply(sent[0]?.id ?? 0, { which: "profiles" });
    expect(await a).toEqual({ which: "profiles" });
    expect(await b).toEqual({ which: "groups" });
  });

  test("one caller's abort leaves its peers alive and drops the late reply", async () => {
    const h = harness();
    const stop = new AbortController();
    const doomed = h.pool.request(ATLAS, "profiles.list", {}, { signal: stop.signal });
    const peer = h.pool.request(ATLAS, "groups.capabilities", {});
    await settle(h, 1, 2);
    // By method, not by position: a request carrying a signal takes an extra
    // microtask to reach the wire, so the send order is not the call order.
    const idOf = (method: string): number =>
      h.sockets[0]?.sent.find((d) => d.method === method)?.id ?? 0;

    stop.abort();
    await expect(doomed).rejects.toMatchObject({ code: "ABORTED" });
    // The socket is shared: one caller hanging up must not take it down.
    expect(h.sockets[0]?.closed).toBe(false);
    expect(h.sockets).toHaveLength(1);

    // The reply the abandoned request would have had, arriving anyway.
    h.sockets[0]?.reply(idOf("profiles.list"), { which: "profiles" });
    h.sockets[0]?.reply(idOf("groups.capabilities"), { which: "groups" });
    expect(await peer).toEqual({ which: "groups" });

    // And the socket still works afterwards — the late reply settled nothing.
    const after = h.pool.request(ATLAS, "session.list", {});
    await settle(h, 1, 3);
    h.sockets[0]?.reply(h.sockets[0]?.sent[2]?.id ?? 0, { ok: true });
    expect(await after).toEqual({ ok: true });
    expect(h.sockets).toHaveLength(1);
  });

  test("a closed socket rejects pending once, and the next call redials with a fresh token", async () => {
    const h = harness();
    const first = h.pool.request(ATLAS, "profiles.list", {});
    await settle(h, 1, 1);
    h.sockets[0]?.reply(1, {});
    await first;

    const orphan = h.pool.request(ATLAS, "groups.capabilities", {});
    await settle(h, 1, 2);
    // The box restarts: the socket ends with a document in flight.
    h.sockets[0]?.end();
    await expect(orphan).rejects.toMatchObject({ code: "CHAT_PROTOCOL" });
    // Not replayed: the dead socket carried that document exactly once and the
    // pool never re-sent it anywhere.
    expect(h.sockets[0]?.sent).toHaveLength(2);
    expect(h.sockets).toHaveLength(1);

    // The remembered token died with the dashboard, so the redial is refused
    // once and `connect` re-scrapes — exactly once, not once per request.
    h.refuse(1);
    const next = h.pool.request(ATLAS, "session.list", {});
    await settle(h, 3, 1);
    expect(h.sockets[2]?.sent.map((d) => d.method)).toEqual(["session.list"]);
    h.sockets[2]?.reply(h.sockets[2]?.sent[0]?.id ?? 0, { sessions: [] });
    expect(await next).toEqual({ sessions: [] });
    expect(h.scrapes()).toBe(2);
  });

  test("an idle socket closes after the TTL and an active one does not", async () => {
    const h = harness({ idleMs: 25 });
    const held = h.pool.request(ATLAS, "profiles.list", {});
    await settle(h, 1, 1);
    // Long enough that an idle socket would have gone, while this one is leased.
    await sleep(60);
    expect(h.sockets[0]?.closed).toBe(false);
    expect(h.pool.size()).toBe(1);
    h.sockets[0]?.reply(1, {});
    await held;

    await sleep(60);
    expect(h.sockets[0]?.closed).toBe(true);
    expect(h.pool.size()).toBe(0);

    // And the next call is a real dial, not a replay of the closed one.
    const again = h.pool.request(ATLAS, "session.list", {});
    await settle(h, 2, 1);
    h.sockets[1]?.reply(h.sockets[1]?.sent[0]?.id ?? 0, { ok: true });
    expect(await again).toEqual({ ok: true });
  });

  test("two instances get two sockets", async () => {
    const h = harness();
    const a = h.pool.request(ATLAS, "profiles.list", {});
    const c = h.pool.request(CORVID, "profiles.list", {});
    await settle(h, 2, 1);
    expect(h.sockets).toHaveLength(2);
    expect(h.sockets[0]?.url).toContain("atlas");
    expect(h.sockets[1]?.url).toContain("corvid");
    h.sockets[0]?.reply(1, { at: "atlas" });
    h.sockets[1]?.reply(1, { at: "corvid" });
    expect(await a).toEqual({ at: "atlas" });
    expect(await c).toEqual({ at: "corvid" });
    expect(h.pool.size()).toBe(2);
  });

  test("dispose closes every socket the pool holds", async () => {
    const h = harness();
    const a = h.pool.request(ATLAS, "profiles.list", {});
    const c = h.pool.request(CORVID, "profiles.list", {});
    await settle(h, 2, 1);
    h.sockets[0]?.reply(1, {});
    h.sockets[1]?.reply(1, {});
    await Promise.all([a, c]);

    expect(trackedChatRequestPools()).toBe(1);
    h.pool.dispose();
    expect(h.sockets[0]?.closed).toBe(true);
    expect(h.sockets[1]?.closed).toBe(true);
    expect(h.pool.size()).toBe(0);
    // Unregistered too: a pool holding nothing must not be pinned by the
    // process-wide registry, or the portal would keep one per `reopen`.
    expect(trackedChatRequestPools()).toBe(0);
    // Idempotent, and the pool still works afterwards.
    h.pool.dispose();
    const after = h.pool.request(ATLAS, "session.list", {});
    await settle(h, 3, 1);
    h.sockets[2]?.reply(h.sockets[2]?.sent[0]?.id ?? 0, { ok: true });
    expect(await after).toEqual({ ok: true });
    // Re-registered by the dial that followed, so a later process-wide dispose
    // still reaches it.
    expect(trackedChatRequestPools()).toBe(1);
    disposeChatRequestPools();
    expect(trackedChatRequestPools()).toBe(0);
    expect(h.sockets[2]?.closed).toBe(true);
  });

  test("unsolicited events are discarded rather than buffered forever", async () => {
    const h = harness();
    const first = h.pool.request(ATLAS, "profiles.list", {});
    await settle(h, 1, 1);
    for (let i = 0; i < 500; i++) h.sockets[0]?.event({ type: "noise", i });
    h.sockets[0]?.reply(1, { ok: true });
    expect(await first).toEqual({ ok: true });
    // The flood changed nothing about the socket's usefulness.
    const second = h.pool.request(ATLAS, "session.list", {});
    await settle(h, 1, 2);
    h.sockets[0]?.reply(2, { still: "here" });
    expect(await second).toEqual({ still: "here" });
    expect(h.sockets).toHaveLength(1);
  });

  test("a dial that fails is not remembered", async () => {
    const h = harness();
    h.refuse(2);
    await expect(h.pool.request(ATLAS, "profiles.list", {})).rejects.toMatchObject({
      code: "CHAT_UNREACHABLE",
    });
    expect(h.pool.size()).toBe(0);
    const ok = h.pool.request(ATLAS, "profiles.list", {});
    await settle(h, 3, 1);
    h.sockets[2]?.reply(h.sockets[2]?.sent[0]?.id ?? 0, { ok: true });
    expect(await ok).toEqual({ ok: true });
  });
});
