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
import { cleanup, screen, userEvent, waitFor, within } from "../dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { flowHarness, gotoHash, mountPortal, type FlowHarness } from "./bridge.ts";

/** Seeded `ready` on 0.14.2 with a fresh heartbeat (`fixture-agents.ts`). */
const BEHIND = "fathom";

let harness: FlowHarness | null = null;

/** See `rerun.flow.test.tsx`: the hash is read at mount, so it is cleared before as well as after. */
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

/** Open `name`'s drawer on its Lifecycle section and return the Upgrade Hermes card. */
async function upgradeCard(): Promise<{ drawer: HTMLElement; card: HTMLElement }> {
  const user = userEvent.setup();
  await user.click(await screen.findByLabelText(new RegExp(`^${BEHIND} · `)));
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
  await user.click(await screen.findByLabelText(/^juniper · /));
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
