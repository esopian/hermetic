/**
 * The transcript: `chat.history`, and the mapping from the dashboard's durable
 * REST rows onto `schema/chat.ts`'s `ChatMessage`.
 *
 * Read over HTTP rather than over the socket on purpose. `session.history`
 * wants a live runtime ID and would resume the session to answer, which takes
 * one of the gateway's warm backends; the REST route pages durable IDs, scopes
 * the database by profile, and builds nothing.
 */
import { checkAbort } from "../../abort.ts";
import { sha256Hex } from "../../shared/sha256.ts";
import {
  CHAT_ERROR_CODES,
  chatError,
  DIRECT_DIAL_HEADERS,
  type BoxAddress,
  type HistoryOptions,
} from "./hermes-chat-types.ts";
import type { ChatConnection } from "./hermes-chat-connect.ts";
import { chatFailure, mapUsage, toolBlock } from "./hermes-chat-blocks.ts";
import { subagentVerdict } from "./hermes-chat-subagent.ts";
import { memberRef } from "./hermes-chat-roster.ts";
import { stripBotDelivery } from "./bot-delivery.ts";
import { readAttachments } from "./hermes-chat-framing.ts";
import {
  describeShares,
  hasShares,
  outboxOnce,
  readMediaShares,
  type ListOutbox,
} from "./hermes-chat-media.ts";
import { parseProcessNotice } from "./process-notice.ts";
import { STEER_DISPLAY_KIND, unwrapSteer } from "./steer-marker.ts";
import {
  arr,
  describe,
  discardBody,
  isoOrNull,
  num,
  rec,
  str,
  stripToken,
} from "./hermes-chat-wire.ts";
import type { createCanonicalSessions } from "../../render/hermes-canonical.ts";
import {
  SUBAGENT_TOOLS_MAX,
  type BotRef,
  type ChatBlock,
  type ChatMessage,
  type ProcessEventBlock,
  type SubagentBlock,
  type SubagentStatus,
} from "../../schema/index.ts";

/** What `createChatHistory` needs, and nothing more. */
export interface ChatHistoryDeps {
  connection: ChatConnection;
  /** The canonical Bot Chat session, when the caller named none. */
  conversation: ReturnType<typeof createCanonicalSessions>["conversation"];
  /**
   * The box's outbox, read once per transcript that holds a share chip, to
   * describe it (`hermes-chat-media.ts`). Absent, chips stay undescribed.
   */
  listOutbox?: ListOutbox | undefined;
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
        discardBody(response);
        conn.invalidate(box);
        tok = await conn.token(box, signal);
        continue;
      }
      if (!response.ok) {
        discardBody(response);
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
      transcript.push(...rows);
      // A bounded read (an observation's window) is one page, and so is a short
      // page: neither can be followed by a repeat, so neither is fingerprinted.
      if (opts.limit !== undefined || rows.length < pageSize)
        return describeHistory(box, mapHistory(box, session, transcript), opts.signal);
      const key = pageKey(rows);
      if (seenPages.has(key))
        throw chatError(CHAT_ERROR_CODES.PROTOCOL, `${box.instance}: history repeated a page`);
      seenPages.add(key);
      offset += rows.length;
    }
  }

  /** Share chips described from one outbox read, when there are any and it answers. */
  async function describeHistory(
    box: BoxAddress,
    messages: ChatMessage[],
    signal: AbortSignal | undefined,
  ): Promise<ChatMessage[]> {
    if (!deps.listOutbox || !hasShares(messages)) return messages;
    const outbox = await outboxOnce(deps.listOutbox, box.instance, signal)();
    return describeShares(messages, outbox);
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
  /** The last visible row that is not a tool result: see `durableHistoryBlocks`' `atTail`. */
  let lastTurnRow = -1;
  for (const [index, entry] of rows.entries()) {
    const row = rec(entry);
    if (!row || row.display_kind === "hidden") continue;
    if (row.role !== "tool") lastTurnRow = index;
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
  for (const [index, entry] of rows.entries()) {
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
    // A mid-turn steer (`steer-marker.ts`) is the operator's own text inside
    // Hermes' out-of-band marker: the text without the marker, flagged
    // `steered`. Checked first, so neither the notice nor the delivery reading
    // below ever sees the marker. The id, again, comes from the raw row.
    const steer = role === "user" ? steerOf(row) : null;
    const notice = role === "user" && !steer ? processNoticeOf(row) : null;
    const blocks = notice
      ? [notice]
      : steer && steer.text !== null
        ? [{ kind: "text" as const, markdown: steer.text }]
        : durableHistoryBlocks(row, calls, completed, index === lastTurnRow);
    // Another bot's `message_agent` delivery, likewise on the user role: the
    // signature becomes `from_bot` and the text keeps only the message. The key
    // is omitted rather than null on every other row, so their shape is as before.
    const delivery = role === "user" && !notice && !steer ? stripBotDelivery(blocks) : null;
    // The operator's attachments, as chips rather than the prompt text that
    // carried them to the agent (plan §8.2, `hermes-chat-framing.ts`). Rows
    // carry no source of their own, so the one test available is the author:
    // a notice or another bot's delivery never had attachments of ours, and a
    // framing block in one is that sender's text, not chips. A steer carried
    // only typed text, never a framed attachment.
    const shown = delivery ? delivery.blocks : blocks;
    const operator = role === "user" && !notice && !delivery && !steer;
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
      // The operator's attachments out of a user row; the agent's outbox
      // shares (`MEDIA:` outbox lines) out of a bot row.
      blocks: operator
        ? readAttachments(shown)
        : role === "bot" && !notice
          ? readMediaShares(shown)
          : shown,
      usage: mapUsage(rec(row.usage)),
      error: str(row.error),
      ...failureOf(row),
      incomplete: row.incomplete === true ? true : null,
      ...(delivery ? { from_bot: delivery.from } : {}),
      ...(steer ? { steered: true } : {}),
    });
  }
  return out;
}

/**
 * A failed turn's structured failure, beside the `error` string: upstream
 * persists the classified `error_surface` with the turn's error
 * (`tui_gateway/session_history.py` `_fail_inflight_turn`). Omitted rather
 * than null on every other row, so their shape is as before.
 */
function failureOf(row: Record<string, unknown>): Partial<Pick<ChatMessage, "failure">> {
  const error = str(row.error);
  if (!error) return {};
  return { failure: chatFailure(CHAT_ERROR_CODES.TURN_FAILED, error, row.error_surface) };
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
  const digest = sha256Hex(parts.join("\u0000"));
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
  const text = singleText(row);
  return text ? parseProcessNotice(text) : null;
}

/**
 * A steer row's unwrapped text, or null when the row is not a steer. A row is a
 * steer when upstream typed it `display_kind: "steer"`, or — for a build or a
 * path that drops the type — when its whole text is exactly the marker wrapper.
 * A typed steer whose text carries no marker keeps its text (`text: null`, the
 * caller maps the row as usual) and is still a steer.
 */
function steerOf(row: Record<string, unknown>): { text: string | null } | null {
  const raw = singleText(row);
  const text = raw === null ? null : unwrapSteer(raw);
  if (text !== null) return { text };
  return row.display_kind === STEER_DISPLAY_KIND ? { text: null } : null;
}

/** A row's whole text when it is one string or a single text part, else null. */
function singleText(row: Record<string, unknown>): string | null {
  const content = row.display_content ?? row.content ?? row.text;
  if (typeof content === "string") return content;
  const parts = arr(content);
  if (parts.length !== 1) return null;
  const only = parts[0];
  return typeof only === "string" ? only : (str(rec(only)?.text) ?? str(rec(only)?.content));
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

/** `tools/clarify_tool.py` `TIMEOUT_RESPONSE`: what a single question stores when nobody answered. */
export const CLARIFY_TIMEOUT_RESPONSE =
  "The user did not provide a response within the time limit. Use your best judgement to make the choice and proceed.";

/**
 * A completed `clarify` call re-read from history, as the answered card Hermes
 * Desktop draws from the same row (`clarify-tool.tsx`). The live request block
 * is gone once the gateway resolves it, so without this a reloaded transcript
 * showed only the raw tool card. The block carries no `request_id`: nothing is
 * open to answer, and every question's `answer` is filled ("" for a skip), which
 * is how a head tells it from a pending clarify.
 *
 * Upstream's result is `{responses: [...]}` for a batch, in question order, or
 * `{question, choices_offered, user_response}` for a single question; a
 * multi-select `user_response` is a list, kept as a JSON array string the way
 * the live path's locked answers are. The result's own `question` and
 * `choices_offered` are preferred over the arguments because they are what the
 * tool actually offered after cleaning (bare, no " (Recommended)" label); the
 * arguments fill in a blank. An error result, or one in neither shape, yields
 * nothing, leaving the tool card alone. The question id is the gateway's
 * `q<index>`, so a settled card keys its questions exactly as the live one did.
 */
export function settledClarify(args: unknown, result: unknown): ChatBlock | null {
  const outcome = rec(result);
  if (!outcome || (outcome.error !== undefined && outcome.error !== null)) return null;
  const asked = rec(args);
  const batch = Array.isArray(outcome.responses);
  if (!batch && !("user_response" in outcome)) return null;
  const responses = batch ? arr(outcome.responses) : [outcome];
  const argued = batch ? arr(asked?.questions) : [asked];
  const questions: NonNullable<Extract<ChatBlock, { kind: "question" }>["questions"]> = [];
  responses.forEach((value, index) => {
    const response = rec(value);
    const raw = argued[index];
    const arg = typeof raw === "string" ? { question: raw } : rec(raw);
    const prompt = (str(response?.question) ?? str(arg?.question) ?? "").trim();
    if (!response || !prompt) return;
    const choices = settledChoices(response.choices_offered ?? arg?.choices);
    // A skip and a timeout both store "" (a timed-out batch adds a top-level
    // `timed_out`); like Desktop's card, either reads as skipped.
    const reply = response.user_response;
    const answer = Array.isArray(reply)
      ? JSON.stringify(reply.map(String))
      : typeof reply === "string" && reply.trim() !== CLARIFY_TIMEOUT_RESPONSE
        ? reply
        : "";
    questions.push({
      id: `q${index}`,
      prompt,
      choices,
      multi_select: choices.length > 0 && (arg?.multi_select === true || Array.isArray(reply)),
      answer,
    });
  });
  const first = questions[0];
  if (!first) return null;
  return {
    kind: "question",
    prompt: first.prompt,
    choices: first.choices,
    multi_select: first.multi_select,
    questions,
    request_id: null,
  };
}

const HISTORY_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "completed",
  "failed",
  "error",
  "timeout",
  "interrupted",
]);

/**
 * A completed `delegate_task` call re-read from history, as one `subagent`
 * block per task (`origin: "history"`), placed right after the tool block.
 *
 * Upstream's result is one of three envelopes:
 *
 * - synchronous (a nested delegation): `{results: [{task_index, status,
 *   summary, api_calls, duration_seconds, model, exit_reason, truncated,
 *   tokens: {input, output}, tool_trace: [{tool, input_summary, status}],
 *   cost_usd?, error?, failure_reason?}], total_duration_seconds}`
 *   (`tools/delegate_tool_dispatch.py` `_execute_and_aggregate`, entry from
 *   `delegate_tool_child_run.py`);
 * - background (the top-level default, `tools/delegate_tool.py`):
 *   `{status: "dispatched", delegation_id, goals, units?, subagent_ids?}` —
 *   accepted, results arriving later as their own turn, so each task is a
 *   `dispatched` row (`_dispatched_payload`); a multi-unit handle gives each
 *   task its own unit's delegation id.
 *
 * The goal comes from the call's arguments (`tasks[i].goal`, or `goal` for a
 * single task), since the results do not repeat it. A task's id is the
 * envelope's `subagent_ids[i]` when present, else the synthetic
 * `hist:<tool_id>:<task_index>`. Any other shape — an error result, plain
 * text, a future envelope — yields no rows and leaves the tool card alone.
 */
export function settledDelegation(
  toolId: string | null,
  args: unknown,
  result: unknown,
): SubagentBlock[] {
  const outcome = rec(result);
  if (!outcome) return [];
  const asked = rec(args);
  const tasks = arr(asked?.tasks);
  const goalOf = (index: number): string =>
    str(rec(tasks[index])?.goal) ?? (tasks.length === 0 ? (str(asked?.goal) ?? "") : "");
  const ids = arr(outcome.subagent_ids);
  const idOf = (index: number): string =>
    str(ids[index]) ?? `hist:${toolId ?? "delegate_task"}:${index}`;
  const base = (index: number, count: number) => ({
    kind: "subagent" as const,
    subagent_id: idOf(index),
    depth: 0,
    task_index: index,
    task_count: Math.max(1, count),
    goal: goalOf(index),
    tools: [],
    origin: "history" as const,
    ...(toolId ? { tool_id: toolId } : {}),
  });

  if (Array.isArray(outcome.results)) {
    const results = outcome.results.flatMap((value) => {
      const entry = rec(value);
      return entry ? [entry] : [];
    });
    const count = Math.max(results.length, tasks.length);
    return results.map((entry, position): SubagentBlock => {
      const index = nonNegativeIndex(entry.task_index) ?? position;
      const raw = str(entry.status);
      const status: SubagentStatus =
        raw !== null && HISTORY_STATUSES.has(raw) ? (raw as SubagentStatus) : "unobserved";
      const tokens = rec(entry.tokens);
      const usage = {
        ...optionalInt("input_tokens", num(tokens?.input) ?? num(tokens?.input_tokens)),
        ...optionalInt("output_tokens", num(tokens?.output) ?? num(tokens?.output_tokens)),
        ...optionalInt("reasoning_tokens", num(tokens?.reasoning) ?? num(tokens?.reasoning_tokens)),
        ...optionalInt("api_calls", num(entry.api_calls)),
      };
      const trace = arr(entry.tool_trace).flatMap((step) => {
        const item = rec(step);
        const name = str(item?.tool);
        if (!item || !name) return [];
        const failed = item.ok === false || str(item.status) === "error";
        return [
          {
            name,
            preview: str(item.input_summary) ?? str(item.input) ?? "",
            ...(failed ? { is_error: true } : {}),
          },
        ];
      });
      const seconds = num(entry.duration_seconds);
      const cost = num(entry.cost_usd);
      const resultFields = {
        ...(cost !== null && cost >= 0 ? { cost_usd: cost } : {}),
        ...(str(entry.failure_reason) ? { failure_reason: str(entry.failure_reason) ?? "" } : {}),
        ...(str(entry.exit_reason) ? { exit_reason: str(entry.exit_reason) ?? "" } : {}),
        ...(typeof entry.truncated === "boolean" ? { truncated: entry.truncated } : {}),
        ...(str(entry.error) ? { error: str(entry.error) ?? "" } : {}),
      };
      const id = str(entry.subagent_id);
      return {
        ...base(index, count),
        ...(id ? { subagent_id: id } : {}),
        status,
        verdict: subagentVerdict(status),
        ...(str(entry.model) ? { model: str(entry.model) ?? "" } : {}),
        ...(str(entry.summary) ? { summary: str(entry.summary) ?? "" } : {}),
        ...(seconds !== null && seconds >= 0 ? { duration_ms: Math.round(seconds * 1000) } : {}),
        tools: trace.slice(-SUBAGENT_TOOLS_MAX),
        tool_count: trace.length,
        ...(Object.keys(usage).length ? { usage } : {}),
        ...(Object.keys(resultFields).length ? { result: resultFields } : {}),
      };
    });
  }

  if (outcome.status === "dispatched") {
    const goals = arr(outcome.goals).filter((g): g is string => typeof g === "string");
    const count = goals.length || tasks.length || 1;
    // A multi-unit handle names each unit's own delegation id and the task
    // indexes it carries; a single unit is the top-level `delegation_id`.
    const unitOf = new Map<number, string>();
    for (const value of arr(outcome.units)) {
      const unit = rec(value);
      const id = str(unit?.delegation_id);
      if (!id) continue;
      for (const index of arr(unit?.task_indexes)) {
        const n = nonNegativeIndex(index);
        if (n !== null) unitOf.set(n, id);
      }
    }
    const top = str(outcome.delegation_id);
    return Array.from({ length: count }, (_, index): SubagentBlock => {
      const delegation = unitOf.get(index) ?? top;
      return {
        ...base(index, count),
        goal: goals[index] ?? goalOf(index),
        status: "dispatched",
        verdict: subagentVerdict("dispatched"),
        ...(delegation ? { delegation_id: delegation } : {}),
      };
    });
  }
  return [];
}

function nonNegativeIndex(value: unknown): number | null {
  const n = num(value);
  return n !== null && Number.isInteger(n) && n >= 0 ? n : null;
}

function optionalInt<K extends string>(key: K, value: number | null): { [P in K]?: number } {
  return value !== null && value >= 0 ? ({ [key]: Math.floor(value) } as { [P in K]?: number }) : {};
}

/** A settled clarify's choices: the non-blank strings, in the order offered. */
function settledChoices(value: unknown): string[] {
  return arr(value).filter((choice): choice is string => typeof choice === "string" && !!choice.trim());
}

/**
 * One durable row's blocks. `atTail` is true when no visible row other than a
 * tool result follows this one in the rows `mapHistory` was given.
 */
function durableHistoryBlocks(
  row: Record<string, unknown>,
  calls: ReadonlyMap<string, Record<string, unknown>>,
  completed: ReadonlySet<string>,
  atTail: boolean,
): ChatBlock[] {
  const id = str(row.tool_call_id);
  if (row.role === "tool" && (id || str(row.tool_name))) {
    const call = id ? calls.get(id) : undefined;
    const fn = rec(call?.function);
    const result = storedJson(row.display_content ?? row.content);
    const metadata = rec(result);
    const name = str(row.tool_name) ?? str(fn?.name) ?? "tool";
    const args = storedJson(fn?.arguments) ?? null;
    const tool = toolBlock(
      {
        tool_id: id,
        name,
        args,
        result,
        exit_code: metadata?.exit_code,
        error: metadata?.error,
        status: metadata?.status,
      },
      null,
    );
    const lower = name.toLowerCase();
    if (lower === "delegate_task") return [tool, ...settledDelegation(id, args, result)];
    const settled = lower === "clarify" ? settledClarify(args, result) : null;
    return settled ? [tool, settled] : [tool];
  }
  const blocks = historyBlocks(row);
  for (const value of arr(row.tool_calls)) {
    const call = rec(value);
    const callId = str(call?.id) ?? str(call?.call_id);
    const fn = rec(call?.function);
    if (callId && fn && str(fn.name)) {
      // The result row owns the completed card. Pairing by ID, across the whole
      // requested transcript, keeps parallel same-name tools and page edges safe.
      //
      // A call with no result row is `running` when its assistant row is at the
      // tail — nothing but tool results follows it — because the box may still
      // be running it (a long foreground `terminal` call looks exactly like
      // this). Read from history, `running` means only "no result yet, may
      // still be running"; the head words it from the observed busy state. Once
      // any other row follows (a user prompt, a steer, a notice, the bot's next
      // reply), the turn moved on without the result, so the call was
      // abandoned and is `warn`. The tail is the tail of the rows read, which
      // is the transcript's own for both reads `history` makes (every page, or
      // the newest `limit` rows, chronological). A caller handing in an older
      // page alone ends mid-transcript, so a call whose result sits on the
      // next page would read `running` there.
      if (!completed.has(callId))
        blocks.push(
          toolBlock(
            {
              tool_id: callId,
              name: fn.name,
              args: storedJson(fn.arguments) ?? null,
              result: null,
              status: atTail ? "running" : "warn",
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

/**
 * What identifies one page of the paged history read, for its repeated-page
 * guard: the rows' durable identities in order, when every row has one.
 *
 * The guard exists for a dashboard that ignores `offset` and hands back the
 * same page for ever. Two pages fetched at different offsets carrying the same
 * ids in the same order are that repeat, whatever their content says — a row
 * edited between the two fetches does not make the second a new page — so the
 * ids are the whole question and the bodies need not be serialised. A page
 * with a row lacking any identity falls back to its full serialisation.
 */
export function pageKey(rows: readonly unknown[]): string {
  const ids: string[] = [];
  for (const row of rows) {
    const r = rec(row);
    const id =
      str(r?.id) ??
      str(r?.message_id) ??
      num(r?.id)?.toString() ??
      num(r?.row_id)?.toString() ??
      str(r?.row_id);
    if (id === null || id === undefined) return `raw\u0000${JSON.stringify(rows)}`;
    ids.push(id);
  }
  return `ids\u0000${ids.join("\u0000")}`;
}
