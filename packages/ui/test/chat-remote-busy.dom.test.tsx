/**
 * A turn this tab did not start (`chat-remote-busy.ts`).
 *
 * Hermes Desktop, the CLI, a routine or another window can be running a turn
 * in the conversation on screen. The observation says so with a `busy` event,
 * and from then on the thread treats it as running: Enter queues behind it,
 * ⌘Enter steers it, the queue drains when the box says it is idle, and every
 * send carries `queued: true` so a send that races the probe can never become
 * an implicit steer. A tool call at the transcript's tail reads by the same
 * signal — running, stopped or unknown, never "needs attention".
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "./dom.ts";
import { afterEach, describe, expect, test } from "bun:test";
import type { ChatMessageView, ChatObserveView, ChatSteerResult } from "../src/api/index.ts";
import { ATLAS, arrival, deliver, harness, messageOf, mount } from "./chat-observe-fixtures.tsx";
import type { Harness } from "./chat-observe-fixtures.tsx";
import { sendable } from "./chat-fixtures.tsx";
import { Thread } from "../src/chat/components/Thread.tsx";

afterEach(cleanup);

function busy(value: boolean | null, session: string | null = "s1"): ChatObserveView {
  return {
    type: "busy",
    instance: ATLAS.instance,
    bot: ATLAS.bot,
    session,
    busy: value,
    at: new Date().toISOString(),
  } as unknown as ChatObserveView;
}

/** The observe harness, recording each send's options and answering steers. */
function recording(steer: ChatSteerResult["status"] = "redirected") {
  const h = harness();
  const sends: Array<{ text: string; opts: { session?: string; queued?: boolean } }> = [];
  const steered: string[] = [];
  let aborts = 0;
  const base = h.api.sendTurn;
  h.api.sendTurn = (instance, bot, text, handlers, opts = {}) => {
    sends.push({ text, opts });
    return base(instance, bot, text, handlers, opts);
  };
  h.api.steerTurn = async (instance, bot, text) => {
    steered.push(text);
    return { instance, bot, status: steer };
  };
  h.api.abortTurn = async (instance, bot) => {
    aborts += 1;
    return { instance, bot, aborted: true } as never;
  };
  return {
    h,
    sends,
    steered,
    get aborts() {
      return aborts;
    },
  };
}

async function open(h: Harness) {
  const view = await mount(h);
  const input = await sendable(view.container);
  const say = (text: string, now = false) => {
    fireEvent.change(input, { target: { value: text } });
    fireEvent.keyDown(input, { key: "Enter", ...(now ? { metaKey: true } : {}) });
  };
  const rows = () => view.container.querySelectorAll(".ch-queue-row");
  return { ...view, input, say, rows };
}

describe("a turn the box reports, started elsewhere", () => {
  test("Enter queues behind it, the composer says the agent is working, and no Stop is offered", async () => {
    const r = recording();
    const v = await open(r.h);
    await deliver(r.h, busy(true));
    expect(v.held.store?.remoteBusy).toBe(true);
    expect(screen.getByText("agent is working")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop turn" })).toBeNull();

    v.say("after you");
    await waitFor(() => expect(v.rows()).toHaveLength(1));
    expect(r.sends).toEqual([]);
  });

  test("the queue drains once the box says it is idle, sent with queued: true", async () => {
    const r = recording();
    const v = await open(r.h);
    await deliver(r.h, busy(true));
    v.say("after you");
    await waitFor(() => expect(v.rows()).toHaveLength(1));

    // A repeat of what is held changes nothing.
    await deliver(r.h, busy(true));
    expect(r.sends).toEqual([]);

    await deliver(r.h, busy(false));
    await waitFor(() => expect(r.sends).toHaveLength(1));
    expect(r.sends[0]).toEqual({ text: "after you", opts: { session: "s1", queued: true } });
    expect(v.rows()).toHaveLength(0);
  });

  test("an ordinary send on an idle conversation also carries queued: true", async () => {
    const r = recording();
    const v = await open(r.h);
    v.say("hello");
    await waitFor(() => expect(r.sends).toHaveLength(1));
    expect(r.sends[0]?.opts.queued).toBe(true);
  });

  test("⌘Enter steers the running turn, and the placeholder is drawn as a steer", async () => {
    const r = recording("redirected");
    const v = await open(r.h);
    await deliver(r.h, busy(true));
    v.say("try the other branch", true);
    await waitFor(() => expect(r.steered).toEqual(["try the other branch"]));
    expect(r.sends).toEqual([]);
    await waitFor(() => expect(v.container.querySelector(".ch-msg.me.steered")).not.toBeNull());
    expect(screen.getByText("Steered")).toBeTruthy();

    // The box's own row for it, text unwrapped by core, replaces the
    // placeholder rather than drawing the prompt twice, and looks the same.
    await deliver(
      r.h,
      arrival(
        messageOf({
          id: "steer-row",
          role: "user",
          steered: true,
          blocks: [{ kind: "text", markdown: "try the other branch" }],
        }),
      ),
    );
    const steers = v.container.querySelectorAll(".ch-msg.me.steered");
    expect(steers).toHaveLength(1);
    expect(steers[0]?.getAttribute("data-chat-message")).toBe("steer-row");
    expect(screen.getAllByText("try the other branch")).toHaveLength(1);
  });

  test("a steer the box refuses waits in the queue; the turn it did not start is never stopped", async () => {
    const r = recording("rejected");
    const v = await open(r.h);
    await deliver(r.h, busy(true));
    v.say("try the other branch", true);
    await waitFor(() => expect(r.steered).toHaveLength(1));
    await waitFor(() => expect(v.rows()).toHaveLength(1));
    expect(r.aborts).toBe(0);
    expect(r.sends).toEqual([]);

    await deliver(r.h, busy(false));
    await waitFor(() => expect(r.sends.map((s) => s.text)).toEqual(["try the other branch"]));
  });

  test("a steer answered idle releases the queue at once", async () => {
    const r = recording("idle");
    const v = await open(r.h);
    await deliver(r.h, busy(true));
    v.say("anyone there", true);
    await waitFor(() => expect(r.sends.map((s) => s.text)).toEqual(["anyone there"]));
    expect(r.sends[0]?.opts.queued).toBe(true);
    expect(r.aborts).toBe(0);
    expect(v.rows()).toHaveLength(0);
  });

  test("a watch that ends, or a feed that drops, forgets the last probe and frees the queue", async () => {
    const r = recording();
    const v = await open(r.h);
    await deliver(r.h, busy(true));
    v.say("after you");
    await waitFor(() => expect(v.rows()).toHaveLength(1));

    await deliver(r.h, {
      type: "error",
      instance: ATLAS.instance,
      bot: ATLAS.bot,
      session: "s1",
      code: "OBSERVE_FAILED",
      message: "gone",
    } as unknown as ChatObserveView);
    expect(v.held.store?.remoteBusy).toBeNull();
    await waitFor(() => expect(r.sends.map((s) => s.text)).toEqual(["after you"]));
  });

  test("the fan-in socket dropping makes the busy state unknown", async () => {
    const r = recording();
    const v = await open(r.h);
    await deliver(r.h, busy(true));
    await act(async () => r.h.streams[0]?.onConnected(false));
    expect(v.held.store?.remoteBusy).toBeNull();
  });

  test("a probe for a session this conversation is not on is ignored", async () => {
    const r = recording();
    const v = await open(r.h);
    await deliver(r.h, busy(true, "s-other"));
    expect(v.held.store?.remoteBusy).toBeNull();
  });

  test("this tab's own turn ending reads as idle until the box says otherwise", async () => {
    const r = recording();
    const h = r.h;
    let end: ((ok: boolean, error: null) => void) | null = null;
    const base = h.api.sendTurn;
    h.api.sendTurn = (instance, bot, text, handlers, opts) => {
      end = handlers.onEnd as never;
      return base(instance, bot, text, handlers, opts);
    };
    const v = await open(h);
    v.say("mine");
    await waitFor(() => expect(v.held.store?.sending).toBe(true));
    await deliver(h, busy(true));
    await act(async () => end?.(true, null));
    await waitFor(() => expect(v.held.store?.sending).toBe(false));
    expect(v.held.store?.remoteBusy).toBe(false);
  });
});

/* ── a tool call at the tail, with no result yet ──────────────────────────── */

function tailTurn(status: "running" | "warn"): ChatMessageView[] {
  return [
    messageOf({ id: "u1", role: "user", blocks: [{ kind: "text", markdown: "run the build" }] }),
    messageOf({
      id: "b1",
      blocks: [
        {
          kind: "tool",
          tool_id: "call-1",
          name: "terminal",
          args: { command: "make" },
          result: null,
          status,
        },
      ],
    }),
  ];
}

function thread(messages: ChatMessageView[], remoteBusy: boolean | null) {
  return render(
    <Thread
      fleetId="f"
      instance="atlas"
      bot="atlas"
      agent={null}
      session={null}
      destination={{ state: "known", origin: "portal", detail: null }}
      state="ready"
      messages={messages}
      live={null}
      sending={false}
      remoteBusy={remoteBusy}
      historyError={null}
      now={Date.now()}
      onSend={() => {}}
      onAbort={() => {}}
    />,
  );
}

describe("a tool call at the tail with no result", () => {
  test.each([
    [true, "Running", "Working…"],
    [false, "Stopped", "Activity stopped"],
    [null, "No result yet", "No result yet"],
  ] as const)("remoteBusy %p reads %p", (remoteBusy, step, summary) => {
    const { container } = thread(tailTurn("running"), remoteBusy);
    const text = container.textContent ?? "";
    expect(container.querySelector(".ch-activity-step summary")?.textContent).toContain(step);
    expect(container.querySelector(".ch-activity > summary")?.textContent).toContain(summary);
    expect(text).not.toContain("Needs attention");
    // The opened step's result agrees with its heading.
    const detail = container.querySelector(".ch-activity-detail")?.textContent ?? "";
    if (remoteBusy === true) expect(detail).toContain("running on the box");
    else {
      expect(detail).not.toContain("running on the box");
      expect(detail).toContain("no result recorded");
    }
  });

  test("an abandoned call (warn) still needs attention", () => {
    const { container } = thread(tailTurn("warn"), true);
    expect(container.querySelector(".ch-activity-step summary")?.textContent).toContain(
      "Needs attention",
    );
  });

  test("a call that is not the newest bot turn keeps the old reading", () => {
    const ask = messageOf({
      id: "u2",
      role: "user",
      at: new Date(Date.now() + 1000).toISOString(),
      blocks: [{ kind: "text", markdown: "and now?" }],
    });
    const later = messageOf({
      id: "b2",
      at: new Date(Date.now() + 2000).toISOString(),
      blocks: [{ kind: "text", markdown: "the build is done" }],
    });
    const { container } = thread([...tailTurn("running"), ask, later], true);
    expect(container.querySelector(".ch-activity-step summary")?.textContent).toContain("Stopped");
  });

  test("an observed stale running card and its later result draw one step", () => {
    const result = messageOf({
      id: "t1",
      role: "system",
      at: new Date(Date.now() + 500).toISOString(),
      blocks: [
        {
          kind: "tool",
          tool_id: "call-1",
          name: "terminal",
          args: { command: "make" },
          result: "ok",
          status: "ok",
        },
      ],
    });
    const { container } = thread([...tailTurn("running"), result], true);
    const steps = container.querySelectorAll(".ch-activity-step");
    expect(steps).toHaveLength(1);
    expect(steps[0]?.textContent).toContain("Complete");
  });
});
