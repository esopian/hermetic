/**
 * Settings → Providers against the real head: the profile rows, the create
 * drawer and the fleet-default action, over the fixture's `main` fleet.
 *
 * Each case is a QA finding pinned where the operator saw it — on the row —
 * rather than only at the core method that caused it, so a regression in
 * either the head's answer or the page's rendering of it fails here.
 */
import { cleanup, screen, waitFor, within } from "../dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { userEvent } from "../dom.ts";
import { flowHarness, gotoHash, mountPortal, type FlowHarness } from "./bridge.ts";

let harness: FlowHarness | null = null;

beforeEach(() => {
  window.localStorage.removeItem("hermetic.layout");
  gotoHash("");
});

afterEach(async () => {
  cleanup();
  await harness?.restore();
  harness = null;
  gotoHash("");
});

/** One profile's row, found by the id it carries. */
function card(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-profile="${id}"]`);
  if (el === null) throw new Error(`no row for ${id}`);
  return el;
}

/** The table's columns, by the header the value sits under. */
const COLUMN = { agents: 4, revision: 5 } as const;

/** The value in one of a row's columns. */
function kv(el: HTMLElement, key: keyof typeof COLUMN): string {
  return el.querySelectorAll("td")[COLUMN[key]]?.textContent ?? "";
}

type User = ReturnType<typeof userEvent.setup>;

/**
 * A row's "Set as fleet default" menu item, or undefined when its `…` menu
 * does not offer one. Plain DOM rather than a role query: a failing role query
 * prints the whole portal on every `waitFor` retry, which turns one red
 * assertion into a run that never finishes. Leaves the menu open.
 */
async function defaultItem(user: User, el: HTMLElement): Promise<HTMLButtonElement | undefined> {
  const more = el.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
  if (more === null) throw new Error("row has no actions menu");
  if (more.getAttribute("aria-expanded") !== "true") await user.click(more);
  return [...el.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) =>
    (b.textContent ?? "").startsWith("Set as fleet default"),
  );
}

/** Whether a row offers Set-as-default — a boolean, so a failure prints one word. */
async function offersDefault(user: User, el: HTMLElement): Promise<boolean> {
  const offered = (await defaultItem(user, el)) !== undefined;
  await user.keyboard("{Escape}");
  return offered;
}

const BEDROCK = "bdr00004";
const ANTHROPIC = "ant00001";
const BEDROCK_AGENTS = "atlas, ember, fathom, granite, heron, ibis, juniper, lumen";

test("creating a second Bedrock profile leaves the first one's agents on its card", async () => {
  harness = await flowHarness();
  gotoHash("#settings/providers");
  mountPortal();
  const user = userEvent.setup();

  await waitFor(() => expect(kv(card(BEDROCK), "agents")).toBe(BEDROCK_AGENTS));

  await user.click(screen.getByRole("button", { name: "New profile" }));
  const drawer = await screen.findByRole("dialog");
  await user.selectOptions(within(drawer).getByRole("combobox"), "bedrock");
  const name = within(drawer).getByLabelText("Name");
  await user.clear(name);
  await user.type(name, "qa-bedrock");
  await user.click(within(drawer).getByRole("button", { name: "Create profile" }));

  await waitFor(() => {
    const created = [...document.querySelectorAll<HTMLElement>("[data-profile]")].find((n) =>
      (n.querySelector(".st-name b")?.textContent ?? "").startsWith("qa-bedrock"),
    );
    expect(created).toBeDefined();
    expect(kv(created!, "agents")).toBe("—");
  });
  expect(kv(card(BEDROCK), "agents")).toBe(BEDROCK_AGENTS);
});

test("the fleet default has no Set-as-default, and setting one leaves its revision", async () => {
  harness = await flowHarness();
  gotoHash("#settings/providers");
  mountPortal();
  const user = userEvent.setup();

  await waitFor(() => expect(kv(card(BEDROCK), "revision")).toBe("r2"));
  expect(await offersDefault(user, card(ANTHROPIC))).toBe(false);

  await user.click((await defaultItem(user, card(BEDROCK)))!);

  await waitFor(() => expect(card(BEDROCK).querySelector(".tag")?.textContent).toBe("fleet default"));
  expect(await offersDefault(user, card(BEDROCK))).toBe(false);
  expect(await offersDefault(user, card(ANTHROPIC))).toBe(true);
  expect(kv(card(BEDROCK), "revision")).toBe("r2");
  expect(kv(card(ANTHROPIC), "revision")).toBe("r1");
});
