/**
 * §4.7's target guard and §4.8's switcher, ported off Playwright.
 *
 * **What the original asserted** (`tests/e2e/two-tab.e2e.ts`): two browser
 * contexts against one portal. Tab A opened `granite` on `main`; tab B drove
 * the fleet switcher popover to `staging` — Switch, "Confirm target change",
 * "Every create, upgrade and teardown will run against this fleet.", Switch
 * target — and the portal moved. Tab A, which had not re-read `/api/meta` and
 * so was still rendering `main`, pressed Stop and was refused with the §4.7
 * envelope mismatch naming both fleets, before a single AWS call and without a
 * single op being registered. Then tab A reloaded, adopted `staging`, found
 * `granite` gone under any status, and stopped `ember` successfully with no
 * refusal left on screen.
 *
 * **What this port asserts**: the switch and the guard, in full. The two-tab
 * *framing* is gone on purpose — under Electrobun there is one window, so
 * "another tab moved the head under me" is no longer a state the product can
 * reach. What the two tabs were a *device for* is still real: the page's
 * `target` is a module-level value adopted from the last `meta.get` it read,
 * every fleet-scoped mutation carries it, and the head refuses one naming a
 * fleet it is not serving. So the switch is driven through the same popover in
 * the one page, and then the page's `target` is put back to `main`'s triple by
 * hand; the refusal that comes back is word for word the original's.
 *
 * Two of its assertions are made against the head directly, which is stronger
 * than the original could be over HTTP:
 *
 *   - that the switch *landed* is a real `dispatch(ctx, "meta.get", {})` taken
 *     after the `Switch target` click, so what it proves is the consequence of
 *     the UI action rather than of how the harness was opened;
 *   - that nothing was spent is a real `dispatch(ctx, "ops.list", { target })`
 *     — the same registry read the original made as `GET /api/ops?target=…`,
 *     and `target` is still the filter's name (`packages/app/src/handlers/ops.ts`).
 *
 * The switch is only reachable here because `bridge.ts` gives its `ServerState`
 * a real `reopen` — an `openHermetic({ fixture: true, home, fleet })` against
 * the same fixture home, which seeds both fleets — rather than the
 * `fixedInstance` that refuses every `reopen(fleet)` with `UNSUPPORTED`. The
 * alternative was an interceptor faking `fleets.switch`, which was not taken
 * and should not be: a canned answer would leave the head on the fleet it
 * started on, and the assertion that it moved would be an assertion about the
 * stub.
 *
 * **What a happy-dom test cannot assert**: two genuinely independent pages.
 * There is one module graph here, so there is one `target`; the stale one is
 * set by `setFleetTarget` rather than owned by a second `BrowserContext`. That
 * is the honest shape of it now — the guard is on the request envelope, and a
 * request built from a stale target is a request built from a stale target
 * however the page came by one. Nor is visibility available in the layout
 * sense: no stylesheet, no boxes (`bootstrap.flow.test.tsx` has that argument
 * in full).
 *
 * Unlike the original — which ran last in a serial suite and needed an
 * `afterAll` to put the shared portal back on `main` — this harness owns its
 * own home and its own fixture, so where it leaves the fleet is nobody's
 * business but its own.
 */
import { act, cleanup, screen, waitFor, within } from "../dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { userEvent } from "../dom.ts";
import { dispatch } from "../../../app/src/handlers/dispatch.ts";
import { setFleetTarget } from "../../src/api/index.ts";
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

/** The env strip's fleet button, which is also the fleet switcher (`accountHeader`). */
function accountHeader(): HTMLElement {
  return screen.getByRole("button", { name: /switch fleet/i });
}

/** Open an agent's drawer and wait for it to be the modal on screen (`openAgent`). */
async function openAgent(user: ReturnType<typeof userEvent.setup>, name: string): Promise<HTMLElement> {
  await user.click(await screen.findByLabelText(new RegExp(`^${name} · `)));
  return await waitFor(() => {
    const d = screen.getByRole("dialog");
    expect(d.getAttribute("aria-modal")).toBe("true");
    expect(d.querySelector(".detail-name")?.textContent).toBe(name);
    return d;
  });
}

/** What the meta handler says this head is serving right now. */
async function servedFleet(h: FlowHarness): Promise<{ id: string | null; alias: string | null }> {
  // The one narrow cast in this file: `metaGet` answers a wide body that is the
  // head's own shape, and only these two fields are being asserted on.
  const meta = (await dispatch(h.ctx, "meta.get", {})) as {
    fleet: { id: string | null; alias: string | null };
  };
  return meta.fleet;
}

test("a fleet switch strands a stale target, which the head refuses and the page recovers from", async () => {
  harness = await flowHarness();
  mountPortal();
  const user = userEvent.setup();

  await waitFor(() => {
    expect(accountHeader().textContent ?? "").toContain(FIXTURE.main.alias);
  });
  expect((await servedFleet(harness)).id).toBe(FIXTURE.main.fleet_id);

  /**
   * `granite` belongs to `main`, and on `main` it has a Stop to press. The
   * original opened it in the tab that was about to go stale; the point it was
   * making — that this agent and this action exist on the fleet the page is
   * looking at now — is the same one, and the drawer is closed again because a
   * single page, unlike a second tab, re-renders out from under it.
   */
  const before = await openAgent(user, FIXTURE.readyAgent);
  // Every action is on the drawer's Lifecycle section.
  await user.click(within(before).getByRole("tab", { name: "Lifecycle" }));
  expect(within(before).getByRole("button", { name: "Stop" })).toBeDefined();
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryAllByRole("dialog").length).toBe(0);
  });

  /* ── the switcher moves the whole head to staging ────────────────────────── */

  await user.click(accountHeader());
  const popover = await screen.findByRole("dialog", { name: "Fleet switcher" });
  const stagingRow = within(popover)
    .getAllByRole("listitem")
    .find((li) => (li.textContent ?? "").includes(FIXTURE.staging.alias));
  expect(stagingRow, "the switcher listed no staging fleet").toBeDefined();

  await user.click(within(stagingRow as HTMLElement).getByRole("button", { name: "Switch" }));
  await waitFor(() => {
    expect(popover.textContent ?? "").toContain("Confirm target change");
  });
  // The sentence that makes the switch a decision rather than a click. It is
  // §4.8's whole reason for a two-step confirm.
  expect(popover.textContent ?? "").toContain(
    "Every create, upgrade and teardown will run against this fleet.",
  );
  await user.click(within(popover).getByRole("button", { name: "Switch target" }));

  /**
   * Asserted at the head rather than at the header, and after the click rather
   * than at the harness: what is being proved is that pressing that button
   * repointed the process, which is a property of the process. The screen
   * agreeing is a second, weaker fact, and it is checked below on the recovery.
   */
  await waitFor(async () => {
    const served = await servedFleet(harness as FlowHarness);
    expect(served.id).toBe(FIXTURE.staging.fleet_id);
    // The alias too, which is what the original read back through
    // `currentFleetAlias`. It is a different lookup from the id (`meta.ts`
    // resolves it against the state's own `fleetId`), so a switch that moved
    // the id and left the label behind would pass on the line above alone.
    expect(served.alias).toBe(FIXTURE.staging.alias);
  });

  /**
   * And the switching page itself, with no reload: the original asserted this
   * of tab B right after the confirm, and it is the only fleet-switch fact that
   * is about the page rather than about the process.
   */
  await waitFor(() => {
    expect(accountHeader().textContent ?? "").toContain(FIXTURE.staging.alias);
  });

  /* ── the page is put into the state the stale tab used to be in ──────────── */

  const drawer = await openAgent(user, FIXTURE.stagingReadyAgent);
  await user.click(within(drawer).getByRole("tab", { name: "Lifecycle" }));
  const stop = within(drawer).getByRole("button", { name: "Stop" });

  /**
   * This line is the port standing in for the original's second browser
   * context. There, the stale tab's `target` still named `main` because it had
   * not re-read `/api/meta` since the switch; here there is one module graph
   * and one `target`, which the provider re-adopted the moment the switch
   * answered, so the stale value is written back deliberately. What follows is
   * then the same request the stale tab sent: an `agents.stop` whose envelope
   * names `main`, arriving at a head that is serving `staging`.
   */
  setFleetTarget({
    account_id: FIXTURE.account_id,
    region: FIXTURE.region,
    fleet_id: FIXTURE.main.fleet_id,
  });

  await user.click(stop);

  const refusal = await waitFor(() => {
    const el = drawer.querySelector<HTMLElement>(".opbar .ph");
    expect(el?.textContent ?? "").toContain("this request names");
    return el as HTMLElement;
  });
  const said = refusal.textContent ?? "";
  expect(said).toContain(
    `this request names ${FIXTURE.main.fleet_id} in ${FIXTURE.account_id}/${FIXTURE.region}`,
  );
  expect(said).toContain(
    `but this portal is serving ${FIXTURE.staging.fleet_id} in ${FIXTURE.account_id}/${FIXTURE.region}`,
  );
  expect(said).toContain("reload the page and try again");

  /**
   * And the refusal came *before* anything was spent: the op registry has no
   * record of a stop against that agent at all, which is the difference between
   * a guard and an apology.
   */
  const ops = (await dispatch(harness.ctx, "ops.list", {
    target: FIXTURE.stagingReadyAgent,
  })) as { ops: unknown[] };
  expect(ops.ops.length).toBe(0);

  /* ── and the page recovers by adopting the fleet the head is serving ─────── */

  // The original's `tabA.reload()`: the page is built again, `FleetProvider`
  // re-reads `meta.get`, and adopting it is what puts `target` back.
  cleanup();
  mountPortal();

  await waitFor(() => {
    expect(accountHeader().textContent ?? "").toContain(FIXTURE.staging.alias);
  });

  // `granite` belongs to `main` and is simply not here any more, under any status.
  expect(screen.queryAllByLabelText(new RegExp(`^${FIXTURE.readyAgent} · `)).length).toBe(0);

  // The same action, against an agent this page is now genuinely showing, and
  // an envelope that names the fleet the head is serving.
  const recovered = await openAgent(user, FIXTURE.stagingReadyAgent);
  await user.click(within(recovered).getByRole("tab", { name: "Lifecycle" }));
  await user.click(within(recovered).getByRole("button", { name: "Stop" }));
  await waitFor(() => {
    expect(harness?.calls.map((c) => c.name)).toContain("agents.stop");
  });

  /**
   * The scan the portal's interval would have run; the row moves on the frames
   * it produces, as in `fleet.flow.test.tsx`. Driven through `ctx.poller()`
   * rather than `harness.poll()` because a switch replaces the state's poller
   * with one bound to the fleet it moved to (`ServerState.#install`), and the
   * harness's own handle is the one it built around the fleet it opened — after
   * this test's switch, that handle would scan `main` and deliver frames about
   * agents this page is no longer showing.
   *
   * Scanned inside the `waitFor`, not once before it: `agents.stop` is recorded
   * when it is asked, and the op it starts can still be running when a single
   * scan lands. That scan reads the agent as still ready, nothing scans again,
   * and the row never moves (seen on a loaded CI runner). A repeated scan is
   * what the portal's interval does anyway.
   */
  await waitFor(async () => {
    await act(async () => {
      await harness?.ctx.poller()?.poll();
    });
    expect(screen.getByLabelText(`${FIXTURE.stagingReadyAgent} · stopped`)).toBeDefined();
  });
  expect(recovered.querySelectorAll(".opbar .ph").length).toBe(0);

  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(screen.queryAllByRole("dialog").length).toBe(0);
  });
});
