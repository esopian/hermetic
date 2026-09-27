/**
 * A version-guarded drawer write sends the version core holds.
 *
 * `agents.set` carries the `expected_version` of the row the drawer was
 * composed against, and core refuses a write whose version is not the current
 * one. On a fresh fixture `atlas` sits on an old bedrock revision, so Refresh
 * profile is offered straight away — and it used to fail inline with "atlas is
 * at version N, not M; re-read and retry", because the row the page held did
 * not carry the version core had.
 */
import { cleanup, screen, userEvent, waitFor, within } from "../dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { type FlowHarness, flowHarness, gotoHash, mountPortal } from "./bridge.ts";

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

/** Every `agents.set` the page sent, as the params it sent. */
function sets(h: FlowHarness): Array<{ expected_version?: number }> {
  return h.calls
    .filter((c) => c.name === "agents.set")
    .map((c) => c.params as { expected_version?: number });
}

test("Refresh profile, then a second guarded write, both carry the version core holds", async () => {
  harness = await flowHarness();
  const h = harness;
  /** What each accepted write answered with — the version core moved to. */
  const answered: number[] = [];
  h.intercept("agents.set", async (_params, passthrough) => {
    const row = (await passthrough()) as { version: number };
    answered.push(row.version);
    return row;
  });
  mountPortal();
  const user = userEvent.setup();

  await user.click(await screen.findByLabelText(/^atlas · /));
  const drawer = await waitFor(() => {
    const el = screen.getByRole("dialog");
    expect(el.querySelector(".detail-name")?.textContent).toBe("atlas");
    return el;
  });
  await user.click(within(drawer).getByRole("tab", { name: "Config" }));

  // The repro: a fresh fixture, atlas on an old revision, Refresh profile.
  await user.click(await within(drawer).findByRole("button", { name: "Refresh profile" }));
  await waitFor(() => expect(within(drawer).getByText(/pending apply/)).toBeTruthy());
  expect(within(drawer).queryByText(/re-read and retry/)).toBeNull();
  expect(answered.length).toBe(1);

  // The write moved core's row on; no scan has run since (the harness never
  // polls on its own), so the only way the drawer can know the new version is
  // the answer it got back. A second guarded write has to send that one.
  await user.click(within(drawer).getByRole("button", { name: "Change profile or model" }));
  await user.click(within(drawer).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(sets(h).length).toBe(2));
  await waitFor(() => expect(within(drawer).queryByRole("button", { name: "Saving…" })).toBeNull());
  expect(within(drawer).queryByText(/re-read and retry/)).toBeNull();
  expect(sets(h)[1]?.expected_version).toBe(answered[0]);
  expect(answered.length).toBe(2);
}, 20_000);
