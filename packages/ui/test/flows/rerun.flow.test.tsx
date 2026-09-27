/**
 * §11.6's "Rerun failed stages", ported off Playwright.
 *
 * **What the original asserted** (`tests/e2e/rerun.e2e.ts`): opened the fixture
 * agent seeded in `error`, checked the rerun button was offered with the
 * wording that explains what it does, clicked it, watched it become a pending
 * state rather than a second click, and then watched the whole of the fixture
 * runner's two-step recovery — `error → bootstrapping → ready`,
 * `2/7 ok · 1 failed` → `7/7 ok` — arrive in a page that was never navigated or
 * reloaded. Finally it re-opened the checklist a finished boot had folded away,
 * read all seven stages `ok` with no message left on the one that failed, and
 * checked the button had gone dead for the right reason.
 *
 * **What this port asserts**: all of it, and one thing the original could only
 * imply. The carrier changes — `fleet.subscribe` pushing frames through the
 * bridge instead of SSE over a socket — but it is the same poller, the same
 * handler and the same `MemoryBackend.simulateRerun`, so the recovery being
 * watched is the real one. The new claim is *how* the page learned: every
 * request the UI makes is recorded (`harness.calls`), so "it came off the
 * stream" can be checked outright rather than inferred from the absence of a
 * `reload()`. A drawer that quietly re-read the agent after its rerun would
 * fail here and would have passed in Playwright.
 *
 * The fixture runner is driven by two real 1s timers inside the backend
 * (`rerunDelayMs`), which no test may reach in from here. So the scans are
 * driven in a bounded loop (`pollUntil`) rather than on a wall-clock sleep: the
 * loop stops the moment the assertion holds, and fails with that assertion's
 * own error if it never does.
 *
 * **What a happy-dom test cannot assert**: visibility in the layout sense. No
 * stylesheet is loaded and no box is measured, so Playwright's `toBeVisible`
 * becomes "is in the document" — which is what it meant here anyway, since the
 * queued button and the stage rows are conditionally *rendered*, never hidden
 * by CSS.
 *
 * The original had to sort last in the whole suite: one shared portal meant
 * this rerun walked `heron` out of `error` for every spec after it, so
 * `bootstrap.e2e.ts` and `fleet.e2e.ts` had to run first and a new spec needing
 * the seeded failure had to be filed before this one. That constraint is gone.
 * Each `flowHarness()` opens its own `HERMETIC_HOME` and its own fixture fleet
 * (`bridge.ts`), so the `heron` recovered below exists only inside this test
 * and the flows may run in any order, in any file, twice.
 */
import { cleanup, screen, waitFor, within } from "../dom.ts";
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
  window.localStorage.removeItem("hermetic.layout");
  gotoHash("");
});

/**
 * Drive fleet scans until `check` holds, or give up with `check`'s own failure.
 *
 * The portal's poller would run these on its three-second interval; here every
 * scan is one the test asked for, so a passing assertion is an assertion about
 * a scan that is known to have happened. The loop exists because the state the
 * page is waiting for is produced by timers *inside the fixture backend* — the
 * imaginary hermeticd acks the command a second after the write and finishes a
 * second after that — and nothing outside `MemoryBackend` can make those fire
 * sooner. Bounded, so a flow that breaks fails in seconds with the real reason
 * rather than hanging until the runner's timeout.
 */
async function pollUntil(h: FlowHarness, check: () => void, tries = 120): Promise<void> {
  let last: unknown = null;
  for (let i = 0; i < tries; i++) {
    await h.poll();
    try {
      await waitFor(check, { timeout: 50 });
      return;
    } catch (e) {
      last = e;
    }
  }
  throw last ?? new Error("pollUntil: never checked");
}

/** `.querySelectorAll` as an array, so the counts below read as counts. */
function all(root: ParentNode, selector: string): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(selector)];
}

test("Rerun failed stages resumes the bootstrap and the agent comes back ready", async () => {
  harness = await flowHarness();
  mountPortal();
  const user = userEvent.setup();

  const row = await screen.findByLabelText(`${FIXTURE.errorAgent} · error`);
  await user.click(row);

  const d = await waitFor(() => {
    const el = screen.getByRole("dialog");
    expect(el.getAttribute("aria-modal")).toBe("true");
    expect(el.querySelector(".detail-name")?.textContent).toBe(FIXTURE.errorAgent);
    return el;
  });

  // Every action is on Lifecycle; the rerun is one of its cards.
  await user.click(within(d).getByRole("tab", { name: "Lifecycle" }));
  const rerun = within(d).getByRole("button", { name: "Rerun failed stages" });
  expect(rerun.hasAttribute("disabled")).toBe(false);
  expect(rerun.getAttribute("title")).toBe(
    "re-runs the stages that are not ok, resuming from the first failure",
  );

  await user.click(rerun);

  /**
   * `rerun` is not an op — the handler writes a command on the agent's row
   * and returns it, so there is no stream to follow. Until the box acks that
   * command the button is a pending state rather than a second click.
   */
  const queued = await waitFor(() => within(d).getByRole("button", { name: "Rerun queued…" }));
  expect(queued.getAttribute("title")).toBe(
    "waiting for hermeticd to pick the rerun up off the agent's row",
  );

  /**
   * Everything from here has to arrive on the fleet stream. Nothing below
   * remounts the portal or re-opens the drawer, and the two facts that prove
   * it are checked after the fact: the dialog node is the same object, and
   * no fresh read of the agent was issued in the meantime.
   */
  const callsBefore = harness.calls.length;

  // The checklist is the Overview's; moving there is local and reads nothing.
  await user.click(within(d).getByRole("tab", { name: "Overview" }));

  await pollUntil(harness, () => {
    expect(d.querySelector(".bootstrap-sum")?.textContent).toBe("7/7 ok · hermeticd 0.4.0");
  });

  // And the row itself has left `error`, which is the point of the button.
  expect(d.querySelector(".drawer-head")?.textContent ?? "").toContain("ready");
  expect(screen.getByLabelText(`${FIXTURE.errorAgent} · ready`)).toBeDefined();

  // The same drawer, still mounted: no remount carried any of the above.
  expect(screen.getByRole("dialog")).toBe(d);
  expect(d.isConnected).toBe(true);

  /**
   * And no re-read carried it either. The dashboard's rows and the drawer's
   * agent both come off the poller's snapshot, so a component that refreshed
   * itself with `agents.list` or `agents.get` after the rerun would be
   * passing the visible assertions on the wrong evidence. Playwright could
   * only decline to call `reload()`; here the whole request log is available.
   */
  const since = harness.calls.slice(callsBefore).map((c) => c.name);
  expect(since).not.toContain("agents.list");
  // `agents.history` rather than `agents.get`: `get` is not in the UI's own
  // `RequestName` union, so asserting its absence asserts nothing. `history` is
  // a name this drawer really can ask for, which makes the negative real.
  expect(since).not.toContain("agents.history");

  /**
   * A finished checklist folds itself away — a ready agent with seven ok
   * stages has nothing to say. So the stages are re-opened to be read, which
   * is also the assertion that the head is still a working disclosure
   * control.
   */
  const head = d.querySelector<HTMLElement>(".bootstrap-head");
  expect(head).not.toBeNull();
  expect(head?.getAttribute("aria-expanded")).toBe("false");
  await user.click(head as HTMLElement);
  await waitFor(() => {
    expect(head?.getAttribute("aria-expanded")).toBe("true");
  });

  const rows = all(d, ".stage-row");
  expect(rows.length).toBe(7);
  expect(rows.map((r) => r.querySelector(".stage-status")?.textContent)).toEqual(
    Array.from({ length: 7 }, () => "ok"),
  );

  // The stage that failed carries no failure message any more.
  const resumed = d.querySelector<HTMLElement>('.stage-row[title="02-data-volume"]');
  expect(resumed).not.toBeNull();
  expect(resumed?.querySelector(".stage-status")?.textContent).toBe("ok");
  expect(resumed?.querySelectorAll(".stage-msg").length).toBe(0);

  // And there is nothing left to rerun.
  await user.click(within(d).getByRole("tab", { name: "Lifecycle" }));
  const spent = within(d).getByRole("button", { name: "Rerun failed stages" });
  expect(spent.hasAttribute("disabled")).toBe(true);
  expect(spent.getAttribute("title")).toBe("rerun needs an agent in error; this one is ready");
}, 30_000);
