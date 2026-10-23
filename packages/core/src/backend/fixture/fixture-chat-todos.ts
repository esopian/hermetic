/**
 * Hermes's task list in the fixture (§9.2): one seeded list, and two prompts
 * that drive it live.
 *
 * - `CORVID_TODO_BLOCK` — the `todo_list` call `corvid`'s canonical session
 *   (`sx-corvid-portal`) left behind: 2 of 5 done, one active, a subtask under
 *   it. Its row is the fixture day's, so the list reads as paused and aged.
 * - `E2E_TODO` — the resume seed (the session's current list, if any), then a
 *   plan of five tasks and two updates at rising revisions, each a `todo_list`
 *   running/complete pair and its `todo.updated` notice, ending with work open.
 * - `E2E_TODO_DONE` — a beat, then every item of the current list done and the
 *   last open one cancelled, so the list finishes. A list with nothing open
 *   gets a sentence and no new revision.
 * - `E2E_TODO_SLOW` beside either — the same turn, its beats
 *   `FIXTURE_TODO_SLOW_STEP_MS` apart, so a screenshot run catches it running.
 *
 * Every block goes through the adapter's own mappers (`toolBlock`,
 * `hermesActivity`, `todoSeedBlock`) from upstream-shaped payloads, so the
 * fixture carries exactly what a real box's stream would.
 */
import { hermesActivity } from "../../chat/hermes/hermes-chat-activity.ts";
import { toolBlock } from "../../chat/hermes/hermes-chat-blocks.ts";
import { todoSeedBlock } from "../../chat/hermes/hermes-chat-todos.ts";
import type { ChatBlock, ChatFrame } from "../../schema/index.ts";
import type { TodoSnapshotLike } from "../../shared/todos.ts";
import { usage } from "./fixture-chat-usage.ts";

export const FIXTURE_TODO_TRIGGER = "E2E_TODO";
export const FIXTURE_TODO_DONE_TRIGGER = "E2E_TODO_DONE";
/** The wait between the steps of `E2E_TODO`, so a person can watch the list move. */
export const FIXTURE_TODO_STEP_MS = 900;
/** With this in the prompt too, each step waits long enough to screenshot the running list. */
export const FIXTURE_TODO_SLOW_TRIGGER = "E2E_TODO_SLOW";
export const FIXTURE_TODO_SLOW_STEP_MS = 30_000;

type SequencedFrame = Extract<ChatFrame, { seq: number }>;
type UpstreamItem = { id: string; content: string; status: string; parent?: string };

const result = (todos: readonly UpstreamItem[], revision: number): string => {
  const done = todos.filter((t) => t.status === "completed").length;
  return JSON.stringify({ todos, revision, summary: `${done}/${todos.length} completed` });
};

/** A finished `todo_list` call, as `tool.complete` or a paired history row maps. */
function completed(
  tool_id: string,
  args: unknown,
  todos: readonly UpstreamItem[],
  revision: number,
): ChatBlock {
  return toolBlock(
    { tool_id, name: "todo_list", args, result: result(todos, revision), duration_s: 0.01 },
    null,
    true,
  );
}

export const CORVID_TODO_BLOCK: ChatBlock = (() => {
  const todos: UpstreamItem[] = [
    { id: "1", content: "Read the staged binding", status: "completed" },
    { id: "2", content: "Check the anthropic key on the box", status: "completed" },
    { id: "3", content: "Dry-run the apply", status: "in_progress" },
    { id: "4", content: "Diff the rendered config", status: "pending", parent: "3" },
    { id: "5", content: "Run tonight's apply", status: "pending" },
  ];
  return completed("tl-fixture-corvid-todo", { todos, merge: false }, todos, 3);
})();

/** One step of a todo turn: the running card, its completion and the notice after it. */
function step(
  tool_id: string,
  args: unknown,
  todos: readonly UpstreamItem[],
  revision: number,
): ChatBlock[] {
  const running = toolBlock({ tool_id, name: "todo_list", args }, "running");
  const notice = hermesActivity("todo.updated", { todos, revision });
  return [running, completed(tool_id, args, todos, revision), ...(notice ? [notice] : [])];
}

/** The `E2E_TODO` plan, its ids scoped to the revision it starts at so a rerun plans afresh. */
function planSteps(base: number): ChatBlock[][] {
  const id = (n: string): string => `r${base + 1}-${n}`;
  const plan: UpstreamItem[] = [
    { id: id("1"), content: "Read the current snapshot policy", status: "in_progress" },
    { id: id("2"), content: "Draft the new retention", status: "pending" },
    { id: id("2a"), content: "Pick the retain count", status: "pending", parent: id("2") },
    { id: id("2b"), content: "Pick the interval", status: "pending", parent: id("2") },
    { id: id("3"), content: "Plan and apply", status: "pending" },
  ];
  const second = plan.map((t) =>
    t.id === id("1")
      ? { ...t, status: "completed" }
      : t.id === id("2") || t.id === id("2a")
        ? { ...t, status: "in_progress" }
        : t,
  );
  const third = second.map((t) =>
    t.id === id("2a")
      ? { ...t, status: "completed" }
      : t.id === id("2b")
        ? { ...t, status: "in_progress" }
        : t,
  );
  const changed = (next: UpstreamItem[], prev: UpstreamItem[]) =>
    next.filter((t, i) => t.status !== prev[i]?.status);
  return [
    step(`tl-fixture-todo-${base + 1}`, { todos: plan, merge: false }, plan, base + 1),
    step(
      `tl-fixture-todo-${base + 2}`,
      { todos: changed(second, plan), merge: true },
      second,
      base + 2,
    ),
    step(
      `tl-fixture-todo-${base + 3}`,
      { todos: changed(third, second), merge: true },
      third,
      base + 3,
    ),
  ];
}

/** An item back in upstream's words, `{id, content, status, parent?}`. */
function upstreamItem(t: TodoSnapshotLike["todos"][number]): UpstreamItem {
  const status = t.status === "done" ? "completed" : t.status === "active" ? "in_progress" : t.status;
  return { id: t.id, content: t.content, status, ...(t.parent ? { parent: t.parent } : {}) };
}

/** `E2E_TODO_DONE`'s one step: every item done, the last open one cancelled. */
function finishSteps(current: TodoSnapshotLike): ChatBlock[] {
  const base = current.revision ?? 0;
  const cancel = current.todos.findLast((t) => t.status !== "done" && t.status !== "cancelled");
  const todos: UpstreamItem[] = current.todos.map((t) => ({
    ...upstreamItem(t),
    status: t === cancel || t.status === "cancelled" ? "cancelled" : "completed",
  }));
  return step(`tl-fixture-todo-${base + 1}`, { todos, merge: true }, todos, base + 1);
}

/**
 * The todo turn `prompt` asks for, or null. Each turn is a list of batches; the
 * caller waits `FIXTURE_TODO_STEP_MS` between them. `current` is the session's
 * list as `latestTodoList` reads its transcript, standing in for the resume's
 * `todo_state`.
 */
export function fixtureTodoTurn(
  prompt: string,
  current: () => TodoSnapshotLike | null,
): ((message: string) => SequencedFrame[][]) | null {
  const done = prompt.includes(FIXTURE_TODO_DONE_TRIGGER);
  if (!done && !prompt.includes(FIXTURE_TODO_TRIGGER)) return null;
  return (message) => {
    const list = current();
    let seq = 0;
    const frames = (pieces: readonly (ChatBlock | string)[]): SequencedFrame[] =>
      pieces.flatMap((piece): SequencedFrame[] =>
        typeof piece === "string"
          ? [
              { type: "block", seq: ++seq, message, block: { kind: "text", markdown: "" } },
              { type: "delta", seq: ++seq, message, text: piece },
            ]
          : [{ type: "block", seq: ++seq, message, block: piece }],
      );
    // The resume seed first, as `createChatTurn` yields it, from the upstream
    // document a resume carries (the parser reads upstream's words only).
    const seed = todoSeedBlock(
      list && { todos: list.todos.map(upstreamItem), revision: list.revision },
    );
    const seeded = seed ? frames([seed]) : [];
    const open = list?.todos.some((t) => t.status !== "done" && t.status !== "cancelled");
    const batches: (ChatBlock | string)[][] = done
      ? list && open
        ? [
            ["Finishing the task list."],
            [
              ...finishSteps(list),
              "Every task is done; I dropped the last one, it was no longer needed.",
            ],
          ]
        : [["There is nothing on the task list to finish."]]
      : (() => {
          const [plan = [], second = [], third = []] = planSteps(list?.revision ?? 0);
          return [
            ["Planning the snapshot change.", ...plan],
            [...second, "The current policy keeps 7 snapshots a day apart."],
            [...third, "Retain count picked; the interval is next."],
          ];
        })();
    const out = batches.map((pieces) => frames(pieces));
    out[0]?.unshift(...seeded);
    out.at(-1)?.push({
      type: "done",
      seq: ++seq,
      message,
      usage: usage(3_180, 240, 0.0049, "claude-sonnet-5"),
      incomplete: null,
    });
    return out;
  };
}
