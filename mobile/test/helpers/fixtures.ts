import type {
  ApprovalBlock,
  Bot,
  ChatFrame,
  ChatMessage,
  Notification,
  QuestionBlock,
  SubagentBlock,
  Swarm,
  ToolBlock,
} from "../../src/protocol/types.ts";

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

export const notification = (over: Partial<Notification> = {}): Notification => ({
  id: "n1",
  at: "2026-10-13T10:00:00.000Z",
  source: "chat",
  kind: "chat.message",
  class: "info",
  title: "scribe replied",
  ref: "atlas/scribe",
  actions: [],
  muted: false,
  ...over,
});

export const hello = (over: Partial<import("../../src/protocol/types.ts").Hello> = {}) => ({
  protocol: 1,
  fleet: { fleet_id: "fxtr0001", account_id: "123456789012", region: "us-west-2", alias: "main" },
  tailnet: "tail1234.ts.net",
  device: {
    device_id: "dev1",
    name: "FIXTURE phone",
    platform: "ios" as const,
    created_at: "2026-10-13T09:00:00.000Z",
    previews: true,
    push_registered: false,
  },
  host: { app: "cli" as const, version: "0.0.0", fixture: true },
  listening: ["atlas"],
  active_turns: [],
  ...over,
});
