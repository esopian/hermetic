/**
 * Classify a roster read's movement before it becomes an inbox row (§4.9).
 *
 * The roster carries one timestamp per bot — the newest row of any kind — so
 * on its own it cannot tell the bot answering from Hermes injecting a
 * background-process notice into the bot's session. Both would read as
 * "<bot> on <instance> has a new message", and a failed command in a thread
 * nobody has open would reach the inbox only as that.
 *
 * So, for each bot whose `last_message_at` has moved past its watermark
 * (`chatMovementOf`, the same rule `observeChatActivity` applies), this reads
 * the newest few rows of that bot's conversation once and looks at the rows in
 * the window `(watermark, last_message_at]`:
 *
 * - each `process_event` block that is not routine raises its own
 *   `chat.event:` row (`notifyProcessEvent`);
 * - a bot row whose final text is an intentional-silence marker (`NO_REPLY`,
 *   `[SILENT]`, …), with only tool runs and reasoning beside it, is the bot
 *   choosing not to answer — Hermes suppressed its delivery — so it is passed
 *   over like a routine event;
 * - another bot's `message_agent` delivery (`from_bot` with a handle) is
 *   passed over too: it is not the operator's message and not news on its
 *   own — the bot's reply to it, when it lands, raises the row;
 * - when every row in the window is such an event or such a silence, each
 *   non-routine event was recorded and the read reached back to the watermark,
 *   the bot is marked `quiet` so `observeChatActivity` advances
 *   the watermark without the generic row;
 * - otherwise — a reply or an operator row among them, an empty window, a read
 *   that failed — the bot is passed through unchanged and the generic row is
 *   raised exactly as before.
 *
 * A first sighting, a bot that did not move and a store that cannot be read
 * cost no request. A failed read never suppresses a row and never fails the
 * roster read: each bot is its own `try`.
 */
import { isRoutineProcessEvent } from "../shared/process-event.ts";
import { isIntentionalSilence } from "../shared/silence.ts";
import type { ChatMessage, ProcessEventBlock } from "../schema/index.ts";
import { chatMovementOf, laterThan, notifyProcessEvent } from "./notifications.ts";
import type { ChatActivity, NotificationDeps } from "./notifications.ts";

/**
 * How many of a moved bot's newest rows the classifier reads. A roster poll
 * runs every few seconds, so a window wider than this between two polls is
 * rare. When the read may not reach back to the watermark — it came back full
 * and every row in it is new — the rows it missed could hold a reply, so the
 * bot is never marked quiet; its events are still raised.
 */
export const CHAT_CLASSIFY_LIMIT = 20;

/** A background-process event message: role `system`, nothing but event blocks. */
function eventBlocks(message: ChatMessage): ProcessEventBlock[] | null {
  if (message.role !== "system" || message.blocks.length === 0) return null;
  const events: ProcessEventBlock[] = [];
  for (const block of message.blocks) {
    if (block.kind !== "process_event") return null;
    events.push(block);
  }
  return events;
}

/**
 * Blocks that are work the turn did rather than words addressed to the reader:
 * the kinds the thread folds into its activity strip (the UI's `isActivity`,
 * `packages/ui/src/chat/components/Activity.tsx`).
 */
const ACTIVITY_KINDS: ReadonlySet<string> = new Set(["activity", "tool", "reasoning", "unknown"]);

/**
 * A bot row whose final answer is a silence marker and which says nothing
 * else: nothing the operator could read. The marker is the turn's last text
 * block — the rule the thread draws a silent turn by
 * (`packages/ui/src/chat/chat-silence.ts`) — so tool runs and reasoning before
 * or after it do not make the turn news. Any other readable block does: a
 * non-blank text block before it, an attachment, a question. A failed or
 * cut-off turn is never silence, whatever its text says (upstream's
 * `is_intentional_silence_agent_result`).
 */
function isSilentReply(message: ChatMessage): boolean {
  if (message.role !== "bot" || message.error || message.incomplete) return false;
  const final = message.blocks.findLastIndex((block) => block.kind === "text");
  const marker = message.blocks[final];
  if (marker?.kind !== "text" || !isIntentionalSilence(marker.markdown)) return false;
  return message.blocks.every(
    (block, i) =>
      i === final ||
      ACTIVITY_KINDS.has(block.kind) ||
      (block.kind === "text" && block.markdown.trim() === ""),
  );
}

/**
 * The roster's bots, each passed through or marked `quiet`, with every
 * non-routine background-process event in a moved bot's new rows raised.
 *
 * `read` must return the bot's newest rows *already redacted* — it is the only
 * path a message takes into this module — and may throw; a throw is that one
 * bot falling back to the generic row.
 */
export async function classifyChatActivity(
  deps: NotificationDeps,
  bots: readonly ChatActivity[],
  read: (bot: ChatActivity) => Promise<readonly ChatMessage[]>,
): Promise<ChatActivity[]> {
  return await Promise.all(
    bots.map(async (bot): Promise<ChatActivity> => {
      try {
        const move = chatMovementOf(deps, bot);
        if (move?.kind !== "moved") return bot;
        const { since, at } = move;
        const rows = await read(bot);
        const fresh = rows.filter(
          (m) => (since === null || laterThan(m.at, since)) && !laterThan(m.at, at),
        );
        // Whether the read reached the watermark: it returned less than it was
        // allowed to, or it holds a row from before the window.
        const covered =
          rows.length < CHAT_CLASSIFY_LIMIT ||
          (since !== null && rows.some((m) => !laterThan(m.at, since)));
        // Nothing in the window: the transcript read disagrees with the roster
        // (another session moved, say). Not evidence of a quiet bot.
        if (fresh.length === 0) return bot;
        let quiet = covered;
        for (const message of fresh) {
          // A delivery always carries its sender's handle. The legacy
          // `[Message from agent '…']` form carries none, and a row whose
          // sender is not named by a handle may be the operator typing one
          // (`bot-delivery.ts` already leaves `Message from HR: …` alone).
          if (isSilentReply(message) || message.from_bot?.handle) continue;
          const events = eventBlocks(message);
          if (events === null) {
            quiet = false;
            continue;
          }
          for (const block of events) {
            if (isRoutineProcessEvent(block)) continue;
            const where = { instance: bot.instance, bot: bot.bot, title: bot.title ?? null };
            // A row that could not be written must not be swallowed by a
            // watermark that moved anyway: the generic row stands in for it.
            if (!notifyProcessEvent(deps, where, block, message.id)) quiet = false;
          }
        }
        return quiet ? { ...bot, quiet: true } : bot;
      } catch {
        // The inbox is a courtesy; a failed read falls back to the generic row.
        return bot;
      }
    }),
  );
}
