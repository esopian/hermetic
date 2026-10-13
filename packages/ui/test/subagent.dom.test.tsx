/**
 * Delegated children inline (WI-14, Option C): one line per child under its
 * `delegate_task` step, and how the store lands a child observed after (or
 * beside) its turn.
 *
 * The line states are drawn through the real `Thread`, which provides the
 * subagent scope; the routing cases go through the real provider and its
 * observation fan-in (`chat-observe-fixtures.tsx`), because "the row moves in
 * the turn that holds it, not the latest one" is a statement about the store.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render, screen, userEvent, waitFor, within } from "./dom.ts";
import type { ChatBlockView, ChatMessageView } from "../src/api/index.ts";
import { Thread } from "../src/chat/components/Thread.tsx";
import { deliver, harness, mount } from "./chat-observe-fixtures.tsx";
import {
  botTurn,
  delegateTool,
  done,
  failed,
  freshId,
  kid,
  line,
  lines,
  rolloverTo,
  running,
  subagentEvent,
  userTurn,
} from "./subagent-fixtures.tsx";

afterEach(() => {
  cleanup();
});

function thread(messages: ChatMessageView[], live: ChatMessageView | null = null) {
  return render(
    <Thread
      fleetId="fleet"
      instance="silent-crane"
      bot="default"
      agent={null}
      session={null}
      destination={{ state: "known", origin: "portal", detail: null }}
      state="ready"
      messages={messages}
      live={live}
      sending={live !== null}
      activity={live ? "thinking" : "idle"}
      historyError={null}
      now={Date.now()}
      onSend={() => {}}
      onAbort={() => {}}
    />,
  );
}

const turn = (...blocks: ChatBlockView[]) => [userTurn("u1", "fan out"), botTurn("b1", blocks)];
const text = (el: Element | null) => el?.textContent ?? "";

describe("a child's line", () => {
  test("running: the latest tool call, a live timer, the accent rule and OPEN", () => {
    const k = running({
      tools: [
        { name: "read_file", preview: "/etc/fstab" },
        { name: "terminal", preview: "iotop -b" },
      ],
      tool_count: 2,
    });
    thread(turn(delegateTool(), k));
    const row = line(k.subagent_id)!;
    expect(row.classList.contains("run")).toBe(true);
    expect(row.querySelector(".sa-glyph")?.getAttribute("aria-label")).toBe("running");
    expect(text(row.querySelector(".sa-act"))).toBe("↳ terminal iotop -b");
    expect(text(row.querySelector(".sa-time"))).toMatch(/^0:1\d$/);
    expect(row.querySelector(".sa-time")?.classList.contains("live")).toBe(true);
    expect(
      within(row).getByRole("button", { name: /Open subagent: Survey disk I\/O/ }).textContent,
    ).toBe("OPEN ↗");
    // The full goal stays reachable however narrow the column gets.
    expect(row.querySelector(".sa-goal")?.getAttribute("title")).toBe(k.goal);
  });

  test("finished: the summary's first line and a settled duration", () => {
    const k = done();
    thread(turn(delegateTool("call-delegate", "ok"), k));
    const row = line(k.subagent_id)!;
    expect(row.classList.contains("run")).toBe(false);
    expect(text(row.querySelector(".sa-act.summary"))).toBe(
      "Flaky. poller.test.ts depends on file order.",
    );
    expect(text(row.querySelector(".sa-time"))).toBe("22s");
  });

  test("failed live reads the summary; failed from history reads failure_reason", () => {
    const live = failed();
    const hist = failed({
      origin: "history",
      task_index: 1,
      summary: "partial notes",
      result: { failure_reason: "max_iterations: the child ran out of turns" },
    });
    thread(turn(delegateTool("call-delegate", "ok"), live, hist));
    expect(line(live.subagent_id)?.classList.contains("bad")).toBe(true);
    expect(text(line(live.subagent_id)!.querySelector(".sa-act.error"))).toBe(
      "Could not finish: the flows suite needs the devkit",
    );
    expect(text(line(hist.subagent_id)!.querySelector(".sa-act.error"))).toBe(
      "max_iterations: the child ran out of turns",
    );
  });

  test("unobserved says results come with the next turn, and never reads as success", () => {
    const k = kid({ status: "unobserved", verdict: "unknown" });
    thread(turn(delegateTool("call-delegate", "ok"), k));
    const row = line(k.subagent_id)!;
    expect(text(row.querySelector(".sa-act"))).toBe(
      "no longer observable — results arrive with the next turn",
    );
    expect(row.querySelector(".sa-glyph")?.getAttribute("aria-label")).toBe("unobserved");
    expect(row.classList.contains("bad")).toBe(false);
  });

  test("a dispatched background row is not failed, and links to its results turn", () => {
    const k = kid({
      status: "dispatched",
      verdict: "running",
      origin: "history",
      delegation_id: "dlg-7",
    });
    const results = botTurn("results", [
      {
        kind: "process_event",
        event: "delegation",
        outcome: "ok",
        delegation: { id: "dlg-7", batch: false, total: 1, succeeded: 1, tasks: [] },
      } as unknown as ChatBlockView,
    ]);
    thread([...turn(delegateTool("call-delegate", "ok"), k), results]);
    const row = line(k.subagent_id)!;
    expect(row.classList.contains("bad")).toBe(false);
    expect(row.classList.contains("run")).toBe(false);
    expect(text(row.querySelector(".sa-act"))).toContain("dispatched in the background");
    expect(within(row).getByRole("button", { name: "result ↓" })).toBeTruthy();
  });

  test("a grandchild is flattened under its parent with a depth tag", () => {
    const parent = running();
    const grand = running({
      depth: 1,
      parent_id: parent.subagent_id,
      tool_id: undefined,
      goal: "Read the CI log",
    });
    thread(turn(delegateTool(), parent, grand));
    const order = lines().map((el) => el.dataset.subagentId);
    expect(order).toEqual([parent.subagent_id, grand.subagent_id]);
    expect(text(line(grand.subagent_id)!.querySelector(".sa-depth"))).toBe("depth 2");
    expect(line(parent.subagent_id)!.querySelector(".sa-depth")).toBeNull();
  });
});

describe("a delegation", () => {
  test("several tasks get one header; the lines sit under the delegate_task step", () => {
    const a = done({ task_index: 0, task_count: 3 });
    const b = running({ task_index: 1, task_count: 3 });
    const c = running({ task_index: 2, task_count: 3 });
    thread(turn(delegateTool(), c, a, b));
    const head = document.querySelector(".sa-head")!;
    expect(text(head.querySelector(".sa-head-t"))).toBe("Delegated 3 tasks");
    expect(text(head.querySelector(".sa-head-f"))).toMatch(/^1 of 3 done · \d:\d\d$/);
    expect(lines().map((el) => el.dataset.subagentId)).toEqual([
      a.subagent_id,
      b.subagent_id,
      c.subagent_id,
    ]);
    // Under the call, inside the open run group.
    const step = document.querySelector(".ch-activity-step");
    expect(step?.parentElement?.nextElementSibling?.querySelector(".sa-group")).not.toBeNull();
    expect((document.querySelector(".ch-activity") as HTMLDetailsElement).open).toBe(true);
    expect(text(document.querySelector(".ch-activity > summary"))).toContain(
      "Waiting on 2 of 3 subagents",
    );
  });

  test("a child not tied to a drawn call sits at the end of the group", () => {
    const loose = running({ tool_id: "call-elsewhere" });
    thread(
      turn(delegateTool("call-delegate", "ok"), loose, {
        kind: "tool",
        name: "terminal",
        tool_id: "t2",
        status: "ok",
        args: {},
        result: null,
        render: "terminal",
      } as unknown as ChatBlockView),
    );
    const items = Array.from(document.querySelectorAll(".ch-activity-list > li"));
    expect(
      items[items.length - 1]?.querySelector(`[data-subagent-id="${loose.subagent_id}"]`),
    ).not.toBeNull();
  });
});

describe("drawing", () => {
  test("a live line fades in on its first draw only, never on a re-mount", () => {
    const k = running();
    const messages = turn(delegateTool(), k);
    const first = thread(messages);
    expect(line(k.subagent_id)?.classList.contains("sa-enter")).toBe(true);
    first.unmount();
    thread(messages);
    expect(line(k.subagent_id)?.classList.contains("sa-enter")).toBe(false);
  });

  test("a history line never fades in", () => {
    const k = done({ origin: "history" });
    thread(turn(delegateTool("call-delegate", "ok"), k));
    expect(line(k.subagent_id)?.classList.contains("sa-enter")).toBe(false);
  });
});

describe("the modal from a line", () => {
  test("OPEN opens the child's run; cost shows only when history carried cost_usd", async () => {
    const priced = done({
      origin: "history",
      task_index: 0,
      task_count: 2,
      result: { cost_usd: 0.0123 },
    });
    const live = done({ task_index: 1, task_count: 2 });
    thread(turn(delegateTool("call-delegate", "ok"), priced, live));
    await userEvent.click(
      within(line(priced.subagent_id)!).getByRole("button", { name: /Open subagent/ }),
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector(".sa-cost")?.textContent).toBe(" · $0.0123");
    await userEvent.click(within(dialog).getByRole("button", { name: "Next subagent" }));
    expect(screen.getByRole("dialog").querySelector(".sa-cost")).toBeNull();
    expect(screen.getByRole("dialog").querySelector(".sa-rollup")?.textContent).toContain(
      "22s · 4 tools",
    );
  });
});

/* ── the store: where an observed child lands ─────────────────────────── */

describe("an observed child", () => {
  test("updates its row in the turn that holds it, even when a later turn exists", async () => {
    const h = harness();
    const k = running({ tool_id: "call-a" });
    h.history = [
      userTurn("u1", "fan out"),
      botTurn("b1", [delegateTool("call-a", "ok"), k, { kind: "text", markdown: "Dispatched." }]),
      userTurn("u2", "and now something else"),
      botTurn("b2", [{ kind: "text", markdown: "A later answer." }]),
    ];
    await mount(h);
    await waitFor(() => expect(line(k.subagent_id)).not.toBeNull());
    await deliver(
      h,
      subagentEvent({
        ...k,
        tools: [...k.tools, { name: "terminal", preview: "iotop -b -n 1" }],
        tool_count: 2,
      }),
    );
    await waitFor(() =>
      expect(text(line(k.subagent_id)!.querySelector(".sa-act"))).toBe("↳ terminal iotop -b -n 1"),
    );
    // One row, in the first turn — not a copy appended to the latest one.
    expect(lines()).toHaveLength(1);
    const article = line(k.subagent_id)!.closest("article")!;
    expect(article.getAttribute("data-chat-ids")).toContain("b1");
  });

  test("keeps running inside a finished turn, then settles there", async () => {
    const h = harness();
    const k = running({ tool_id: "call-a" });
    h.history = [
      userTurn("u1", "go"),
      botTurn("b1", [delegateTool("call-a", "ok"), k, { kind: "text", markdown: "Done for now." }]),
    ];
    await mount(h);
    await waitFor(() => expect(line(k.subagent_id)?.classList.contains("run")).toBe(true));
    await deliver(
      h,
      subagentEvent({
        ...k,
        status: "completed",
        verdict: "done",
        summary: "All quiet.",
        duration_ms: 30_000,
      }),
    );
    await waitFor(() => expect(text(line(k.subagent_id)!.querySelector(".sa-act"))).toBe("All quiet."));
    expect(line(k.subagent_id)?.classList.contains("run")).toBe(false);
    // A late frame never moves a settled child backwards.
    await deliver(h, subagentEvent({ ...k, tool_count: 5 }));
    expect(text(line(k.subagent_id)!.querySelector(".sa-act"))).toBe("All quiet.");
  });

  test("a child new to this browser lands on its call's turn, else the latest turn", async () => {
    const h = harness();
    h.history = [
      userTurn("u1", "go"),
      botTurn("b1", [delegateTool("call-a", "ok"), { kind: "text", markdown: "Dispatched." }]),
      userTurn("u2", "next"),
      botTurn("b2", [{ kind: "text", markdown: "Later." }]),
    ];
    await mount(h);
    const owned = running({ subagent_id: freshId(), tool_id: "call-a" });
    const stray = running({ subagent_id: freshId(), tool_id: "call-unknown" });
    await deliver(h, subagentEvent(owned));
    await deliver(h, subagentEvent(stray));
    await waitFor(() => expect(lines()).toHaveLength(2));
    expect(line(owned.subagent_id)!.closest("article")!.getAttribute("data-chat-ids")).toContain("b1");
    expect(line(stray.subagent_id)!.closest("article")!.getAttribute("data-chat-ids")).toContain("b2");
  });

  test("a history stand-in for the same task is replaced, not drawn beside", async () => {
    const h = harness();
    const handle = kid({
      subagent_id: "hist:call-a:0",
      status: "dispatched",
      verdict: "running",
      origin: "history",
      tool_id: "call-a",
      delegation_id: "dlg-1",
    });
    h.history = [userTurn("u1", "go"), botTurn("b1", [delegateTool("call-a", "ok"), handle])];
    await mount(h);
    await waitFor(() => expect(lines()).toHaveLength(1));
    const live = running({ tool_id: "call-a", delegation_id: "dlg-1" });
    await deliver(h, subagentEvent(live));
    await waitFor(() => expect(line(live.subagent_id)).not.toBeNull());
    expect(lines()).toHaveLength(1);
  });
});

describe("an observed child after the conversation moved on", () => {
  test("a late child of a retired session never lands in the session that replaced it", async () => {
    const h = harness();
    h.history = [
      userTurn("u1", "go"),
      botTurn("b1", [delegateTool("call-a", "ok"), { kind: "text", markdown: "Dispatched." }]),
    ];
    await mount(h);
    // The conversation is archived and replaced: a rollover to `s2`.
    await deliver(h, {
      type: "snapshot",
      instance: "atlas",
      bot: "atlas",
      session: "s2",
      messages: [
        userTurn("n1", "fresh start"),
        botTurn("n2", [{ kind: "text", markdown: "Hello again." }]),
      ],
      at: new Date().toISOString(),
    } as unknown as Parameters<typeof deliver>[1]);
    await waitFor(() => expect(screen.queryByText("Hello again.")).not.toBeNull());
    const late = running({ tool_id: "call-a" });
    await deliver(h, subagentEvent(late, "s1"));
    expect(lines()).toHaveLength(0);
    // A child of the conversation on screen still lands.
    const current = running({ tool_id: "call-x" });
    await deliver(h, subagentEvent(current, "s2"));
    await waitFor(() => expect(line(current.subagent_id)).not.toBeNull());
    expect(lines()).toHaveLength(1);
  });

  test("a re-read after the turn keeps a running child's live state over history's handle", async () => {
    const h = harness();
    let turn: Parameters<typeof h.api.sendTurn>[3] | null = null;
    h.api.sendTurn = (_instance, _bot, _message, handlers) => {
      turn = handlers;
      return () => {};
    };
    const mounted = await mount(h);
    const k = running({
      tool_id: "call-bg",
      tools: [
        { name: "terminal", preview: "iostat -x 1 3" },
        { name: "terminal", preview: "iotop -b -n 1" },
      ],
      tool_count: 2,
    });
    await act(async () => {
      mounted.held.store!.send("E2E_SUBAGENT_BACKGROUND");
    });
    await waitFor(() => expect(turn).not.toBeNull());
    // What the box records for that turn: the call, with history's handle for the child.
    h.history = [
      userTurn("u1", "E2E_SUBAGENT_BACKGROUND"),
      botTurn("b1", [
        delegateTool("call-bg", "ok"),
        {
          ...k,
          status: "dispatched",
          verdict: "running",
          origin: "history",
          tools: [],
          tool_count: 0,
          started_at: undefined,
        },
        { kind: "text", markdown: "Dispatched." },
      ]),
    ];
    await act(async () => {
      turn!.onFrame({
        type: "block",
        seq: 1,
        message: "live-1",
        block: delegateTool("call-bg", "running"),
      });
      turn!.onFrame({ type: "block", seq: 2, message: "live-1", block: k });
      turn!.onFrame({ type: "done", seq: 3, message: "live-1" });
      turn!.onEnd(true, null);
    });
    // The re-read has replaced the live message with the box's rows.
    await waitFor(() =>
      expect(line(k.subagent_id)?.closest("article")?.getAttribute("data-chat-ids")).toContain("b1"),
    );
    const row = line(k.subagent_id)!;
    expect(row.classList.contains("run")).toBe(true);
    expect(row.querySelector(".sa-act")?.textContent).toBe("↳ terminal iotop -b -n 1");
    expect(lines()).toHaveLength(1);
  });
});

describe("a child on the turn's own frames", () => {
  /** A harness whose turns are driven by hand. */
  async function driven(history: ChatMessageView[]) {
    const h = harness();
    h.history = history;
    const turn: { handlers: Parameters<typeof h.api.sendTurn>[3] | null } = { handlers: null };
    h.api.sendTurn = (_instance, _bot, _message, handlers) => {
      turn.handlers = handlers;
      return () => {};
    };
    const mounted = await mount(h);
    await act(async () => {
      mounted.held.store!.send("delegate this");
    });
    await waitFor(() => expect(turn.handlers).not.toBeNull());
    return { h, turn: turn.handlers!, held: mounted.held };
  }

  test("a frame older than an observed copy still draws the child, at its newer state", async () => {
    const { h, turn } = await driven([userTurn("u0", "hello")]);
    const k = running({ tool_id: "call-new" });
    // Observed first, while the turn has drawn nothing it could land on.
    await deliver(
      h,
      subagentEvent({
        ...k,
        tools: [...k.tools, { name: "terminal", preview: "iotop -b" }],
        tool_count: 2,
      }),
    );
    expect(lines()).toHaveLength(0);
    await act(async () => {
      turn.onFrame({ type: "block", seq: 1, message: "live-1", block: delegateTool("call-new") });
      turn.onFrame({ type: "block", seq: 2, message: "live-1", block: k });
    });
    await waitFor(() => expect(line(k.subagent_id)).not.toBeNull());
    expect(line(k.subagent_id)!.querySelector(".sa-act")?.textContent).toBe("↳ terminal iotop -b");
  });

  test("a late running frame never undoes a child history has settled", async () => {
    const { h, turn } = await driven([userTurn("u0", "hello")]);
    const k = running({ tool_id: "call-s" });
    await act(async () => {
      turn.onFrame({ type: "block", seq: 1, message: "live-1", block: delegateTool("call-s") });
      turn.onFrame({ type: "block", seq: 2, message: "live-1", block: k });
    });
    await waitFor(() => expect(line(k.subagent_id)?.classList.contains("run")).toBe(true));
    // The box's own record of the turn arrives with the child settled, under
    // history's synthetic id and with the cost the live wire never carries.
    await deliver(
      h,
      rolloverTo("s1", [
        userTurn("u0", "hello"),
        botTurn("live-1", [
          delegateTool("call-s", "ok"),
          {
            ...k,
            subagent_id: "hist:call-s:0",
            origin: "history",
            status: "completed",
            verdict: "done",
            summary: "All quiet.",
            duration_ms: 30_000,
            result: { cost_usd: 0.0031 },
          },
        ]),
      ]),
    );
    await waitFor(() => expect(line(k.subagent_id)?.dataset.verdict).toBe("done"));
    // A frame of the same turn, delayed past that read.
    await act(async () => {
      turn.onFrame({
        type: "block",
        seq: 3,
        message: "live-1",
        block: { ...k, tools: [...k.tools, { name: "terminal", preview: "late" }], tool_count: 2 },
      });
    });
    expect(lines().every((el) => el.dataset.verdict === "done")).toBe(true);
    expect(document.querySelector(".sa-line.run")).toBeNull();
    await userEvent.click(within(line(k.subagent_id)!).getByRole("button", { name: /Open subagent/ }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector(".sa-cost")?.textContent).toBe(" · $0.0031");
    expect(within(dialog).queryByRole("button", { name: "STOP" })).toBeNull();
    expect(within(dialog).queryByRole("textbox", { name: "Steer this subagent" })).toBeNull();
  });

  test("a mid-turn rollover takes the retired session's children off the live message", async () => {
    const { h, turn } = await driven([userTurn("u0", "hello")]);
    const k = running({ tool_id: "call-r" });
    await act(async () => {
      turn.onFrame({ type: "block", seq: 1, message: "live-1", block: delegateTool("call-r") });
      turn.onFrame({ type: "block", seq: 2, message: "live-1", block: k });
    });
    await waitFor(() => expect(line(k.subagent_id)).not.toBeNull());
    await deliver(h, rolloverTo("s2", [userTurn("n1", "after the archive")]));
    await waitFor(() => expect(lines()).toHaveLength(0));
  });
});
