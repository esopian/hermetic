/**
 * §11.6's keyboard and focus contract, ported off Playwright.
 *
 * **What the original asserted** (`tests/e2e/keyboard.e2e.ts`): that a drawer
 * is `aria-modal="true"` and keeps that promise — focus moves inside on open,
 * twenty-five Tabs and twenty-five Shift+Tabs never leave it, Escape closes it;
 * that the create drawer's controls come in reading order, name → dice → brain →
 * preset → Customize, whose fields run size → more sizes → data volume → system
 * disk; and the keyboard half of plan item
 * H20 — that the destroy confirm is reachable and typable without a mouse, and
 * that completing it by keyboard arms exactly nothing until the plan for those
 * options is on screen.
 *
 * **What this port asserts**: all three, as DOM and state facts.
 * `@testing-library/user-event` really does move `document.activeElement` on
 * `tab()`, and it honours a `preventDefault` on its own `keydown` — which is
 * precisely how `lib/focus.ts` wraps at the ends — so the trap under test is
 * the shipping one and not a re-implementation. The last test uses the bridge's
 * hold-open interceptor (`(_p, pass) => held.then(pass)`) to own the "before the
 * plan arrives" state the original owned with a held `page.route`; the plan read
 * itself is the real `plan.destroy` handler over the real fixture backend, and
 * releasing the hold is what arms the button.
 *
 * **What a happy-dom test cannot assert**: the browser's own tab order.
 * Playwright pressed Tab and let Chromium decide where focus went, over a real
 * layout with the app's six stylesheets applied. `user-event` instead computes
 * a tabbable list from the DOM itself, and happy-dom loads no stylesheet, so a
 * control that the shipping CSS hides — `display: none`, `visibility: hidden`,
 * a zero-size box, a `content-visibility` subtree — reads here as perfectly
 * reachable and would be tabbed to. (`focusableWithin` does consult
 * `getComputedStyle`, but with no stylesheet there is nothing for it to find.)
 * That cuts one specific way: this file can prove a control *is* in the tab
 * order and in what position, and cannot prove that a control the CSS has
 * hidden is *out* of it. Everything the originals assert is of the first kind.
 *
 * Nor is `toBeVisible` available in its layout sense, for the same reason
 * (`bootstrap.flow.test.tsx` says more); presence in the document is the
 * strongest claim here, and none of these elements is hidden by CSS.
 */
import { cleanup, screen, waitFor, within } from "../dom.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

/** The topmost drawer, or nothing. Every drawer comes through `Drawer.tsx`. */
function drawers(): HTMLElement[] {
  return screen.queryAllByRole("dialog");
}

/** True while focus is anywhere inside an open drawer — `focusInDrawer` verbatim. */
function focusInDrawer(): boolean {
  return document.activeElement?.closest(".drawer") != null;
}

/**
 * Which of the drawer's landmarks the focused element belongs to, if any. The
 * original ran this as a `page.evaluate`; here the document is already in
 * process, so it is the same three lines without the round trip.
 */
function focusMarker(markers: readonly string[]): string | null {
  const el = document.activeElement;
  if (el === null) return null;
  return markers.find((s) => el.closest(s) !== null) ?? null;
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

describe("the keyboard contract, over a real head", () => {
  test("a drawer traps focus and Escape closes it", async () => {
    harness = await flowHarness();
    mountPortal();
    const user = userEvent.setup();

    const d = await openAgent(user, FIXTURE.errorAgent);
    expect(d.getAttribute("aria-modal")).toBe("true");

    // Focus is moved into the drawer on open rather than left on <body>.
    expect(focusInDrawer()).toBe(true);

    // Walking forwards past the last control wraps to the first, rather than
    // stepping out into the fleet behind the backdrop.
    for (let i = 0; i < 25; i++) {
      await user.tab();
      expect(focusInDrawer(), `focus left the drawer after ${i + 1} Tab presses`).toBe(true);
    }

    // And backwards, which is the direction a trap is usually missing.
    for (let i = 0; i < 25; i++) {
      await user.tab({ shift: true });
      expect(focusInDrawer(), `focus left the drawer after ${i + 1} Shift+Tab presses`).toBe(true);
    }

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(drawers().length).toBe(0);
    });

    // The drawer above was rendering a real agent read from a real head: the
    // fleet it was opened from arrived on `fleet.subscribe`, and the drawer's
    // own history read is `agents.history`. A trap over an empty dialog would
    // have nothing to trap.
    expect(harness.calls.map((c) => c.name)).toContain("agents.history");
  });

  test("the create drawer tabs through its controls in reading order", async () => {
    harness = await flowHarness();
    mountPortal();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /New agent/ }));
    const d = await waitFor(() => {
      const el = screen.getByRole("dialog");
      expect(el.getAttribute("aria-modal")).toBe("true");
      return el;
    });

    const MARKERS = [
      ".name-input",
      ".dice-btn",
      ".cr-brain",
      '[aria-label="Machine preset"]',
      ".cr-disc-t",
      '[aria-label="Size"]',
      ".more-sizes",
      '[aria-label="Data volume"]',
      'input[type="range"]',
    ] as const;

    // The name field is where a create starts, so it is where focus lands.
    await waitFor(() => {
      expect(focusMarker(MARKERS)).toBe(".name-input");
    });

    const visited: string[] = [];
    for (let i = 0; i < 30; i++) {
      await user.tab();
      expect(focusInDrawer(), "the create drawer let focus escape").toBe(true);
      const marker = focusMarker(MARKERS);
      if (marker !== null && visited[visited.length - 1] !== marker) visited.push(marker);
      // Customize is a disclosure: opened from the keyboard, its fields follow
      // it in the tab order.
      if (
        marker === ".cr-disc-t" &&
        document.activeElement?.getAttribute("aria-expanded") === "false"
      ) {
        await user.keyboard("{Enter}");
      }
      if (marker === 'input[type="range"]') break;
    }

    /**
     * Asserted as an order rather than a transcript: how many size cells or
     * volume steps a build offers is a product decision that may change, but the
     * sequence name → brain → preset → Customize (size → data volume → system
     * disk) is the shape of the form, and a control that jumped out of it would
     * be a real regression.
     */
    expect(visited).toEqual([
      ".dice-btn",
      ".cr-brain",
      '[aria-label="Machine preset"]',
      ".cr-disc-t",
      '[aria-label="Size"]',
      ".more-sizes",
      '[aria-label="Data volume"]',
      'input[type="range"]',
    ]);

    // The drawer really is the create drawer and not an empty shell: it is
    // offering the fixture fleet's sizes, which came off the real head.
    expect(within(d).getByRole("group", { name: "Size" })).toBeDefined();

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(drawers().length).toBe(0);
    });
  });

  test("the destroy confirm is reachable by keyboard and arms nothing without a plan", async () => {
    harness = await flowHarness();

    /**
     * The plan read is held open until this test lets it go, so "before the plan
     * arrives" is a state the test owns rather than a race it hopes to win. The
     * request still reaches the real handler the moment the hold is released —
     * this delays `plan.destroy`, it does not replace it.
     */
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.intercept("plan.destroy", (_params, passthrough) => held.then(passthrough));

    mountPortal();
    const user = userEvent.setup();

    const d = await openAgent(user, FIXTURE.errorAgent);
    // Destroy lives on Lifecycle, in the danger zone at the bottom.
    await user.click(within(d).getByRole("tab", { name: "Lifecycle" }));
    await user.click(within(d).getByRole("button", { name: `Destroy ${FIXTURE.errorAgent}…` }));

    const confirm = await waitFor(() => {
      const el = d.querySelector<HTMLElement>(".confirm");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    // `HTMLButtonElement`, so the `disabled` property below reads as a boolean
    // rather than as an attribute that may or may not be there.
    const submit = within(confirm).getByRole("button", { name: "Destroy" }) as HTMLButtonElement;
    const typed = within(confirm).getByLabelText("Type the agent name to confirm");

    // The plan has not landed, so the panel is still reading it.
    expect(confirm.textContent ?? "").toContain("reading the destroy plan…");
    expect(submit.disabled).toBe(true);

    // Reach the confirm field from the button that opened the panel, using only
    // the keyboard. The panel opens under that button, so it is forwards.
    let reached = false;
    for (let i = 0; i < 10 && !reached; i++) {
      await user.tab();
      reached = focusMarker([".name-input"]) === ".name-input";
    }
    expect(reached, "the destroy confirm field was not reachable by keyboard").toBe(true);

    await user.keyboard(FIXTURE.errorAgent);
    expect((typed as HTMLInputElement).value).toBe(FIXTURE.errorAgent);
    await waitFor(() => {
      expect(confirm.querySelector(".name-hint")?.textContent).toBe("matches");
    });

    // Everything the operator can do is done, and the button is still dead.
    expect(submit.disabled).toBe(true);
    expect(submit.getAttribute("title")).toBe("waiting for the destroy plan for these exact options");

    release();
    await waitFor(() => {
      expect(submit.disabled).toBe(false);
    });

    // The plan that armed it came from the real `plan.destroy` handler — the
    // interceptor only decided when, never what.
    expect(harness.calls.map((c) => c.name)).toContain("plan.destroy");

    // Escape closes the confirm first, then the drawer — the focus stack is
    // ordered, so one press does not throw away both.
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(d.querySelectorAll(".confirm").length).toBe(0);
    });
    expect(drawers().length).toBe(1);

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(drawers().length).toBe(0);
    });
  });
});
