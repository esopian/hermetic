/**
 * The conversation store's pure helpers (desktop mirrors): matching an
 * optimistic placeholder to the recorded row that echoes it, inserting rows by
 * stamp, and what the rail quotes for a message. Pure TypeScript.
 */
import type { AttachmentBlock, ChatMessage, ChatRole } from "@hermetic/core/chat-client";
import { previewOf } from "./chat-logic.ts";

/** A recorded row may land this long *before* the placeholder it accounts for (clock skew). */
export const MATCH_BEHIND_MS = 1_000;
/** …and this long after it. */
export const MATCH_AHEAD_MS = 5 * 60_000;

export const LOCAL_PREFIX = "local:";

export const isLocal = (message: ChatMessage): boolean => message.id.startsWith(LOCAL_PREFIX);

function bodyOf(message: ChatMessage): string {
  return message.blocks
    .map((block) => (block.kind === "text" ? block.markdown : ""))
    .join("")
    .trim();
}

/** Whether a recorded row is the echo of an optimistic placeholder. */
export function accountsFor(recorded: ChatMessage, placeholder: ChatMessage): boolean {
  if (recorded.role !== placeholder.role) return false;
  const gap = Date.parse(recorded.at) - Date.parse(placeholder.at);
  if (gap < -MATCH_BEHIND_MS || gap > MATCH_AHEAD_MS) return false;
  return bodyOf(recorded) === bodyOf(placeholder);
}

/** The placeholders no recorded row accounts for yet (each recorded row claims at most one). */
export function stillPending(
  local: readonly ChatMessage[],
  recorded: readonly ChatMessage[],
): ChatMessage[] {
  const ids = new Set(recorded.map((row) => row.id));
  const claimed = new Set<number>();
  const pending: ChatMessage[] = [];
  for (const message of local) {
    if (!isLocal(message)) continue;
    if (ids.has(message.id)) continue;
    const at = recorded.findIndex((row, i) => !claimed.has(i) && accountsFor(row, message));
    if (at === -1) pending.push(message);
    else claimed.add(at);
  }
  return pending;
}

/** Insert rows in timestamp order, after any row with the same stamp. */
export function insertByStamp(
  messages: readonly ChatMessage[],
  rows: readonly ChatMessage[],
): ChatMessage[] {
  const next = [...messages];
  for (const row of rows) {
    const at = Date.parse(row.at);
    let i = next.length;
    if (!Number.isNaN(at)) {
      while (i > 0) {
        const before = Date.parse(next[i - 1]!.at);
        if (Number.isNaN(before) || before <= at) break;
        i -= 1;
      }
    }
    next.splice(i, 0, row);
  }
  return next;
}

export const isProcessEventMessage = (m: ChatMessage): boolean =>
  m.blocks.length > 0 && m.blocks.every((b) => b.kind === "process_event");

/** What the rail quotes for a message: its prose, attributed when another bot sent it (desktop `previewText`). */
function previewTextOf(message: ChatMessage): string {
  const prose = message.blocks
    .map((b) => (b.kind === "text" ? b.markdown : ""))
    .filter((text) => text.length > 0)
    .join("\n");
  return message.from_bot && prose ? `${message.from_bot.name}: ${prose}` : prose;
}

/** The rail row's quote for `message`, or `null` when it has none to give. */
export function quoteOf(message: ChatMessage): { preview: string; preview_role: ChatRole } | null {
  if (isProcessEventMessage(message)) return null;
  const preview = previewOf(previewTextOf(message));
  return preview ? { preview, preview_role: message.role } : null;
}

/** Whether the transcript already holds the reply `live` was assembling. */
export function answered(messages: readonly ChatMessage[], live: ChatMessage): boolean {
  const since = Date.parse(live.at);
  return messages.some(
    (m) =>
      m.id === live.id || (m.role !== "user" && !isProcessEventMessage(m) && Date.parse(m.at) >= since),
  );
}

/**
 * The optimistic row for a prompt this phone sent: its words, then one chip per
 * attached file (`attachments`). A prompt that is only files has no text block.
 */
export function localPrompt(
  id: string,
  body: string,
  at: string,
  session: string | null,
  attachments: readonly AttachmentBlock[] = [],
): ChatMessage {
  return {
    id,
    session: session ?? "",
    role: "user",
    author: null,
    at,
    blocks: [
      ...(body || attachments.length === 0 ? [{ kind: "text" as const, markdown: body }] : []),
      ...attachments,
    ],
    usage: null,
    error: null,
    incomplete: null,
  };
}
