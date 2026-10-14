/**
 * A bot's additional sessions survive clicking away from one.
 *
 * The rail's Sessions tab lists the sessions of the selected bot. That list is
 * read once per conversation record, and the record for the bot's Bot Chat read
 * its copy before a "+ New separate session" existed. Clicking the bot again
 * selected that record, and its stale list said the new session did not exist:
 * it vanished from the rail, with or without a message sent into it. Both
 * cases go through the real rail, the real `bind` and the real `dispatch` over
 * the fixture backend, which persists an empty session the moment `chat.open`
 * creates it, as a real gateway does.
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

async function openScribe(): Promise<HTMLElement> {
  harness = await flowHarness();
  await harness.ctx.hermetic().chat.listen({ instance: "atlas", listening: true });
  await harness.ctx.chatOwner.sync();
  gotoHash("#chat/atlas/scribe");
  mountPortal();
  return await screen.findByRole("textbox", { name: /^Message Marshall/ }, { timeout: 4_000 });
}

function rail(): HTMLElement {
  return screen.getByRole("complementary", { name: "Bots and sessions" });
}

async function newSession(): Promise<void> {
  await userEvent.click(within(rail()).getByRole("tab", { name: "Sessions" }));
  // The fixture seeds one additional session for Marshall; the list is read.
  await waitFor(
    () => expect(within(rail()).getByRole("button", { name: /Daily digest/ })).toBeTruthy(),
    {
      timeout: 4_000,
    },
  );
  await userEvent.click(within(rail()).getByRole("button", { name: "New separate session" }));
  await waitFor(
    () => {
      const row = within(rail()).getByRole("button", { name: /Additional chat/ });
      expect(row.getAttribute("aria-current")).toBe("true");
    },
    { timeout: 4_000 },
  );
}

async function clickBackToBotChat(): Promise<void> {
  await userEvent.click(within(rail()).getByRole("tab", { name: /^Bots/ }));
  // The Bots tab opens on Unread, which hides a bot with nothing new in it.
  await userEvent.click(within(rail()).getByRole("button", { name: "All" }));
  await userEvent.click(within(rail()).getAllByRole("button", { name: /Marshall/ })[0]!);
  await waitFor(() => expect(window.location.hash).toBe("#chat/atlas/scribe"), { timeout: 4_000 });
  await userEvent.click(within(rail()).getByRole("tab", { name: "Sessions" }));
}

test("a new session with nothing sent is still listed after clicking the bot", async () => {
  await openScribe();
  await newSession();

  await clickBackToBotChat();

  await waitFor(
    () => expect(within(rail()).getByRole("button", { name: /Additional chat/ })).toBeTruthy(),
    { timeout: 4_000 },
  );
  expect(within(rail()).getByRole("button", { name: /Daily digest/ })).toBeTruthy();
});

test("a new session with a turn in it is still listed after clicking the bot", async () => {
  await openScribe();
  await newSession();
  const composer = await screen.findByRole("textbox", { name: /^Message Marshall/ });
  await userEvent.type(composer, "hello in the new session{Enter}");
  await waitFor(() => expect(harness!.calls.some((call) => call.name === "chat.turn")).toBe(true), {
    timeout: 4_000,
  });
  await waitFor(
    () =>
      expect(within(rail()).getByRole("button", { name: /Additional chat/ }).textContent).toContain(
        "2 turns",
      ),
    { timeout: 4_000 },
  );

  await clickBackToBotChat();

  await waitFor(
    () => expect(within(rail()).getByRole("button", { name: /Additional chat/ })).toBeTruthy(),
    { timeout: 4_000 },
  );
});
