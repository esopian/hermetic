/**
 * A slash command typed into the composer (issue #73) is answered by the
 * command layer and drawn as a command, not as the agent's prose.
 *
 * Through the real composer, the real `bind` and the real `dispatch`, over the
 * fixture backend, whose command layer (`fixture-chat-command.ts`) answers the
 * way a box's does: `/help` with its text, an unknown name with a refusal.
 */
import { cleanup, screen, userEvent, waitFor } from "../dom.ts";
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

test("/help draws the command's output as a command block", async () => {
  const composer = await openScribe();
  await userEvent.type(composer, "/help{Enter}");
  await waitFor(
    () => {
      const block = document.querySelector('[data-chat-command="/help"]');
      expect(block?.textContent ?? "").toContain("Available commands:");
    },
    { timeout: 4_000 },
  );
  expect(document.querySelector('[data-chat-command="/help"]')?.getAttribute("role")).toBe("note");
  // The box keeps no copy of a command's answer, and the transcript re-read
  // that follows every turn must not take it off the screen.
  const turnAt = harness!.calls.findIndex((call) => call.name === "chat.turn");
  await waitFor(
    () => expect(harness!.calls.slice(turnAt).some((call) => call.name === "chat.history")).toBe(true),
    { timeout: 4_000 },
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(document.querySelector('[data-chat-command="/help"]')?.textContent ?? "").toContain(
    "Available commands:",
  );
  // The line itself never became a prompt the bot answered in prose.
  const stored = await harness!.ctx.hermetic().chat.history({ instance: "atlas", bot: "scribe" });
  expect(
    stored.messages.some((m) => m.blocks.some((b) => b.kind === "text" && b.markdown === "/help")),
  ).toBe(false);
});

test("an unknown command is a visible error", async () => {
  const composer = await openScribe();
  await userEvent.type(composer, "/nope{Enter}");
  await waitFor(
    () => {
      const block = document.querySelector('[data-chat-command="/nope"]');
      expect(block?.getAttribute("role")).toBe("alert");
      expect(block?.textContent ?? "").toContain("Unknown command /nope");
    },
    { timeout: 4_000 },
  );
});
