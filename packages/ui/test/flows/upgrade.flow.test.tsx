/**
 * Upgrading Hermes from the agent drawer, both ways (§6.5).
 *
 * The Lifecycle card offers two buttons for one version bump. "Upgrade now" is
 * `upgrade --hermes V --now`: the pin, then the `apply_request` a rollout
 * writes, then a wait for the box to report the new config — which the fixture
 * backend's fake hermeticd answers about a second later (`simulateConverge`,
 * `memory-simulation.ts`, switched on by fixture mode's open path). "Pin for
 * next recreate" is the pin alone, and the box keeps running what it ran.
 *
 * So the claims are about the row the real core leaves behind, read back
 * through the real `agents.get` rather than off the page: after Upgrade now the
 * box *runs* the new version and has applied the config the pin rendered;
 * after a pin it does neither. And about the request itself — the press is one
 * `upgrade` carrying the `now` the operator chose, since that boolean is the
 * whole difference between the two.
 *
 * `fathom` is the subject: seeded `ready`, heartbeating and on 0.14.2, behind
 * the fleet's newest release, so the card is live and its box can answer.
 */
import { createElement, StrictMode } from "react";
import { act, cleanup, render, screen, userEvent, waitFor, within } from "../dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Portal } from "../../src/Portal.tsx";
import { FleetProvider } from "../../src/state/state.tsx";
import { flowHarness, gotoHash, mountPortal, type FlowHarness } from "./bridge.ts";

/** Seeded `ready` on 0.14.2 with a fresh heartbeat (`fixture-agents.ts`). */
const BEHIND = "fathom";

let harness: FlowHarness | null = null;

/** See `rerun.flow.test.tsx`: the hash is read at mount, so it is cleared before as well as after. */
beforeEach(() => {
  window.localStorage.removeItem("hermetic.layout");
  gotoHash("#fleet");
});

afterEach(async () => {
  cleanup();
  await harness?.restore();
  harness = null;
  window.localStorage.removeItem("hermetic.layout");
  gotoHash("");
});

/** Open `name`'s drawer on its Lifecycle section and return the Upgrade Hermes card. */
async function upgradeCard(): Promise<{ drawer: HTMLElement; card: HTMLElement }> {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: `Open ${BEHIND} details` }));
  const drawer = await waitFor(() => {
    const el = screen.getByRole("dialog");
    expect(el.querySelector(".detail-name")?.textContent).toBe(BEHIND);
    return el;
  });
  await user.click(within(drawer).getByRole("tab", { name: "Lifecycle" }));
  const card = within(drawer).getByRole("region", { name: "Upgrade Hermes" });
  return { drawer, card };
}

/** The version the card offers, off its own "current → latest" line. */
function offered(card: HTMLElement): string {
  const match = /0\.14\.2 → (\d+(?:\.\d+)*)/.exec(card.textContent ?? "");
  if (!match?.[1]) throw new Error(`the card offers no version: ${card.textContent}`);
  return match[1];
}

/** The `now` each `upgrade` request carried, in order. */
function upgradeRequests(h: FlowHarness): Array<Record<string, unknown>> {
  return h.calls.filter((c) => c.name === "upgrade").map((c) => c.params as Record<string, unknown>);
}

test("Upgrade now pins the version and converges the running box onto it", async () => {
  const h = await flowHarness();
  harness = h;
  mountPortal();
  const user = userEvent.setup();

  const before = await h.ctx.hermetic().agents.get(BEHIND);
  expect(before.running_hermes_version).toBe("0.14.2");

  const { drawer, card } = await upgradeCard();
  const latest = offered(card);
  // The cost is said beside the button, before anything is pressed.
  expect(card.textContent ?? "").toContain("a turn in flight is interrupted");
  const now = within(card).getByRole("button", { name: "Upgrade now" });
  expect(now.hasAttribute("disabled")).toBe(false);
  await user.click(now);

  // One request, naming the version and asking for the in-place converge.
  expect(upgradeRequests(h)).toEqual([
    expect.objectContaining({ name: BEHIND, hermes: latest, now: true }),
  ]);

  // The rail ends on the run's tally, which counts the box as converged.
  await waitFor(
    () => {
      const note = within(drawer).getByRole("note");
      expect(note.textContent ?? "").toContain(`to hermes ${latest}: 1 converged`);
    },
    { timeout: 15_000 },
  );

  // The row core left behind: pinned, rendered, applied, and the box reports it.
  const after = await h.ctx.hermetic().agents.get(BEHIND);
  expect(after.hermes_version).toBe(latest);
  expect(after.running_hermes_version).toBe(latest);
  expect(after.applied_config_hash).toBe(after.config_hash);
  expect(after.config_hash).not.toBe(before.config_hash);

  // Once the fleet is re-read the card has nothing left to offer.
  await h.poll();
  await waitFor(() => {
    const fresh = within(drawer).getByRole("region", { name: "Upgrade Hermes" });
    expect(fresh.textContent ?? "").toContain("already on the newest release");
  });
}, 30_000);

test("Pin for next recreate records the version and leaves the box alone", async () => {
  const h = await flowHarness();
  harness = h;
  mountPortal();
  const user = userEvent.setup();

  const before = await h.ctx.hermetic().agents.get(BEHIND);
  const { drawer, card } = await upgradeCard();
  const latest = offered(card);
  await user.click(within(card).getByRole("button", { name: "Pin for next recreate" }));

  expect(upgradeRequests(h)).toEqual([
    expect.objectContaining({ name: BEHIND, hermes: latest, now: false }),
  ]);

  // The rail's last word is where the version takes effect — and how to take it now.
  await waitFor(
    () => {
      const note = within(drawer).getByRole("note");
      expect(note.textContent ?? "").toContain("takes it on its next recreate");
      expect(note.textContent ?? "").toContain("--now");
    },
    { timeout: 15_000 },
  );

  // Pinned and rendered, but nothing asked the box to apply it.
  const after = await h.ctx.hermetic().agents.get(BEHIND);
  expect(after.hermes_version).toBe(latest);
  expect(after.running_hermes_version).toBe(before.running_hermes_version);
  expect(after.apply_request ?? null).toEqual(before.apply_request ?? null);
}, 30_000);

test("a stopped agent can be pinned but not upgraded now, and the card says why", async () => {
  const h = await flowHarness();
  harness = h;
  mountPortal();
  const user = userEvent.setup();

  // `juniper` is seeded stopped on 0.13.8: behind, with no box to answer.
  await user.click(await screen.findByRole("button", { name: "Open juniper details" }));
  const drawer = await waitFor(() => screen.getByRole("dialog"));
  await user.click(within(drawer).getByRole("tab", { name: "Lifecycle" }));
  const card = within(drawer).getByRole("region", { name: "Upgrade Hermes" });

  expect(card.textContent ?? "").toContain("Upgrade now needs a running box; this one is stopped");
  expect(within(card).getByRole("button", { name: "Upgrade now" }).hasAttribute("disabled")).toBe(true);
  expect(
    within(card).getByRole("button", { name: "Pin for next recreate" }).hasAttribute("disabled"),
  ).toBe(false);
  expect(upgradeRequests(h)).toEqual([]);
}, 30_000);

/**
 * Closing and reopening the drawer while Upgrade now is still waiting on the
 * box (real mode, 2026-10-12): the reopened rail ended on `STREAM_ENDED` and
 * "What to try next" while core went on to converge the box.
 *
 * The reopened drawer mounts under StrictMode, as the dev app does
 * (`entry-app.tsx`), so it subscribes, unsubscribes and subscribes again. The
 * binding answered the unsubscribe with a synthetic `STREAM_ENDED` terminal,
 * and because `op.event` was then routed by `op_id` alone, the surviving
 * subscription took it as the op's end. Fixed three ways, all held here: no
 * terminal for a reader that hung up (`rpc/bind.ts`), frames routed by the
 * subscription that produced them (`transport-rpc.ts`), and a fresh reader
 * replayed the op whole rather than resumed from the window's cursor
 * (`useOp.ts`) — plus `useAgentOp` asking the registry again after
 * StrictMode's rehearsal unmount. The op is held open so the reopen lands while
 * it is running, which the real one did for the ninety seconds Hermes took to
 * restart. The ordering race — another reader's live frame arriving before the
 * reopened drawer's replay — is `transport-rpc.test.ts`'s "a reader gets its
 * own subscription's frames".
 */
test("reopening the drawer on a running upgrade does not end it as STREAM_ENDED", async () => {
  const h = await flowHarness();
  harness = h;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let opId: string | null = null;
  h.intercept("upgrade", () => {
    const op = h.ctx.ops.start("upgrade", BEHIND, async function* () {
      const at = () => new Date().toISOString();
      yield { phase: `${BEHIND}:render`, progress: 0.25, message: "pinned; config uploaded", at: at() };
      yield { phase: `${BEHIND}:requested`, progress: 0.5, message: "asked to apply", at: at() };
      await gate;
      yield { phase: "done", progress: 1, message: "pinned 1 agent(s): 1 converged", at: at() };
    });
    opId = op.id;
    return { op_id: op.id, op };
  });
  render(createElement(StrictMode, null, createElement(FleetProvider, null, createElement(Portal))));
  const user = userEvent.setup();

  const { drawer, card } = await upgradeCard();
  await user.click(within(card).getByRole("button", { name: "Upgrade now" }));
  await waitFor(() => expect(drawer.textContent ?? "").toContain("asked to apply"));

  // Close it, and open it again while the box has still not reported.
  await user.click(within(drawer).getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await user.click(await screen.findByRole("button", { name: `Open ${BEHIND} details` }));
  const reopened = await waitFor(() => screen.getByRole("dialog"));
  await waitFor(() => expect(reopened.textContent ?? "").toContain("asked to apply"));
  // Room for the StrictMode unmount's unsubscribe to cross the bridge and back.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  expect(reopened.textContent ?? "").not.toContain("STREAM_ENDED");

  // The op is still running, and ends the way core ends it.
  expect(opId).not.toBeNull();
  expect(h.ctx.ops.get(opId ?? "")?.status).toBe("running");
  release();
  await waitFor(() => expect(h.ctx.ops.get(opId ?? "")?.status).toBe("ok"));
  await waitFor(() => expect(reopened.textContent ?? "").toContain("1 converged"));
  expect(reopened.textContent ?? "").not.toContain("STREAM_ENDED");
  expect(reopened.textContent ?? "").not.toContain("What to try next");
}, 30_000);
