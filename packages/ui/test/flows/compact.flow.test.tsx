/**
 * Compacting a conversation (§9.2): the strip's Compact button and a typed
 * `/compact` are one turn on `session.compress`, so both say they are running
 * while the box summarises and re-read the transcript when it lands. Through
 * the real composer, `bind` and `dispatch` over the fixture backend, whose
 * compaction takes a real one's beat when the focus names `E2E_COMPACT_SLOW`.
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

const strip = () => document.querySelector(".bm-strip") as HTMLElement;
const answer = (command: string) => document.querySelector(`[data-chat-command="${command}"]`);
const names = () => harness!.calls.map((call) => call.name);

test("a compaction says it is running, then lands and the transcript is re-read", async () => {
  const composer = await openScribe();
  await userEvent.type(composer, "/compact E2E_COMPACT_SLOW{Enter}");

  // The running state lasts the fixture's 1.5 s beat; waitFor sees it on the
  // render that draws it, so the window only bounds a page that never does.
  await waitFor(
    () => {
      expect(screen.getAllByText("Compacting context…").length).toBeGreaterThan(0);
      expect(within(strip()).getByRole("button", { name: "Compacting…" })).toBeTruthy();
    },
    { timeout: 4_000 },
  );
  const turnAt = names().lastIndexOf("chat.turn");

  await waitFor(
    () => {
      expect(answer("/compact E2E_COMPACT_SLOW")?.textContent ?? "").toContain(
        "✓ Context compression complete",
      );
      expect(within(strip()).getByRole("button", { name: "Compact" })).toBeTruthy();
      expect(names().slice(turnAt).includes("chat.history")).toBe(true);
    },
    { timeout: 4_000 },
  );
  // The answer outlives the re-read that followed the turn.
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(answer("/compact E2E_COMPACT_SLOW")).toBeTruthy();
  // 1.7 s of it is real time (the fixture's compaction beat and the settle above),
  // and the 4 s waits around it can exceed bun's 5 s under load.
}, 15_000);

test("the Compact button runs the same turn", async () => {
  await openScribe();
  await userEvent.click(within(strip()).getByRole("button", { name: "Compact" }));
  await waitFor(
    () => expect(answer("/compact")?.textContent ?? "").toContain("✓ Context compression complete"),
    { timeout: 4_000 },
  );
  expect(names()).toContain("chat.turn");
  expect(names()).not.toContain("chat.compact");
});

test("/compact in an additional session compacts it rather than reaching the slash worker", async () => {
  const composer = await openScribe();
  const rail = screen.getByRole("complementary", { name: "Bots and sessions" });
  await userEvent.click(within(rail).getByRole("tab", { name: "Sessions" }));
  await userEvent.click(within(rail).getByRole("button", { name: "New separate session" }));
  await waitFor(() => expect(window.location.hash).toContain("session="), { timeout: 4_000 });
  await userEvent.type(composer, "/compact{Enter}");
  await waitFor(
    () => expect(answer("/compact")?.textContent ?? "").toContain("✓ Context compression complete"),
    { timeout: 4_000 },
  );
});
