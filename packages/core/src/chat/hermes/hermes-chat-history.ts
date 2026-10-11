/**
 * The transcript: `chat.history`, and the mapping from the dashboard's durable
 * REST rows onto `schema/chat.ts`'s `ChatMessage`.
 *
 * Read over HTTP rather than over the socket on purpose. `session.history`
 * wants a live runtime ID and would resume the session to answer, which takes
 * one of the gateway's warm backends; the REST route pages durable IDs, scopes
 * the database by profile, and builds nothing.
 */
import { createHash } from "node:crypto";
import { checkAbort } from "../../abort.ts";
import {
  CHAT_ERROR_CODES,
  chatError,
  DIRECT_DIAL_HEADERS,
  type BoxAddress,
  type HistoryOptions,
} from "./hermes-chat-types.ts";
import type { ChatConnection } from "./hermes-chat-connect.ts";
import { mapUsage, toolBlock } from "./hermes-chat-blocks.ts";
import { memberRef } from "./hermes-chat-roster.ts";
import { stripBotDelivery } from "./bot-delivery.ts";
import { parseProcessNotice } from "./process-notice.ts";
import { arr, describe, isoOrNull, num, rec, str, stripToken } from "./hermes-chat-wire.ts";
import type { createCanonicalSessions } from "../../render/hermes-canonical.ts";
import type { BotRef, ChatBlock, ChatMessage, ProcessEventBlock } from "../../schema/index.ts";

/** What `createChatHistory` needs, and nothing more. */
export interface ChatHistoryDeps {
  connection: ChatConnection;
  /** The canonical Bot Chat session, when the caller named none. */
  conversation: ReturnType<typeof createCanonicalSessions>["conversation"];
}

export function createChatHistory(deps: ChatHistoryDeps) {
  const conn = deps.connection;

  /** Authenticated, read-only dashboard JSON; a stale cached token gets one refresh. */
  async function readJson(box: BoxAddress, url: URL, signal?: AbortSignal): Promise<unknown> {
    const cached = conn.cached(box);
    let tok = await conn.token(box, signal);
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await conn.fetch(url, {
          method: "GET",
          headers: { ...DIRECT_DIAL_HEADERS, "X-Hermes-Session-Token": tok },
          signal: signal ?? null,
        });
      } catch (error) {
        checkAbort(signal, "chat.history");
        throw chatError(
          CHAT_ERROR_CODES.UNREACHABLE,
          `${box.instance}: history read failed (${stripToken(describe(error), tok)})`,
        );
      }
      if (response.status === 401 && cached && attempt === 0) {
        conn.invalidate(box);
        tok = await conn.token(box, signal);
        continue;
      }
      if (!response.ok) {
        throw chatError(
          CHAT_ERROR_CODES.PROTOCOL,
          `${box.instance}: history answered HTTP ${response.status}`,
          { status: response.status },
        );
      }
      try {
        return await response.json();
      } catch {
        throw chatError(CHAT_ERROR_CODES.PROTOCOL, `${box.instance}: history did not return JSON`);
      }
    }
  }

  async function history(
    box: BoxAddress,
    bot: string,
    opts: HistoryOptions = {},
  ): Promise<ChatMessage[]> {
    checkAbort(opts.signal, "chat.history");
    let session = opts.session;
    if (!session) session = (await deps.conversation(box, bot, opts))?.session;
    if (!session) return [];
    // session.list names durable database IDs. session.history instead requires
    // a live runtime ID and rejects limit. The dashboard's REST read accepts
    // durable IDs, pages them without building a backend, and scopes the DB by
    // profile. Reading a transcript must never resume it or occupy a warm slot.
    const transcript: unknown[] = [];
    const pageSize = opts.limit ?? 500;
    let offset = 0;
    const seenPages = new Set<string>();
    for (;;) {
      const url = new URL(`api/sessions/${encodeURIComponent(session)}/messages`, box.baseUrl);
      url.searchParams.set("profile", bot);
      url.searchParams.set("limit", String(pageSize));
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("order", opts.limit === undefined ? "oldest" : "latest");
      const raw = await readJson(box, url, opts.signal);
      const rows = rec(raw)?.messages;
      if (!Array.isArray(rows))
        throw chatError(CHAT_ERROR_CODES.PROTOCOL, `${box.instance}: history named no messages`);
      const fingerprint = JSON.stringify(rows);
      if (rows.length && seenPages.has(fingerprint))
        throw chatError(CHAT_ERROR_CODES.PROTOCOL, `${box.instance}: history repeated a page`);
      seenPages.add(fingerprint);
      transcript.push(...rows);
      if (opts.limit !== undefined || rows.length < pageSize)
        return mapHistory(box, session, transcript);
      offset += rows.length;
    }
  }
  return { history };
}

/**
 * Durable REST rows use numeric IDs, OpenAI-style assistant tool_calls, and
 * separate tool result rows. The 2026-09-17 live read confirmed these shapes;
 * unfamiliar message parts still survive as unknown blocks.
 */
export function mapHistory(box: BoxAddress, session: string, raw: unknown): ChatMessage[] {
  const rows = arr(rec(raw)?.messages ?? rec(raw)?.history ?? raw);
  const calls = new Map<string, Record<string, unknown>>();
  const completed = new Set<string>();
  for (const entry of rows) {
    const row = rec(entry);
    if (!row || row.display_kind === "hidden") continue;
    for (const value of arr(row.tool_calls)) {
      const call = rec(value);
      const id = str(call?.id) ?? str(call?.call_id);
      if (id && call) calls.set(id, call);
    }
    const id = str(row.tool_call_id);
    if (row.role === "tool" && id) completed.add(id);
  }
  const out: ChatMessage[] = [];
  /** The previous mapped row's `at`, carried forward for a row the box left unstamped. */
  let carried: string | null = null;
  for (const entry of rows) {
    const row = rec(entry);
    if (!row || row.display_kind === "hidden") continue;
    const durableId = num(row.id) ?? num(row.row_id);
    // Upstream's `TranscriptMessage.row_id` is the documented durable rewind
    // target; some builds send it as a string rather than a number.
    const rowRef = str(row.row_id);
    const stamped = isoOrNull(row.at ?? row.timestamp ?? row.created_at);
    const at: string = stamped ?? carried ?? HISTORY_EPOCH;
    carried = at;
    const role = messageRole(str(row.role));
    // A background-process notice Hermes injected as the user's row: the
    // operator never typed it, so it is a system event, not "You". Only the
    // role and blocks change — the id below is computed from the row exactly
    // as before, so a transcript read either side of this change agrees.
    const notice = role === "user" ? processNoticeOf(row) : null;
    const blocks = notice ? [notice] : durableHistoryBlocks(row, calls, completed);
    // Another bot's `message_agent` delivery, likewise on the user role: the
    // signature becomes `from_bot` and the text keeps only the message. The key
    // is omitted rather than null on every other row, so their shape is as before.
    const delivery = role === "user" && !notice ? stripBotDelivery(blocks) : null;
    out.push({
      id:
        str(row.id) ??
        str(row.message_id) ??
        (durableId !== null
          ? `${session}:${durableId}`
          : rowRef !== null
            ? `${session}:${rowRef}`
            : rowId(session, row, stamped)),
      session,
      role: notice ? "system" : role,
      author: authorRef(box, row.author ?? row.from),
      at,
      blocks: delivery ? delivery.blocks : blocks,
      usage: mapUsage(rec(row.usage)),
      error: str(row.error),
      incomplete: row.incomplete === true ? true : null,
      ...(delivery ? { from_bot: delivery.from } : {}),
    });
  }
  return out;
}

/**
 * The timestamp a row that carries none is read at.
 *
 * It used to be the laptop's clock, which is re-evaluated on every read: the
 * same row came back with a new `at` each poll, and since `chat-observe.ts`
 * announces on `at` and `notifications.ts` keys the inbox row on it, one
 * unstamped row minted a fresh notification every five seconds. So the
 * fallback has to be a function of the row and nothing else. Carry-forward
 * from the previous row is the closest honest answer — a transcript is
 * ordered, so an unstamped row happened no earlier than the one before it —
 * and the epoch anchors a read that begins with one. The session's own
 * `started_at` would be a better anchor, but the paged read accumulates bare
 * rows and no longer has the envelope it came in.
 */
const HISTORY_EPOCH = "1970-01-01T00:00:00.000Z";

/**
 * A stable id for a row the box gave no id of any kind.
 *
 * The positional `${session}:${offset + i}` this replaces was an index into
 * the read's *window*, and an `order=latest` window slides: the same message
 * was message 7 on one read and message 6 on the next, so the cursor
 * `chat-observe.ts` keeps saw it as new. Hashing the row instead makes the id
 * a property of what the box said rather than of when it was asked.
 *
 * Only the fields that say *which message this is* go in, in a fixed order:
 * who said it, what it says, and when the box stamped it. Hashing the whole row
 * would be worse than the index it replaces — a row picks up sidecars between
 * reads (`usage` once the turn settles, `incomplete`, a reasoning summary) and
 * a JSON object has no guaranteed key order, so the same message would hash
 * differently on the next poll and arrive as a second copy.
 *
 * The row's *own* timestamp, never the carried-forward one, for the same
 * reason: a carried `at` depends on which rows the window happened to include.
 * Two rows identical in author, text and stamp collapse to one id, which is the
 * one case this cannot tell apart and also the one case where announcing twice
 * would be indistinguishable from announcing once.
 */
function rowId(session: string, row: Record<string, unknown>, stamped: string | null): string {
  const parts = [
    session,
    str(row.role) ?? "",
    str(row.author) ?? str(row.from) ?? str(row.name) ?? "",
    canonical(row.content ?? row.display_content ?? row.text ?? null),
    stamped ?? "",
  ];
  const digest = createHash("sha256").update(parts.join("\u0000")).digest("hex");
  return `${session}:h${digest.slice(0, 16)}`;
}

/**
 * A message body as one string, with object keys sorted.
 *
 * Content is usually a string and sometimes a list of parts; either way the
 * same body has to produce the same bytes however the box happened to order the
 * keys inside it.
 */
function canonical(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner === null || typeof inner !== "object" || Array.isArray(inner)) return inner;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(inner as Record<string, unknown>).sort()) {
      sorted[key] = (inner as Record<string, unknown>)[key];
    }
    return sorted;
  });
}

/**
 * The `process_event` block for a row whose whole text is one of Hermes'
 * injected notices, or null. Upstream stores the notice as plain string
 * content; a single text part is accepted too, so a build that wraps content
 * in parts does not bring "You" back.
 */
export function processNoticeOf(row: Record<string, unknown>): ProcessEventBlock | null {
  const content = row.display_content ?? row.content ?? row.text;
  if (typeof content === "string") return parseProcessNotice(content);
  const parts = arr(content);
  if (parts.length !== 1) return null;
  const only = parts[0];
  const text = typeof only === "string" ? only : (str(rec(only)?.text) ?? str(rec(only)?.content));
  return text ? parseProcessNotice(text) : null;
}

function messageRole(raw: string | null): ChatMessage["role"] {
  if (raw === "user" || raw === "human") return "user";
  if (raw === "assistant" || raw === "bot" || raw === "agent") return "bot";
  return raw === "system" || raw === "tool" || raw === null ? "system" : "system";
}

function authorRef(box: BoxAddress, raw: unknown): BotRef | null {
  const refs = memberRef(box, raw);
  return refs[0] ?? null;
}

/** Parse structured tool fields without discarding a malformed or plain-text value. */
function storedJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function durableHistoryBlocks(
  row: Record<string, unknown>,
  calls: ReadonlyMap<string, Record<string, unknown>>,
  completed: ReadonlySet<string>,
): ChatBlock[] {
  const id = str(row.tool_call_id);
  if (row.role === "tool" && (id || str(row.tool_name))) {
    const call = id ? calls.get(id) : undefined;
    const fn = rec(call?.function);
    const result = storedJson(row.display_content ?? row.content);
    const metadata = rec(result);
    return [
      toolBlock(
        {
          tool_id: id,
          name: str(row.tool_name) ?? str(fn?.name) ?? "tool",
          args: storedJson(fn?.arguments) ?? null,
          result,
          exit_code: metadata?.exit_code,
          error: metadata?.error,
          status: metadata?.status,
        },
        null,
      ),
    ];
  }
  const blocks = historyBlocks(row);
  for (const value of arr(row.tool_calls)) {
    const call = rec(value);
    const callId = str(call?.id) ?? str(call?.call_id);
    const fn = rec(call?.function);
    if (callId && fn && str(fn.name)) {
      // The result row owns the completed card. Pairing by ID, across the whole
      // requested transcript, keeps parallel same-name tools and page edges safe.
      if (!completed.has(callId))
        blocks.push(
          toolBlock(
            {
              tool_id: callId,
              name: fn.name,
              args: storedJson(fn.arguments) ?? null,
              result: null,
              status: "warn",
            },
            null,
          ),
        );
    } else {
      blocks.push({ kind: "unknown", name: "tool_call", payload: value });
    }
  }
  return blocks;
}

function historyBlocks(row: Record<string, unknown>): ChatBlock[] {
  const parts = row.display_content ?? row.blocks ?? row.parts ?? row.content;
  if (typeof parts === "string") return parts ? [{ kind: "text", markdown: parts }] : [];
  const list = arr(parts);
  if (list.length === 0) {
    const text = str(row.text) ?? str(row.content);
    return text ? [{ kind: "text", markdown: text }] : [];
  }
  const blocks: ChatBlock[] = [];
  for (const part of list) {
    if (typeof part === "string") {
      if (part) blocks.push({ kind: "text", markdown: part });
      continue;
    }
    const p = rec(part);
    if (!p) continue;
    const kind = str(p.type) ?? str(p.kind) ?? "";
    switch (kind) {
      case "text":
      case "output_text":
        blocks.push({ kind: "text", markdown: str(p.text) ?? str(p.content) ?? "" });
        break;
      case "thinking":
      case "reasoning":
        blocks.push({
          kind: "reasoning",
          text: str(p.text) ?? "",
          duration_ms: num(p.duration_ms),
          tokens: num(p.tokens),
        });
        break;
      case "tool_use":
      case "tool_call":
      case "tool":
      case "tool_result":
        blocks.push(toolBlock(p, null));
        break;
      default:
        // Same contract as the live stream: a part this build has never heard of
        // is kept whole rather than dropped (§9.2).
        blocks.push({ kind: "unknown", name: kind || "part", payload: p });
        break;
    }
  }
  return blocks;
}
