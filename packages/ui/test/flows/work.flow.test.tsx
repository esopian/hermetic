/**
 * WORK (§9.2, issue #117), driven end to end: the fixture's kanban boards read
 * over the real `kanban.*` handlers and the real `bind`, drawn by the shipping
 * `WorkView` and task drawer.
 */
import { cleanup, screen, userEvent, waitFor, within } from "../dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { type FlowHarness, flowHarness, gotoHash, mountPortal } from "./bridge.ts";

const VIEW_KEY = "hermetic.work.view";
let harness: FlowHarness | null = null;

function reset(): void {
  window.localStorage.removeItem(VIEW_KEY);
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

function row(instance: string): HTMLElement {
  const label = [...document.querySelectorAll<HTMLElement>(".wk-nm")].find(
    (el) => el.textContent === instance,
  );
  const r = label?.closest<HTMLElement>(".wk-mrow");
  if (!r) throw new Error(`no matrix row for ${instance}`);
  return r;
}

async function openWork(): Promise<void> {
  harness ??= await flowHarness();
  gotoHash("#work");
  mountPortal();
  await waitFor(() => expect(document.querySelector('[data-task-id="t_8b20d6e1"]')).not.toBeNull(), {
    timeout: 4_000,
  });
}

test("#work draws the matrix: atlas's cards, and ember's off row with its fix", async () => {
  await openWork();
  const atlas = row("atlas");
  expect(atlas.querySelector('[data-task-id="t_8b20d6e1"]')).not.toBeNull();
  expect(atlas.querySelector('[data-task-id="t_ab33c901"]')).not.toBeNull();
  const ember = row("ember");
  expect(ember.querySelector(".wk-off")).not.toBeNull();
  expect(within(ember).getByText("hermes plugins enable kanban").tagName).toBe("CODE");
  expect(within(ember).queryByRole("button", { name: /enable/i })).toBeNull();
});

test("the layout toggle is kept in localStorage and survives a remount", async () => {
  await openWork();
  await userEvent.click(screen.getByRole("button", { name: "Queue" }));
  expect(window.localStorage.getItem(VIEW_KEY)).toBe("queue");
  await waitFor(() => expect(document.querySelector(".wk-qwrap")).not.toBeNull());

  cleanup();
  gotoHash("#work");
  mountPortal();
  await waitFor(() => expect(document.querySelector(".wk-qwrap")).not.toBeNull(), { timeout: 4_000 });
  expect(document.querySelector(".wk-matrix")).toBeNull();
  expect(screen.getByRole("button", { name: "Queue" }).getAttribute("aria-pressed")).toBe("true");
});

test("answering a blocked card posts the answer and puts it back in Ready", async () => {
  await openWork();
  await userEvent.click(row("atlas").querySelector<HTMLElement>('[data-task-id="t_8b20d6e1"]')!);
  const drawer = await screen.findByRole("dialog", {}, { timeout: 4_000 });
  const answer = await within(drawer).findByRole("textbox", { name: "Your answer" });
  await userEvent.type(answer, "Up to $100/mo; self-hosting is fine.");
  await userEvent.click(within(drawer).getByRole("button", { name: "Answer & unblock" }));
  await waitFor(() => expect(drawer.querySelector(".wk-dh .wk-pill")?.textContent).toBe("ready"), {
    timeout: 4_000,
  });
  expect(within(drawer).getByText("Up to $100/mo; self-hosting is fine.")).toBeTruthy();
  expect(drawer.querySelector(".wk-cli")?.textContent).toContain("hermetic kanban unblock --input");
});
