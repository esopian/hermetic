/**
 * The chat's kanban task widget end to end over the fixture backend (#117).
 *
 * `E2E_KANBAN` (`fixture-chat-kanban.ts`) has atlas's default bot file a card
 * with `kanban_create`; the fixture board then walks it triage → ready →
 * running → done over eight seconds of wall clock and lands Hermes' `✔` notice
 * in the conversation. The widget reads the card through the real `bind` and
 * `dispatch` (`kanban.task`) and re-reads it every five seconds, so the test
 * waits for the real timeline (done by about 10 s): hence 30 s.
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

const TITLE = "Write a 3-line haiku about kanban boards to haiku.txt";

test("a kanban_create call is a live task card that reaches done, then the notice is an event", async () => {
  harness = await flowHarness();
  await harness.ctx.hermetic().chat.listen({ instance: "atlas", listening: true });
  await harness.ctx.chatOwner.sync();
  gotoHash("#chat/atlas/default");
  mountPortal();
  const composer = await screen.findByRole("textbox", { name: /^Message / }, { timeout: 4_000 });
  setFleetTarget(harness.target);
  await userEvent.type(composer, "E2E_KANBAN{Enter}");

  const card = await screen.findByRole("region", { name: /^Task t_/ }, { timeout: 4_000 });
  const id = card.getAttribute("data-task-id") ?? "";
  expect(id).toMatch(/^t_[0-9a-f]{8}$/);
  expect(within(card).getByText(id)).toBeTruthy();
  expect(within(card).getByText(TITLE)).toBeTruthy();
  await waitFor(() => expect(within(card).getByText("scratch")).toBeTruthy(), { timeout: 4_000 });

  // The board walks the card to done at +8 s; the widget's 5 s poll sees it by +10 s.
  await waitFor(() => expect(card.querySelector(".ch-kt-st")?.textContent).toBe("done"), {
    timeout: 14_000,
    interval: 250,
  });
  expect(card.classList.contains("ok")).toBe(true);
  expect(within(card).getByText(/Created a 3-line haiku about kanban boards/)).toBeTruthy();
  expect(within(card).getByText("1 run")).toBeTruthy();

  // Hermes' notice is an event row with Open task, never the operator's message.
  const openTask = await screen.findByRole("button", { name: "Open task" }, { timeout: 4_000 });
  expect(openTask.closest("article.me")).toBeNull();
  expect(screen.getByText(`✔ Kanban ${id}`)).toBeTruthy();
}, 30_000);

test("a card deleted from the board reads as deleted, not as a box that stopped answering", async () => {
  harness = await flowHarness();
  await harness.ctx.hermetic().chat.listen({ instance: "atlas", listening: true });
  await harness.ctx.chatOwner.sync();
  gotoHash("#chat/atlas/default");
  mountPortal();
  const composer = await screen.findByRole("textbox", { name: /^Message / }, { timeout: 4_000 });
  setFleetTarget(harness.target);
  await userEvent.type(composer, "E2E_KANBAN{Enter}");
  const card = await screen.findByRole("region", { name: /^Task t_/ }, { timeout: 4_000 });
  await waitFor(() => expect(card.querySelector(".ch-kt-st")).not.toBeNull(), { timeout: 4_000 });
  const id = card.getAttribute("data-task-id") ?? "";
  await harness.ctx.hermetic().kanban.delete({ instance: "atlas", id, confirm: true });
  await waitFor(
    () => expect(within(card).getByText("This card was deleted from the board.")).toBeTruthy(),
    {
      timeout: 8_000,
      interval: 250,
    },
  );
  expect(within(card).queryByText(/is not answering/)).toBeNull();
}, 15_000);

test("a card on a box whose board is off is unreadable, not deleted", async () => {
  harness = await flowHarness();
  await harness.ctx.hermetic().chat.listen({ instance: "ember", listening: true });
  await harness.ctx.chatOwner.sync();
  gotoHash("#chat/ember/default");
  mountPortal();
  const composer = await screen.findByRole("textbox", { name: /^Message / }, { timeout: 4_000 });
  setFleetTarget(harness.target);
  await userEvent.type(composer, "E2E_KANBAN{Enter}");
  const card = await screen.findByRole("region", { name: /^Task t_/ }, { timeout: 4_000 });
  await waitFor(
    () => expect(within(card).getByText(/This card is not readable on ember/)).toBeTruthy(),
    {
      timeout: 4_000,
    },
  );
  expect(within(card).queryByText("This card was deleted from the board.")).toBeNull();
});
