/**
 * The shapes the conversation and roster stores trade with their transport.
 *
 * The chat wire types themselves (`ChatMessage`, `ChatFrame`, `Session`,
 * `Swarm`, the blocks) come straight from core's `@hermetic/core/chat-client`
 * door, the same types the desktop renders; what is here are the phone's own
 * result envelopes, shaped like the desktop's `chat.*` results so the stores
 * read the same fields either way.
 */
import type {
  AttachmentBlock,
  ChatConversation,
  ChatMessage,
  ChatSteerStatus,
  SendOptions,
  Session,
} from "@hermetic/core/chat-client";
import type { FilesStageResult } from "@hermetic/core/schema";

export interface HistoryResult {
  /** The conversation `conversation()` resolved, when the gateway has Bot Mode. */
  conversation?: ChatConversation | null;
  instance: string;
  bot: string;
  /** The session the transcript came from, or `null` when the bot has none yet. */
  session: string | null;
  messages: ChatMessage[];
}

export interface SessionsResult {
  instance: string;
  bot: string;
  sessions: Session[];
}

export interface AbortResult {
  instance: string;
  bot: string;
  aborted: boolean;
}

export type SteerStatus = ChatSteerStatus;

export interface SteerResult {
  instance: string;
  bot: string;
  status: SteerStatus;
}

export interface RespondResult {
  status: "ok" | "expired";
  remaining?: string[];
}

/** What starting a turn asks for. */
export interface TurnRequest {
  instance: string;
  bot: string;
  /** Continue this session; omitted means the bot's canonical one ("Bot Chat"). */
  session?: string;
  /** Start a fresh thread instead. */
  new_session?: boolean;
  message: string;
  /** The optimistic prompt's local id, for correlation in logs and tests. */
  client_ref?: string;
  /** Files staged on the box for this turn; the adapter commits and frames them. */
  attachments?: SendAttachments;
}

/**
 * A turn's attachments: what the Hermes adapter takes (`SendOptions.attachments`:
 * the staged ids and the box's commit), plus the staged files themselves, which
 * the optimistic prompt draws as chips until the box's transcript has the row.
 * Build it with `outgoingAttachments` (`attachments.ts`).
 */
export type SendAttachments = NonNullable<SendOptions["attachments"]> & {
  readonly staged?: readonly FilesStageResult[];
  /** The chips to draw instead, when resending files known only by their chips (Retry). */
  readonly chips?: readonly AttachmentBlock[];
};

export interface TurnStartResult {
  /** Minted on the phone: the gateway names no turn. */
  turn_id: string;
}

/** How a turn this phone drove ended. */
export type TurnState = "done" | "error" | "aborted";

/**
 * A turn the phone stopped following (the app went to the background) that
 * its box still reports busy (`session.active_list`): the store shows it as
 * still running there rather than over.
 */
export type RemoteStatus = "working" | "starting" | "waiting";
