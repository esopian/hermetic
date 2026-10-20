/**
 * An image pasted into the composer, as a file in the draft's tray.
 *
 * React Native's `TextInput` pastes text only: on iOS its `UITextView` takes
 * strings from the pasteboard and nothing about an image reaches JS. The
 * composer pastes an image through `expo-clipboard`'s `ClipboardPasteButton`
 * (iOS's `UIPasteControl`, which reads the pasteboard without the "allow
 * paste" prompt) instead, and hands what it answers here: a `data:` URI and
 * the picture's size. `pasteAttachments` checks it, has the base64 written to the
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

/** A base64 `data:` URI's type and base64 text, or `null` when it is not one (or holds nothing). */
export function decodeDataUri(uri: string): { mime: string; base64: string } | null {
  const match = /^data:([^;,]+)(?:;[^;,]*)*;base64,(.*)$/s.exec(uri);
  const base64 = (match?.[2] ?? "").replace(/\s+/g, "");
  if (!match || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 === 1) return null;
  return { mime: (match[1] ?? "").toLowerCase(), base64 };
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
 * image whose data does not decode). `write` decodes the base64 into a file
 * under a name and answers the file's URI and size.
 */
export async function pasteAttachments(
  payload: PastePayload,
  write: (name: string, base64: string) => Promise<{ uri: string; size: number }>,
  now: () => Date = () => new Date(),
): Promise<PendingAttachment[]> {
  if (payload.type !== "image") return [];
  const decoded = decodeDataUri(payload.data);
  if (!decoded) return [];
  const name = pastedName(decoded.mime, now());
  const { uri, size } = await write(name, decoded.base64);
  return [
    pendingAttachment({
      name,
      uri,
      mime: decoded.mime,
      size,
      kind: isImageMime(decoded.mime) ? "image" : "file",
    }),
  ];
}
