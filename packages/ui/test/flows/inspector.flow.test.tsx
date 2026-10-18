/**
 * The developer tools' stream inspector (§9.2 "Developer tools"), end to end:
 * the real page against the real `bind` and `dispatch` over the fixture
 * backend, whose turns are captured with synthetic wire records standing in
 * for the socket the fixture does not have.
 *
 * Off, nothing of it is on screen and the head refuses its requests. Switched
 * on in Settings › Developer, the thread header grows its Inspect chip; the
 * chip opens the pane on that conversation and taps it, a turn's records
 * arrive in it, closing it unsubscribes, and switching the tools off again
 * takes the chip away and closes the head's door.
 */
import { cleanup, screen, userEvent, waitFor, within } from "../dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { isHermeticError } from "@hermetic/core";
import { dispatch } from "../../../app/src/handlers/dispatch.ts";
import { type FlowHarness, flowHarness, gotoHash, mountPortal } from "./bridge.ts";

let harness: FlowHarness | null = null;

function reset(): void {
  window.localStorage.removeItem("hermetic.layout");
  window.localStorage.removeItem("hermetic.inspector.width");
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

async function codeOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (e) {
    if (isHermeticError(e)) return e.code;
    throw e;
  }
  return "resolved";
}

function enableSwitch(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>("checkbox", { name: "Enable developer tools" });
}

function chip(): HTMLElement | null {
  return screen.queryByRole("button", { name: "Inspect" });
}

test("off by default: no chip, and every request but settings refuses", async () => {
  harness = await flowHarness();
  const h = harness;
  await h.ctx.hermetic().chat.listen({ instance: "atlas", listening: true });
  await h.ctx.chatOwner.sync();
  gotoHash("#chat/atlas/scribe");
  mountPortal();
  await screen.findByRole("textbox", { name: /^Message Marshall/ }, { timeout: 4_000 });
  expect(chip()).toBeNull();
  expect(screen.queryByRole("complementary", { name: "Stream inspector" })).toBeNull();
  // Nothing on the page asked the tools anything while they were off.
  expect(h.calls.filter((c) => c.name.startsWith("devtools."))).toEqual([]);
  expect(await codeOf(dispatch(h.ctx, "devtools.stats", {}))).toBe("DEVTOOLS_DISABLED");
});

test("switched on in Settings, the chip opens the inspector, a turn streams in, and off closes it all", async () => {
  harness = await flowHarness();
  const h = harness;
  await h.ctx.hermetic().chat.listen({ instance: "atlas", listening: true });
  await h.ctx.chatOwner.sync();
  gotoHash("#settings/developer");
  mountPortal();
  const user = userEvent.setup();

  await waitFor(() => expect(enableSwitch().disabled).toBe(false), { timeout: 4_000 });
  expect(enableSwitch().checked).toBe(false);
  await user.click(enableSwitch());
  await waitFor(() => expect(enableSwitch().checked).toBe(true));
  expect(await dispatch(h.ctx, "devtools.settings", {})).toMatchObject({ enabled: true });
  // The blocks that only mean something while the tools are on.
  await screen.findByText("Stream inspector");
  await screen.findByText("When to capture");

  gotoHash("#chat/atlas/scribe");
  const composer = await screen.findByRole(
    "textbox",
    { name: /^Message Marshall/ },
    { timeout: 4_000 },
  );
  await waitFor(() => expect(chip()).not.toBeNull());

  await user.click(chip()!);
  const pane = await screen.findByRole("complementary", { name: "Stream inspector" });
  await waitFor(() => expect(h.calls.some((c) => c.name === "devtools.tap")).toBe(true));
  expect(chip()?.getAttribute("aria-pressed")).toBe("true");

  await user.type(composer, "hello{Enter}");
  const wire = within(pane).getByRole("grid", { name: "Wire records" });
  // The list is virtualized, so the end of a turn is found through the filter.
  await waitFor(() => expect(Number(wire.getAttribute("aria-rowcount"))).toBeGreaterThan(0), {
    timeout: 6_000,
  });
  const filter = within(pane).getByRole("textbox", { name: "Filter records" });
  await user.type(filter, "type:message.complete");
  await waitFor(() => expect(within(wire).getAllByText("message.complete").length).toBeGreaterThan(0), {
    timeout: 6_000,
  });
  await user.clear(filter);

  // The Frames tab draws what core handed the head, with the page's reducer
  // outcome beside each frame this window reduced.
  await user.click(within(pane).getByRole("tab", { name: /^Frames/ }));
  const frames = within(pane).getByRole("grid", { name: "Frames records" });
  await waitFor(() => expect(within(frames).getAllByText("done").length).toBeGreaterThan(0));
  await waitFor(() =>
    expect(within(frames).queryAllByText(/^(appended|new block|applied)$/).length).toBeGreaterThan(0),
  );

  // State shows the text the deltas built, not the empty block the turn opened with.
  await user.click(within(pane).getByRole("tab", { name: /^State/ }));
  const tree = within(pane).getByRole("tree", { name: "Conversation state" });
  await waitFor(() =>
    expect(within(tree).getAllByText(/^now · text · ".+"$/).length).toBeGreaterThan(0),
  );
  await user.click(within(pane).getByRole("tab", { name: /^Frames/ }));

  // Selecting a row fills the detail.
  const row = within(pane)
    .getByRole("grid", { name: "Frames records" })
    .querySelector<HTMLElement>("[data-insp-row]");
  expect(row).not.toBeNull();
  await user.click(row!);
  expect(within(pane).queryByText("Select a row.")).toBeNull();

  // Closing the pane hangs up on the tap.
  await user.click(within(pane).getByRole("button", { name: "Close the inspector" }));
  await waitFor(() =>
    expect(screen.queryByRole("complementary", { name: "Stream inspector" })).toBeNull(),
  );
  await waitFor(() => expect(h.calls.some((c) => c.name === "devtools.untap")).toBe(true));

  // Off again: the chip goes, and the head refuses.
  gotoHash("#settings/developer");
  await waitFor(() => expect(enableSwitch().checked).toBe(true), { timeout: 4_000 });
  await user.click(enableSwitch());
  await waitFor(() => expect(enableSwitch().checked).toBe(false));
  expect(screen.queryByText("When to capture")).toBeNull();
  gotoHash("#chat/atlas/scribe");
  await screen.findByRole("textbox", { name: /^Message Marshall/ }, { timeout: 4_000 });
  expect(chip()).toBeNull();
  expect(await codeOf(dispatch(h.ctx, "devtools.stats", {}))).toBe("DEVTOOLS_DISABLED");
  expect(
    await codeOf(
      dispatch(
        h.ctx,
        "devtools.tap",
        { conversation: { instance: "atlas", bot: "scribe", session: null } },
        () => {},
      ),
    ),
  ).toBe("DEVTOOLS_DISABLED");
}, 30_000);

test("on, quick jump lists the two developer commands, and Inspect stream opens the pane", async () => {
  harness = await flowHarness();
  const h = harness;
  // Switched on before the page boots: `meta.get` carries the gate.
  await dispatch(h.ctx, "devtools.settings", { enabled: true });
  await h.ctx.hermetic().chat.listen({ instance: "atlas", listening: true });
  await h.ctx.chatOwner.sync();
  gotoHash("#chat/atlas/scribe");
  mountPortal();
  await screen.findByRole("textbox", { name: /^Message Marshall/ }, { timeout: 4_000 });
  await waitFor(() => expect(chip()).not.toBeNull());

  await userEvent.keyboard("{Control>}k{/Control}");
  const input = await screen.findByRole("combobox", { name: "Jump to a conversation or command" });
  await userEvent.type(input, ">");
  const list = screen.getByRole("listbox");
  await waitFor(() => expect(within(list).getByText("Inspect stream")).toBeDefined());
  expect(within(list).getByText("Open Settings › Developer")).toBeDefined();

  await userEvent.type(input, "insp{Enter}");
  await screen.findByRole("complementary", { name: "Stream inspector" });
}, 30_000);

test("off, quick jump lists neither developer command", async () => {
  harness = await flowHarness();
  const h = harness;
  await h.ctx.hermetic().chat.listen({ instance: "atlas", listening: true });
  await h.ctx.chatOwner.sync();
  gotoHash("#chat/atlas/scribe");
  mountPortal();
  await screen.findByRole("textbox", { name: /^Message Marshall/ }, { timeout: 4_000 });
  await userEvent.keyboard("{Control>}k{/Control}");
  const input = await screen.findByRole("combobox", { name: "Jump to a conversation or command" });
  await userEvent.type(input, ">");
  const list = screen.getByRole("listbox");
  await waitFor(() => expect(within(list).getByText("Settings")).toBeDefined());
  expect(within(list).queryByText("Inspect stream")).toBeNull();
  expect(within(list).queryByText("Open Settings › Developer")).toBeNull();
});
