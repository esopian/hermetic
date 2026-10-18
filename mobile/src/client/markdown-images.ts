/**
 * Images in a markdown paragraph.
 *
 * The parser (`markdown.ts`) is the desktop's, byte-identical, and has no
 * image node: `![alt](url)` reaches the renderer as a text span ending in `!`
 * followed by a link span. This pass finds that pair and splits the paragraph
 * around it, so the renderer can draw the picture as a block of its own
 * between the words. Whether the picture is loaded is `file-urls.ts`'s call,
 * not this one's. Pure TypeScript.
 */
import type { MdSpan } from "./markdown.ts";

export type ParagraphPiece =
  | { kind: "spans"; spans: MdSpan[] }
  | { kind: "image"; alt: string; href: string };

/** A paragraph's spans, cut at each `![alt](href)`; one `spans` piece when there is none. */
export function splitImages(spans: readonly MdSpan[]): ParagraphPiece[] {
  const out: ParagraphPiece[] = [];
  let run: MdSpan[] = [];
  const flush = (): void => {
    // A run of nothing but whitespace and breaks between two images is not a paragraph.
    if (run.some((s) => s.type !== "br" && (s.type !== "text" || s.text.trim() !== "")))
      out.push({ kind: "spans", spans: run });
    run = [];
  };
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i] as MdSpan;
    const next = spans[i + 1];
    if (span.type === "text" && span.text.endsWith("!") && next?.type === "link") {
      const before = span.text.slice(0, -1);
      if (before) run.push({ type: "text", text: before });
      flush();
      out.push({ kind: "image", alt: next.text, href: next.href });
      i++;
      continue;
    }
    run.push(span);
  }
  flush();
  return out.length > 0 ? out : [{ kind: "spans", spans: [...spans] }];
}

/** Whether a paragraph holds an image at all (the common case answers fast). */
export function hasImage(spans: readonly MdSpan[]): boolean {
  for (let i = 0; i < spans.length - 1; i++) {
    const span = spans[i];
    if (span?.type === "text" && span.text.endsWith("!") && spans[i + 1]?.type === "link") return true;
  }
  return false;
}
