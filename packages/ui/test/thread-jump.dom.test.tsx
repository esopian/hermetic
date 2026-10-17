/**
 * The jump registry (`chat/thread-jump.ts`): registered threads are asked
 * newest first, one that does not hold the id is skipped, and the mounted DOM
 * is the fallback. The last test runs a real `Thread`, whose jump maps a
 * folded source id to its row through `VirtualLog`.
 */
import { act, cleanup, render } from "./dom.ts";
import { afterEach, expect, test } from "bun:test";
import type { ChatBlockView, ChatMessageView } from "../src/api/index.ts";
import { Thread } from "../src/chat/components/Thread.tsx";
import {
  findMessage,
  jumpToMessage,
  registerThreadJump,
  registeredThreadJumps,
} from "../src/chat/thread-jump.ts";

const undo: (() => void)[] = [];
afterEach(() => {
  while (undo.length) undo.pop()?.();
  cleanup();
  document.body.innerHTML = "";
});

function element(id: string, ids = id): HTMLElement {
  const el = document.createElement("article");
  el.dataset.chatMessage = id;
  el.dataset.chatIds = ids;
  el.tabIndex = -1;
  return el;
}

test("asks the newest thread first and skips one that does not hold the id", async () => {
  const asked: string[] = [];
  const older = element("m1");
  const newer = element("m1");
  undo.push(
    registerThreadJump((id) => {
      asked.push(`older:${id}`);
      return Promise.resolve(older);
    }),
  );
  undo.push(
    registerThreadJump((id) => {
      asked.push(`newer:${id}`);
      return id === "m1" ? Promise.resolve(newer) : null;
    }),
  );
  expect(await jumpToMessage("m1")).toBe(newer);
  expect(asked).toEqual(["newer:m1"]);
  asked.length = 0;
  expect(await jumpToMessage("m2")).toBe(older);
  expect(asked).toEqual(["newer:m2", "older:m2"]);
});

test("passes the block through, defaulting to center", async () => {
  const blocks: string[] = [];
  undo.push(
    registerThreadJump((_id, { block }) => {
      blocks.push(block);
      return null;
    }),
  );
  await jumpToMessage("x");
  await jumpToMessage("x", { block: "start" });
  expect(blocks).toEqual(["center", "start"]);
});

test("falls back to the mounted DOM, by own id or a folded id", async () => {
  const article = element("m3", "m1 m2 m3");
  document.body.append(article);
  const scrolled: unknown[] = [];
  article.scrollIntoView = (options?: boolean | ScrollIntoViewOptions) => scrolled.push(options);
  expect(await jumpToMessage("m2")).toBe(article);
  expect(scrolled).toEqual([{ block: "center" }]);
  expect(await jumpToMessage("m3")).toBe(article);
  expect(await jumpToMessage("nope")).toBeNull();
});

test("a thread that cannot reach its row falls back to the DOM", async () => {
  const article = element("m1");
  document.body.append(article);
  undo.push(registerThreadJump(() => Promise.resolve(null)));
  expect(await jumpToMessage("m1")).toBe(article);
});

test("a docked thread is asked only after every main-view thread", async () => {
  const asked: string[] = [];
  const answer = (name: string) => (id: string) => {
    asked.push(name);
    return id === "m1" ? Promise.resolve(element(name)) : null;
  };
  undo.push(registerThreadJump(answer("main")));
  undo.push(registerThreadJump(answer("dock"), { secondary: () => true }));
  expect((await jumpToMessage("m1"))?.dataset.chatMessage).toBe("main");
  expect(asked).toEqual(["main"]);
  asked.length = 0;
  await jumpToMessage("m2");
  expect(asked).toEqual(["main", "dock"]);
});

test("unregistering removes exactly that thread", () => {
  const before = registeredThreadJumps();
  const off = registerThreadJump(() => null);
  expect(registeredThreadJumps()).toBe(before + 1);
  off();
  off();
  expect(registeredThreadJumps()).toBe(before);
});

test("findMessage searches under the root it is given", () => {
  const inside = document.createElement("div");
  inside.append(element("a"));
  document.body.append(inside, element("b"));
  expect(findMessage(inside, "a")?.dataset.chatMessage).toBe("a");
  expect(findMessage(inside, "b")).toBeNull();
});

function msg(id: string, role: "user" | "bot" | "system", blocks: ChatBlockView[]): ChatMessageView {
  return {
    id,
    session: "s1",
    role,
    author: role === "bot" ? { instance: "atlas", bot: "default" } : null,
    at: "2026-09-17T11:00:00Z",
    blocks,
    usage: null,
    error: null,
    incomplete: null,
  } as unknown as ChatMessageView;
}

const text = (markdown: string): ChatBlockView => ({ kind: "text", markdown });

/** The `role: "tool"` row a history read writes; folds into the bot turn after it. */
const toolRow = (n: number): ChatMessageView =>
  msg(`stored:${n}`, "system", [
    {
      kind: "tool",
      name: "terminal",
      tool_id: `call-${n}`,
      status: "ok",
      args: { command: `printf step-${n}` },
      result: "[redacted]",
      render: "terminal",
      duration_ms: 1200,
    } as unknown as ChatBlockView,
  ]);

function mountThread(messages: ChatMessageView[]) {
  return render(
    <Thread
      fleetId="fxtr0001"
      instance="atlas"
      bot="default"
      agent={null}
      session={null}
      destination={{ state: "known", origin: "portal", detail: null }}
      state="ready"
      messages={messages}
      live={null}
      sending={false}
      historyError={null}
      now={Date.parse("2026-09-17T12:00:00Z")}
      onSend={() => {}}
      onAbort={() => {}}
    />,
  );
}

/**
 * Start the jump inside `act`, which flushes the render that mounts and settles
 * the row; the promise resolves in that render's commit, so it is awaited after.
 */
async function jump(id: string): Promise<HTMLElement | null> {
  let pending: Promise<HTMLElement | null> = Promise.resolve(null);
  await act(async () => {
    pending = jumpToMessage(id);
  });
  return pending;
}

test("a mounted Thread registers, and answers with the message inside its row", async () => {
  const before = registeredThreadJumps();
  const view = mountThread([
    msg("u1", "user", [text("hello")]),
    msg("b1", "bot", [text("hi there")]),
    msg("u2", "user", [text("bye")]),
  ]);
  expect(registeredThreadJumps()).toBe(before + 1);
  const found = await jump("b1");
  expect(found?.dataset.chatMessage).toBe("b1");
  expect(found?.closest("[data-vrow]")).not.toBeNull();
  view.unmount();
  expect(registeredThreadJumps()).toBe(before);
});

test("a folded source id resolves to its turn's row and article", async () => {
  mountThread([
    msg("u1", "user", [text("check the disk")]),
    toolRow(1),
    toolRow(2),
    msg("stored:9", "bot", [text("Done")]),
  ]);
  const found = await jump("stored:2");
  expect(found?.dataset.chatIds).toBe("stored:1 stored:2 stored:9");
  // The row is keyed on the turn's first source id, not the one asked for.
  expect(found?.closest<HTMLElement>("[data-vrow]")?.dataset.vrow).toBe("stored:1");
});
