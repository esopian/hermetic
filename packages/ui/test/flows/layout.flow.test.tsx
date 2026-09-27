/**
 * §11.6's dashboard-at-a-laptop's-width pair, ported off Playwright.
 *
 * **What the original asserted** (`tests/e2e/layout.e2e.ts`): with the viewport
 * pinned to 1440×900 and the table layout pinned in `localStorage`, that the
 * fleet table renders — visible, first columnheader `Listening`, second
 * `Agent`, and a row for each of `heron`, `granite` and `kestrel` matched by
 * name alone — and that the account header is on every one of the five hash
 * routes carrying the frozen account id. Two assertions, because "which account
 * am I about to spend money in" is a question every page has to answer.
 *
 * **What this port asserts**: both, against the real handlers, plus the layout
 * *state* the width was standing in for. The rows and the columns come off the
 * same `fleet.subscribe` snapshot the dashboard really renders from, and the
 * account header off the same `meta.get`.
 *
 * **What a happy-dom test cannot assert**: the viewport. happy-dom computes no
 * layout — no box has a size, no stylesheet is parsed, no media query is
 * evaluated — so `1440×900` is not a condition that can be established here and
 * `toBeVisible` is not a question that can be asked. Pixel geometry is
 * genuinely out of reach, and per AGENTS.md the desktop breakpoint is the only
 * one this app has anyway (mobile is out of scope), so the original's single
 * `VIEWPORTS` entry had no second case to be compared against. What the width
 * was a proxy for is portable and is asserted instead: that the choice between
 * board and table is a piece of app state, read from `hermetic.layout`
 * (`state/state.tsx`), and that choosing `table` is what puts a `role="table"`
 * named `Fleet` on screen with its columns in order. The toolbar's own
 * `aria-pressed` is checked alongside it, because that attribute is the one
 * rendered consequence of the stored preference an operator can see.
 *
 * `fleet.flow.test.tsx` already asserts the account header over a slightly
 * different route list (it ends `#settings/runs`; this one ends
 * `#settings/danger`, which is unique to the original here, and this one checks
 * the account id where that one also checks region and alias). Both are kept:
 * the routes are not the same set, and neither is a superset of the other. The
 * duplication is exactly the originals' and no more.
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

/** Every page the app routes to, as the hash router spells them. */
const PAGES = ["", "#fleet/volumes", "#settings", "#settings/providers", "#settings/danger"];

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

describe("the dashboard's layout, over a real head", () => {
  test("the fleet table renders", async () => {
    useTableLayout();
    harness = await flowHarness();
    mountPortal();

    const table = await screen.findByRole("table", { name: "Fleet" });
    const headers = within(table).getAllByRole("columnheader");
    expect(headers[0]?.textContent).toBe("Listening");
    expect(headers[1]?.textContent).toBe("Agent");

    // By name, not by status: the original ran against a shared fixture fleet
    // that earlier specs had mutated, and what it is about is the table
    // rendering. Kept by name here too — the assertion is the same one.
    for (const name of [FIXTURE.errorAgent, FIXTURE.readyAgent, FIXTURE.sseAgent]) {
      expect(
        within(table).getByRole("row", { name: new RegExp(`^${name} · `) }),
        `${name} row`,
      ).toBeDefined();
    }

    /**
     * The state behind the table, which is what the pinned viewport was really
     * selecting for. `useLayout` read `table` out of `localStorage` on mount,
     * App branched on it, and the toolbar's layout group says so — the one
     * attribute the stored preference turns into something on screen.
     */
    const group = screen.getByRole("group", { name: "Layout" });
    const pressed = within(group)
      .getAllByRole("button")
      .map((b) => [b.textContent, b.getAttribute("aria-pressed")]);
    expect(pressed).toEqual([
      ["board", "false"],
      ["table", "true"],
      ["triage", "false"],
    ]);

    // And the branch is a real branch: asking for the board takes the table
    // away rather than restyling it.
    const user = userEvent.setup();
    await user.click(within(group).getByRole("button", { name: "board" }));
    await waitFor(() => {
      expect(screen.queryAllByRole("table", { name: "Fleet" }).length).toBe(0);
    });
    expect(window.localStorage.getItem("hermetic.layout")).toBe("board");
  });

  test("the account header is present on every page", async () => {
    for (const hash of PAGES) {
      gotoHash(hash);
      harness = await flowHarness();
      mountPortal();

      const switcher = await screen.findByRole("button", { name: /switch fleet/i });
      const strip = switcher.closest(".envstrip");
      expect(strip?.textContent ?? "", `env strip on /${hash}`).toContain(FIXTURE.account_id);

      cleanup();
      await harness.restore();
      harness = null;
    }
  });
});
