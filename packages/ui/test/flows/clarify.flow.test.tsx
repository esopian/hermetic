/**
 * The clarify loop, end to end over the fixture backend.
 *
 * A prompt carrying `E2E_BATCH_CLARIFY` or `E2E_BLOCKING_CLARIFY` parks the
 * fixture's turn on a question card (`fixture-chat-requests.ts`). The page
 * answers through the real composer, the real `bind` and the real `dispatch`
 * (`chat.respond`), and the same turn carries on in the same assistant message.
 * The unit tests (`request-actions.dom.test.tsx`) cover the card alone; this is
 * the seam: card -> `chat.respond` -> parked turn -> continuation frames.
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

async function openScribe(): Promise<HTMLElement> {
  harness = await flowHarness();
  await harness.ctx.hermetic().chat.listen({ instance: "atlas", listening: true });
  await harness.ctx.chatOwner.sync();
  gotoHash("#chat/atlas/scribe");
  mountPortal();
  const composer = await screen.findByRole("textbox", { name: /^Message Marshall/ }, WAIT);
  setFleetTarget(harness.target);
  return composer;
}

/**
 * Hold the transcript re-read that follows a finished turn. The fixture's turn
 * runs to `done` the instant it is answered, and the page then redraws from
 * history, which no longer holds the card. Holding that read keeps the live
 * message on screen, so the card, its "Response sent." and the continuation
 * below it can be seen together; `release` lets the turn settle.
 */
function holdTranscript(): () => void {
  let release = (): void => {};
  const gate = new Promise<void>((done) => {
    release = done;
  });
  harness!.intercept("chat.history", (_params, passthrough) => gate.then(passthrough));
  return release;
}

/** The question cards on the page: a `.ch-card` whose head reads "question". */
function questionCards(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".ch-card")).filter(
    (card) => card.querySelector(".ch-card-head span")?.textContent === "question",
  );
}

async function theCard(): Promise<HTMLElement> {
  await waitFor(() => expect(questionCards()).toHaveLength(1), WAIT);
  return questionCards()[0]!;
}

const confirmIn = (card: HTMLElement) =>
  within(card).getByRole("button", { name: "Confirm and continue" }) as HTMLButtonElement;

/** The send button's title says "Queue" while a turn runs and "Send" once it ends. */
function turnRunning(): boolean {
  return document.querySelector<HTMLElement>(".ch-send")?.title.startsWith("Queue") ?? false;
}

/**
 * The assistant message that holds the card, read fresh: the page redraws the
 * block as frames arrive, so an element held across a step may be detached.
 */
const holder = () => questionCards()[0]?.closest("article") ?? null;
const holderText = () => holder()?.textContent ?? "";

test("a batch clarify is one card, answered whole, and the same turn continues", async () => {
  const composer = await openScribe();
  const release = holdTranscript();
  await userEvent.type(composer, "E2E_BATCH_CLARIFY{Enter}");

  const card = await theCard();
  expect(within(card).getByText("Pick a batch drink?")).toBeTruthy();
  expect(within(card).getByText("Pick a batch time?")).toBeTruthy();
  expect(within(card).getByText("0 of 2 answered")).toBeTruthy();
  expect(confirmIn(card).disabled).toBe(true);
  expect(questionCards()).toHaveLength(1);

  expect(within(card).getByText("turn paused")).toBeTruthy();
  await userEvent.click(within(card).getByRole("radio", { name: "Coffee (Recommended)" }));
  const when = within(within(card).getByRole("group", { name: "Pick a batch time?" }));
  await userEvent.click(when.getByRole("checkbox", { name: "Morning" }));
  await userEvent.click(when.getByRole("checkbox", { name: "Night" }));
  expect(when.getByRole("checkbox", { name: "Morning" }).getAttribute("aria-checked")).toBe("true");
  expect(when.getByRole("checkbox", { name: "Night" }).getAttribute("aria-checked")).toBe("true");
  expect(within(card).getByText("2 of 2 answered")).toBeTruthy();
  expect(confirmIn(card).disabled).toBe(false);

  await userEvent.click(confirmIn(card));

  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Response sent."), WAIT);
  // The fixture echoes what it was sent: the choice went out bare.
  const reply = "Got it: Coffee; Morning and Night. Continuing.";
  await waitFor(() => expect(holderText()).toContain(reply), WAIT);
  // The continuation lands in the message that holds the card, below it.
  const after = holder()!.querySelector(".ch-card")!;
  const text = Array.from(holder()!.querySelectorAll("*")).find((el) => el.textContent === reply);
  expect(text).toBeTruthy();
  expect(after.compareDocumentPosition(text!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(questionCards()).toHaveLength(1);
  // Answered, the card no longer says the turn waits on it.
  expect(within(questionCards()[0]!).queryByText("turn paused") === null).toBe(true);
  // One `chat.respond`, with both answers keyed by question id.
  const responds = harness!.calls.filter((call) => call.name === "chat.respond");
  expect(responds).toHaveLength(1);
  expect(responds[0]!.params).toMatchObject({
    kind: "question",
    answers: { q0: "Coffee", q1: '["Morning","Night"]' },
  });
  release();
  await waitFor(() => expect(turnRunning()).toBe(false), WAIT);
  // In the transcript, not only the sidebar's preview, which now fits it whole.
  expect(
    Array.from(document.querySelectorAll("article"), (article) => article.textContent ?? "").some(
      (text) => text.includes(reply),
    ),
  ).toBe(true);
});

test("a blocking clarify is one card, and Yes continues the turn", async () => {
  const composer = await openScribe();
  const release = holdTranscript();
  await userEvent.type(composer, "E2E_BLOCKING_CLARIFY{Enter}");

  const card = await theCard();
  expect(within(card).getByText("Keep this test turn running?")).toBeTruthy();
  // One question: no progress counter, and a choice alone is the whole answer.
  expect(within(card).queryByText(/answered$/)).toBeNull();
  await userEvent.click(within(card).getByRole("radio", { name: "Yes" }));
  await userEvent.click(confirmIn(card));

  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Response sent."), WAIT);
  await waitFor(() => expect(holderText()).toContain("Got it: Yes. Continuing."), WAIT);
  expect(harness!.calls.filter((call) => call.name === "chat.respond")).toHaveLength(1);
  release();
  await waitFor(() => expect(turnRunning()).toBe(false), WAIT);
});

test("a question answered from its card is no longer open, so the next message skips nothing", async () => {
  const composer = await openScribe();
  const release = holdTranscript();
  await userEvent.type(composer, "E2E_BLOCKING_CLARIFY{Enter}");

  const card = await theCard();
  await userEvent.click(within(card).getByRole("radio", { name: "Yes" }));
  await userEvent.click(confirmIn(card));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Response sent."), WAIT);
  await waitFor(() => expect(holderText()).toContain("Got it: Yes. Continuing."), WAIT);

  // The gateway sends no close after an ordinary answer, so only the card's
  // own release says the question is done: the next message goes out without
  // a skip, and the card is not relabelled as skipped.
  await userEvent.type(composer, "thanks{Enter}");
  release();
  await waitFor(
    () => expect(harness!.calls.filter((call) => call.name === "chat.turn")).toHaveLength(2),
    WAIT,
  );
  const responds = harness!.calls.filter((call) => call.name === "chat.respond");
  expect(responds).toHaveLength(1);
  expect(responds[0]!.params).not.toHaveProperty("skip");
  expect(document.body.textContent ?? "").not.toContain("Question skipped");
  await waitFor(() => expect(turnRunning()).toBe(false), WAIT);
});

test("Enter while a batch is open queues the message and leaves the card answerable", async () => {
  const composer = await openScribe();
  const release = holdTranscript();
  await userEvent.type(composer, "E2E_BATCH_CLARIFY{Enter}");
  const card = await theCard();

  // D4a: queueing is "after the current work", and the question is that work.
  await userEvent.type(composer, "just pick coffee{Enter}");
  await waitFor(() => expect(document.querySelectorAll(".ch-queue-row")).toHaveLength(1), WAIT);
  expect(harness!.calls.filter((call) => call.name === "chat.respond")).toHaveLength(0);
  expect(document.querySelector(".ch-composer-question")?.textContent).toBe(
    "A question is waiting — Enter queues until it is answered · ⌘Enter skips it and steers",
  );
  expect(confirmIn(card)).toBeTruthy();

  // Answered from the card, the turn ends and the queue drains into the next one.
  await userEvent.click(within(card).getByRole("radio", { name: "Coffee (Recommended)" }));
  const when = within(within(card).getByRole("group", { name: "Pick a batch time?" }));
  await userEvent.click(when.getByRole("checkbox", { name: "Morning" }));
  await userEvent.click(confirmIn(card));
  await waitFor(() => expect(holderText()).toContain("Got it:"), WAIT);
  release();
  await waitFor(
    () => expect(harness!.calls.filter((call) => call.name === "chat.turn")).toHaveLength(2),
    WAIT,
  );
  const responds = harness!.calls.filter((call) => call.name === "chat.respond");
  expect(responds).toHaveLength(1);
  expect(responds[0]!.params).not.toHaveProperty("skip");
  await waitFor(() => expect(turnRunning()).toBe(false), WAIT);
});

test("⌘Enter while a batch is open skips the card, which stays as Skipped, and the turn continues", async () => {
  const composer = await openScribe();
  const release = holdTranscript();
  await userEvent.type(composer, "E2E_BATCH_CLARIFY{Enter}");
  await theCard();

  await userEvent.type(composer, "just pick coffee");
  await userEvent.keyboard("{Meta>}{Enter}{/Meta}");

  // The composer settles the card itself once the skip is acknowledged: the
  // gateway sends no close after an ordinary answer. The card stays, collapsed
  // to what was asked, each question marked Skipped. Assert on booleans, never
  // `toBeNull()` on a node: a failure there pretty-prints the DOM and crashes bun.
  await waitFor(
    () => expect(screen.queryByRole("button", { name: "Confirm and continue" }) === null).toBe(true),
    WAIT,
  );
  expect(questionCards()).toHaveLength(1);
  const skipped = () =>
    Array.from(questionCards()[0]!.querySelectorAll(".bm-settled-skipped"), (el) => el.textContent);
  expect(skipped()).toEqual(["Skipped", "Skipped"]);
  expect(questionCards()[0]!.textContent).toContain("Pick a batch drink?");
  // The steer may land mid-reply, which closes the reply off where it stands
  // and puts the operator's words under it: the reply reads across the parts.
  const replyText = () =>
    Array.from(
      document.querySelectorAll("article.ch-msg:not(.me) .ch-msg-body"),
      (body) => body.textContent ?? "",
    ).join("");
  await waitFor(() => expect(replyText()).toContain("Skipped. Continuing."), WAIT);
  // Nothing was answered on the operator's behalf, and the skip carries no answer.
  expect(document.body.textContent ?? "").not.toContain("Got it:");
  const responds = harness!.calls.filter((call) => call.name === "chat.respond");
  expect(responds).toHaveLength(1);
  expect(responds[0]!.params).toMatchObject({ kind: "question", skip: true });
  expect(responds[0]!.params).not.toHaveProperty("answers");
  expect(responds[0]!.params).not.toHaveProperty("answer");
  release();
  // The typed text reached the box: steered into the turn, or sent after it.
  await waitFor(
    () =>
      expect(
        harness!.calls.some(
          (call) =>
            (call.name === "chat.steer" || call.name === "chat.turn") &&
            JSON.stringify(call.params).includes("just pick coffee"),
        ),
      ).toBe(true),
    WAIT,
  );
  await waitFor(() => expect(turnRunning()).toBe(false), WAIT);
  // Re-read from history, the settled card still says what was asked and that
  // it was skipped: the same summary, from the stored clarify result.
  await waitFor(
    () =>
      expect(
        harness!.calls.filter((call) => call.name === "chat.history").length,
      ).toBeGreaterThanOrEqual(2),
    WAIT,
  );
  await waitFor(() => expect(skippedCards()).toEqual([["Skipped", "Skipped"]]), WAIT);
});

/** Each question card on the page, as its rows' "Skipped" marks. */
const skippedCards = () =>
  questionCards().map((card) =>
    Array.from(card.querySelectorAll(".bm-settled-skipped"), (el) => el.textContent ?? ""),
  );

test("a clarify nobody answers settles as Timed out, and a late choice only drafts", async () => {
  const composer = (await openScribe()) as HTMLTextAreaElement;
  const release = holdTranscript();
  await userEvent.type(composer, "E2E_CLARIFY_TIMEOUT{Enter}");
  const card = await theCard();
  expect(within(card).getByText("Proceed with the default plan?")).toBeTruthy();

  // The fixture's request gives up on its own; the box closes it with `timeout`.
  await waitFor(
    () =>
      expect(questionCards()[0]?.querySelector(".bm-settled-head")?.textContent ?? "").toBe(
        "Timed out",
      ),
    WAIT,
  );
  await waitFor(
    () => expect(holderText()).toContain("No answer came in time. Continuing with the default."),
    WAIT,
  );
  const late = within(questionCards()[0]!).getByRole("button", { name: "Hold" });
  await userEvent.click(late);
  await waitFor(
    () => expect(composer.value).toBe('Re: "Proceed with the default plan?" — my answer: Hold'),
    WAIT,
  );
  expect(harness!.calls.filter((call) => call.name === "chat.respond")).toHaveLength(0);
  release();
  await waitFor(() => expect(turnRunning()).toBe(false), WAIT);
});
