import { screen } from "@testing-library/react-native";
import { Markdown } from "../../src/chat/Markdown.tsx";
import { PlainText } from "../../src/chat/PlainText.tsx";
import { collapseSpaces, plainSegments } from "../../src/chat/text-layout.ts";
import { type MdSpan, parseMarkdown } from "../../src/client/markdown.ts";
import { renderUi } from "../helpers/render.tsx";

/** Every text-bearing span a paragraph holds, flattened. */
function leaves(spans: MdSpan[]): MdSpan[] {
  return spans.flatMap((s) => ("spans" in s && s.spans ? leaves(s.spans) : [s]));
}

describe("bot text: the desktop's line semantics", () => {
  test("a newline inside a paragraph is a `br` (the desktop's `<br>`), never a raw newline", () => {
    const [p, ...rest] = parseMarkdown("the data volume is\nmounted at /data, and **bold\nrun**.");
    expect(rest).toEqual([]);
    if (p?.type !== "p") throw new Error("not a paragraph");
    expect(leaves(p.spans).filter((s) => s.type === "br").length).toBe(2);
    for (const leaf of leaves(p.spans)) if ("text" in leaf) expect(leaf.text).not.toContain("\n");
  });

  test("a blank line is a paragraph break, not a line break", () => {
    expect(parseMarkdown("one\n\ntwo").map((n) => n.type)).toEqual(["p", "p"]);
  });

  test("runs of spaces collapse to one, as `white-space: normal` draws them", () => {
    expect(collapseSpaces("two  spaces\tand a tab")).toBe("two spaces and a tab");
    expect(collapseSpaces("one space")).toBe("one space");
  });

  test("the renderer draws the collapsed text", async () => {
    await renderUi(<Markdown markdown={"Done.  Next  step."} />);
    expect(screen.getByText("Done. Next step.")).toBeTruthy();
  });
});

describe("operator text: the desktop's PlainText", () => {
  test("prose is kept verbatim, newlines and spaces included", () => {
    expect(plainSegments("line one\nline  two")).toEqual([
      { kind: "inline", parts: [{ code: false, text: "line one\nline  two" }] },
    ]);
  });

  test("backtick spans become inline code; no other markup is read", () => {
    expect(plainSegments("run `ls -la` then **stop**")).toEqual([
      {
        kind: "inline",
        parts: [
          { code: false, text: "run " },
          { code: true, text: "ls -la" },
          { code: false, text: " then **stop**" },
        ],
      },
    ]);
  });

  test("a fenced block is a pane; the phone drops the newline beside it (the desktop keeps it)", () => {
    expect(plainSegments("before\n```sh\necho hi\n```\nafter")).toEqual([
      { kind: "inline", parts: [{ code: false, text: "before" }] },
      { kind: "fence", text: "echo hi" },
      { kind: "inline", parts: [{ code: false, text: "after" }] },
    ]);
    expect(plainSegments("```\nx\n```")).toEqual([{ kind: "fence", text: "x" }]);
  });

  test("PlainText renders the plain run as one text and the code as code", async () => {
    await renderUi(<PlainText text={"And summarise\n**not bold**"} />);
    expect(screen.getByText("And summarise\n**not bold**")).toBeTruthy();
    await renderUi(<PlainText text={"run `ls`\n```\necho hi\n```"} />);
    expect(screen.getByText(" ls ")).toBeTruthy();
    expect(screen.getByText("echo hi")).toBeTruthy();
  });
});
