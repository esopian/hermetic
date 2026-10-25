/**
 * Kanban in the chat: a Hermes card notice drawn as an event row with an
 * "Open task" link, and a `kanban_create` call drawn as a task card.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "./dom.ts";
import type { ChatBlockOf } from "../src/api/index.ts";
import { Block } from "../src/chat/components/blocks/index.tsx";
import { readKanbanCreateResult } from "@hermetic/core/shared";
import { ProcessEventContext, ProcessEventRow } from "../src/chat/components/blocks/ProcessEvent.tsx";
import { OpenKanbanTaskContext } from "../src/work/open-task.ts";
import { at, eventOf } from "./process-event-fixtures.ts";
import type { ReactNode } from "react";

afterEach(cleanup);

const ID = "t_ab12cd34";

function withOpener(children: ReactNode) {
  const opened: [string, string][] = [];
  const view = render(
    <OpenKanbanTaskContext.Provider value={{ open: (i, t) => opened.push([i, t]) }}>
      <ProcessEventContext.Provider
        value={{
          fleetId: "fxtr0001",
          instance: "kestrel",
          bot: "default",
          status: "pending",
          starts: new Map(),
          anchors: new Map(),
        }}
      >
        {children}
      </ProcessEventContext.Provider>
    </OpenKanbanTaskContext.Provider>,
  );
  return { opened, view };
}

describe("kanban notice row", () => {
  test("glyph, card, assignee, what happened, summary, and Open task", () => {
    const event = eventOf({
      event: "kanban",
      outcome: "ok",
      process_id: null,
      status: null,
      exit_code: null,
      command: null,
      raw: `✔ @worker Kanban ${ID} done — Ship the notes\nWrote CHANGELOG.md`,
      notice: {
        task_id: ID,
        assignee: "worker",
        board: null,
        kanban_kind: "completed",
        detail: "Ship the notes",
        body: "Wrote CHANGELOG.md",
      },
    });
    const { opened, view } = withOpener(
      <ProcessEventRow entry={{ event, row: { message: { id: "m1", at: at(0) } } }} />,
    );
    expect(view.container.querySelector(".ch-ev-sq.ok")).not.toBeNull();
    expect(screen.getByText(`✔ Kanban ${ID}`)).toBeTruthy();
    expect(screen.getByText("@worker")).toBeTruthy();
    expect(screen.getByText("done — Ship the notes")).toBeTruthy();
    expect(screen.getByText("Wrote CHANGELOG.md")).toBeTruthy();
    expect(screen.queryByText("You")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open task" }));
    expect(opened).toEqual([["kestrel", ID]]);
  });

  test("a gave-up card is a bad square", () => {
    const event = eventOf({
      event: "kanban",
      outcome: "failed",
      raw: `✖ Kanban ${ID} gave up after repeated spawn failures`,
      notice: { task_id: ID, kanban_kind: "gave_up" },
    });
    const { view } = withOpener(
      <ProcessEventRow entry={{ event, row: { message: { id: "m2", at: at(0) } } }} />,
    );
    expect(view.container.querySelector(".ch-ev-sq.bad")).not.toBeNull();
    expect(screen.getByText("gave up after repeated spawn failures")).toBeTruthy();
  });
});

describe("kanban_create card", () => {
  const tool = (result: unknown): ChatBlockOf<"tool"> => ({
    kind: "tool",
    name: "kanban_create",
    args: { title: "Ship the notes" },
    result,
    status: "ok",
    render: "kanban_task",
  });

  test("reads the task id from an object or a JSON string, else null", () => {
    expect(readKanbanCreateResult(tool({ task_id: ID }))).toEqual({ task_id: ID });
    expect(readKanbanCreateResult(tool(JSON.stringify({ task_id: ID })))).toEqual({ task_id: ID });
    expect(readKanbanCreateResult(tool("not json"))).toBeNull();
    expect(readKanbanCreateResult(tool({ error: "kanban off" }))).toBeNull();
  });

  test("draws a task card that opens the task", () => {
    const { opened } = withOpener(<Block block={tool({ task_id: ID })} instance="kestrel" />);
    expect(screen.getByText(ID)).toBeTruthy();
    expect(screen.getByText("Ship the notes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(opened).toEqual([["kestrel", ID]]);
  });
});
