/**
 * One request card's delivery: bytes into the main process, then `files.put`
 * (attachments plan §8.3). Three ways in — a dropped or pasted `File`, an
 * upload the native dialog already registered, or the operator's text secret
 * as bytes — and one stream out, which the card can cancel.
 *
 * The state names no file and holds no bytes: a card's render shows progress
 * and the box's refusal, and nothing here is logged. Text-secret bytes are
 * zeroed once the put ends, success or not — with one exception. A durable
 * secret whose SSM slot already holds one is refused until the operator says
 * to replace it (`replace_slot` on the error); the source is then held in a
 * ref (the `File`, the native pick's upload, or the text's bytes) only until
 * the operator answers: "Replace" sends it again with `replace`, "Cancel"
 * zeroes or discards it. Starting anything else, unmounting, or the slot
 * closing under the question (the card calls `keep`) discards it too.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import * as filesApi from "../api/files.ts";
import type { PutOptions } from "../api/files.ts";
import { putStream, toBase64 } from "./upload.ts";

export type PutState =
  | { phase: "idle" }
  | { phase: "uploading"; progress: number; sent: number; total: number }
  | {
      phase: "error";
      code: string;
      message: string;
      /** The durable slot that already holds a secret: ask before replacing it. */
      replace_slot?: string;
    };

export type PutApi = Pick<
  typeof filesApi,
  "uploadOpen" | "secretTextUpload" | "uploadDiscard" | "putUpload"
>;

/** What a job sends, kept so a "Replace" can send it again. */
type Source =
  | { kind: "file"; file: File }
  | { kind: "bytes"; bytes: Uint8Array; name: string }
  | { kind: "upload"; upload_id: string; size: number };

interface Job {
  cancelled: boolean;
  /** An upload this card opened and has not handed to a put yet. */
  upload: string | null;
  close: (() => void) | null;
  /** Aborts the file's PUT to the upload port while it runs. */
  abortSend?: (() => void) | null;
  /** The job's source and options, until it ends; text bytes are zeroed then. */
  source: Source | null;
  opts: PutOptions;
}

export interface FilePut {
  state: PutState;
  /** A drop or a paste: the page PUTs the file to the loopback upload port while the put reads it. */
  putFile: (file: File, opts?: PutOptions) => void;
  /** A native pick: the main process already holds the bytes. */
  putUpload: (upload_id: string, size: number, opts?: PutOptions) => void;
  /** A text secret. `bytes` is zeroed once the put ends (or the replace question is answered). */
  putBytes: (bytes: Uint8Array, name: string, opts?: PutOptions) => void;
  cancel: () => void;
  /** Forget a refusal (the operator is about to try again). */
  clear: () => void;
  /** "Replace": send the held source again, with `replace`. */
  replace: () => void;
  /** "Cancel" on the replace question: the held source is zeroed or discarded. */
  keep: () => void;
}

const codeOf = (e: unknown): string =>
  typeof e === "object" && e !== null && "code" in e ? String(e.code) : "INTERNAL";

export function useFilePut(
  instance: string,
  request_id: string,
  /** The put ended, however it ended: the card re-reads the slot. */
  onSettled: () => void,
  api: PutApi = filesApi,
): FilePut {
  const [state, setState] = useState<PutState>({ phase: "idle" });
  const job = useRef<Job | null>(null);
  /** A source held for the replace question, and nothing else. */
  const asking = useRef<{ source: Source; opts: PutOptions } | null>(null);
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;
  const apiRef = useRef(api);
  apiRef.current = api;

  const discard = (current: Job): void => {
    const upload = current.upload;
    current.upload = null;
    if (upload !== null) void apiRef.current.uploadDiscard(upload).catch(() => undefined);
  };

  /** A source nobody will send again: text zeroed, a native pick discarded. */
  const drop = (source: Source | null): void => {
    if (source?.kind === "bytes") source.bytes.fill(0);
    if (source?.kind === "upload")
      void apiRef.current.uploadDiscard(source.upload_id).catch(() => undefined);
  };

  /** Ends a job's hold on its source. A native pick's upload is the job's own `upload` to discard. */
  const release = (current: Job): void => {
    const source = current.source;
    current.source = null;
    if (source?.kind === "bytes") source.bytes.fill(0);
  };

  /** Lets go of a source held for the replace question. */
  const forgetAsk = (): void => {
    const held = asking.current;
    asking.current = null;
    drop(held?.source ?? null);
  };

  const fail = useCallback((current: Job, code: string, message: string, replace_slot?: string) => {
    if (job.current !== current) return;
    job.current = null;
    current.abortSend?.();
    current.abortSend = null;
    if (replace_slot !== undefined && current.source !== null) {
      // Held for the operator's answer. Core kept a native pick registered
      // for this (a path, no bytes); a page upload it forgot, and the page
      // sends the `File` or the bytes again.
      if (current.source.kind === "upload") current.upload = null;
      asking.current = { source: current.source, opts: current.opts };
      current.source = null;
    }
    discard(current);
    release(current);
    setState({
      phase: "error",
      code,
      message,
      ...(replace_slot !== undefined && asking.current !== null ? { replace_slot } : {}),
    });
    settledRef.current();
  }, []);

  /** The second half of every path: the upload is the box's to read. */
  const put = useCallback(
    (current: Job, upload_id: string, total: number, from: number) => {
      current.upload = upload_id;
      setState({ phase: "uploading", progress: from, sent: Math.round(total * from), total });
      current.close = apiRef.current.putUpload(instance, request_id, upload_id, current.opts, {
        onProgress: (frame) => {
          if (job.current !== current) return;
          const p = Math.min(1, Math.max(0, frame.progress ?? 0));
          const progress = from + (1 - from) * p;
          setState({ phase: "uploading", progress, sent: Math.round(total * progress), total });
        },
        onDone: (frame) => {
          if (job.current !== current) return;
          if (frame.type === "error") {
            fail(current, frame.code, frame.message, frame.replace_slot);
            return;
          }
          // The box consumed the upload; there is nothing left to discard.
          current.upload = null;
          current.abortSend = null;
          job.current = null;
          release(current);
          setState({ phase: "idle" });
          settledRef.current();
        },
      });
    },
    [instance, request_id, fail],
  );

  /** Stops a job: its stream closed, its upload discarded. Never settles. */
  const stop = (current: Job): void => {
    current.cancelled = true;
    current.close?.();
    current.close = null;
    current.abortSend?.();
    current.abortSend = null;
    discard(current);
    release(current);
  };

  /** A new job replaces the one in flight, which is stopped rather than orphaned. */
  const start = (source: Source, opts: PutOptions): Job => {
    const previous = job.current;
    const current: Job = { cancelled: false, upload: null, close: null, source, opts };
    job.current = current;
    if (previous !== null) stop(previous);
    return current;
  };

  const sendThenPut = useCallback(
    async (source: Extract<Source, { kind: "file" | "bytes" }>, opts: PutOptions) => {
      const current = start(source, opts);
      if (source.kind === "file") {
        const file = source.file;
        setState({ phase: "uploading", progress: 0, sent: 0, total: file.size });
        try {
          const { upload_id, url } = await apiRef.current.uploadOpen(file.name, file.size);
          current.upload = upload_id;
          if (current.cancelled || job.current !== current) {
            discard(current);
            release(current);
            return;
          }
          // The put reads the upload as the PUT writes it: one pipe, page to box.
          put(current, upload_id, file.size, 0);
          const abort = new AbortController();
          current.abortSend = () => abort.abort();
          putStream(url, file, abort.signal).catch((e: unknown) => {
            // A put that has answered owns the outcome (`fail` ignores a stale job).
            if (current.cancelled || job.current !== current) return;
            current.close?.();
            current.close = null;
            fail(current, codeOf(e), e instanceof Error ? e.message : String(e));
          });
        } catch (e) {
          if (current.cancelled) {
            discard(current);
            release(current);
            return;
          }
          fail(current, codeOf(e), e instanceof Error ? e.message : String(e));
        }
        return;
      }
      const body = source.bytes;
      const name = source.name;
      const total = body.byteLength;
      setState({ phase: "uploading", progress: 0, sent: 0, total });
      try {
        const { upload_id } = await apiRef.current.secretTextUpload(name, toBase64(body));
        current.upload = upload_id;
        // A cancellation during the RPC still needs to discard its newly returned id.
        if (current.cancelled || job.current !== current) {
          discard(current);
          release(current);
          return;
        }
        put(current, upload_id, total, 0);
      } catch (e) {
        if (current.cancelled) {
          discard(current);
          release(current);
          return;
        }
        fail(current, codeOf(e), e instanceof Error ? e.message : String(e));
      }
    },
    [put, fail],
  );

  const putFile = useCallback(
    (file: File, opts: PutOptions = {}) => {
      forgetAsk();
      void sendThenPut({ kind: "file", file }, opts);
    },
    [sendThenPut],
  );

  const putUpload = useCallback(
    (upload_id: string, size: number, opts: PutOptions = {}) => {
      forgetAsk();
      put(start({ kind: "upload", upload_id, size }, opts), upload_id, size, 0);
    },
    [put],
  );

  const putBytes = useCallback(
    (bytes: Uint8Array, name: string, opts: PutOptions = {}) => {
      forgetAsk();
      void sendThenPut({ kind: "bytes", bytes, name }, opts);
    },
    [sendThenPut],
  );

  const replace = useCallback(() => {
    const held = asking.current;
    asking.current = null;
    if (held === null) return;
    const opts: PutOptions = { ...held.opts, replace: true };
    const source = held.source;
    if (source.kind === "upload") {
      put(start(source, opts), source.upload_id, source.size, 0);
    } else {
      void sendThenPut(source, opts);
    }
  }, [put, sendThenPut]);

  const keep = useCallback(() => {
    forgetAsk();
    setState((s) => (s.phase === "error" ? { phase: "idle" } : s));
  }, []);

  const cancel = useCallback(() => {
    const current = job.current;
    if (current === null) return;
    job.current = null;
    stop(current);
    setState({ phase: "idle" });
    settledRef.current();
  }, []);

  const clear = useCallback(() => {
    forgetAsk();
    setState((s) => (s.phase === "error" ? { phase: "idle" } : s));
  }, []);

  // A card that unmounts mid-upload stops it: nobody is left to show its end.
  // Anything held for the replace question goes with it.
  useEffect(
    () => () => {
      forgetAsk();
      const current = job.current;
      if (current === null) return;
      job.current = null;
      stop(current);
    },
    [],
  );

  return { state, putFile, putUpload, putBytes, cancel, clear, replace, keep };
}

/**
 * A card shows the replace question only while its slot is live. Should the
 * slot close under it (expired, declined, answered elsewhere), nobody is left
 * to press Cancel: the held source is let go here instead — text zeroed, a
 * native pick's upload discarded — rather than when the card unmounts.
 */
export function useLetGoWhenClosed(live: boolean, put: FilePut): void {
  const asking = put.state.phase === "error" && put.state.replace_slot !== undefined;
  const keep = put.keep;
  useEffect(() => {
    if (!live && asking) keep();
  }, [live, asking, keep]);
}
