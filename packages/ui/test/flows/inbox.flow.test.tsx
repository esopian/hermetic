/**
 * Inbox v2, end to end: the real centre and drawer over the real `dispatch`
 * and the fixture inbox (§4.9).
 *
 * What only a flow can say: that a clear and its undo reach core as the
 * requests the contract names (`notifications.clear`, then `ack {unread}` and
 * `clear {restore}`), that core's inbox view really does leave the snoozed and
 * cleared fixture rows out of the centre, and that the drawer's Snoozed and
 * History views read their own slice with `notifications.list({ view })`.
 */
import { cleanup, screen, userEvent, waitFor, within } from "../dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { type FlowHarness, flowHarness, gotoHash, mountPortal } from "./bridge.ts";

let harness: FlowHarness | null = null;

beforeEach(() => {
  window.localStorage.removeItem("hermetic.layout");
  window.sessionStorage.clear();
  gotoHash("");
});

afterEach(async () => {
  cleanup();
  await harness?.restore();
  harness = null;
  gotoHash("");
});

function callsTo(name: string): Record<string, unknown>[] {
  return (harness?.calls ?? [])
    .filter((c) => c.name === name)
    .map((c) => c.params as Record<string, unknown>);
}

function rowOf(title: string): HTMLElement {
  const el = screen.getByText(title).closest(".nt-item");
  if (!(el instanceof HTMLElement)) throw new Error(`no row for ${title}`);
  return el;
}

test("clear and undo reach core; the drawer reads Snoozed and History on demand", async () => {
  harness = await flowHarness();
  mountPortal();
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: /^Notifications/ }));
  await screen.findByText("create failed - quill");
  // Core's inbox view: the snoozed and the cleared fixture rows are not in it.
  expect(screen.queryByText("ember reboot finished")).toBeNull();
  expect(screen.queryByText("corvid stop finished")).toBeNull();

  await user.click(within(rowOf("create failed - quill")).getByRole("button", { name: /^Clear/ }));
  await waitFor(() => expect(screen.queryByText("create failed - quill")).toBeNull());
  await waitFor(() => expect(callsTo("notifications.clear").length).toBe(1));
  const cleared = callsTo("notifications.clear")[0]?.ids as string[];
  expect(cleared.length).toBe(1);

  await user.click(screen.getByRole("button", { name: /Undo/ }));
  await screen.findByText("create failed - quill");
  await waitFor(() =>
    expect(
      callsTo("notifications.clear").some(
        (p) => p.restore === true && (p.ids as string[])[0] === cleared[0],
      ),
    ).toBe(true),
  );
  // The fixture's quill failure was unread, so undo also marks it unread again.
  expect(callsTo("notifications.ack").some((p) => p.unread === true)).toBe(true);
  await waitFor(() => expect(rowOf("create failed - quill").getAttribute("data-unread")).toBe("true"));

  await user.click(screen.getByRole("button", { name: "Full inbox →" }));
  const drawer = await screen.findByRole("dialog", { name: "Inbox" });
  const rail = within(drawer).getByRole("navigation", { name: "Inbox views" });

  await user.click(within(rail).getByRole("button", { name: /^History/ }));
  await within(drawer).findByText("corvid stop finished");
  expect(callsTo("notifications.list").some((p) => p.view === "history")).toBe(true);

  await user.click(within(rail).getByRole("button", { name: /^Snoozed/ }));
  await within(drawer).findByText("ember reboot finished");
  expect(callsTo("notifications.list").some((p) => p.view === "snoozed")).toBe(true);

  // Core's auto-clear rule is read when the drawer opens.
  expect(callsTo("notifications.settings").length).toBeGreaterThan(0);

  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Inbox" })).toBeNull());
});
