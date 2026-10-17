/**
 * Parse once per distinct text: bounded caches in front of `parseMarkdown` and
 * `renderMathHtml`.
 *
 * A settled message says the same thing for the rest of its life, and both
 * passes are pure functions of their input, so a transcript re-drawn — a
 * remount, a conversation switched away from and back, a row React had to
 * render again — should not pay for them twice. The caches are least recently
 * used and bounded twice — by entries and by the characters they hold —
 * because a long session sees an unbounded number of texts, and KaTeX's HTML
 * for one formula can run to tens of kilobytes.
 *
 * The parsed nodes are shared between every caller that asks for the same
 * text. Nothing downstream mutates them (`blocks/Text.tsx` only reads), and
 * that sharing is also what lets the memoized node components see an
 * unchanged node as the same reference.
 */
import { parseMarkdown } from "./chat-markdown.ts";
import type { MdNode } from "./chat-markdown.ts";
import { renderMathHtml } from "./chat-math.ts";

/** Entries each cache keeps. A busy transcript's worth of messages and formulas. */
export const MARKDOWN_CACHE_LIMIT = 500;

/**
 * Characters each cache may hold, keys and values together: about 2 MB of
 * UTF-16 apiece, so about 4 MB for the pair. An entry larger than this on its
 * own is answered and not kept.
 */
export const MARKDOWN_CACHE_CHARS = 1_000_000;

/**
 * A `Map` in recency order: a hit moves to the back, and the front is evicted
 * while the cache is over either bound. Each entry carries its weight in
 * characters: for parsed markdown twice its source — the key, and the nodes
 * holding the same text again in pieces — and for math the key and the HTML.
 */
class Lru<V> {
  private readonly entries = new Map<string, { value: V; weight: number }>();
  private weight = 0;
  constructor(
    private readonly limit: number,
    private readonly budget: number,
  ) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, weight: number): void {
    this.drop(key);
    if (weight > this.budget) return;
    this.entries.set(key, { value, weight });
    this.weight += weight;
    while (this.entries.size > this.limit || this.weight > this.budget) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.drop(oldest.value);
    }
  }

  private drop(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.delete(key);
    this.weight -= entry.weight;
  }

  clear(): void {
    this.entries.clear();
    this.weight = 0;
  }

  get size(): number {
    return this.entries.size;
  }

  get held(): number {
    return this.weight;
  }
}

const markdown = new Lru<readonly MdNode[]>(MARKDOWN_CACHE_LIMIT, MARKDOWN_CACHE_CHARS);
/** `null` is a real answer (draw the source), so it is boxed to tell it from a miss. */
const math = new Lru<{ html: string | null }>(MARKDOWN_CACHE_LIMIT, MARKDOWN_CACHE_CHARS);

/** How many times each pass actually ran — a test's window onto the caches. */
export const markdownCacheStats = { parses: 0, mathRenders: 0 };

/** `parseMarkdown(text)`, from the cache when this text was parsed before. */
export function cachedMarkdown(text: string): readonly MdNode[] {
  // A block missing the field its schema promises still renders (`RowBoundary`
  // is the floor, not the plan): whatever `parseMarkdown` makes of it, uncached.
  if (typeof text !== "string") return parseMarkdown(text);
  const hit = markdown.get(text);
  if (hit !== undefined) return hit;
  markdownCacheStats.parses += 1;
  const nodes = parseMarkdown(text);
  markdown.set(text, nodes, text.length * 2);
  return nodes;
}

/** `renderMathHtml(tex, displayMode)`, from the cache when it was typeset before. */
export function cachedMathHtml(tex: string, displayMode: boolean): string | null {
  const key = `${displayMode ? "D" : "I"}${tex}`;
  const hit = math.get(key);
  if (hit !== undefined) return hit.html;
  markdownCacheStats.mathRenders += 1;
  const html = renderMathHtml(tex, displayMode);
  math.set(key, { html }, key.length + (html?.length ?? 0));
  return html;
}

/** Empty both caches and zero the counts. For tests. */
export function clearMarkdownCache(): void {
  markdown.clear();
  math.clear();
  markdownCacheStats.parses = 0;
  markdownCacheStats.mathRenders = 0;
}

/** Entries and characters currently held, per cache. For tests. */
export function markdownCacheSize(): {
  markdown: number;
  math: number;
  markdownChars: number;
  mathChars: number;
} {
  return {
    markdown: markdown.size,
    math: math.size,
    markdownChars: markdown.held,
    mathChars: math.held,
  };
}
