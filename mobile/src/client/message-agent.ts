/**
 * A Bot Mode `message_agent` call (a bot-to-bot DM) read off its tool block,
 * for the compact "→ bot" line the transcript draws in place of a tool step
 * (desktop `bot-dm.ts` `messageAgentCall`, which the phone cannot import).
 *
 * Null means "draw the ordinary tool row": a call this build cannot read — no
 * hint, arguments missing, or a result that is not upstream's JSON — still
 * renders, it never disappears. Pure TypeScript.
 */
import type { ChatBlock } from "@hermetic/core/chat-client";

export interface MessageAgentLine {
  /** `target` as the model wrote it: a profile name, a friendly name or an @handle. */
  target: string;
  /** The bot the line's avatar is drawn for: the target, `@` dropped. */
  bot: string;
  message: string;
  /**
   * `pending` while the call runs, `sent` once handed off, `ambiguous` when
   * upstream could not tell (and says not to resend), `failed` on an error.
   */
  state: "pending" | "sent" | "ambiguous" | "failed";
  /** Upstream's sentence on a failed or ambiguous call. */
  error: string | null;
}

/** The statuses upstream acknowledges a completed hand-off with. */
const SENT = new Set(["queued", "claimed", "settled"]);

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value) as unknown);
    } catch {
      return null;
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

/** A `message_agent` call this build reads: drawn as a DM line, never folded into the steps. */
export function isDmTool(block: ChatBlock | undefined): boolean {
  return messageAgentLine(block) !== null;
}

/** The DM a block sends, or null when it is not a `message_agent` call this build can read. */
export function messageAgentLine(block: ChatBlock | undefined): MessageAgentLine | null {
  if (block?.kind !== "tool" || block.render !== "message_agent") return null;
  const args = record(block.args);
  const target = text(args?.["target"]);
  const message = typeof args?.["message"] === "string" ? args["message"] : null;
  if (!target || message === null) return null;
  const base = { target, bot: target.replace(/^@+/, ""), message, error: null };
  if (block.status === "running") return { ...base, state: "pending" };
  const ack = record(block.result);
  if (!ack) return null;
  const status = ack["status"];
  const error = text(ack["error"]);
  if (status === undefined || status === null)
    return error ? { ...base, state: "failed", error } : null;
  if (status === "ambiguous") return { ...base, state: "ambiguous", error };
  if (typeof status !== "string" || !SENT.has(status)) return null;
  return { ...base, state: "sent" };
}
