/**
 * Hand-built delegated children for the subagent suites
 * (`subagent.dom.test.tsx`, `subagent-modal.dom.test.tsx`): blocks in core's
 * `SubagentBlock` shape, the `delegate_task` call they sit under, and the
 * observation event that carries one after its turn.
 */
import type { ChatBlockOf, ChatBlockView, ChatMessageView, ChatObserveView } from "../src/api/index.ts";
import { ATLAS } from "./chat-observe-fixtures.tsx";

export type Kid = ChatBlockOf<"subagent">;

let serial = 0;
/** A fresh id per call, so one test's first draw is never another's. */
export const freshId = (prefix = "sa"): string =>
  `${prefix}-${++serial}-${Math.random().toString(36).slice(2, 8)}`;

export function kid(over: Partial<Kid> = {}): Kid {
  return {
    kind: "subagent",
    subagent_id: freshId(),
    depth: 0,
    task_index: 0,
    task_count: 1,
    goal: "Survey disk I/O on the box",
    model: "claude-haiku-5",
    status: "running",
    verdict: "running",
    started_at: new Date(Date.now() - 12_000).toISOString(),
    tools: [],
    origin: "live",
    tool_id: "call-delegate",
    ...over,
  } as Kid;
}

export const running = (over: Partial<Kid> = {}): Kid =>
  kid({ tools: [{ name: "terminal", preview: "iostat -x 1 3" }], tool_count: 1, ...over });

export const done = (over: Partial<Kid> = {}): Kid =>
  kid({
    status: "completed",
    verdict: "done",
    duration_ms: 22_000,
    summary: "Flaky. poller.test.ts depends on file order.\nMore detail here.",
    tools: [{ name: "terminal", preview: "bun test" }],
    tool_count: 4,
    ...over,
  });

export const failed = (over: Partial<Kid> = {}): Kid =>
  kid({
    status: "timeout",
    verdict: "failed",
    duration_ms: 51_000,
    summary: "Could not finish: the flows suite needs the devkit",
    tools: [{ name: "terminal", preview: "bun test flows" }],
    tool_count: 3,
    ...over,
  });

export function delegateTool(
  toolId = "call-delegate",
  status: "ok" | "running" = "running",
): ChatBlockView {
  return {
    kind: "tool",
    name: "delegate_task",
    tool_id: toolId,
    status,
    args: { goal: "fan out" },
    result: null,
    render: "json",
  } as unknown as ChatBlockView;
}

export function botTurn(
  id: string,
  blocks: ChatBlockView[],
  at = new Date().toISOString(),
): ChatMessageView {
  return {
    id,
    session: "s1",
    role: "bot",
    author: null,
    at,
    blocks,
    usage: null,
    error: null,
    incomplete: null,
  } as unknown as ChatMessageView;
}

export function userTurn(id: string, text: string, at = new Date().toISOString()): ChatMessageView {
  return {
    id,
    session: "s1",
    role: "user",
    author: null,
    at,
    blocks: [{ kind: "text", markdown: text }],
    usage: null,
    error: null,
    incomplete: null,
  } as unknown as ChatMessageView;
}

/** The observation's one typed exception: a child, whole, after (or during) its turn. */
export function subagentEvent(block: Kid, session: string | null = "s1"): ChatObserveView {
  return {
    type: "subagent",
    instance: ATLAS.instance,
    bot: ATLAS.bot,
    session,
    block,
  } as unknown as ChatObserveView;
}

/** The lines drawn, by child id. */
export const line = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`.sa-line[data-subagent-id="${id}"]`);

export const lines = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>(".sa-line"));

/** A `snapshot` naming another session: the conversation was archived and replaced. */
export function rolloverTo(session: string, messages: ChatMessageView[]): ChatObserveView {
  return {
    type: "snapshot",
    instance: ATLAS.instance,
    bot: ATLAS.bot,
    session,
    messages,
    at: new Date().toISOString(),
  } as unknown as ChatObserveView;
}
