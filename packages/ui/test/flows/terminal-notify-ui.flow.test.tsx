/**
 * The terminal's notifications, end to end on the page side (issue #18): the
 * real portal over the real `dispatch` and the fixture inbox.
 *
 * No terminal session here — `terminal-notify.flow.test.tsx` drives a real
 * one on the harness's terminal host. A terminal row is raised the way the app's attention rules
 * raise one (`terminalNotices(hermetic).raise`, core's own writer, gated by
 * core's own `terminal_alerts`), and reaches the page as a `notification` frame
 * from the head's poller, so everything from the frame onwards is the shipped
 * path: the toast gate, `Open session`'s hash, the hash writer that has to
 * keep the session segment, and the return toast.
 */
import { act, cleanup, flipPageHidden, screen, userEvent, waitFor, within } from "../dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { terminalNotices } from "@hermetic/core";
import { type FlowHarness, flowHarness, gotoHash, mountPortal } from "./bridge.ts";

let harness: FlowHarness | null = null;

beforeEach(() => {
  window.localStorage.removeItem("hermetic.layout");
  window.localStorage.removeItem("hermetic.notifications");
  window.sessionStorage.clear();
  gotoHash("");
});

afterEach(async () => {
  cleanup();
  flipPageHidden(false);
  await harness?.restore();
  harness = null;
  gotoHash("");
});

function callsTo(name: string): Record<string, unknown>[] {
  return (harness?.calls ?? [])
    .filter((c) => c.name === name)
    .map((c) => c.params as Record<string, unknown>);
}

/** What the app's attention rules would report: atlas's session `s1` finished `apt`. */
async function raiseFinished(h: FlowHarness, session = "s1"): Promise<void> {
  terminalNotices(h.ctx.hermetic()).raise({
    fleet_id: h.target.fleet_id,
    agent: "atlas",
    session_id: session,
    session_index: 1,
    event: "finished",
    program: "apt",
    exit_code: 0,
    ran_ms: 372_000,
  });
  await h.poll();
}

const TITLE = "atlas · session 1 — apt finished · exit 0";

/** The window going away or coming back; in `act`, because the return toast is state it sets. */
async function setHidden(hidden: boolean): Promise<void> {
  await act(async () => {
    flipPageHidden(hidden);
  });
}

test("the settings switch writes terminal_alerts, and Off dims the Terminal group", async () => {
  harness = await flowHarness();
  gotoHash("#settings/notifications");
  mountPortal();
  const user = userEvent.setup();

  const master = await screen.findByRole("group", { name: "Terminal notifications" });
  // Enabled once core's setting has been read; On is the default.
  await waitFor(() =>
    expect(within(master).getByRole("button", { name: "On" }).getAttribute("aria-pressed")).toBe(
      "true",
    ),
  );
  expect(screen.getByRole("group", { name: "Terminal trigger" })).toBeTruthy();

  await user.click(within(master).getByRole("button", { name: "Off" }));
  await waitFor(() =>
    expect(callsTo("notifications.settings").some((p) => p.terminal_alerts === false)).toBe(true),
  );
  await screen.findByText("Terminal notifications are off · nothing is raised");
  const dimmed = document.querySelector('.st-dim [data-field="terminal"]');
  expect(dimmed).not.toBeNull();
  expect(screen.queryByRole("group", { name: "Terminal trigger" })).toBeNull();

  // Core holds the line: with the switch off, a session's report writes nothing.
  await raiseFinished(harness);
  expect(screen.queryByText(TITLE)).toBeNull();

  await user.click(within(master).getByRole("button", { name: "On" }));
  await waitFor(() =>
    expect(callsTo("notifications.settings").some((p) => p.terminal_alerts === true)).toBe(true),
  );
  await screen.findByRole("group", { name: "Terminal trigger" });
  expect(screen.queryByText("Terminal notifications are off · nothing is raised")).toBeNull();
});

test("a terminal toast's Open session lands on the agent's Terminal section, on the session", async () => {
  harness = await flowHarness();
  mountPortal();
  const user = userEvent.setup();
  await screen.findAllByText("atlas");

  await raiseFinished(harness);
  const toast = (await screen.findByText(TITLE)).closest(".nt-toast");
  if (!(toast instanceof HTMLElement)) throw new Error("no toast for the terminal row");
  expect(toast.getAttribute("data-kind")).toBe("terminal.finished");

  await user.click(within(toast).getByRole("button", { name: "Open session" }));
  // The hash writer keeps the session segment rather than respelling it away.
  await waitFor(() => expect(window.location.hash).toBe("#agent/atlas/terminal/s1"));
  await waitFor(() => expect(document.querySelector('[data-section="terminal"]')).not.toBeNull());
  expect(window.location.hash).toBe("#agent/atlas/terminal/s1");
});

test("hidden, a terminal row arrives; on return the pinned toast offers it, and Enter lands", async () => {
  harness = await flowHarness();
  mountPortal();
  const user = userEvent.setup();
  await screen.findAllByText("atlas");

  await setHidden(true);
  await raiseFinished(harness);
  await screen.findByText(TITLE);
  expect(screen.queryByRole("alertdialog", { name: "Terminal · while you were away" })).toBeNull();

  await setHidden(false);
  const back = await screen.findByRole("alertdialog", { name: "Terminal · while you were away" });
  expect(within(back).getByText(TITLE)).toBeTruthy();
  // The stacked toast it speaks for is gone: one copy, not two.
  expect(document.querySelector(".nt-toast")).toBeNull();
  const open = within(back).getByRole("button", { name: "Open session ⏎" });
  await waitFor(() => expect(document.activeElement).toBe(open));

  await user.keyboard("{Enter}");
  await waitFor(() => expect(window.location.hash).toBe("#agent/atlas/terminal/s1"));
  expect(screen.queryByRole("alertdialog", { name: "Terminal · while you were away" })).toBeNull();
  // Opening the session reads its row.
  await waitFor(() => expect(callsTo("notifications.ack").length).toBeGreaterThan(0));
});

test("Esc dismisses the return toast and goes nowhere", async () => {
  harness = await flowHarness();
  mountPortal();
  const user = userEvent.setup();
  await screen.findAllByText("atlas");

  await setHidden(true);
  await raiseFinished(harness);
  await screen.findByText(TITLE);
  await setHidden(false);
  const back = await screen.findByRole("alertdialog", { name: "Terminal · while you were away" });
  await waitFor(() =>
    expect(document.activeElement).toBe(within(back).getByRole("button", { name: "Open session ⏎" })),
  );

  await user.keyboard("{Escape}");
  await waitFor(() =>
    expect(screen.queryByRole("alertdialog", { name: "Terminal · while you were away" })).toBeNull(),
  );
  expect(window.location.hash).not.toContain("terminal");
});
