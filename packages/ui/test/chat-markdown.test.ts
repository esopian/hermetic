/**
 * The markdown parser (§9.2), checked without mounting
 * anything: what a `text` block's prose becomes as nodes. Moved out of
 * `chat-logic.test.ts` with the parser itself; the rules it covers are the
 * ones a model actually exercises — paragraphs, fences, lists (nested, task),
 * GFM tables and strikethrough, inline math, and nested emphasis.
 */
import { describe, expect, test } from "bun:test";
import { parseInline, parseMarkdown } from "../src/chat/chat-markdown.ts";

describe("parseMarkdown", () => {
  test("paragraphs, headings, lists, quotes and fences", () => {
    const nodes = parseMarkdown(
      [
        "# What I found",
        "",
        "Three boxes are behind.",
        "",
        "- ember",
        "- fathom",
        "",
        "> see §6.5",
      ].join("\n"),
    );
    expect(nodes.map((n) => n.type)).toEqual(["h", "p", "list", "quote"]);
    expect(nodes[2]).toMatchObject({ type: "list", ordered: false });
  });

  test("a single newline inside a paragraph is a line break, not a space", () => {
    // A model that writes a numbered run one item per line means one item per
    // line. Joining them with a space rendered "1 2 3 … 30" as one long line.
    const nodes = parseMarkdown(["one", "two", "three"].join("\n"));
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ type: "p" });
    const spans = (nodes[0] as { spans: { type: string; text?: string }[] }).spans;
    expect(spans.map((s) => s.type)).toEqual(["text", "br", "text", "br", "text"]);
    expect(spans.filter((s) => s.type === "text").map((s) => s.text)).toEqual(["one", "two", "three"]);
  });

  test("inline markup survives a soft break instead of printing its delimiters", () => {
    // A model wraps a long line wherever the line got long, not where the
    // markup ends. Scanning each line on its own ended every rule at the
    // newline and printed the asterisks and backticks it had opened.
    const bold = parseMarkdown(["**bold", "text**"].join("\n"))[0] as {
      spans: { type: string; text?: string }[];
    };
    expect(bold.spans.map((s) => s.type)).toEqual(["strong", "br", "strong"]);
    expect(bold.spans.map((s) => s.text).join("|")).toBe("bold||text");

    const code = parseMarkdown(["`hermetic agent", "ps`"].join("\n"))[0] as {
      spans: { type: string; text?: string }[];
    };
    expect(code.spans.map((s) => s.type)).toEqual(["code", "br", "code"]);
    expect(code.spans.some((s) => (s.text ?? "").includes("`"))).toBe(false);
  });

  test("a blank line still ends the paragraph, and a list is not joined by breaks", () => {
    const nodes = parseMarkdown(["one", "", "two"].join("\n"));
    expect(nodes.map((n) => n.type)).toEqual(["p", "p"]);
    const list = parseMarkdown(["- ember", "- fathom"].join("\n"))[0] as {
      type: string;
      items: unknown[];
    };
    expect(list.type).toBe("list");
    expect(list.items).toHaveLength(2);
  });

  test("a fence keeps its language and its interior verbatim", () => {
    const nodes = parseMarkdown(
      ["```bash", "for a in ember; do", "  echo $a", "done", "```"].join("\n"),
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ type: "code", lang: "bash" });
    expect(nodes[0]).toHaveProperty("text", "for a in ember; do\n  echo $a\ndone");
  });

  test("inline code suspends every other rule inside it", () => {
    const spans = parseInline("run `hermetic **upgrade**` first");
    expect(spans[1]).toEqual({ type: "code", text: "hermetic **upgrade**" });
  });

  test("links, emphasis and citation markers", () => {
    expect(parseInline("see [the docs](https://x.example)")).toContainEqual({
      type: "link",
      text: "the docs",
      href: "https://x.example",
    });
    expect(parseInline("**ember** is the one")[0]).toEqual({ type: "strong", text: "ember" });
    expect(parseInline("125 MiB/s[^1]")).toContainEqual({ type: "cite", n: "1" });
  });

  test("underscores inside identifiers remain literal, including Unicode words", () => {
    for (const identifier of [
      "LIVE_CHAT_1789679968888_AFTER_ABORT",
      "snake_case_name",
      "a_b_c",
      "α_β_γ",
      "name_part_",
    ]) {
      expect(parseInline(identifier)).toEqual([{ type: "text", text: identifier }]);
    }
  });

  test("underscore emphasis requires word boundaries and non-whitespace content", () => {
    expect(parseInline("(_emphasis_) then _two words_.")).toEqual([
      { type: "text", text: "(" },
      { type: "em", text: "emphasis" },
      { type: "text", text: ") then " },
      { type: "em", text: "two words" },
      { type: "text", text: "." },
    ]);
    for (const text of ["_ leading_", "_trailing _", "__unhandled strong__"]) {
      expect(parseInline(text)).toEqual([{ type: "text", text }]);
    }
  });

  test("markdown that is only prose is one paragraph, and empty input is nothing", () => {
    expect(parseMarkdown("just a line")).toHaveLength(1);
    expect(parseMarkdown("")).toHaveLength(0);
  });
});

/* ── GFM, math and nesting ───────────────────────────────────────────────── */

describe("parseMarkdown: GFM", () => {
  const table = (markdown: string) =>
    parseMarkdown(markdown).find((n) => n.type === "table") as
      | {
          type: "table";
          align: (string | null)[];
          header: { type: string; text?: string }[][];
          rows: { type: string; text?: string }[][][];
        }
      | undefined;

  test("a delimiter row makes the line above it a header, and carries the alignment", () => {
    const node = table(["| A | B | C |", "|---|:-:|--:|", "| 1 | 2 | 3 |"].join("\n"));
    expect(node?.align).toEqual([null, "center", "right"]);
    expect(node?.header).toHaveLength(3);
    expect(node?.rows).toHaveLength(1);
    expect(node?.rows[0]?.[2]?.[0]).toEqual({ type: "text", text: "3" });
  });

  test("the outer pipes are optional and the cells are parsed as prose", () => {
    const node = table(["A | B", ":--- | ---", "`x` | **y**"].join("\n"));
    expect(node?.align).toEqual(["left", null]);
    expect(node?.rows[0]?.[0]?.[0]).toEqual({ type: "code", text: "x" });
    expect(node?.rows[0]?.[1]?.[0]).toMatchObject({ type: "strong", text: "y" });
  });

  test("a table ends at a blank line or at the first line without a pipe", () => {
    const nodes = parseMarkdown(["| A |", "|---|", "| 1 |", "after"].join("\n"));
    expect(nodes.map((n) => n.type)).toEqual(["table", "p"]);
    expect((nodes[0] as { rows: unknown[] }).rows).toHaveLength(1);
    const blank = parseMarkdown(["| A |", "|---|", "| 1 |", "", "after"].join("\n"));
    expect(blank.map((n) => n.type)).toEqual(["table", "p"]);
  });

  test("a sentence containing a pipe is still a sentence", () => {
    // No delimiter row under it, so nothing here is a table.
    const nodes = parseMarkdown("run `ps | grep hermeticd` on the box");
    expect(nodes.map((n) => n.type)).toEqual(["p"]);
  });

  test("a task item carries its state; an ordinary bullet carries none", () => {
    const list = parseMarkdown(
      ["- [x] done", "* [X] also done", "- [ ] pending", "- plain"].join("\n"),
    )[0] as {
      type: string;
      items: { checked: boolean | null; spans: { type: string; text?: string }[] }[];
    };
    expect(list.type).toBe("list");
    expect(list.items.map((i) => i.checked)).toEqual([true, true, false, null]);
    expect(list.items[0]?.spans[0]).toEqual({ type: "text", text: "done" });
    expect(list.items[2]?.spans[0]).toEqual({ type: "text", text: "pending" });
  });

  test("a rule of dashes, stars or underscores is a rule, not a list and not prose", () => {
    for (const rule of ["---", "***", "___", "- - -", "  ****  "]) {
      expect(parseMarkdown(rule).map((n) => n.type)).toEqual(["hr"]);
    }
    // Two is not enough, and a bullet with content is still a bullet.
    expect(parseMarkdown("--").map((n) => n.type)).toEqual(["p"]);
    expect(parseMarkdown("- ember").map((n) => n.type)).toEqual(["list"]);
  });

  test("a rule ends the paragraph above it", () => {
    expect(parseMarkdown(["one", "---", "two"].join("\n")).map((n) => n.type)).toEqual([
      "p",
      "hr",
      "p",
    ]);
  });

  test("display math keeps its source, on one line or several", () => {
    expect(parseMarkdown("$$E = mc^2$$")).toEqual([{ type: "math", text: "E = mc^2" }]);
    expect(parseMarkdown(["$$", "a + b", "= c", "$$"].join("\n"))).toEqual([
      { type: "math", text: "a + b\n= c" },
    ]);
  });

  test("a `$$` that opens nothing swallows nothing", () => {
    // The opener has to be the delimiter alone. A sentence that begins with the
    // characters — and shell quoting is exactly where a model writes them —
    // opened a block that ran to the end of the turn, eating every paragraph,
    // list and table under it into one unreadable expression.
    const nodes = parseMarkdown(
      ["$$ is how bash spells the pid.", "", "Next paragraph", "", "- a", "- b"].join("\n"),
    );
    expect(nodes.map((n) => n.type)).toEqual(["p", "p", "list"]);
    expect(nodes.some((n) => n.type === "math")).toBe(false);

    // A bare opener with no closer below it is prose too, for the same reason:
    // a turn cut off mid-expression must not take the document with it.
    const cut = parseMarkdown(["$$", "a + b", "", "and then"].join("\n"));
    expect(cut.map((n) => n.type)).toEqual(["p", "p"]);
    expect(cut.some((n) => n.type === "math")).toBe(false);
  });

  test("a task item with no label is still a task", () => {
    const list = parseMarkdown(["- [x]", "- [ ] pending", "- [x]not a task"].join("\n"))[0] as {
      items: { checked: boolean | null; spans: unknown[] }[];
    };
    expect(list.items.map((i) => i.checked)).toEqual([true, false, null]);
    expect(list.items[0]?.spans).toEqual([]);
    expect(list.items[2]?.spans[0]).toEqual({ type: "text", text: "[x]not a task" });
  });
});

describe("parseInline: math and nesting", () => {
  test("inline math becomes a math span carrying the TeX", () => {
    expect(parseInline("so $E = mc^2$ holds")).toEqual([
      { type: "text", text: "so " },
      { type: "math", text: "E = mc^2" },
      { type: "text", text: " holds" },
    ]);
    expect(parseInline("$x$")).toEqual([{ type: "math", text: "x" }]);
  });

  test("a price is not an expression", () => {
    // The rule that buys this: no space just inside either delimiter, and no
    // digit straight after the closing one.
    for (const text of ["costs $5 and $6", "$5 and $6", "$ x $", "$x $", "$ x$", "a $5 and $6 b"]) {
      expect(parseInline(text).some((s) => s.type === "math")).toBe(false);
    }
    expect(parseInline("costs $5 and $6")).toEqual([{ type: "text", text: "costs $5 and $6" }]);
  });

  test("a link nests inside emphasis, and emphasis inside a link", () => {
    const italic = parseInline("*italic with [a link](https://example.com) inside*")[0] as {
      type: string;
      spans?: { type: string; text?: string; href?: string }[];
    };
    expect(italic.type).toBe("em");
    expect(italic.spans?.map((s) => s.type)).toEqual(["text", "link", "text"]);
    expect(italic.spans?.[1]).toMatchObject({
      type: "link",
      text: "a link",
      href: "https://example.com",
    });

    const link = parseInline("[see **this**](https://example.com)")[0] as {
      type: string;
      spans?: { type: string; text?: string }[];
    };
    expect(link.type).toBe("link");
    expect(link.spans?.map((s) => s.type)).toEqual(["text", "strong"]);
    expect(link.spans?.[1]).toMatchObject({ type: "strong", text: "this" });
  });

  test("code nests inside strong, and a code span keeps its asterisks literal", () => {
    const strong = parseInline("**bold with `code` inside**")[0] as {
      type: string;
      spans?: { type: string; text?: string }[];
    };
    expect(strong.type).toBe("strong");
    expect(strong.spans?.map((s) => s.type)).toEqual(["text", "code", "text"]);
    expect(strong.spans?.[1]).toEqual({ type: "code", text: "code" });

    expect(parseInline("`code with **literal asterisks** here`")).toEqual([
      { type: "code", text: "code with **literal asterisks** here" },
    ]);
    // Backticks suspend the dollar rule too.
    expect(parseInline("`$E = mc^2$`")).toEqual([{ type: "code", text: "$E = mc^2$" }]);
  });

  test("emphasis with nothing inside it is still the flat node it always was", () => {
    // The `spans` field is only present where it earns its place; the renderer
    // reads `text` otherwise, and every existing node keeps its shape.
    expect(parseInline("**ember**")[0]).toEqual({ type: "strong", text: "ember" });
    expect(parseInline("*one*")[0]).toEqual({ type: "em", text: "one" });
  });

  test("a nested scan does not lose the parent's place in the line", () => {
    // `INLINE` is one shared global regex and `nested` re-enters `parseInline`
    // with it; without restoring `lastIndex` the tail of the line vanished.
    const spans = parseInline("**a `b` c** then *d [e](https://x.example) f* end");
    expect(spans.map((s) => s.type)).toEqual(["strong", "text", "em", "text"]);
    expect(spans.map((s) => (s as { text?: string }).text).join("|")).toBe(
      "a `b` c| then |d [e](https://x.example) f| end",
    );
  });
});

describe("parseInline: triple emphasis and strikethrough", () => {
  test("`***a***` is strong around em, not a literal asterisk either side", () => {
    // The bug: `**` matched first, leaving `*bold italic*` inside it and a
    // stray asterisk on screen.
    const span = parseInline("***bold italic***")[0] as {
      type: string;
      text?: string;
      spans?: { type: string; text?: string; spans?: unknown }[];
    };
    expect(span.type).toBe("strong");
    expect(span.text).toBe("bold italic");
    expect(span.spans).toEqual([{ type: "em", text: "bold italic", spans: undefined }]);
    expect(parseInline("***a***").map((s) => (s as { text?: string }).text)).toEqual(["a"]);
  });

  test("`___a___` is the same node, and an identifier is still literal", () => {
    const span = parseInline("___both___")[0] as { type: string; spans?: { type: string }[] };
    expect(span.type).toBe("strong");
    expect(span.spans?.[0]?.type).toBe("em");
    for (const identifier of ["__init__", "a___b", "LIVE___CHAT"]) {
      expect(parseInline(identifier)).toEqual([{ type: "text", text: identifier }]);
    }
  });

  test("emphasis nests either way round without printing its delimiters", () => {
    const strong = parseInline("**a *b* c**")[0] as {
      type: string;
      spans?: { type: string; text?: string }[];
    };
    expect(strong.type).toBe("strong");
    expect(strong.spans?.map((s) => s.type)).toEqual(["text", "em", "text"]);
    expect(strong.spans?.[1]).toMatchObject({ type: "em", text: "b" });

    const em = parseInline("*a **b** c*")[0] as {
      type: string;
      spans?: { type: string; text?: string }[];
    };
    expect(em.type).toBe("em");
    expect(em.spans?.map((s) => s.type)).toEqual(["text", "strong", "text"]);
    expect(em.spans?.[1]).toMatchObject({ type: "strong", text: "b" });
  });

  test("`~~a~~` is a del span carrying its content without the tildes", () => {
    expect(parseInline("~~gone~~")[0]).toEqual({ type: "del", text: "gone", spans: undefined });
    const spans = parseInline("keep ~~drop **this**~~ keep");
    expect(spans.map((s) => s.type)).toEqual(["text", "del", "text"]);
    const del = spans[1] as { text?: string; spans?: { type: string }[] };
    expect(del.text).toBe("drop **this**");
    expect(del.spans?.map((s) => s.type)).toEqual(["text", "strong"]);
    // A lone tilde pair with whitespace inside it, and a single tilde, stay prose.
    for (const text of ["~~ no ~~", "a ~ b ~ c", "~single~"]) {
      expect(parseInline(text).some((s) => s.type === "del")).toBe(false);
    }
  });

  test("two delimiters that merely meet are not an empty run", () => {
    // `*?` in a run body matched nothing between the delimiters and deleted the
    // asterisks a model wrote. Arithmetic, identifiers and globs are prose.
    for (const text of ["2 ** 8 == 256", "x**y", "**/*.ts", "a __ b", "~~~~", "a ~~ b"]) {
      expect(parseInline(text)).toEqual([{ type: "text", text }]);
    }
    expect(parseInline("2 ** 8").some((s) => s.type === "em" || s.type === "strong")).toBe(false);
  });

  test("a code span still suspends the new rules too", () => {
    expect(parseInline("`***a*** ~~b~~`")).toEqual([{ type: "code", text: "***a*** ~~b~~" }]);
  });
});

describe("parseMarkdown: nested lists", () => {
  type Item = { spans: { text?: string }[]; lists?: List[] };
  type List = { type: string; ordered: boolean; items: Item[] };
  const first = (markdown: string) => parseMarkdown(markdown)[0] as unknown as List;

  test("an indented bullet becomes the parent item's child, not its sibling", () => {
    const list = first(["- one", "  - one a", "  - one b", "- two"].join("\n"));
    expect(list.items).toHaveLength(2);
    expect(list.items[0]?.lists?.[0]?.items.map((i) => i.spans[0]?.text)).toEqual(["one a", "one b"]);
    expect(list.items[1]?.lists).toBeUndefined();
  });

  test("a tab indents as well as two spaces do", () => {
    const list = first(["- one", "\t- child"].join("\n"));
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.lists?.[0]?.items[0]?.spans[0]?.text).toBe("child");
  });

  test("a bullet list nests under an ordered parent, and keeps its own kind", () => {
    const list = first(["1. first", "   - bullet", "2. second"].join("\n"));
    expect(list.ordered).toBe(true);
    expect(list.items.map((i) => i.spans[0]?.text)).toEqual(["first", "second"]);
    const child = list.items[0]?.lists?.[0];
    expect(child?.ordered).toBe(false);
    expect(child?.items.map((i) => i.spans[0]?.text)).toEqual(["bullet"]);
  });

  test("an ordered list nests under a bullet parent", () => {
    const list = first(["- steps", "  1. one", "  2. two"].join("\n"));
    const child = list.items[0]?.lists?.[0];
    expect(child?.ordered).toBe(true);
    expect(child?.items).toHaveLength(2);
  });

  test("the run returns to the parent level when the indent does", () => {
    const list = first(["- a", "  - a1", "- b", "  - b1", "  - b2"].join("\n"));
    expect(list.items.map((i) => i.spans[0]?.text)).toEqual(["a", "b"]);
    expect(list.items[0]?.lists?.[0]?.items).toHaveLength(1);
    expect(list.items[1]?.lists?.[0]?.items).toHaveLength(2);
  });

  test("a nested task item keeps its checkbox state", () => {
    const list = first(["- parent", "  - [x] done", "  - [ ] todo"].join("\n"));
    const child = list.items[0]?.lists?.[0] as unknown as {
      items: { checked: boolean | null }[];
    };
    expect(child.items.map((i) => i.checked)).toEqual([true, false]);
  });

  test("a kind switch at a nested level is a second list, not a bullet in the first", () => {
    // Appending it to the bullets above drew a numbered item as a bullet.
    const list = first(["- a", "  - b", "  1. c"].join("\n"));
    const children = list.items[0]?.lists;
    expect(children).toHaveLength(2);
    expect(children?.[0]?.ordered).toBe(false);
    expect(children?.[0]?.items.map((i) => i.spans[0]?.text)).toEqual(["b"]);
    expect(children?.[1]?.ordered).toBe(true);
    expect(children?.[1]?.items.map((i) => i.spans[0]?.text)).toEqual(["c"]);
  });

  test("flat lists keep exactly the shape they had before nesting existed", () => {
    const nodes = parseMarkdown(["- ember", "- fathom", "", "- burrow"].join("\n"));
    // A blank line between two bullet runs is still one list.
    expect(nodes.map((n) => n.type)).toEqual(["list"]);
    const list = nodes[0] as unknown as List;
    expect(list.items).toHaveLength(3);
    for (const item of list.items) expect(item.lists).toBeUndefined();
    // A bullet run and a numbered run at column zero are still two lists.
    expect(parseMarkdown(["- a", "1. b"].join("\n")).map((n) => n.type)).toEqual(["list", "list"]);
  });
});

test("inline parsing is linear in the length of what a model wrote", () => {
  // Re-slicing the tail on every match rescans from zero, so a paragraph with n
  // spans costs O(n·len) and one long model-authored paragraph hung the tab.
  const line = Array.from({ length: 4000 }, (_, i) => `\`c${i}\` and **b${i}**`).join(" ");
  const started = performance.now();
  const spans = parseInline(line);
  expect(spans.length).toBeGreaterThan(8000);
  expect(performance.now() - started).toBeLessThan(2000);
});
