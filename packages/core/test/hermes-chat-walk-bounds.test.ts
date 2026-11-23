/**
 * Every paged walk on the transcript read ends, whatever the box answers: in
 * the transcript, or in a typed `CHAT_PROTOCOL`, never a spin. The read also
 * runs in the desktop app and on the phone, where a spin is a frozen UI.
 */
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { createChatConnection } from "../src/chat/hermes/hermes-chat-connect.ts";
import { createChatHistory } from "../src/chat/hermes/hermes-chat-history.ts";
import { createMovedBotChats } from "../src/chat/hermes/hermes-chat-moved.ts";
import type { BoxAddress, ChatFetch, ChatSocket } from "../src/chat/hermes/hermes-chat-types.ts";

const BOX: BoxAddress = { instance: "atlas", baseUrl: "https://atlas.example.ts.net/" };
const PAGE = `<script>window.__HERMES_SESSION_TOKEN__ = "FIXTURE-token";</script>`;
const json = (body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
  );

/** A history reader over `messages(session, offset)`, counting reads per session. */
function reader(
  messages: (session: string, offset: number) => unknown,
  previousRoots: readonly string[] = [],
) {
  const reads = new Map<string, number>();
  const fetch: ChatFetch = (input) => {
    const url = new URL(String(input));
    const m = /^\/api\/sessions\/([^/]+)\/messages$/.exec(url.pathname);
    if (!m) return Promise.resolve(new Response(PAGE, { headers: { "content-type": "text/html" } }));
    const session = decodeURIComponent(m[1] ?? "");
    reads.set(session, (reads.get(session) ?? 0) + 1);
    return json(messages(session, Number(url.searchParams.get("offset"))));
  };
  const history = createChatHistory({
    connection: createChatConnection({
      fetch,
      openSocket: (): ChatSocket => {
        throw new Error("no socket in this file");
      },
      waitMs: 1000,
    }),
    conversation: () => Promise.resolve(null),
    previousRoots: () => previousRoots,
  });
  return { history: history.history, reads };
}

describe("the paged history read", () => {
  test("a cursor that does not advance, over rows with no id that a turn keeps rewriting, is capped", async () => {
    let n = 0;
    // A full page every time, never the same twice, so the repeat guard cannot see it.
    const { history, reads } = reader(() => ({
      messages: Array.from({ length: 500 }, () => ({ role: "user", content: `row ${n++}` })),
    }));
    await expect(history(BOX, "default", { session: "s1" })).rejects.toMatchObject({
      code: "CHAT_PROTOCOL",
      message: "atlas: history ran past 200 pages of 500",
    });
    expect(reads.get("s1")).toBe(200);
  });

  test("pages that cycle back to one already read are refused", async () => {
    const page = (start: number) =>
      Array.from({ length: 500 }, (_, i) => ({ id: start + i, role: "user", content: "x" }));
    // Offsets 0, 500, 1000 answer A, B, A.
    const { history, reads } = reader((_, offset) => ({
      messages: page(offset === 500 ? 501 : 1),
    }));
    await expect(history(BOX, "default", { session: "s1" })).rejects.toMatchObject({
      code: "CHAT_PROTOCOL",
      message: "atlas: history repeated a page",
    });
    expect(reads.get("s1")).toBe(3);
  });
});

describe("the moved-aside roots read ahead of the current Bot Chat", () => {
  const rows = (session: string) => ({
    session_id: session,
    messages: [{ id: 1, role: "user", content: `in ${session}`, timestamp: 1 }],
  });

  test("a previous root naming the current session, or listed twice, is read once", async () => {
    const { history, reads } = reader(rows, ["root-a", "s1", "root-a"]);
    const messages = await history(BOX, "default", { session: "s1" });
    expect(messages.map((m) => m.session)).toEqual(["root-a", "s1"]);
    expect(Object.fromEntries(reads)).toEqual({ s1: 1, "root-a": 1 });
  });

  test("a previous root the box resolves to the current session adds nothing", async () => {
    const { history } = reader((session) => rows(session === "root-b" ? "s1" : session), ["root-b"]);
    const messages = await history(BOX, "default", { session: "s1" });
    expect(messages.map((m) => m.session)).toEqual(["s1"]);
  });
});

describe("the walk for moved-aside Bot Chats", () => {
  const sessions = (from: number, count: number) => ({
    sessions: Array.from({ length: count }, (_, i) => ({ id: `t${from + i}`, title: "a thread" })),
  });
  const noTitles = () => Promise.resolve({ sessions: [] });

  test("a list that never runs out of new sessions is capped", async () => {
    let gets = 0;
    const moved = createMovedBotChats({
      get: (_, path) => {
        gets += 1;
        return Promise.resolve(
          sessions(Number(new URLSearchParams(path.split("?")[1]).get("offset")), 100),
        );
      },
    });
    await expect(moved.moved(noTitles, BOX, "default", "local-x")).rejects.toMatchObject({
      code: "CHAT_PROTOCOL",
      message: "atlas: session list ran past 20000 sessions looking for moved-aside Bot Chats",
    });
    expect(gets).toBe(200);
  });

  test("a list that ignores the offset ends on the first page with nothing new", async () => {
    let gets = 0;
    const moved = createMovedBotChats({
      get: () => {
        gets += 1;
        return Promise.resolve(sessions(0, 100));
      },
    });
    expect(await moved.moved(noTitles, BOX, "default", "local-x")).toEqual([]);
    expect(gets).toBe(2);
  });

  test("a caller that cannot see the holder reuses the walk made under it", async () => {
    let gets = 0;
    const moved = createMovedBotChats({
      get: () => {
        gets += 1;
        return Promise.resolve(sessions(0, 3));
      },
    });
    await moved.moved(noTitles, BOX, "default", "local-x");
    // The session list's polls, whose window lost the holder.
    for (let i = 0; i < 3; i += 1) await moved.moved(noTitles, BOX, "default", "");
    expect(gets).toBe(1);
    await moved.moved(noTitles, BOX, "default", "local-y");
    expect(gets).toBe(2);
  });

  describe("a walk that fails", () => {
    afterEach(() => setSystemTime());
    const failing = () => {
      const calls = { gets: 0 };
      const moved = createMovedBotChats({
        get: () => {
          calls.gets += 1;
          return Promise.reject(new Error("atlas: dashboard answered HTTP 503"));
        },
      });
      return { moved: moved.moved, calls };
    };

    test("is answered from memory for a minute, then walked again", async () => {
      setSystemTime(new Date("2026-11-16T00:00:00Z"));
      const { moved, calls } = failing();
      for (let i = 0; i < 3; i += 1)
        await expect(moved(noTitles, BOX, "default", "local-x")).rejects.toThrow("HTTP 503");
      expect(calls.gets).toBe(1);
      setSystemTime(new Date("2026-11-16T00:01:01Z"));
      await expect(moved(noTitles, BOX, "default", "")).rejects.toThrow("HTTP 503");
      expect(calls.gets).toBe(2);
    });

    test("is not remembered when the caller aborted it", async () => {
      const { moved, calls } = failing();
      const signal = AbortSignal.abort();
      await expect(moved(noTitles, BOX, "default", "local-x", { signal })).rejects.toThrow();
      await expect(moved(noTitles, BOX, "default", "local-x")).rejects.toThrow("HTTP 503");
      expect(calls.gets).toBe(2);
    });
  });
});
