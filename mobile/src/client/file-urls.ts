/**
 * Where a picture in a transcript may come from, decided in one place.
 *
 * An image is fetched the moment it is drawn, with no tap, so it is held to a
 * stricter rule than a link (desktop `safeImageSrc`): a box that wants to
 * signal out only has to name an off-tailnet URL and let the phone deliver
 * the request for it. So a reference is one of three kinds (`classifyImageUrl`):
 *
 * - `box` — a file on the conversation's own box: an inbox or outbox entry,
 *   named by its id (`f_…`, `sh_…`) or its content path (`/files/<id>/content`).
 *   Its bytes come through the phone's files client (`PhoneFiles.content`),
 *   so the request crosses the same tunnel gate and digest check as every
 *   other files call, and the box is always this conversation's, never a host
 *   the text named. Loaded at once.
 * - `external` — an absolute `https:` URL. Never fetched on render: the
 *   picture is a placeholder naming the host, and its bytes are fetched only
 *   after the operator taps "Load image" on that block.
 * - `refused` — anything else (`http:`, `data:`, `file:`, `javascript:`, a
 *   relative or protocol-relative path, a portal path the desktop serves,
 *   `/api/…`): never loaded; the caller draws the name or alt text instead.
 *
 * Pure TypeScript.
 */
import { FILES_ROUTES, isFileId, isShareId } from "@hermetic/core/shared";
import { hermeticdUrl } from "../gateway/hermeticd.ts";

/** An image the phone may draw: bytes from the box, or a web image behind a tap. */
export type ImageSource = { kind: "box"; id: string } | { kind: "external"; uri: string; host: string };

/** How an image reference is treated (see the module comment). */
export type ImageClass = ImageSource | { kind: "refused" };

/** `http://<host>:7434/files/<id>/content`: where hermeticd serves an entry's bytes. */
export function fileContentUrl(host: string, id: string): string {
  return hermeticdUrl(host, FILES_ROUTES.content(id));
}

/** An inbox (`f_…`) or outbox (`sh_…`) entry id. */
export function isBoxFileId(id: string): boolean {
  return isFileId(id) || isShareId(id);
}

const CONTENT_PATH = /^\/files\/([^/?#]+)\/content(?:[?#].*)?$/;

/** The entry a box reference names — a bare id or `/files/<id>/content` — or null. */
export function boxFileIdOf(ref: string | null | undefined): string | null {
  if (typeof ref !== "string") return null;
  const raw = ref.trim();
  if (isBoxFileId(raw)) return raw;
  const m = CONTENT_PATH.exec(raw);
  if (!m?.[1]) return null;
  let id: string;
  try {
    id = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  return isBoxFileId(id) ? id : null;
}

/** An absolute `https:` URL with a host, as the URL and its host, or null. */
function httpsUrl(raw: string): { uri: string; host: string } | null {
  if (!/^https:\/\/[^/?#\s]/i.test(raw) || /\s/.test(raw)) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname ? { uri: raw, host: url.hostname } : null;
  } catch {
    return null;
  }
}

/** `box` (load at once), `external` (load on a tap) or `refused` (never load). */
export function classifyImageUrl(ref: string | null | undefined): ImageClass {
  if (typeof ref !== "string") return { kind: "refused" };
  const raw = ref.trim();
  if (raw.length === 0) return { kind: "refused" };
  const id = boxFileIdOf(raw);
  if (id !== null) return { kind: "box", id };
  const web = httpsUrl(raw);
  return web === null ? { kind: "refused" } : { kind: "external", ...web };
}

/** The source an image reference resolves to, or null when it is refused. */
export function imageSourceOf(ref: string | null | undefined): ImageSource | null {
  const found = classifyImageUrl(ref);
  return found.kind === "refused" ? null : found;
}

/**
 * The picture an `image`/`screenshot` tool result names: its `file_id` (or
 * `share_id`) on the box first, then `href`/`url`, or the result itself when
 * it is a string. Null when it names nothing the phone may load.
 */
export function toolImageSource(result: unknown): ImageSource | null {
  if (typeof result === "string") return imageSourceOf(result);
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  for (const key of ["file_id", "share_id"]) {
    const id = r[key];
    if (typeof id === "string" && isBoxFileId(id)) return { kind: "box", id };
  }
  for (const key of ["href", "url"]) {
    const found = imageSourceOf(typeof r[key] === "string" ? (r[key] as string) : null);
    if (found) return found;
  }
  return null;
}

/** What a tool result says it points at, for the line drawn when nothing loads. */
export function toolImageHref(result: unknown): string | null {
  if (typeof result === "string") return result || null;
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  const href = r["href"] ?? r["url"];
  return typeof href === "string" && href.length > 0 ? href : null;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard base64, with padding. Written out so nothing depends on the engine's `btoa`. */
export function base64(bytes: Uint8Array): string {
  const out: string[] = [];
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out.push(
      B64[(n >> 18) & 63] ?? "",
      B64[(n >> 12) & 63] ?? "",
      B64[(n >> 6) & 63] ?? "",
      B64[n & 63] ?? "",
    );
  }
  const left = bytes.length - i;
  if (left === 1) {
    const n = (bytes[i] ?? 0) << 16;
    out.push(B64[(n >> 18) & 63] ?? "", B64[(n >> 12) & 63] ?? "", "==");
  } else if (left === 2) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8);
    out.push(B64[(n >> 18) & 63] ?? "", B64[(n >> 12) & 63] ?? "", B64[(n >> 6) & 63] ?? "", "=");
  }
  return out.join("");
}

/** A `data:` URI for bytes this phone fetched from its own box, for an `Image`. */
export function dataUri(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${base64(bytes)}`;
}
