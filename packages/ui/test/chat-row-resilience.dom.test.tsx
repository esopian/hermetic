/**
 * A transcript is data, and data arrives malformed (§9.2, "an unrecognised
 * shape renders; it never disappears").
 *
 * Two layers, tested separately because they fail differently.
 *
 * **The shapes.** Every block field the renderers reach for is typed as a
 * string in `core/src/schema/chat.ts`, and none of it is revalidated between
 * the database and the DOM. A row persisted by an older build, or produced by
 * a gateway a version ahead, arrives with a field simply absent — and every
 * one of those went through `RedactedText`, whose `text.split` turned a
 * missing `title` into an uncaught `TypeError`. React's answer to an uncaught
 * render error is to unmount the tree, so one malformed block blanked the
 * whole chat. The shapes below are the ones that actually threw.
 *
 * **The floor.** The guards fix the shapes that were found; `RowBoundary` is
 * what keeps the promise for the ones that were not. A renderer that throws
 * for any reason at all costs its own row and nothing else.
 */
import { cleanup, render, screen } from "./dom.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChatBlockView, ChatMessageView } from "../src/api/index.ts";
import { Block } from "../src/chat/components/blocks/index.tsx";
import { RowBoundary } from "../src/chat/components/RowBoundary.tsx";
import { Thread } from "../src/chat/components/Thread.tsx";
import { parseMarkdown } from "../src/chat/chat-logic.ts";

afterEach(cleanup);

const NOW = new Date("2026-09-19T12:00:00Z").getTime();

function draw(value: Record<string, unknown>) {
  return render(<Block block={value as unknown as ChatBlockView} now={NOW} />);
}

describe("a block missing a field its schema promises", () => {
  /**
   * Each of these threw `Cannot read properties of undefined (reading 'split')`
   * out of `RedactedText`, and took the thread down with it. The assertion is
   * only that they render: what a missing title *says* is not the contract,
   * that it draws at all is.
   */
  const shapes: [string, Record<string, unknown>][] = [
    ["text without markdown", { kind: "text" }],
    ["text whose markdown is null", { kind: "text", markdown: null }],
    ["reasoning without text", { kind: "reasoning" }],
    ["activity without title", { kind: "activity", category: "notice", key: "k", state: "running" }],
    [
      "an error activity without title",
      { kind: "activity", category: "notice", key: "k", state: "error" },
    ],
    ["tool without name", { kind: "tool", status: "ok" }],
    ["approval without tool or summary", { kind: "approval" }],
    ["question without prompt", { kind: "question", choices: [] }],
    ["attachment without mime or name", { kind: "attachment" }],
    ["sources without items", { kind: "sources" }],
  ];

  for (const [name, shape] of shapes) {
    test(`${name} renders`, () => {
      expect(() => draw(shape)).not.toThrow();
    });
  }

  test("an absent markdown document is an empty one, not a throw", () => {
    expect(parseMarkdown(undefined as unknown as string)).toEqual([]);
    expect(parseMarkdown(null as unknown as string)).toEqual([]);
  });
});

/**
 * What the throwing renders below write to `console.error`, captured.
 *
 * A caught render error is logged twice — React reports it, and `RowBoundary`
 * records it for the tab's console — and both come with a stack. Those are
 * the expected output of every test here that throws on purpose, so they are
 * kept out of the suite's output and asserted on instead.
 */
function captureConsoleError(): { readonly logged: string[] } {
  const state = { logged: [] as string[] };
  const native = console.error;
  beforeEach(() => {
    state.logged = [];
    console.error = (...args: unknown[]) => {
      state.logged.push(args.map(String).join(" "));
    };
  });
  afterEach(() => {
    console.error = native;
  });
  return {
    get logged() {
      return state.logged;
    },
  };
}

/** A renderer that fails for a reason nobody anticipated. */
function Boom(): never {
  throw new TypeError("undefined is not an object (evaluating 'text.split')");
}

describe("RowBoundary", () => {
  const errors = captureConsoleError();

  test("a row that throws costs its own row and no other", () => {
    render(
      <>
        <RowBoundary resetKey="a">
          <p>first turn</p>
        </RowBoundary>
        <RowBoundary resetKey="b">
          <Boom />
        </RowBoundary>
        <RowBoundary resetKey="c">
          <p>third turn</p>
        </RowBoundary>
      </>,
    );
    expect(screen.getByText("first turn")).toBeDefined();
    expect(screen.getByText("third turn")).toBeDefined();
    expect(screen.getByText("This message could not be rendered.")).toBeDefined();
    expect(errors.logged.some((line) => line.startsWith("chat row failed to render"))).toBe(true);
  });

  test("a latched row recovers when its content changes", () => {
    const { rerender, container } = render(
      <RowBoundary resetKey="turn:1">
        <Boom />
      </RowBoundary>,
    );
    expect(container.querySelector("[data-row-failed]")).not.toBeNull();
    rerender(
      <RowBoundary resetKey="turn:2">
        <p>the frame that completed it</p>
      </RowBoundary>,
    );
    expect(container.querySelector("[data-row-failed]")).toBeNull();
    expect(screen.getByText("the frame that completed it")).toBeDefined();
  });
});

describe("the thread keeps its other turns", () => {
  const errors = captureConsoleError();

  function message(id: string, blocks: unknown[]): ChatMessageView {
    return {
      id,
      session: "s",
      role: "bot",
      at: new Date(NOW).toISOString(),
      author: { instance: "silent-crane", bot: "default" },
      blocks,
    } as unknown as ChatMessageView;
  }

  test("one unrenderable message does not blank the transcript", () => {
    /**
     * A block whose *payload* cannot be read — the class of failure no field
     * guard covers, because the value is there and reading it is what fails.
     */
    const hostile: Record<string, unknown> = { kind: "unknown", name: "surprise" };
    Object.defineProperty(hostile, "payload", {
      enumerable: true,
      get() {
        throw new TypeError("undefined is not an object (evaluating 'text.split')");
      },
    });

    const { container } = render(
      <Thread
        fleetId="fleet"
        instance="silent-crane"
        bot="default"
        botTitle={null}
        agent={null}
        session={null}
        destination={{ state: "known", origin: "portal", detail: null }}
        state="ready"
        messages={[
          message("before", [{ kind: "text", markdown: "the turn above" }]),
          message("broken", [hostile]),
          message("after", [{ kind: "text", markdown: "the turn below" }]),
        ]}
        live={null}
        sending={false}
        historyError={null}
        now={NOW}
        onSend={() => {}}
        onAbort={() => {}}
      />,
    );
    expect(container.textContent).toContain("the turn above");
    expect(container.textContent).toContain("the turn below");
    expect(container.querySelectorAll("[data-row-failed]")).toHaveLength(1);
    expect(errors.logged.some((line) => line.startsWith("chat row failed to render"))).toBe(true);
  });
});
