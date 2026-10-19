/**
 * `@hermetic/core/chat-client`: core's Hermes chat adapter, for runtimes that
 * are not the laptop.
 *
 * Two of them. The phone (`mobile/`) talks to each box's Hermes gateway
 * directly over the tailnet, and it does so through the same adapter the
 * desktop uses, so the two cannot disagree about what a transcript says. And
 * hermeticd (`packages/agentd`) drives its own box's gateway through it for the
 * push watcher. Both get the adapter (`createHermesChat`), the transcript
 * follower (`createChatObservation`), the chat wire types, the transcript mask,
 * and the error type the adapter throws.
 *
 * What must never be reachable from here: anything that needs node, bun or
 * AWS, or that reads the environment — `chat-transport.ts`, `chat/chat.ts`,
 * `backend/`, `aws/`, `local/`, `render/render.ts`, `render/render-browser.ts`.
 * The caller supplies `fetch`, the socket and timers through `HermesChatDeps`;
 * this door brings no transport of its own. `test/chat-client-portable.test.ts`
 * walks every module reachable from this file and fails on the first that is
 * not portable, and it records the runtime globals (`AbortSignal.timeout`,
 * `AbortSignal.any`, `structuredClone`) the phone has to polyfill.
 *
 * The schema types come straight from `schema/chat.ts` and
 * `schema/requests.ts`, not through `schema/index.ts`. Types only: a caller
 * that wants to validate a frame imports the Zod schema through
 * `@hermetic/core/schema`.
 *
 * Named re-exports, never `export *`: the door is this list.
 */

// --- The adapter ---------------------------------------------------------
export { createHermesChat } from "./chat/hermes/hermes-chat.ts";
export { DIRECT_DIAL_HEADERS } from "./chat/hermes/hermes-chat-types.ts";
export type {
  BoxAddress,
  ChatSocket,
  ChatSteerStatus,
  HermesChatClient,
  HermesChatDeps,
  HermesChatOptions,
  HistoryOptions,
  ObserveOptions,
  SendOptions,
  SubagentSteerStatus,
} from "./chat/hermes/hermes-chat-types.ts";

// --- Creating a Bot Mode bot ---------------------------------------------
// The sequence `bots.create` runs, over a caller's bound `botModeRpc`.
export { botProfileOf, createBotOverRpc } from "./chat/hermes/hermes-bot-create.ts";
export type { BotModeCall } from "./chat/hermes/hermes-bot-create.ts";

// --- Following a transcript ----------------------------------------------
export {
  OBSERVE_HINTS_ENDED,
  OBSERVE_POLL_MS,
  OBSERVE_RECONNECT_ATTEMPTS,
  OBSERVE_RECONNECT_BASE_MS,
  OBSERVE_RECONNECT_MAX_MS,
  OBSERVE_WINDOW,
  createChatObservation,
} from "./chat/chat-observe.ts";
export type {
  ChatObservation,
  ChatObserveDeps,
  ChatObserveHint,
  ChatObserveOptions,
  ChatObserveSnapshot,
  ChatObserveTarget,
} from "./chat/chat-observe.ts";

// --- Masking a transcript ------------------------------------------------
// `transcriptMask(DEFAULT_CHAT_SETTINGS.redact)` is the mask the desktop applies
// out of the box: content as the box wrote it, failure text always masked.
// `redactText` is the string-level mask, for a notification preview.
export { redactText, transcriptMask } from "./chat/chat-redact.ts";
export type { TranscriptMask } from "./chat/chat-redact.ts";
export { DEFAULT_CHAT_SETTINGS } from "./chat/chat-settings.ts";
export { compactionFor, compactionFrames } from "./chat/compact-turn.ts";
export type { ChatSettings } from "./chat/chat-settings.ts";

// --- Errors and aborts ---------------------------------------------------
export { HermeticError, hasCode, isHermeticError } from "./errors.ts";
export type { ErrorCode } from "./shared/error-codes.ts";
export { abortableSleep, checkAbort } from "./abort.ts";

// --- The chat wire types (§9.2) ------------------------------------------
import type { ChatBlock, ChatFrame } from "./schema/chat.ts";

export type {
  ApprovalChoice,
  Bot,
  BotRef,
  ChatBlock,
  ChatConversation,
  ChatErrorSurface,
  ChatFailure,
  ChatFrame,
  ChatMessage,
  ChatObserveEvent,
  ChatRole,
  ChatUsage,
  ProcessEventBlock,
  ProcessEventType,
  ProcessOutcome,
  RequestCloseReason,
  Room,
  Session,
  SessionKind,
  SessionOrigin,
  SubagentBlock,
  SubagentStatus,
  SubagentVerdict,
  Swarm,
  ToolRender,
  ToolStatus,
} from "./schema/chat.ts";
export type { ChatRespondInput } from "./schema/requests.ts";

// `schema/chat.ts` exports only the unions; the members are named here, by
// discriminant, so they cannot drift from it.
export type BlockFrame = Extract<ChatFrame, { type: "block" }>;
export type DeltaFrame = Extract<ChatFrame, { type: "delta" }>;
export type DoneFrame = Extract<ChatFrame, { type: "done" }>;
export type ErrorFrame = Extract<ChatFrame, { type: "error" }>;

export type ChatBlockKind = ChatBlock["kind"];
export type TextBlock = Extract<ChatBlock, { kind: "text" }>;
export type CommandBlock = Extract<ChatBlock, { kind: "command" }>;
export type ActivityBlock = Extract<ChatBlock, { kind: "activity" }>;
export type ReasoningBlock = Extract<ChatBlock, { kind: "reasoning" }>;
export type ToolBlock = Extract<ChatBlock, { kind: "tool" }>;
export type AttachmentBlock = Extract<ChatBlock, { kind: "attachment" }>;
export type ApprovalBlock = Extract<ChatBlock, { kind: "approval" }>;
export type QuestionBlock = Extract<ChatBlock, { kind: "question" }>;
export type SourcesBlock = Extract<ChatBlock, { kind: "sources" }>;
export type HermeticBlock = Extract<ChatBlock, { kind: "hermetic" }>;
export type UnknownBlock = Extract<ChatBlock, { kind: "unknown" }>;
