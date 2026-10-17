/**
 * Render isolation through the real chat store: the blocks inside settled
 * messages stay still while the store moves around them.
 *
 * `thread-render-isolation.dom.test.tsx` drives `Thread` by its props. This
 * drives it the way the app does — `ChatProvider` around `ChatView`, the
 * transcript arriving through a history read and the observation — because
 * the blocks that leaked renders were not reached through props at all: a
 * delegated child's line read the subagent scope's context, and an
 * attachment chip, a share card and a failure's recovery buttons each read the
 * whole chat value, which is rebuilt on every clock tick, roster read and
 * notification. Each now reads only its slice (`chat-select.tsx`,
 * `SubagentScope`), and each reports its renders to `renderProbe`.
 *
 * The activity group has no probe of its own; the delegated child's line is
 * drawn inside it and is not memoized, so a group that re-rendered would show
 * up as a `SubagentLine` render.
 */
import { act, cleanup, render, waitFor } from "./dom.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useEffect } from "react";
import type { ChatBlockView, ChatMessageView } from "../src/api/index.ts";
import { ChatProvider, useChat } from "../src/chat/chat-state.tsx";
import type { Chat } from "../src/chat/chat-state.tsx";
import { ChatView } from "../src/chat/components/ChatView.tsx";
import { renderProbe } from "../src/chat/render-probe.ts";
import { NotifyProvider, useNotify } from "../src/state/notify-state.tsx";
import type { Notify } from "../src/state/notify-state.tsx";
import { arrival, deliver, harness, snapshot, swarmOf } from "./chat-observe-fixtures.tsx";
import type { Harness } from "./chat-observe-fixtures.tsx";
import { fakeClock } from "./fake-clock.ts";
import { fakeInbox, notification } from "./inbox-fake.ts";
import { botTurn, delegateTool, done, subagentEvent, userTurn } from "./subagent-fixtures.tsx";

const START = Date.parse("2026-09-18T12:00:00Z");
const at = (minute: string): string => `2026-09-18T11:${minute}:00Z`;

const SHARE_ID = "sh_timeline0001";

/** A share the agent made: `share_file`, drawn as a share card. */
function shareTool(): ChatBlockView {
  const share = {
    share_id: SHARE_ID,
    name: "502-timeline.csv",
    bytes: 4_812,
    mime: "text/csv",
    sha256: "9".repeat(64),
  };
  return {
    kind: "tool",
    name: "share_file",
    tool_id: "call-share",
    args: { path: "/data/502-timeline.csv" },
    result: share,
    status: "ok",
    render: "file_share",
    share,
  } as unknown as ChatBlockView;
}

/**
 * The children carry a fixed `started_at`: a read off the wire carries the
 * box's own stamp, and a fixture stamped `Date.now()` would make every read
 * a different transcript.
 *
 * Settled messages carrying every block that used to leak: a delegated child
 * in a tool group, a staged attachment, a share card and a failure card.
 * Built fresh on every call, as a read off the wire is.
 */
function transcript(): ChatMessageView[] {
  return [
    userTurn("u1", "fan out please", at("00")),
    botTurn(
      "b1",
      [
        delegateTool("call-a", "ok"),
        done({
          subagent_id: "kid-a",
          tool_id: "call-a",
          origin: "history",
          task_count: 2,
          started_at: at("00"),
        }),
        { kind: "text", markdown: "The child came back." },
      ],
      at("01"),
    ),
    {
      ...userTurn("u2", "here is the log", at("02")),
      blocks: [
        {
          kind: "attachment",
          name: "app.log",
          mime: "text/plain",
          bytes: 12,
          href: "inbox/2026-09-18/f_applog/app.log",
          file_id: "f_applog",
        } as unknown as ChatBlockView,
        { kind: "text", markdown: "here is the log" },
      ],
    },
    botTurn("b2", [shareTool(), { kind: "text", markdown: "Shared the timeline." }], at("03")),
    userTurn("u3", "again", at("04")),
    {
      ...botTurn("b3", [{ kind: "text", markdown: "Partial" }], at("05")),
      failure: { code: "RATE_LIMITED", message: "slow down" },
    } as unknown as ChatMessageView,
  ];
}

let counts = new Map<string, number>();
function reset(): void {
  counts = new Map();
}
/** Renders since the last `reset()`, by `component:id`, with the zeros left out. */
function renders(): Record<string, number> {
  return Object.fromEntries(counts);
}

beforeEach(() => {
  reset();
  renderProbe.hit = (component, id) => {
    const key = `${component}:${id}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
});

afterEach(() => {
  renderProbe.hit = null;
  cleanup();
});

async function mount(): Promise<{
  h: Harness;
  clock: ReturnType<typeof fakeClock>;
  chat: () => Chat;
  notify: () => Notify;
}> {
  const h = harness();
  h.history = transcript();
  const clock = fakeClock(START);
  const held: { chat: Chat | null; notify: Notify | null } = { chat: null, notify: null };
  function Probe() {
    const chat = useChat();
    const notify = useNotify();
    useEffect(() => {
      held.chat = chat;
      held.notify = notify;
    });
    return null;
  }
  const inbox = fakeInbox([notification({ id: "n1", agent: "elsewhere", title: "something else" })]);
  render(
    <NotifyProvider api={inbox.api}>
      <ChatProvider api={h.api} timing={clock.timing}>
        <Probe />
        <ChatView />
      </ChatProvider>
    </NotifyProvider>,
  );
  await waitFor(() => expect(held.chat?.historyRead).toBe(true));
  await waitFor(() => expect(held.notify?.items.length).toBe(1));
  return {
    h,
    clock,
    chat: () => held.chat as Chat,
    notify: () => held.notify as Notify,
  };
}

const BLOCKS = ["SubagentLine:kid-a", "Attachment:f_applog", `ShareCard:${SHARE_ID}`, "FailureCard:b3"];

describe("blocks in settled messages do not re-render", () => {
  test("every probed block is drawn", async () => {
    await mount();
    for (const key of BLOCKS) expect(counts.get(key) ?? 0).toBeGreaterThan(0);
  });

  test("when the clock ticks", async () => {
    const { clock, chat } = await mount();
    const before = chat().now;
    reset();
    await clock.advance(30_000);
    expect(chat().now).toBeGreaterThan(before);
    expect(renders()).toEqual({ "Thread:atlas": 1 });
  });

  test("when the roster refreshes with new objects saying the same", async () => {
    const { h, chat } = await mount();
    const roster = chat().swarms;
    reset();
    h.swarms = [swarmOf("atlas")];
    await act(async () => {
      await chat().refreshSwarms({ force: true });
    });
    expect(chat().swarms).not.toBe(roster);
    for (const key of Object.keys(renders())) expect(key).toBe("Thread:atlas");
  });

  test("when a notification is read", async () => {
    const { notify } = await mount();
    reset();
    await act(async () => {
      await notify().ack("n1");
    });
    expect(notify().items[0]?.read_at).not.toBeNull();
    for (const key of Object.keys(renders())) expect(key).toBe("Thread:atlas");
  });

  test("when a message arrives", async () => {
    // A new row changes the transcript, so everything derived from it is
    // recomputed: the subagent scope's results map among them, which every
    // child's line reads through context.
    const { h, chat } = await mount();
    reset();
    // From the operator, sent elsewhere: a bot reply would rightly re-render
    // the failure card, which only the latest failure's offers Retry on.
    await deliver(h, arrival(userTurn("u4", "one more thing", at("06"))));
    expect(chat().messages.at(-1)?.id).toBe("u4");
    expect(renders()).toEqual({ "Thread:atlas": 1, "Row:u4": 1, "Message:u4": 1 });
  });

  test("when a snapshot and a history read deliver the same rows again", async () => {
    const { h, chat } = await mount();
    const held = chat().messages;
    reset();
    await deliver(h, snapshot(transcript()));
    h.history = transcript();
    await act(async () => {
      await chat().reloadHistory();
    });
    expect(chat().messages).toBe(held);
    for (const key of Object.keys(renders())) expect(key).toBe("Thread:atlas");
  });
});

describe("a store write site keeps identity after placing children back", () => {
  test("snapshot and history read: reapplySubagents, then reuseMessages", async () => {
    const { h, chat } = await mount();
    // A child observed after its turn lands on the turn that dispatched it.
    await deliver(h, {
      ...subagentEvent(
        done({
          subagent_id: "kid-b",
          tool_id: "call-a",
          origin: "live",
          task_index: 1,
          task_count: 2,
          started_at: at("00"),
        }),
      ),
      session: "s1",
    } as never);
    const placed = chat().messages.find((m) => m.id === "b1");
    expect(placed?.blocks.some((b) => b.kind === "subagent" && b.subagent_id === "kid-b")).toBe(true);
    const others = chat().messages.filter((m) => m.id !== "b1");
    reset();
    // The box's rows do not carry the observed child; the store places it
    // back on every replacement, which builds the row anew each time.
    await deliver(h, snapshot(transcript()));
    expect(chat().messages.find((m) => m.id === "b1")).toBe(placed);
    h.history = transcript();
    await act(async () => {
      await chat().reloadHistory();
    });
    expect(chat().messages.find((m) => m.id === "b1")).toBe(placed);
    for (const m of others) expect(chat().messages.find((x) => x.id === m.id)).toBe(m);
    for (const key of Object.keys(renders())) expect(key).toBe("Thread:atlas");
  });
});
