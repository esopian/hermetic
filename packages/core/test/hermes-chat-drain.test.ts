/**
 * Two costs of the paged history read that an observation pays on every
 * reconcile: an error response must release its body rather than hold its
 * connection until garbage collection, and the repeated-page guard must not
 * serialise every row of every page to tell one page from another.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHermesChat, disposeChatRequestPools } from "../src/chat/hermes/hermes-chat.ts";
import { pageKey } from "../src/chat/hermes/hermes-chat-history.ts";
import type { BoxAddress, ChatFetch, ChatSocket } from "../src/chat/hermes/hermes-chat-types.ts";

afterEach(() => disposeChatRequestPools());

const BOX: BoxAddress = { instance: "atlas", baseUrl: "https://atlas.example.ts.net/" };
const PAGE = `<script>window.__HERMES_SESSION_TOKEN__ = "FIXTURE-token";</script>`;

/** A response whose body records whether it was cancelled. */
function tracked(status: number, body: string, type = "application/json") {
  let cancelled = false;
  const encoded = new TextEncoder().encode(body);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(stream, { status, headers: { "content-type": type } }),
    cancelled: () => cancelled,
  };
}

function adapter(fetchImpl: ChatFetch) {
  return createHermesChat({
    fetch: fetchImpl,
    openSocket: (): ChatSocket => {
      throw new Error("no socket in this file");
    },
    now: () => "2026-10-17T09:00:00.000Z",
  });
}

describe("error bodies are released", () => {
  test("a history read answered with a 500 cancels the body before throwing", async () => {
    const failed = tracked(500, `{"detail":"boom"}`);
    const chat = adapter((input) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/api/sessions/")) return Promise.resolve(failed.response);
      return Promise.resolve(new Response(PAGE, { headers: { "content-type": "text/html" } }));
    });
    await expect(chat.history(BOX, "default", { session: "s1", limit: 10 })).rejects.toMatchObject({
      code: "CHAT_PROTOCOL",
    });
    expect(failed.cancelled()).toBe(true);
  });

  test("a 401 retried with a fresh token cancels the refused body", async () => {
    const refused = tracked(401, `{"detail":"stale"}`);
    let reads = 0;
    const chat = adapter((input) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/api/sessions/")) {
        reads += 1;
        if (reads === 2) return Promise.resolve(refused.response);
        return Promise.resolve(
          new Response(JSON.stringify({ messages: [] }), {
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(new Response(PAGE, { headers: { "content-type": "text/html" } }));
    });
    // The first read caches the token, so the second read's 401 is retried.
    await chat.history(BOX, "default", { session: "s1", limit: 10 });
    await chat.history(BOX, "default", { session: "s1", limit: 10 });
    expect(reads).toBe(3);
    expect(refused.cancelled()).toBe(true);
  });

  test("a dashboard that refuses the token scrape has its body cancelled", async () => {
    const refused = tracked(503, "<html>starting</html>", "text/html");
    const chat = adapter(() => Promise.resolve(refused.response));
    await expect(chat.history(BOX, "default", { session: "s1", limit: 10 })).rejects.toMatchObject({
      code: "CHAT_UNREACHABLE",
    });
    expect(refused.cancelled()).toBe(true);
  });
});

describe("the repeated-page key", () => {
  const row = (id: number, text = `m${id}`) => ({ id, role: "user", content: text });

  test("a repeated page has the same key, edited or not", () => {
    const page = [row(1), row(2)];
    expect(pageKey(page)).toBe(pageKey([row(1), row(2)]));
    // The same ids at another offset are the offset being ignored, whatever
    // was edited in between.
    expect(pageKey(page)).toBe(pageKey([row(1, "edited"), row(2)]));
  });

  test("distinct pages have distinct keys", () => {
    expect(pageKey([row(1), row(2)])).not.toBe(pageKey([row(3), row(4)]));
    // An appended row is a different page.
    expect(pageKey([row(1), row(2)])).not.toBe(pageKey([row(1), row(2), row(3)]));
  });

  test("rows without an identity fall back to their content", () => {
    const bare = (text: string) => ({ role: "user", content: text });
    expect(pageKey([bare("a")])).toBe(pageKey([bare("a")]));
    expect(pageKey([bare("a")])).not.toBe(pageKey([bare("b")]));
  });

  test("a dashboard that ignores the offset is still caught", async () => {
    const rows = Array.from({ length: 500 }, (_, i) => row(i + 1));
    let reads = 0;
    const chat = adapter((input) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/api/sessions/")) {
        reads += 1;
        return Promise.resolve(
          new Response(JSON.stringify({ messages: rows }), {
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return Promise.resolve(new Response(PAGE, { headers: { "content-type": "text/html" } }));
    });
    await expect(chat.history(BOX, "default", { session: "s1" })).rejects.toThrow(
      "history repeated a page",
    );
    expect(reads).toBe(2);
  });
});
