/**
 * Every dashboard read on the chat path ends: a box whose dashboard accepts the
 * request and never answers is `CHAT_UNREACHABLE` after `REST_READ_MS`, never a
 * hang. Writes are not cut off, and the caller's own abort still wins.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { createChatConnection } from "../src/chat/hermes/hermes-chat-connect.ts";
import { createChatHistory } from "../src/chat/hermes/hermes-chat-history.ts";
import { createChatPeer } from "../src/chat/hermes/hermes-chat-peer.ts";
import type { BoxAddress, ChatFetch, ChatSocket } from "../src/chat/hermes/hermes-chat-types.ts";
import { REST_READ_MS } from "../src/chat/hermes/hermes-chat-wire.ts";

const BOX: BoxAddress = { instance: "atlas", baseUrl: "https://atlas.example.ts.net/" };
const PAGE = `<script>window.__HERMES_SESSION_TOKEN__ = "FIXTURE-token";</script>`;
const UNREACHABLE = {
  code: "CHAT_UNREACHABLE",
  message: `atlas: the dashboard did not answer within ${REST_READ_MS / 1000}s`,
};

/** Never settles, and ignores its signal, like a stuck connection. */
const never = () => new Promise<Response>(() => {});
const html = () => Promise.resolve(new Response(PAGE, { headers: { "content-type": "text/html" } }));

function connection(fetch: ChatFetch) {
  return createChatConnection({
    fetch,
    openSocket: (): ChatSocket => {
      throw new Error("no socket in this file");
    },
    waitMs: 1000,
  });
}

/** Settles `promise` into a record so a test can look without awaiting a hang. */
function track<T>(promise: Promise<T>) {
  const state: { done: boolean; error?: unknown } = { done: false };
  promise.then(
    () => {
      state.done = true;
    },
    (error: unknown) => {
      state.done = true;
      state.error = error;
    },
  );
  return state;
}

async function flush() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe("a dashboard read that never answers", () => {
  test("the transcript page ends in CHAT_UNREACHABLE", async () => {
    const fetch: ChatFetch = (input) =>
      new URL(String(input)).pathname.endsWith("/messages") ? never() : html();
    const history = createChatHistory({
      connection: connection(fetch),
      conversation: () => Promise.resolve(null),
    });
    const read = track(history.history(BOX, "default", { session: "s1" }));
    await flush();
    jest.advanceTimersByTime(REST_READ_MS - 1);
    await flush();
    expect(read.done).toBe(false);
    jest.advanceTimersByTime(1);
    await flush();
    expect(read.error).toMatchObject(UNREACHABLE);
  });

  test("the token scrape ends in CHAT_UNREACHABLE", async () => {
    const conn = connection(never);
    const read = track(conn.token(BOX, undefined));
    await flush();
    jest.advanceTimersByTime(REST_READ_MS);
    await flush();
    expect(read.error).toMatchObject(UNREACHABLE);
  });

  test("a Bot Mode GET ends in CHAT_UNREACHABLE; a write is left to finish", async () => {
    const peer = createChatPeer({
      connection: connection((input, init) =>
        new URL(String(input)).pathname.startsWith("/api/") || init?.method !== "GET"
          ? never()
          : html(),
      ),
    });
    const get = track(peer.botModeRest(BOX, "GET", "/api/sessions?limit=100"));
    const patch = track(peer.botModeRest(BOX, "PATCH", "/api/sessions/s1", { title: "x" }));
    await flush();
    jest.advanceTimersByTime(REST_READ_MS * 4);
    await flush();
    expect(get.error).toMatchObject(UNREACHABLE);
    expect(patch.done).toBe(false);
  });

  test("the caller's abort still ends it first, as an abort", async () => {
    const fetch: ChatFetch = (input, init) =>
      new URL(String(input)).pathname.endsWith("/messages")
        ? new Promise((_, reject) =>
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
          )
        : html();
    const history = createChatHistory({
      connection: connection(fetch),
      conversation: () => Promise.resolve(null),
    });
    const stop = new AbortController();
    const read = track(history.history(BOX, "default", { session: "s1", signal: stop.signal }));
    await flush();
    stop.abort();
    await flush();
    expect(read.error).toMatchObject({ code: "ABORTED" });
  });
});
