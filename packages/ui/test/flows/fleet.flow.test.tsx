/**
 * §11.6's three basics, ported off Playwright.
 *
 * **What the original asserted** (`tests/e2e/fleet.e2e.ts`): that the fleet
 * table renders every seeded agent under the twelve documented columns and
 * hides the destroyed `oriole` until the toolbar asks for it; that the account
 * header — which is also the fleet switcher — is on every hash route carrying
 * the frozen account, region and alias; and that stopping an agent through its
 * drawer rewrites that agent's row in a page nobody reloaded, carried there by
 * the fleet stream and nothing else.
 *
 * **What this port asserts**: the same three, against the real handlers. The
 * third is the one that matters most and the one that changes shape: over HTTP
 * the carrier was `/api/fleet/stream`, here it is `fleet.subscribe` pushing
 * sink frames through the bridge into the page's subscription — the same
 * handler, the same poller, the same frames, one less socket. It is this
 * suite's proof that a real push reaches a real component: the row is asserted
 * to move with no re-read of the fleet in between, and the calls the UI made
 * are checked to confirm there was none.
 *
 * **What a happy-dom test cannot assert**: three things.
 *   1. Visibility, in the layout sense — no stylesheet is loaded and no box is
 *      measured, so `toBeVisible` becomes "is in the document". None of these
 *      elements is hidden by CSS; they are conditionally rendered.
 *   2. A real navigation. `page.goto("/#settings")` reloaded the document;
 *      here each route is a fresh mount with the hash already set, which is
 *      what `nav-state.tsx` reads on mount anyway.
 *   3. The three-second poll interval. The poller is driven by hand
 *      (`harness.poll()`), so the stream assertion is about delivery rather
 *      than about a clock — and it is deterministic instead of merely fast.
 *
 * Unlike the original, which ran `serial` against one shared portal, each test
 * here gets its own fixture fleet: the `stop` below leaves `kestrel` stopped in
 * a fleet nothing else will ever see.
 */
import { cleanup, screen, waitFor, within } from "../dom.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { userEvent } from "../dom.ts";
import {
  FIXTURE,
  flowHarness,
  gotoHash,
  mountPortal,
  useTableLayout,
  type FlowHarness,
} from "./bridge.ts";

/** Every agent the `main` fixture fleet seeds, except the destroyed `oriole`. */
const SEEDED: ReadonlyArray<readonly [string, string]> = [
  ["atlas", "ready"],
  ["corvid", "ready"],
  ["ember", "degraded"],
  ["fathom", "ready"],
  ["granite", "ready"],
  ["heron", "error"],
  ["ibis", "ready"],
  ["juniper", "stopped"],
  ["kestrel", "ready"],
  ["lumen", "unreachable"],
  ["marrow", "stopped"],
];

const COLUMNS = [
  "Listening",
  "Agent",
  "Status",
  "Health",
  "Version",
  "Config",
  "Size",
  "CPU",
  "Mem",
  "Tailscale",
  "Uptime",
  "Data volume",
];

let harness: FlowHarness | null = null;

/**
 * The route and the layout, cleared *before* each test as well as after.
 *
 * The `afterEach` below protects the next file; it does nothing for this one's
 * first test, which runs on whatever `window.location.hash` the previous file
 * left. `nav-state.tsx` reads the hash when it mounts, so an inherited
 * `#chat/...` boots the portal into Bot Chat and every fleet query here misses
 * a page that was never drawn. Which file runs before this one is readdir
 * order, so that was green on macOS and red on Linux.
 */
beforeEach(() => {
  window.localStorage.removeItem("hermetic.layout");
  gotoHash("");
});

afterEach(async () => {
  cleanup();
  await harness?.restore();
  harness = null;
  // The layout is a per-browser preference and this process is one browser for
  // every UI test file; leaving `table` behind would re-render the next file's
  // dashboard in a layout it never asked for.
  window.localStorage.removeItem("hermetic.layout");
  gotoHash("");
});

describe("the fleet, over a real head", () => {
  test("the fleet table renders every seeded agent", async () => {
    useTableLayout();
    harness = await flowHarness();
    mountPortal();
    const user = userEvent.setup();

    const table = await screen.findByRole("table", { name: "Fleet" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(COLUMNS);

    for (const [name, status] of SEEDED) {
      expect(
        within(table).getByRole("row", { name: `${name} · ${status}` }),
        `${name} · ${status}`,
      ).toBeDefined();
    }

    // `oriole` is destroyed, and the dashboard hides it until the toolbar asks.
    expect(within(table).queryAllByRole("row", { name: /^oriole/ }).length).toBe(0);
    await user.click(screen.getByRole("button", { name: /destroyed$/ }));
    await waitFor(() => {
      expect(screen.getByRole("row", { name: "oriole · destroyed" })).toBeDefined();
    });
  });

  test("the account header is present on every page", async () => {
    for (const hash of ["", "#fleet/volumes", "#settings", "#settings/providers", "#settings/runs"]) {
      gotoHash(hash);
      harness = await flowHarness();
      mountPortal();

      // The switcher is the fleet name on the env strip, and the strip beside
      // it carries the frozen target itself: account and region are what stop
      // an operator acting on the wrong one.
      const switcher = await screen.findByRole("button", { name: /switch fleet/i });
      expect(switcher.textContent ?? "", `fleet button on /${hash}`).toContain(FIXTURE.main.alias);
      const text = switcher.closest(".envstrip")?.textContent ?? "";
      expect(text, `env strip on /${hash}`).toContain(FIXTURE.account_id);
      expect(text, `env strip on /${hash}`).toContain(FIXTURE.region);
      // The views are in the header on every page, Settings included.
      const header = document.querySelector("header.header") as HTMLElement;
      expect(within(header).getByRole("navigation", { name: "Views" })).toBeDefined();

      cleanup();
      await harness.restore();
      harness = null;
    }
  });

  /**
   * Volumes is the fleet's second lens, not a view: the old `#volumes` address
   * lands on it (respelled in place), Escape leaves it alone, `+ New agent` is
   * there too, and the headline's other half goes back to the agents.
   */
  test("the volumes lens lives on the fleet page", async () => {
    gotoHash("#volumes");
    harness = await flowHarness();
    mountPortal();
    const user = userEvent.setup();

    await screen.findByRole("textbox", { name: "Filter volumes" });
    expect(window.location.hash).toBe("#fleet/volumes");
    const nav = screen.getByRole("navigation", { name: "Views" });
    expect(within(nav).queryByRole("button", { name: /^Volumes/ })).toBeNull();
    expect(
      within(nav)
        .getByRole("button", { name: /^Fleet/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    // §9's inventory, drawn in lanes under the fleet's own toolbar.
    await screen.findByText("No agent");

    await user.keyboard("{Escape}");
    expect(window.location.hash).toBe("#fleet/volumes");
    expect(screen.getByRole("textbox", { name: "Filter volumes" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /New agent/ }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();

    await user.click(screen.getByRole("button", { name: /^\d+ agents$/ }));
    await screen.findByRole("textbox", { name: "Filter agents" });
    expect(window.location.hash).toBe("");
  });

  test("the fleet stream carries a status change into the fleet without a re-read", async () => {
    harness = await flowHarness();
    mountPortal();
    const user = userEvent.setup();

    const name = FIXTURE.sseAgent;
    const row = await screen.findByLabelText(`${name} · ready`);

    await user.click(row);
    const d = await waitFor(() => {
      const el = screen.getByRole("dialog");
      // The original reached this drawer through `openAgent`, which asserted
      // the modal promise on every open. Kept here rather than assumed.
      expect(el.getAttribute("aria-modal")).toBe("true");
      expect(el.querySelector(".detail-name")?.textContent).toBe(name);
      return el;
    });

    // Stop is a Lifecycle card.
    await user.click(within(d).getByRole("tab", { name: "Lifecycle" }));
    await user.click(within(d).getByRole("button", { name: "Stop" }));
    await waitFor(() => {
      expect(harness?.calls.map((c) => c.name)).toContain("agents.stop");
    });
    const afterStop = harness.calls.length;

    /**
     * The scan the portal's interval would have run three seconds later. It is
     * the *only* thing between the stop and the assertions below: the page is
     * never re-rendered from a fresh read, and the frames this produces are the
     * ones the agent's row has to move on.
     */
    await harness.poll();

    await waitFor(() => {
      expect(screen.getByLabelText(`${name} · stopped`)).toBeDefined();
    });
    expect(screen.queryAllByLabelText(`${name} · ready`).length).toBe(0);

    // The drawer is rendering the same row, and moved with it.
    expect(d.querySelector(".drawer-head")?.textContent ?? "").toContain("stopped");

    /**
     * And it moved on the stream rather than on a re-read. Playwright made this
     * claim by never calling `goto` or `reload`; here the claim can be checked
     * outright, because every request the UI made is recorded — so a component
     * that "fixed" this by quietly re-listing the fleet after a mutation would
     * fail here instead of passing on the wrong evidence.
     */
    const since = harness.calls.slice(afterStop).map((c) => c.name);
    expect(since).not.toContain("agents.list");
    expect(since).not.toContain("fleet.subscribe");
  });
});
