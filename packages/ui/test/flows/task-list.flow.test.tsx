/**
 * Hermes's task list (§9.2 Task list), end to end over the fixture backend.
 *
 * corvid's canonical Bot Chat (`sx-corvid-portal`) carries a list left 2 of 5
 * done a fixture day ago (`fixture-chat-todos.ts`), so it opens paused and
 * aged. `E2E_TODO` plans afresh at rising revisions with a beat between steps,
 * and `E2E_TODO_DONE` finishes the current list with one item cancelled. Every
 * block reaches the page through the real handlers and `bind`.
 */
import { cleanup, fireEvent, screen, userEvent, waitFor, within } from "../dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { type FlowHarness, flowHarness, gotoHash, mountPortal } from "./bridge.ts";
import { TASK_LIST_PREFS_KEY } from "../../src/chat/task-list-prefs.ts";
import { registerThreadJump } from "../../src/chat/thread-jump.ts";

let harness: FlowHarness | null = null;
/** These tests run paced fixture turns in real time, past bun's 5 s default. */
const LONG = 30_000;

function reset(): void {
  window.localStorage.removeItem("hermetic.layout");
  for (const k of Object.keys(window.localStorage))
    if (k.startsWith(TASK_LIST_PREFS_KEY)) window.localStorage.removeItem(k);
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

async function open(hash: string): Promise<HTMLElement> {
  harness = await flowHarness();
  for (const instance of ["corvid", "atlas"])
    await harness.ctx.hermetic().chat.listen({ instance, listening: true });
  await harness.ctx.chatOwner.sync();
  gotoHash(hash);
  mountPortal();
  return await screen.findByRole("textbox", { name: /^Message / }, { timeout: 4_000 });
}

const strip = (): HTMLElement | null => document.querySelector<HTMLElement>(".tl-pin .tl-strip");
const sheet = (): HTMLElement | null => screen.queryByRole("region", { name: "Task list" });
const railBars = (): string[] =>
  [...document.querySelectorAll<HTMLElement>(".ch-conv .tl-rail")].map((el) => el.title);
/** The full strip is the button; a folded line holds one beside its Hide. */
const stripButton = (): HTMLElement =>
  strip()!.tagName === "BUTTON"
    ? strip()!
    : within(strip()!).getByRole("button", { name: /^Task list/ });
const log = (): HTMLElement => document.querySelector<HTMLElement>(".ch-log")!;
/**
 * The turn has settled: no Stop in the composer. Asserted as a boolean: a failed
 * `toBeNull` on a DOM node pretty-prints the node, and React's props behind it.
 */
const settled = () =>
  waitFor(() => expect(document.querySelector('[aria-label="Stop turn"]') === null).toBe(true), {
    timeout: 8_000,
  });

test(
  "a paused list from history: folded line, sheet, jump, rail bar, Hide",
  async () => {
    await open("#chat/corvid/default");
    await waitFor(() => expect(strip()?.textContent).toContain("paused"), { timeout: 4_000 });
    // Folded: one line (square, fraction, the item, `paused · age`, Hide) over the bar.
    const line = strip()!.querySelector(".tl-fold")!;
    expect(line.querySelector(".tl-frac")?.textContent).toBe("2/5");
    expect(line.querySelector(".tl-now")?.textContent).toBe("▷ Dry-run the apply");
    expect(line.querySelector(".tl-meta")?.textContent).toMatch(/^paused · \d+[hd]$/);
    // meta · Hide · caret, the caret at the right edge.
    expect([...line.children].map((el) => el.className)).toEqual([
      "tl-line",
      "ch-chip tl-hide",
      "tl-caret",
    ]);
    // The bar carries the counts, so the line does not spell them out.
    expect(strip()!.querySelectorAll(":scope > .tl-bar > i")).toHaveLength(5);
    expect(strip()!.querySelector(".tl-bar.live") === null).toBe(true);
    expect(strip()!.textContent).not.toMatch(/active|open/);
    expect(stripButton().getAttribute("aria-label")).toContain("paused, untouched");
    expect(railBars()).toContain("2/5 · 1 active · 2 open");

    await userEvent.click(stripButton());
    expect(sheet()!.textContent).toContain("last known · from history");
    // The subtask sits under its parent.
    expect(sheet()!.querySelector(".tl-sub")?.textContent).toContain("Diff the rendered config");
    fireEvent.keyDown(sheet()!.querySelector(".tl-sheet-body")!, { key: "Escape" });
    expect(sheet() === null).toBe(true);

    const asked: string[] = [];
    const unregister = registerThreadJump((id) => {
      asked.push(id);
      return null;
    });
    await userEvent.click(stripButton());
    await userEvent.click(
      within(sheet()!).getByRole("button", { name: /Jump to where it was planned/ }),
    );
    unregister();
    expect(sheet() === null).toBe(true);
    expect(asked).toHaveLength(1);

    await userEvent.click(within(strip()!).getByRole("button", { name: "Hide" }));
    await waitFor(() => expect(strip() === null).toBe(true));
    // Hiding is the strip's; the rail still says the work is paused.
    expect(railBars()).toContain("2/5 · 1 active · 2 open");
  },
  LONG,
);

test("the rail reads a conversation that is not open", async () => {
  await open("#chat/atlas/default");
  await waitFor(() => expect(railBars()).toContain("2/5 · 1 active · 2 open"), { timeout: 4_000 });
});

test(
  "a live list runs, lands in the transcript, re-shows after Hide, finishes and clears",
  async () => {
    const composer = await open("#chat/corvid/default");
    await waitFor(() => expect(strip() === null).toBe(false), { timeout: 4_000 });
    await userEvent.click(within(strip()!).getByRole("button", { name: "Hide" }));
    await waitFor(() => expect(strip() === null).toBe(true));

    // A new revision brings the hidden list back.
    await userEvent.type(composer, "E2E_TODO{Enter}");
    await waitFor(() => expect(strip()?.textContent).toContain("Read the current snapshot policy"), {
      timeout: 4_000,
    });
    expect(strip()!.classList.contains("folded")).toBe(false);
    expect(strip()!.querySelector(".tl-bar.live") === null).toBe(false);
    await userEvent.click(stripButton());
    expect(sheet()!.textContent).toMatch(/live · rev \d+ · \d\d:\d\d:\d\d/);
    await userEvent.click(within(sheet()!).getByRole("button", { name: "Close" }));

    // The turn ends with work open: the list folds to paused.
    await settled();
    await waitFor(() => expect(strip()?.textContent).toContain("paused"), { timeout: 4_000 });
    await waitFor(() => expect(log().textContent).toContain("Planned 5 tasks"), { timeout: 4_000 });
    expect(log().textContent).toContain("rev 4");
    expect(log().textContent).not.toContain('"todos"');
    expect(log().textContent).not.toContain("Task list updated");
    const group = [...log().querySelectorAll<HTMLElement>(".ch-activity > summary")].find((s) =>
      s.textContent?.includes("tasks 2/5"),
    );
    expect(group === undefined).toBe(false);
    await userEvent.click(group!);
    const row = [...log().querySelectorAll<HTMLElement>(".ch-activity-todo")].find((b) =>
      b.textContent?.includes("rev 6"),
    );
    await userEvent.click(row!);
    expect(sheet() === null).toBe(false);
    await userEvent.click(within(sheet()!).getByRole("button", { name: "Close" }));

    await userEvent.type(composer, "E2E_TODO_DONE{Enter}");
    await waitFor(() => expect(strip()?.querySelector(".tl-frac")?.textContent).toBe("✓ 4/4 done"), {
      timeout: 8_000,
    });
    // The cancelled count is the sheet's: the line spells no counts.
    expect(strip()!.querySelector(".tl-note")?.textContent).toBe("clears when you send");
    expect(strip()!.textContent).not.toContain("cancelled");
    // Finished: the bar stays under the line, every cell done; nothing to hide.
    expect(strip()!.querySelectorAll(":scope > .tl-bar > i.done")).toHaveLength(4);
    expect(within(strip()!).queryByRole("button", { name: "Hide" }) === null).toBe(true);
    await settled();
    // Watched to the end: the strip keeps its done line, the rail has nothing to add.
    expect(strip() === null).toBe(false);
    expect(railBars().some((t) => t.startsWith("✓"))).toBe(false);
    expect(railBars()).not.toContain("2/5 · 1 active · 2 open");

    await userEvent.type(composer, "thanks{Enter}");
    await waitFor(() => expect(strip() === null).toBe(true), { timeout: 4_000 });
    await settled();

    // A new list after the clear shows again.
    await userEvent.type(composer, "E2E_TODO{Enter}");
    await waitFor(() => expect(strip()?.textContent).toContain("Read the current snapshot policy"), {
      timeout: 4_000,
    });
    await settled();
  },
  LONG,
);

test(
  "a list finished out of sight carries ✓ on the rail until it is opened",
  async () => {
    await open("#chat/corvid/default");
    const composer = await screen.findByRole("textbox", { name: /^Message / });
    await waitFor(() => expect(strip() === null).toBe(false), { timeout: 4_000 });
    await userEvent.type(composer, "E2E_TODO_DONE{Enter}");
    // Away while the turn is still in its paced step.
    gotoHash("#chat/atlas/default");
    await waitFor(() => expect(railBars()).toContain("✓ 4/4 · 1 cancelled"), { timeout: 8_000 });

    gotoHash("#chat/corvid/default");
    await waitFor(() => expect(log().textContent).toContain("Every task is done"), {
      timeout: 4_000,
    });
    // Opened finished: seen and cleared, so neither the rail nor the strip shows it.
    await waitFor(() => expect(railBars().some((t) => t.startsWith("✓"))).toBe(false));
    expect(strip() === null).toBe(true);
  },
  LONG,
);
