/**
 * The inline picture of an image the agent shared (attachments plan §8.5).
 *
 * The bytes come over the same `files.content` machinery a staged file's
 * thumbnail uses — images only, under the preview cap, read by the main
 * process — and are drawn from a `blob:` URL this page minted
 * (`page-blob-urls.ts`), the only kind `safeImageSrc` lets an `<img>` load.
 *
 * Fail closed: a picture is drawn only when the share names its full 64-hex
 * sha256 and the main process verifies the received bytes against it. A
 * share naming no digest, or only a short prefix of one, is never read for a
 * preview — Save… still works, and core verifies what it saves. A digest that
 * is neither is malformed and reads as a mismatch: a picture the box altered
 * after sharing is not the picture the agent shared. The URL is the card's
 * own, pinned while it is drawn and revoked when the card leaves.
 */
import { useEffect, useState } from "react";
import { filesContent } from "../api/files.ts";
import { mintBlobUrl, pinBlobUrl, revokeBlobUrl } from "./page-blob-urls.ts";
import { readVerifiedImage } from "./verified-image.ts";

export type SharePreview =
  | { state: "loading" }
  | { state: "ready"; url: string }
  /** The received bytes do not hash to the shared sha256, or the sha256 is malformed. */
  | { state: "mismatch" }
  /** The share names no full sha256 (none, or a short prefix): nothing to verify against. */
  | { state: "unverified" }
  /** The box no longer has the share (`FILE_NOT_FOUND`): past its TTL. */
  | { state: "gone" }
  | { state: "failed" };

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
 * `null` when there is nothing to draw: no box, or not an image. Only a full
 * 64-hex `sha256` lets the bytes be read and drawn (`previewDigest`).
 */
export function useSharePreview(
  instance: string | null,
  id: string,
  image: boolean,
  sha256: string | null,
  read: typeof filesContent = filesContent,
): SharePreview | null {
  const active = image && instance !== null;
  const [preview, setPreview] = useState<SharePreview>({ state: "loading" });
  useEffect(() => {
    if (!active || instance === null) return;
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
    readVerifiedImage(instance, id, expected, read)
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
        if (!live) return;
        const code = typeof e === "object" && e !== null && "code" in e ? String(e.code) : "";
        setPreview(
          code === "FILE_NOT_FOUND"
            ? { state: "gone" }
            : code === "FILE_DIGEST_MISMATCH"
              ? { state: "mismatch" }
              : { state: "failed" },
        );
      });
    return () => {
      live = false;
      unpin();
      if (url !== null) revokeBlobUrl(url);
      url = null;
    };
  }, [active, instance, id, sha256, read]);
  return active ? preview : null;
}
