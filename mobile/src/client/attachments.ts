/**
 * The composer's attachments: what the operator picked for the next message,
 * where each file stands on its way to the box, and the turn's attachments once
 * every file is staged.
 *
 * A file goes `picked` (on the phone) → `staging` (uploading to the box's
 * hermeticd, `gateway/files.ts`) → `staged` (the box holds it, waiting for the
 * turn's commit), or `failed` with the error's code and message. `stageAll`
 * drives the uploads and reports each step through `dispatch`, so a screen
 * holding the state in `useReducer` redraws as they land.
 * `outgoingAttachments` is what `sendMessage` takes: the staged ids, the box's
 * commit, and the staged files for the optimistic prompt's chips.
 *
 * Pure: no React, no Expo. Reading a picked file's bytes and deleting the
 * picker's cache copy are injected (`readBytes` and `discardPicked` in
 * `pick-attachment.ts` on the device). A file larger than its cap fails before
 * a byte is read. A caller passing `discard` has the copy deleted once read
 * (the bytes are then kept on a failed entry for its Retry); the chat screen
 * keeps the copy while the chip is in the tray instead, so an upload the box
 * let expire can be staged again.
 */
import type { AttachmentBlock } from "@hermetic/core/chat-client";
import type { FilesStageResult } from "@hermetic/core/schema";
import { FILES_LIMITS } from "@hermetic/core/shared";
import type { PhoneFiles } from "../gateway/files.ts";
import type { SendAttachments } from "./chat-types.ts";
import { HermeticError, reasonOf } from "./errors.ts";

/** How many files one message may carry (the desktop's and the adapter's cap). */
export const ATTACHMENTS_PER_TURN = FILES_LIMITS.attachmentsPerTurn;

/** A file a picker handed back (`pick-attachment.ts`). */
export interface PickedFile {
  name: string;
  /** A local `file://` URI the bytes are read from. */
  uri: string;
  mime?: string | undefined;
  /** Bytes, as the picker reported them (`0` when it did not say). */
  size: number;
  kind: "image" | "file";
}

export type AttachmentStatus = "picked" | "staging" | "staged" | "failed";

export interface PendingAttachment extends PickedFile {
  /** This draft's own id for the file; the box's id is `staged.id`. */
  local_id: string;
  /** The bytes, once read; dropped when the box has them. */
  bytes?: Uint8Array | undefined;
  status: AttachmentStatus;
  staged?: FilesStageResult | undefined;
  error?: { code: string; message: string } | undefined;
}

export type AttachmentAction =
  | { type: "add"; items: readonly PendingAttachment[] }
  | { type: "remove"; local_id: string }
  | { type: "staging"; local_id: string }
  | { type: "staged"; local_id: string; staged: FilesStageResult }
  | {
      type: "failed";
      local_id: string;
      error: { code: string; message: string };
      /** The bytes already read, kept for Retry (the cache copy is gone). */
      bytes?: Uint8Array | undefined;
    }
  /** Back to `picked`, so the next `stageAll` tries it again. */
  | { type: "retry"; local_id: string }
  | { type: "clear" };

let seq = 0;

/** A fresh local id for a picked file. */
export function nextAttachmentId(): string {
  seq += 1;
  return `att${seq}`;
}

/** A picked file as a draft entry. */
export function pendingAttachment(
  file: PickedFile,
  local_id: string = nextAttachmentId(),
  bytes?: Uint8Array,
): PendingAttachment {
  return { ...file, local_id, status: "picked", ...(bytes ? { bytes } : {}) };
}

/**
 * The largest a picked file may be: the image cap for an image, else the file
 * cap (a fleet may set a lower one; the box enforces that).
 */
export function capFor(file: Pick<PickedFile, "kind">): number {
  return file.kind === "image" ? FILES_LIMITS.imageBytes : FILES_LIMITS.fileBytes;
}

/** How many more files the draft can take. */
export function roomFor(pending: readonly PendingAttachment[]): number {
  return Math.max(0, ATTACHMENTS_PER_TURN - pending.length);
}

/**
 * The draft's reducer. `add` keeps only as many new files as there is room for
 * (`roomFor`); the screen says so when a pick was cut short.
 */
export function attachmentsReducer(
  state: readonly PendingAttachment[],
  action: AttachmentAction,
): PendingAttachment[] {
  const patch = (local_id: string, fn: (a: PendingAttachment) => PendingAttachment) => {
    let hit = false;
    const next = state.map((a) => {
      if (a.local_id !== local_id) return a;
      hit = true;
      return fn(a);
    });
    return hit ? next : (state as PendingAttachment[]);
  };
  switch (action.type) {
    case "add": {
      const taken = new Set(state.map((a) => a.local_id));
      const fresh = action.items.filter((a) => !taken.has(a.local_id)).slice(0, roomFor(state));
      return fresh.length === 0 ? (state as PendingAttachment[]) : [...state, ...fresh];
    }
    case "remove": {
      const next = state.filter((a) => a.local_id !== action.local_id);
      return next.length === state.length ? (state as PendingAttachment[]) : next;
    }
    case "staging":
      return patch(action.local_id, ({ error: _e, ...a }) => ({ ...a, status: "staging" }));
    case "staged":
      return patch(action.local_id, ({ error: _e, bytes: _b, ...a }) => ({
        ...a,
        status: "staged",
        staged: action.staged,
      }));
    case "failed":
      return patch(action.local_id, (a) => ({
        ...a,
        status: "failed",
        error: action.error,
        ...(action.bytes ? { bytes: action.bytes } : {}),
      }));
    case "retry":
      return patch(action.local_id, ({ error: _e, staged: _s, ...a }) => ({ ...a, status: "picked" }));
    case "clear":
      return state.length === 0 ? (state as PendingAttachment[]) : [];
  }
}

/** How the draft stands: what the send button and the strip's summary read. */
export function attachmentsSummary(pending: readonly PendingAttachment[]): {
  picked: number;
  staging: number;
  staged: number;
  failed: number;
  /** Every file is on the box (and there is at least one). */
  ready: boolean;
} {
  const count = (s: AttachmentStatus) => pending.filter((a) => a.status === s).length;
  const staged = count("staged");
  return {
    picked: count("picked"),
    staging: count("staging"),
    staged,
    failed: count("failed"),
    ready: pending.length > 0 && staged === pending.length,
  };
}

export interface StageAllOptions {
  /** The conversation's session, when it has one (the box files the upload under it). */
  session_id?: string | null | undefined;
  /** The operator confirmed a key-looking file is not a key. */
  not_secret?: boolean | undefined;
  signal?: AbortSignal | undefined;
  /** Read a picked file's bytes (`readBytes` on the device); used when the entry has none. */
  read?: ((uri: string) => Promise<Uint8Array>) | undefined;
  /** Delete the picker's cache copy once its bytes are read (`discardPicked` on the device). */
  discard?: ((file: PickedFile) => void) | undefined;
  /** Each step, as it happens: hand it the reducer's dispatch. */
  dispatch?: ((action: AttachmentAction) => void) | undefined;
}

/**
 * Upload every `picked` file to the box, one at a time (a phone holds one
 * file's bytes in memory at once, not ten). Staged and failed entries are left
 * as they are; `retry` a failed one first. Answers the draft as it ended.
 * A stop (`signal`) leaves the file that was uploading `failed` with `ABORTED`
 * and the rest `picked`.
 */
export async function stageAll(
  pending: readonly PendingAttachment[],
  files: Pick<PhoneFiles, "stage">,
  opts: StageAllOptions = {},
): Promise<PendingAttachment[]> {
  let state = [...pending];
  const step = (action: AttachmentAction) => {
    state = attachmentsReducer(state, action);
    opts.dispatch?.(action);
  };
  for (const item of pending) {
    if (item.status !== "picked") continue;
    if (opts.signal?.aborted) break;
    step({ type: "staging", local_id: item.local_id });
    let bytes = item.bytes;
    try {
      if (!bytes) {
        // The picker's size first: a file over its cap is refused unread.
        const cap = capFor(item);
        if (item.size > cap) {
          throw new HermeticError("FILE_TOO_LARGE", "the file is larger than a message may carry", {
            size: item.size,
            limit: cap,
          });
        }
        if (!opts.read) throw new HermeticError("VALIDATION", "the file could not be read");
        bytes = await opts.read(item.uri);
        // Read: the bytes live on the entry now, so the picker's copy can go.
        // A failed read keeps the copy for Retry, until the file is removed.
        opts.discard?.(item);
      }
      const staged = await files.stage({
        name: item.name,
        bytes,
        ...(opts.session_id ? { session_id: opts.session_id } : {}),
        ...(opts.not_secret ? { not_secret: true } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      step({ type: "staged", local_id: item.local_id, staged });
    } catch (error) {
      const reason = reasonOf(error);
      // A file too large stays too large: its bytes are not worth holding.
      const keep = bytes && reason.code !== "FILE_TOO_LARGE" ? { bytes } : {};
      step({ type: "failed", local_id: item.local_id, error: reason, ...keep });
    }
  }
  return state;
}

/**
 * The turn's attachments: every staged file, in the operator's order, with the
 * box's commit. `null` when nothing is staged. Files still uploading or failed
 * are not included; send only when `attachmentsSummary(...).ready`, or accept
 * dropping them.
 */
export function outgoingAttachments(
  pending: readonly PendingAttachment[],
  files: Pick<PhoneFiles, "commit">,
): SendAttachments | null {
  const staged = pending.flatMap((a) => (a.status === "staged" && a.staged ? [a.staged] : []));
  if (staged.length === 0) return null;
  return {
    ids: staged.map((file) => file.id),
    commit: (id, session, signal) => files.commit(id, session, signal),
    staged,
  };
}

/**
 * The optimistic prompt's chip for each staged file, as the desktop draws its
 * local echo (`localAttachmentBlock`): `href` is the file's id until the box's
 * transcript row, which carries the committed path, replaces the echo.
 */
export function attachmentChips(staged: readonly FilesStageResult[]): AttachmentBlock[] {
  return staged.map((file) => ({
    kind: "attachment",
    name: file.name,
    mime: file.mime || "application/octet-stream",
    bytes: file.bytes,
    href: file.id,
    file_id: file.id,
    sha256: file.sha256,
  }));
}

/**
 * A failed turn's files, to send again with its words (Retry). Each chip names
 * its file by id, and committing an id twice answers what the first commit did,
 * so the same ids go again through the box's commit (`files`). Refused with
 * `FILE_NOT_FOUND` when a file cannot go again: a chip with no id, or (for this
 * phone's own echo, whose files may never have been committed) a staged file
 * past its expiry. `sent(id)` is what this phone staged (`ConversationStore.sentFile`).
 * `null` when the prompt had no files.
 */
export function resendAttachments(
  prompt: { files: readonly AttachmentBlock[]; recorded: boolean },
  files: Pick<PhoneFiles, "commit">,
  sent: (id: string) => FilesStageResult | undefined,
  now: number,
): SendAttachments | null {
  if (prompt.files.length === 0) return null;
  const ids: string[] = [];
  for (const chip of prompt.files) {
    const id = chip.file_id;
    const expires = id ? sent(id)?.expires_at : undefined;
    if (!id || (!prompt.recorded && expires !== undefined && Date.parse(expires) <= now)) {
      throw new HermeticError(
        "FILE_NOT_FOUND",
        "an attachment of this message is no longer on the box; attach it again",
      );
    }
    ids.push(id);
  }
  return {
    ids,
    commit: (id, session, signal) => files.commit(id, session, signal),
    chips: [...prompt.files],
  };
}

/**
 * The entries of a finished `stageAll` that are still in the tray, in their
 * order: a file the operator removed while the others uploaded does not go.
 */
export function inTray(
  staged: readonly PendingAttachment[],
  tray: readonly PendingAttachment[],
): PendingAttachment[] {
  const live = new Set(tray.map((a) => a.local_id));
  return staged.filter((a) => live.has(a.local_id));
}

/** How long before its expiry a staged file is treated as gone: the commit comes after the send. */
export const STAGE_EXPIRY_MARGIN_MS = 60_000;

/**
 * The staged entries the box will have dropped by the time the turn commits
 * them (`expires_at`, the stage area's hour, less a margin). Mark each failed
 * with `FILE_NOT_FOUND` before sending; its Retry stages it again.
 */
export function expiredStaged(pending: readonly PendingAttachment[], now: number): string[] {
  return pending
    .filter(
      (a) =>
        a.status === "staged" &&
        a.staged !== undefined &&
        Date.parse(a.staged.expires_at) - STAGE_EXPIRY_MARGIN_MS <= now,
    )
    .map((a) => a.local_id);
}
