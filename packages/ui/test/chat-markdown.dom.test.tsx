/**
 * GFM and math, drawn.
 *
 * `chat-logic.test.ts` owns the parse rules; this owns the elements they turn
 * into, and it is driven by one document containing every construct at once —
 * the same document the constructs were reported broken in. The negative
 * assertions at the end are the actual bug report: a table that rendered as
 * pipes, a task list that rendered as `[x]`, a rule that rendered as dashes
 * and an expression that rendered as dollars. None of that literal syntax may
 * survive into the DOM.
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

const DOCUMENT = [
  "| Column A | Column B | Column C |",
  "|----------|:--------:|---------:|",
  "| left | center | right |",
  "| a | b | c |",
  "",
  "---",
  "",
  "- [x] Completed task",
  "- [ ] Pending task",
  "",
  "Term with footnote-ish inline math: $E = mc^2$, and a horizontal rule above ends the sections.",
  "",
  "Nested formatting test: **bold with `code` inside**, *italic with [a link](https://example.com) inside*, and `code with **literal asterisks** that should not bold`.",
].join("\n");

/** The paragraph every inline rule has to survive at once. */
const INLINE_SAMPLE =
  "Plain paragraph with **bold**, *italic*, ***bold italic***, ~~strikethrough~~, `inline code`, and a [link](https://example.com).";

const NESTED_LISTS = [
  "- top one",
  "  - child one",
  "  - child two",
  "- top two",
  "",
  "1. first",
  "   - bullet under a number",
  "2. second",
].join("\n");

describe("markdown in a text block", () => {
  test("a GFM table becomes one table with its header, rows and alignment", () => {
    const { container } = draw(DOCUMENT);
    const tables = container.querySelectorAll("table");
    expect(tables).toHaveLength(1);
    const table = tables[0] as HTMLTableElement;
    const headers = table.querySelectorAll("th");
    expect(headers).toHaveLength(3);
    expect(Array.from(headers, (th) => th.textContent)).toEqual(["Column A", "Column B", "Column C"]);
    expect(table.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(
      Array.from(
        table.querySelectorAll("tbody tr")[0]?.querySelectorAll("td") ?? [],
        (td) => td.textContent,
      ),
    ).toEqual(["left", "center", "right"]);
    // The delimiter row's colons, as the only thing they are for.
    expect((headers[0] as HTMLElement).style.textAlign).toBe("");
    expect((headers[1] as HTMLElement).style.textAlign).toBe("center");
    expect((headers[2] as HTMLElement).style.textAlign).toBe("right");
    const firstRow = table.querySelectorAll("tbody tr")[0]?.querySelectorAll("td") ?? [];
    expect((firstRow[1] as HTMLElement).style.textAlign).toBe("center");
    expect((firstRow[2] as HTMLElement).style.textAlign).toBe("right");
  });

  test("a thematic break and a task list become an hr and read-only checkboxes", () => {
    const { container } = draw(DOCUMENT);
    expect(container.querySelectorAll("hr")).toHaveLength(1);
    const boxes = container.querySelectorAll('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    expect((boxes[0] as HTMLInputElement).checked).toBe(true);
    expect((boxes[1] as HTMLInputElement).checked).toBe(false);
    for (const box of boxes) expect((box as HTMLInputElement).disabled).toBe(true);
    expect(container.querySelectorAll("li.ch-task")).toHaveLength(2);
    expect(container.textContent).toContain("Completed task");
    expect(container.textContent).toContain("Pending task");
  });

  test("inline math becomes a typeset math span carrying the TeX, without its delimiters", () => {
    const { container } = draw(DOCUMENT);
    const math = container.querySelectorAll(".ch-math");
    expect(math).toHaveLength(1);
    // KaTeX typesets the source into glyph spans, so the TeX itself only
    // survives in the MathML annotation it emits alongside them.
    expect(math[0]?.querySelector(".katex")).not.toBeNull();
    expect(math[0]?.querySelector("annotation")?.textContent).toBe("E = mc^2");
  });

  test("links nest inside emphasis and code inside strong; a code span stays literal", () => {
    const { container } = draw(DOCUMENT);
    const link = container.querySelector("em a");
    expect(link?.getAttribute("href")).toBe("https://example.com");
    expect(link?.textContent).toBe("a link");
    expect(container.querySelector("strong code")?.textContent).toBe("code");

    const literal = Array.from(container.querySelectorAll("code")).find((el) =>
      (el.textContent ?? "").includes("literal asterisks"),
    );
    expect(literal?.textContent).toBe("code with **literal asterisks** that should not bold");
    expect(literal?.querySelector("strong")).toBeNull();
  });

  test("no delimiter, marker or dollar syntax survives into the rendered text", () => {
    const { container } = draw(DOCUMENT);
    const text = container.textContent ?? "";
    for (const literal of ["|---", "|", "[x]", "[ ]", "---", "$"]) {
      expect(text).not.toContain(literal);
    }
  });

  test("a redacted marker in a table cell is still drawn by RedactedText", () => {
    // Core masks before the wire (`tests/chat-redaction.test.ts`); this is the
    // second door. A construct that draws prose without going through
    // `RedactedText` would show the marker as plain characters.
    const { container } = draw(["| host | note |", "|---|---|", "| ember | [redacted] |"].join("\n"));
    const cells = container.querySelectorAll("tbody td");
    expect(cells).toHaveLength(2);
    expect(cells[1]?.querySelector(".ch-redacted")?.textContent).toBe("[redacted]");
  });

  test("every inline rule in one paragraph draws its own element", () => {
    const { container } = draw(INLINE_SAMPLE);
    expect(container.querySelectorAll("p")).toHaveLength(1);
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    // `***…***` is a strong wrapping an em, and neither of them is a stray
    // asterisk on screen.
    const both = container.querySelector("strong em");
    expect(both?.textContent).toBe("bold italic");
    expect(both?.parentElement?.tagName).toBe("STRONG");
    const italics = Array.from(container.querySelectorAll("em"), (el) => el.textContent);
    expect(italics).toEqual(["italic", "bold italic"]);
    expect(container.querySelector("del")?.textContent).toBe("strikethrough");
    expect(container.querySelector("del em")).toBeNull();
    expect(container.querySelector("code")?.textContent).toBe("inline code");
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com");
    expect(link?.textContent).toBe("link");
    // The delimiters themselves never reach the reader.
    const text = container.textContent ?? "";
    for (const literal of ["*", "~", "`", "](", "https://example.com"]) {
      expect(text).not.toContain(literal);
    }
  });

  test("a strikethrough leaf is drawn through RedactedText like every other", () => {
    // The second door, after core's masking. A construct that draws prose
    // without it shows the marker as plain characters.
    const { container } = draw("~~[redacted]~~ and - a list item");
    const del = container.querySelector("del");
    expect(del?.querySelector(".ch-redacted")?.textContent).toBe("[redacted]");
  });

  test("an indented item is drawn as a list inside its parent item", () => {
    const { container } = draw(NESTED_LISTS);
    const lists = container.querySelectorAll("ul, ol");
    // Two top-level lists, each with one sublist inside it.
    expect(lists).toHaveLength(4);

    const outer = Array.from(container.querySelectorAll("ul")).filter(
      (el) => el.parentElement?.tagName !== "LI",
    )[0] as HTMLElement;
    expect(outer.children).toHaveLength(2);
    const firstItem = outer.children[0] as HTMLElement;
    const sub = firstItem.querySelector("ul");
    expect(sub).not.toBeNull();
    expect(sub?.parentElement?.tagName).toBe("LI");
    expect(Array.from(sub?.children ?? [], (li) => li.textContent)).toEqual(["child one", "child two"]);
    // The second top-level item has no sublist of its own.
    expect((outer.children[1] as HTMLElement).querySelector("ul")).toBeNull();

    const ol = container.querySelector("ol") as HTMLElement;
    expect(ol.children).toHaveLength(2);
    const nestedUl = (ol.children[0] as HTMLElement).querySelector("ul");
    expect(nestedUl?.parentElement?.tagName).toBe("LI");
    expect(nestedUl?.textContent).toBe("bullet under a number");
    // A nested item's marker is gone from the text, not indented into it.
    expect(container.textContent ?? "").not.toContain("- child one");
  });

  test("a nested list item is drawn through RedactedText too", () => {
    const { container } = draw(["- parent", "  - [redacted]"].join("\n"));
    const sub = container.querySelector("li ul li");
    expect(sub?.querySelector(".ch-redacted")?.textContent).toBe("[redacted]");
  });

  test("a display-math block is typeset in display mode and never shows its dollars", () => {
    const { container } = draw("$$\n\\frac{a}{b}\n$$");
    const block = container.querySelector(".ch-math.block");
    expect(block?.querySelector(".katex-display")).not.toBeNull();
    expect(block?.querySelector("annotation")?.textContent).toBe("\\frac{a}{b}");
    expect(container.textContent).not.toContain("$");
  });
});
