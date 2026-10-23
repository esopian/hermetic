/**
 * The task list's views: the transcript's Tasks rows (their own line while the
 * turn runs, inside the run's group once it settles, opening the sheet on
 * their change), the pinned strip expanded and folded, the sheet, and the chip
 * left when nothing is pinned.
 */
import { latestTodoList, todoLifecycle, type TodoView } from "@hermetic/core/shared";
import { fireEvent, screen } from "@testing-library/react-native";
import * as ReactNative from "react-native";
import { View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { TaskSheet } from "../../src/chat/TaskSheet.tsx";
import { TasksChip, TaskStrip } from "../../src/chat/TaskStrip.tsx";
import { TurnRow } from "../../src/chat/TurnRow.tsx";
import { turnRows } from "../../src/client/chat-turns.ts";
import { previousLists, taskStrip } from "../../src/client/task-list.ts";
import { msg, todoTool, tool } from "../helpers/fixtures.ts";
import { NOW, renderUi, scope } from "../helpers/render.tsx";

const METRICS = {
  frame: { x: 0, y: 0, width: 393, height: 852 },
  insets: { top: 59, left: 0, right: 0, bottom: 34 },
};

const PLAN = todoTool(
  [
    ["1", "Read the policy", "done"],
    ["2", "Draft the change", "active"],
    ["2a", "Pick the count", "pending", "2"],
    ["3", "Apply it", "pending"],
    ["4", "Announce it", "pending"],
  ],
  2,
);

function list(over: { busy?: boolean; live?: boolean; view?: TodoView } = {}) {
  const found = latestTodoList([msg({ at: "2026-10-13T11:59:00.000Z", blocks: [PLAN] })]);
  if (!found) throw new Error("no list");
  const life = todoLifecycle({
    snapshot: found.snapshot,
    busy: over.busy ?? false,
    live: over.live ?? false,
    updatedAt: found.at,
    now: NOW,
    view: over.view ?? {},
  });
  return { found, life };
}

async function drawTurn(streaming: boolean, open = jest.fn()) {
  const message = msg({ blocks: [tool({ status: "ok" }), PLAN, { kind: "text", markdown: "On it." }] });
  const [row] = turnRows([message], NOW);
  if (!row) throw new Error("no row");
  await renderUi(
    <View>
      <TurnRow row={row} instance="atlas" bot="scribe" now={NOW} streaming={streaming} />
    </View>,
    scope({ tasks: { prevOf: previousLists([message]), open } }),
  );
  return open;
}

describe("Tasks rows in the transcript", () => {
  test("while the turn runs, the todo call is its own row, and opens the sheet on it", async () => {
    const open = await drawTurn(true);
    const row = screen.getByLabelText("Tasks: Planned 5 tasks, 1 of 5 done");
    await fireEvent.press(row);
    expect(open).toHaveBeenCalledWith(PLAN);
  });

  test("settled, it folds into the run's head as a task update", async () => {
    await drawTurn(false);
    expect(screen.queryByLabelText(/^Tasks:/)).toBeNull();
    await fireEvent.press(screen.getByLabelText("Tools complete, 1 tool · 1 task update"));
    expect(screen.getByLabelText("Tasks: Planned 5 tasks, 1 of 5 done")).toBeTruthy();
  });
});

describe("the pinned strip", () => {
  const handlers = () => ({ onToggle: jest.fn(), onOpen: jest.fn(), onHide: jest.fn() });

  test("running: the window around the running item, All N tasks opens the sheet, the head folds", async () => {
    const { found, life } = list({ busy: true, live: true });
    const on = handlers();
    await renderUi(
      <TaskStrip
        state={taskStrip({ found, life, folded: false, observing: true })}
        snapshot={found.snapshot}
        pulse={life.pulse}
        {...on}
      />,
    );
    expect(screen.getByLabelText("Running: Draft the change")).toBeTruthy();
    expect(screen.getByLabelText("Done: Read the policy")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("All 5 tasks"));
    expect(on.onOpen).toHaveBeenCalled();
    await fireEvent.press(screen.getByLabelText("Tasks 1 of 5, running: Draft the change"));
    expect(on.onToggle).toHaveBeenCalled();
  });

  test("paused: one line that opens the sheet, and Hide", async () => {
    const { found, life } = list();
    const on = handlers();
    const previous = ReactNative.Dimensions.get("window");
    ReactNative.Dimensions.set({ window: { ...previous, fontScale: 1 } });
    await renderUi(
      <TaskStrip
        state={taskStrip({ found, life, folded: false, observing: true })}
        snapshot={found.snapshot}
        pulse={life.pulse}
        {...on}
      />,
    );
    expect(screen.getByText("▷\uFE0E Draft the change")).toBeTruthy();
    // Archivo has no ▷: the glyph is drawn in the mono face.
    expect(screen.getByText("▷\uFE0E")).toHaveStyle({ fontFamily: "JetBrainsMono-Bold" });
    expect(screen.getByText("paused")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("Hide the task list"));
    expect(on.onHide).toHaveBeenCalled();
    await fireEvent.press(screen.getByLabelText("Tasks 1 of 5, paused: Draft the change"));
    expect(on.onOpen).toHaveBeenCalled();
    await screen.unmount();
    ReactNative.Dimensions.set({ window: previous });
  });

  test("finished: the check is drawn apart in the mono bold face", async () => {
    const { found, life } = list();
    const done = { ...life, strip: "finished" as const, cancelled: 0 };
    await renderUi(
      <TaskStrip
        state={taskStrip({ found, life: done, folded: false, observing: true })}
        snapshot={found.snapshot}
        pulse={false}
        {...handlers()}
      />,
    );
    expect(screen.getByText(/^✓\uFE0E\s*1\/5 done$/)).toHaveStyle({ fontFamily: "JetBrainsMono-Bold" });
    await screen.unmount();
  });

  test("paused at a large text size: the line drops its meta, the label keeps it", async () => {
    // The jest window's fontScale is 2.
    const { found, life } = list();
    await renderUi(
      <TaskStrip
        state={taskStrip({ found, life, folded: false, observing: true })}
        snapshot={found.snapshot}
        pulse={life.pulse}
        {...handlers()}
      />,
    );
    expect(screen.queryByText("paused")).toBeNull();
    expect(screen.getByLabelText("Tasks 1 of 5, paused: Draft the change")).toBeTruthy();
  });

  test("paused: VoiceOver reaches Hide as an action on the one strip element", async () => {
    const { found, life } = list();
    const on = handlers();
    await renderUi(
      <TaskStrip
        state={taskStrip({ found, life, folded: false, observing: true })}
        snapshot={found.snapshot}
        pulse={life.pulse}
        {...on}
      />,
    );
    const strip = screen.getByLabelText("Tasks 1 of 5, paused: Draft the change");
    expect(strip.props.accessibilityActions).toEqual([
      { name: "activate", label: "Open the task list" },
      { name: "hide", label: "Hide the task list" },
    ]);
    await fireEvent(strip, "accessibilityAction", { nativeEvent: { actionName: "hide" } });
    expect(on.onHide).toHaveBeenCalled();
    expect(on.onOpen).not.toHaveBeenCalled();
    await fireEvent(strip, "accessibilityAction", { nativeEvent: { actionName: "activate" } });
    expect(on.onOpen).toHaveBeenCalled();
  });

  test("running, folded: no Hide action", async () => {
    const { found, life } = list({ busy: true, live: true });
    await renderUi(
      <TaskStrip
        state={taskStrip({ found, life, folded: true, observing: true })}
        snapshot={found.snapshot}
        pulse={life.pulse}
        {...handlers()}
      />,
    );
    expect(screen.getByText("▶\uFE0E Draft the change")).toBeTruthy();
    const strip = screen.getByLabelText("Tasks 1 of 5, running: Draft the change");
    expect(strip.props.accessibilityActions).toBeUndefined();
  });

  test("nothing pinned: the chip under the last turn says the list was hidden", async () => {
    const { found, life } = list({ view: { hidden: 2 } });
    expect(taskStrip({ found, life, folded: false, observing: true }).kind).toBe("none");
    const onPress = jest.fn();
    await renderUi(<TasksChip found={found} phase={life.phase} onPress={onPress} />);
    await fireEvent.press(screen.getByLabelText("Tasks 1 of 5, hidden from the bar"));
    expect(onPress).toHaveBeenCalled();
  });
});

describe("the Tasks sheet", () => {
  test("the whole tree, its counts and source, read-only", async () => {
    const { found, life } = list();
    await renderUi(
      <SafeAreaProvider initialMetrics={METRICS}>
        <TaskSheet
          visible
          found={found}
          life={life}
          observing
          now={NOW}
          flash={{ ids: new Set(["2"]), key: 1 }}
          onClose={jest.fn()}
        />
      </SafeAreaProvider>,
    );
    expect(screen.getByText("1/5")).toBeTruthy();
    expect(screen.getByText("1 active · 3 open · paused")).toBeTruthy();
    expect(screen.getByText(/^rev 2 · updated /)).toBeTruthy();
    expect(screen.getByLabelText("Open: Pick the count")).toBeTruthy();
    expect(screen.getByText(/Read-only: Hermetic shows the agent's list/)).toBeTruthy();
  });
});
