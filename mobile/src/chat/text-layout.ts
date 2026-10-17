/**
 * How chat prose is laid out as text, as the desktop lays it out in HTML.
 *
 * A React Native `<Text>` draws its string verbatim, where a browser applies a
 * `white-space` rule first. The two places that differ are kept here, pure, so
 * the rules are testable without rendering:
 *
 * - **Bot text** (`Markdown.tsx`). The parser (`client/markdown.ts`) already
 *   turns every newline inside a paragraph into a `br` span — the desktop
 *   draws each one as `<br>` (`breaks` semantics, `chat-markdown.ts`), and the
 *   phone draws it as `"\n"`, so line breaks already match. What is left is
 *   the paragraph's `white-space: normal`: a run of spaces or tabs inside a
 *   text span collapses to one space. `collapseSpaces` does that.
 * - **Operator text** (`blocks/Block.tsx`, `mine`). The desktop's `PlainText`
 *   (`packages/ui/src/chat/components/blocks/Text.tsx`) is `white-space:
 *   pre-wrap` — every space and newline kept — with only two pieces of markup:
 *   fenced blocks become code panes and backtick spans become inline code.
 *   `plainSegments` mirrors its `FENCE` and `INLINE_CODE` split exactly.
 */

/** A run of spaces or tabs inside a line, as HTML's `white-space: normal` sees it. */
const SPACE_RUN = /[ \t]+/g;

export function collapseSpaces(text: string): string {
  return text.replace(SPACE_RUN, " ");
}

/** Desktop `PlainText`'s fence rule: an optional info line, then the body up to the closer. */
const FENCE = /```[^\S\n]*[^\n]*\n?([\s\S]*?)```/g;
/** Desktop `PlainText`'s inline-code rule: one line, no backtick inside. */
const INLINE_CODE = /`([^`\n]+)`/g;

export interface PlainPart {
  code: boolean;
  text: string;
}

export type PlainSegment = { kind: "fence"; text: string } | { kind: "inline"; parts: PlainPart[] };

function inlineParts(text: string): PlainPart[] {
  const parts: PlainPart[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_CODE)) {
    if (m.index > last) parts.push({ code: false, text: text.slice(last, m.index) });
    parts.push({ code: true, text: m[1] ?? "" });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ code: false, text: text.slice(last) });
  return parts;
}

/**
 * Operator text after the desktop's `PlainText`: fenced blocks, and runs of
 * prose with inline code in them, whitespace otherwise kept (`pre-wrap`).
 *
 * One phone-only difference: the newline directly beside a fence is dropped.
 * The desktop's `pre-wrap` keeps it, so a desktop bubble shows a blank line
 * there; on a phone the pane already breaks the line, and the extra one only
 * costs height in a narrow bubble.
 */
export function plainSegments(text: string): PlainSegment[] {
  const segments: PlainSegment[] = [];
  const prose = (slice: string, beforeFence: boolean, afterFence: boolean) => {
    // Phone-only: the newline either side of a fence is dropped, since the
    // pane breaks the line itself (the desktop's `pre-wrap` keeps it).
    let s = slice;
    if (afterFence) s = s.replace(/^\n/, "");
    if (beforeFence) s = s.replace(/\n$/, "");
    if (s) segments.push({ kind: "inline", parts: inlineParts(s) });
  };
  let last = 0;
  for (const m of text.matchAll(FENCE)) {
    if (m.index > last) prose(text.slice(last, m.index), true, last > 0);
    // A `<pre>` does not draw the newline that sits right before its closer.
    segments.push({ kind: "fence", text: (m[1] ?? "").replace(/\n$/, "") });
    last = m.index + m[0].length;
  }
  if (last < text.length) prose(text.slice(last), false, last > 0);
  return segments;
}
