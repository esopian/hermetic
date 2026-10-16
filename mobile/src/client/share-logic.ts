/**
 * Which blocks are files the agent shared (desktop `ShareCard.tsx`
 * `isShareTool`, `shareIdOf`): a `share_file` call and a `MEDIA:` chip naming
 * the outbox, both drawn as a share card (`chat/blocks/ShareCard.tsx`) and
 * never folded into a turn's steps. Pure TypeScript.
 */
import type { ChatBlock } from "@hermetic/core/chat-client";
import { isShareId } from "@hermetic/core/shared";

/** A `share_file` call drawn as a card: shared, or refused by the box. */
export function isShareTool(block: ChatBlock | undefined): boolean {
  return (
    block?.kind === "tool" &&
    block.render === "file_share" &&
    (Boolean(block.share) || block.status === "bad" || block.status === "warn")
  );
}

/** An attachment naming a share in the outbox (`MEDIA:`): drawn as a share card. */
export function isShareAttachment(block: ChatBlock | undefined): boolean {
  return block?.kind === "attachment" && typeof block.file_id === "string" && isShareId(block.file_id);
}
