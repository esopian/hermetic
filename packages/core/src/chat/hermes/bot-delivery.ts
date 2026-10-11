/**
 * A bot-to-bot DM as the receiving bot's transcript stores it.
 *
 * `message_agent` (`tools/bot_mode_dm.py`, Hermes v2026.9.24) hands the
 * message to a background delivery that runs a turn in the target's canonical
 * Bot Chat. The turn runs on the user role, so the delivery lands as an
 * ordinary `user` row whose text is the sender's signature and the body:
 * `Message from 🤖 <display name> (@<handle>): <body>` (`bot_mode_dm.py:238`).
 * The operator never typed it, so core lifts the signature into
 * `ChatMessage.from_bot` and leaves the body as the row's text — the same move
 * `process-notice.ts` makes for an injected `[IMPORTANT: …` row.
 *
 * The pattern is Hermes Desktop's `AGENT_MESSAGE_RE`
 * (`apps/desktop/src/components/assistant-ui/thread/user-message.tsx:90-91`),
 * verbatim, so a row Desktop draws as a delivery is one hermetic draws as a
 * delivery and nothing else is. It also accepts the relayed form
 * (`(@handle@connection)`, whose connection part is dropped here) and the
 * legacy `[Message from agent '<name>']` signature, which carries no handle.
 */
import type { ChatBlock, ChatMessage } from "../../schema/index.ts";

/** Desktop's `AGENT_MESSAGE_RE`: 1 name, 2 handle, 3 legacy name, 4 body. */
const AGENT_MESSAGE_RE =
  /^(?:Message from (?:🤖\s*)?([^:\n(]{1,64}?)(?:\s*\(@([a-z0-9][a-z0-9_-]{0,63})(?:@[a-zA-Z0-9][a-zA-Z0-9_-]{0,63})?\))?:\s*|\[Message from agent '([^']{1,64})'\]\s*)([\s\S]*)$/u;

/** The sender a delivery row is signed with. */
export type BotDeliverySender = NonNullable<ChatMessage["from_bot"]>;

/** A delivery's signature and the message it carries, or null for any other text. */
export function parseBotDelivery(text: string): { from: BotDeliverySender; body: string } | null {
  const match = AGENT_MESSAGE_RE.exec(text);
  if (!match) return null;
  const name = (match[1] ?? match[3] ?? "").trim();
  if (!name) return null;
  return { from: { name, handle: match[2] ?? null }, body: match[4] ?? "" };
}

/**
 * A user row's blocks with a delivery signature lifted off its first text
 * block, or null when the row is not a delivery. Only the leading text block
 * is read: the signature is a prefix of the content upstream wrote, so a
 * `Message from` anywhere later is somebody quoting one.
 */
export function stripBotDelivery(
  blocks: readonly ChatBlock[],
): { from: BotDeliverySender; blocks: ChatBlock[] } | null {
  const first = blocks[0];
  if (first?.kind !== "text") return null;
  const parsed = parseBotDelivery(first.markdown);
  if (!parsed) return null;
  return { from: parsed.from, blocks: [{ kind: "text", markdown: parsed.body }, ...blocks.slice(1)] };
}

/**
 * A rail preview that opens with a delivery signature, as `Name: body`, or
 * null. Upstream builds the session preview from the newest row's raw text, so
 * without this the rail would quote the signature.
 */
export function botDeliveryPreview(preview: string): string | null {
  const parsed = parseBotDelivery(preview);
  return parsed ? `${parsed.from.name}: ${parsed.body}` : null;
}
