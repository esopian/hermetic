/**
 * Chat is the page the app opens on, over a real head.
 *
 * A launch with no hash lands on Chat, the view nav reads `CHAT | FLEET |
 * SETTINGS` in that order, and a Chat with nobody to talk to says why — no
 * agents at all, or none listening — with one button to the Fleet page where
 * both are fixed. Each flow sets up its own state against the fixture rather
 * than changing the shared seeds: the harness's fresh home has no instance
 * listened to, and an empty fleet is the agents read answering nothing.
 */
import { cleanup, screen, userEvent, waitFor, within } from "../dom.ts";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { FIXTURE, type FlowHarness, flowHarness, gotoHash, mountPortal } from "./bridge.ts";

let harness: FlowHarness | null = null;
let restoreSpy: (() => void) | null = null;

function reset(): void {
  window.localStorage.removeItem("hermetic.layout");
  window.sessionStorage.clear();
  gotoHash("");
}

beforeEach(reset);

afterEach(async () => {
  cleanup();
  restoreSpy?.();
  restoreSpy = null;
  await harness?.restore();
  harness = null;
  reset();
});

function views(): HTMLElement {
  return screen.getByRole("navigation", { name: "Views" });
}

function pressed(name: RegExp): string | null {
  return within(views()).getByRole("button", { name }).getAttribute("aria-pressed");
}

const NO_AGENTS =
  "Chat talks to the agents in this fleet, and there are none yet. Create one in Fleet.";
const NONE_LISTENING = "No agent is listening for chat. Turn on listening for an agent in Fleet.";

test("a launch with no hash lands on Chat", async () => {
  harness = await flowHarness();
  // One listened instance, so Chat has somebody to talk to and draws its
  // workspace rather than an empty state.
  await harness.ctx.hermetic().chat.listen({ instance: FIXTURE.sseAgent, listening: true });
  await harness.ctx.chatOwner.sync();
  mountPortal();

  await waitFor(() => expect(pressed(/^Chat/)).toBe("true"));
  expect(pressed(/^Fleet/)).toBe("false");
  // Spelled out in place, so a reload and back/forward both name the view.
  expect(window.location.hash).toBe("#chat");
  expect(screen.queryByRole("textbox", { name: "Filter agents" })).toBeNull();
  await waitFor(() => expect(document.querySelector(".ch-body")).not.toBeNull());
  expect(screen.queryByText(NONE_LISTENING)).toBeNull();
});

test("the view nav reads Chat, Work, Fleet, Settings", async () => {
  harness = await flowHarness();
  mountPortal();

  await waitFor(() => expect(pressed(/^Chat/)).toBe("true"));
  const labels = within(views())
    .getAllByRole("button")
    .map((b) => (b.textContent ?? "").trim().split(/\s+/)[0]);
  expect(labels).toEqual(["Chat", "Work", "Fleet", "Settings"]);
});

test("the fleet is still reachable by its own hash", async () => {
  harness = await flowHarness();
  gotoHash("#fleet");
  mountPortal();

  await screen.findByRole("textbox", { name: "Filter agents" });
  expect(pressed(/^Fleet/)).toBe("true");
  expect(window.location.hash).toBe("#fleet");
});

test("a hash naming nothing is replaced by the fleet's, not pushed over", async () => {
  harness = await flowHarness();
  gotoHash("#nowhere");
  const before = window.history.length;
  mountPortal();

  await screen.findByRole("textbox", { name: "Filter agents" });
  expect(window.location.hash).toBe("#fleet");
  // Back must not step onto `#nowhere`, an entry the view cannot follow.
  expect(window.history.length).toBe(before);
});

test("agents but none listening: Chat says so and goes to Fleet", async () => {
  harness = await flowHarness();
  mountPortal();
  const user = userEvent.setup();

  const panel = await screen.findByRole("region", { name: "Chat" });
  expect(within(panel).getByText(NONE_LISTENING)).toBeDefined();
  expect(screen.queryByText(NO_AGENTS)).toBeNull();

  await user.click(within(panel).getByRole("button", { name: /^Go to Fleet/ }));
  await screen.findByRole("textbox", { name: "Filter agents" });
  expect(pressed(/^Fleet/)).toBe("true");
  expect(window.location.hash).toBe("#fleet");
  expect(screen.queryByText(NONE_LISTENING)).toBeNull();
});

test("no agents at all: Chat says so and goes to Fleet", async () => {
  harness = await flowHarness();
  const list = spyOn(harness.ctx.hermetic().agents, "list").mockResolvedValue([]);
  restoreSpy = () => list.mockRestore();
  await harness.poll();
  mountPortal();
  const user = userEvent.setup();

  const panel = await screen.findByRole("region", { name: "Chat" });
  expect(within(panel).getByText(NO_AGENTS)).toBeDefined();
  expect(screen.queryByText(NONE_LISTENING)).toBeNull();

  await user.click(within(panel).getByRole("button", { name: /^Go to Fleet/ }));
  await waitFor(() => expect(pressed(/^Fleet/)).toBe("true"));
  expect(window.location.hash).toBe("#fleet");
  // The fleet's own empty state, with its create button, is what it lands on.
  await screen.findByRole("button", { name: /Create your first agent/ });
});
