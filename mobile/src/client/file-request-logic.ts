/**
 * The pure half of the phone's request cards (`chat/blocks/FileRequest.tsx`,
 * `SecretText.tsx`): which tool blocks are cards, what a card says about time,
 * size and origin, and when a delivery came after the agent stopped waiting.
 *
 * Mirrors `packages/ui/src/chat/file-request-logic.ts` (the desktop's), which
 * the phone cannot import. Pure TypeScript.
 */
import type { ChatBlock, ToolBlock } from "@hermetic/core/chat-client";
import type { FileRequest } from "@hermetic/core/schema";
import { FILES_TTL, shortId } from "@hermetic/core/shared";

export type RequestToolBlock = ToolBlock & { render: "file_request" | "secret_request" };

/** A `request_file`/`await_file`/`request_secret` call: drawn as a request card, never folded. */
export function isRequestTool(block: ChatBlock | undefined): block is RequestToolBlock {
  return (
    block?.kind === "tool" && (block.render === "file_request" || block.render === "secret_request")
  );
}

/** A slot that may still change under the card. */
export function slotLive(slot: FileRequest | null): boolean {
  return slot === null || slot.state === "open" || slot.state === "receiving";
}

export function slotDelivered(slot: FileRequest | null): boolean {
  return slot?.state === "fulfilled" || slot?.state === "consumed";
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** `1:58` (hours and minutes) until `expires_at`; `0:00` once it passed. */
export function countdown(expires_at: string, now: number): string {
  const left = Math.max(0, Math.floor((Date.parse(expires_at) - now) / 1000));
  if (Number.isNaN(left)) return "—";
  return `${Math.floor(left / 3600)}:${pad(Math.floor((left % 3600) / 60))}`;
}

/** How long the slot was open, for "No file within 2 h". */
export function lifetimeLabel(slot: Pick<FileRequest, "created_at" | "expires_at">): string {
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

/**
 * The agent's wait ran out (`pending`) and the turn moved on, and the file
 * arrived afterwards: nobody is waiting for it, so the card offers to say so.
 * Only while the slot is `fulfilled`: once it is `consumed` the agent already
 * read it, and there is nothing left to tell.
 */
export function deliveredLate(block: ToolBlock, slot: FileRequest | null): boolean {
  return (
    block.status !== "running" &&
    resultStatus(block.result) === "pending" &&
    slot?.state === "fulfilled"
  );
}

/**
 * Requests whose late delivery the operator already told the agent about, for
 * the life of the app: a card that remounts must not offer it a second time.
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

/** The same for a text secret: the path and the key names, never a value. */
export function secretContinueMessage(
  request_id: string,
  path: string,
  keys: readonly string[],
): string {
  const named = keys.length > 0 ? ` (keys: ${keys.join(", ")})` : "";
  return `[hermetic] Secret for request ${request_id} delivered: ${path}${named}`;
}

/**
 * Where the slot came from, as the box recorded it. "This conversation" is
 * claimed only when the slot's session is the message's own; anything else is
 * a warning, since a request id can be named in model-written arguments.
 */
export function requestOrigin(
  slot: Pick<FileRequest, "request_id" | "session_id">,
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

/** The tool's own arguments, for a card that cannot read the box's slot: the model's words. */
export interface RequestArgs {
  purpose: string | null;
  accept: string[];
  sensitivity: "normal" | "secret" | null;
  keys: string[];
}

export function requestArgs(block: ToolBlock): RequestArgs {
  const args = (block.args ?? {}) as Record<string, unknown>;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return {
    purpose: typeof args.purpose === "string" ? args.purpose : null,
    accept: strings(args.accept),
    sensitivity:
      args.sensitivity === "secret" ? "secret" : args.sensitivity === "normal" ? "normal" : null,
    keys: strings(args.keys),
  };
}
