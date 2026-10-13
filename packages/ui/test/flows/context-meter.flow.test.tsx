/**
 * The composer's context-window meter, over the fixture's transcripts.
 *
 * The figures are the gateway's own (`ChatUsage.context_*`), read through the
 * real `chat.history` handler and the real `bind` and drawn by the shipping
 * `Thread`. The fixture seeds one conversation per band: atlas's portal thread
 * is neutral, granite/quarry's release checklist is past the warn line, and
 * atlas's CLI reindex ran the window to 99%.
 *
 * Atlas's portal thread is stored the way a real box stores it, with no window
 * on its rows; its figure is the live gateway session's, which the first
 * `chat.history` read asks for (`usage: true`). That is the reopened
 * conversation whose meter is right before any turn is sent.
 */
import { cleanup, screen, userEvent, waitFor } from "../dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { type FlowHarness, flowHarness, gotoHash, mountPortal } from "./bridge.ts";

let harness: FlowHarness | null = null;

function reset(): void {
  window.localStorage.removeItem("hermetic.layout");
  window.sessionStorage.clear();
  gotoHash("");
}

beforeEach(reset);

afterEach(async () => {
  cleanup();
  await harness?.restore();
  harness = null;
  reset();
});

async function openMeter(instance: string, bot: string, session: string): Promise<HTMLElement> {
  harness = await flowHarness();
  await harness.ctx.hermetic().chat.listen({ instance, listening: true });
  await harness.ctx.chatOwner.sync();
  gotoHash(`#chat/${instance}/${bot}?session=${session}`);
  mountPortal();
  return await screen.findByRole("meter", undefined, { timeout: 4_000 });
}

test("a near-full window reads bad, with the exact figures as its name", async () => {
  const meter = await openMeter("atlas", "default", "sx-atlas-cli");
  expect(meter.dataset.level).toBe("bad");
  expect(meter.textContent).toBe("99%");
  expect(meter.getAttribute("aria-valuenow")).toBe("99");
  expect(meter.getAttribute("data-tip")).toBe("Context: 198,400 / 200,000 tokens (99%)");
  expect(meter.getAttribute("aria-label")).toBe(meter.getAttribute("data-tip"));
  expect(meter.closest(".ch-composer-foot")).not.toBeNull();
});

test("a window past the warn line reads warn", async () => {
  const meter = await openMeter("granite", "quarry", "sx-granite-quarry-cli");
  expect(meter.dataset.level).toBe("warn");
  expect(meter.textContent).toBe("84%");
  expect(meter.getAttribute("data-tip")).toBe("Context: 168,400 / 200,000 tokens (84%)");
});

test("an ordinary conversation reads neutral", async () => {
  const meter = await openMeter("atlas", "default", "sx-atlas-portal");
  expect(meter.dataset.level).toBe("neutral");
  expect(meter.textContent).toBe("12%");
  expect(meter.getAttribute("data-tip")).toBe("Context: 24,400 / 200,000 tokens (12%)");
});

test("a conversation with no figure from the gateway draws no meter", async () => {
  harness = await flowHarness();
  await harness.ctx.hermetic().chat.listen({ instance: "corvid", listening: true });
  await harness.ctx.chatOwner.sync();
  gotoHash("#chat/corvid/wren?session=sx-corvid-wren-portal");
  mountPortal();
  await screen.findByText("Are you awake?", undefined, { timeout: 4_000 });
  expect(screen.queryByRole("meter")).toBeNull();
});

/** The `chat.history` requests that asked for the live session's usage. */
const usageReads = (h: FlowHarness) =>
  h.calls.filter(
    (call) => call.name === "chat.history" && (call.params as { usage?: unknown }).usage === true,
  );

test("a reopened conversation shows its live window before any turn is sent", async () => {
  const meter = await openMeter("atlas", "default", "sx-atlas-portal");
  expect(meter.textContent).toBe("12%");
  expect(meter.closest(".ch-composer-foot")).not.toBeNull();
  // Nothing was sent: the figure came with the conversation's first read.
  expect(harness!.calls.some((call) => call.name === "chat.turn")).toBe(false);
  expect(usageReads(harness!)).toHaveLength(1);
  // And not from the rows: they carry tokens but no window, as a box's do.
  const stored = await harness!.ctx
    .hermetic()
    .chat.history({ instance: "atlas", bot: "default", session: "sx-atlas-portal" });
  expect(stored.usage).toBeUndefined();
  expect(stored.messages.some((m) => m.usage?.context_used != null)).toBe(false);
  expect(stored.messages.some((m) => m.usage?.input_tokens === 24_400)).toBe(true);
});

test("a turn's figure replaces the reopened one, and later reads do not take it back", async () => {
  await openMeter("atlas", "default", "sx-atlas-portal");
  expect(screen.getByRole("meter").textContent).toBe("12%");
  const composer = await screen.findByRole("textbox", { name: /^Message / }, { timeout: 4_000 });
  await userEvent.type(composer, "how full is the window?{Enter}");
  // The fixture turn's `done` reports 12,040 of 200,000: 6%.
  await waitFor(() => expect(screen.getByRole("meter").textContent).toBe("6%"), {
    timeout: 4_000,
  });
  // The settled turn's re-read lands, and the live figure is not asked again.
  await waitFor(
    () =>
      expect(harness!.calls.filter((call) => call.name === "chat.history").length).toBeGreaterThan(1),
    { timeout: 4_000 },
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(screen.getByRole("meter").textContent).toBe("6%");
  expect(usageReads(harness!)).toHaveLength(1);
});
