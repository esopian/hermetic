/**
 * Settings › Mobile end to end: the real page against the real `bind` and
 * `dispatch` over the fixture backend. `mobile.pair` is a read of the open
 * fleet, so the code the page draws is the fixture fleet's own link — parsed
 * back here with the same `parseMobileLink` the phone uses.
 */
import { cleanup, render, screen, userEvent, waitFor, within } from "../dom.ts";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { StrictMode, createElement } from "react";
import { HermeticError } from "@hermetic/core";
import { parseMobileLink } from "@hermetic/core/shared";
import { dispatch } from "../../../app/src/handlers/dispatch.ts";
import { MobileSection } from "../../src/components/settings/MobileSection.tsx";
import { type FlowHarness, flowHarness, gotoHash, mountPortal } from "./bridge.ts";

let harness: FlowHarness | null = null;

beforeEach(() => {
  window.localStorage.removeItem("hermetic.layout");
  window.sessionStorage.clear();
  gotoHash("");
});

afterEach(async () => {
  cleanup();
  await harness?.restore();
  harness = null;
  gotoHash("");
});

interface PairAnswer {
  link: string;
  fleet: { fleet_id: string; alias: string | null; tailnet: string };
  agents: { name: string }[];
  agents_in_link: number;
}

function pairCalls(h: FlowHarness): unknown[] {
  return h.calls.filter((c) => c.name === "mobile.pair").map((c) => c.params);
}

function linkField(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>("textbox", { name: "Pairing link" });
}

test("nothing is read until asked; then the QR, the link, the count and the fleet", async () => {
  harness = await flowHarness();
  const h = harness;
  const expected = (await dispatch(h.ctx, "mobile.pair", {})) as PairAnswer;
  const before = pairCalls(h).length;
  gotoHash("#settings/mobile");
  mountPortal();
  const user = userEvent.setup();

  // Opening the page reads nothing.
  await screen.findByText(/nothing read yet/);
  expect(screen.getByText("Read-only")).toBeDefined();
  expect(pairCalls(h).length).toBe(before);

  await user.click(screen.getByRole("button", { name: "Show pairing code" }));
  const qr = await screen.findByRole("img", { name: "Pairing QR code" });
  expect(qr.querySelector("svg path")).not.toBeNull();
  expect(pairCalls(h)).toEqual([{}]);

  // The link is the fleet's own, and the phone's parser reads all 11 agents back.
  const link = linkField().value;
  expect(link).toBe(expected.link);
  expect(link.startsWith("hermetic://fleet?")).toBe(true);
  expect(linkField().readOnly).toBe(true);
  const parsed = parseMobileLink(link);
  expect(parsed?.fleet_id).toBe("fxtr0001");
  expect(parsed?.agents.length).toBe(11);

  expect(screen.getByText("11 of 11 agents in the code")).toBeDefined();
  expect(screen.queryByText(/reads the other/)).toBeNull();
  // The facts: the page's own, not the env strip's or the rail's.
  const page = qr.closest<HTMLElement>(".st-page");
  if (page === null) throw new Error("the QR is not on the settings page");
  const facts = within(page);
  expect(facts.getByText("main", { selector: "b" })).toBeDefined();
  expect(facts.getByText("fxtr0001", { selector: "b" })).toBeDefined();
  const { tailnet } = expected.fleet;
  expect(facts.getByText(tailnet, { selector: "b" })).toBeDefined();
  expect(
    screen.getByText(
      `Install the Hermetic app and Tailscale on the phone, sign Tailscale into ${tailnet}, then scan this code.`,
    ),
  ).toBeDefined();
  expect(
    screen.getByText("The code carries no secret: the phone is trusted by its tailnet membership."),
  ).toBeDefined();

  // Copy puts the whole link on the clipboard and says so.
  const write = spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
  try {
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    expect(write).toHaveBeenCalledWith(expected.link);
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeDefined());
    expect(screen.getByRole("status").textContent).toBe("Copied the pairing link");
    write.mockRejectedValue(new Error("Denied"));
    await user.click(screen.getByRole("button", { name: "Copied" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("Clipboard unavailable"),
    );
  } finally {
    write.mockRestore();
  }

  // The primary reads again.
  await user.click(screen.getByRole("button", { name: "Read again" }));
  await waitFor(() => expect(pairCalls(h).length).toBe(2));
  expect(linkField().value).toBe(expected.link);
});

test("a refusal shows core's code and message; a retry clears it; a failed re-read keeps the last code", async () => {
  harness = await flowHarness();
  const h = harness;
  h.intercept("mobile.pair", () => {
    throw new HermeticError("FLEET_MISMATCH", "the _fleet item is missing");
  });
  gotoHash("#settings/mobile");
  mountPortal();
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: "Show pairing code" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe("FLEET_MISMATCH · the _fleet item is missing");
  expect(screen.queryByRole("img", { name: "Pairing QR code" })).toBeNull();
  expect(screen.queryByText(/nothing read yet/)).toBeNull();

  h.intercept("mobile.pair", null);
  await user.click(screen.getByRole("button", { name: "Show pairing code" }));
  await screen.findByRole("img", { name: "Pairing QR code" });
  expect(screen.queryByRole("alert")).toBeNull();
  const shown = linkField().value;

  h.intercept("mobile.pair", () => {
    throw new HermeticError("ACCOUNT_MISMATCH", "these credentials are for another account");
  });
  await user.click(screen.getByRole("button", { name: "Read again" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toBe(
      "ACCOUNT_MISMATCH · these credentials are for another account",
    ),
  );
  expect(linkField().value).toBe(shown);
  expect(screen.getByRole("img", { name: "Pairing QR code" })).toBeDefined();
});

test("a link that names fewer agents than the fleet has says the phone reads the rest", async () => {
  harness = await flowHarness();
  const h = harness;
  h.intercept("mobile.pair", async (_params, passthrough) => {
    const answer = (await passthrough()) as PairAnswer;
    return { ...answer, agents_in_link: answer.agents.length - 3 };
  });
  gotoHash("#settings/mobile");
  mountPortal();
  const user = userEvent.setup();

  await user.click(await screen.findByRole("button", { name: "Show pairing code" }));
  await screen.findByText("8 of 11 agents in the code");
  expect(
    screen.getByText("The phone reads the other 3 from the fleet once it is on the tailnet."),
  ).toBeDefined();
});

test("under StrictMode, as the app mounts it, the answer still lands", async () => {
  // The app's entry wraps the page in StrictMode, whose mount, cleanup, mount
  // once left a liveness flag false and every answer dropped.
  harness = await flowHarness();
  render(createElement(StrictMode, null, createElement(MobileSection)));
  const user = userEvent.setup();

  await user.click(screen.getByRole("button", { name: "Show pairing code" }));
  await screen.findByRole("img", { name: "Pairing QR code" });
  expect(screen.getByText("11 of 11 agents in the code")).toBeDefined();
  expect(screen.queryByText("reading the fleet…")).toBeNull();
});
