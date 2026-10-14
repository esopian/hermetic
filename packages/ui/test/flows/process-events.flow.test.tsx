/**
 * Background-process events in a Bot Chat thread, driven end to end.
 *
 * The fixture seeds kestrel's canonical Bot Chat (`sx-kestrel-events`,
 * `fixture-chat-process-events.ts`) with the notices a real box writes: a DM
 * reply from `lead-qa`, a clean build, a failed test run, a burst of routine
 * completions, a termination and a subagent batch. Every row below is read
 * over the real `chat.history` handler and the real `bind`, and drawn by the
 * shipping `Thread` — nothing here builds a block by hand.
 *
 * Hermes stores each notice as the user's turn, so the one thing these rows
 * must never do is claim to be the operator: the "You" label belongs to the
 * prompt at the top of the transcript and to nothing the box wrote.
 */
import { cleanup, screen, userEvent, waitFor } from "../dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { FIXTURE, type FlowHarness, flowHarness, gotoHash, mountPortal } from "./bridge.ts";

let harness: FlowHarness | null = null;

/**
 * The route and the layout, cleared before and after: an inherited
 * `#chat/...` would decide what the next test sees before it has asked for
 * anything.
 */
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

/**
 * Listen on kestrel — the precondition for any Bot Chat, done the way the
 * handler does it (`handlers/chat.ts` `listen`) — then open its Bot Chat and
 * wait for the transcript's failed test run to be drawn.
 */
async function openKestrel(): Promise<HTMLElement> {
  harness = await flowHarness();
  await harness.ctx.hermetic().chat.listen({ instance: FIXTURE.sseAgent, listening: true });
  await harness.ctx.chatOwner.sync();
  gotoHash(`#chat/${FIXTURE.sseAgent}/default`);
  mountPortal();
  await waitFor(() => expect(failedRow()).not.toBeNull(), { timeout: 4_000 });
  return document.querySelector<HTMLElement>(".ch-log")!;
}

/** The failed `bun test packages/ui` completion. */
function failedRow(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.ch-ev[data-outcome="failed"]');
}

/** Top-level event rows whose line names `command`; the burst's members are `.sub`. */
function rowsFor(command: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".ch-ev:not(.sub):not(.burst)")].filter((row) =>
    row.querySelector(".ch-ev-line .cmd")?.textContent?.includes(command),
  );
}

function burst(): HTMLDetailsElement | null {
  return document.querySelector<HTMLDetailsElement>(".ch-ev.burst details.ch-ev-burst");
}

function dmCard(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".ch-ev .ch-ev-dm");
}

/** Whether `root`, or anything in it, is labelled exactly "You". */
function labelledYou(root: Element): boolean {
  return [root, ...root.querySelectorAll("*")].some((el) => el.textContent?.trim() === "You");
}

test("a DM reply is drawn as the bot that replied", async () => {
  await openKestrel();
  const card = dmCard();
  expect(card).not.toBeNull();
  const head = card!.querySelector(".ch-ev-dm-head")!;
  expect(head.textContent).toContain(`lead-qa → ${FIXTURE.sseAgent}`);
  expect(card!.querySelector(".ch-ev-dm-who .ch-msg-who")?.textContent).toBe("lead-qa");
});

test("a failed run opens shut, with its last output line in red on the fold", async () => {
  await openKestrel();
  const more = failedRow()!.querySelector<HTMLDetailsElement>("details.ch-ev-more")!;
  expect(more).not.toBeNull();
  expect(more.open).toBe(false);
  const last = more.querySelector("summary .ch-ev-last")!;
  expect(last.classList.contains("bad")).toBe(true);
  expect(last.textContent).toBe("1 fail");
  expect(more.querySelector("summary")!.textContent).toContain("output · 40 lines · last line: ");
});

test("consecutive routine events fold into one shut burst", async () => {
  await openKestrel();
  const fold = burst();
  expect(fold).not.toBeNull();
  expect(fold!.open).toBe(false);
  expect(fold!.querySelector("summary")!.textContent).toContain("5 events");
  expect(fold!.querySelectorAll(".ch-ev.sub")).toHaveLength(5);
});

test("no event row is labelled You; the operator's prompt is", async () => {
  const log = await openKestrel();
  const events = [...log.querySelectorAll(".ch-ev")];
  // DM card, build, failed run, burst (with five members), subagent batch.
  expect(events.length).toBeGreaterThanOrEqual(5);
  for (const row of events) expect(labelledYou(row)).toBe(false);
  // Not vacuous: the thread does draw "You", on the one row a human wrote.
  const you = [...log.querySelectorAll(".ch-msg-who")].filter((el) => el.textContent === "You");
  expect(you).toHaveLength(1);
  expect(you[0]!.closest(".ch-ev")).toBeNull();
  expect(you[0]!.closest("[data-chat-message]")?.getAttribute("data-chat-message")).toContain(
    "mx-kestrel-events-1",
  );
});

test("an eventful thread has one rendering and no density switch", async () => {
  // A density the old switch stored for this thread must not hide anything now.
  window.localStorage.setItem(
    "hermetic.chat.event-density",
    JSON.stringify({ [`${FIXTURE.main.fleet_id}/${FIXTURE.sseAgent}/default/`]: "failures" }),
  );
  await openKestrel();
  expect(screen.queryByRole("group", { name: "Background events" })).toBeNull();
  expect(screen.queryByRole("button", { name: "failures only" })).toBeNull();
  // Routine rows, the failure and the DM reply are all drawn.
  expect(burst()).not.toBeNull();
  expect(rowsFor("bun run build")).toHaveLength(1);
  expect(failedRow()).not.toBeNull();
  expect(dmCard()).not.toBeNull();
});

test("the burst line names three process ids and counts the rest", async () => {
  await openKestrel();
  const ids = burst()!.querySelector<HTMLElement>("summary .ids")!;
  const all = ids.title.split(", ");
  expect(all.length).toBeGreaterThan(3);
  expect(ids.textContent).toMatch(new RegExp(`\\+${all.length - 3}$`));
  expect(ids.textContent!.split(",")).toHaveLength(3);
});

test("the rail previews a bot whose newest row is an event as its sentence", async () => {
  await openKestrel();
  // The rail opens on Unread, which hides a bot with nothing new in it.
  await userEvent.click(screen.getByRole("button", { name: "All" }));
  const rows = [...document.querySelectorAll<HTMLElement>(".ch-conv-main")];
  const kestrel = rows.find(
    (row) => row.querySelector(".ch-conv-name")?.textContent === FIXTURE.sseAgent,
  );
  const preview = kestrel?.querySelector(".ch-conv-prev")?.textContent ?? "";
  // The transcript ends on the subagent batch, so the row quotes its sentence.
  expect(preview).toMatch(/^subagents \d+ of \d+ finished/);
  expect(preview).not.toContain("[IMPORTANT");
  expect(preview).not.toContain("[ASYNC DELEGATION");
});
