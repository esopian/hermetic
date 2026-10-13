/**
 * The approval loop, end to end over the fixture backend.
 *
 * A prompt carrying `E2E_APPROVAL` (or its `_SMART`, `_NOSESSION`, `_TIMEOUT`
 * variants) parks the fixture's turn on an approval card
 * (`fixture-chat-approval.ts`) whose `choices` follow the gateway's fill rule.
 * The page answers through the real card, the real `bind` and the real
 * `dispatch` (`chat.respond kind:"approval"`), and the same turn carries on.
 * The gateway grants any non-`deny` choice it is sent, offered or not (D27), so
 * what is under test here is that the page only ever offers what was offered.
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
const COMMAND = "rm -rf /var/cache/fixture-build";

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

/** Hold the re-read after the turn, so the live card and its outcome stay on screen. */
function holdTranscript(): () => void {
  let release = (): void => {};
  const gate = new Promise<void>((done) => {
    release = done;
  });
  harness!.intercept("chat.history", (_params, passthrough) => gate.then(passthrough));
  return release;
}

async function theCard(): Promise<HTMLElement> {
  await waitFor(() => expect(document.querySelectorAll(".ch-approve")).toHaveLength(1), WAIT);
  return document.querySelector<HTMLElement>(".ch-approve")!;
}

const card = () => document.querySelector<HTMLElement>(".ch-approve");
const buttonsIn = (el: HTMLElement) => Array.from(el.querySelectorAll("button"), (b) => b.textContent);
const responds = () => harness!.calls.filter((call) => call.name === "chat.respond");
const pageText = () =>
  Array.from(
    document.querySelectorAll("article.ch-msg:not(.me) .ch-msg-body"),
    (b) => b.textContent ?? "",
  ).join("");

function turnRunning(): boolean {
  return document.querySelector<HTMLElement>(".ch-send")?.title.startsWith("Queue") ?? false;
}

test("the default fill offers all four; Approve once runs the command", async () => {
  const composer = await openScribe();
  const release = holdTranscript();
  await userEvent.type(composer, "E2E_APPROVAL{Enter}");
  const approval = await theCard();
  expect(within(approval).getByText(COMMAND)).toBeTruthy();
  expect(buttonsIn(approval)).toEqual(["Approve once", "This session", "Always allow", "Deny"]);

  await userEvent.click(within(approval).getByRole("button", { name: "Approve once" }));
  await waitFor(
    () => expect(within(card()!).getByRole("status").textContent).toBe("Approved once"),
    WAIT,
  );
  await waitFor(() => expect(pageText()).toContain(`Approved once: ran ${COMMAND}.`), WAIT);
  expect(responds()).toHaveLength(1);
  expect(responds()[0]!.params).toMatchObject({ kind: "approval", choice: "once" });
  release();
  await waitFor(() => expect(turnRunning()).toBe(false), WAIT);
});

test("a smart-denied command offers only a one-shot answer", async () => {
  const composer = await openScribe();
  const release = holdTranscript();
  await userEvent.type(composer, "E2E_APPROVAL_SMART{Enter}");
  expect(buttonsIn(await theCard())).toEqual(["Approve once", "Deny"]);
  await userEvent.click(within(card()!).getByRole("button", { name: "Deny" }));
  await waitFor(() => expect(within(card()!).getByRole("status").textContent).toBe("Denied"), WAIT);
  await waitFor(() => expect(pageText()).toContain(`Denied: did not run ${COMMAND}.`), WAIT);
  release();
  await waitFor(() => expect(turnRunning()).toBe(false), WAIT);
});

test("session approval off offers once and deny", async () => {
  const composer = await openScribe();
  const release = holdTranscript();
  await userEvent.type(composer, "E2E_APPROVAL_NOSESSION{Enter}");
  expect(buttonsIn(await theCard())).toEqual(["Approve once", "Deny"]);
  await userEvent.click(within(card()!).getByRole("button", { name: "Approve once" }));
  await waitFor(() => expect(pageText()).toContain("Approved once: ran"), WAIT);
  release();
  await waitFor(() => expect(turnRunning()).toBe(false), WAIT);
});

test("Always allow takes a second step; Escape backs out of it without stopping the turn", async () => {
  const composer = await openScribe();
  const release = holdTranscript();
  await userEvent.type(composer, "E2E_APPROVAL{Enter}");
  const approval = await theCard();

  await userEvent.click(within(approval).getByRole("button", { name: "Always allow" }));
  const step = within(card()!).getByRole("group", { name: "Always allow this command?" });
  expect(within(step).getByText("recursive delete")).toBeTruthy();
  expect(document.activeElement?.textContent).toBe("Cancel");
  await userEvent.keyboard("{Escape}");
  expect(within(card()!).queryAllByRole("group").length).toBe(0);
  // The turn is still parked on the card: Escape did not reach the stop.
  expect(harness!.calls.some((call) => call.name === "chat.abort")).toBe(false);
  expect(turnRunning()).toBe(true);

  await userEvent.click(within(card()!).getByRole("button", { name: "Always allow" }));
  const again = within(card()!).getByRole("group", { name: "Always allow this command?" });
  await userEvent.click(within(again).getByRole("button", { name: "Always allow" }));
  await waitFor(
    () => expect(within(card()!).getByRole("status").textContent).toBe("Always allowed"),
    WAIT,
  );
  await waitFor(() => expect(pageText()).toContain(`Always allowed: ran ${COMMAND}.`), WAIT);
  expect(responds()).toHaveLength(1);
  expect(responds()[0]!.params).toMatchObject({ kind: "approval", choice: "always" });
  release();
  await waitFor(() => expect(turnRunning()).toBe(false), WAIT);
});

test("an approval nobody answers says the command was not run", async () => {
  const composer = await openScribe();
  const release = holdTranscript();
  await userEvent.type(composer, "E2E_APPROVAL_TIMEOUT{Enter}");
  await theCard();
  await waitFor(
    () =>
      expect(card()?.querySelector(".bm-approval-outcome.bad")?.textContent ?? "").toBe(
        "Approval timed out — the command was not run",
      ),
    WAIT,
  );
  expect(buttonsIn(card()!)).toEqual([]);
  await waitFor(() => expect(pageText()).toContain("Approval timed out: did not run"), WAIT);
  expect(responds()).toHaveLength(0);
  release();
  await waitFor(() => expect(turnRunning()).toBe(false), WAIT);
});
