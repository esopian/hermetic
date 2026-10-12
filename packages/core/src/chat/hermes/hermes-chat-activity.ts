/** Pinned Hermes event vocabulary translated once, before either head renders it. */
import type { ChatBlock } from "../../schema/chat.ts";

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

/** Null means unfamiliar: the adapter must keep the original unknown block. */
export function hermesActivity(type: string, payload: Record<string, unknown>): Activity | null {
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
    case "tool.output_risk":
      return make(
        "notice",
        `risk:${text(payload.tool_id) ?? text(payload.name) ?? "tool"}`,
        payload.redacted === true ? "Tool output was redacted" : "Tool output needs review",
        "warning",
        Array.isArray(payload.findings)
          ? payload.findings.filter((item): item is string => typeof item === "string").join(" · ")
          : text(payload.risk),
      );
    case "session.reclaimed":
      return make(
        "notice",
        "session:reclaimed",
        "Agent session was released",
        "warning",
        text(payload.reason),
      );
    case "request.cancel":
      return {
        ...make(
          "notice",
          `request:${text(payload.id) ?? "unknown"}`,
          "Request closed",
          "done",
          text(payload.reason),
        ),
        request_id: text(payload.id),
      };
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
    case "subagent.spawn_requested":
    case "subagent.start":
    case "subagent.progress":
    case "subagent.thinking":
    case "subagent.tool":
    case "subagent.complete":
      return make(
        "generation",
        `subagent:${text(payload.subagent_id) ?? text(payload.delegation_id) ?? String(payload.task_index ?? "child")}`,
        type === "subagent.complete"
          ? payload.status === "timeout"
            ? "Delegated work timed out"
            : payload.status === "interrupted"
              ? "Delegated work was interrupted"
              : level(payload.status) === "error"
                ? "Delegated work failed"
                : "Delegated work finished"
          : "Delegated work in progress",
        type === "subagent.complete" ? level(payload.status) : "running",
        text(payload.summary) ?? text(payload.text) ?? text(payload.goal),
      );
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
    case "todo.updated":
      return Array.isArray(payload.todos)
        ? make("notice", "tasks", "Task list updated", "done", `${payload.todos.length} tasks`)
        : null;
    default:
      return null;
  }
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
