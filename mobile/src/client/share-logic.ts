/**
 * Which blocks are files the agent shared (desktop `ShareCard.tsx`
 * `isShareTool`, `shareIdOf`): a `share_file` call and a `MEDIA:` chip naming
 * the outbox, both drawn as a share card (`chat/blocks/ShareCard.tsx`) and
 * never folded into a turn's steps. Pure TypeScript.
 */
import type { ChatBlock } from "@hermetic/core/chat-client";
import { type ContentPurpose, isShareId, isTextPreviewMime, mediaKindOf } from "@hermetic/core/shared";

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

/**
 * What a share card draws above its row, from the box's sniffed type (never
 * the name), as the desktop card does: an image is shown at once, audio and
 * video play inline behind "Play", a text file opens behind "Preview".
 */
export type ShareView = "image" | "audio" | "video" | "text";

/** How a share with this type and id is viewed, or `null` (only Save). */
export function shareView(mime: string, id: string): ShareView | null {
  if (!isShareId(id)) return null;
  const kind = mediaKindOf(mime);
  // AVPlayer decodes neither WebM nor Ogg: Save, not a Play that always fails.
  if (/\/(webm|ogg)\b/i.test(mime)) return null;
  if (kind !== "file") return kind;
  return isTextPreviewMime(mime) ? "text" : null;
}

/** The toggle beside Save: `null` for an image, which needs none. */
export function shareToggleLabel(view: ShareView | null, open: boolean): string | null {
  if (view === null || view === "image") return null;
  if (open) return "Hide";
  return view === "text" ? "Preview" : "Play";
}

/** The `files.content` purpose a view reads under, which sets its byte cap. */
export function sharePurpose(view: ShareView): ContentPurpose {
  return view === "image" ? "image" : view === "text" ? "text" : "playback";
}
