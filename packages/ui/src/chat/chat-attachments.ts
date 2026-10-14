/**
 * The composer's pending attachments (design.md §9.2, attachments plan §8.1).
 *
 * They live on the conversation record next to `draft`, so a conversation that
 * moves between the dock, the drawer and the full view keeps them, and so does
 * a composer that unmounts mid-upload: the jobs below belong to the store, not
 * to a component. Nothing here is persisted; a reload loses the chips, and the
 * box's stage directory forgets the bytes within the hour (`FILES_TTL.stage`).
 *
 * Two ways in, one way through:
 *
 * - A drop or a paste hands the page a `File` and no path. Its bytes go to the
 *   main process in base64 chunks of `FILES_LIMITS.chunkBytes`, capped at
 *   `FILES_LIMITS.chunkUploadBytes`; anything larger is an error chip pointing
 *   at ⊕, which never moves bytes through the webview.
 * - ⊕ (or ⌘⇧A) opens the native dialog in the main process
 *   (`files.pickNative`), which answers upload ids and never a path.
 *
 * Either way the upload id is staged on the box (`files.stage`), and the chip
 * holds the staged entry's `file_id` — the only thing `chat.send` carries.
 */
import { useCallback, useRef } from "react";
import { FILES_LIMITS, isImageMime } from "@hermetic/core/shared";
import * as filesApi from "../api/files.ts";
import type { ChatBlockOf } from "../api/index.ts";
import type { StageHandlers } from "../api/files.ts";
import type { Conversation } from "./chat-conversation-record.ts";
import { key } from "./chat-conversation-record.ts";
import { fmtBytes } from "./chat-logic.ts";
import type { ChatSelection } from "./chat-types.ts";
import { sendChunks } from "./chunk-upload.ts";

/** One chip in the composer's tray. Replaced, never mutated, so a render sees it move. */
export interface DraftAttachment {
  /** Local and only ever used to address the chip. */
  local_id: string;
  name: string;
  size: number;
  /** The browser's guess until staged, then the box's sniffed type. */
  mime: string;
  state: "uploading" | "staged" | "error";
  /** 0..1 across the whole trip: chunks into the main process, then the box. */
  progress: number;
  phase?: "send" | "hash" | "upload";
  file_id?: string;
  error?: { code: string; message: string };
  /** The chip can be sent again with `not_secret` (a `FILE_LOOKS_SECRET` refusal). */
  secretOverride?: "retry" | "repick";
  /** The chip can be tried again from the bytes this page still holds. */
  retryable?: boolean;
  /**
   * A `LIMIT` chip's count: the files that did not fit under
   * `FILES_LIMITS.attachmentsPerTurn`. One chip stands for all of them.
   */
  overflow?: number;
  /** Files already staged on the box that the chip stands for, deleted when it is removed. */
  dropped?: readonly string[];
}

/** What a sent (or queued) message carries about each of its files. */
export interface SentAttachment {
  file_id: string;
  name: string;
  size: number;
  mime: string;
}

/** Whether the box's `hermeticd` serves files; `unknown` until it answered. */
export type FilesCapabilityState = "unknown" | "yes" | "no";

export interface AttachmentsControl {
  items: readonly DraftAttachment[];
  capability: FilesCapabilityState;
  /** Ask the box once whether it can take files. Idempotent. */
  probe: () => void;
  addFiles: (files: readonly File[]) => void;
  /** ⊕ / ⌘⇧A: the native open dialog. */
  pick: () => void;
  /** The × on a chip: stops its upload, or deletes what the box staged. */
  remove: (local_id: string) => void;
  /** Send an error chip again: from its bytes, or, for a native pick, by re-picking. */
  retry: (local_id: string, opts?: { not_secret?: boolean }) => void;
  /** The staged chips, handed to a send and cleared without deleting anything. */
  take: () => SentAttachment[];
  /**
   * Put sent attachments back as staged chips: a refused send, or an edited
   * queue row. Only as many as the tray has room for; the rest are one `LIMIT`
   * chip, and removing it deletes them on the box.
   */
  restore: (sent: readonly SentAttachment[]) => void;
  /** Delete staged files on the box that no chip holds any more (a removed queue row). */
  discard: (sent: readonly SentAttachment[]) => void;
}

/** The calls the pipeline makes, injectable so a test can count them. */
export type AttachmentsApi = Pick<
  typeof filesApi,
  | "chunkOpen"
  | "chunkAppend"
  | "chunkClose"
  | "chunkDiscard"
  | "filesCapability"
  | "filesDiscard"
  | "pickNative"
  | "stageUpload"
>;

const NO_ITEMS: readonly DraftAttachment[] = [];

/** The control with no conversation behind it: nothing selected, nothing to attach to. */
export const NO_ATTACHMENTS: AttachmentsControl = {
  items: NO_ITEMS,
  capability: "unknown",
  probe: () => undefined,
  addFiles: () => undefined,
  pick: () => undefined,
  remove: () => undefined,
  retry: () => undefined,
  take: () => [],
  restore: () => undefined,
  discard: () => undefined,
};

export { chunkOffsets, toBase64 } from "./chunk-upload.ts";

const MB = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/** A refusal in the words a chip has room for. */
export function attachmentErrorText(
  code: string,
  message: string,
  file: { size: number; mime: string },
): string {
  switch (code) {
    case "FILE_TOO_LARGE": {
      const cap = isImageMime(file.mime) ? FILES_LIMITS.imageBytes : FILES_LIMITS.fileBytes;
      return `too large · ${fmtBytes(file.size)} > ${MB(cap)}`;
    }
    case "FILE_DIGEST_MISMATCH":
      return "Upload corrupted — retry";
    case "DISK_FULL":
      return "the box's disk is full";
    case "FILE_LOOKS_SECRET":
      return "looks like a key or credential";
    case "FILE_TYPE_REJECTED":
      return "this file type is refused";
    case "FILE_NOT_FOUND":
      return "expired on box";
    case "UNSUPPORTED":
      return "Update hermeticd to attach files";
    default:
      return message || code;
  }
}

/** Ready, uploading and failed counts, for the composer's footer and its Send. */
export function summarize(items: readonly DraftAttachment[]): {
  ready: number;
  uploading: number;
  failed: number;
} {
  let ready = 0;
  let uploading = 0;
  let failed = 0;
  for (const a of items) {
    if (a.state === "staged") ready += 1;
    else if (a.state === "uploading") uploading += 1;
    else failed += 1;
  }
  return { ready, uploading, failed };
}

/** Two trays folded into one, for the record merges in the conversation store. */
export function mergeAttachments(
  into: readonly DraftAttachment[],
  from: readonly DraftAttachment[],
): DraftAttachment[] {
  const seen = new Set(into.map((a) => a.local_id));
  return [...into, ...from.filter((a) => !seen.has(a.local_id))];
}

/** The words on the one chip that stands for every file over the per-message cap. */
const LIMIT_MESSAGE = `max ${FILES_LIMITS.attachmentsPerTurn} files per message`;
const limitName = (n: number) => `${n} more ${n === 1 ? "file" : "files"} not attached`;
const isLimit = (a: DraftAttachment) => a.error?.code === "LIMIT";

interface Job {
  target: ChatSelection;
  /** The bytes, for a drop or paste: what a retry sends again. */
  file: File | null;
  /**
   * The upload id, once the main process holds one, until a successful stage
   * consumes it. A failed or abandoned stage leaves it held (core's
   * `uploads.take()`), so whoever lets go of it discards it (`release`).
   */
  upload: string | null;
  /** Closes the `files.stage` stream while it runs. */
  closeStage: (() => void) | null;
  cancelled: boolean;
}

export interface DraftAttachmentDeps {
  get: (target: ChatSelection) => Conversation;
  changed: () => void;
  permits: (instance: string) => boolean;
  api?: AttachmentsApi;
}

export function useDraftAttachments({ get, changed, permits, api }: DraftAttachmentDeps) {
  const apiRef = useRef<AttachmentsApi>(api ?? filesApi);
  apiRef.current = api ?? filesApi;
  const jobs = useRef(new Map<string, Job>());
  const seq = useRef(0);
  const capability = useRef(new Map<string, FilesCapabilityState | "pending">());
  const controls = useRef(
    new Map<
      string,
      { items: readonly DraftAttachment[]; cap: FilesCapabilityState; control: AttachmentsControl }
    >(),
  );

  /** Replace one chip wherever its conversation's record now is (records merge). */
  const patch = useCallback(
    (target: ChatSelection, local_id: string, next: Partial<DraftAttachment>) => {
      const record = get(target);
      const at = record.attachments.findIndex((a) => a.local_id === local_id);
      if (at < 0) return false;
      const items = [...record.attachments];
      items[at] = { ...items[at]!, ...next };
      record.attachments = items;
      changed();
      return true;
    },
    [get, changed],
  );

  const add = useCallback(
    (target: ChatSelection, chip: Omit<DraftAttachment, "local_id">): string => {
      const local_id = `a${++seq.current}`;
      const record = get(target);
      record.attachments = [...record.attachments, { local_id, ...chip }];
      changed();
      return local_id;
    },
    [get, changed],
  );

  /**
   * Let go of a job's upload id: the main process frees it (best-effort). Every
   * path that ends a job without a successful stage comes through here, so an
   * upload is never left holding its share of the main process's budget.
   */
  const release = useCallback((job: Job) => {
    const upload = job.upload;
    job.upload = null;
    if (upload !== null) void apiRef.current.chunkDiscard(upload).catch(() => undefined);
  }, []);

  const fail = useCallback(
    (target: ChatSelection, local_id: string, code: string, message: string) => {
      const job = jobs.current.get(local_id);
      const chip = get(target).attachments.find((a) => a.local_id === local_id);
      if (!chip) return;
      const fromBytes = job?.file !== null && job?.file !== undefined;
      patch(target, local_id, {
        state: "error",
        error: { code, message: attachmentErrorText(code, message, chip) },
        phase: undefined,
        secretOverride: code === "FILE_LOOKS_SECRET" ? (fromBytes ? "retry" : "repick") : undefined,
        retryable: fromBytes && code !== "FILE_TOO_LARGE" && code !== "FILE_TYPE_REJECTED",
      });
      if (job) {
        job.closeStage = null;
        release(job);
      }
    },
    [get, patch, release],
  );

  /** Stage a closed upload on the box. `base` is how far the chunks already took the bar. */
  const stage = useCallback(
    (target: ChatSelection, local_id: string, upload_id: string, base: number, not_secret: boolean) => {
      const job = jobs.current.get(local_id);
      if (!job || job.cancelled) return;
      const span = 1 - base;
      const handlers: StageHandlers = {
        onProgress: (frame) => {
          if (job.cancelled) return;
          patch(target, local_id, {
            phase: frame.phase === "hash" ? "hash" : "upload",
            progress: Math.min(0.99, base + span * Math.max(0, Math.min(1, frame.progress))),
          });
        },
        onDone: (frame) => {
          job.closeStage = null;
          // Only a successful stage consumes the upload; a refusal leaves it
          // held, and `fail` (or the `remove` that cancelled it) discards it.
          if (frame.type === "staged") job.upload = null;
          if (job.cancelled) {
            release(job);
            return;
          }
          if (frame.type === "staged") {
            patch(target, local_id, {
              state: "staged",
              progress: 1,
              phase: undefined,
              file_id: frame.file.id,
              mime: frame.file.mime,
              size: frame.file.bytes,
              name: frame.file.name,
            });
            return;
          }
          fail(target, local_id, frame.code, frame.message);
        },
      };
      job.closeStage = apiRef.current.stageUpload(
        target.instance,
        upload_id,
        not_secret ? { not_secret: true } : {},
        handlers,
      );
    },
    [patch, fail, release],
  );

  /** A drop or a paste: chunks into the main process, then the stage. */
  const sendBytes = useCallback(
    async (target: ChatSelection, local_id: string, file: File, not_secret: boolean) => {
      const job = jobs.current.get(local_id);
      if (!job) return;
      const calls = apiRef.current;
      try {
        const upload_id = await sendChunks(calls, file, file.name, {
          onOpen: (id) => {
            job.upload = id;
          },
          onChunk: (sent, size) =>
            patch(target, local_id, {
              phase: "send",
              progress: size === 0 ? 0.5 : (sent / size) * 0.5,
            }),
          cancelled: () => job.cancelled,
        });
        if (upload_id === null) {
          release(job);
          return;
        }
        stage(target, local_id, upload_id, 0.5, not_secret);
      } catch (e) {
        if (job.cancelled) {
          release(job);
          return;
        }
        const code = typeof e === "object" && e !== null && "code" in e ? String(e.code) : "INTERNAL";
        fail(target, local_id, code, e instanceof Error ? e.message : String(e));
      }
    },
    [patch, stage, fail, release],
  );

  /** Slots left under the per-message cap. The one `LIMIT` chip takes none. */
  const roomFor = useCallback(
    (target: ChatSelection) =>
      FILES_LIMITS.attachmentsPerTurn - get(target).attachments.filter((a) => !isLimit(a)).length,
    [get],
  );

  /**
   * Fold `count` files that did not fit into the tray's one `LIMIT` chip,
   * minting it if there is none. `dropped` are staged ids it then answers for.
   */
  const overflow = useCallback(
    (target: ChatSelection, count: number, dropped: readonly string[] = []) => {
      if (count <= 0) return;
      const record = get(target);
      const held = record.attachments.find(isLimit);
      const n = (held?.overflow ?? 0) + count;
      const ids = [...(held?.dropped ?? []), ...dropped];
      const chip: Omit<DraftAttachment, "local_id"> = {
        name: limitName(n),
        size: 0,
        mime: "",
        state: "error",
        progress: 0,
        error: { code: "LIMIT", message: LIMIT_MESSAGE },
        overflow: n,
        ...(ids.length > 0 ? { dropped: ids } : {}),
      };
      if (held) patch(target, held.local_id, chip);
      else add(target, chip);
    },
    [get, patch, add],
  );

  const addFiles = useCallback(
    (target: ChatSelection, files: readonly File[]) => {
      if (!permits(target.instance) || capability.current.get(target.instance) === "no") return;
      let over = 0;
      for (const file of files) {
        const chip = {
          name: file.name || "pasted file",
          size: file.size,
          mime: file.type || "application/octet-stream",
          state: "uploading" as const,
          progress: 0,
        };
        if (roomFor(target) <= 0) {
          over += 1;
          continue;
        }
        if (file.size > FILES_LIMITS.chunkUploadBytes) {
          add(target, {
            ...chip,
            state: "error",
            error: {
              code: "DROP_TOO_LARGE",
              message: `use ⊕ for files over ${MB(FILES_LIMITS.chunkUploadBytes)}`,
            },
          });
          continue;
        }
        const local_id = add(target, { ...chip, phase: "send" });
        jobs.current.set(local_id, { target, file, upload: null, closeStage: null, cancelled: false });
        void sendBytes(target, local_id, file, false);
      }
      overflow(target, over);
    },
    [permits, roomFor, add, sendBytes, overflow],
  );

  /**
   * The native dialog. `notSecretFor` is the one file a "Pick again, attach
   * anyway" vouched for: only a picked file with its name and size is staged
   * with `not_secret`, never everything else chosen in the same dialog.
   */
  const pickInto = useCallback(
    async (target: ChatSelection, notSecretFor: { name: string; size: number } | null) => {
      if (!permits(target.instance) || capability.current.get(target.instance) === "no") return;
      let picked: { upload_id: string; name: string; size: number }[];
      try {
        picked = (await apiRef.current.pickNative(target.instance)).files;
      } catch (e) {
        const code = typeof e === "object" && e !== null && "code" in e ? String(e.code) : "INTERNAL";
        add(target, {
          name: "file dialog",
          size: 0,
          mime: "",
          state: "error",
          progress: 0,
          error: {
            code,
            message: attachmentErrorText(code, e instanceof Error ? e.message : String(e), {
              size: 0,
              mime: "",
            }),
          },
        });
        return;
      }
      let over = 0;
      for (const f of picked) {
        if (roomFor(target) <= 0) {
          void apiRef.current.chunkDiscard(f.upload_id).catch(() => undefined);
          over += 1;
          continue;
        }
        const local_id = add(target, {
          name: f.name,
          size: f.size,
          mime: "",
          state: "uploading",
          progress: 0,
          phase: "hash",
        });
        jobs.current.set(local_id, {
          target,
          file: null,
          upload: f.upload_id,
          closeStage: null,
          cancelled: false,
        });
        const vouched =
          notSecretFor !== null && f.name === notSecretFor.name && f.size === notSecretFor.size;
        stage(target, local_id, f.upload_id, 0, vouched);
      }
      overflow(target, over);
    },
    [permits, roomFor, add, stage, overflow],
  );

  /** Stop one job: its stage closed, its upload freed. A late answer then lands on nothing. */
  const cancel = useCallback(
    (job: Job) => {
      job.cancelled = true;
      job.closeStage?.();
      job.closeStage = null;
      release(job);
    },
    [release],
  );

  const remove = useCallback(
    (target: ChatSelection, local_id: string) => {
      const record = get(target);
      const chip = record.attachments.find((a) => a.local_id === local_id);
      record.attachments = record.attachments.filter((a) => a.local_id !== local_id);
      changed();
      const job = jobs.current.get(local_id);
      jobs.current.delete(local_id);
      const calls = apiRef.current;
      if (job) cancel(job);
      if (chip?.state === "staged" && chip.file_id) {
        void calls.filesDiscard(target.instance, chip.file_id).catch(() => undefined);
      }
      for (const id of chip?.dropped ?? []) {
        void calls.filesDiscard(target.instance, id).catch(() => undefined);
      }
    },
    [get, changed, cancel],
  );

  /**
   * Abandon every job, or every job on `instance`: their stages closed and
   * their uploads freed in the main process. The chips are the record's, and
   * go with it; a staged file is left to the box's TTL, since the box may be
   * one this page can no longer reach.
   */
  const cancelAll = useCallback(
    (instance?: string) => {
      for (const [local_id, job] of jobs.current) {
        if (instance !== undefined && job.target.instance !== instance) continue;
        jobs.current.delete(local_id);
        cancel(job);
      }
    },
    [cancel],
  );

  const retry = useCallback(
    (target: ChatSelection, local_id: string, opts: { not_secret?: boolean } = {}) => {
      const job = jobs.current.get(local_id);
      const not_secret = opts.not_secret === true;
      if (job?.file) {
        job.cancelled = false;
        patch(target, local_id, {
          state: "uploading",
          progress: 0,
          phase: "send",
          error: undefined,
          secretOverride: undefined,
          retryable: undefined,
        });
        void sendBytes(target, local_id, job.file, not_secret);
        return;
      }
      // A native pick's upload id was freed when its stage failed: pick it
      // again. Only that file, matched by name and size, is vouched for.
      const chip = get(target).attachments.find((a) => a.local_id === local_id);
      remove(target, local_id);
      void pickInto(target, not_secret && chip ? { name: chip.name, size: chip.size } : null);
    },
    [get, patch, sendBytes, remove, pickInto],
  );

  const take = useCallback(
    (target: ChatSelection): SentAttachment[] => {
      const record = get(target);
      const sent: SentAttachment[] = [];
      for (const a of record.attachments) {
        if (a.state !== "staged" || !a.file_id) continue;
        sent.push({ file_id: a.file_id, name: a.name, size: a.size, mime: a.mime });
        jobs.current.delete(a.local_id);
      }
      record.attachments = record.attachments.filter((a) => a.state !== "staged");
      changed();
      return sent;
    },
    [get, changed],
  );

  const restore = useCallback(
    (target: ChatSelection, sent: readonly SentAttachment[]) => {
      if (sent.length === 0) return;
      const record = get(target);
      const held = new Set(record.attachments.map((a) => a.file_id));
      const fresh = sent.filter((s) => !held.has(s.file_id));
      const room = Math.max(0, roomFor(target));
      const back = fresh.slice(0, room).map<DraftAttachment>((s) => ({
        local_id: `a${++seq.current}`,
        name: s.name,
        size: s.size,
        mime: s.mime,
        state: "staged",
        progress: 1,
        file_id: s.file_id,
      }));
      record.attachments = [...back, ...record.attachments];
      changed();
      // What did not fit is still staged on the box: one chip says so, and
      // removing it deletes them there.
      const rest = fresh.slice(room);
      overflow(
        target,
        rest.length,
        rest.map((s) => s.file_id),
      );
    },
    [get, changed, roomFor, overflow],
  );

  const discard = useCallback((target: ChatSelection, sent: readonly SentAttachment[]) => {
    for (const s of sent) {
      void apiRef.current.filesDiscard(target.instance, s.file_id).catch(() => undefined);
    }
  }, []);

  const probe = useCallback(
    (instance: string) => {
      if (!permits(instance) || capability.current.has(instance)) return;
      capability.current.set(instance, "pending");
      apiRef.current
        .filesCapability(instance)
        .then((answer) => {
          capability.current.set(instance, answer.files ? "yes" : "no");
          changed();
        })
        .catch(() => {
          // An unreachable box is not a box without the service: leave the
          // button live, and let a stage say what went wrong. Asked again later.
          capability.current.delete(instance);
        });
    },
    [permits, changed],
  );

  /** One control per conversation, identity-stable until its chips or capability move. */
  const forTarget = useCallback(
    (target: ChatSelection): AttachmentsControl => {
      const record = get(target);
      const k = key(target);
      const raw = capability.current.get(target.instance);
      const cap: FilesCapabilityState = raw === "yes" || raw === "no" ? raw : "unknown";
      const items = record.attachments.length === 0 ? NO_ITEMS : record.attachments;
      const cached = controls.current.get(k);
      if (cached && cached.items === items && cached.cap === cap) return cached.control;
      const control: AttachmentsControl = {
        items,
        capability: cap,
        probe: () => probe(target.instance),
        addFiles: (files) => addFiles(target, files),
        pick: () => void pickInto(target, null),
        remove: (id) => remove(target, id),
        retry: (id, opts) => retry(target, id, opts),
        take: () => take(target),
        restore: (sent) => restore(target, sent),
        discard: (sent) => discard(target, sent),
      };
      controls.current.set(k, { items, cap, control });
      return control;
    },
    [get, probe, addFiles, pickInto, remove, retry, take, restore, discard],
  );

  return { forTarget, cancelAll };
}

/* ── the sent message's chips ────────────────────────────────────────────── */

/** Where a local echo's file stands: the box has not, has, or never took the turn. */
export type AttachmentDelivery = "sending" | "delivered" | "failed";

/**
 * An attachment block as the page holds it: core's block (`file_id`/`sha256`
 * set for a file that went through the files service, `href` then a box path
 * and never a URL), plus the local echo's `delivery`, which only the page
 * writes and core never sends.
 */
export type LocalAttachmentBlock = ChatBlockOf<"attachment"> & { delivery?: AttachmentDelivery };

/** The local echo's delivery state, or `null` for a block core sent. */
export function attachmentDelivery(block: ChatBlockOf<"attachment">): AttachmentDelivery | null {
  const d = (block as LocalAttachmentBlock).delivery;
  return d === "sending" || d === "delivered" || d === "failed" ? d : null;
}

/** The echo's block for one sent file. */
export function localAttachmentBlock(
  a: SentAttachment,
  delivery: AttachmentDelivery,
): LocalAttachmentBlock {
  return {
    kind: "attachment",
    name: a.name,
    mime: a.mime || "application/octet-stream",
    bytes: a.size,
    href: a.file_id,
    file_id: a.file_id,
    delivery,
  };
}

/** Move a local echo's chips to `state`. */
export function markDelivery(record: Conversation, id: string, state: AttachmentDelivery): void {
  record.messages = record.messages.map((m) =>
    m.id !== id
      ? m
      : {
          ...m,
          blocks: m.blocks.map((b) =>
            b.kind === "attachment" && attachmentDelivery(b) !== null
              ? ({ ...b, delivery: state } satisfies LocalAttachmentBlock)
              : b,
          ),
        },
  );
}
