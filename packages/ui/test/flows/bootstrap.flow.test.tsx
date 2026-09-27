/**
 * §11.6's bootstrap checklist, ported off Playwright.
 *
 * **What the original asserted** (`tests/e2e/bootstrap.e2e.ts`): booted the
 * portal against the fixture backend, opened `heron` — the agent seeded in
 * `error` with `02-data-volume` failed at exit 100 — and checked the whole of
 * the stage board it rendered: the collapsed summary line, seven stage rows,
 * the failed row's status, humanised label and message, the two `ok` and four
 * `pending` rows around it, and the drawer's own verdict naming the stage.
 *
 * **What this port asserts**: all of it, against the same fixture data reaching
 * the same components — `agents.list` and `agents.history` answered by the real
 * handlers over the real `dispatch` (`bridge.ts`), rendered into happy-dom.
 * Nothing about the board is stubbed: the stage rows come from the fixture
 * agent's own `bootstrap` field, and the verdict from its event history.
 *
 * **What a happy-dom test cannot assert**: visibility. Playwright's
 * `toBeVisible` is a layout question — a box with a non-zero size that is not
 * `display: none` — and happy-dom computes no layout and loads no stylesheet,
 * so presence in the document is the strongest available claim. The specs'
 * `toBeVisible` calls become "is in the tree", which is what they were really
 * testing here: none of these elements is conditionally hidden by CSS, they are
 * conditionally *rendered*.
 *
 * The original also had to sort before `rerun.e2e.ts`, because one shared
 * portal meant a rerun walked `heron` out of `error` for every later spec. This
 * file has its own fleet and no such constraint (`bridge.ts`).
 */
import { cleanup, screen, waitFor } from "../dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { userEvent } from "../dom.ts";
import { FIXTURE, flowHarness, gotoHash, mountPortal, type FlowHarness } from "./bridge.ts";

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
  // This file sets neither, but it clears both: `bun test` is one process, and
  // a file that depends on its neighbours' hygiene is a file that fails when it
  // is run alone or first.
  gotoHash("");
  localStorage.removeItem("hermetic.layout");
});

/** The one drawer on screen. Every drawer in the app comes through `Drawer.tsx`. */
function drawer(): HTMLElement {
  return screen.getByRole("dialog");
}

/** `.querySelectorAll` as an array, so the counts below read as counts. */
function all(root: ParentNode, selector: string): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(selector)];
}

test("the stage checklist renders every stage of an agent seeded in error", async () => {
  harness = await flowHarness();
  mountPortal();
  const user = userEvent.setup();

  // Asserted from the fleet first: the row says `error` before the drawer does.
  const row = await screen.findByLabelText(`${FIXTURE.errorAgent} · error`);

  await user.click(row);

  const d = await waitFor(() => {
    const el = drawer();
    expect(el.getAttribute("aria-modal")).toBe("true");
    expect(el.querySelector(".detail-name")?.textContent).toBe(FIXTURE.errorAgent);
    return el;
  });

  // The collapsed summary. A failing agent opens expanded, so the rows below
  // are reachable without clicking the head.
  await waitFor(() => {
    expect(d.querySelector(".bootstrap-sum")?.textContent).toBe("2/7 ok · 1 failed · hermeticd 0.4.0");
  });

  const rows = all(d, ".stage-row");
  expect(rows.length).toBe(7);

  // `title` is the raw stage id; the bold label is the humanised form of it.
  const failedRow = d.querySelector<HTMLElement>('.stage-row[title="02-data-volume"]');
  expect(failedRow).not.toBeNull();
  expect(failedRow?.querySelector(".stage-status")?.textContent).toBe("failed");
  expect(failedRow?.querySelector("b")?.textContent).toBe("Data volume");
  expect(failedRow?.querySelector(".stage-msg")?.textContent).toBe(
    "exit 100 · device /dev/nvme1n1 has an unknown signature; refusing to mkfs",
  );

  // Two ok before the failure, four pending after it: a checklist that resumed
  // past a failed stage would be describing a box that cannot exist.
  const statuses = rows.map((r) => r.querySelector(".stage-status")?.textContent);
  expect(statuses.filter((s) => s === "ok").length).toBe(2);
  expect(statuses.filter((s) => s === "pending").length).toBe(4);

  // The drawer's own explanation of the row's status, read from the fixture
  // history — which is a second handler (`agents.history`) and arrives after
  // the board, so it is waited for rather than read.
  await waitFor(() => {
    expect(d.querySelector(".probe-verdict")?.textContent ?? "").toContain(
      "bootstrap stage 02-data-volume failed",
    );
  });

  // The whole of the above came off the real head: no canned answer exists in
  // this suite, and these are the two reads that produced it. The board itself
  // arrives on the fleet feed rather than from `agents.list` — the dashboard
  // reads its rows from the poller's snapshot, which is why `fleet.subscribe`
  // and not a list call is what a page showing agents has asked for.
  const asked = harness.calls.map((c) => c.name);
  expect(asked).toContain("fleet.subscribe");
  expect(asked).toContain("agents.history");
});
