/**
 * Bot-to-bot DMs (`message_agent`, Hermes v2026.9.24 `tools/bot_mode_dm.py`)
 * as the thread draws them: the sender's call becomes a "Messaged <bot>"
 * marker, the delivery in the target's Bot Chat is drawn as the sending bot
 * speaking, and either end opens the exchange (`BotExchange.tsx`).
 *
 * Core does the upstream-specific part: it tags the call `render:
 * "message_agent"` and lifts the delivery's `Message from 🤖 …` signature into
 * `ChatMessage.from_bot` (`core/src/chat/hermes/bot-delivery.ts`). What is left
 * here is reading the call's own arguments and acknowledgement, which are the
 * tool's payload exactly as a generic tool card would show them.
 *
 * Wording follows Desktop's `AgentDeliveryNotice`: "Messaging <bot>…" while
 * the call runs, "Messaged <bot>" once it is queued, "Message from <bot>" on
 * the receiving side.
 */
import { botHandle, resolveBotTarget } from "@hermetic/core/shared";
import type { BlockLike, MessageLike } from "./chat-logic.ts";

/** A roster row, as far as these rules read one. Any `BotView` satisfies it. */
export interface DmBot {
  instance: string;
  name: string;
  title?: string | null;
  is_default?: boolean;
}

/** A `message_agent` call, read off its tool block. */
export interface MessageAgentCall {
  /** `target` exactly as the model wrote it: a profile name, a friendly name or an @slug. */
  target: string;
  message: string;
  /** `pending` while the call runs, `sent` once queued, `failed` on an error acknowledgement. */
  state: "pending" | "sent" | "failed";
  /** The acknowledgement's `@handle`, when it gave one. */
  to: string | null;
  /** The delivery's background process, whose completion notice carries the reply. */
  processId: string | null;
  /** Upstream's failure code (`runtime_offline`, `target_busy`, …) on a failed call. */
  reason: string | null;
  /** Upstream's failure sentence on a failed call. */
  error: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A JSON object, given as one or as its text; null for anything else. */
function jsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return record(value);
  try {
    return record(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

/**
 * The call a block makes, or null when the block is not a `message_agent` call
 * this build can read — not hinted, arguments missing, or a result that is not
 * the JSON upstream answers with. Null means "draw the ordinary tool row": a
 * shape this file does not recognise renders, it never disappears (§9.2).
 */
export function messageAgentCall(block: BlockLike): MessageAgentCall | null {
  if (block.kind !== "tool" || block["render"] !== "message_agent") return null;
  const args = jsonObject(block["args"]);
  const target = text(args?.["target"]);
  const message = typeof args?.["message"] === "string" ? args["message"] : null;
  if (!target || message === null) return null;
  const base = { target: target.trim(), message, to: null, processId: null, reason: null, error: null };
  const result = block["result"];
  if (block["status"] === "running" || result === null || result === undefined)
    return { ...base, state: "pending" };
  const ack = jsonObject(result);
  if (!ack) return null;
  const error = text(ack["error"]);
  if (error) return { ...base, state: "failed", error, reason: text(ack["reason"]) };
  return {
    ...base,
    state: "sent",
    to: text(ack["to"]),
    processId: text(ack["process_id"]),
  };
}

/**
 * The roster bot a call or a signature names, or null. The acknowledgement's
 * `@handle` is the box's own resolution and is tried first; the free-text
 * target after it. Same instance only, with the box's own resolver.
 */
export function resolveDmBot<B extends DmBot>(
  names: readonly (string | null | undefined)[],
  teammates: readonly B[],
): B | null {
  for (const name of names) {
    if (!name) continue;
    const hit = resolveBotTarget(name, teammates);
    if (hit) return hit;
  }
  return null;
}

/** The name a bot is shown by: its title, else its handle. */
export function dmBotName(bot: DmBot | null, fallback: string): string {
  const title = bot?.title?.trim();
  if (title) return title;
  return bot ? botHandle(bot.name) : fallback.replace(/^@+/, "");
}

const sameBody = (a: string, b: string): boolean => a.trim() === b.trim();

function bodyOf(message: Pick<MessageLike, "blocks">): string {
  return message.blocks
    .map((block) =>
      block.kind === "text" && typeof block["markdown"] === "string" ? block["markdown"] : "",
    )
    .join("");
}

/**
 * Whether a row is `sender`'s delivery of `message`. Exact (trimmed) first;
 * a prefix either way after it, because a box that capped or a fixture that
 * trimmed the body still names the same delivery.
 */
function isDeliveryOf(row: MessageLike, sender: string, message: string, exact: boolean): boolean {
  const from = row.from_bot;
  if (row.role !== "user" || !from) return false;
  // A legacy signature names no handle; the body alone has to carry it.
  if (from.handle && from.handle !== botHandle(sender)) return false;
  const body = bodyOf(row).trim();
  const want = message.trim();
  if (exact) return sameBody(body, want);
  const probe = want.slice(0, 120);
  return body.length > 0 && (body.startsWith(probe) || want.startsWith(body.slice(0, 120)));
}

/**
 * The delivery of `message` from `sender` in a transcript, and the rows that
 * answered it: everything after it up to the next user row. Null when the
 * transcript does not hold it — the delivery has not run yet, or the Bot Chat
 * rolled over since.
 */
export function findExchange<M extends MessageLike>(
  transcript: readonly M[],
  sender: string,
  message: string,
): { delivery: M; replies: M[] } | null {
  let at = -1;
  for (const exact of [true, false]) {
    for (let i = transcript.length - 1; i >= 0; i--) {
      if (isDeliveryOf(transcript[i]!, sender, message, exact)) {
        at = i;
        break;
      }
    }
    if (at >= 0) break;
  }
  if (at < 0) return null;
  const replies: M[] = [];
  for (const row of transcript.slice(at + 1)) {
    if (row.role === "user") break;
    replies.push(row);
  }
  return { delivery: transcript[at]!, replies };
}

/**
 * The reply a delivery's completion notice carried back to the sender, by the
 * acknowledgement's process id, or null.
 */
export function noticeReply(
  transcript: readonly MessageLike[],
  processId: string | null,
): string | null {
  if (!processId) return null;
  for (const row of transcript) {
    for (const block of row.blocks) {
      if (block.kind !== "process_event" || block["process_id"] !== processId) continue;
      const reply = record(block["dm"])?.["reply"];
      if (typeof reply === "string") return reply;
    }
  }
  return null;
}
