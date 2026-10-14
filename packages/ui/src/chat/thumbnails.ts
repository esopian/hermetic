/**
 * Thumbnails of files the operator sent, read back from the box
 * (`files.content`) and drawn from a `blob:` URL this page minted
 * (`page-blob-urls.ts`). One read per file per page, shared by every chip that
 * shows it, keyed by fleet, box and file.
 *
 * A chip pins its URL while it is mounted, so the registry never revokes a
 * picture on screen. An unpinned URL the registry evicts forgets its entry and
 * tells every chip still subscribed, which reads it again. `expired` (the box
 * no longer has the file) is final; `failed` is retried after
 * `FAILED_RETRY_MS`, since the box may only have been unreachable.
 */
import { useEffect, useState } from "react";
import { filesContent } from "../api/files.ts";
import { mintBlobUrl, pinBlobUrl } from "./page-blob-urls.ts";

export type Thumbnail =
  | { state: "loading" }
  | { state: "ready"; url: string }
  /** The box no longer has the file (`FILE_NOT_FOUND`): past its TTL. */
  | { state: "expired" }
  | { state: "failed" };

const LOADING: Thumbnail = { state: "loading" };
const DEFAULT_FAILED_RETRY_MS = 30_000;
let failedRetryMs = DEFAULT_FAILED_RETRY_MS;

const cache = new Map<string, Thumbnail>();
/** When each `failed` entry failed, so a later mount can read it again. */
const failedAt = new Map<string, number>();
/** Every mounted chip per key, told when its entry settles or is evicted. */
const listeners = new Map<string, Set<() => void>>();

type Fetch = typeof filesContent;

function decode(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function notify(k: string): void {
  for (const tell of [...(listeners.get(k) ?? [])]) tell();
}

function settle(k: string, t: Thumbnail): void {
  cache.set(k, t);
  if (t.state === "failed") failedAt.set(k, Date.now());
  else failedAt.delete(k);
  notify(k);
}

/** A `failed` entry past its retry delay is no entry at all. */
function current(k: string): Thumbnail | undefined {
  const held = cache.get(k);
  if (held?.state === "failed" && Date.now() - (failedAt.get(k) ?? 0) >= failedRetryMs) {
    cache.delete(k);
    failedAt.delete(k);
    return undefined;
  }
  return held;
}

function load(k: string, instance: string, file_id: string, read: Fetch): void {
  cache.set(k, LOADING);
  read(instance, file_id).then(
    ({ mime, data_b64 }) => {
      const blob = new Blob([decode(data_b64)], { type: mime });
      let url = "";
      url = mintBlobUrl(blob, () => {
        const held = cache.get(k);
        if (held?.state === "ready" && held.url === url) {
          cache.delete(k);
          notify(k);
        }
      });
      settle(k, { state: "ready", url });
    },
    (e: unknown) => {
      const code = typeof e === "object" && e !== null && "code" in e ? String(e.code) : "";
      settle(k, code === "FILE_NOT_FOUND" ? { state: "expired" } : { state: "failed" });
    },
  );
}

/** `null` when there is nothing to read: no box, no file, or not an image. */
export function useThumbnail(
  instance: string | null,
  file_id: string | null,
  fleet = "",
  read: Fetch = filesContent,
): Thumbnail | null {
  const k = instance && file_id ? `${fleet}\u0000${instance}\u0000${file_id}` : null;
  const [tick, rerender] = useState(0);
  // Subscribe for as long as the chip is mounted, and read whatever is missing.
  // `tick` moves on every notice, so an eviction comes back through here.
  useEffect(() => {
    if (k === null || instance === null || file_id === null) return;
    const tell = () => rerender((n) => n + 1);
    const set = listeners.get(k) ?? new Set();
    set.add(tell);
    listeners.set(k, set);
    if (!current(k)) load(k, instance, file_id, read);
    return () => {
      set.delete(tell);
      if (set.size === 0 && listeners.get(k) === set) listeners.delete(k);
    };
  }, [k, instance, file_id, read, tick]);
  const held = k === null ? null : (current(k) ?? LOADING);
  const url = held?.state === "ready" ? held.url : null;
  // A URL on screen is pinned until this chip lets go of it.
  useEffect(() => (url ? pinBlobUrl(url) : undefined), [url]);
  // A failure is asked again once its delay has passed, without a frame.
  const failed = held?.state === "failed";
  useEffect(() => {
    if (!failed || k === null) return;
    const wait = Math.max(0, failedRetryMs - (Date.now() - (failedAt.get(k) ?? 0)));
    const timer = setTimeout(() => rerender((n) => n + 1), wait + 1);
    return () => clearTimeout(timer);
  }, [failed, k]);
  return held;
}

/** Test seam: forget every thumbnail, and optionally shorten the `failed` retry. */
export function resetThumbnails(opts: { failedRetryMs?: number } = {}): void {
  cache.clear();
  failedAt.clear();
  listeners.clear();
  failedRetryMs = opts.failedRetryMs ?? DEFAULT_FAILED_RETRY_MS;
}
