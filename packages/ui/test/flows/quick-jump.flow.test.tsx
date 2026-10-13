/**
 * Quick jump end to end: the real portal, the real `bind` and `dispatch`, over
 * the fixture's chat catalog.
 *
 * Outside the Chat view it finds agents, bots and commands, and no longer
 * offers the messages this browser happens to hold. In the Chat view a bare
 * query is a conversation search, and Enter opens the conversation in full.
 */
import { cleanup, screen, userEvent, waitFor, within } from "../dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
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

/** Atlas's default bot open in the Chat view, its canonical transcript read. */
async function openAtlas(): Promise<void> {
  harness = await flowHarness();
  await harness.ctx.hermetic().chat.listen({ instance: "atlas", listening: true });
  await harness.ctx.chatOwner.sync();
  gotoHash("#chat/atlas");
  mountPortal();
  await screen.findByText("Show me the diff you would apply.", {}, { timeout: 4_000 });
}

async function openQuickJump(): Promise<HTMLElement> {
  await userEvent.keyboard("{Control>}k{/Control}");
  const input = await screen.findByLabelText("Jump to a conversation or command");
  await waitFor(() => expect(document.activeElement).toBe(input));
  return input;
}

test("outside the Chat view, text from a loaded message offers no message row", async () => {
  await openAtlas();
  // Back to the fleet, with the conversation still selected and loaded.
  gotoHash("");

  const input = await openQuickJump();
  await userEvent.type(input, "diff you would");
  // Long enough for the list to settle on whatever it is going to show.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const list = screen.getByRole("listbox");
  expect(within(list).queryAllByRole("option")).toHaveLength(0);
  expect(list.textContent).toContain("No matches.");

  // The control: the same palette still finds the agent by name.
  await userEvent.clear(input);
  await userEvent.type(input, "atlas");
  await waitFor(() => expect(within(list).getAllByRole("option").length).toBeGreaterThan(0));
});

test("in the Chat view, a bare query searches conversations and Enter opens one in full", async () => {
  await openAtlas();

  const input = await openQuickJump();
  expect(input.getAttribute("placeholder")).toMatch(/^Search conversations/);
  await userEvent.type(input, "volume report");
  const list = screen.getByRole("listbox");
  const row = await within(list).findByRole("option", { name: /Reading the volume report/ });
  expect(row.getAttribute("aria-selected")).toBe("true");

  await userEvent.keyboard("{Enter}");
  await waitFor(() =>
    expect(window.location.hash).toBe("#chat/atlas/default?session=sx-atlas-desktop"),
  );
  expect(screen.queryByLabelText("Jump to a conversation or command")).toBeNull();
  await screen.findByText("Summarise the volume report in three lines.", {}, { timeout: 4_000 });
});
