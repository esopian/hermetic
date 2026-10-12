/**
 * §4.7 on the chat send path: a turn names the fleet it is for.
 *
 * `chat.turn` is the only way the page sends a message, and it used to carry
 * no target the head looked at, so a window left open across a fleet switch
 * could land a turn on a box in the fleet the app had moved to. Here the page's
 * `target` is set to a fleet the head is not serving — the same device
 * `fleet-switch.flow.test.tsx` uses for a stale window — and the message goes
 * through the real composer, the real `bind` and the real `dispatch`.
 *
 * The refusal has to be visible: it never reached the box, so the transcript
 * the page re-reads afterwards does not hold the message, and the band is the
 * only record that it was not sent.
 */
import { cleanup, screen, userEvent, waitFor } from "../dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { setFleetTarget } from "../../src/api/index.ts";
import { FIXTURE, type FlowHarness, flowHarness, gotoHash, mountPortal } from "./bridge.ts";

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

test("a turn from a window on another fleet is refused FLEET_MISMATCH, and says so", async () => {
  const composer = await openScribe();
  setFleetTarget({
    account_id: FIXTURE.account_id,
    region: FIXTURE.region,
    fleet_id: FIXTURE.staging.fleet_id,
  });

  await userEvent.type(composer, "hello from a stale window{Enter}");

  await waitFor(
    () => {
      const band = screen.getAllByRole("alert").find((el) => el.textContent?.includes("Not sent"));
      expect(band?.textContent).toContain("reload the page");
    },
    { timeout: 4_000 },
  );
  expect(harness!.calls.some((call) => call.name === "chat.turn")).toBe(true);
});

test("the same turn from a window on this fleet is sent", async () => {
  const composer = await openScribe();
  setFleetTarget(harness!.target);

  await userEvent.type(composer, "hello{Enter}");

  await waitFor(() => expect(harness!.calls.some((call) => call.name === "chat.turn")).toBe(true), {
    timeout: 4_000,
  });
  // Give a refusal the same chance to arrive that the first case waited for.
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(screen.queryAllByRole("alert").some((el) => el.textContent?.includes("Not sent"))).toBe(false);
});
