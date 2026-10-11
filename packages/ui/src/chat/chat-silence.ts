/**
 * A bot that chose not to answer (§9.2).
 *
 * Hermes lets a bot reply with a bare intentional-silence marker — `NO_REPLY`,
 * `[SILENT]`, a translation — and suppresses only the *delivery*: the row stays
 * in the transcript as an ordinary assistant message. Upstream Desktop never
 * sees one live (a Bot Chat turn completes with empty text), but every read of
 * the transcript does, and drawing it as a bubble that says "NO_REPLY" is
 * drawing a control token as if the bot had said it.
 *
 * What counts as a marker is upstream's rule, carried by `@hermetic/core/shared`
 * — nothing here knows the token list. This module only decides *which block*
 * of a turn the rule applies to.
 */
import { isIntentionalSilence, isPartialSilenceMarker } from "@hermetic/core/shared";
import type { ChatBlockView, ChatMessageView } from "../api/index.ts";
import { isActivity } from "./components/Activity.tsx";

/** What a silent turn reads as, in the thread and on the rail. */
export const SILENT_LABEL = "stayed silent";

/**
 * The turn's closing prose block: the last text block, provided nothing
 * addressed to the reader follows it. A tool run or a notice after it does not
 * count — the final answer is still the final answer — but an attachment or a
 * question does.
 */
function finalText(blocks: readonly ChatBlockView[]): number {
  const index = blocks.findLastIndex((block) => block.kind === "text");
  if (index < 0) return -1;
  return blocks.slice(index + 1).every(isActivity) ? index : -1;
}

function markdownAt(blocks: readonly ChatBlockView[], index: number): string {
  const block = blocks[index];
  return block?.kind === "text" ? block.markdown : "";
}

/**
 * The index of the block that is a settled bot turn's silence marker, or -1.
 *
 * Only a successful turn is silent: a failed or cut-off one ends on whatever
 * it said, marker or not, because upstream suppresses delivery for successful
 * turns alone and a failure's own words must never be swallowed.
 */
export function silentBlock(
  message: Pick<ChatMessageView, "role" | "error" | "incomplete">,
  blocks: readonly ChatBlockView[],
  streaming: boolean,
): number {
  if (streaming || message.role !== "bot" || message.error || message.incomplete) return -1;
  const index = finalText(blocks);
  return index >= 0 && isIntentionalSilence(markdownAt(blocks, index)) ? index : -1;
}

/**
 * The index of the in-flight text block being held back, or -1: while the
 * prose streamed so far could still turn out to be a marker, the reader sees
 * the caret, not `NO_`. The moment it diverges, all of it is shown.
 */
export function heldBlock(blocks: readonly ChatBlockView[], streaming: boolean): number {
  if (!streaming) return -1;
  const index = finalText(blocks);
  return index >= 0 && isPartialSilenceMarker(markdownAt(blocks, index)) ? index : -1;
}

/** The tooltip on a silent turn: which token it returned, and why nothing shows. */
export function silentTitle(markdown: string): string {
  return `replied ${markdown.trim()} — Hermes suppresses delivery`;
}

/**
 * A rail preview that is only a marker, from a bot.
 *
 * The marker is silence only when the bot returned it: the operator's own
 * "No reply" is their words, as is anything else a non-bot row says. An
 * unknown role is the common case, not an old shape — upstream's preview
 * names none (`BotView.preview_role`) — and the newest row of a Bot Chat that
 * reads as a bare marker is overwhelmingly the bot's, so it still reads as
 * silence rather than showing every silent bot's raw `NO_REPLY`.
 */
export function isSilentPreview(
  text: string | null | undefined,
  role?: ChatMessageView["role"] | null,
): boolean {
  if (role != null && role !== "bot") return false;
  return !!text && isIntentionalSilence(text);
}
