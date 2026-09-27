/**
 * TeX → HTML, for the two `math` cases in `blocks/Text.tsx`.
 *
 * Desktop parity: upstream `apps/desktop` (Hermes v2026.9.14) renders message
 * markdown with streamdown + @streamdown/math on top of katex 0.16.x, so an
 * expression a model writes arrives at the reader as an expression. This module
 * is the whole of that here — one function, so that the single place in the UI
 * that hands a string to `dangerouslySetInnerHTML` is one file with the reasons
 * written next to it.
 *
 * Why the innerHTML is safe:
 *
 *  - The string is **generated** by KaTeX, not passed through it. KaTeX parses
 *    TeX into its own node tree and serializes spans and MathML elements; the
 *    input is never interpolated into the output as markup. Characters it does
 *    not understand come out as text nodes, escaped.
 *  - `trust` is left at its default of `false`, which is what disables the
 *    commands that *can* emit a URL or raw markup (`\href`, `\url`,
 *    `\includegraphics`, `\htmlClass` and friends). A model writing
 *    `\href{javascript:…}` gets the characters it typed, not a link.
 *  - `throwOnError: false` keeps a malformed expression from taking a turn's
 *    render down with it: KaTeX draws the offending source in its error colour
 *    instead of throwing. `strict: "ignore"` is the same argument for the
 *    warnings — prose from a box is not ours to lint, and the alternative is a
 *    console line per Unicode character in every transcript.
 *  - Anything that still throws (KaTeX raises outside `ParseError` for a few
 *    structural limits) returns `null`, and the caller falls back to drawing
 *    the source through `RedactedText` as it did before this existed.
 *
 * And the ordering rule, which is the load-bearing part: **redaction comes
 * first**. Core masks secrets before the wire (`tests/chat-redaction.test.ts`)
 * and the UI's second door is `RedactedText`, which finds the marker core left
 * behind and draws it as `.ch-redacted`. A marker handed to KaTeX would come
 * back as typeset glyphs — the marker still legible, but no longer the
 * component's to mark, and the class the operator reads as "something was taken
 * out of this" gone. So a source carrying a marker is refused here and rendered
 * as source by the caller. Redact, then render; never the other way around.
 */
import katex from "katex";

/** What core's `chat-redact.ts` leaves behind, matched exactly as `RedactedText` matches it. */
const REDACTION_MARKER = /\[redacted\]|‹redacted by hermetic›/i;

/**
 * KaTeX's HTML for `tex`, or `null` when the caller should draw the source
 * instead: empty input, a redaction marker inside it, or a renderer that threw.
 */
export function renderMathHtml(tex: string, displayMode: boolean): string | null {
  const src = typeof tex === "string" ? tex.trim() : "";
  if (src === "") return null;
  if (REDACTION_MARKER.test(src)) return null;
  try {
    return katex.renderToString(src, {
      displayMode,
      throwOnError: false,
      strict: "ignore",
      output: "htmlAndMathml",
      // Two ceilings, both pinned here rather than left at a default, because
      // both of them are reachable from a sentence a model wrote. `maxSize`
      // defaults to Infinity: `\rule{9999em}{9999em}` is a single token that
      // lays out a box thousands of screens wide, which is not a broken
      // expression but a transcript and a composer pushed out of the viewport.
      // 10em is larger than any legitimate glyph or rule and small enough to
      // stay inside the column. `maxExpand` is KaTeX's own default of 1000; it
      // is written out so the macro-expansion ceiling is visible next to the
      // size one instead of being a fact about a version.
      maxSize: 10,
      maxExpand: 1000,
    });
  } catch {
    return null;
  }
}
