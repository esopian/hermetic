/**
 * `attachment` — a file that travelled with the turn: the bot's,
 * or the operator's own upload.
 *
 * Two variants on one field: an image is shown, anything else is named. The
 * split is on the MIME type rather than on the extension, because the extension
 * is a claim the file makes about itself and the MIME type is the box's.
 */
import { useState } from "react";
import { isShareId } from "@hermetic/core/shared";
import { RedactedText, plainText } from "../RedactedText.tsx";
import type { ChatBlockOf } from "../../../api/index.ts";
import { fmtBytes, safeHref, safeImageSrc } from "../../chat-logic.ts";
import { attachmentDelivery } from "../../chat-attachments.ts";
import type { AttachmentDelivery } from "../../chat-attachments.ts";
import { useChatIfAvailable } from "../../chat-state.tsx";
import { useThumbnail } from "../../thumbnails.ts";
import { useFleetIfAvailable } from "../../../state/state.tsx";
import { fleetIdOf } from "../../../api/index.ts";
import { ShareAttachment } from "./ShareCard.tsx";
import { typeTag } from "../../file-type-tag.ts";

/**
 * A file that went through the files service: `href` is a path on the box,
 * never a URL, so the chip is never a link. An image's thumbnail is read back
 * from the box on demand; past the inbox TTL the chip says so.
 */
function StagedAttachment({
  block,
  file_id,
  sha256,
  delivery,
  instance: own,
  fleetId: ownFleet,
}: {
  block: ChatBlockOf<"attachment">;
  file_id: string;
  sha256: string | null;
  delivery: AttachmentDelivery | null;
  instance?: string;
  fleetId?: string;
}) {
  // The thread's own box, as the message row names it; the selection only
  // for a caller that names none.
  const selected = useChatIfAvailable()?.selection?.instance ?? null;
  const instance = own ?? selected;
  const current = fleetIdOf(useFleetIfAvailable()?.meta);
  const fleet = ownFleet ?? current ?? "";
  const mime = typeof block.mime === "string" ? block.mime : "";
  const image = mime.startsWith("image/");
  const thumb = useThumbnail(image ? instance : null, image ? file_id : null, fleet);
  const src = thumb?.state === "ready" ? safeImageSrc(thumb.url) : null;
  const expired = thumb?.state === "expired";
  const status = expired
    ? "expired on box"
    : delivery === "sending"
      ? `sending… · ${fmtBytes(block.bytes)}`
      : delivery === "failed"
        ? `not delivered · ${fmtBytes(block.bytes)}`
        : `✓ delivered · ${fmtBytes(block.bytes)}${sha256 ? ` · sha ${sha256.slice(0, 4)}…` : ""}`;
  return (
    <div className="ch-attach">
      {src ? <img className="ch-shot" src={src} alt={plainText(block.name)} /> : null}
      {image && !src ? (
        <div className="ch-shot-missing">{expired ? "preview expired" : "preview unavailable"}</div>
      ) : null}
      <span className={`ch-attach-item${expired ? " expired" : ""}`} data-file-id={file_id}>
        <i>{typeTag(mime, block.name)}</i>
        <span>
          <b>
            <RedactedText text={block.name} />
          </b>
          <span>{status}</span>
        </span>
      </span>
    </div>
  );
}

export function AttachmentBlock({
  block,
  instance,
  fleetId,
}: {
  block: ChatBlockOf<"attachment">;
  instance?: string;
  fleetId?: string;
}) {
  // A file the agent shared (`MEDIA:` naming the outbox): the share card.
  if (block.file_id && isShareId(block.file_id)) {
    return <ShareAttachment block={block} {...(instance ? { instance } : {})} />;
  }
  if (block.file_id) {
    return (
      <StagedAttachment
        block={block}
        file_id={block.file_id}
        sha256={block.sha256 || null}
        delivery={attachmentDelivery(block)}
        {...(instance ? { instance } : {})}
        {...(fleetId ? { fleetId } : {})}
      />
    );
  }
  return <LinkedAttachment block={block} />;
}

function LinkedAttachment({ block }: { block: ChatBlockOf<"attachment"> }) {
  // Two different questions, and the image one is the stricter of the two: a
  // link is only fetched if the operator clicks it, while an `<img>` is fetched
  // on render. A box that wants to signal out only has to name an off-tailnet
  // URL and let the browser deliver the request for it.
  const href = safeHref(block.href);
  // A block missing its `mime` is a file this build cannot name, not a thread
  // that fails to draw — same normalise-at-the-edge rule as `RedactedText`.
  const mime = typeof block.mime === "string" ? block.mime : "";
  const src = mime.startsWith("image/") ? safeImageSrc(block.href) : null;
  // An image whose bytes do not arrive says so in one line and leaves the chip
  // to carry the file — never a transcript-wide box around its alt text.
  const [failed, setFailed] = useState<string | null>(null);
  const broken = src !== null && failed === src;
  const Row = href === null ? "span" : "a";
  return (
    <div className="ch-attach">
      {src && !broken ? (
        <img className="ch-shot" src={src} alt={plainText(block.name)} onError={() => setFailed(src)} />
      ) : null}
      {broken ? <div className="ch-shot-missing">preview unavailable</div> : null}
      <Row className="ch-attach-item" {...(href === null ? {} : { href, download: block.name })}>
        <i>{typeTag(mime, block.name)}</i>
        <span>
          <b>
            <RedactedText text={block.name} />
          </b>
          <span>{`${fmtBytes(block.bytes)} · ${mime}`}</span>
        </span>
      </Row>
    </div>
  );
}
