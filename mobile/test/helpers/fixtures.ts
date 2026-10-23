import type {
  ApprovalBlock,
  Bot,
  ChatFrame,
  ChatMessage,
  QuestionBlock,
  SubagentBlock,
  Swarm,
  ToolBlock,
} from "@hermetic/core/chat-client";
import type { MobileFleetView } from "@hermetic/core/schema";
import type { InboxEntry } from "../../src/inbox/store.ts";

export const delta = (seq: number, text: string, message = "m1"): ChatFrame => ({
  type: "delta",
  seq,
  message,
  text,
});

export const block = (seq: number, b: ChatMessage["blocks"][number], message = "m1"): ChatFrame => ({
  type: "block",
  seq,
  message,
  block: b,
});

export const done = (seq: number, message = "m1"): ChatFrame => ({
  type: "done",
  seq,
  message,
  usage: { input_tokens: 10, output_tokens: 20 },
});

export const errorFrame = (code = "RATE_LIMITED", message = "slow down"): ChatFrame => ({
  type: "error",
  code,
  message,
});

export const tool = (over: Partial<ToolBlock> = {}): ToolBlock => ({
  kind: "tool",
  tool_id: "t1",
  name: "terminal",
  args: { command: "ls" },
  status: "running",
  ...over,
});

type TodoStatus = "done" | "active" | "pending" | "cancelled";

/** A finished `todo_list` call leaving `items` (`[id, content, status, parent?]`) at `revision`. */
export const todoTool = (
  items: readonly (readonly [string, string, TodoStatus, string?])[],
  revision: number | null = 1,
  over: Partial<ToolBlock> = {},
): ToolBlock =>
  tool({
    tool_id: `todo-${revision ?? "x"}`,
    name: "todo_list",
    status: "ok",
    todos: {
      todos: items.map(([id, content, status, parent]) => ({
        id,
        content,
        status,
        ...(parent ? { parent } : {}),
      })),
      revision,
    },
    ...over,
  });

export const approval = (over: Partial<ApprovalBlock> = {}): ApprovalBlock => ({
  kind: "approval",
  tool: "terminal",
  summary: "rm -rf build",
  request_id: "r1",
  choices: ["once", "session", "always", "deny"],
  ...over,
});

export const question = (over: Partial<QuestionBlock> = {}): QuestionBlock => ({
  kind: "question",
  prompt: "Which branch?",
  choices: ["main", "dev"],
  request_id: "q1",
  ...over,
});

export const subagent = (over: Partial<SubagentBlock> = {}): SubagentBlock => ({
  kind: "subagent",
  subagent_id: "s1",
  depth: 1,
  task_index: 0,
  task_count: 1,
  goal: "research",
  status: "running",
  verdict: "running",
  tools: [],
  origin: "live",
  ...over,
});

export const msg = (over: Partial<ChatMessage> & { text?: string } = {}): ChatMessage => {
  const { text, ...rest } = over;
  return {
    id: "h1",
    session: "s-1",
    role: "bot",
    at: "2026-10-13T10:00:00.000Z",
    blocks: [{ kind: "text", markdown: text ?? "hello" }],
    ...rest,
  };
};

export const bot = (over: Partial<Bot> = {}): Bot => ({
  instance: "atlas",
  name: "scribe",
  title: (over.name ?? "scribe").toUpperCase(),
  is_default: false,
  avatar_seed: "x",
  unread: 0,
  needs_action: false,
  muted: false,
  warm: false,
  ...over,
});

export const swarm = (instance: string, bots: Bot[], over: Partial<Swarm> = {}): Swarm => ({
  instance,
  reachable: true,
  bots: bots.map((b) => ({ ...b, instance })),
  rooms: [],
  warm_slots: { used: 0, total: 3 },
  sections: [],
  ...over,
});

export const inboxEntry = (over: Partial<InboxEntry> = {}): InboxEntry => ({
  id: "i1",
  kind: "turn.done",
  instance: "atlas",
  bot: "scribe",
  session: "s-1",
  title: "scribe · atlas",
  body: "Reply ready",
  at: "2026-10-13T10:00:00.000Z",
  read_at: null,
  dedupe: "atlas:s-1:4:turn.done",
  ...over,
});

/** A `GET /fleet` answer for the fixture fleet. */
export const fleetView = (over: Partial<MobileFleetView> = {}): MobileFleetView => ({
  fleet: {
    fleet_id: "fxtr0001",
    alias: "main",
    tailnet: "hermetic.ts.net",
    region: "us-west-2",
    account_id: "123456789012",
    foundation_version: 16,
  },
  agents: [
    {
      name: "atlas",
      status: "ready",
      tailscale_dns_name: "fxtr0001-atlas.hermetic.ts.net",
      tailscale_ip: "100.64.0.1",
      version: "0.21.1",
    },
  ],
  read_at: "2026-10-13T10:00:00.000Z",
  ...over,
});
