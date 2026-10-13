/**
 * Structural types for what crosses the bridge, mirroring core's Zod schemas by
 * field name (`packages/core/src/schema/chat.ts`, `notification.ts`,
 * `agent.ts`, and `.context/mobile-protocol.md` for the bridge's own frames).
 *
 * Hand-written because the phone cannot import core: it is its own toolchain,
 * and Zod has no place in the bundle. A Zod `.nullish()` field is `?: T | null`
 * here; `.optional()` is `?: T`; `.nullable()` is `: T | null`. Nothing in this
 * file is a value, so bun can import it from the repo root for the e2e test.
 */

import type {
  MOBILE_CLIENT_FRAMES,
  MOBILE_PLATFORMS,
  MOBILE_PUSH_KINDS,
  MOBILE_SERVER_FRAMES,
  MOBILE_TURN_STATES,
} from "./constants.ts";

/* ── addressing ─────────────────────────────────────────────────────────── */

export interface BotRef {
  instance: string;
  bot: string;
}

/** Every `rpc`, `turn.start` and `observe.open` carries the fleet it means. */
export interface FleetTarget {
  account_id: string;
  region: string;
  fleet_id: string;
}

export type SessionKind = "canonical" | "thread" | "routine";
export type ChatRole = "user" | "bot" | "system";

/* ── roster ─────────────────────────────────────────────────────────────── */

export interface Bot {
  instance: string;
  name: string;
  title: string;
  description?: string | null;
  is_default: boolean;
  model?: string | null;
  section?: string | null;
  avatar_seed: string;
  last_message_at?: string | null;
  last_message_session?: string | null;
  preview?: string | null;
  preview_role?: ChatRole | null;
  unread: number;
  needs_action: boolean;
  muted: boolean;
  warm: boolean;
}

export interface Room {
  id: string;
  name: string;
  instance: string;
  members: BotRef[];
  round?: { n: number; of: number } | null;
  needs_action: boolean;
}

export interface Swarm {
  instance: string;
  reachable: boolean;
  unreachable_reason?: string | null;
  bots: Bot[];
  rooms: Room[];
  warm_slots: { used: number; total: number | null };
  sections: string[];
}

export interface Session {
  id: string;
  instance: string;
  bot: string;
  kind: SessionKind;
  /** `SESSION_ORIGIN_NAMES` in core/shared; kept open here so a new origin does not break the phone. */
  origin: string;
  origin_detail?: string | null;
  title: string;
  preview?: string | null;
  last_message_at?: string | null;
  unread: number;
  turn_count: number;
}

export interface ChatConversation {
  instance: string;
  bot: string;
  root_session: string;
  session: string;
  kind: SessionKind;
  created: boolean;
}

/* ── blocks ─────────────────────────────────────────────────────────────── */

export type ToolRender = "diff" | "terminal" | "table" | "image" | "screenshot" | "message_agent";
export type ToolStatus = "running" | "ok" | "warn" | "bad";
export type ApprovalChoice = "once" | "session" | "always" | "deny";
export type RequestCloseReason =
  | "timeout"
  | "interrupted"
  | "shutdown"
  | "resolved"
  | "session_closed"
  | "other";

export interface TextBlock {
  kind: "text";
  markdown: string;
}

export interface ActivityBlock {
  kind: "activity";
  category: "connection" | "queue" | "history" | "generation" | "notice" | "usage";
  key: string;
  title: string;
  detail?: string | null;
  state: "running" | "done" | "warning" | "error";
  request_id?: string | null;
  role?: "status" | "work" | null;
  reason?: RequestCloseReason | null;
  payload?: unknown;
}

export interface ReasoningBlock {
  kind: "reasoning";
  text: string;
  duration_ms?: number | null;
  tokens?: number | null;
}

export interface ToolBlock {
  kind: "tool";
  tool_id?: string | null;
  name: string;
  server?: string | null;
  args: unknown;
  result?: unknown;
  status: ToolStatus;
  exit_code?: number | null;
  duration_ms?: number | null;
  render?: ToolRender | null;
}

export interface AttachmentBlock {
  kind: "attachment";
  name: string;
  mime: string;
  bytes: number;
  href: string;
}

export interface ApprovalBlock {
  kind: "approval";
  tool: string;
  summary: string;
  detail?: string | null;
  expires_at?: string | null;
  request_id?: string | null;
  /** Zod defaults this to `["once", "deny"]`, so it is always present on the wire. */
  choices: ApprovalChoice[];
  smart_denied?: boolean;
  pattern?: string;
  payload?: unknown;
}

export interface QuestionEntry {
  id: string;
  prompt: string;
  choices: string[];
  multi_select: boolean;
  answer: string | null;
}

export interface QuestionBlock {
  kind: "question";
  prompt: string;
  choices: string[];
  multi_select?: boolean;
  questions?: QuestionEntry[];
  request_id?: string | null;
  expires_at?: string | null;
  payload?: unknown;
}

export interface SourcesBlock {
  kind: "sources";
  items: { title: string; href: string; snippet?: string | null }[];
}

export interface HermeticBlock {
  kind: "hermetic";
  card: "agent" | "op" | "plan" | "fleet";
  ref: string;
}

export interface UnknownBlock {
  kind: "unknown";
  name: string;
  payload: unknown;
}

export type ProcessEventType =
  | "completion"
  | "watch_match"
  | "watch_disabled"
  | "delegation"
  | "mcp_reload";
export type ProcessOutcome = "ok" | "failed" | "terminated" | "info";

export interface ProcessDelegationTask {
  index: number;
  goal?: string | null;
  status: string;
  ok: boolean;
  summary?: string | null;
  duration_s?: number | null;
  api_calls?: number | null;
}

export interface ProcessEventBlock {
  kind: "process_event";
  event: ProcessEventType;
  outcome: ProcessOutcome;
  process_id?: string | null;
  status?: string | null;
  exit_code?: number | null;
  signal?: string | null;
  command?: string | null;
  output_tail?: string | null;
  output_lines?: number | null;
  duration_s?: number | null;
  message?: string | null;
  watch?: { pattern: string; suppressed: number } | null;
  delegation?: {
    id: string;
    batch: boolean;
    status?: string | null;
    total: number;
    succeeded: number;
    api_calls?: number | null;
    tasks: ProcessDelegationTask[];
    error?: string | null;
  } | null;
  dm?: { to_profile: string; reply: string; warnings: string[] } | null;
  raw: string;
}

export type SubagentStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "error"
  | "timeout"
  | "interrupted"
  | "dispatched"
  | "unobserved";
export type SubagentVerdict = "running" | "done" | "failed" | "stopped" | "unknown";

export interface SubagentToolRow {
  name: string;
  preview: string;
  is_error?: boolean;
}

export interface SubagentBlock {
  kind: "subagent";
  subagent_id: string;
  delegation_id?: string;
  parent_id?: string;
  child_session_id?: string;
  depth: number;
  task_index: number;
  task_count: number;
  goal: string;
  model?: string;
  status: SubagentStatus;
  verdict: SubagentVerdict;
  started_at?: string;
  duration_ms?: number;
  summary?: string;
  tool_count?: number;
  tools: SubagentToolRow[];
  progress?: string;
  thinking?: string;
  files_read?: string[];
  files_written?: string[];
  output_tail?: SubagentToolRow[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    reasoning_tokens?: number;
    api_calls?: number;
  };
  result?: {
    cost_usd?: number;
    failure_reason?: string;
    exit_reason?: string;
    truncated?: boolean;
    error?: string;
  };
  origin: "live" | "replay" | "history";
  tool_id?: string;
}

export type ChatBlock =
  | TextBlock
  | ActivityBlock
  | ReasoningBlock
  | ToolBlock
  | AttachmentBlock
  | ApprovalBlock
  | QuestionBlock
  | SourcesBlock
  | HermeticBlock
  | ProcessEventBlock
  | SubagentBlock
  | UnknownBlock;

export type ChatBlockKind = ChatBlock["kind"];

/* ── messages ───────────────────────────────────────────────────────────── */

export interface ChatUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cost_usd?: number | null;
  model?: string | null;
}

export interface ChatErrorSurface {
  layer: string;
  code: string;
  retryable: boolean;
  provider?: string;
  model?: string;
  auth_kind?: string;
  provider_label?: string;
  resets_at?: number;
  message?: string;
}

export interface ChatFailure {
  code: string;
  message: string;
  surface?: ChatErrorSurface;
}

export interface ChatMessage {
  id: string;
  session: string;
  role: ChatRole;
  author?: BotRef | null;
  at: string;
  blocks: ChatBlock[];
  usage?: ChatUsage | null;
  error?: string | null;
  failure?: ChatFailure | null;
  incomplete?: boolean | null;
  from_bot?: { name: string; handle: string | null; connection?: string | null } | null;
}

/* ── the stream ─────────────────────────────────────────────────────────── */

export interface BlockFrame {
  type: "block";
  seq: number;
  message: string;
  block: ChatBlock;
}

export interface DeltaFrame {
  type: "delta";
  seq: number;
  message: string;
  text: string;
}

export interface DoneFrame {
  type: "done";
  seq: number;
  message: string;
  usage?: ChatUsage | null;
  incomplete?: boolean | null;
}

export interface ErrorFrame {
  type: "error";
  code: string;
  message: string;
  failure?: ChatFailure;
}

export type ChatFrame = BlockFrame | DeltaFrame | DoneFrame | ErrorFrame;

/* ── observation ────────────────────────────────────────────────────────── */

export type ChatObserveEvent =
  | {
      type: "snapshot";
      instance: string;
      bot: string;
      session: string | null;
      messages: ChatMessage[];
      at: string;
    }
  | { type: "message"; instance: string; bot: string; session: string | null; message: ChatMessage }
  | {
      type: "reconnect";
      instance: string;
      bot: string;
      attempt: number;
      delay_ms: number;
      code: string;
      message: string;
    }
  | { type: "error"; instance: string; bot: string; code: string; message: string }
  | { type: "subagent"; instance: string; bot: string; session: string | null; block: SubagentBlock };

/* ── notifications ──────────────────────────────────────────────────────── */

export type NotificationSource = "operation" | "agent" | "fleet" | "chat" | "budget" | "terminal";
export type NotificationKind =
  | "operation.failed"
  | "operation.done"
  | "agent.health"
  | "fleet.advisory"
  | "chat.message"
  | "chat.error"
  | "terminal.output"
  | "terminal.finished"
  | "terminal.input"
  | "terminal.bell"
  | "terminal.disconnected";
export type NotificationClass = "ok" | "info" | "warn" | "bad" | "needs_action";
export type NotificationActionTarget =
  | "agent"
  | "op"
  | "run"
  | "foundation"
  | "volumes"
  | "settings"
  | "chat"
  | "terminal";

export interface NotificationAction {
  label: string;
  target: NotificationActionTarget;
  ref?: string;
}

export interface Notification {
  id: string;
  at: string;
  source: NotificationSource;
  kind: NotificationKind;
  class: NotificationClass;
  title: string;
  detail?: string | null;
  agent?: string | null;
  fleet_id?: string | null;
  ref?: string | null;
  key?: string | null;
  actions: NotificationAction[];
  read_at?: string | null;
  resolved_at?: string | null;
  cleared_at?: string | null;
  snoozed_until?: string | null;
  muted: boolean;
}

export interface NotificationMute {
  target: string;
  at: string;
}

export interface NotificationsListResult {
  notifications: Notification[];
  unread: number;
  needs_action: number;
  snoozed: number;
  history: number;
  next_snooze_at: string | null;
  mutes: NotificationMute[];
}

export interface NotificationCounts {
  unread: number;
  needs_action: number;
}

/* ── agents (the subset the phone reads) ───────────────────────────────── */

export interface AgentView {
  name: string;
  status: string;
  display_status: string;
  tailscale_dns_name?: string | null;
  tailscale_ip?: string | null;
  browsers: { name: string; serve_path: string }[];
}

/* ── rpc results the phone reads ───────────────────────────────────────── */

export interface ListeningResult {
  instances: string[];
}
export interface SwarmsResult {
  swarms: Swarm[];
}
export interface SessionsResult {
  instance: string;
  bot: string;
  sessions: Session[];
}
export interface HistoryResult {
  conversation?: ChatConversation | null;
  instance: string;
  bot: string;
  session: string | null;
  messages: ChatMessage[];
}
export interface AbortResult {
  instance: string;
  bot: string;
  aborted: boolean;
}
export type SteerStatus = "redirected" | "queued" | "rejected" | "idle";
export interface SteerResult {
  instance: string;
  bot: string;
  status: SteerStatus;
}
export interface RespondResult {
  status: "ok" | "expired";
  remaining?: string[];
}

/* ── the bridge's own documents ─────────────────────────────────────────── */

export type MobilePlatform = (typeof MOBILE_PLATFORMS)[number];
export type TurnState = (typeof MOBILE_TURN_STATES)[number];
export type PushKind = (typeof MOBILE_PUSH_KINDS)[number];
export type ClientFrameType = (typeof MOBILE_CLIENT_FRAMES)[number];
export type ServerFrameType = (typeof MOBILE_SERVER_FRAMES)[number];

/** The bridge's error body: the desktop `RpcErrorBody` shape. */
export interface BridgeErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

export interface TurnSummary {
  turn_id: string;
  instance: string;
  bot: string;
  session: string | null;
  started_at: string;
  state: TurnState;
  last_n: number;
  truncated: boolean;
  device_id: string;
}

export interface Hello {
  protocol: number;
  fleet: { fleet_id: string; account_id: string; region: string; alias: string | null };
  tailnet: string | null;
  device: {
    device_id: string;
    name: string;
    platform: MobilePlatform;
    created_at: string;
    previews: boolean;
    push_registered: boolean;
  };
  host: { app: "desktop" | "cli"; version: string; fixture: boolean };
  listening: string[];
  active_turns: TurnSummary[];
}

export interface HealthResult {
  ok: true;
  protocol: number;
  fixture: boolean;
}

export interface PairRequest {
  code: string;
  device_name: string;
  platform: MobilePlatform;
}

export interface PairResult {
  token: string;
  device_id: string;
  hello: Hello;
}

export interface PushSettingsResult {
  ok: true;
  previews: boolean;
  enabled: boolean;
}

/** What a `turn.start` asks for. */
export interface TurnRequest {
  instance: string;
  bot: string;
  session?: string;
  new_session?: boolean;
  message: string;
  client_ref?: string;
}

/* ── ws frames ──────────────────────────────────────────────────────────── */

export type ClientFrame =
  | {
      type: "auth";
      token: string;
      protocol: number;
      resume?: { turns: { turn_id: string; after: number }[] };
    }
  | { type: "rpc"; id: string; method: string; params: unknown; target: FleetTarget }
  | { type: "turn.start"; id: string; target: FleetTarget; turn: TurnRequest }
  | { type: "turn.resume"; id: string; turn_id: string; after: number }
  | { type: "turn.abort"; id: string; turn_id: string }
  | {
      type: "observe.open";
      id: string;
      target: FleetTarget;
      instance: string;
      bot: string;
      session?: string | null;
    }
  | { type: "observe.close"; id: string; sub_id: string }
  | { type: "pong" };

export type ServerFrame =
  | { type: "auth.ok"; hello: Hello }
  | { type: "auth.error"; error: BridgeErrorBody }
  | { type: "res"; id: string; ok: true; result: unknown }
  | { type: "res"; id: string; ok: false; error: BridgeErrorBody }
  | { type: "turn.frame"; turn_id: string; n: number; frame: ChatFrame }
  | { type: "turn.end"; turn_id: string; n: number; state: Exclude<TurnState, "running"> }
  | { type: "turn.started"; turn: TurnSummary }
  | { type: "observe.event"; sub_id: string; event: ChatObserveEvent }
  | { type: "observe.end"; sub_id: string; error?: { code: string; message: string } }
  | { type: "notification"; row: Notification; counts: NotificationCounts }
  | { type: "listening"; instances: string[] }
  | { type: "ping" }
  | { type: "error"; error: BridgeErrorBody };

export interface TurnStartResult {
  turn_id: string;
}
export interface TurnResumeResult {
  turn_id: string;
  state: TurnState;
  last_n: number;
  truncated: boolean;
}
export interface ObserveOpenResult {
  sub_id: string;
}

/* ── push payloads (`data` of an Expo push) ─────────────────────────────── */

export type PushData =
  | {
      kind: "turn.done" | "turn.error";
      instance: string;
      bot: string;
      session: string | null;
      turn_id: string;
      dedupe: string;
    }
  | {
      kind: "needs_action";
      request_kind: "approval" | "question";
      instance: string;
      bot: string;
      session: string | null;
      request_id: string;
      dedupe: string;
    }
  | {
      kind: "notification";
      id: string;
      dedupe: string;
      ref?: string | null;
      target?: NotificationActionTarget | null;
    };
