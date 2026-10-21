/**
 * The device side of attaching a file: the photo library, the camera, the
 * Files picker, and reading a picked file's bytes. Every Expo import the
 * attachments path needs is here and nowhere else, so tests mock this one
 * module (or the three Expo modules under it) and the rest stays pure
 * (`attachments.ts`).
 *
 * Each picker answers `PickedFile`s, or nothing when the operator cancelled.
 * Photos come back in the most compatible representation (JPEG rather than
 * HEIC): Hermes's image tool reads PNG, JPEG, GIF and WebP only
 * (`isImageMime`).
 *
 * Every picker leaves its own copy of the file in the app's cache (the
 * document picker because it is told to, so the bytes outlive the picker; the
 * image picker always). The chat screen deletes a copy when its file leaves
 * the tray: sent, removed, or left behind when the screen goes
 * (`discardPicked`); `stageAll`'s `discard` deletes it once read instead. A
 * picked private key must not sit in the cache for good.
 */
import type { ErrorCode } from "@hermetic/core/chat-client";
import { isImageMime } from "@hermetic/core/shared";
import * as DocumentPicker from "expo-document-picker";
import { File, Paths } from "expo-file-system";
import * as ImagePicker from "expo-image-picker";
import type { PickedFile } from "./attachments.ts";
import { ATTACHMENTS_PER_TURN } from "./attachments.ts";
import { HermeticError, PERMISSION_DENIED } from "./errors.ts";

/** The last path segment of a URI, decoded, or `fallback` when it has none. */
function baseName(uri: string, fallback: string): string {
  const last = uri.split(/[?#]/)[0]?.split("/").pop() ?? "";
  try {
    return decodeURIComponent(last) || fallback;
  } catch {
    return last || fallback;
  }
}

const EXT_FOR_MIME: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

/**
 * A photo's name: the library's own, else the URI's. When the picker converted
 * the photo (a `.HEIC` handed back as JPEG), the extension follows the bytes.
 */
export function photoName(
  fileName: string | null | undefined,
  uri: string,
  mime: string | undefined,
): string {
  const name = fileName || baseName(uri, "photo.jpg");
  const ext = mime ? EXT_FOR_MIME[mime.toLowerCase()] : undefined;
  if (!ext) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const have = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (have === ext || (ext === "jpg" && have === "jpeg")) return name;
  return `${stem}.${ext}`;
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

/**
 * Whether the file counts against the image cap: its type says a raster image
 * Hermes reads, else (no type given) its extension does. The box sniffs the
 * bytes again; this only sizes the check made before they are read.
 */
export function kindOf(name: string, mime: string | undefined): PickedFile["kind"] {
  if (mime) return isImageMime(mime) ? "image" : "file";
  const dot = name.lastIndexOf(".");
  return dot > 0 && IMAGE_EXTS.has(name.slice(dot + 1).toLowerCase()) ? "image" : "file";
}

/** The file's size: the picker's word for it, else the file system's (`0` when neither knows). */
function sizeOf(uri: string, reported: number | null | undefined): number {
  if (typeof reported === "number" && reported > 0) return reported;
  try {
    return new File(uri).size ?? 0;
  } catch {
    return 0;
  }
}

function fromImageAsset(asset: ImagePicker.ImagePickerAsset): PickedFile {
  const mime = asset.mimeType ?? undefined;
  const name = photoName(asset.fileName, asset.uri, mime);
  return {
    name,
    uri: asset.uri,
    ...(mime ? { mime } : {}),
    size: sizeOf(asset.uri, asset.fileSize),
    kind: kindOf(name, mime),
  };
}

/**
 * Delete the picker's cache copy of `file` (best effort, and only inside the
 * app's cache directory). Call it when the bytes have been read, or when the
 * file is dropped unsent: removed from the tray, the tray cleared, the screen
 * left, or a file request answered.
 */
export function discardPicked(file: Pick<PickedFile, "uri">): void {
  try {
    if (!insideCache(file.uri, Paths.cache.uri)) return;
    const copy = new File(file.uri);
    if (copy.exists) copy.delete();
  } catch {
    // Already gone, or never ours: the system clears the cache in time anyway.
  }
}

/**
 * Whether `uri` names a file under the cache directory `cache`: a prefix match
 * on whole segments, with no `.`/`..` segment (spelled out or percent-encoded)
 * and no encoded separator that could climb out of it.
 */
export function insideCache(uri: string, cache: string | null | undefined): boolean {
  if (!cache) return false;
  const root = cache.endsWith("/") ? cache : `${cache}/`;
  if (!uri.startsWith(root) || uri.length === root.length) return false;
  if (/[?#]/.test(uri)) return false;
  for (const segment of uri.slice(root.length).split("/")) {
    let plain: string;
    try {
      plain = decodeURIComponent(segment);
    } catch {
      return false;
    }
    if (plain === "" || plain === "." || plain === ".." || /[/\\]/.test(plain)) return false;
  }
  return true;
}

/** The picked assets past `limit`, which the draft has no room for: their copies go now. */
function dropExtra<T extends { uri: string }>(assets: readonly T[], limit: number): T[] {
  for (const extra of assets.slice(limit)) discardPicked(extra);
  return assets.slice(0, limit);
}

const IMAGE_OPTIONS: ImagePicker.ImagePickerOptions = {
  mediaTypes: ["images"],
  quality: 1,
  exif: false,
  base64: false,
  preferredAssetRepresentationMode:
    ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
};

/**
 * Photos from the library, up to `limit` (the room left in the draft,
 * `roomFor`). iOS's picker runs out of process and needs no library permission.
 */
export async function pickFromLibrary(limit: number = ATTACHMENTS_PER_TURN): Promise<PickedFile[]> {
  if (limit <= 0) return [];
  const result = await ImagePicker.launchImageLibraryAsync({
    ...IMAGE_OPTIONS,
    allowsMultipleSelection: limit > 1,
    selectionLimit: limit,
    orderedSelection: true,
  });
  if (result.canceled) return [];
  return dropExtra(result.assets, limit).map(fromImageAsset);
}

/**
 * One photo from the camera, or `null` when the operator cancelled. Throws
 * `PERMISSION_DENIED` when camera access is off for the app.
 */
export async function takePhoto(): Promise<PickedFile | null> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    throw new HermeticError(
      PERMISSION_DENIED as ErrorCode,
      "Camera access is off for Hermetic. Turn it on in the Settings app.",
    );
  }
  const result = await ImagePicker.launchCameraAsync(IMAGE_OPTIONS);
  if (result.canceled) return null;
  const asset = result.assets[0];
  return asset ? fromImageAsset(asset) : null;
}

/**
 * Files from the Files app (any type), up to `limit`. Each is copied into the
 * app's cache so its bytes can be read after the picker closes.
 */
export async function pickDocument(limit: number = ATTACHMENTS_PER_TURN): Promise<PickedFile[]> {
  if (limit <= 0) return [];
  const result = await DocumentPicker.getDocumentAsync({
    type: "*/*",
    multiple: limit > 1,
    copyToCacheDirectory: true,
  });
  if (result.canceled) return [];
  return dropExtra(result.assets, limit).map((asset) => {
    const mime = asset.mimeType ?? undefined;
    const name = asset.name || baseName(asset.uri, "file");
    return {
      name,
      uri: asset.uri,
      ...(mime ? { mime } : {}),
      size: sizeOf(asset.uri, asset.size),
      kind: kindOf(name, mime),
    };
  });
}

/** A picked file's bytes (`stageAll`'s `read`; its `discard` is `discardPicked`). */
export async function readBytes(uri: string): Promise<Uint8Array> {
  return await new File(uri).bytes();
}

/**
 * Decode `base64` natively into the app's cache under `name` and answer its
 * `file://` URI and size: a pasted picture (`paste.ts`) becomes a cache copy
 * like a picked photo's, so `readBytes` and `discardPicked` treat it the same.
 */
export async function writeToCache(
  name: string,
  base64: string,
): Promise<{ uri: string; size: number }> {
  const file = new File(Paths.cache, name);
  file.create({ intermediates: true, overwrite: true });
  file.write(base64, { encoding: "base64" });
  return { uri: file.uri, size: file.size ?? 0 };
}
