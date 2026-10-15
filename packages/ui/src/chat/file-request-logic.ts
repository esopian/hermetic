/**
 * The pure half of the request cards (attachments plan §8.3–8.4b): which tool
 * blocks are cards, what the card says about time, size and class, when a
 * delivery came after the agent stopped waiting, and whether the turn read
 * untrusted content before it asked.
 */
import { FILES_LIMITS, FILES_TTL, looksLikeKeyMaterial, shortId } from "@hermetic/core/shared";
import type { ChatBlockOf, ChatBlockView } from "../api/index.ts";
import type { FileRequestSlot } from "../api/files.ts";

export type RequestToolBlock = ChatBlockOf<"tool"> & { render: "file_request" | "secret_request" };

/** A `request_file`/`await_file`/`request_secret` call: drawn as a request card, never grouped. */
export function isRequestTool(block: ChatBlockView | undefined): block is RequestToolBlock {
  return (
    block?.kind === "tool" && (block.render === "file_request" || block.render === "secret_request")
  );
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** `1:58:12` until `expires_at`; `0:00:00` once it passed. */
export function countdown(expires_at: string, now: number): string {
  const left = Math.max(0, Math.floor((Date.parse(expires_at) - now) / 1000));
  if (Number.isNaN(left)) return "—";
  return `${Math.floor(left / 3600)}:${pad(Math.floor((left % 3600) / 60))}:${pad(left % 60)}`;
}

/** How long the slot was open, for "No file within 2 h". */
export function lifetimeLabel(slot: Pick<FileRequestSlot, "created_at" | "expires_at">): string {
  let ms = Date.parse(slot.expires_at) - Date.parse(slot.created_at);
  // A slot the box closed early carries its closing time; the default lifetime is the honest answer.
  if (!Number.isFinite(ms) || ms < 60_000) ms = FILES_TTL.request * 1000;
  const minutes = Math.round(ms / 60_000);
  return minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`;
}

/** A size cap as people write one: `256 MB`, `4 KB`. */
export function capLabel(bytes: number): string {
  const KiB = 1024;
  const MiB = KiB * KiB;
  if (bytes >= MiB && bytes % MiB === 0) return `${bytes / MiB} MB`;
  if (bytes >= KiB && bytes % KiB === 0) return `${bytes / KiB} KB`;
  if (bytes >= MiB) return `${(bytes / MiB).toFixed(1)} MB`;
  if (bytes >= KiB) return `${(bytes / KiB).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** `41ab…`: enough of a digest to compare by eye, never the whole of it. */
export function shortSha(sha256: string): string {
  return `${sha256.slice(0, 4)}…`;
}

export function baseName(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? path : path.slice(cut + 1);
}

/** `HH:MM` in the operator's zone. */
export function clockHM(iso: string | number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--";
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The plugin result's `status`, when the result is the object the plugin returns. */
export function resultStatus(result: unknown): string | null {
  if (result === null || typeof result !== "object") return null;
  const status = (result as { status?: unknown }).status;
  return typeof status === "string" ? status : null;
}

export function slotDelivered(slot: FileRequestSlot | null): boolean {
  return slot?.state === "fulfilled" || slot?.state === "consumed";
}

/**
 * The agent's wait ran out (`pending`) and the turn moved on, and the file
 * arrived afterwards: nobody is waiting for it, so the card offers to say so.
 * Only while the slot is `fulfilled`: once it is `consumed` the agent already
 * read the file, and there is nothing left to tell it.
 */
export function deliveredLate(block: ChatBlockOf<"tool">, slot: FileRequestSlot | null): boolean {
  return (
    block.status !== "running" &&
    resultStatus(block.result) === "pending" &&
    slot?.state === "fulfilled"
  );
}

/**
 * Requests whose late delivery the operator already told the agent about,
 * for the life of the page: a card that remounts (scrolled away, the pane
 * reopened) must not offer "Tell & continue" a second time.
 */
const TOLD_LATE = new Set<string>();
const toldKey = (instance: string, request_id: string): string => `${instance}\u0000${request_id}`;

export function toldLate(instance: string, request_id: string): boolean {
  return TOLD_LATE.has(toldKey(instance, request_id));
}

export function markToldLate(instance: string, request_id: string): void {
  TOLD_LATE.add(toldKey(instance, request_id));
}

/** What "Tell <agent> & continue" sends (D7: the operator's choice, never automatic). */
export function continueMessage(request_id: string, path: string): string {
  return `[hermetic] File for request ${request_id} delivered: ${path}`;
}

/**
 * The same for a text secret: the path and the key names, never a value.
 * `keys` are names as the box recorded them (`fulfilled.keys`).
 */
export function secretContinueMessage(
  request_id: string,
  path: string,
  keys: readonly string[],
): string {
  const named = keys.length > 0 ? ` (keys: ${keys.join(", ")})` : "";
  return `[hermetic] Secret for request ${request_id} delivered: ${path}${named}`;
}

/**
 * Where the slot came from, as the box recorded it. A request id can be named
 * in model-written `await_file` arguments, so "this conversation" is claimed
 * only when the slot's session is the one on screen; anything else is a
 * warning.
 */
export function requestOrigin(
  slot: Pick<FileRequestSlot, "request_id" | "session_id">,
  session_id: string | null | undefined,
): { own: boolean; label: string } {
  const own = slot.session_id !== undefined && slot.session_id === session_id;
  const where = own
    ? "from this conversation"
    : slot.session_id === undefined
      ? "session not recorded"
      : "from another session";
  return { own, label: `${shortId(slot.request_id)} · ${where}` };
}

const UNTRUSTED_TOOL = /^(web|browser|mcp)_/;

/**
 * The turn read something from outside before this request: a tool the
 * gateway flagged (`tool.output_risk`, an activity keyed `risk:`), or a web,
 * browser or MCP tool (an MCP server's output is a third party's words). The request may be the page's words rather than the operator's.
 */
export function untrustedBefore(blocks: readonly ChatBlockView[], index: number): boolean {
  for (let i = 0; i < index && i < blocks.length; i += 1) {
    const block = blocks[i]!;
    if (block.kind === "activity" && block.key.startsWith("risk:")) return true;
    if (block.kind === "tool" && UNTRUSTED_TOOL.test(block.name)) return true;
  }
  return false;
}

/** D6 on the page: whether a dropped file's head looks like a private key. */
export async function looksLikeKey(file: Blob, name: string): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, FILES_LIMITS.sniffBytes).arrayBuffer());
  try {
    return looksLikeKeyMaterial(head, name);
  } finally {
    head.fill(0);
  }
}
