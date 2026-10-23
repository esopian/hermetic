/** Pinned Hermes event vocabulary translated once, before either head renders it. */
import type { ApprovalChoice, ChatBlock, RequestCloseReason } from "../../schema/chat.ts";
import { todoSnapshotFrom } from "./hermes-chat-todos.ts";

type Activity = Extract<ChatBlock, { kind: "activity" }>;
const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const level = (value: unknown): Activity["state"] =>
  value === "error" || value === "failed" || value === "timeout"
    ? "error"
    : value === "warn" || value === "warning" || value === "interrupted"
      ? "warning"
      : "done";

/**
 * `status` for a replaceable "what is happening now" snapshot (connection,
 * queue, history load, usage tally, "preparing" spinner, moa aggregation
 * progress, `status.update` notices); `work` for everything that recorded
 * something the turn did (plain notices, errors, subagent progress, and the
 * rest of the notice-category events below).
 */
export function defaultRole(category: Activity["category"], key: string): "status" | "work" {
  if (
    category === "connection" ||
    category === "queue" ||
    category === "history" ||
    category === "usage"
  )
    return "status";
  if (category === "generation")
    return key === "generation" || key === "model:aggregation" ? "status" : "work";
  if (category === "notice") return key.startsWith("status:") ? "status" : "work";
  return "work";
}

/**
 * Null means unfamiliar: the adapter must keep the original unknown block.
 * `now` (epoch ms) is read only for a connection deadline's time left.
 */
export function hermesActivity(
  type: string,
  payload: Record<string, unknown>,
  now: () => number = Date.now,
): Activity | null {
  const make = (
    category: Activity["category"],
    key: string,
    title: string,
    state: Activity["state"] = "running",
    detail: string | null = null,
  ): Activity => ({
    kind: "activity",
    category,
    key,
    title,
    state,
    detail,
    role: defaultRole(category, key),
    payload,
  });
  switch (type) {
    case "chat.status":
      if (payload.state === "connecting")
        return make("connection", "connection", "Connecting to Hermes");
      if (payload.state === "queued") return make("queue", "queue", "Waiting for the agent");
      return null;
    case "session.resume_progress": {
      if (
        typeof payload.phase !== "string" ||
        !["loading", "complete", "failed"].includes(String(payload.status))
      )
        return null;
      return make(
        "history",
        `history:${payload.phase}`,
        payload.status === "failed"
          ? "Conversation could not be loaded"
          : payload.status === "complete"
            ? "Conversation loaded"
            : "Loading conversation",
        payload.status === "failed" ? "error" : payload.status === "complete" ? "done" : "running",
        text(payload.message),
      );
    }
    case "tool.generating":
      return text(payload.name) ? make("generation", "generation", `Preparing ${payload.name}`) : null;
    case "session.usage": {
      const usage = record(payload.usage);
      if (!usage) return null;
      const pieces: string[] = [];
      const input = usage.input ?? usage.prompt;
      const output = usage.output ?? usage.completion;
      if (typeof input === "number") pieces.push(`${input.toLocaleString("en-US")} input tokens`);
      if (typeof output === "number") pieces.push(`${output.toLocaleString("en-US")} output tokens`);
      if (typeof usage.cost_usd === "number") pieces.push(`$${usage.cost_usd.toFixed(4)}`);
      return make("usage", "usage", "Current usage", "running", pieces.join(" · ") || null);
    }
    case "status.update":
      return text(payload.text)
        ? make("notice", `status:${text(payload.kind) ?? "status"}`, String(payload.text))
        : null;
    case "notice":
    case "error":
      return text(payload.message)
        ? make("notice", type, String(payload.message), type === "error" ? "error" : "done")
        : null;
    case "notification.show":
      return text(payload.text)
        ? make(
            "notice",
            `notification:${text(payload.key) ?? text(payload.id) ?? payload.text}`,
            String(payload.text),
            level(payload.level),
          )
        : null;
    case "notification.clear":
      return text(payload.key)
        ? make("notice", `notification:${payload.key}`, "Notice dismissed", "done")
        : null;
    case "session.reclaimed":
      return make(
        "notice",
        "session:reclaimed",
        "Agent session was released",
        "warning",
        text(payload.reason),
      );
    case "request.cancel": {
      const reason = closeReason(payload.reason);
      return {
        ...make(
          "notice",
          `request:${text(payload.id) ?? "unknown"}`,
          "Request closed",
          "done",
          CLOSE_COPY[reason] ?? text(payload.reason),
        ),
        request_id: text(payload.id),
        reason,
      };
    }
    case "connection.request":
    case "connection.update":
      return connectionNotice(type, payload, now);
    case "browser.progress":
      return text(payload.message)
        ? make("notice", "browser", String(payload.message), level(payload.level))
        : null;
    case "preview.restart.progress":
      return text(payload.text)
        ? make(
            "notice",
            `preview:${text(payload.task_id) ?? "restart"}`,
            String(payload.text),
            level(payload.level),
          )
        : null;
    case "review.summary":
    case "background.complete":
    case "btw.complete":
    case "preview.restart.complete":
      return text(payload.text)
        ? make(
            "notice",
            `${type}:${text(payload.task_id) ?? "latest"}`,
            type === "review.summary" ? "Review finished" : "Background work finished",
            "done",
            String(payload.text),
          )
        : null;
    // `subagent.*` is not an activity: the turn and the observation fold it
    // into whole `subagent` blocks (`hermes-chat-subagent.ts`) before any
    // event reaches this mapping.
    case "moa.reference":
      return make(
        "notice",
        `reference:${text(payload.label) ?? String(payload.index ?? "reference")}`,
        text(payload.label) ?? "Model reference",
        "done",
        text(payload.text),
      );
    case "moa.aggregating":
    case "moa.progress":
    case "moa.phase":
      return make(
        "generation",
        "model:aggregation",
        "Combining model responses",
        "running",
        typeof payload.refs_done === "number" && typeof payload.refs_total === "number"
          ? `${payload.refs_done} of ${payload.refs_total} references ready`
          : text(payload.aggregator),
      );
    case "todo.updated": {
      // Null for a list that does not parse; the turn then drops the event.
      const todos = todoSnapshotFrom(payload);
      if (!todos) return null;
      return {
        ...make("notice", "tasks", "Task list updated", "done", `${todos.todos.length} tasks`),
        todos,
      };
    }
    default:
      return null;
  }
}

/** Upstream's `request.cancel` reason, in its own spelling; anything else is `other`. */
function closeReason(value: unknown): RequestCloseReason {
  return value === "timeout" ||
    value === "interrupted" ||
    value === "shutdown" ||
    value === "resolved" ||
    value === "session_closed"
    ? value
    : "other";
}

/**
 * The close notice's `detail`, as copy. `other` keeps upstream's own words.
 * `resolved` is neutral on purpose: upstream sends it after *this* laptop's
 * own answer as well as another surface's (`tools/approval_gateway_wait.py`),
 * so "answered elsewhere" would be wrong half the time.
 */
const CLOSE_COPY: Partial<Record<RequestCloseReason, string>> = {
  timeout: "Timed out",
  interrupted: "Cancelled when the turn stopped",
  shutdown: "Cancelled: the gateway shut down",
  resolved: "Answered",
  session_closed: "Withdrawn: the session closed",
};

/**
 * A connector connection request (`connection.request`, and its
 * `connection.update`s), as one notice keyed `connection:<op_id>` (D14/D26).
 *
 * hermetic cannot answer one — the card's Skip/Continue need a Desktop-only
 * connector catalog — so this says what was asked and that the agent carries
 * on after the operation's deadline. The payload kept on the block is only
 * `{op_id, seq, deadline_at}`: a target's `connect_url` is an authorization
 * link and its `connection_id` a vendor account, and neither is ever surfaced.
 * A stale update is dropped before this point (`createConnectionGate`).
 */
function connectionNotice(
  type: string,
  payload: Record<string, unknown>,
  now: () => number,
): Activity | null {
  const op = text(payload.op_id);
  if (!op) return null;
  // An account-scoped operation is broadcast to every socket with an empty
  // session id (`methods_connectors.py` `_connection_update`); it belongs to no
  // conversation, so it is no turn's notice.
  if (record(payload.owner)?.type === "account") return null;
  const targets = Array.isArray(payload.targets)
    ? payload.targets.map(record).filter((t): t is Record<string, unknown> => t !== null)
    : [];
  const settled = payload.settled === true || typeof payload.settled_at === "number";
  // A request names the operation's whole budget; an update names only its
  // deadline (epoch seconds), so the time left is read off the clock.
  const timeout =
    typeof payload.timeout_seconds === "number"
      ? payload.timeout_seconds
      : typeof payload.deadline_at === "number"
        ? Math.max(0, payload.deadline_at - now() / 1000)
        : null;
  const named = (t: Record<string, unknown>) => text(t.name) ?? text(t.kind) ?? "connector";
  const detail = settled
    ? targets.map((t) => `${named(t)}: ${text(t.state) ?? "closed"}`).join(" · ")
    : [
        targets.map((t) => [named(t), text(t.action)].filter(Boolean).join(" · ")).join(", "),
        timeout !== null ? `the agent continues after ${Math.round(timeout)}s` : null,
      ]
        .filter(Boolean)
        .join("; ");
  return {
    kind: "activity",
    category: "notice",
    key: `connection:${op}`,
    title:
      type === "connection.update" && settled
        ? "Connection request closed"
        : "Connection request — not supported on hermetic",
    state: settled ? "done" : "running",
    detail: detail || null,
    role: "work",
    payload: {
      op_id: op,
      ...(typeof payload.seq === "number" ? { seq: payload.seq } : {}),
      ...(typeof payload.deadline_at === "number" ? { deadline_at: payload.deadline_at } : {}),
    },
  };
}

/**
 * Drops a `connection.*` event whose operation `seq` is not above the one this
 * turn already showed for the same `op_id`, so a late or replayed update (or
 * the resume snapshot of one already seen) cannot roll a notice back. One per
 * turn; every other event passes.
 */
export function createConnectionGate() {
  const held = new Map<string, number>();
  return {
    stale(type: string, payload: Record<string, unknown>): boolean {
      if (type !== "connection.request" && type !== "connection.update") return false;
      const op = text(payload.op_id);
      const seq = typeof payload.seq === "number" ? payload.seq : null;
      if (!op || seq === null) return false;
      const last = held.get(op);
      if (last !== undefined && seq <= last) return true;
      held.set(op, seq);
      return false;
    },
  };
}

/** Upstream's choice strings, in the gateway's order. `all` is never offered. */
const APPROVAL_ORDER: readonly ApprovalChoice[] = ["once", "session", "always", "deny"];

/**
 * The choices an approval offers: the request's own `choices` when it sent
 * any usable ones (unknown values dropped, its order kept), else the gateway's fill rule
 * (`tui_gateway/server.py` `_approval_request_payload`): `once`; `session` when
 * not `smart_denied` and `allow_session` is not false; `always` under that
 * when `allow_permanent` is not false; then `deny`.
 */
export function approvalChoices(payload: Record<string, unknown>): ApprovalChoice[] {
  if (Array.isArray(payload.choices)) {
    const known = new Set<string>(APPROVAL_ORDER);
    const kept = payload.choices.filter(
      (c): c is ApprovalChoice => typeof c === "string" && known.has(c),
    );
    // A list with nothing usable in it is no offer at all: the fill rule
    // decides, rather than a card with no buttons.
    if (kept.length) return [...new Set(kept)];
  }
  const choices: ApprovalChoice[] = ["once"];
  if (payload.smart_denied !== true && payload.allow_session !== false) {
    choices.push("session");
    if (payload.allow_permanent !== false) choices.push("always");
  }
  choices.push("deny");
  return choices;
}

const RECOMMENDED = "(Recommended)";

/**
 * The choices a clarify can actually offer, filtered the way Hermes Desktop
 * does (`store/clarify.ts` `normalizeChoices`): non-blank, single-line, and at
 * most 200 characters before the backend's " (Recommended)" suffix. Anything
 * else would be a dead button; an empty result means a free-text answer.
 */
function clarifyChoices(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((choice): choice is string => {
    if (typeof choice !== "string" || !choice.trim() || choice.includes("\n")) return false;
    const bare = choice.endsWith(RECOMMENDED) ? choice.slice(0, -RECOMMENDED.length).trim() : choice;
    return bare.length <= 200;
  });
}

type QuestionEntry = NonNullable<Extract<ChatBlock, { kind: "question" }>["questions"]>[number];

/**
 * A batch clarify's questions in the gateway's order. An entry without a
 * string `qid` or a non-blank question cannot be answered and is dropped, and
 * `multi_select` only counts when some choice survives. `answers` is present
 * only when the request was replayed from `open_requests`, holding the locks
 * the gateway already recorded.
 */
function clarifyQuestions(payload: Record<string, unknown>): QuestionEntry[] {
  if (!Array.isArray(payload.questions)) return [];
  const locked = record(payload.answers);
  const entries: QuestionEntry[] = [];
  for (const value of payload.questions) {
    const row = record(value);
    const qid = row && typeof row.qid === "string" && row.qid.trim() ? row.qid : null;
    const prompt = row && typeof row.question === "string" ? row.question.trim() : "";
    if (!row || !qid || !prompt) continue;
    const choices = clarifyChoices(row.choices);
    const answer = locked?.[qid];
    entries.push({
      id: qid,
      prompt,
      choices,
      multi_select: row.multi_select === true && choices.length > 0,
      answer: typeof answer === "string" ? answer : null,
    });
  }
  return entries;
}

/**
 * A gateway server request as one block. Approvals and clarifies become the
 * cards `chat.respond` answers; a clarify is one block however many questions
 * it carries, because the gateway keeps it open until every question is
 * answered. Any other request stays visible as a notice pointing at Hermes.
 */
export function hermesRequest(
  method: string,
  id: string,
  payload: Record<string, unknown>,
): ChatBlock[] {
  const expires = text(payload.expires_at);
  const expires_at =
    expires && Number.isFinite(Date.parse(expires)) ? new Date(expires).toISOString() : null;
  if (method === "approval")
    return [
      {
        kind: "approval",
        tool: text(payload.tool_name) ?? "command",
        summary: text(payload.command) ?? text(payload.description) ?? "Approval requested",
        detail: text(payload.description),
        expires_at,
        request_id: id,
        choices: approvalChoices(payload),
        ...(payload.smart_denied === true ? { smart_denied: true } : {}),
        ...(text(payload.description) ? { pattern: String(payload.description) } : {}),
        payload,
      },
    ];
  if (method === "clarify") {
    if (Array.isArray(payload.questions)) {
      const questions = clarifyQuestions(payload);
      const first = questions[0];
      if (first)
        return [
          {
            kind: "question",
            prompt: first.prompt,
            choices: first.choices,
            multi_select: first.multi_select,
            questions,
            request_id: id,
            expires_at,
            payload,
          },
        ];
    } else if (typeof payload.question === "string" && payload.question.trim()) {
      const choices = clarifyChoices(payload.choices);
      return [
        {
          kind: "question",
          prompt: payload.question,
          choices,
          ...(payload.multi_select === true && choices.length ? { multi_select: true } : {}),
          request_id: id,
          expires_at,
          payload,
        },
      ];
    }
  }
  return [
    {
      kind: "activity",
      category: "notice",
      key: `request:${id}`,
      title: "Hermes needs your attention",
      state: "warning",
      detail: "Respond in Hermes to continue.",
      role: "work",
      payload: { method, request_id: id, ...payload },
    },
  ];
}
