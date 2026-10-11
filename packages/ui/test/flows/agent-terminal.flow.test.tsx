/**
 * The agent drawer's Terminal section end to end (issue #18): the real
 * portal, the real `bind` and `dispatch`, the app's real terminal host over
 * the canned shell (`pty-fixture.ts`) — nothing spawned. The only stand-in is
 * the screen itself (`fake-term.ts`), because happy-dom cannot run xterm.
 */
import { cleanup, screen, userEvent, waitFor, within } from "../dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { FakeTermView, installFakeTerms } from "../fake-term.ts";
import { type FlowHarness, flowHarness, gotoHash, mountPortal } from "./bridge.ts";

let harness: FlowHarness | null = null;
let restoreTerms: (() => void) | null = null;

beforeEach(() => {
  window.localStorage.removeItem("hermetic.layout");
  window.sessionStorage.clear();
  restoreTerms = installFakeTerms();
  gotoHash("");
});

afterEach(async () => {
  cleanup();
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

function callsTo(name: string): unknown[] {
  return (harness?.calls ?? []).filter((c) => c.name === name).map((c) => c.params);
}

/** The newest screen, once the section has made one. */
async function lastScreen(): Promise<FakeTermView> {
  await waitFor(() => expect(FakeTermView.instances.length).toBeGreaterThan(0));
  return FakeTermView.last();
}

test("cold until Connect; whoami answers; Logs and back restores the screen; End closes it", async () => {
  harness = await flowHarness();
  gotoHash("#agent/atlas/terminal");
  mountPortal();
  const user = userEvent.setup();

  const connect = await screen.findByRole("button", { name: "Connect →" });
  // D3: opening the section spawned nothing, and asked for nothing but the list.
  expect(host(harness).list("atlas")).toEqual([]);
  expect(callsTo("terminal.open")).toEqual([]);
  // The command it would run, from core's own `ssh` argv.
  await waitFor(() => expect(screen.getAllByText(/^tailscale ssh hermes@/).length).toBeGreaterThan(0));

  await user.click(connect);
  await waitFor(() => expect(host(harness as FlowHarness).list("atlas").length).toBe(1));
  const first = await lastScreen();
  await waitFor(() => expect(first.text()).toContain("canned shell"));
  // The sub-tab and the nav both say there is a session now.
  expect(screen.getByRole("tab", { name: /1 · / })).toBeTruthy();
  await waitFor(() =>
    expect(document.getElementById("agent-tab-terminal-sub")?.textContent).toContain("1 session"),
  );
  expect(document.querySelector(".dr-snav-foot")?.textContent).toContain("hermetic ssh");

  first.type("whoami\r");
  await waitFor(() => expect(first.text()).toContain("whoami\nhermes"));

  // Leave for Logs: the session outlives the section.
  await user.click(screen.getByRole("tab", { name: /Logs/ }));
  await waitFor(() => expect(first.disposed).toBe(true));
  expect(host(harness).list("atlas")[0]?.state).toBe("live");

  // Back: a new screen, painted from the snapshot.
  await user.click(screen.getByRole("tab", { name: /Terminal/ }));
  await waitFor(() => expect(FakeTermView.instances.length).toBe(2));
  const second = FakeTermView.last();
  await waitFor(() => expect(second.text()).toContain("whoami\nhermes"));

  await user.click(screen.getByRole("button", { name: "End" }));
  await waitFor(() => expect(host(harness as FlowHarness).list("atlas")).toEqual([]));
  await screen.findByRole("button", { name: "Connect →" });
});

test("keystrokes stay with the shell: Esc on the screen does not close the drawer", async () => {
  harness = await flowHarness();
  gotoHash("#agent/atlas/terminal");
  mountPortal();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Connect →" }));
  const view = await lastScreen();
  await waitFor(() => expect(view.text()).toContain("canned shell"));
  expect(screen.getByText(/keys go to the shell while it has focus/)).toBeTruthy();

  const input = screen.getByLabelText("Terminal input");
  input.focus();
  await user.keyboard("{Escape}");
  expect(document.querySelector('[aria-labelledby="agent-title"]')).not.toBeNull();
  expect(window.location.hash).toContain("#agent/atlas/terminal");

  // Off the screen, Esc is the drawer's again.
  (document.activeElement as HTMLElement | null)?.blur();
  screen.getByRole("tab", { name: /Terminal/ }).focus();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(document.querySelector('[aria-labelledby="agent-title"]')).toBeNull());
});

test("a stopped agent gets the unavailable panel, and Go to Lifecycle goes there", async () => {
  harness = await flowHarness();
  gotoHash("#agent/juniper/terminal");
  mountPortal();
  const user = userEvent.setup();

  const panel = await screen.findByRole("region", { name: /No shell while this agent is stopped/ });
  expect(within(panel).queryByRole("button", { name: "Connect →" })).toBeNull();
  expect(document.getElementById("agent-tab-terminal-sub")?.textContent).toContain("instance stopped");
  await user.click(within(panel).getByRole("button", { name: "Go to Lifecycle →" }));
  await waitFor(() => expect(window.location.hash).toBe("#agent/juniper/lifecycle"));
  expect(callsTo("terminal.open")).toEqual([]);
});

test("three sessions is the cap: + New is disabled and says why", async () => {
  harness = await flowHarness();
  gotoHash("#agent/atlas/terminal");
  mountPortal();
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: "Connect →" }));
  for (const n of [2, 3]) {
    const add = await screen.findByRole("button", { name: "+ New" });
    await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
    await user.click(add);
    await waitFor(() => expect(host(harness as FlowHarness).list("atlas").length).toBe(n));
  }
  const add = screen.getByRole("button", { name: "+ New" }) as HTMLButtonElement;
  await waitFor(() => expect(add.disabled).toBe(true));
  expect(add.title).toContain("3 sessions is the limit per agent");
  expect(screen.getAllByRole("tab", { name: /^\d · / }).length).toBe(3);
  await waitFor(() =>
    expect(document.getElementById("agent-tab-terminal-sub")?.textContent).toContain("3 sessions"),
  );
});

test("a deep link to a session the app no longer holds says so and offers Connect", async () => {
  harness = await flowHarness();
  gotoHash("#agent/atlas/terminal/gone1");
  mountPortal();
  await screen.findByRole("region", { name: "That session has closed" });
  expect(screen.getByRole("button", { name: "Connect →" })).toBeTruthy();
  expect(window.location.hash).toBe("#agent/atlas/terminal/gone1");
});

test("a deep link to a session still listed selects it", async () => {
  harness = await flowHarness();
  const opened = await host(harness).open({ name: "atlas", cols: 80, rows: 24 });
  await host(harness).open({ name: "atlas", cols: 80, rows: 24 });
  gotoHash(`#agent/atlas/terminal/${opened.session_id}`);
  mountPortal();
  const tab = await screen.findByRole("tab", { name: /^1 · / });
  await waitFor(() => expect(tab.getAttribute("aria-selected")).toBe("true"));
  const view = await lastScreen();
  await waitFor(() => expect(view.text()).toContain("canned shell"));
});

test("Ctrl-K on the screen is the shell's (kill-line), not quick jump; off the screen it is quick jump", async () => {
  harness = await flowHarness();
  gotoHash("#agent/atlas/terminal");
  mountPortal();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Connect →" }));
  const view = await lastScreen();
  await waitFor(() => expect(view.text()).toContain("canned shell"));

  screen.getByLabelText("Terminal input").focus();
  await user.keyboard("{Control>}k{/Control}");
  expect(screen.queryByLabelText("Jump to a conversation or command")).toBeNull();

  // The control: the same chord with focus on the drawer's own nav opens it.
  screen.getByRole("tab", { name: /Terminal/ }).focus();
  await user.keyboard("{Control>}k{/Control}");
  await screen.findByLabelText("Jump to a conversation or command");
});
