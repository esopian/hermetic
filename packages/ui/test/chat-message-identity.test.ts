/**
 * Stable identity for transcript rows (`src/chat/chat-message-identity.ts`)
 * and the markdown caches (`src/chat/markdown-cache.ts`): the pure halves of
 * the transcript's render isolation. The rendered half is
 * `thread-render-isolation.dom.test.tsx`.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { ChatMessageView } from "../src/api/index.ts";
import { reuseMessages, reuseRows, sameMap, sameValue } from "../src/chat/chat-message-identity.ts";
import { turnRows } from "../src/chat/chat-turns.ts";
import {
  MARKDOWN_CACHE_CHARS,
  MARKDOWN_CACHE_LIMIT,
  cachedMarkdown,
  cachedMathHtml,
  clearMarkdownCache,
  markdownCacheSize,
  markdownCacheStats,
} from "../src/chat/markdown-cache.ts";

function row(id: string, text: string, over: Record<string, unknown> = {}): ChatMessageView {
  return {
    id,
    session: "s1",
    role: "bot",
    author: null,
    at: "2026-09-17T11:00:00Z",
    blocks: [{ kind: "text", markdown: text }],
    usage: null,
    error: null,
    incomplete: null,
    ...over,
  } as unknown as ChatMessageView;
}

describe("sameValue", () => {
  test("compares plain JSON structurally", () => {
    expect(sameValue({ a: [1, { b: "x" }], c: null }, { a: [1, { b: "x" }], c: null })).toBe(true);
    expect(sameValue({ a: [1, 2] }, { a: [1, 2, 3] })).toBe(false);
    expect(sameValue({ a: 1 }, { a: "1" })).toBe(false);
    expect(sameValue([1], { 0: 1 })).toBe(false);
  });

  test("a key present on one side only is a difference, even when undefined", () => {
    expect(sameValue({ a: 1, b: undefined }, { a: 1 })).toBe(false);
    expect(sameValue({ a: 1 }, { a: 1, b: undefined })).toBe(false);
  });

  test("a non-plain object is equal only to itself", () => {
    const map = new Map([["a", 1]]);
    expect(sameValue(map, new Map([["a", 1]]))).toBe(false);
    expect(sameValue({ m: map }, { m: map })).toBe(true);
    expect(sameValue(new Date(0), new Date(0))).toBe(false);
  });
});

describe("reuseMessages", () => {
  test("a reconcile that changed nothing returns the held array itself", () => {
    const held = [row("a", "one"), row("b", "two")];
    expect(reuseMessages(held, structuredClone(held))).toBe(held);
  });

  test("an unchanged row keeps its object; a changed one is taken fresh", () => {
    const held = [row("a", "one"), row("b", "two")];
    const fresh = [row("a", "one"), row("b", "two, edited")];
    const out = reuseMessages(held, fresh);
    expect(out).not.toBe(held);
    expect(out[0]).toBe(held[0]!);
    expect(out[1]).toBe(fresh[1]!);
  });

  test("an appended row is new and every held row is kept", () => {
    const held = [row("a", "one"), row("b", "two")];
    const fresh = [...structuredClone(held), row("c", "three")];
    const out = reuseMessages(held, fresh);
    expect(out.length).toBe(3);
    expect(out[0]).toBe(held[0]!);
    expect(out[1]).toBe(held[1]!);
    expect(out[2]).toBe(fresh[2]!);
  });

  test("rows are matched by id, not by position", () => {
    const held = [row("a", "one"), row("b", "two")];
    const fresh = [row("b", "two"), row("a", "one")];
    const out = reuseMessages(held, fresh);
    expect(out).not.toBe(held);
    expect(out[0]).toBe(held[1]!);
    expect(out[1]).toBe(held[0]!);
  });

  test("a dropped row shortens the array and keeps the rest", () => {
    const held = [row("a", "one"), row("b", "two")];
    const out = reuseMessages(held, [row("a", "one")]);
    expect(out).toEqual([held[0]!]);
    expect(out[0]).toBe(held[0]!);
  });

  test("a field that differs only in a nested block is a change", () => {
    const held = [row("a", "one", { usage: { input_tokens: 1 } })];
    const out = reuseMessages(held, [row("a", "one", { usage: { input_tokens: 2 } })]);
    expect(out[0]).not.toBe(held[0]!);
  });
});

describe("reuseRows", () => {
  const NOW = Date.parse("2026-09-17T12:00:00Z");
  const tool = (id: string, at: string): ChatMessageView =>
    row(id, "", {
      at,
      blocks: [{ kind: "tool", name: "bash", status: "ok", args: {}, result: null }],
    });

  test("a merged turn rebuilt from the same source rows is kept", () => {
    const messages = [
      row("u", "go", { role: "user" }),
      tool("t1", "2026-09-17T11:00:01Z"),
      tool("t2", "2026-09-17T11:00:02Z"),
      row("b", "done", { at: "2026-09-17T11:00:03Z" }),
    ];
    const first = turnRows(messages, NOW);
    const second = turnRows([...messages], NOW);
    expect(second[1]).not.toBe(first[1]!);
    expect(reuseRows(first, second)).toBe(first);
  });

  test("a turn that took another row is new; the rows above it are kept", () => {
    const messages = [row("u", "go", { role: "user" }), tool("t1", "2026-09-17T11:00:01Z")];
    const first = turnRows(messages, NOW);
    const second = turnRows([...messages, tool("t2", "2026-09-17T11:00:02Z")], NOW);
    const out = reuseRows(first, second);
    expect(out[0]).toBe(first[0]!);
    expect(out[1]).not.toBe(first[1]!);
    expect(out[1]?.ids).toEqual(["t1", "t2"]);
  });
});

describe("sameMap", () => {
  test("same keys and values, by the given equality", () => {
    expect(sameMap(new Map([["a", 1]]), new Map([["a", 1]]))).toBe(true);
    expect(sameMap(new Map([["a", 1]]), new Map([["a", 2]]))).toBe(false);
    expect(sameMap(new Map([["a", { at: "x" }]]), new Map([["a", { at: "x" }]]))).toBe(false);
    expect(
      sameMap(new Map([["a", { at: "x" }]]), new Map([["a", { at: "x" }]]), (x, y) => x.at === y.at),
    ).toBe(true);
  });
});

describe("markdown cache", () => {
  beforeEach(clearMarkdownCache);

  test("one parse per distinct text, and the same nodes handed back", () => {
    const first = cachedMarkdown("**bold** and `code`");
    const again = cachedMarkdown("**bold** and `code`");
    expect(again).toBe(first);
    cachedMarkdown("something else");
    expect(markdownCacheStats.parses).toBe(2);
  });

  test("math is keyed by display mode as well as by source", () => {
    const inline = cachedMathHtml("x^2", false);
    expect(cachedMathHtml("x^2", false)).toBe(inline);
    cachedMathHtml("x^2", true);
    expect(markdownCacheStats.mathRenders).toBe(2);
  });

  test("a null answer is cached like any other", () => {
    expect(cachedMathHtml("   ", false)).toBeNull();
    expect(cachedMathHtml("   ", false)).toBeNull();
    expect(markdownCacheStats.mathRenders).toBe(1);
  });

  test("bounded: the least recently used text is evicted first", () => {
    cachedMarkdown("keep");
    for (let i = 0; i < MARKDOWN_CACHE_LIMIT - 1; i++) cachedMarkdown(`text ${i}`);
    // Touching it moves it to the back, so the next insert evicts `text 0`.
    cachedMarkdown("keep");
    cachedMarkdown("one more");
    expect(markdownCacheSize().markdown).toBe(MARKDOWN_CACHE_LIMIT);
    const parses = markdownCacheStats.parses;
    cachedMarkdown("keep");
    expect(markdownCacheStats.parses).toBe(parses);
    cachedMarkdown("text 0");
    expect(markdownCacheStats.parses).toBe(parses + 1);
  });

  test("bounded by characters as well: big entries push old ones out, and one too big is not kept", () => {
    const big = "x".repeat(MARKDOWN_CACHE_CHARS / 4);
    cachedMarkdown(`a${big}`);
    cachedMarkdown(`b${big}`);
    // Weighed at twice its length, a third pushes the first out.
    cachedMarkdown(`c${big}`);
    expect(markdownCacheSize().markdownChars).toBeLessThanOrEqual(MARKDOWN_CACHE_CHARS);
    const parses = markdownCacheStats.parses;
    cachedMarkdown(`c${big}`);
    expect(markdownCacheStats.parses).toBe(parses);
    cachedMarkdown(`a${big}`);
    expect(markdownCacheStats.parses).toBe(parses + 1);
    const huge = "y".repeat(MARKDOWN_CACHE_CHARS);
    cachedMarkdown(huge);
    cachedMarkdown(huge);
    expect(markdownCacheStats.parses).toBe(parses + 3);
  });
});
