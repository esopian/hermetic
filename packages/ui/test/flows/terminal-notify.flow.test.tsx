/**
 * Terminal notifications from a real session (issue #18, D10): the Terminal
 * section opens a session on the app's terminal host over the canned shell,
 * the shell runs a command long enough to count as finished, and the
 * attention rules (`app/src/terminal/attention.ts`) raise a row that reaches
 * the page through the poller's flush — the shipped path end to end.
 *
 * The host runs on a hand-advanced clock, so "ran for twelve seconds" takes
 * none. Frame coalescing runs on the same clock, so the helpers below tick it
 * while they wait.
 */
import { act, cleanup, flipPageHidden, screen, userEvent, waitFor, within } from "../dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { FakeTimers } from "../../../app/test/terminal/fake-timers.ts";
import { notificationSettings } from "../../src/api/index.ts";
import { FakeTermView, installFakeTerms } from "../fake-term.ts";
import { type FlowHarness, flowHarness, gotoHash, mountPortal } from "./bridge.ts";

let harness: FlowHarness | null = null;
let timers: FakeTimers;
let restoreTerms: (() => void) | null = null;

beforeEach(() => {
  window.localStorage.removeItem("hermetic.layout");
  window.localStorage.removeItem("hermetic.notifications");
  window.sessionStorage.clear();
  timers = new FakeTimers();
  restoreTerms = installFakeTerms();
  gotoHash("");
});

afterEach(async () => {
  cleanup();
  flipPageHidden(false);
  await harness?.restore();
  harness = null;
  restoreTerms?.();
  restoreTerms = null;
  gotoHash("");
});

function host(h: FlowHarness) {
  const terminals = h.ctx.terminals;
  if (terminals === undefined) throw new Error("the flow harness builds a terminal host");
  return terminals;
}

/**
 * Move the page by hash, inside `act`. Outside it, a hash change that leaves
 * the Terminal section followed by a `waitFor` that has to wait crashes Bun
 * 1.3.10 under happy-dom (a segfault, before React renders the change); a
 * flushed update is also simply the honest model of a navigation.
 */
async function go(hash: string): Promise<void> {
  await act(async () => {
    gotoHash(hash);
  });
}

/** Wait on real time for `done`, ticking the host's clock so coalesced frames go out. */
async function settle(done: () => void): Promise<void> {
  await waitFor(() => {
    timers.advance(20);
    done();
  });
}

/**
 * Connect atlas from its Terminal section, start `sleep 12`, and wait until
 * the shell reports it busy. Returns the session id.
 */
async function startSleep(h: FlowHarness): Promise<string> {
  gotoHash("#agent/atlas/terminal");
  mountPortal();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Connect →" }));
  await waitFor(() => expect(FakeTermView.instances.length).toBeGreaterThan(0));
  const view = FakeTermView.last();
  await settle(() => expect(view.text()).toContain("canned shell"));
  view.type("sleep 12\r");
  await settle(() => expect(host(h).list("atlas")[0]?.activity.state).toBe("busy"));
  const id = host(h).list("atlas")[0]?.session_id;
  if (id === undefined) throw new Error("no session");
  return id;
}

/** The command finishes twelve (fake) seconds later; let the mirror parse its marker. */
async function finishSleep(h: FlowHarness): Promise<void> {
  await act(async () => {
    timers.advance(12_000);
  });
  await settle(() => expect(host(h).list("atlas")[0]?.activity.state).toBe("idle"));
}

const FINISHED = /atlas · session 1 — sleep finished/;

test("a session finishing while the page is on Chat raises a toast that opens it", async () => {
  harness = await flowHarness({ terminalTimers: timers });
  const id = await startSleep(harness);

  // Off to Chat: the section unmounts, the session carries on unwatched.
  await go("#chat");
  await waitFor(() => expect(document.querySelector('[data-section="terminal"]')).toBeNull());
  await finishSleep(harness);

  const toast = (await screen.findByText(FINISHED)).closest(".nt-toast");
  if (!(toast instanceof HTMLElement)) throw new Error("no toast for the terminal row");
  expect(toast.getAttribute("data-kind")).toBe("terminal.finished");

  await userEvent.setup().click(within(toast).getByRole("button", { name: "Open session" }));
  await waitFor(() => expect(window.location.hash).toBe(`#agent/atlas/terminal/${id}`));
  const tab = await screen.findByRole("tab", { name: /^1 · / });
  await waitFor(() => expect(tab.getAttribute("aria-selected")).toBe("true"));
});

test("hidden while it finishes: the return toast offers the session, and Enter lands on it", async () => {
  harness = await flowHarness({ terminalTimers: timers });
  const id = await startSleep(harness);
  await go("#chat");
  await waitFor(() => expect(document.querySelector('[data-section="terminal"]')).toBeNull());

  await act(async () => {
    flipPageHidden(true);
  });
  await finishSleep(harness);
  await screen.findByText(FINISHED);
  await act(async () => {
    flipPageHidden(false);
  });

  const back = await screen.findByRole("alertdialog", { name: "Terminal · while you were away" });
  const open = within(back).getByRole("button", { name: "Open session ⏎" });
  await waitFor(() => expect(document.activeElement).toBe(open));
  await userEvent.setup().keyboard("{Enter}");
  await waitFor(() => expect(window.location.hash).toBe(`#agent/atlas/terminal/${id}`));
  await screen.findByRole("tab", { name: /^1 · / });
});

test("with terminal notifications off, a finished command raises nothing", async () => {
  harness = await flowHarness({ terminalTimers: timers });
  await notificationSettings({ terminal_alerts: false });
  expect(host(harness).alertsOn).toBe(false);
  await startSleep(harness);
  // The section says so where the operator is looking.
  await screen.findByText("◌ alerts off");

  await go("#chat");
  await waitFor(() => expect(document.querySelector('[data-section="terminal"]')).toBeNull());
  await finishSleep(harness);
  await harness.poll();
  expect(screen.queryByText(FINISHED)).toBeNull();
  expect(document.querySelector('.nt-toast[data-kind^="terminal."]')).toBeNull();
});
