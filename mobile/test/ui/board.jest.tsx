/**
 * The board screen: every listened box's cards in the desktop queue's groups,
 * lenses and filter, a board that is off or not answering, opening a card, and
 * filing one. The boxes are a scripted dashboard (`rest`), the way the phone
 * reaches them.
 */
import { act, fireEvent, screen } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import Board from "../../app/board.tsx";
import { boardCards, boardSections, lensCounts } from "../../src/client/board-list.ts";
import type { InstanceBoard } from "../../src/client/kanban.ts";
import { FleetContext, type FleetContextValue } from "../../src/fleet/FleetProvider.tsx";
import { flush } from "../helpers/fakes.ts";
import { renderUi } from "../helpers/render.tsx";

jest.mock("expo-router", () => {
  const { useEffect } = require("react");
  return {
    router: { push: jest.fn(), back: jest.fn() },
    useFocusEffect: (fn: () => undefined | (() => void)) => useEffect(fn, [fn]),
  };
});

const task = (over: Record<string, unknown>) => ({
  id: "t_00000001",
  title: "A card",
  status: "ready",
  assignee: "scribe",
  priority: 0,
  created_at: 100,
  ...over,
});

/** The dashboard's `GET /board` answer: one column per status. */
const columns = (tasks: Record<string, unknown>[]) => ({
  columns: [...new Set(tasks.map((t) => t.status as string))].map((name) => ({
    name,
    tasks: tasks.filter((t) => t.status === name).map(({ status: _, ...t }) => t),
  })),
});

const ATLAS = [
  task({
    id: "t_0000000a",
    title: "Which region?",
    status: "blocked",
    block_kind: "needs_input",
    last_failure_error: "Pick a region",
  }),
  task({ id: "t_0000000b", title: "Write the digest", status: "running" }),
  task({ id: "t_0000000c", title: "Rotate keys", status: "ready", priority: 2 }),
  task({ id: "t_0000000d", title: "Old chore", status: "done" }),
];

function fakeRest() {
  return jest.fn(async (input: { instance: string; method: string; path: string; body?: unknown }) => {
    if (input.instance === "kestrel")
      throw Object.assign(new Error("kestrel: dashboard GET failed (HTTP 404)"), {
        code: "CHAT_PROTOCOL",
      });
    if (input.method === "POST" && input.path.endsWith("/tasks"))
      return { task: { id: "t_0000000e", title: "New", status: "ready", created_at: 1 } };
    if (input.path.endsWith("/profiles"))
      return { profiles: [{ name: "default" }, { name: "scribe" }] };
    if (input.path.endsWith("/board")) return columns(ATLAS);
    return { task: ATLAS[0], comments: [], runs: [], events: [] };
  });
}

async function draw(rest = fakeRest()) {
  const state = { link: { label: "main" } };
  const ctx = {
    client: { gateway: { rest } },
    fleet: { listened: () => ["atlas", "kestrel"], subscribe: () => () => {}, getState: () => state },
  } as unknown as FleetContextValue;
  const metrics = {
    frame: { x: 0, y: 0, width: 393, height: 852 },
    insets: { top: 59, left: 0, right: 0, bottom: 34 },
  };
  await renderUi(
    <SafeAreaProvider initialMetrics={metrics}>
      <FleetContext.Provider value={ctx}>
        <Board />
      </FleetContext.Provider>
    </SafeAreaProvider>,
  );
  for (let i = 0; i < 5; i++) await act(flush);
  return rest;
}

describe("boardSections", () => {
  const boards: InstanceBoard[] = [
    { instance: "atlas", state: "on", reason: null, tasks: ATLAS as never },
  ];
  const cards = boardCards(boards);

  test("groups like the desktop queue, needs-you first, done only in the all lens", () => {
    const open = boardSections(cards, "open", "");
    expect(open.map((s) => [s.label, s.data.map((c) => c.id)])).toEqual([
      ["Needs you", ["t_0000000a"]],
      ["Agents working", ["t_0000000b"]],
      ["Queued", ["t_0000000c"]],
    ]);
    expect(boardSections(cards, "all", "").at(-1)?.label).toBe("Done");
    expect(lensCounts(cards)).toEqual({ you: 1, open: 3, all: 4 });
  });

  test("the filter matches title, id, instance and assignee; Needs you always shows", () => {
    expect(boardSections(cards, "open", "rotate").map((s) => s.label)).toEqual(["Needs you", "Queued"]);
    expect(boardSections(cards, "you", "zzz")).toEqual([
      expect.objectContaining({ label: "Needs you", data: [] }),
    ]);
  });
});

test("the screen lists each group's cards and says why a box has no board", async () => {
  await draw();
  expect(screen.getByText("Needs you")).toBeTruthy();
  expect(screen.getByText("Which region?")).toBeTruthy();
  expect(screen.getByText("Pick a region")).toBeTruthy();
  expect(screen.getByText("Rotate keys")).toBeTruthy();
  expect(screen.queryByText("Old chore")).toBeNull();
  expect(screen.getByText(/kanban plugin is off on kestrel/)).toBeTruthy();
  expect(screen.getByText("hermes plugins enable kanban")).toBeTruthy();

  await fireEvent.press(screen.getByLabelText("4 all"));
  await act(flush);
  expect(screen.getByText("Done")).toBeTruthy();
  expect(screen.getByText("Old chore")).toBeTruthy();
});

test("New task files the card on the picked board and opens it", async () => {
  const rest = await draw();
  await fireEvent.press(screen.getByLabelText("New task"));
  for (let i = 0; i < 3; i++) await act(flush);
  await fireEvent.changeText(screen.getByLabelText("Title"), "Ship the board");
  await fireEvent.press(screen.getByLabelText("@scribe"));
  await fireEvent.press(screen.getByLabelText("Triage first"));
  await fireEvent.press(screen.getByLabelText("Create task"));
  for (let i = 0; i < 3; i++) await act(flush);
  const post = rest.mock.calls.map(([c]) => c).find((c) => c.method === "POST");
  expect(post).toEqual(
    expect.objectContaining({
      instance: "atlas",
      path: "/api/plugins/kanban/tasks",
      body: expect.objectContaining({ title: "Ship the board", assignee: "scribe", triage: true }),
    }),
  );
  expect(screen.getByText("Task t_0000000e")).toBeTruthy();
});
