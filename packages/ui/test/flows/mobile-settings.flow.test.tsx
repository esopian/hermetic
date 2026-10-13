/**
 * Settings › Mobile end to end: the real page against the real `dispatch` over
 * the fixture backend, with the bridge hosted on loopback port 0 where a flow
 * needs one (`flowHarness({ mobileHost: true })`).
 *
 * The phone is played by a plain `fetch` to the bridge's own pair route, the
 * request the companion app makes after scanning the QR, so a device appearing
 * in the table is the bridge's `paired` event reaching the page through
 * `mobile.serve` — not a test calling the store behind its back.
 */
import { act, cleanup, screen, userEvent, waitFor, within } from "../dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { HermeticError, MOBILE_PROTOCOL, MOBILE_ROUTES, mobileBridgeHost } from "@hermetic/core";
import { dispatch } from "../../../app/src/handlers/dispatch.ts";
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

function toggle(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>("checkbox", { name: "Serve the mobile bridge" });
}

function settingsCalls(h: FlowHarness): unknown[] {
  return h.calls.filter((c) => c.name === "mobile.settings").map((c) => c.params);
}

/** Capture what `mobile.pair` answered, so the test knows the code the page shows. */
function capturePairs(h: FlowHarness): { code: string; url: string }[] {
  const seen: { code: string; url: string }[] = [];
  h.intercept("mobile.pair", async (_params, passthrough) => {
    const answer = (await passthrough()) as { code: string; url: string };
    seen.push(answer);
    return answer;
  });
  return seen;
}

/** What the companion app does with a scanned code. */
async function phonePairs(bridgeUrl: string, code: string, device_name: string): Promise<Response> {
  return await fetch(new URL(MOBILE_ROUTES.pair, bridgeUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [MOBILE_PROTOCOL.VERSION_HEADER]: String(MOBILE_PROTOCOL.PROTOCOL_VERSION),
    },
    body: JSON.stringify({ code, device_name, platform: "android" }),
  });
}

test("serve, pair a phone, see it arrive, revoke it, stop", async () => {
  harness = await flowHarness({ mobileHost: true });
  const h = harness;
  const pairs = capturePairs(h);
  gotoHash("#settings/mobile");
  mountPortal();
  const user = userEvent.setup();

  await waitFor(() => expect(toggle().disabled).toBe(false));
  expect(toggle().checked).toBe(false);
  expect(screen.getByText("No phones paired")).toBeDefined();

  // On: the setting is written, the host starts the bridge, and the follow
  // reports it listening.
  await user.click(toggle());
  await waitFor(() => expect(toggle().checked).toBe(true));
  expect(settingsCalls(h)).toContainEqual({ enabled: true });
  const status = h.ctx.mobile?.status() ?? null;
  if (status === null) throw new Error("enabling did not start the hosted bridge");
  await waitFor(() => expect(screen.getByText(status.url)).toBeDefined());
  expect(screen.getByText("listening")).toBeDefined();

  // Pair: a QR and the code, grouped for reading aloud.
  await user.click(screen.getByRole("button", { name: "Pair a phone" }));
  await waitFor(() => expect(pairs.length).toBe(1));
  const issued = pairs[0];
  if (issued === undefined) throw new Error("unreachable");
  const shown = `${issued.code.slice(0, 4)}-${issued.code.slice(4)}`;
  await waitFor(() => expect(screen.getByLabelText("Pairing code").textContent).toBe(shown));
  const qr = screen.getByRole("img", { name: "Pairing QR code" });
  expect(qr.querySelector("svg path")).not.toBeNull();
  expect(screen.getByText(/^expires in \d+:\d\d$/)).toBeDefined();
  expect(screen.getByText(/must be on the tailnet/)).toBeDefined();

  // The phone spends the code: the panel closes and the phone is listed.
  // In `act`: the bridge's `paired` event reaches the page while the phone's
  // request is still in flight, and the page's state moves on it.
  const answer = await act(async () => await phonePairs(status.url, issued.code, "FIXTURE Pixel"));
  expect(answer.status).toBe(200);
  await waitFor(() => expect(screen.getByText("Paired FIXTURE Pixel.")).toBeDefined());
  expect(screen.queryByLabelText("Pairing code")).toBeNull();
  const row = await waitFor(() => {
    const cell = screen.getByText("FIXTURE Pixel", { selector: "b" });
    const tr = cell.closest("tr");
    if (tr === null) throw new Error("not in a row yet");
    return tr;
  });
  expect(within(row).getByText("Android")).toBeDefined();
  expect(within(row).getByText("on")).toBeDefined();
  expect(screen.getByText(/paired FIXTURE Pixel ·/)).toBeDefined();

  // Revoke, confirmed in place.
  await user.click(screen.getByRole("button", { name: "Revoke FIXTURE Pixel" }));
  const confirm = screen.getByRole("alertdialog", { name: "Revoke FIXTURE Pixel" });
  await user.click(within(confirm).getByRole("button", { name: "Revoke phone" }));
  await waitFor(() => expect(screen.getByText("No phones paired")).toBeDefined());
  expect(screen.queryByRole("alertdialog")).toBeNull();
  const held = (await dispatch(h.ctx, "mobile.devices", {})) as { devices: unknown[] };
  expect(held.devices).toEqual([]);

  // Off: the bridge stops and the page says so.
  await user.click(toggle());
  await waitFor(() => expect(toggle().checked).toBe(false));
  expect(settingsCalls(h)).toContainEqual({ enabled: false });
  expect(h.ctx.mobile?.status()).toBeNull();
  await waitFor(() => expect(screen.getByText("off", { selector: "b" })).toBeDefined());
});

test("cancelling a revoke keeps the phone", async () => {
  harness = await flowHarness({ mobileHost: true });
  const h = harness;
  await dispatch(h.ctx, "mobile.settings", { enabled: true });
  await h.ctx.mobile?.sync();
  const status = h.ctx.mobile?.status() ?? null;
  if (status === null) throw new Error("the hosted bridge did not start");
  const { code } = (await dispatch(h.ctx, "mobile.pair", {})) as { code: string };
  expect((await phonePairs(status.url, code, "FIXTURE iPhone")).status).toBe(200);

  gotoHash("#settings/mobile");
  mountPortal();
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Revoke FIXTURE iPhone" }));
  const confirm = screen.getByRole("alertdialog", { name: "Revoke FIXTURE iPhone" });
  await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.getByText("FIXTURE iPhone", { selector: "b" })).toBeDefined();
  expect(h.calls.some((c) => c.name === "mobile.revoke")).toBe(false);
});

test("with no hosted bridge: enabling saves, pairing still issues a code, and the page says why it cannot follow", async () => {
  harness = await flowHarness();
  const h = harness;
  const pairs = capturePairs(h);
  gotoHash("#settings/mobile");
  mountPortal();
  const user = userEvent.setup();

  await waitFor(() => expect(toggle().disabled).toBe(false));
  await user.click(toggle());
  await waitFor(() => expect(toggle().checked).toBe(true));
  expect(settingsCalls(h)).toContainEqual({ enabled: true });
  expect(await dispatch(h.ctx, "mobile.settings", {})).toMatchObject({ enabled: true });
  await waitFor(() => expect(screen.getByText(/live status unavailable/)).toBeDefined());
  expect(screen.getByText("not serving")).toBeDefined();

  await user.click(screen.getByRole("button", { name: "Pair a phone" }));
  await waitFor(() => expect(pairs.length).toBe(1));
  expect(screen.getByRole("img", { name: "Pairing QR code" })).toBeDefined();
  expect(screen.getByText(/The bridge is not running/)).toBeDefined();

  // A new code replaces the old one on screen.
  await user.click(screen.getByRole("button", { name: "Generate new code" }));
  await waitFor(() => expect(pairs.length).toBe(2));
  const second = pairs[1]?.code ?? "";
  await waitFor(() =>
    expect(screen.getByLabelText("Pairing code").textContent).toBe(
      `${second.slice(0, 4)}-${second.slice(4)}`,
    ),
  );
  await user.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.queryByLabelText("Pairing code")).toBeNull();
});

test("the address form validates, warns on a wildcard host, and saves overrides", async () => {
  harness = await flowHarness();
  const h = harness;
  gotoHash("#settings/mobile");
  mountPortal();
  const user = userEvent.setup();

  const host = await screen.findByLabelText<HTMLInputElement>("Host");
  const port = screen.getByLabelText<HTMLInputElement>("Port");
  await waitFor(() => expect(host.disabled).toBe(false));

  await user.type(host, "0.0.0.0");
  expect(screen.getByText(/listens on every network this laptop joins/)).toBeDefined();
  await user.type(port, "99999");
  expect(screen.getByText(/Port must be a whole number/)).toBeDefined();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save address" }).disabled).toBe(true);

  await user.clear(host);
  await user.type(host, "100.64.0.9");
  await user.clear(port);
  await user.type(port, "8123");
  expect(screen.queryByText(/listens on every network/)).toBeNull();
  await user.click(screen.getByRole("button", { name: "Save address" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Save address" })).toBeNull());
  expect(settingsCalls(h)).toContainEqual({ host: "100.64.0.9", port: 8123 });
  expect(await dispatch(h.ctx, "mobile.settings", {})).toEqual({
    enabled: false,
    host: "100.64.0.9",
    port: 8123,
  });

  // Clearing both fields goes back to the defaults.
  await user.clear(host);
  await user.clear(port);
  await user.click(screen.getByRole("button", { name: "Save address" }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Save address" })).toBeNull());
  expect(settingsCalls(h)).toContainEqual({ host: null, port: null });
});

test("a bridge that cannot start says why, until it serves again", async () => {
  harness = await flowHarness({ mobileHost: true });
  const h = harness;
  const host = h.ctx.mobile;
  if (host === undefined) throw new Error("the harness hosts a bridge");
  gotoHash("#settings/mobile");
  mountPortal();
  const user = userEvent.setup();

  await waitFor(() => expect(toggle().disabled).toBe(false));
  await user.click(toggle());
  await waitFor(() => expect(screen.getByText("listening")).toBeDefined());

  // The next start fails, twice (the host retries once): the follow reports it.
  const core = mobileBridgeHost(h.ctx.state.hermetic);
  const start = core.start;
  core.start = async () => {
    throw new HermeticError("CONFLICT", "port 8787 is taken");
  };
  try {
    await act(async () => {
      await host.stop("test");
      await host.sync();
    });
    await waitFor(() =>
      expect(screen.getByText("Bridge failed to start: port 8787 is taken (CONFLICT)")).toBeDefined(),
    );
    expect(screen.getByText("not serving")).toBeDefined();
  } finally {
    core.start = start;
  }

  // Serving again clears it.
  await act(async () => {
    await host.sync();
  });
  await waitFor(() => expect(screen.getByText("listening")).toBeDefined());
  expect(screen.queryByText(/Bridge failed to start/)).toBeNull();
  await act(async () => {
    await host.stop("test");
  });
}, 20_000);
