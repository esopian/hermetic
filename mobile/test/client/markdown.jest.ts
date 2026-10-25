import { parseInline, parseMarkdown } from "../../src/client/markdown.ts";

describe("markdown (byte-identical copy of the desktop parser)", () => {
  test("headings, paragraphs, lists, code, quote, hr", () => {
    const nodes = parseMarkdown(
      [
        "# Title",
        "",
        "Some **bold** and `code`.",
        "",
        "- one",
        "- two",
        "",
        "```ts",
        "const x = 1;",
        "```",
        "",
        "> quoted",
        "",
        "---",
      ].join("\n"),
    );
    expect(nodes.map((n) => n.type)).toEqual(["h", "p", "list", "code", "quote", "hr"]);
    expect(nodes[3]).toEqual({ type: "code", lang: "ts", text: "const x = 1;" });
  });

  test("inline spans", () => {
    const spans = parseInline("a *em* **strong** ~~del~~ [link](https://example.com) `x`");
    const types = spans.map((s) => s.type);
    expect(types).toEqual(expect.arrayContaining(["em", "strong", "del", "link", "code"]));
    const link = spans.find((s) => s.type === "link");
    expect(link).toMatchObject({ href: "https://example.com" });
  });

  test("a bare URL links, without the sentence's trailing period", () => {
    const spans = parseInline("see https://x.y/z.");
    expect(spans.find((s) => s.type === "link")).toMatchObject({
      href: "https://x.y/z",
      text: "https://x.y/z",
    });
    expect(spans[spans.length - 1]).toMatchObject({ type: "text", text: "." });
  });

  test("an unterminated fence still yields a code block (streaming)", () => {
    const nodes = parseMarkdown("```py\nprint(1)");
    expect(nodes[0]).toMatchObject({ type: "code", lang: "py" });
  });

  test("tables", () => {
    const nodes = parseMarkdown("| a | b |\n|:--|--:|\n| 1 | 2 |");
    expect(nodes[0]).toMatchObject({ type: "table", align: ["left", "right"] });
  });

  test("ordered and task lists", () => {
    const [ordered] = parseMarkdown("1. a\n2. b");
    expect(ordered).toMatchObject({ type: "list", ordered: true });
    const [tasks] = parseMarkdown("- [x] done\n- [ ] todo");
    expect(tasks?.type === "list" && tasks.items.map((i) => i.checked)).toEqual([true, false]);
  });
});
