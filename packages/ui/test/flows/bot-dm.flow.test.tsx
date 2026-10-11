/**
 * A bot-to-bot DM, driven end to end over the fixture backend.
 *
 * The fixture seeds atlas's Marshall (`scribe`) messaging NickQABot
 * (`auditor`) with `message_agent` (`fixture-chat-dms.ts`). Marshall's Bot
 * Chat holds the call; NickQABot's holds the delivery and its reply. Both are
 * read over the real `chat.history` handler and the real `bind`, and the
 * exchange's read of the target's Bot Chat goes the same way.
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

async function open(bot: string): Promise<void> {
  harness = await flowHarness();
  await harness.ctx.hermetic().chat.listen({ instance: "atlas", listening: true });
  await harness.ctx.chatOwner.sync();
  gotoHash(`#chat/atlas/${bot}`);
  mountPortal();
}

test("Marshall's DM is a Messaged marker that opens the exchange with NickQABot's reply", async () => {
  await open("scribe");
  const marker = await screen.findByRole(
    "button",
    { name: /Messaged\s*NickQABot/ },
    { timeout: 4_000 },
  );
  await userEvent.click(marker);
  const dialog = screen.getByRole("dialog", { name: "Marshall ⇄ NickQABot" });
  await waitFor(() => expect(dialog.textContent).toContain("Re-QA of #4124 at e4cf2ec:"), {
    timeout: 4_000,
  });
  expect(dialog.textContent).toContain("Evan has asked for another targeted re-QA");
  expect(within(dialog).getByRole("button", { name: "Open NickQABot's Bot Chat" })).toBeTruthy();
});

test("NickQABot's delivery from Marshall is Marshall speaking, not You", async () => {
  await open("auditor");
  const marker = await screen.findByRole(
    "button",
    { name: /Message from Marshall/ },
    { timeout: 4_000 },
  );
  const article = marker.closest("article")!;
  expect(article.querySelector(".ch-msg-who")?.textContent).toBe("Marshall");
  expect(article.classList.contains("me")).toBe(false);
});
