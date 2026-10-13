/**
 * One child's run in the modal (WI-14, Option C), through the real provider:
 * the modal reads the same block the line draws, so an observed update moves
 * it while it is open; Steer and Stop go out as `chat.steer`/`chat.abort` with
 * `subagent_id`; and what the operator sees after either is the honest state
 * (Q5's three steps, "Stop requested" until the child is interrupted).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, screen, userEvent, waitFor, within } from "./dom.ts";
import { deliver, harness, mount } from "./chat-observe-fixtures.tsx";
import type { Harness } from "./chat-observe-fixtures.tsx";
import {
  rolloverTo,
  botTurn,
  delegateTool,
  done,
  line,
  running,
  subagentEvent,
  userTurn,
} from "./subagent-fixtures.tsx";
import type { Kid } from "./subagent-fixtures.tsx";

afterEach(cleanup);

interface Calls {
  steers: { id: string; text: string; session: string | null | undefined }[];
  stops: string[];
  steerAnswer: "queued" | "rejected";
  stopAnswer: boolean;
}

function controls(h: Harness): Calls {
  const calls: Calls = { steers: [], stops: [], steerAnswer: "queued", stopAnswer: true };
  h.api.steerSubagent = (instance, bot, id, text, session) => {
    calls.steers.push({ id, text, session });
    return Promise.resolve({ instance, bot, status: calls.steerAnswer } as never);
  };
  h.api.stopSubagent = (instance, bot, id) => {
    calls.stops.push(id);
    return Promise.resolve({ instance, bot, aborted: calls.stopAnswer } as never);
  };
  return calls;
}

/** A finished parent turn holding three children: one done, two running. */
async function setup(): Promise<{ h: Harness; calls: Calls; kids: Kid[] }> {
  const h = harness();
  const calls = controls(h);
  const kids = [
    done({ task_index: 0, task_count: 3, tool_id: "call-a", goal: "Classify the core-unit failure" }),
    running({
      task_index: 1,
      task_count: 3,
      tool_id: "call-a",
      goal: "Classify the e2e-flows failure",
    }),
    running({ task_index: 2, task_count: 3, tool_id: "call-a", goal: "Classify the lint failure" }),
  ];
  h.history = [userTurn("u1", "triage CI"), botTurn("b1", [delegateTool("call-a", "ok"), ...kids])];
  await mount(h);
  await waitFor(() => expect(line(kids[2]!.subagent_id)).not.toBeNull());
  return { h, calls, kids };
}

async function openKid(k: Kid): Promise<HTMLElement> {
  await userEvent.click(within(line(k.subagent_id)!).getByRole("button", { name: /Open subagent/ }));
  return screen.getByRole("dialog");
}

const heading = () => screen.getByRole("dialog").querySelector("h3")?.textContent ?? "";
const ack = () => screen.getByRole("dialog").querySelector(".sa-ack")?.textContent ?? "";
const next = () => within(screen.getByRole("dialog")).getByRole("button", { name: "Next subagent" });
const steerField = () =>
  within(screen.getByRole("dialog")).queryByRole("textbox", { name: "Steer this subagent" });

describe("the subagent modal", () => {
  test("lists the siblings and switches between them by click, arrow and ‹ ›", async () => {
    const { kids } = await setup();
    const dialog = await openKid(kids[1]!);
    expect(heading()).toBe("Classify the e2e-flows failure");
    expect(dialog.querySelector(".sa-mhead .kicker")?.textContent).toBe("Subagent 2 of 3 · running");
    // The parent turn is over; the header says so, since the thread is hidden.
    expect(dialog.querySelector(".sa-parent")?.textContent).toBe("parent: done");
    const sibs = Array.from(dialog.querySelectorAll<HTMLButtonElement>(".sa-sib"));
    expect(sibs.map((b) => b.dataset.sibling)).toEqual(kids.map((k) => k.subagent_id));
    await userEvent.click(sibs[0]!);
    expect(heading()).toBe("Classify the core-unit failure");
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(heading()).toBe("Classify the lint failure");
    await userEvent.click(within(dialog).getByRole("button", { name: "Previous subagent" }));
    expect(heading()).toBe("Classify the e2e-flows failure");
  });

  test("moves while it is open: a new tool call, then the result", async () => {
    const { h, kids } = await setup();
    const k = kids[1]!;
    const dialog = await openKid(k);
    expect(dialog.querySelector(".sa-working")?.textContent).toMatch(/^working · \d:\d\d$/);
    await deliver(
      h,
      subagentEvent({
        ...k,
        tools: [...k.tools, { name: "terminal", preview: "bun test --rerun-each 5" }],
        tool_count: 2,
        progress: "2 tools · rerunning the flows suite",
      }),
    );
    await waitFor(() => expect(dialog.textContent).toContain("bun test --rerun-each 5"));
    expect(dialog.querySelector(".sa-t.cur .pv")?.textContent).toBe("bun test --rerun-each 5");
    expect(dialog.querySelector(".sa-t.progress")?.textContent).toContain("rerunning the flows suite");
    // The new call was seen live, so it carries an offset from the child's start.
    expect(dialog.querySelector(".sa-t.cur .rel")?.textContent).toMatch(/^\+0:1\d$/);
    await deliver(
      h,
      subagentEvent({
        ...k,
        status: "completed",
        verdict: "done",
        summary: "Flaky.\nTwo of five reruns failed at the same waitFor.",
        duration_ms: 51_000,
        tool_count: 2,
        usage: { input_tokens: 1000, output_tokens: 200, api_calls: 4 },
        files_read: ["a.ts", "b.ts"],
        output_tail: [
          { name: "terminal", preview: "bun test", is_error: true },
          { name: "read_file", preview: "a.ts" },
        ],
      }),
    );
    await waitFor(() => expect(dialog.querySelector(".sa-result")).not.toBeNull());
    expect(dialog.querySelector(".sa-rollup")?.textContent).toBe(
      "51s · 2 tools · 2 files · 1,200 tokens · 4 api calls",
    );
    // No cost: the live wire never carries one (Q1).
    expect(dialog.querySelector(".sa-cost")).toBeNull();
    expect(dialog.querySelector(".sa-tail li.err")?.textContent).toContain("bun test");
    expect(dialog.querySelector(".sa-working")).toBeNull();
    expect(steerField()).toBeNull();
  });

  test("a steer is queued, then likely applied on the child's next tool call", async () => {
    const { h, calls, kids } = await setup();
    const k = kids[1]!;
    await openKid(k);
    expect(document.activeElement).toBe(steerField());
    await userEvent.type(steerField()!, "check the devkit first{Enter}");
    await waitFor(() => expect(ack()).toBe("Queued · not yet confirmed"));
    expect(calls.steers).toEqual([
      { id: k.subagent_id, text: "check the devkit first", session: "s1" },
    ]);
    expect(steerField()!.getAttribute("value") ?? (steerField() as HTMLInputElement).value).toBe("");
    await deliver(
      h,
      subagentEvent({
        ...k,
        tools: [...k.tools, { name: "terminal", preview: "ls devkit · steer: check the devkit first" }],
        tool_count: 2,
      }),
    );
    await waitFor(() => expect(ack()).toBe("Likely applied"));
  });

  test("a steer that arrived too late reads as not landed", async () => {
    const { h, kids } = await setup();
    const k = kids[1]!;
    await openKid(k);
    await userEvent.type(steerField()!, "stop after this{Enter}");
    await waitFor(() => expect(ack()).toBe("Queued · not yet confirmed"));
    await deliver(
      h,
      subagentEvent({
        ...k,
        status: "completed",
        verdict: "done",
        summary:
          "Real.\n\n[steer did not land — the subagent finished before it could be delivered: stop after this]",
      }),
    );
    await waitFor(() => expect(ack()).toBe("Steer did not land"));
  });

  test("a rejected steer and a stop that found nothing say the child is gone", async () => {
    const { calls, kids } = await setup();
    calls.steerAnswer = "rejected";
    calls.stopAnswer = false;
    await openKid(kids[1]!);
    await userEvent.type(steerField()!, "anything{Enter}");
    await waitFor(() => expect(ack()).toBe("Not delivered — subagent gone or session reset"));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "STOP" }));
    await waitFor(() => expect(ack()).toContain("Not found — subagent gone or session reset"));
  });

  test("Stop is requested on the box's yes, and stopped only on the interrupted completion", async () => {
    const { h, calls, kids } = await setup();
    const k = kids[2]!;
    const dialog = await openKid(k);
    await userEvent.click(within(dialog).getByRole("button", { name: "STOP" }));
    await waitFor(() => expect(ack()).toBe("Stop requested"));
    expect(calls.stops).toEqual([k.subagent_id]);
    expect(ack()).not.toContain("Stopped by you");
    // Still running: a delivered stop is not a stopped child.
    expect(steerField()).not.toBeNull();
    expect(line(k.subagent_id)?.classList.contains("run")).toBe(true);
    await deliver(
      h,
      subagentEvent({ ...k, status: "interrupted", verdict: "stopped", duration_ms: 24_000 }),
    );
    await waitFor(() => expect(ack()).toBe("Stopped by you"));
    expect(steerField()).toBeNull();
    expect(dialog.querySelector(".sa-closed")?.textContent).toBe(
      "This subagent was stopped. Steering is closed.",
    );
  });

  test("an unsent steer is kept per child across switching, closing and reopening", async () => {
    const { kids } = await setup();
    await openKid(kids[1]!);
    await userEvent.type(steerField()!, "for e2e");
    // The field keeps its own arrows: the key is not taken from the caret,
    // and the child does not change.
    expect(fireEvent.keyDown(steerField()!, { key: "ArrowUp" })).toBe(true);
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(steerField());
    expect(heading()).toBe("Classify the e2e-flows failure");
    expect((steerField() as HTMLInputElement).value).toBe("for e2e");
    await userEvent.click(next());
    expect(heading()).toBe("Classify the lint failure");
    expect((steerField() as HTMLInputElement).value).toBe("");
    await userEvent.type(steerField()!, "for lint");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await openKid(kids[1]!);
    expect((steerField() as HTMLInputElement).value).toBe("for e2e");
    await userEvent.click(next());
    expect((steerField() as HTMLInputElement).value).toBe("for lint");
  });

  test("Escape closes it and puts focus back on the child's OPEN button", async () => {
    const { h, kids } = await setup();
    const aborts: unknown[] = [];
    h.api.abortTurn = (...args) => {
      aborts.push(args);
      return Promise.resolve({ aborted: true } as never);
    };
    await openKid(kids[1]!);
    await userEvent.click(next());
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    // Back to the line of the child last shown, wherever it is now.
    await waitFor(() =>
      expect((document.activeElement as HTMLElement | null)?.dataset.subagentOpen).toBe(
        kids[2]!.subagent_id,
      ),
    );
    expect(aborts).toHaveLength(0);
  });

  test("a finished child and a history child are read-only; focus lands on close", async () => {
    const h = harness();
    controls(h);
    const hist = done({ origin: "history", tool_id: "call-h", goal: "From the transcript" });
    h.history = [userTurn("u1", "go"), botTurn("b1", [delegateTool("call-h", "ok"), hist])];
    await mount(h);
    await waitFor(() => expect(line(hist.subagent_id)).not.toBeNull());
    const dialog = await openKid(hist);
    expect(steerField()).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "STOP" })).toBeNull();
    expect(dialog.querySelector(".sa-closed")?.textContent).toContain("Read from the transcript");
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close" }));
    await act(async () => {
      within(dialog).getByRole("button", { name: "Close" }).click();
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("control state that outlives its row", () => {
  test("a history row that wins over its live child keeps the child's stop, trail and open modal", async () => {
    const h = harness();
    const calls = controls(h);
    h.history = [userTurn("u1", "go"), botTurn("b1", [delegateTool("call-a", "ok")])];
    const { held } = await mount(h);
    const k = running({ tool_id: "call-a", goal: "Benchmark the volume" });
    await deliver(h, subagentEvent(k));
    await waitFor(() => expect(line(k.subagent_id)).not.toBeNull());
    const dialog = await openKid(k);
    await userEvent.click(within(dialog).getByRole("button", { name: "STOP" }));
    await waitFor(() => expect(ack()).toBe("Stop requested"));
    expect(calls.stops).toEqual([k.subagent_id]);
    await deliver(
      h,
      subagentEvent({ ...k, status: "interrupted", verdict: "stopped", duration_ms: 9_000 }),
    );
    await waitFor(() => expect(ack()).toBe("Stopped by you"));
    // The box writes the call down; history names the child synthetically and
    // knows what the live wire never carried.
    h.history = [
      userTurn("u1", "go"),
      botTurn("b1", [
        delegateTool("call-a", "ok"),
        {
          ...k,
          subagent_id: "hist:call-a:0",
          origin: "history",
          status: "interrupted",
          verdict: "stopped",
          duration_ms: 9_000,
          result: { cost_usd: 0.0042 },
        },
      ]),
    ];
    await act(async () => {
      await held.store!.reloadTranscript();
    });
    await waitFor(() => expect(screen.getByRole("dialog").querySelector(".sa-cost")).not.toBeNull());
    expect(heading()).toBe("Benchmark the volume");
    expect(ack()).toBe("Stopped by you");
    expect(line(k.subagent_id)).not.toBeNull();
  });

  test("a stop answered after a rollover lands on the retired session's child", async () => {
    const h = harness();
    controls(h);
    let answer: (aborted: boolean) => void = () => {};
    h.api.stopSubagent = (instance, bot) =>
      new Promise((resolve) => {
        answer = (aborted) => resolve({ instance, bot, aborted } as never);
      });
    const k = running({ tool_id: "call-a" });
    h.history = [userTurn("u1", "go"), botTurn("b1", [delegateTool("call-a", "ok"), k])];
    const { held } = await mount(h);
    await waitFor(() => expect(line(k.subagent_id)).not.toBeNull());
    const dialog = await openKid(k);
    await userEvent.click(within(dialog).getByRole("button", { name: "STOP" }));
    await waitFor(() => expect(ack()).toBe("Stopping…"));
    await deliver(h, rolloverTo("s2", [userTurn("n1", "after the archive")]));
    await act(async () => {
      answer(true);
    });
    // The conversation on screen never held that child.
    expect(held.store!.subagents.control.has(k.subagent_id)).toBe(false);
    await act(async () => {
      held.store!.select("atlas", "atlas", "s1");
    });
    await waitFor(() =>
      expect(held.store!.subagents.control.get(k.subagent_id)?.stop?.state).toBe("requested"),
    );
  });
});
