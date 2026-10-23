/** The fixture's task list: corvid's seeded list, and `E2E_TODO` / `E2E_TODO_DONE` driving it live. */
import { expect, test } from "bun:test";
import { fixtureChatClient } from "../src/backend/fixture/fixture-chat.ts";
import { FIXTURE_TODO_STEP_MS } from "../src/backend/fixture/fixture-chat-todos.ts";
import type { BoxAddress } from "../src/chat/hermes/hermes-chat.ts";
import { ChatMessage, type ChatBlock, type ChatFrame } from "../src/schema/index.ts";
import { latestTodoList, todoDiff, todoFraction, todoLifecycle } from "../src/shared/index.ts";

const BOX: BoxAddress = {
  instance: "corvid",
  baseUrl: "https://fxtr0001-corvid.fixture.ts.net/",
  fleet_id: "fxtr0001",
};
const SESSION = "sx-corvid-portal";

function setup() {
  const waits: number[] = [];
  const client = fixtureChatClient({
    delayMs: 0,
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });
  const send = async (text: string): Promise<ChatBlock[]> => {
    const frames: ChatFrame[] = [];
    for await (const f of client.send(BOX, "default", text, { session: SESSION })) frames.push(f);
    expect(frames.at(-1)?.type).toBe("done");
    return frames.flatMap((f) => (f.type === "block" ? [f.block] : []));
  };
  const current = async () =>
    latestTodoList(await client.history(BOX, "default", { session: SESSION }));
  return { client, waits, send, current };
}

test("corvid's canonical session carries a paused, aged 2-of-5 list", async () => {
  const { current } = setup();
  const found = await current();
  expect(found?.snapshot && todoFraction(found.snapshot)).toEqual({ done: 2, total: 5 });
  expect(found?.snapshot.todos.filter((t) => t.status === "active")).toHaveLength(1);
  expect(found?.snapshot.todos.some((t) => t.parent)).toBe(true);
  const life = todoLifecycle({
    snapshot: found?.snapshot ?? null,
    busy: false,
    live: true,
    updatedAt: found?.at ?? null,
    now: Date.parse("2026-09-17T12:00:00.000Z"),
    view: {},
  });
  expect(life).toMatchObject({ phase: "paused", strip: "paused", aged: "2h" });
});

test("E2E_TODO: seed, a plan and two updates a beat apart, then into history", async () => {
  const { send, waits, current } = setup();
  const blocks = await send("E2E_TODO");
  expect(blocks[0]).toMatchObject({
    kind: "activity",
    key: "tasks",
    role: "status",
    todos: { revision: 3 },
  });
  // The seed restates the session's list as it stands: 2 of 5, one active.
  const seed = blocks[0]?.kind === "activity" ? blocks[0].todos : null;
  expect(seed && todoFraction(seed)).toEqual({ done: 2, total: 5 });
  expect(seed?.todos.filter((t) => t.status === "active")).toHaveLength(1);
  const lists = blocks.flatMap((b) => (b.kind === "tool" && b.todos ? [b.todos] : []));
  expect(lists.map((l) => l.revision)).toEqual([4, 5, 6]);
  expect(todoDiff(null, lists[0] ?? { todos: [], revision: null })).toBe("Planned 5 tasks");
  expect(lists[0]?.todos.filter((t) => t.parent)).toHaveLength(2);
  expect(blocks.filter((b) => b.kind === "activity" && b.key === "tasks" && b.todos)).toHaveLength(4);
  expect(waits).toEqual([FIXTURE_TODO_STEP_MS, FIXTURE_TODO_STEP_MS]);

  const found = await current();
  expect(found?.snapshot.revision).toBe(6);
  expect(found?.snapshot.todos.some((t) => t.status === "active")).toBe(true);
});

test("E2E_TODO_DONE finishes the current list, one item cancelled", async () => {
  const { send, current, client, waits } = setup();
  await send("E2E_TODO");
  waits.length = 0;
  const blocks = await send("E2E_TODO_DONE");
  // One beat before the finishing update, so a head can look away first.
  expect(waits).toEqual([FIXTURE_TODO_STEP_MS]);
  const last = blocks.flatMap((b) => (b.kind === "tool" && b.todos ? [b.todos] : [])).at(-1);
  expect(last?.revision).toBe(7);
  expect(last?.todos.every((t) => t.status === "done" || t.status === "cancelled")).toBe(true);
  expect(last?.todos.filter((t) => t.status === "cancelled")).toHaveLength(1);
  expect((await current())?.snapshot.revision).toBe(7);
  const rows = await client.history(BOX, "default", { session: SESSION });
  for (const row of rows) expect(() => ChatMessage.parse(row)).not.toThrow();
  // The notices are events, not rows: history holds the tool calls alone.
  expect(rows.flatMap((r) => r.blocks).some((b) => b.kind === "activity" && b.key === "tasks")).toBe(
    false,
  );
});

test("E2E_TODO_DONE on a finished list says so and adds no revision", async () => {
  const { send, current } = setup();
  await send("E2E_TODO_DONE");
  const blocks = await send("E2E_TODO_DONE");
  expect(blocks.some((b) => b.kind === "tool")).toBe(false);
  expect((await current())?.snapshot.revision).toBe(4);
});
