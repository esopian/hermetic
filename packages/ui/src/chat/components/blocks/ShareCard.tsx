/**
 * A file the agent handed the operator (attachments plan §8.5, scenario E):
 * `share_file`, or a `MEDIA:` line naming the box's outbox.
 *
 * One card per share: the type tag, the name, the size, a short sha256, how
 * long the box keeps it, and Save…. An image is fetched at once over the
 * preview machinery and shown above the row — only when the share names a full
 * sha256 and its bytes hash to it; with no digest to check, the card says so
 * and offers Save… instead (core verifies what it saves). Save… asks the main process for a
 * folder (the page never sees the path) and downloads into it.
 *
 * A share the box refused never gets a card: the call is a tool error, and the
 * box's words ("share refused: credential path") are what the operator reads.
 */
import { FILES_TTL, isImageMime, isShareId } from "@hermetic/core/shared";
import type { ChatBlockOf, ChatBlockView } from "../../../api/index.ts";
import { fmtBytes, safeImageSrc } from "../../chat-logic.ts";
import { useChatSelect } from "../../chat-select.tsx";
import type { Chat } from "../../chat-types.ts";
import { saveErrorText, useFileSave } from "../../use-file-save.ts";
import type { FileSaveState } from "../../use-file-save.ts";
import { useSharePreview } from "../../use-share-preview.ts";
import { RedactedText, plainText } from "../RedactedText.tsx";
import { typeTag } from "../../file-type-tag.ts";
import { ToolBlock, resultText, subjectOf } from "./Tool.tsx";
import "./ShareCard.css";
import { renderProbe } from "../../render-probe.ts";

/** The selected box, the one slice of the chat store a card reads (`chat-select.tsx`). */
const selectedInstance = (chat: Chat | null): string | null => chat?.selection?.instance ?? null;

/** What a card draws: a `share_file` result, or an outbox chip's facts. */
export interface ShareFacts {
  id: string;
  name: string;
  mime: string;
  /** 0 when the outbox listing could not be read. */
  bytes: number;
  sha256: string | null;
}

/** A settled `share_file` call: a card when it shared, the box's words when it was refused. */
export function isShareTool(block: ChatBlockView | undefined): boolean {
  return (
    block?.kind === "tool" &&
    block.render === "file_share" &&
    (Boolean(block.share) || block.status === "bad" || block.status === "warn")
  );
}

/** The share id a block draws, if it draws one as a share card. */
export function shareIdOf(block: ChatBlockView | undefined): string | null {
  if (block?.kind === "tool" && block.render === "file_share" && block.share) {
    return block.share.share_id;
  }
  if (block?.kind === "attachment" && typeof block.file_id === "string" && isShareId(block.file_id)) {
    return block.file_id;
  }
  return null;
}

/** `on box 24 h`: how long the outbox keeps a share. */
const RETENTION = `on box ${Math.round(FILES_TTL.outbox / 3600)} h`;

function saveLine(state: FileSaveState): { text: string; tone: "ok" | "bad" | "muted" } | null {
  switch (state.phase) {
    case "choosing":
      return { text: "choosing a folder…", tone: "muted" };
    case "saving":
      return {
        text: state.progress === null ? "saving…" : `saving… ${Math.round(state.progress * 100)}%`,
        tone: "muted",
      };
    case "saved":
      return {
        text: `✓ saved ${state.file.name} · ${fmtBytes(state.file.bytes)} · sha ${state.file.sha256.slice(0, 4)}…`,
        tone: "ok",
      };
    case "error":
      return { text: `not saved — ${saveErrorText(state.code, state.message)}`, tone: "bad" };
    default:
      return null;
  }
}

export function ShareCard({ share, instance: own }: { share: ShareFacts; instance?: string }) {
  renderProbe.hit?.("ShareCard", share.id);
  // The thread's own box, as the message row names it; the selection only
  // for a caller that names none.
  const selected = useChatSelect(selectedInstance);
  const instance = own ?? selected;
  const mime = typeof share.mime === "string" ? share.mime : "";
  const image = isImageMime(mime);
  const preview = useSharePreview(instance, share.id, image, share.sha256);
  const saving = useFileSave(instance, share.id);
  const src = preview?.state === "ready" ? safeImageSrc(preview.url) : null;
  const gone =
    preview?.state === "gone" ||
    (saving.state.phase === "error" && saving.state.code === "FILE_NOT_FOUND");
  const sha = share.sha256 ? `sha ${share.sha256.slice(0, 4)}…` : null;
  const meta = [
    share.bytes > 0 || sha !== null ? fmtBytes(share.bytes) : null,
    sha,
    gone ? "no longer on the box" : RETENTION,
  ]
    .filter(Boolean)
    .join(" · ");
  const busy = saving.state.phase === "choosing" || saving.state.phase === "saving";
  const line = gone ? null : saveLine(saving.state);
  return (
    <div className="ch-attach ch-share" data-share-id={share.id}>
      {src ? <img className="ch-shot" src={src} alt={plainText(share.name)} /> : null}
      {preview?.state === "mismatch" ? (
        <div className="ch-share-note bad" role="alert">
          preview withheld — the image does not match the shared sha256
        </div>
      ) : null}
      {preview?.state === "unverified" ? (
        <div className="ch-share-note muted" role="note">
          no preview without a verified sha256 — Save… instead
        </div>
      ) : null}
      {preview?.state === "failed" ? <div className="ch-shot-missing">preview unavailable</div> : null}
      <div className={`ch-attach-item ch-share-item${gone ? " expired" : ""}`}>
        <i>{typeTag(mime, share.name)}</i>
        <span>
          <b>
            <RedactedText text={share.name} />
          </b>
          <span>{meta}</span>
        </span>
        <button
          type="button"
          className="ch-share-save"
          disabled={instance === null || busy || gone}
          onClick={saving.start}
        >
          {busy ? "Saving…" : "Save…"}
        </button>
      </div>
      {line ? (
        <div className={`ch-share-note ${line.tone}`} role={line.tone === "bad" ? "alert" : "status"}>
          <RedactedText text={line.text} />
        </div>
      ) : null}
    </div>
  );
}

/** `share_file`: its card, the box's refusal, or — still running or unreadable — the tool row. */
export function ShareToolBlock({ block, instance }: { block: ChatBlockOf<"tool">; instance?: string }) {
  const share = block.share;
  if (share) {
    return (
      <ShareCard
        share={{
          id: share.share_id,
          name: share.name,
          mime: share.mime,
          bytes: share.bytes,
          sha256: share.sha256,
        }}
        {...(instance ? { instance } : {})}
      />
    );
  }
  if (block.status === "bad" || block.status === "warn") {
    const subject = subjectOf(block.args);
    return (
      <div className={`ch-share-refused ${block.status}`} role="note">
        <span className="ch-share-tag">{block.name}</span>
        {subject ? (
          <code>
            <RedactedText text={subject} />
          </code>
        ) : null}
        <p>
          <RedactedText text={resultText(block.result) || "the share failed"} />
        </p>
      </div>
    );
  }
  return <ToolBlock block={block} />;
}

/** A `MEDIA:` outbox chip: the same card, from what the chip carries. */
export function ShareAttachment({
  block,
  instance,
}: {
  block: ChatBlockOf<"attachment">;
  instance?: string;
}) {
  return (
    <ShareCard
      share={{
        id: block.file_id ?? "",
        name: block.name,
        mime: typeof block.mime === "string" ? block.mime : "",
        bytes: typeof block.bytes === "number" ? block.bytes : 0,
        sha256: block.sha256 || null,
      }}
      {...(instance ? { instance } : {})}
    />
  );
}
