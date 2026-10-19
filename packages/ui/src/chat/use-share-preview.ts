/**
 * The inline picture, player or text of a file the agent shared (attachments
 * plan §8.5).
 *
 * The bytes come over the same `files.content` machinery a staged file's
 * thumbnail uses — read by the main process for one purpose (an image to show,
 * audio or video to play, text to show), each under its own cap and refused
 * for any other type — and are drawn from a `blob:` URL this page minted
 * (`page-blob-urls.ts`), the only kind `safeImageSrc` lets an `<img>` load and
 * `safeMediaSrc` lets an `<audio>` or `<video>` load. Text is decoded here and
 * drawn as text, never as markup.
 *
 * Fail closed: bytes are drawn only when the share names its full 64-hex
 * sha256 and the main process verifies the received bytes against it. A
 * share naming no digest, or only a short prefix of one, is never read for a
 * preview — Save… still works, and core verifies what it saves. A digest that
 * is neither is malformed and reads as a mismatch: a file the box altered
 * after sharing is not the file the agent shared. The URL is the card's own,
 * pinned while it is drawn and revoked when the card leaves.
 */
import { useEffect, useState } from "react";
import type { ContentPurpose } from "@hermetic/core/shared";
import { filesContent } from "../api/files.ts";
import { mintBlobUrl, pinBlobUrl, revokeBlobUrl } from "./page-blob-urls.ts";
import { readVerifiedBytes } from "./verified-image.ts";

export type SharePreview =
  | { state: "loading" }
  | { state: "ready"; url: string }
  /** The received bytes do not hash to the shared sha256, or the sha256 is malformed. */
  | { state: "mismatch" }
  /** The share names no full sha256 (none, or a short prefix): nothing to verify against. */
  | { state: "unverified" }
  /** The box no longer has the share (`FILE_NOT_FOUND`): past its TTL. */
  | { state: "gone" }
  /** Over what the page reads for this purpose (`FILE_TOO_LARGE`): Save… instead. */
  | { state: "too_large" }
  | { state: "failed" };

/** A refusal's code, as the bridge carries it. */
function codeOf(e: unknown): string {
  return typeof e === "object" && e !== null && "code" in e ? String(e.code) : "";
}

/** The settled state a failed read leaves the card in. */
function failure(e: unknown): { state: "gone" | "mismatch" | "too_large" | "failed" } {
  switch (codeOf(e)) {
    case "FILE_NOT_FOUND":
      return { state: "gone" };
    case "FILE_DIGEST_MISMATCH":
      return { state: "mismatch" };
    case "FILE_TOO_LARGE":
      return { state: "too_large" };
    default:
      return { state: "failed" };
  }
}

const FULL_SHA256 = /^[0-9a-f]{64}$/;
/** A short prefix of a digest — what a chip may carry when the listing was cut short. */
const PREFIX_SHA256 = /^[0-9a-f]{1,63}$/;

/** What a share's `sha256` lets the preview do: verify against it, refuse, or not draw at all. */
export function previewDigest(
  sha256: string | null,
): { kind: "full"; hex: string } | { kind: "unverified" } | { kind: "malformed" } {
  if (sha256 === null || sha256 === "") return { kind: "unverified" };
  const hex = sha256.toLowerCase();
  if (FULL_SHA256.test(hex)) return { kind: "full", hex };
  if (PREFIX_SHA256.test(hex)) return { kind: "unverified" };
  return { kind: "malformed" };
}

/**
 * `null` when there is nothing to draw: no box, or no `purpose` (a share that
 * is neither an image nor audio or video). Only a full 64-hex `sha256` lets
 * the bytes be read and drawn (`previewDigest`).
 */
export function useSharePreview(
  instance: string | null,
  id: string,
  purpose: Extract<ContentPurpose, "image" | "playback"> | null,
  sha256: string | null,
  read: typeof filesContent = filesContent,
): SharePreview | null {
  const active = purpose !== null && instance !== null;
  const [preview, setPreview] = useState<SharePreview>({ state: "loading" });
  useEffect(() => {
    if (purpose === null || instance === null) return;
    const digest = previewDigest(sha256);
    if (digest.kind === "unverified") {
      setPreview({ state: "unverified" });
      return;
    }
    if (digest.kind === "malformed") {
      setPreview({ state: "mismatch" });
      return;
    }
    const expected = digest.hex;
    let live = true;
    let url: string | null = null;
    let unpin: () => void = () => undefined;
    setPreview({ state: "loading" });
    // An image keeps the request it always made; the default purpose is the image's.
    readVerifiedBytes(instance, id, expected, purpose === "image" ? undefined : purpose, read)
      .then((blob) => {
        if (!live) return;
        const minted = mintBlobUrl(blob, () => {
          // Evicted to make room: read it again rather than draw a dead URL.
          if (live && url === minted) {
            url = null;
            setPreview({ state: "failed" });
          }
        });
        url = minted;
        unpin = pinBlobUrl(minted);
        setPreview({ state: "ready", url: minted });
      })
      .catch((e: unknown) => {
        if (live) setPreview(failure(e));
      });
    return () => {
      live = false;
      unpin();
      if (url !== null) revokeBlobUrl(url);
      url = null;
    };
  }, [purpose, instance, id, sha256, read]);
  return active ? preview : null;
}

/** A text share's contents, or why there are none to show. */
export type ShareText =
  | { state: "loading" }
  | { state: "ready"; text: string }
  | Exclude<SharePreview, { state: "loading" } | { state: "ready"; url: string }>;

/**
 * The contents of a text share, read only while `open` (the card's Preview is
 * pressed) and under the same digest rule as a picture. `null` while closed or
 * with no box.
 */
export function useShareText(
  instance: string | null,
  id: string,
  open: boolean,
  sha256: string | null,
  read: typeof filesContent = filesContent,
): ShareText | null {
  const active = open && instance !== null;
  const [text, setText] = useState<ShareText>({ state: "loading" });
  useEffect(() => {
    if (!open || instance === null) return;
    const digest = previewDigest(sha256);
    if (digest.kind === "unverified") {
      setText({ state: "unverified" });
      return;
    }
    if (digest.kind === "malformed") {
      setText({ state: "mismatch" });
      return;
    }
    let live = true;
    setText({ state: "loading" });
    readVerifiedBytes(instance, id, digest.hex, "text", read)
      .then((blob) => blob.arrayBuffer())
      .then((buffer) => {
        if (live) setText({ state: "ready", text: new TextDecoder("utf-8").decode(buffer) });
      })
      .catch((e: unknown) => {
        if (live) setText(failure(e));
      });
    return () => {
      live = false;
    };
  }, [open, instance, id, sha256, read]);
  return active ? text : null;
}
