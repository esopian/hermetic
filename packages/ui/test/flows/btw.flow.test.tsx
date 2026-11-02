/**
 * `/btw <question>` (§9.2 A side question): a temporary spotlight card above
 * the composer. Typed mid-turn it is asked at once — never queued, never
 * steered, the running turn untouched — and idle it is never sent as a turn.
 * Dismissing it leaves an undo strip; an answered card can be quoted into the
 * draft or continued as a branch.
 *
 * Through the real composer, the real `bind` and the real `dispatch` as
 * `chat.btw`/`chat.branch`, over the fixture backend, which answers a side
 * question after ~800 ms and fails one containing `E2E_BTW_ERROR`.
 * `E2E_SUBAGENT` paced at 30 ms holds a turn open for seconds
 * (`subagent.flow.test.tsx`). The 8-second expiry of the undo strip is
 * stepped on a fake clock in `chat-btw.dom.test.tsx`.
 */
import { cleanup, screen, userEvent, waitFor, within } from "../dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { setFleetTarget } from "../../src/api/index.ts";
import { type FlowHarness, flowHarness, gotoHash, mountPortal } from "./bridge.ts";

let harness: FlowHarness | null = null;

function reset(): void {
  window.localStorage.removeItem("hermetic.layout");
  window.sessionStorage.clear();
  gotoHash("");
}

beforeEach(reset);

afterEach(async () => {
  cleanup();
  await harness?.restore();
  harness = null;
  reset();
});

const WAIT = { timeout: 8_000 };

async function openScribe(chatDelayMs?: number): Promise<HTMLTextAreaElement> {
  harness = await flowHarness(chatDelayMs === undefined ? {} : { chatDelayMs });
  await harness.ctx.hermetic().chat.listen({ instance: "atlas", listening: true });
  await harness.ctx.chatOwner.sync();
  gotoHash("#chat/atlas/scribe");
  mountPortal();
  const composer = await screen.findByRole("textbox", { name: /^Message Marshall/ }, WAIT);
  setFleetTarget(harness.target);
  return composer as HTMLTextAreaElement;
}

const card = () => screen.queryByRole("dialog", { name: "Side question" });
const cardText = () => card()?.textContent ?? "";
const undoStrip = () => document.querySelector<HTMLElement>(".ch-btw-undo");
const calls = (name: string) => harness!.calls.filter((call) => call.name === name);
const turnRunning = () =>
  document.querySelector<HTMLElement>(".ch-send")?.title.startsWith("Queue") ?? false;
const queuedTexts = () =>
  Array.from(document.querySelectorAll(".ch-queue-row .ch-queue-text"), (n) => n.textContent ?? "");
const answered = () => waitFor(() => expect(cardText()).toContain("A fixture's side answer to:"), WAIT);

async function midTurn(composer: HTMLTextAreaElement): Promise<void> {
  await userEvent.type(composer, "E2E_SUBAGENT{Enter}");
  await waitFor(() => expect(turnRunning()).toBe(true), WAIT);
}

test("/btw mid-turn opens the card at once; nothing is queued and the turn runs on", async () => {
  const composer = await openScribe(30);
  await midTurn(composer);
  await userEvent.type(composer, "/btw what is X?");
  // The cue says it is a side question before it is sent.
  expect(document.querySelector(".ch-btw-cue")?.textContent ?? "").toContain("asked now, not queued");
  expect(Boolean(document.querySelector(".ch-input-box.ch-btw-box"))).toBe(true);
  await userEvent.type(composer, "{Enter}");
  expect(composer.value).toBe("");
  expect(Boolean(document.querySelector(".ch-queue"))).toBe(false);
  expect(cardText()).toContain("what is X?");
  expect(cardText()).toContain("Answering from the conversation so far");
  expect(cardText()).toContain("not the running turn");
  // Focus stays in the composer.
  expect(document.activeElement === composer).toBe(true);
  await waitFor(() => expect(calls("chat.btw")).toHaveLength(1), WAIT);
  expect(calls("chat.btw")[0]!.params).toMatchObject({
    instance: "atlas",
    bot: "scribe",
    text: "what is X?",
  });
  expect(calls("chat.steer")).toHaveLength(0);
  await answered();
  expect(turnRunning()).toBe(true);
  // The running turn finishes as it would have, and was the only turn sent.
  await waitFor(() => expect(turnRunning()).toBe(false), WAIT);
  expect(calls("chat.turn")).toHaveLength(1);
  // Not a transcript row: the re-read after the turn leaves the card alone.
  expect(Boolean(card())).toBe(true);
  expect(Boolean(document.querySelector('[data-chat-command="/btw"]'))).toBe(false);
}, 20_000);

test("Esc and Discard leave an undo strip, and Undo brings the card back", async () => {
  const composer = await openScribe();
  await userEvent.type(composer, "/btw what is X?{Enter}");
  await answered();
  // Esc in an empty composer discards the card.
  await userEvent.type(composer, "{Escape}");
  expect(Boolean(card())).toBe(false);
  expect(undoStrip()?.textContent ?? "").toContain("Side answer discarded: it is gone.");
  await userEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(cardText()).toContain("A fixture's side answer to: what is X?");
  expect(Boolean(undoStrip())).toBe(false);
  // Discard × does the same.
  await userEvent.click(screen.getByRole("button", { name: "Discard ×" }));
  expect(Boolean(card())).toBe(false);
  expect(Boolean(undoStrip())).toBe(true);
  // A typed draft keeps Esc's old meaning: the card stays dismissed, the draft stays.
  await userEvent.click(screen.getByRole("button", { name: "Undo" }));
  await userEvent.type(composer, "half a thought");
  await userEvent.type(composer, "{Escape}");
  expect(Boolean(card())).toBe(true);
  // Esc with focus in the card always discards.
  screen.getByRole("button", { name: "Discard ×" }).focus();
  await userEvent.keyboard("{Escape}");
  expect(Boolean(card())).toBe(false);
  expect(composer.value).toBe("half a thought");
  expect(calls("chat.turn")).toHaveLength(0);
});

test("a new /btw replaces the open card, which goes to the undo strip", async () => {
  const composer = await openScribe();
  await userEvent.type(composer, "/btw first?{Enter}");
  await userEvent.type(composer, "/btw second?{Enter}");
  expect(cardText()).toContain("second?");
  expect(Boolean(undoStrip())).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "Undo" }));
  // The first comes back, still waiting for its answer, and the second takes the strip.
  expect(cardText()).toContain("first?");
  await waitFor(() => expect(cardText()).toContain("A fixture's side answer to: first?"), WAIT);
  expect(Boolean(undoStrip())).toBe(true);
});

test("a queued row asked as btw goes Back to queue in its old place", async () => {
  const composer = await openScribe(30);
  await midTurn(composer);
  await userEvent.type(composer, "first queued{Enter}");
  await userEvent.type(composer, "second queued{Enter}");
  expect(queuedTexts()).toEqual(["first queued", "second queued"]);
  expect(document.querySelector(".ch-queue-status")?.textContent ?? "").toContain("Ask an aside now");
  const asks = screen.getAllByRole("button", { name: "Ask queued message as a side question" });
  await userEvent.click(asks[0]!);
  expect(queuedTexts()).toEqual(["second queued"]);
  expect(cardText()).toContain("from the queue");
  expect(cardText()).toContain("first queued");
  await userEvent.click(screen.getByRole("button", { name: "↩ Back to queue" }));
  expect(Boolean(card())).toBe(false);
  expect(Boolean(undoStrip())).toBe(false);
  expect(queuedTexts()).toEqual(["first queued", "second queued"]);
  // The late answer is ignored: no card comes back.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  expect(Boolean(card())).toBe(false);
}, 20_000);

test("Quote into message puts the quoted answer in the draft and sends nothing", async () => {
  const composer = await openScribe();
  await userEvent.type(composer, "/btw what is X?{Enter}");
  await answered();
  await userEvent.type(composer, "my reply");
  await userEvent.click(screen.getByRole("button", { name: "Quote into message" }));
  expect(composer.value).toBe(
    "> **btw:** what is X?\n>\n> A fixture's side answer to: what is X?\n\nmy reply",
  );
  expect(Boolean(card())).toBe(false);
  expect(Boolean(undoStrip())).toBe(false);
  expect(calls("chat.turn")).toHaveLength(0);
});

test("a failed side question offers Retry, which asks again", async () => {
  const composer = await openScribe();
  await userEvent.type(composer, "/btw E2E_BTW_ERROR please{Enter}");
  await waitFor(() => expect(cardText()).toContain("fixture side question failed"), WAIT);
  expect(Boolean(card()?.querySelector('[role="alert"]'))).toBe(true);
  await userEvent.click(within(card()!).getByRole("button", { name: "Retry" }));
  expect(cardText()).toContain("Answering from the conversation so far");
  await waitFor(() => expect(calls("chat.btw")).toHaveLength(2), WAIT);
  await waitFor(() => expect(cardText()).toContain("fixture side question failed"), WAIT);
  expect(calls("chat.turn")).toHaveLength(0);
});

test("/btw alone shows its usage and sends nothing", async () => {
  const composer = await openScribe();
  await userEvent.type(composer, "/btw{Enter}");
  expect(cardText()).toContain("Usage: /btw <question>");
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(calls("chat.btw")).toHaveLength(0);
  expect(calls("chat.turn")).toHaveLength(0);
});

test("Esc with no card keeps stopping a running turn", async () => {
  const composer = await openScribe(30);
  await midTurn(composer);
  await userEvent.type(composer, "{Escape}");
  await waitFor(() => expect(calls("chat.abort").length).toBeGreaterThan(0), WAIT);
});

test("with a card open, Esc in an empty composer discards it and leaves the turn running", async () => {
  const composer = await openScribe(30);
  await midTurn(composer);
  await userEvent.type(composer, "/btw what is X?{Enter}");
  await userEvent.type(composer, "{Escape}");
  expect(Boolean(card())).toBe(false);
  expect(Boolean(undoStrip())).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(calls("chat.abort")).toHaveLength(0);
  expect(turnRunning()).toBe(true);
}, 20_000);

test("Continue as a branch opens a new session ending with the question and answer", async () => {
  const composer = await openScribe();
  await userEvent.type(composer, "/btw what is X?{Enter}");
  await answered();
  await userEvent.click(screen.getByRole("button", { name: "Continue as a branch ↗" }));
  await waitFor(() => expect(calls("chat.branch")).toHaveLength(1), WAIT);
  expect(calls("chat.branch")[0]!.params).toMatchObject({
    instance: "atlas",
    bot: "scribe",
    question: "what is X?",
    answer: "A fixture's side answer to: what is X?",
  });
  // The laptop's clock is never a cut.
  expect(calls("chat.branch")[0]!.params).not.toHaveProperty("until");
  await waitFor(() => expect(window.location.hash).toContain("session=sx-branch-1"), WAIT);
  expect(Boolean(card())).toBe(false);
  await waitFor(() => {
    const rows = Array.from(document.querySelectorAll("article.ch-msg"), (a) => a.textContent ?? "");
    expect(rows.at(-2) ?? "").toContain("what is X?");
    expect(rows.at(-1) ?? "").toContain("A fixture's side answer to: what is X?");
  }, WAIT);
}, 20_000);
