/**
 * The gateway's internal signals never draw a row (§9.2).
 *
 * Atlas's portal thread stores, beside an `unknown` `workspace.checkpoint`
 * block, an `unknown` `platforms.changed` one: a change-watcher broadcast
 * Hermes Desktop consumes without drawing anything
 * (`@hermetic/core/shared` `HERMES_INTERNAL_EVENTS`). Read over the real
 * `chat.history` handler and the real `bind`, and drawn by the shipping
 * `Thread`, the first must render and the second must not.
 */
import { cleanup, waitFor } from "../dom.ts";
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

test("an unknown event renders; a gateway internal signal beside it does not", async () => {
  harness = await flowHarness();
  await harness.ctx.hermetic().chat.listen({ instance: "atlas", listening: true });
  await harness.ctx.chatOwner.sync();
  gotoHash("#chat/atlas/default?session=sx-atlas-portal");
  mountPortal();
  await waitFor(
    () =>
      expect(document.querySelector(".ch-log")?.textContent ?? "").toContain("workspace.checkpoint"),
    { timeout: 4_000 },
  );
  // Not vacuous: the stored transcript does carry the internal signal.
  const stored = await harness.ctx
    .hermetic()
    .chat.history({ instance: "atlas", bot: "default", session: "sx-atlas-portal" });
  expect(
    stored.messages.some((m) =>
      m.blocks.some((b) => b.kind === "unknown" && b.name === "platforms.changed"),
    ),
  ).toBe(true);
  expect(document.body.textContent ?? "").not.toContain("platforms.changed");
});
