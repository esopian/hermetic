/**
 * Injected Hermes rows in a Bot Chat thread, driven end to end.
 *
 * The fixture's `sx-kestrel-injected` session (`fixture-chat-injected.ts`) is
 * raw dashboard rows run through the real `mapHistory`: every row Hermes
 * stores as the user's that the operator never typed, beside the operator's
 * own skill invocation, messaging reply and a turn that failed. Each is read
 * over the real `chat.history` handler and drawn by the shipping `Thread`.
 *
 * A boundary (a scheduled wakeup, a resumed or compacted context, a handoff, a
 * model switch) is a centred marker between turns; work-shaped notices (a
 * goal, a nudge, the tool-call limit, a persona) are gutter rows. None of them
 * is "You".
 */
import { cleanup, waitFor } from "../dom.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { FIXTURE, type FlowHarness, flowHarness, gotoHash, mountPortal } from "./bridge.ts";

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

const id = (n: number | string) => `mx-kestrel-injected-${n}`;

/** Listen on kestrel, open the injected session, and wait for its last row (the failed turn). */
async function openInjected(): Promise<HTMLElement> {
  harness = await flowHarness();
  await harness.ctx.hermetic().chat.listen({ instance: FIXTURE.sseAgent, listening: true });
  await harness.ctx.chatOwner.sync();
  gotoHash(`#chat/${FIXTURE.sseAgent}/default?session=sx-kestrel-injected`);
  mountPortal();
  await waitFor(() => expect(row(52)?.querySelector(".ch-failure")).toBeTruthy(), {
    timeout: 4_000,
  });
  return document.querySelector<HTMLElement>(".ch-log")!;
}

function row(n: number | string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-chat-message="${id(n)}"]`);
}

const MARKERS = [3, 5, 7, 9, 11, 12, "18:notice", 20, 22, 36, 38, 40, 42, "49:notice"];
const GUTTER = [15, 16, 24, 26, 28, 29, 30, 32, 34, 44, 46];

test("only the operator's own rows are labelled You", async () => {
  const log = await openInjected();
  const mine = [...log.querySelectorAll<HTMLElement>("article.ch-msg.me")].map(
    (el) => el.dataset["chatMessage"],
  );
  expect(mine).toEqual([1, 13, 18, 47, 49, 51].map(id));
  for (const el of log.querySelectorAll(".ch-msg-who"))
    if (el.textContent === "You") expect(el.closest("article.ch-msg.me")).not.toBeNull();
});

test("boundaries are markers between turns, work-shaped notices are gutter rows", async () => {
  const log = await openInjected();
  const markers = [...log.querySelectorAll<HTMLElement>(".ch-marker-row")].map(
    (el) => el.dataset["chatMessage"],
  );
  expect(markers).toEqual(MARKERS.map(id));
  for (const n of GUTTER) expect(row(n)?.classList.contains("ch-ev")).toBe(true);
  expect(row(3)!.textContent).toContain("heartbeat · every 30m");
  expect(row(5)!.textContent).toContain("loop wakeup #4");
  expect(row(9)!.querySelector(".ch-marker.bad")).not.toBeNull();
  expect(row(11)!.textContent).toContain("cron · nightly-digest · mirrored");
  expect(row(12)!.textContent).toContain("webhook · github-push · mirrored");
  expect(row(20)!.textContent).toContain("turn resumed after a crash");
  expect(row(40)!.textContent).toContain("handed off from CLI");
  expect(row(42)!.textContent).toContain("model → claude-sonnet-5-5");
  expect(row(36)!.querySelector("summary")!.textContent).toBe("view summary");
  expect(row(24)!.querySelector(".k")!.textContent).toBe("goal");
  expect(row(26)!.dataset["outcome"]).toBe("failed");
  expect(row(34)!.textContent).toContain("tool-call limit reached");
  expect(row(46)!.textContent).toContain("default style");
});

test("markers never fold into a burst; a warn row keeps its own row too", async () => {
  const log = await openInjected();
  const bursts = [...log.querySelectorAll<HTMLElement>(".ch-ev.burst")];
  expect(bursts.length).toBe(2);
  for (const burst of bursts) expect(burst.querySelector(".ch-marker-row")).toBeNull();
  // The two routine nudges after a reply burst; of the three after the gate,
  // the oversized tool call (warn) stands alone and the other two burst.
  expect(row(15)!.closest(".ch-ev.burst")).toBe(bursts[0]!);
  expect(row(16)!.closest(".ch-ev.burst")).toBe(bursts[0]!);
  expect(row(28)!.closest(".ch-ev.burst")).toBeNull();
  expect(row(29)!.closest(".ch-ev.burst")).toBe(bursts[1]!);
});

test("the reply after a marker says re: in its header, not responding to", async () => {
  await openInjected();
  const re = (n: number) => row(n)!.querySelector(".ch-reply-meta")?.textContent ?? null;
  expect(re(4)).toBe("re: heartbeat");
  expect(re(6)).toBe("re: /loop #4");
  expect(re(8)).toBe("re: cron pr-checkin");
  expect(re(41)).toBe("re: handoff");
  expect(row(4)!.querySelector(".ch-inreply")).toBeNull();
  // After a gutter burst, the reply keeps the responding-to line.
  expect(re(17)).toBeNull();
  expect(row(17)!.querySelector(".ch-inreply")!.textContent).toContain("responding to 2 events");
});

test("the carried-over task list folds open to a checklist, nested by depth", async () => {
  await openInjected();
  const marker = row(38)!;
  expect(marker.textContent).toContain("task list carried over · 1 active · 2 open");
  const items = [...marker.querySelectorAll<HTMLElement>(".ch-tasks li")];
  expect(items.map((li) => li.dataset["status"])).toEqual(["done", "active", "pending", "pending"]);
  expect(items[1]!.textContent).toContain("Rebase #108 onto master");
  expect(items[1]!.style.paddingLeft).toBe("26px");
  expect(items[0]!.style.paddingLeft).toBe("8px");
});

test("a skill invocation stays the operator's, with a chip and the instruction", async () => {
  await openInjected();
  const skill = row(47)!;
  expect(skill.querySelector(".ch-msg-who")!.textContent).toBe("You");
  expect(skill.querySelector(".ch-skill-chip")!.textContent).toBe("⚡ review");
  expect(skill.querySelector(".ch-msg-body")!.textContent).toContain("the diff on #108");
  expect(skill.textContent).not.toContain("IMPORTANT");
});

test("a messaging reply shows what it replied to above the operator's text", async () => {
  await openInjected();
  const reply = row(13)!;
  expect(reply.querySelector(".ch-replyto")!.textContent).toBe("↩ replying to “can you rebase #108?”");
  expect(reply.querySelector(".ch-msg-body")!.textContent).toBe("yes, and re-run CI after");
});

test("a gateway resume with the operator's text is a marker, then their message", async () => {
  await openInjected();
  const marker = row("18:notice")!;
  const mine = row(18)!;
  expect(marker.querySelector(".ch-marker.warn")!.textContent).toContain(
    "turn resumed after gateway restart",
  );
  expect(mine.querySelector(".ch-msg-who")!.textContent).toBe("You");
  expect(mine.querySelector(".ch-msg-body")!.textContent).toBe("is #108 pushed yet?");
  expect(marker.compareDocumentPosition(mine) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test("a failed turn is the failure card, not the bot speaking", async () => {
  await openInjected();
  const failed = row(52)!;
  expect(failed.querySelector(".ch-failure")).not.toBeNull();
  expect(failed.querySelector(".ch-plain-text, .ch-md")).toBeNull();
  const buttons = [...failed.querySelectorAll(".ch-failure button")].map((b) => b.textContent);
  expect(buttons).toEqual(expect.arrayContaining(["Retry", "Copy details"]));
});
