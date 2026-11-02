/**
 * The `/btw` card against the provider (§9.2 A side question): a failure of
 * any shape lands on the card, an empty answer still says something, an
 * answer finds its card in the undo strip, and the strip is gone after 8 s
 * on the store's clock (`fake-clock.ts`). Plus the pure helpers of
 * `chat-btw.ts`.
 */
import { act, cleanup, render, screen, userEvent, waitFor } from "./dom.ts";
import { afterEach, expect, test } from "bun:test";
import type { ChatBtwResult, ChatMessageView } from "../src/api/index.ts";
import { BTW_UNDO_MS, quoteBtw, snapshotOf, snapshotReply } from "../src/chat/chat-btw.ts";
import { fresh } from "../src/chat/chat-conversation-record.ts";
import type { BtwCard } from "../src/chat/chat-btw.ts";
import { ChatProvider } from "../src/chat/chat-state.tsx";
import { ChatView } from "../src/chat/components/ChatView.tsx";
import { harness, type Harness } from "./chat-observe-fixtures.tsx";
import { fakeClock, type FakeClock } from "./fake-clock.ts";

afterEach(cleanup);

const card = () => screen.queryByRole("dialog", { name: "Side question" });
const strip = () => document.querySelector<HTMLElement>(".ch-btw-undo");

async function mount(h: Harness, clock?: FakeClock): Promise<HTMLTextAreaElement> {
  const view = render(
    <ChatProvider api={h.api} timing={clock?.timing}>
      <ChatView />
    </ChatProvider>,
  );
  return await waitFor(() => {
    const node = view.container.querySelector(".ch-input") as HTMLTextAreaElement | null;
    expect(node).not.toBeNull();
    expect(node!.disabled).toBe(false);
    return node!;
  });
}

const answer = (text: string, over: Partial<ChatBtwResult> = {}): ChatBtwResult => ({
  instance: "atlas",
  bot: "atlas",
  task_id: "t1",
  question: text,
  answer: `answer to ${text}`,
  error: false,
  ...over,
});

test("an ask that throws rather than rejects lands on the card, and the input is cleared", async () => {
  const h = harness();
  h.api.askBtw = () => {
    throw new Error("no fleet target");
  };
  const input = await mount(h);
  await userEvent.type(input, "/btw what changed?{Enter}");
  await waitFor(() =>
    expect(card()?.querySelector('[role="alert"]')?.textContent).toBe("no fleet target"),
  );
  expect(input.value).toBe("");
  expect(h.calls.send).toBe(0);
});

test("an empty answer reads (no answer); idle, the card sees the whole chat", async () => {
  const h = harness();
  h.api.askBtw = async (_i, _b, text) => answer(text, { answer: "" });
  const input = await mount(h);
  await userEvent.type(input, "/btw what changed?{Enter}");
  await waitFor(() => expect(card()?.textContent ?? "").toContain("(no answer)"));
  expect(card()?.textContent ?? "").toContain("sees the whole chat");
  expect(card()?.textContent ?? "").not.toContain("not the running turn");
});

test("a pending card dismissed keeps waiting, and Undo shows the answer that came meanwhile", async () => {
  const h = harness();
  let release: (r: ChatBtwResult) => void = () => {};
  h.api.askBtw = (_i, _b, text) =>
    new Promise<ChatBtwResult>((resolve) => {
      release = () => resolve(answer(text));
    });
  const input = await mount(h);
  await userEvent.type(input, "/btw slow?{Enter}");
  expect(card()?.textContent ?? "").toContain("Answering from the conversation so far");
  await userEvent.type(input, "{Escape}");
  expect(Boolean(card())).toBe(false);
  await act(async () => release(answer("slow?")));
  await userEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(card()?.textContent ?? "").toContain("answer to slow?");
});

test("the undo strip counts down and is gone after 8 s", async () => {
  const h = harness();
  h.api.askBtw = async (_i, _b, text) => answer(text);
  const clock = fakeClock();
  const input = await mount(h, clock);
  await userEvent.type(input, "/btw what changed?{Enter}");
  await waitFor(() => expect(card()?.textContent ?? "").toContain("answer to what changed?"));
  await userEvent.type(input, "{Escape}");
  expect(strip()?.textContent ?? "").toContain("8s");
  await clock.advance(BTW_UNDO_MS - 1_000);
  expect(strip()?.textContent ?? "").toContain("1s");
  await clock.advance(1_000);
  expect(Boolean(strip())).toBe(false);
  expect(Boolean(card())).toBe(false);
});

const msg = (over: Partial<ChatMessageView>): ChatMessageView =>
  ({
    id: over.id ?? "m",
    session: "s",
    role: "bot",
    author: null,
    at: "2026-10-30T10:00:00.000Z",
    blocks: [{ kind: "text", markdown: "hello" }],
    usage: null,
    error: null,
    incomplete: null,
    ...over,
  }) as ChatMessageView;

const at = (rows: ChatMessageView[], working: boolean, segments: string[] = []) =>
  snapshotReply(rows, working, segments)?.at ?? null;

test("snapshotReply is the last finished bot reply, before a running turn's prompt", () => {
  const rows = [
    msg({ id: "a", at: "2026-10-30T10:00:00.000Z" }),
    msg({ id: "b", at: "2026-10-30T10:01:00.000Z", role: "user" }),
    msg({ id: "c", at: "2026-10-30T10:02:00.000Z" }),
    msg({ id: "d", at: "2026-10-30T10:03:00.000Z", role: "user" }),
    msg({ id: "e", at: "2026-10-30T10:04:00.000Z", blocks: [{ kind: "text", markdown: "partial" }] }),
  ];
  expect(at(rows, true)).toBe("2026-10-30T10:02:00.000Z");
  expect(at(rows, false)).toBe("2026-10-30T10:04:00.000Z");
  expect(at([msg({ incomplete: true })], false)).toBeNull();
  expect(at([], false)).toBeNull();
});

test("a steer is not the running turn's prompt, and a steered-off segment is not a reply", () => {
  const rows = [
    msg({ id: "a", at: "2026-10-30T10:00:00.000Z" }),
    msg({ id: "p", at: "2026-10-30T10:01:00.000Z", role: "user" }),
    msg({ id: "seg", at: "2026-10-30T10:02:00.000Z" }),
    msg({ id: "local:steer:x", at: "2026-10-30T10:03:00.000Z", role: "user" }),
    msg({ id: "s2", at: "2026-10-30T10:03:30.000Z", role: "user", steered: true }),
  ];
  expect(at(rows, true, ["seg"])).toBe("2026-10-30T10:00:00.000Z");
});

test("a branch cuts at the last reply's id only when that row is the box's own", () => {
  const record = fresh({ instance: "atlas", bot: "atlas", session: null });
  const prompt = msg({ id: "S:2", session: "S", at: "2026-10-30T10:01:00.000Z", role: "user" });
  record.messages = [msg({ id: "S:1", session: "S", at: "2026-10-30T10:00:00.000Z" }), prompt];
  // Idle: the last reply is a box row, so the cut is sent.
  expect(snapshotOf(record)).toEqual({
    midTurn: false,
    until: "2026-10-30T10:00:00.000Z",
    untilMessage: "S:1",
  });
  record.sending = true;
  expect(snapshotOf(record)).toMatchObject({ midTurn: true, untilMessage: "S:1" });
  // A previous turn's kept live reply (`<instance>:<clock>`) and a local echo cut nothing.
  record.sending = false;
  record.messages = [prompt, msg({ id: "atlas:1730282400000", session: "S" })];
  expect(snapshotOf(record).untilMessage).toBeNull();
  record.messages = [prompt, msg({ id: "local:x", session: "S" })];
  expect(snapshotOf(record).untilMessage).toBeNull();
});

test("quoteBtw quotes the question and every answer line ahead of the draft", () => {
  const c = { question: "q?", answer: "one\n\ntwo" } as BtwCard;
  expect(quoteBtw(c, "typed")).toBe("> **btw:** q?\n>\n> one\n>\n> two\n\ntyped");
  expect(quoteBtw(c, "  ")).toBe("> **btw:** q?\n>\n> one\n>\n> two\n\n");
});
