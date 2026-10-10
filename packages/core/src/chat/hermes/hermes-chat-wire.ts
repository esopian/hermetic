/**
 * Tolerant reads, shared by every module of the Hermes chat adapter.
 *
 * Nothing upstream sends is trusted to have the type its name suggests, so the
 * adapter reads every field through one of these. They are deliberately total:
 * each answers null (or an empty array) rather than throwing, because a single
 * malformed field in a roster of thirteen boxes must not blank the roster.
 *
 * `socketUrl`, `originOf` and `stripToken` live here too: they are the three
 * places the session token is built into, kept out of, or removed from a
 * string, and keeping them together is what makes that rule reviewable.
 */
import { HermeticError } from "../../errors.ts";

/**
 * The `source` hermetic stamps on every `session.create` and `session.resume`.
 *
 * Upstream stores the `source` a session's row is first written with as its DB
 * `source` and lists it back on every `session.list` row, so a session this
 * portal (or any hermetic) created is distinguishable from one the box's own
 * TUI opened — without it, every websocket client is stamped `tui`. On
 * `session.resume` it only sets the runtime record (the agent's platform, so
 * its system-prompt hint); the stored `source` is never overwritten unless it is
 * the placeholder `'unknown'` (`_insert_session_row`, `hermes_state_sessions.py:298`),
 * so a resume cannot relabel another client's session. It does not replace the
 * local record of which sessions this laptop sent into (`claimLocal`,
 * `chat.ts`): `hermetic` maps to a foreign origin, and that local record stays
 * the only thing that grants `portal`.
 */
export const HERMETIC_SESSION_SOURCE = "hermetic";

/**
 * `JSON.parse`, answering `undefined` rather than throwing.
 *
 * `undefined` and not `null` because `null` is a document a JSON-RPC peer may
 * legally send, and the reader has to be able to tell "the box said null" from
 * "that was not a document yet".
 */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function rec(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/**
 * A **non-empty** string, or null.
 *
 * The empty string is treated as absence on purpose. Upstream writes `""` where
 * it means "not set" — `display_name` and `description` both came back empty on
 * the probed box — so returning it would defeat every `str(a) ?? str(b) ?? x`
 * fallback in this file. That matters beyond tidiness: `ChatMessage.id`,
 * `Session.id`, `Room.id`, `ToolBlock.name`, `Bot.name` and `ApprovalBlock.tool`
 * are all `.min(1)` in the schema, so an empty string reaching one of them is
 * not a cosmetic problem, it is a `ZodError` thrown at whichever head parses it.
 */
export function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * `rec`, made total: an object, or an empty one.
 *
 * For readers that walk into a field immediately (`record(x).name`) and treat a
 * missing parent and a missing child alike. `rec` is the right helper wherever
 * "the box sent no object at all" is itself an answer.
 */
export function record(v: unknown): Record<string, unknown> {
  return rec(v) ?? {};
}

/** Every element of an array that is an object; anything else is dropped. */
export function records(v: unknown): Record<string, unknown>[] {
  return arr(v)
    .map(rec)
    .filter((row): row is Record<string, unknown> => row !== null);
}

export function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function nonNegative(v: number | null): number | null {
  return v === null ? null : Math.max(0, Math.trunc(v));
}

export function scaleSeconds(v: number | null): number | null {
  return v === null ? null : Math.max(0, Math.round(v * 1000));
}

/**
 * Epoch seconds, epoch milliseconds and a date string all appear in upstream's
 * own state files, so all three are accepted and anything else is "the box did
 * not say", which `Iso.nullish()` is there to express.
 */
export function isoOrNull(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    const ms = v > 1e12 ? v : v * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * `wss://host/api/ws?token=…`, from the `https://host/` the caller resolved.
 *
 * The return value of this function is a credential. It goes to `deps.openSocket`
 * and nowhere else; nothing built from it may reach an error message, a log
 * line or a response body without passing `stripToken` first.
 */
export function socketUrl(baseUrl: string, token: string): string {
  const url = new URL("/api/ws", baseUrl);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.searchParams.set("token", token);
  return url.toString();
}

/** `https://host` — safe to name in an error, unlike the URL that was dialled. */
export function originOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return "the box";
  }
}

/**
 * Removes the live session token from a string that came from somewhere else.
 *
 * The belt to `originOf`'s braces: this adapter controls the messages it writes,
 * but not the ones a `ChatSocket` implementation or the runtime attaches to a
 * failed upgrade, and those are built from the URL that was dialled.
 */
export function stripToken(text: string, token: string): string {
  return token ? text.split(token).join("[redacted]") : text;
}

export function isHermeticCode(e: unknown, code: string): boolean {
  return e instanceof HermeticError && String(e.code) === code;
}

/** The message, never the object — core hands a head text it can render (§3.2 rule 1). */
export function describe(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  return typeof e === "string" && e ? e : "unknown failure";
}
