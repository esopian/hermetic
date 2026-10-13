/**
 * A failed turn, end to end over the fixture backend.
 *
 * A prompt carrying `E2E_ERROR_<CODE>` fails the fixture's turn with an `error`
 * frame whose `failure` carries upstream's classified surface
 * (`fixture-chat-error.ts`), and the fixture's history keeps the failed turn.
 * The page draws the failure on the turn itself — live, then from the re-read —
 * and offers what the failure allows (`recoveryPlan`), each action bound to the
 * failed turn's own prompt and going out through the real `bind` and `dispatch`.
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

const WAIT = { timeout: 4_000 };

async function openScribe(): Promise<HTMLTextAreaElement> {
  harness = await flowHarness();
  await harness.ctx.hermetic().chat.listen({ instance: "atlas", listening: true });
  await harness.ctx.chatOwner.sync();
  gotoHash("#chat/atlas/scribe");
  mountPortal();
  const composer = await screen.findByRole("textbox", { name: /^Message Marshall/ }, WAIT);
  setFleetTarget(harness.target);
  return composer as HTMLTextAreaElement;
}

const failureCards = () => Array.from(document.querySelectorAll<HTMLElement>(".ch-failure"));
async function theCard(): Promise<HTMLElement> {
  await waitFor(() => expect(failureCards()).toHaveLength(1), WAIT);
  return failureCards()[0]!;
}
const buttonsIn = (el: HTMLElement) => Array.from(el.querySelectorAll("button"), (b) => b.textContent);
const turns = () => harness!.calls.filter((call) => call.name === "chat.turn");

function turnRunning(): boolean {
  return document.querySelector<HTMLElement>(".ch-send")?.title.startsWith("Queue") ?? false;
}

test("a rate limit is drawn on the turn, holds Retry until the reset, and survives the re-read", async () => {
  const composer = await openScribe();
  await userEvent.type(composer, "E2E_ERROR_RATE_LIMITED{Enter}");
  const card = await theCard();
  expect(within(card).getByText("Rate limited.")).toBeTruthy();
  // The head names upstream's own code, whatever spelling the fixture uses.
  expect(card.querySelector(".ch-card-head .right")?.textContent ?? "").toMatch(/^rate_limit/);
  expect(within(card).getByText(/^Retry available at \d\d:\d\d:\d\d$/)).toBeTruthy();
  const retry = within(card).getByRole("button", { name: "Retry" }) as HTMLButtonElement;
  expect(retry.disabled).toBe(true);
  // The box took the message; the refusal band would say it did not.
  expect(document.body.textContent ?? "").not.toContain("The message was not sent.");
  await waitFor(() => expect(turnRunning()).toBe(false), WAIT);
  // The re-read brings the failed turn back from history, drawn the same way.
  await waitFor(
    () =>
      expect(harness!.calls.filter((c) => c.name === "chat.history").length).toBeGreaterThanOrEqual(2),
    WAIT,
  );
  const reread = await theCard();
  expect(within(reread).getByText("Rate limited.")).toBeTruthy();
  expect(within(reread).getByText(/^Retry available at/)).toBeTruthy();
  expect(turns()).toHaveLength(1);
});

test("a gateway loop error offers Retry, which resends the failed turn's own prompt", async () => {
  const composer = await openScribe();
  await userEvent.type(composer, "E2E_ERROR_LOOP_ERROR{Enter}");
  const card = await theCard();
  expect(buttonsIn(card)).toEqual(["Retry", "Start new session", "Copy details"]);
  await waitFor(() => expect(turnRunning()).toBe(false), WAIT);
  await userEvent.click(within(failureCards()[0]!).getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(turns()).toHaveLength(2), WAIT);
  expect(turns()[1]!.params).toMatchObject({ message: "E2E_ERROR_LOOP_ERROR" });
});

test("Start new session opens one and sends the failed prompt into it", async () => {
  const composer = await openScribe();
  await userEvent.type(composer, "E2E_ERROR_LOOP_ERROR{Enter}");
  await theCard();
  await waitFor(() => expect(turnRunning()).toBe(false), WAIT);
  const first = turns()[0]!.params as { session?: string };
  await userEvent.click(within(failureCards()[0]!).getByRole("button", { name: "Start new session" }));
  await waitFor(() => expect(turns()).toHaveLength(2), WAIT);
  const opens = harness!.calls.filter(
    (c) => c.name === "chat.open" && (c.params as { new_session?: boolean }).new_session === true,
  );
  expect(opens).toHaveLength(1);
  const second = turns()[1]!.params as { message: string; session?: string };
  expect(second.message).toBe("E2E_ERROR_LOOP_ERROR");
  // Into the new conversation, not the one that failed.
  expect(second.session).toBeTruthy();
  expect(second.session).not.toBe(first.session);
});

test("a context overflow offers Compact and a new session, not a plain Retry", async () => {
  const composer = await openScribe();
  await userEvent.type(composer, "E2E_ERROR_CONTEXT_OVERFLOW{Enter}");
  const card = await theCard();
  expect(within(card).getByText("This thread has filled the model's window.")).toBeTruthy();
  expect(buttonsIn(card)).toEqual(["Compact", "Start new session", "Switch provider", "Copy details"]);
  await waitFor(() => expect(turnRunning()).toBe(false), WAIT);
  await userEvent.click(within(failureCards()[0]!).getByRole("button", { name: "Compact" }));
  await waitFor(
    () => expect(harness!.calls.filter((c) => c.name === "chat.compact")).toHaveLength(1),
    WAIT,
  );
  expect(turns()).toHaveLength(1);
});

test("a blocked prompt goes back into the composer, unsent", async () => {
  const composer = await openScribe();
  await userEvent.type(composer, "E2E_ERROR_CONTENT_POLICY_BLOCKED{Enter}");
  const card = await theCard();
  expect(buttonsIn(card)).toContain("Edit message");
  expect(buttonsIn(card)).not.toContain("Retry");
  await waitFor(() => expect(turnRunning()).toBe(false), WAIT);
  await userEvent.click(within(failureCards()[0]!).getByRole("button", { name: "Edit message" }));
  await waitFor(() => expect(composer.value).toBe("E2E_ERROR_CONTENT_POLICY_BLOCKED"), WAIT);
  expect(turns()).toHaveLength(1);
});

test("a rejected API key links to the provider settings and collects nothing", async () => {
  const composer = await openScribe();
  await userEvent.type(composer, "E2E_ERROR_AUTH{Enter}");
  const card = await theCard();
  expect(buttonsIn(card)).toEqual(["Retry", "Switch provider", "Update API key", "Copy details"]);
  expect(card.querySelectorAll("input").length).toBe(0);
  await waitFor(() => expect(turnRunning()).toBe(false), WAIT);
  await userEvent.click(within(failureCards()[0]!).getByRole("button", { name: "Update API key" }));
  await waitFor(() => expect(window.location.hash).toBe("#settings/providers"), WAIT);
});

test("text that arrived before the failure stays above the card", async () => {
  const composer = await openScribe();
  await userEvent.type(composer, "E2E_ERROR_AFTER_TEXT{Enter}");
  const card = await theCard();
  const article = card.closest("article")!;
  expect(article.textContent).toContain("Checking the box before the provider call.");
  expect(within(card).getByText("Rate limited.")).toBeTruthy();
  await waitFor(() => expect(turnRunning()).toBe(false), WAIT);
});
