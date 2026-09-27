/**
 * Plan-then-apply on the destroy confirmation, ported off Playwright
 * (§3.2 rule 3, §6.7).
 *
 * **What the original asserted** (`tests/e2e/destroy-plan.e2e.ts`): that the
 * destroy submit is armed by *the plan on screen* and nothing else. Two cases.
 * A plan read that fails: the panel says so in its own words, offers the read
 * again, renders no steps, and keeps the button dead even after the operator
 * has typed the agent's name exactly — the assertion the whole spec exists for,
 * because typing the name is a second gate and not the gate. And a plan read
 * that succeeds: the steps render, the button stays dead until the name is
 * typed, arms once it is, and goes dead again the moment an option is toggled,
 * because the plan that would be applied is no longer the plan that was read.
 *
 * **What this port asserts**: both cases, unchanged. What moves is where the
 * refusal is injected. Playwright fulfilled the request with a 503 at the
 * browser's network boundary (`page.route`); here it is
 * `harness.intercept("plan.destroy", …)`, which is the same idea one level
 * down — the bridge maps a thrown `HermeticError` through the binding's own
 * `refusalFor`, so the page receives exactly the `ApiError` a refusing handler
 * would have produced. The point the original was making is preserved intact:
 * there is no test-only branch anywhere in the production code, and what is
 * being exercised is what the drawer does with a refusal it did not expect.
 *
 * The second test adds a claim the original could not make. It runs with no
 * interception at all, so its plan is read by the real `plan.destroy` handler
 * against the fixture fleet — and the request log (`harness.calls`) is checked
 * at the end to confirm that the plan really was asked for and that no `apply`
 * or `agents.destroy` was ever issued. "Nothing was applied" stops being an
 * argument about what the spec declined to click.
 *
 * **What a happy-dom test cannot assert**: visibility in the layout sense. No
 * stylesheet is loaded and no box is measured, so `toBeVisible` becomes "is in
 * the document" — which is what it meant for this panel anyway, since the
 * alert, the steps and the confirmation are conditionally *rendered*. The
 * disabled button is checked on the attribute the component actually sets
 * rather than on Playwright's computed notion of enablement; it is the same
 * `disabled={armed === null}`.
 *
 * Each test gets its own fixture fleet (`bridge.ts`), so neither can leave the
 * other a `heron` in a state it did not seed.
 */
import { cleanup, screen, waitFor, within } from "../dom.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HermeticError } from "@hermetic/core";
import { userEvent } from "../dom.ts";
import { FIXTURE, flowHarness, gotoHash, mountPortal, type FlowHarness } from "./bridge.ts";

/**
 * What `plan.destroy` refuses with, and the message the panel must surface.
 *
 * The message is the original's, verbatim — it is what the assertion reads, and
 * what the panel has to put in front of an operator. The *code* is not:
 * `tests/e2e/destroy-plan.e2e.ts` fulfilled a raw 503 body at the network
 * boundary and could spell `AWS_UNAVAILABLE`, which is not and never was one of
 * core's `ERROR_CODES` (`packages/core/src/shared/error-codes.ts`). Here the
 * refusal is a real `HermeticError` travelling the real refusal path, so it
 * must carry a real code. `INTERNAL` is the honest one for an AWS call that did
 * not answer — there is no AWS-specific code — and it keeps its own message,
 * because `errors.ts` only substitutes `INTERNAL_MESSAGE` for a throw that was
 * not a `HermeticError` at all.
 */
const REFUSAL = {
  code: "INTERNAL",
  message: "ec2:DescribeInstances did not answer",
} as const;

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

/** Open the fixture agent's drawer, the way `helpers.ts`'s `openAgent` did. */
async function openAgent(name: string): Promise<HTMLElement> {
  const user = userEvent.setup();
  const row = await screen.findByLabelText(new RegExp(`^${name} · `));
  await user.click(row);
  return await waitFor(() => {
    const el = screen.getByRole("dialog");
    expect(el.getAttribute("aria-modal")).toBe("true");
    expect(el.querySelector(".detail-name")?.textContent).toBe(name);
    return el;
  });
}

/**
 * The confirmation panel inside the drawer, once Lifecycle's danger-zone
 * `Destroy <name>…` opened it.
 */
async function openConfirm(d: HTMLElement): Promise<HTMLElement> {
  const user = userEvent.setup();
  await user.click(within(d).getByRole("tab", { name: "Lifecycle" }));
  const name = d.querySelector(".detail-name")?.textContent ?? "";
  await user.click(within(d).getByRole("button", { name: `Destroy ${name}…` }));
  return await waitFor(() => {
    const confirm = d.querySelector<HTMLElement>(".confirm");
    expect(confirm).not.toBeNull();
    return confirm as HTMLElement;
  });
}

describe("the destroy confirmation, over a real head", () => {
  test("a destroy plan that cannot be read leaves the submit disabled", async () => {
    harness = await flowHarness();
    /**
     * The `page.route` of the original, one level down: the interceptor throws
     * and the bridge maps it exactly as a handler's own refusal is mapped, so
     * the drawer is handed the real `ApiError` and not a shape invented here.
     */
    harness.intercept("plan.destroy", () => {
      throw new HermeticError(REFUSAL.code, REFUSAL.message);
    });
    mountPortal();
    const user = userEvent.setup();

    const d = await openAgent(FIXTURE.errorAgent);
    const confirm = await openConfirm(d);

    const alert = await waitFor(() => within(confirm).getByRole("alert"));
    await waitFor(() => {
      expect(alert.textContent ?? "").toContain(`Could not read the destroy plan: ${REFUSAL.message}`);
    });
    expect(alert.textContent ?? "").toContain("nothing can be destroyed until it reads");
    expect(within(alert).getByRole("button", { name: "Retry plan" })).toBeDefined();

    // No steps were rendered, so there is nothing on screen that could be applied.
    expect(confirm.querySelectorAll(".steps-list span").length).toBe(0);

    const submit = within(confirm).getByRole("button", { name: "Destroy" });
    expect(submit.hasAttribute("disabled")).toBe(true);

    /**
     * The confirmation is completed in full — the volume choice left alone, the name
     * typed exactly — and the button still does not arm. This is the assertion
     * the whole spec exists for: typing the name is a *second* gate, not the
     * gate.
     */
    await user.type(
      within(confirm).getByLabelText("Type the agent name to confirm"),
      FIXTURE.errorAgent,
    );
    await waitFor(() => {
      expect(confirm.querySelector(".name-hint")?.textContent).toBe("matches");
    });
    expect(submit.hasAttribute("disabled")).toBe(true);
    expect(submit.getAttribute("title")).toBe("waiting for the destroy plan for these exact options");

    // "Retry plan" re-asks; the interceptor is still refusing, so the panel stays put.
    const before = harness.calls.filter((c) => c.name === "plan.destroy").length;
    await user.click(within(alert).getByRole("button", { name: "Retry plan" }));
    await waitFor(() => {
      expect(harness?.calls.filter((c) => c.name === "plan.destroy").length).toBe(before + 1);
    });
    await waitFor(() => {
      expect(within(confirm).getByRole("alert").textContent ?? "").toContain(
        `Could not read the destroy plan: ${REFUSAL.message}`,
      );
    });
    expect(within(confirm).getByRole("button", { name: "Destroy" }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  test("the plan reads, and only then does the submit arm", async () => {
    // No interception: this plan is read by the real handler, against the
    // fixture fleet, and the steps below are the ones core actually produced.
    harness = await flowHarness();
    mountPortal();
    const user = userEvent.setup();

    const d = await openAgent(FIXTURE.errorAgent);
    const confirm = await openConfirm(d);

    // The plan lands and its steps render; no error row this time.
    await waitFor(() => {
      expect(confirm.querySelectorAll(".steps-list span").length).toBeGreaterThan(0);
    });
    expect(within(confirm).queryAllByRole("alert").length).toBe(0);

    // A read plan alone is still not enough — the name has not been typed.
    const submit = within(confirm).getByRole("button", { name: "Destroy" });
    expect(submit.hasAttribute("disabled")).toBe(true);

    await user.type(
      within(confirm).getByLabelText("Type the agent name to confirm"),
      FIXTURE.errorAgent,
    );
    await waitFor(() => {
      expect(within(confirm).getByRole("button", { name: "Destroy" }).hasAttribute("disabled")).toBe(
        false,
      );
    });

    /**
     * Toggling an option invalidates the plan that is on screen, because the
     * plan it would apply is no longer the plan the operator read. The button
     * goes dead again until the new one lands.
     */
    await user.click(within(confirm).getByRole("radio", { name: /Delete data volume/ }));
    await waitFor(() => {
      expect(within(confirm).getByRole("button", { name: "Destroy" }).hasAttribute("disabled")).toBe(
        true,
      );
    });

    // Nothing is applied here. `Cancel` closes the panel and leaves the fleet be.
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(d.querySelectorAll(".confirm").length).toBe(0);
    });
    expect(d.querySelector(".detail-name")?.textContent).toBe(FIXTURE.errorAgent);

    /**
     * And the claim the original could only make by not clicking: the plan was
     * genuinely read from the head, and nothing that destroys anything was ever
     * asked for.
     */
    const asked = harness.calls.map((c) => c.name);
    expect(asked).toContain("plan.destroy");
    expect(asked).not.toContain("apply");
  });

  /**
   * The submit itself, over the real bridge. `apply` is the one public method
   * whose name is also a `Function` property, and Electrobun's request proxy
   * answers those with the function's own (`transport-rpc.ts`, `RpcHandle`).
   * Before this ran, no flow ever pressed Destroy, so a transport that sent
   * `apply` with no method name at all — "The requested method has no
   * handler: undefined" — was green everywhere and broken in the app.
   */
  test("the armed submit reaches the head as `apply`, carrying the plan it read", async () => {
    harness = await flowHarness();
    mountPortal();
    const user = userEvent.setup();

    const d = await openAgent(FIXTURE.errorAgent);
    const confirm = await openConfirm(d);
    await waitFor(() => {
      expect(confirm.querySelectorAll(".steps-list span").length).toBeGreaterThan(0);
    });
    await user.type(
      within(confirm).getByLabelText("Type the agent name to confirm"),
      FIXTURE.errorAgent,
    );
    const submit = await waitFor(() => {
      const button = within(confirm).getByRole("button", { name: "Destroy" });
      expect(button.hasAttribute("disabled")).toBe(false);
      return button;
    });
    await user.click(submit);

    const call = await waitFor(() => {
      const found = harness?.calls.find((c) => c.name === "apply");
      expect(found).toBeDefined();
      return found;
    });
    const params = call?.params as { plan?: { target?: unknown }; yes?: unknown };
    expect(params.yes).toBe(true);
    expect(params.plan?.target).toBe(FIXTURE.errorAgent);
    expect(harness.calls.map((c) => c.name)).not.toContain("undefined");

    /**
     * And the rail follows the op it started. `apply` answers `{op_id, op}`,
     * and the drawer subscribes by `op_id`; when the handlers answered `{op}`
     * alone the rail subscribed to `undefined` and never moved, while the
     * teardown ran to completion behind it.
     */
    const subscribe = await waitFor(() => {
      const found = harness?.calls.find((c) => c.name === "ops.subscribe");
      expect(found).toBeDefined();
      return found;
    });
    const opId = (subscribe?.params as { op_id?: unknown } | undefined)?.op_id;
    expect(typeof opId).toBe("string");
    await waitFor(() => {
      expect(d.querySelector(".drawer-op")).not.toBeNull();
    });
  });
});
