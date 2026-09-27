/**
 * `attachment` — a file that travelled with the turn: the bot's,
 * or the operator's own upload.
 *
 * Two variants on one field: an image is shown, anything else is named. The
 * split is on the MIME type rather than on the extension, because the extension
 * is a claim the file makes about itself and the MIME type is the box's.
 */
import { useState } from "react";
import { RedactedText } from "../RedactedText.tsx";
import type { ChatBlockOf } from "../../../api/index.ts";
import { fmtBytes, safeHref, safeImageSrc } from "../../chat-logic.ts";

/** `image/png` → `PNG`, `application/pdf` → `PDF`. The square on the left of the row. */
export function typeTag(mime: string, name: string): string {
  const sub = (typeof mime === "string" ? mime : "").split("/")[1] ?? "";
  const cleaned = sub.split("+")[0] ?? "";
  if (cleaned && cleaned.length <= 4) return cleaned.toUpperCase();
  const file = typeof name === "string" ? name : "";
  const ext = file.includes(".") ? (file.split(".").pop() ?? "") : "";
  return (ext || cleaned || "file").slice(0, 4).toUpperCase();
}

export function AttachmentBlock({ block }: { block: ChatBlockOf<"attachment"> }) {
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
        <img className="ch-shot" src={src} alt={block.name} onError={() => setFailed(src)} />
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
