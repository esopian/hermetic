/**
 * The composer meter draws the newer of what the thread's rows carry and the
 * figure the conversation's record holds (`Chat.context`). Rendered directly;
 * how the record comes to hold one is `context-record.dom.test.tsx`.
 */
import { afterEach, expect, test } from "bun:test";
import { cleanup, render, screen } from "./dom.ts";
import type { ChatMessageView } from "../src/api/index.ts";
import { Thread } from "../src/chat/components/Thread.tsx";
import type { ContextReading } from "../src/chat/context-usage.ts";

afterEach(cleanup);

const NOW = Date.parse("2026-10-12T10:00:00.000Z");

function row(id: string, at: string, usage: ChatMessageView["usage"]): ChatMessageView {
  return {
    id,
    session: "s1",
    role: "bot",
    author: { instance: "atlas", bot: "default" },
    at,
    blocks: [{ kind: "text", markdown: `reply ${id}` }],
    usage,
    error: null,
    incomplete: null,
  } as ChatMessageView;
}

const windowOf = (used: number) => ({
  input_tokens: used,
  output_tokens: 10,
  cost_usd: null,
  model: "m",
  context_used: used,
  context_max: 200_000,
  context_percent: Math.round((used / 200_000) * 100),
});

function thread(
  messages: ChatMessageView[],
  live: ChatMessageView | null,
  context: ContextReading | null = null,
) {
  return (
    <Thread
      fleetId="fxtr0001"
      instance="atlas"
      bot="default"
      agent={null}
      session={null}
      destination={{ state: "known", origin: "portal", detail: null }}
      state="ready"
      messages={messages}
      live={live}
      context={context}
      sending={false}
      historyError={null}
      now={NOW}
      onSend={() => {}}
      onAbort={() => {}}
    />
  );
}

const older = row("old", "2026-10-12T08:00:00.000Z", windowOf(24_000));
const durable = row("live-durable", "2026-10-12T09:59:01.000Z", null);
const held = (used: number, at: string): ContextReading => ({
  usage: { used, max: 200_000, percent: Math.round((used / 200_000) * 100), estimated: false },
  at,
});

test("the record's figure, newer than any row's, is the one drawn", () => {
  render(thread([older, durable], null, held(170_000, "2026-10-12T09:59:00.000Z")));
  expect(screen.getByRole("meter").textContent).toBe("85%");
  expect(screen.getByRole("meter").dataset.level).toBe("warn");
});

test("a row newer than the record's figure wins", () => {
  render(thread([older], null, held(170_000, "2026-10-12T07:00:00.000Z")));
  expect(screen.getByRole("meter").textContent).toBe("12%");
});

test("a live turn's tick draws before the record has anything", () => {
  const live = {
    ...row("live", "2026-10-12T09:59:00.000Z", null),
    blocks: [
      {
        kind: "activity",
        category: "usage",
        key: "usage",
        title: "Current usage",
        state: "running",
        detail: null,
        payload: { usage: { context_used: 190_000, context_max: 200_000 } },
      },
    ],
  } as ChatMessageView;
  render(thread([older], live));
  expect(screen.getByRole("meter").textContent).toBe("95%");
  expect(screen.getByRole("meter").dataset.level).toBe("bad");
});

test("no figure anywhere draws no meter", () => {
  render(thread([durable], null));
  expect(screen.queryByRole("meter")).toBeNull();
});
