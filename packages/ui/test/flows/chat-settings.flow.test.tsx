/**
 * Settings › Chat's redaction switch (§9.2), end to end: the real page against
 * the real `dispatch` over the fixture backend, with the switch landing in the
 * fixture home's own `prefs` row.
 *
 * Each gesture is asserted twice: on screen, and in what `chat.settings` now
 * answers from the head, so a page that only *looked* saved fails here. What
 * the switch does to a transcript is `tests/chat-redaction.test.ts`'s.
 */
import { cleanup, screen, userEvent, waitFor } from "../dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { dispatch } from "../../../app/src/handlers/dispatch.ts";
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

async function held(h: FlowHarness): Promise<{ redact: boolean }> {
  return (await dispatch(h.ctx, "chat.settings", {})) as { redact: boolean };
}

function toggle(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>("checkbox", { name: "Redact secrets in transcripts" });
}

test("the switch is off with a warning, and turning it on saves this laptop's setting", async () => {
  harness = await flowHarness();
  const h = harness;
  gotoHash("#settings/chat");
  mountPortal();
  const user = userEvent.setup();

  await waitFor(() => expect(toggle().disabled).toBe(false));
  expect(toggle().checked).toBe(false);
  expect(screen.getByText(/Redaction is off\./)).toBeDefined();
  expect(await held(h)).toEqual({ redact: false });

  await user.click(toggle());
  await waitFor(() => expect(toggle().checked).toBe(true));
  expect(screen.queryByText(/Redaction is off\./)).toBeNull();
  expect(await held(h)).toEqual({ redact: true });
  expect(h.calls.filter((c) => c.name === "chat.settings").map((c) => c.params)).toContainEqual({
    redact: true,
  });

  await user.click(toggle());
  await waitFor(() => expect(toggle().checked).toBe(false));
  expect(screen.getByText(/Redaction is off\./)).toBeDefined();
  expect(await held(h)).toEqual({ redact: false });
});

test("a page opened after the switch was set reads it back from core", async () => {
  harness = await flowHarness();
  await dispatch(harness.ctx, "chat.settings", { redact: true });
  gotoHash("#settings/chat");
  mountPortal();
  await waitFor(() => expect(toggle().checked).toBe(true));
  expect(screen.queryByText(/Redaction is off\./)).toBeNull();
});
