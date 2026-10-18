/**
 * Render isolation in the transcript: an unchanged message is not drawn again.
 *
 * Measured before this existed: some 290k changed-props re-renders in a
 * quarter hour of chat, nearly all of them messages that had not changed —
 * every row of the transcript re-rendered on every streaming delta, every
 * appended message, every poll that brought the same rows back, every 30 s
 * clock tick, every roster refresh and every notification. Each of those is a
 * trigger below, and for each the count of `Message` renders of the messages
 * it did not touch must be zero.
 *
 * Renders are counted through `renderProbe` (`src/chat/render-probe.ts`),
 * which `Thread`, each transcript row and `Message` report to. The thread's
 * own count confirms each trigger did reach it — a zero for the messages is
 * only worth something if the thread itself rendered.
 */
import { act, cleanup, render } from "./dom.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useEffect } from "react";
import type { ComponentProps } from "react";
import type { AgentView, ChatBlockView, ChatMessageView } from "../src/api/index.ts";
import { Thread } from "../src/chat/components/Thread.tsx";
import { renderProbe } from "../src/chat/render-probe.ts";
import { reuseMessages } from "../src/chat/chat-message-identity.ts";
import { clearMarkdownCache, markdownCacheStats } from "../src/chat/markdown-cache.ts";
import { NotifyProvider, useNotify } from "../src/state/notify-state.tsx";
import type { Notify } from "../src/state/notify-state.tsx";
import { fakeInbox, notification } from "./inbox-fake.ts";

const NOW = Date.parse("2026-09-17T12:00:00Z");
const TEAM = [
  { instance: "atlas", name: "default", title: "Atlas", is_default: true },
  { instance: "atlas", name: "scout", title: "Scout" },
];

function msg(
  id: string,
  role: "user" | "bot",
  at: string,
  blocks: ChatBlockView[] | string,
): ChatMessageView {
  return {
    id,
    session: "s1",
    role,
    author: null,
    at,
    blocks: typeof blocks === "string" ? [{ kind: "text", markdown: blocks }] : blocks,
    usage: null,
    error: null,
    incomplete: null,
  } as unknown as ChatMessageView;
}

/** A transcript of distinct texts, with markdown and math worth caching. */
function transcript(): ChatMessageView[] {
  return [
    msg("u1", "user", "2026-09-17T11:00:00Z", "how is the disk?"),
    msg("b1", "bot", "2026-09-17T11:00:05Z", "**Fine.** `/data` is at 41%, and $x^2$ holds."),
    msg("u2", "user", "2026-09-17T11:01:00Z", "and the logs?"),
    msg("b2", "bot", "2026-09-17T11:01:05Z", "- one\n- two\n\n$$\\int_0^1 x\\,dx$$"),
    msg("u3", "user", "2026-09-17T11:02:00Z", "thanks"),
    msg("b3", "bot", "2026-09-17T11:02:05Z", "Any time. See [the docs](https://example.com)."),
  ];
}
const DISTINCT_BOT_TEXTS = 3;

function agentOf(): AgentView {
  return {
    name: "atlas",
    display_status: "ready",
    tailscale_dns_name: "atlas.tail.ts.net",
    volume_id: null,
    last_heartbeat: "2026-09-17T11:59:00Z",
  } as unknown as AgentView;
}

type ThreadProps = ComponentProps<typeof Thread>;

function props(over: Partial<ThreadProps> = {}): ThreadProps {
  return {
    fleetId: "fxtr0001",
    instance: "atlas",
    bot: "default",
    botTitle: "Atlas",
    agent: agentOf(),
    session: null,
    destination: { state: "known", origin: "portal", detail: null },
    state: "ready",
    messages: transcript(),
    live: null,
    sending: false,
    historyError: null,
    now: NOW,
    onSend: () => {},
    onAbort: () => {},
    teammates: TEAM.map((bot) => ({ ...bot })),
    ...over,
  };
}

let counts = new Map<string, number>();

/** Renders of `Message` per message id since the last `reset()`. */
function messageRenders(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, n] of counts) if (key.startsWith("Message:")) out[key.slice(8)] = n;
  return out;
}
function rowRenders(): number {
  let total = 0;
  for (const [key, n] of counts) if (key.startsWith("Row:")) total += n;
  return total;
}
/** Renders of `Thread` since the last `reset()`. */
function threadRenders(): number {
  return counts.get("Thread:atlas") ?? 0;
}
function reset(): void {
  counts = new Map();
}

function view(p: ThreadProps) {
  return <Thread {...p} />;
}

beforeEach(() => {
  reset();
  clearMarkdownCache();
  renderProbe.hit = (component, id) => {
    const key = `${component}:${id}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
});

afterEach(() => {
  renderProbe.hit = null;
  cleanup();
});

describe("an unchanged message does not re-render", () => {
  test("the first render draws every message once", () => {
    render(view(props()));
    expect(messageRenders()).toEqual({ u1: 1, b1: 1, u2: 1, b2: 1, u3: 1, b3: 1 });
  });

  test("when a message is appended", () => {
    const p = props();
    const { rerender } = render(view(p));
    reset();
    const next = [...p.messages, msg("u4", "user", "2026-09-17T11:03:00Z", "one more thing")];
    rerender(view({ ...p, messages: next }));
    expect(threadRenders()).toBeGreaterThan(0);
    expect(messageRenders()).toEqual({ u4: 1 });
    expect(rowRenders()).toBe(1);
  });

  test("when a streaming delta lands on the live message", () => {
    const p = props({ sending: true, activity: "streaming" });
    const live = msg("live", "bot", "2026-09-17T11:03:05Z", "Partial ans");
    const { rerender } = render(view({ ...p, live }));
    reset();
    rerender(
      view({ ...p, live: { ...live, blocks: [{ kind: "text", markdown: "Partial answer, more" }] } }),
    );
    expect(threadRenders()).toBeGreaterThan(0);
    expect(messageRenders()).toEqual({ live: 1 });
  });

  test("when a reconcile delivers the same rows again, as new objects", () => {
    const p = props();
    const { rerender } = render(view(p));
    reset();
    // What a snapshot or a history read hands the store: the same rows, freshly
    // parsed. `reuseMessages` is what the store runs them through.
    const again = reuseMessages(p.messages, structuredClone(p.messages));
    expect(again).toBe(p.messages);
    rerender(view({ ...p, messages: again }));
    expect(messageRenders()).toEqual({});
  });

  test("when the transcript array is rebuilt around the same rows", () => {
    const p = props();
    const { rerender } = render(view(p));
    reset();
    rerender(view({ ...p, messages: [...p.messages] }));
    expect(threadRenders()).toBeGreaterThan(0);
    expect(messageRenders()).toEqual({});
    expect(rowRenders()).toBe(0);
  });

  test("when the clock ticks", () => {
    const p = props();
    const { rerender } = render(view(p));
    reset();
    rerender(view({ ...p, now: NOW + 30_000 }));
    rerender(view({ ...p, now: NOW + 60_000 }));
    expect(threadRenders()).toBeGreaterThan(0);
    expect(messageRenders()).toEqual({});
  });

  test("when the clock ticks, only a message with an open request re-renders", () => {
    const asking = msg("ask", "bot", "2026-09-17T11:03:05Z", [
      {
        kind: "approval",
        tool: "write_file",
        summary: "/data/x · new file",
        detail: null,
        request_id: "r1",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      } as unknown as ChatBlockView,
    ]);
    const p = props({ messages: [...transcript(), asking] });
    const { rerender } = render(view(p));
    reset();
    rerender(view({ ...p, now: NOW + 30_000 }));
    expect(messageRenders()).toEqual({ ask: 1 });
  });

  test("when the roster refreshes", () => {
    const p = props();
    const { rerender } = render(view(p));
    reset();
    // A roster read: new objects for the agent and the teammates, saying the same.
    rerender(view({ ...p, agent: agentOf(), teammates: TEAM.map((bot) => ({ ...bot })) }));
    expect(threadRenders()).toBeGreaterThan(0);
    expect(messageRenders()).toEqual({});
    expect(rowRenders()).toBe(0);
  });

  test("when a notification arrives", async () => {
    const inbox = fakeInbox([
      notification({ id: "n1", agent: "other", title: "something elsewhere" }),
      notification({ id: "n2", agent: "other", title: "something else" }),
    ]);
    let notify: Notify | null = null;
    function Grab() {
      const value = useNotify();
      useEffect(() => {
        notify = value;
      });
      return null;
    }
    const p = props();
    render(
      <NotifyProvider api={inbox.api}>
        <Grab />
        {view(p)}
      </NotifyProvider>,
    );
    await act(async () => {
      await (notify as Notify | null)?.refresh();
    });
    reset();
    await act(async () => {
      await (notify as Notify | null)?.ack("n1");
    });
    expect(threadRenders()).toBeGreaterThan(0);
    expect(messageRenders()).toEqual({});
  });
});

describe("markdown is parsed once per distinct text", () => {
  test("across every trigger, and a remount", () => {
    const p = props();
    const { rerender, unmount } = render(view(p));
    expect(markdownCacheStats.parses).toBe(DISTINCT_BOT_TEXTS);
    const math = markdownCacheStats.mathRenders;
    expect(math).toBe(2);
    rerender(view({ ...p, now: NOW + 30_000 }));
    rerender(view({ ...p, messages: structuredClone(p.messages) }));
    rerender(view({ ...p, agent: agentOf() }));
    unmount();
    render(view(p));
    expect(markdownCacheStats.parses).toBe(DISTINCT_BOT_TEXTS);
    expect(markdownCacheStats.mathRenders).toBe(math);
  });
});
