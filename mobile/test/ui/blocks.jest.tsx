import { fireEvent, screen } from "@testing-library/react-native";
import * as Clipboard from "expo-clipboard";
import { Linking, View } from "react-native";
import { ActivityGroup } from "../../src/chat/blocks/Activity.tsx";
import { Block } from "../../src/chat/blocks/Block.tsx";
import { FailureCard } from "../../src/chat/blocks/Failure.tsx";
import { TurnRow } from "../../src/chat/TurnRow.tsx";
import { turnRows } from "../../src/client/chat-turns.ts";
import type { ChatBlock } from "../../src/protocol/types.ts";
import { approval, msg, question, subagent, tool } from "../helpers/fixtures.ts";
import { NOW, renderUi, scope } from "../helpers/render.tsx";

const draw = (block: ChatBlock, opts: { streaming?: boolean; mine?: boolean } = {}) =>
  renderUi(<Block block={block} now={NOW} {...opts} />, scope());

describe("text", () => {
  test("markdown nodes become native text: heading, emphasis, code span, list, quote", async () => {
    await draw({
      kind: "text",
      markdown: "# Title\n\nSome **bold** and *em* and `code`.\n\n- one\n- two\n\n> quoted",
    });
    expect(screen.getByText("Title")).toBeTruthy();
    expect(screen.getByText("bold")).toBeTruthy();
    expect(screen.getByText("em")).toBeTruthy();
    expect(screen.getByText(" code ")).toBeTruthy();
    expect(screen.getByText("one")).toBeTruthy();
    expect(screen.getByText("two")).toBeTruthy();
    expect(screen.getByText("quoted")).toBeTruthy();
  });

  test("a fenced block is mono with its language and a working Copy", async () => {
    await draw({ kind: "text", markdown: "```ts\nconst a = 1;\n```" });
    expect(screen.getByText("ts")).toBeTruthy();
    expect(screen.getByText("const a = 1;")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Copy code"));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith("const a = 1;");
  });

  test("a safe link opens; an unsafe one is drawn as text with its target", async () => {
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    await draw({
      kind: "text",
      markdown: "[docs](https://example.com/x) and [bad](javascript:void) and [here](/api/x)",
    });
    await fireEvent.press(screen.getByText("docs"));
    expect(open).toHaveBeenCalledWith("https://example.com/x");
    expect(screen.getByText("bad (javascript:void)")).toBeTruthy();
    expect(screen.getByText("here (/api/x)")).toBeTruthy();
    open.mockRestore();
  });

  test("tables draw header and cells", async () => {
    await draw({ kind: "text", markdown: "| a | b |\n|---|---|\n| 1 | 2 |" });
    expect(screen.getByText("a")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
  });

  test("the operator's own words are plain, never markdown", async () => {
    await draw({ kind: "text", markdown: "**not bold**" }, { mine: true });
    expect(screen.getByText("**not bold**")).toBeTruthy();
  });

  test("a streaming text block carries the caret", async () => {
    await draw({ kind: "text", markdown: "partial" }, { streaming: true });
    expect(screen.getByLabelText("streaming")).toBeTruthy();
  });
});

describe("cards", () => {
  test("reasoning: closed, says how long and how much, or live", async () => {
    await draw({ kind: "reasoning", text: "pondering", duration_ms: 1500, tokens: 1200 });
    expect(screen.getByText("thought for 1.5s · 1,200 tokens")).toBeTruthy();
    expect(screen.queryByText("pondering")).toBeNull();
    await fireEvent.press(screen.getByRole("button"));
    expect(screen.getByText("pondering")).toBeTruthy();
  });

  test("reasoning with no cost reads live", async () => {
    await draw({ kind: "reasoning", text: "x" });
    expect(screen.getByText("live")).toBeTruthy();
  });

  test("tool running: accent name, not collapsible", async () => {
    await draw(tool({ status: "running" }));
    expect(screen.getByText("● terminal")).toBeTruthy();
    expect(screen.getByText("running on the box")).toBeTruthy();
  });

  test("tool settled: collapsed with exit code; opened shows args and result", async () => {
    await draw(tool({ status: "ok", exit_code: 0, duration_ms: 420, result: { stdout: "file.txt" } }));
    expect(screen.getByText("exit 0 · 420ms")).toBeTruthy();
    expect(screen.getByText("ls")).toBeTruthy();
    expect(screen.queryByText("file.txt")).toBeNull();
    await fireEvent.press(screen.getByRole("button"));
    expect(screen.getByText("file.txt")).toBeTruthy();
    expect(screen.getByText("Arguments")).toBeTruthy();
  });

  test("tool diff hint draws the diff", async () => {
    await draw(tool({ status: "ok", render: "diff", result: "@@ -1 +1 @@\n-old\n+new" }));
    await fireEvent.press(screen.getByRole("button"));
    expect(screen.getByText("+new")).toBeTruthy();
    expect(screen.getByText("-old")).toBeTruthy();
  });

  test("activity warning is a notice, never folded", async () => {
    await draw({
      kind: "activity",
      category: "notice",
      key: "k",
      title: "Context nearly full",
      detail: "92% used",
      state: "warning",
    });
    expect(screen.getByText("Context nearly full")).toBeTruthy();
    expect(screen.getByText("92% used")).toBeTruthy();
  });

  test("attachment shows tag, name and size", async () => {
    await draw({
      kind: "attachment",
      name: "report.pdf",
      mime: "application/pdf",
      bytes: 2048,
      href: "/x",
    });
    expect(screen.getByText("PDF")).toBeTruthy();
    expect(screen.getByText("report.pdf")).toBeTruthy();
    expect(screen.getByText("2 KB · application/pdf")).toBeTruthy();
  });

  test("sources: numbered rows", async () => {
    await draw({ kind: "sources", items: [{ title: "Spec", href: "https://e.com" }] });
    await fireEvent.press(screen.getByRole("button"));
    expect(screen.getByText("Spec")).toBeTruthy();
  });

  test("hermetic card names its reference", async () => {
    await draw({ kind: "hermetic", card: "agent", ref: "atlas" });
    expect(screen.getByText("atlas")).toBeTruthy();
  });

  test("process event: one line, output on tap", async () => {
    await draw({
      kind: "process_event",
      event: "completion",
      outcome: "failed",
      command: "make build",
      exit_code: 2,
      output_tail: "error: boom",
      raw: "",
    });
    expect(screen.getByText("process finished")).toBeTruthy();
    expect(screen.getByText("make build")).toBeTruthy();
    expect(screen.getByText("exit 2")).toBeTruthy();
  });

  test("subagent: a one-liner that opens the child", async () => {
    const openSubagent = jest.fn();
    await renderUi(
      <Block
        block={subagent({ goal: "research", tools: [{ name: "web", preview: "searching" }] })}
        now={NOW}
      />,
      scope({ openSubagent }),
    );
    expect(screen.getByText("research")).toBeTruthy();
    expect(screen.getByText("↳ web searching")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Subagent: research, running"));
    expect(openSubagent).toHaveBeenCalledWith("s1");
  });

  test("an unknown kind falls through to name and payload, open", async () => {
    await draw({ kind: "hologram", name: "projector", payload: { beams: 3 } } as unknown as ChatBlock);
    expect(screen.getByText("Additional activity")).toBeTruthy();
    expect(screen.getByText("projector")).toBeTruthy();
    expect(screen.getByText(/"beams": 3/)).toBeTruthy();
  });

  test("approval reaches its card", async () => {
    await draw(approval());
    expect(screen.getByText("⚑ Approval required")).toBeTruthy();
  });

  test("question reaches its card", async () => {
    await draw(question());
    expect(screen.getByText("Which branch?")).toBeTruthy();
  });
});

describe("activity group", () => {
  test("settled tools: 'Tools complete · N tools', steps on open", async () => {
    await renderUi(
      <ActivityGroup
        blocks={[
          tool({ tool_id: "a", status: "ok" }),
          tool({ tool_id: "b", name: "read_file", status: "ok" }),
        ]}
        streaming={false}
      />,
    );
    expect(screen.getByText("Tools complete")).toBeTruthy();
    expect(screen.getByText("2 tools")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Tools complete, 2 tools"));
    expect(screen.getByText("read_file")).toBeTruthy();
  });

  test("a failed tool says so", async () => {
    await renderUi(<ActivityGroup blocks={[tool({ status: "bad" })]} streaming={false} />);
    expect(screen.getByText("Tool failed")).toBeTruthy();
  });

  test("streaming and waiting on the operator", async () => {
    await renderUi(
      <ActivityGroup blocks={[tool({ status: "ok" })]} streaming waiting activity="idle" />,
    );
    expect(screen.getByText("Waiting for your response")).toBeTruthy();
  });
});

describe("failure card", () => {
  test("a rate limit reads as a warn card with Retry for the latest failure", async () => {
    const retry = jest.fn(() => true);
    const prompt = msg({ id: "u1", role: "user", text: "do it" });
    const failed = msg({
      id: "f1",
      blocks: [],
      failure: { code: "RATE_LIMITED", message: "slow down" },
    });
    await renderUi(
      <FailureCard failure={failed.failure ?? null} ids={["f1"]} at={failed.at} />,
      scope({ retry, messages: [prompt, failed] }),
    );
    expect(screen.getByText("provider error")).toBeTruthy();
    expect(screen.getByText("Rate limited.")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Retry"));
    expect(retry).toHaveBeenCalledWith("do it");
  });

  test("no failure at all is the cut-off card", async () => {
    await renderUi(<FailureCard failure={null} />);
    expect(screen.getByText("This turn stopped before it finished.")).toBeTruthy();
  });
});

describe("turn rows", () => {
  test("operator bubble, then a bot turn with name and blocks", async () => {
    const rows = turnRows(
      [
        msg({ id: "u1", role: "user", text: "hello bot", at: "2026-10-13T11:59:00.000Z" }),
        msg({ id: "b1", text: "hello **you**", at: "2026-10-13T11:59:30.000Z" }),
      ],
      NOW,
    );
    await renderUi(
      <View>
        {rows.map((row) => (
          <TurnRow
            key={row.message.id}
            row={row}
            fleetId="fxtr0001"
            instance="atlas"
            bot="scribe"
            botTitle="Scribe"
            status="ready"
            now={NOW}
          />
        ))}
      </View>,
      scope(),
    );
    expect(screen.getByText("hello bot")).toBeTruthy();
    expect(screen.getByText("Scribe")).toBeTruthy();
    expect(screen.getByText("you")).toBeTruthy();
  });

  test("a local prompt reads sending…", async () => {
    const [row] = turnRows([msg({ id: "local:1", role: "user", text: "hi" })], NOW);
    if (!row) throw new Error("no row");
    await renderUi(
      <TurnRow row={row} fleetId="f" instance="atlas" bot="scribe" status="ready" now={NOW} />,
      scope(),
    );
    expect(screen.getByText("sending…")).toBeTruthy();
  });
});
