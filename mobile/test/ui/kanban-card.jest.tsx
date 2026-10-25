/**
 * A filed kanban card in the conversation (`blocks/KanbanCard.tsx`): drawn as
 * its own card, not a tool step, read from the box's board through the
 * gateway, and its sheet answers a blocked card with Unblock.
 */
import { act, fireEvent, screen } from "@testing-library/react-native";
import type { ReactElement } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Block } from "../../src/chat/blocks/Block.tsx";
import { sections } from "../../src/client/chat-activity.ts";
import { FleetContext, type FleetContextValue } from "../../src/fleet/FleetProvider.tsx";
import { flush } from "../helpers/fakes.ts";
import { tool } from "../helpers/fixtures.ts";
import { NOW, renderUi, scope } from "../helpers/render.tsx";

const ID = "t_0000abcd";
const created = tool({
  tool_id: "k1",
  name: "kanban_create",
  args: { title: "Migrate the DB" },
  status: "ok",
  render: "kanban_task",
  result: JSON.stringify({ task_id: ID }),
});

function fakeRest(status = "blocked") {
  return jest.fn(async (input: { method: string; path: string; body?: unknown }) => {
    if (input.method === "GET")
      return {
        task: {
          id: ID,
          title: "Migrate the DB",
          status,
          assignee: "scribe",
          block_kind: "needs_input",
          last_failure_error: "Which region?",
          created_at: 1,
        },
        comments: [{ id: 1, author: "scribe", body: "Which region?", created_at: 2 }],
        runs: [],
      };
    return { task: { id: ID, title: "Migrate the DB", status: "ready" } };
  });
}

async function draw(ui: ReactElement, rest: ReturnType<typeof fakeRest>) {
  const fleet = { client: { gateway: { rest } } } as unknown as FleetContextValue;
  const metrics = {
    frame: { x: 0, y: 0, width: 393, height: 852 },
    insets: { top: 59, left: 0, right: 0, bottom: 34 },
  };
  await renderUi(
    <SafeAreaProvider initialMetrics={metrics}>
      <FleetContext.Provider value={fleet}>{ui}</FleetContext.Provider>
    </SafeAreaProvider>,
    scope(),
  );
  await act(flush);
}

test("a filed card stands alone instead of folding into Tools complete", () => {
  const list = sections([tool({ tool_id: "a", status: "ok" }), created]);
  expect(list.map((s) => s.activity)).toEqual([true, false]);
});

test("the card reads the board and shows status, title, assignee and the live line", async () => {
  const rest = fakeRest();
  await draw(<Block block={created} now={NOW} />, rest);
  expect(rest).toHaveBeenCalledWith(
    expect.objectContaining({
      instance: "atlas",
      method: "GET",
      path: `/api/plugins/kanban/tasks/${ID}`,
    }),
  );
  expect(screen.getByText(ID)).toBeTruthy();
  expect(screen.getByLabelText("Status needs input")).toBeTruthy();
  expect(screen.getByText("Migrate the DB")).toBeTruthy();
  expect(screen.getByText(/@scribe/)).toBeTruthy();
  expect(screen.getByText("Which region?")).toBeTruthy();
  expect(screen.getByText(/Blocked · 6 of 8/)).toBeTruthy();
});

test("Open shows the sheet, and Unblock posts the answer, then moves the card to Ready", async () => {
  const rest = fakeRest();
  await draw(<Block block={created} now={NOW} />, rest);
  await fireEvent.press(screen.getByLabelText(`Open task ${ID}`));
  await act(flush);
  await act(flush);
  await fireEvent.changeText(screen.getByLabelText(`Answer on task ${ID}`), "eu-west-1");
  await fireEvent.press(screen.getByText("Unblock"));
  await act(flush);
  const writes = rest.mock.calls.map(([c]) => c).filter((c) => c.method !== "GET");
  expect(writes).toEqual([
    expect.objectContaining({
      method: "POST",
      path: `/api/plugins/kanban/tasks/${ID}/comments`,
      body: { body: "eu-west-1", author: "hermetic" },
    }),
    expect.objectContaining({
      method: "PATCH",
      path: `/api/plugins/kanban/tasks/${ID}`,
      body: { status: "ready" },
    }),
  ]);
  expect(screen.getByText("Unblocked: back to Ready.")).toBeTruthy();
});

test("a board that 404s reads as not readable there, not as a box that is down", async () => {
  const rest = jest.fn(async () => {
    throw Object.assign(new Error("kestrel: dashboard GET failed (HTTP 404)"), {
      code: "CHAT_PROTOCOL",
    });
  }) as unknown as ReturnType<typeof fakeRest>;
  await draw(<Block block={created} now={NOW} />, rest);
  expect(screen.getByText(/not readable on atlas/)).toBeTruthy();
  expect(screen.queryByText(/not answering/)).toBeNull();
});
