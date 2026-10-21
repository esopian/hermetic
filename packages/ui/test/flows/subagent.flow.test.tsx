/**
 * Delegated children end to end over the fixture backend (WI-14).
 *
 * `E2E_SUBAGENT`, `E2E_SUBAGENT_PARALLEL` and `E2E_SUBAGENT_BACKGROUND`
 * (`fixture-chat-subagent.ts`) drive real `SubagentLedger`s, so the page sees
 * the blocks a box would give it: on the turn's frames while the parent runs,
 * and on the observation stream (the one typed `subagent` event) after a
 * background delegation has ended its turn. Steer and Stop go through the
 * real modal, the real `bind` and the real `dispatch` as `chat.steer` /
 * `chat.abort` with `subagent_id`; the fixture echoes a steer into the child's
 * next tool preview and ends a stopped child `interrupted`.
 *
 * The fixture is paced (`chatDelayMs`) so a child is still running when the
 * page acts on it. Each child step is then 180ms, so a test spends seconds in
 * the fixture's own sleeps (the parallel delegation's 21 steps alone are
 * 3.8s) and takes 3-6s unloaded: past Bun's 5s default, hence 20s.
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

async function openScribe(): Promise<HTMLElement> {
  harness = await flowHarness({ chatDelayMs: 30 });
  await harness.ctx.hermetic().chat.listen({ instance: "atlas", listening: true });
  await harness.ctx.chatOwner.sync();
  gotoHash("#chat/atlas/scribe");
  mountPortal();
  const composer = await screen.findByRole("textbox", { name: /^Message Marshall/ }, WAIT);
  setFleetTarget(harness.target);
  return composer;
}

const lines = () => Array.from(document.querySelectorAll<HTMLElement>(".sa-line"));
const lineFor = (goal: RegExp) =>
  lines().find((el) => goal.test(el.querySelector(".sa-goal")?.textContent ?? ""));
const pageText = () =>
  Array.from(
    document.querySelectorAll("article.ch-msg:not(.me) .ch-msg-body"),
    (b) => b.textContent ?? "",
  ).join("\n");
const turnRunning = () =>
  document.querySelector<HTMLElement>(".ch-send")?.title.startsWith("Queue") ?? false;
const ack = () => screen.queryByRole("dialog")?.querySelector(".sa-ack")?.textContent ?? "";
const calls = (name: string) => harness!.calls.filter((call) => call.name === name);

async function open(goal: RegExp): Promise<HTMLElement> {
  await waitFor(() => expect(lineFor(goal)).toBeTruthy(), WAIT);
  await userEvent.click(within(lineFor(goal)!).getByRole("button", { name: /Open subagent/ }));
  return screen.getByRole("dialog");
}

test("a synchronous delegation: one line that runs, then settles under the call", async () => {
  const composer = await openScribe();
  await userEvent.type(composer, "E2E_SUBAGENT{Enter}");
  await waitFor(() => expect(lines()).toHaveLength(1), WAIT);
  await waitFor(() => expect(lines()[0]?.classList.contains("run")).toBe(true), WAIT);
  await waitFor(() => expect(lines()[0]?.dataset.verdict).toBe("done"), WAIT);
  await waitFor(() => expect(pageText()).toContain("The subagent reports:"), WAIT);
  await waitFor(() => expect(turnRunning()).toBe(false), WAIT);
  // Re-read from the box after the turn: still one line, now history's, done.
  expect(lines()).toHaveLength(1);
  expect(lines()[0]?.dataset.verdict).toBe("done");
  expect(lines()[0]?.querySelector(".sa-act")?.textContent?.length).toBeGreaterThan(0);
}, 20_000);

test("a parallel delegation: a header, three lines, and the timeout reads as failed", async () => {
  const composer = await openScribe();
  await userEvent.type(composer, "E2E_SUBAGENT_PARALLEL{Enter}");
  await waitFor(() => expect(lines()).toHaveLength(3), WAIT);
  expect(document.querySelector(".sa-head-t")?.textContent).toBe("Delegated 3 tasks");
  await waitFor(() => expect(pageText()).toContain("2 of 3 tasks finished"), WAIT);
  await waitFor(() => expect(turnRunning()).toBe(false), WAIT);
  const fio = lineFor(/Benchmark the volume with fio/)!;
  expect(fio.classList.contains("bad")).toBe(true);
  expect(fio.querySelector(".sa-act.error")?.textContent).toContain("Timed out after 30s");
  expect(document.querySelector(".sa-head-f")?.textContent).toMatch(/^3 of 3 done/);
}, 20_000);

test("a background delegation: lines keep moving after the turn, then the results turn lands", async () => {
  const composer = await openScribe();
  await userEvent.type(composer, "E2E_SUBAGENT_BACKGROUND{Enter}");
  await waitFor(() => expect(pageText()).toContain("Dispatched. I will resume"), WAIT);
  await waitFor(() => expect(turnRunning()).toBe(false), WAIT);
  // The parent turn is over and its children are not: they ride the observation.
  await waitFor(() => expect(lines().some((el) => el.classList.contains("run"))).toBe(true), WAIT);
  const before = lines().map((el) => el.querySelector(".sa-act")?.textContent);
  await waitFor(
    () => expect(lines().map((el) => el.querySelector(".sa-act")?.textContent)).not.toEqual(before),
    WAIT,
  );
  await waitFor(() => expect(lines().every((el) => el.dataset.verdict === "done")).toBe(true), WAIT);
  await waitFor(() => expect(pageText()).toContain("Both background tasks are done."), WAIT);
  // Never duplicated by the re-read that ended the turn.
  expect(lines().length).toBeGreaterThan(0);
  expect(new Set(lines().map((el) => el.dataset.subagentId)).size).toBe(lines().length);
}, 20_000);

test("a steer from the modal is queued, then likely applied when the child's next call echoes it", async () => {
  const composer = await openScribe();
  await userEvent.type(composer, "E2E_SUBAGENT{Enter}");
  const dialog = await open(/Survey disk I\/O/);
  const field = within(dialog).getByRole("textbox", { name: "Steer this subagent" });
  await userEvent.type(field, "only nvme1n1{Enter}");
  await waitFor(() => expect(calls("chat.steer")).toHaveLength(1), WAIT);
  expect(calls("chat.steer")[0]!.params).toMatchObject({ text: "only nvme1n1" });
  expect((calls("chat.steer")[0]!.params as { subagent_id?: string }).subagent_id).toMatch(
    /^sa-fixture-/,
  );
  await waitFor(() => expect(ack()).toBe("Likely applied"), WAIT);
  expect(screen.getByRole("dialog").textContent).toContain("steer: only nvme1n1");
  // Escape closes the modal and nothing else: the turn was not stopped.
  await userEvent.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(calls("chat.abort")).toHaveLength(0);
  await waitFor(() => expect(turnRunning()).toBe(false), WAIT);
}, 20_000);

test("Stop from the modal is requested, then the child is stopped by you and the turn goes on", async () => {
  const composer = await openScribe();
  await userEvent.type(composer, "E2E_SUBAGENT_PARALLEL{Enter}");
  const dialog = await open(/Benchmark the volume with fio/);
  await userEvent.click(within(dialog).getByRole("button", { name: "STOP" }));
  await waitFor(() => expect(calls("chat.abort")).toHaveLength(1), WAIT);
  expect((calls("chat.abort")[0]!.params as { subagent_id?: string }).subagent_id).toMatch(
    /^sa-fixture-/,
  );
  await waitFor(() => expect(ack()).toBe("Stopped by you"), WAIT);
  expect(within(screen.getByRole("dialog")).queryByRole("button", { name: "STOP" })).toBeNull();
  await userEvent.keyboard("{Escape}");
  await waitFor(
    () => expect(lineFor(/Benchmark the volume with fio/)?.dataset.verdict).toBe("stopped"),
    WAIT,
  );
  // The parent turn carried on to its own answer.
  await waitFor(() => expect(turnRunning()).toBe(false), WAIT);
  expect(pageText()).toContain("tasks finished");
}, 20_000);
