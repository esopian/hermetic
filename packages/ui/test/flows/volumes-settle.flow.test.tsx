/**
 * A destroy that keeps its data volume re-reads the volume inventory when the
 * agent comes to rest (`settleVolumes`, `App.tsx`).
 *
 * The inventory is a 30s poll of its own and the fleet is a stream, so the
 * Volumes tab used to go on listing a destroyed agent's volume as in use by it
 * — and the nav's "n free · $x/mo" badge went on not counting it — until the
 * next poll or a manual Refresh. The destroy here is driven through core
 * directly, the way a CLI in another terminal would run it: the page learns of
 * it only from the fleet stream, which is exactly the path the fix listens on.
 */
import { cleanup, screen, waitFor } from "../dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { FIXTURE, flowHarness, gotoHash, mountPortal, type FlowHarness } from "./bridge.ts";

let harness: FlowHarness | null = null;

beforeEach(() => {
  window.localStorage.removeItem("hermetic.layout");
  gotoHash("");
});

afterEach(async () => {
  cleanup();
  await harness?.restore();
  harness = null;
  window.localStorage.removeItem("hermetic.layout");
  gotoHash("");
});

/** The Fleet tab's badge: `N`, or `N · M loose vols` while volumes sit free. */
function volumesBadge(): string {
  const nav = screen.getByRole("navigation", { name: "Views" });
  const button = [...nav.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").startsWith("Fleet"),
  );
  return button?.querySelector(".badge:not(.pending)")?.textContent ?? "";
}

function freeCount(badge: string): number {
  const m = /(\d+) loose vols?/.exec(badge);
  return m ? Number(m[1]) : 0;
}

test("destroying an agent but keeping its volume moves the volume to free without a refresh", async () => {
  const h = await flowHarness();
  harness = h;
  mountPortal();

  await screen.findByLabelText(`${FIXTURE.readyAgent} · ready`);
  const before = await waitFor(() => {
    const badge = volumesBadge();
    expect(badge).toMatch(/^\d+/);
    return freeCount(badge);
  });

  for await (const _ of h.ctx.hermetic().agents.destroy({ name: FIXTURE.readyAgent, yes: true })) {
    // Drained for its side effects; the page only sees the stream.
  }

  // One scan carries the `destroyed` row; nothing here asks for the volumes.
  await h.poll();
  await waitFor(() => expect(freeCount(volumesBadge())).toBe(before + 1), { timeout: 2000 });
}, 30_000);
