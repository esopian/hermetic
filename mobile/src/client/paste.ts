/**
 * An image pasted into the composer, as a file in the draft's tray.
 *
 * React Native's `TextInput` pastes text only: on iOS its `UITextView` takes
 * strings from the pasteboard and nothing about an image reaches JS. The
 * composer pastes an image through `expo-clipboard`'s `ClipboardPasteButton`
 * (iOS's `UIPasteControl`, which reads the pasteboard without the "allow
 * paste" prompt) instead, and hands what it answers here: a `data:` URI and
 * the picture's size. `pasteAttachments` decodes it, writes the bytes to the
 * cache (`write`, `writeToCache` in `pick-attachment.ts` on the device) so the
 * entry has a `file://` URI like any picked photo, and answers the tray entry.
 * Text answers nothing: the field pastes text itself.
 *
 * Pure: no React, no Expo, so the fixture kit (built under Bun by the root
 * seam tests) can hand the same shape to the same path.
 */
import { isImageMime } from "@hermetic/core/shared";
import { type PendingAttachment, pendingAttachment } from "./attachments.ts";

/** What the paste control answers for an image (`expo-clipboard`'s `ImagePasteEvent`). */
export interface PastedImage {
  type: "image";
  /** A `data:image/…;base64,…` URI. */
  data: string;
  size: { width: number; height: number };
}

/** Either thing the paste control can answer (`expo-clipboard`'s `PasteEventPayload`). */
export type PastePayload = PastedImage | { type: "text"; text: string };

/**
 * How the paste control encodes the picture. JPEG, like the photo pickers'
 * "compatible" representation: a pasted camera photo as PNG can pass the
 * image cap, and Hermes reads either.
 */
export const PASTE_IMAGE_OPTIONS = { format: "jpeg", jpegQuality: 0.9 } as const;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

/** Standard base64 (padding optional, whitespace ignored) to bytes; `null` on anything else. */
export function fromBase64(text: string): Uint8Array | null {
  const clean = text.replace(/\s+/g, "").replace(/=+$/, "");
  if (clean.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let j = 0;
  for (const c of clean) {
    const v = B64_INDEX.get(c);
    if (v === undefined) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[j++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

/** A base64 `data:` URI's type and bytes, or `null` when it is not one. */
export function decodeDataUri(uri: string): { mime: string; bytes: Uint8Array } | null {
  const match = /^data:([^;,]+)(?:;[^;,]*)*;base64,(.*)$/s.exec(uri);
  if (!match) return null;
  const bytes = fromBase64(match[2] ?? "");
  return bytes ? { mime: (match[1] ?? "").toLowerCase(), bytes } : null;
}

const EXT_FOR_MIME: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** A pasted picture's file name: when it was pasted, with the extension its bytes call for. */
export function pastedName(mime: string, at: Date): string {
  const stamp = at.toISOString().replace(/\D/g, "").slice(0, 17);
  return `pasted-${stamp}.${EXT_FOR_MIME[mime] ?? "img"}`;
}

/**
 * The tray entries a paste adds: one for an image, none for text (or for an
 * image whose data does not decode). `write` stores the bytes under a name
 * and answers the file's URI.
 */
export async function pasteAttachments(
  payload: PastePayload,
  write: (name: string, bytes: Uint8Array) => Promise<string>,
  now: () => Date = () => new Date(),
): Promise<PendingAttachment[]> {
  if (payload.type !== "image") return [];
  const decoded = decodeDataUri(payload.data);
  if (!decoded || decoded.bytes.byteLength === 0) return [];
  const name = pastedName(decoded.mime, now());
  const uri = await write(name, decoded.bytes);
  return [
    pendingAttachment({
      name,
      uri,
      mime: decoded.mime,
      size: decoded.bytes.byteLength,
      kind: isImageMime(decoded.mime) ? "image" : "file",
    }),
  ];
}
