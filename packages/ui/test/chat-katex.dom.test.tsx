/**
 * Math, actually typeset.
 *
 * `chat-markdown.dom.test.tsx` owns the GFM constructs; this owns the one that
 * is not drawn from parsed nodes at all — `blocks/Text.tsx` hands the TeX to
 * KaTeX (`chat-math.ts`) and puts the HTML it generated into the DOM. So there
 * are two things to hold down here, and they are different in kind:
 *
 *  - that an expression becomes `.katex` / `.katex-display` rather than styled
 *    source, which is the feature; and
 *  - that a redaction marker never reaches the typesetter, which is the
 *    ordering rule. Core masks before the wire
 *    (`tests/chat-redaction.test.ts`) and `RedactedText` is the second door;
 *    typesetting a marker would turn the thing that says "something was taken
 *    out of this" into glyphs with no class on them.
 */
import { cleanup, render } from "./dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import type { ChatBlockView } from "../src/api/index.ts";
import { Block } from "../src/chat/components/blocks/index.tsx";

afterEach(cleanup);

const NOW = new Date("2026-09-16T12:00:00Z").getTime();

function draw(markdown: string) {
  return render(
    <Block
      block={{ kind: "text", markdown } as unknown as ChatBlockView}
      now={NOW}
      streaming={false}
    />,
  );
}

describe("math rendered with KaTeX", () => {
  test("inline math becomes a .katex element inside the math span", () => {
    const { container } = draw("Mass and energy: $E = mc^2$, as usual.");
    const span = container.querySelector(".ch-math");
    expect(span).not.toBeNull();
    expect(span?.querySelector(".katex")).not.toBeNull();
    // Typeset, not display-typeset: an inline expression sits in the sentence.
    expect(span?.querySelector(".katex-display")).toBeNull();
    // The dollars are consumed by the parser and never drawn.
    expect(container.textContent ?? "").not.toContain("$");
  });

  test("display math becomes a .katex-display block", () => {
    const { container } = draw("$$\n\\frac{a}{b}\n$$");
    const block = container.querySelector(".ch-math.block");
    expect(block).not.toBeNull();
    expect(block?.querySelector(".katex-display")).not.toBeNull();
    expect(container.textContent ?? "").not.toContain("$");
  });

  test("KaTeX keeps the TeX source in its MathML annotation", () => {
    // The accessible name of a typeset expression is the expression. Losing
    // this is how math turns into a row of meaningless glyphs for a reader
    // using a screen reader, and it is invisible on screen.
    const { container } = draw("$E = mc^2$");
    const annotation = container.querySelector('annotation[encoding="application/x-tex"]');
    expect(annotation?.textContent).toBe("E = mc^2");
  });

  test("an expression KaTeX cannot parse falls back to its source, not an empty node", () => {
    const { container } = draw("$\\notacommand{x}$");
    const span = container.querySelector(".ch-math");
    expect(span).not.toBeNull();
    // `throwOnError: false` means KaTeX draws the offending source itself; the
    // one thing that may not happen is the expression vanishing.
    expect((span?.textContent ?? "").length).toBeGreaterThan(0);
  });

  test("a redaction marker inside TeX is drawn by RedactedText and never typeset", () => {
    // What arrives here is what core left behind after masking: the marker,
    // where the secret was. `chat-math.ts` refuses it, so the fallback path
    // draws it and `RedactedText` marks it.
    const { container } = draw("The key is $k = [redacted]$ for this run.");
    const span = container.querySelector(".ch-math");
    expect(span).not.toBeNull();
    expect(span?.querySelector(".ch-redacted")?.textContent).toBe("[redacted]");
    // The ordering assertion: KaTeX never saw it.
    expect(span?.querySelector(".katex")).toBeNull();
    expect(container.querySelector(".ch-math.rendered")).toBeNull();
  });

  test("the same rule holds for a display block, and for core's other marker", () => {
    // `chat-redact.ts` writes two spellings and `RedactedText` matches both;
    // this is the one the inline test above does not use, so between them the
    // refusal in `chat-math.ts` is exercised for each.
    const marker = "‹redacted by hermetic›";
    const { container } = draw(`$$\nk = ${marker}\n$$`);
    const block = container.querySelector(".ch-math.block");
    expect(block).not.toBeNull();
    expect(block?.querySelector(".ch-redacted")?.textContent).toBe(marker);
    expect(block?.querySelector(".katex-display")).toBeNull();
    expect(container.querySelector(".ch-math.rendered")).toBeNull();
    // The marker is drawn once, as itself: not swallowed, not duplicated into
    // a MathML annotation beside a typeset copy of itself.
    expect(container.querySelectorAll(".ch-redacted")).toHaveLength(1);
    expect((block?.textContent ?? "").split(marker)).toHaveLength(2);
  });

  test("a rule bigger than the screen is capped rather than drawn", () => {
    // `maxSize` is pinned in `chat-math.ts`; left at KaTeX's default of
    // Infinity, this single token lays out a box thousands of screens wide and
    // pushes the transcript and the composer out of the viewport. It is one
    // sentence from a bot away, so it is held down here.
    const { container } = draw("$\\rule{9999em}{9999em}$");
    const span = container.querySelector(".ch-math");
    expect(span?.querySelector(".katex")).not.toBeNull();

    // Every length KaTeX laid out: the inline styles of the HTML branch and
    // the sizing attributes of the MathML one. Checked against the cap rather
    // than against the one string this expression happened to use, so a future
    // `maxSize` above the column width fails here.
    const lengths: number[] = [];
    for (const el of span?.querySelectorAll("*") ?? []) {
      for (const attr of ["style", "width", "height", "voffset"]) {
        const value = el.getAttribute(attr);
        if (value === null) continue;
        for (const m of value.matchAll(/(-?\d+(?:\.\d+)?)em/g)) lengths.push(Math.abs(Number(m[1])));
      }
    }
    expect(lengths.length).toBeGreaterThan(0);
    expect(Math.max(...lengths)).toBeLessThanOrEqual(10);

    // The uncapped number survives in exactly one place — the MathML
    // annotation, which is the TeX source as text and lays nothing out.
    expect(span?.querySelector('annotation[encoding="application/x-tex"]')?.textContent).toBe(
      "\\rule{9999em}{9999em}",
    );
    for (const el of span?.querySelectorAll("*") ?? []) {
      if (el.tagName.toLowerCase() === "annotation") continue;
      for (const attr of el.attributes) expect(attr.value).not.toContain("9999");
    }
  });

  test("KaTeX does not emit a link even when the TeX asks for one", () => {
    // `trust` is left false, so `\href` is not honoured. A model writing one
    // gets the characters it typed; it does not get an anchor in a document
    // whose origin talks to the loopback API.
    const { container } = draw("$\\href{javascript:alert(1)}{click}$");
    const span = container.querySelector(".ch-math");
    expect(span).not.toBeNull();
    expect(span?.querySelector("a")).toBeNull();
    // Nothing in the output carries a URL at all: the scheme survives only as
    // the escaped text of the MathML annotation, which is the TeX source and
    // is never navigable.
    expect(span?.querySelector("[href]")).toBeNull();
    expect(span?.querySelector("[src]")).toBeNull();
  });
});
