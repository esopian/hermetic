/**
 * The composer's attachment chips, and the thread's drop target
 * (attachments plan §8.1).
 *
 * The chips draw a conversation's pending files (`chat-attachments.ts`); the
 * drop overlay covers one thread pane while files are dragged over it, and
 * names the agent, so with two dock panes a file is never dropped on the
 * wrong one. Every control is a real `<button>` styled here and in
 * `chat.css`, never left to the engine's defaults.
 */
import { useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import { FILES_LIMITS, FILES_TTL } from "@hermetic/core/shared";
import type { AttachmentsControl, DraftAttachment } from "../chat-attachments.ts";
import { summarize } from "../chat-attachments.ts";
import { fmtBytes } from "../chat-logic.ts";
import { RedactedText, plainText } from "./RedactedText.tsx";
import { typeTag } from "./blocks/Attachment.tsx";

/** The words for a box without the files service, on every surface that refuses. */
export const NO_FILES_COPY = "Update hermeticd to attach files";

const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const mb = (bytes: number) => `${NUMBER.format(bytes / (1024 * 1024))} MB`;
const days = (seconds: number) => {
  const n = Math.round(seconds / 86_400);
  return `${NUMBER.format(n)} ${n === 1 ? "day" : "days"}`;
};

/** `images ≤ 25 MB · files ≤ 256 MB · max 10`, from the limits core enforces. */
export const LIMITS_LINE = `images ≤ ${mb(FILES_LIMITS.imageBytes)} · files ≤ ${mb(
  FILES_LIMITS.fileBytes,
)} · max ${NUMBER.format(FILES_LIMITS.attachmentsPerTurn)}`;

/** `2 ready · 1 uploading · 1 failed`, or `""` with nothing pending. */
export function attachSummary(items: readonly DraftAttachment[]): string {
  const { ready, uploading, failed } = summarize(items);
  return [
    ready ? `${ready} ready` : "",
    uploading ? `${uploading} uploading` : "",
    failed ? `${failed} failed` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function chipStatus(a: DraftAttachment): string {
  if (a.state === "error") return a.error?.message ?? "failed";
  if (a.state === "staged") return `✓ staged · ${fmtBytes(a.size)}`;
  const pct = Math.round(a.progress * 100);
  return `uploading ${pct}% · ${fmtBytes(a.size * a.progress)} / ${fmtBytes(a.size)}`;
}

export function AttachTray({ files }: { files: AttachmentsControl }) {
  if (files.items.length === 0) return null;
  return (
    <ul className="ch-tray" aria-label="Attachments">
      {files.items.map((a) => (
        <li key={a.local_id} className={`ch-file ${a.state}`} data-state={a.state}>
          <i aria-hidden="true">{typeTag(a.mime, a.name)}</i>
          <span className="ch-file-text">
            <b>
              <RedactedText text={a.name} />
            </b>
            <span className="ch-file-status" role={a.state === "error" ? "alert" : undefined}>
              {chipStatus(a)}
            </span>
          </span>
          {a.state === "uploading" ? (
            <span className="ch-file-bar" aria-hidden="true">
              <span style={{ width: `${Math.round(a.progress * 100)}%` }} />
            </span>
          ) : null}
          {a.state === "error" && a.secretOverride ? (
            <button
              type="button"
              className="ch-file-act"
              title={
                a.secretOverride === "retry"
                  ? "Send it anyway: it is not a secret"
                  : "Pick the file again and send it anyway"
              }
              onClick={() => files.retry(a.local_id, { not_secret: true })}
            >
              {a.secretOverride === "retry" ? "Attach anyway" : "Pick again, attach anyway"}
            </button>
          ) : a.state === "error" && a.retryable ? (
            <button type="button" className="ch-file-act" onClick={() => files.retry(a.local_id)}>
              Retry
            </button>
          ) : null}
          <button
            type="button"
            className="ch-file-x"
            aria-label={`Remove ${plainText(a.name)}`}
            title="Remove"
            onClick={() => files.remove(a.local_id)}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Whether a drag carries files rather than text or a link. */
function carriesFiles(e: DragEvent): boolean {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  for (let i = 0; i < types.length; i++) if (types[i] === "Files") return true;
  return false;
}

/**
 * How long the overlay outlives the last `dragover`. A drag over the pane
 * fires one at least every 350 ms (±200) even with the pointer still, so a
 * second of silence means the drag ended somewhere this pane never heard.
 */
export const DRAG_IDLE_MS = 1_000;

/**
 * The drop target for one thread pane. Handlers go on the pane's root; the
 * overlay is drawn inside it while files hover. Only a file drag is taken —
 * text and links dragged within the page behave as they always did — and the
 * page prevents the default for it so a missed drop never navigates.
 *
 * Enter and leave are counted because they fire for every child crossed, but
 * a child that unmounts under the pointer (a streaming reply re-rendering)
 * never sends its leave. So the overlay also goes on any `dragend` or `drop`
 * anywhere in the window, on a leave out of the window, and when `dragover`
 * has gone quiet for `DRAG_IDLE_MS`.
 *
 * `canDrop` is the composer's own `enabled`: a pane that cannot send cannot
 * take files either.
 */
export function useFileDrop(files: AttachmentsControl | null, agent: string, canDrop = true) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enabled = files !== null && files.capability !== "no" && canDrop;
  const reset = () => {
    depth.current = 0;
    if (idle.current) clearTimeout(idle.current);
    idle.current = null;
    setOver(false);
  };
  const resetRef = useRef(reset);
  resetRef.current = reset;
  const armIdle = () => {
    if (idle.current) clearTimeout(idle.current);
    idle.current = setTimeout(() => resetRef.current(), DRAG_IDLE_MS);
  };
  useEffect(() => {
    if (!over) return;
    const end = () => resetRef.current();
    // Out of the window: nothing entered, at or past the viewport's edge. The
    // edge check keeps an engine that leaves `relatedTarget` unset on every
    // leave from dropping the overlay at each child crossed.
    const leave = (e: globalThis.DragEvent) => {
      if (e.relatedTarget !== null) return;
      const { clientX: x, clientY: y } = e;
      if (x <= 0 || y <= 0 || x >= window.innerWidth || y >= window.innerHeight) resetRef.current();
    };
    window.addEventListener("dragend", end, true);
    window.addEventListener("drop", end, true);
    window.addEventListener("dragleave", leave, true);
    return () => {
      window.removeEventListener("dragend", end, true);
      window.removeEventListener("drop", end, true);
      window.removeEventListener("dragleave", leave, true);
    };
  }, [over]);
  useEffect(
    () => () => {
      if (idle.current) clearTimeout(idle.current);
    },
    [],
  );
  const handlers =
    files === null
      ? {}
      : {
          onDragEnter: (e: DragEvent) => {
            if (!carriesFiles(e)) return;
            e.preventDefault();
            depth.current += 1;
            setOver(true);
            armIdle();
          },
          onDragOver: (e: DragEvent) => {
            if (!carriesFiles(e)) return;
            e.preventDefault();
            armIdle();
            if (!over) setOver(true);
            if (e.dataTransfer) e.dataTransfer.dropEffect = enabled ? "copy" : "none";
          },
          onDragLeave: (e: DragEvent) => {
            if (!carriesFiles(e)) return;
            depth.current = Math.max(0, depth.current - 1);
            if (depth.current === 0) setOver(false);
          },
          onDrop: (e: DragEvent) => {
            if (!carriesFiles(e)) return;
            e.preventDefault();
            reset();
            const list = Array.from(e.dataTransfer?.files ?? []);
            if (enabled && list.length > 0) files.addFiles(list);
          },
        };
  const overlay = over ? (
    <div className={`ch-drop${enabled ? "" : " off"}`} role="status">
      {enabled ? (
        <>
          <b>Drop to attach</b>
          <span className="ch-drop-to">
            {"→ "}
            <RedactedText text={agent} />
            {` · inbox · deleted after ${days(FILES_TTL.inbox)}`}
          </span>
          <span className="ch-drop-limits">{LIMITS_LINE}</span>
        </>
      ) : (
        <>
          <b>Can't attach here</b>
          <span className="ch-drop-to">{`${agent} · ${NO_FILES_COPY}`}</span>
        </>
      )}
    </div>
  ) : null;
  return { handlers, overlay };
}
