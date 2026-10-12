/**
 * Delegated children (`delegate_task`) as whole `subagent` blocks.
 *
 * The gateway relays a child's life on the *parent* session as
 * `subagent.spawn_requested|start|progress|thinking|tool|complete`
 * (`tui_gateway/tool_progress.py` `_progress_subagent`): each event carries
 * `goal`, `task_index` and `task_count`, plus whichever of the whitelisted
 * fields (`_SUBAGENT_FIELDS`) the child had — ids, depth, model, counters,
 * files, the last tool's name and preview, and on `complete` the status,
 * summary, duration and output tail. Nothing here is a delta a head could
 * replay on its own, so the ledger accumulates per `subagent_id` and hands back
 * the **whole block** on every change: a head's replace-by-key merge is then
 * the entire reducer.
 *
 * Pure: no socket, no clock unless one is injected. One ledger per session,
 * owned by whoever outlives a turn, because a background delegation keeps
 * reporting after the turn that started it has ended.
 */
import {
  SUBAGENT_TOOLS_MAX,
  type SubagentBlock,
  type SubagentStatus,
  type SubagentVerdict,
} from "../../schema/chat.ts";
import { arr, num, rec, str } from "./hermes-chat-wire.ts";

/** Upstream's terminal statuses (`TERMINAL_SUBAGENT_STATUSES`). */
const TERMINAL: ReadonlySet<SubagentStatus> = new Set([
  "completed",
  "failed",
  "error",
  "timeout",
  "interrupted",
]);

const WIRE_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "completed",
  "failed",
  "error",
  "timeout",
  "interrupted",
]);

/**
 * The fold a head colours by. `timeout` and `error` are failures; a status
 * this build does not know — including hermetic's own `unobserved` — is
 * `unknown`, never success.
 */
export function subagentVerdict(status: string): SubagentVerdict {
  switch (status) {
    case "queued":
    case "running":
    case "dispatched":
      return "running";
    case "completed":
      return "done";
    case "failed":
    case "error":
    case "timeout":
      return "failed";
    case "interrupted":
      return "stopped";
    default:
      return "unknown";
  }
}

/**
 * Upstream's note when a steer reached a child too late to be delivered
 * (`delegate_tool_child_run.py`: `[steer did not land — …]`, appended to the
 * summary). Q5's third step reads it: "Steer did not land".
 */
export function steerMissed(summary: string | null | undefined): boolean {
  return typeof summary === "string" && summary.includes("[steer did not land");
}

/** The ledger's event vocabulary; anything else is not the ledger's. */
const EVENTS = new Set([
  "subagent.spawn_requested",
  "subagent.start",
  "subagent.progress",
  "subagent.thinking",
  "subagent.tool",
  "subagent.complete",
]);

export function isSubagentEvent(method: string): boolean {
  return EVENTS.has(method);
}

/**
 * The key a child is held under. Upstream's identity fields are optional
 * (older emitters omit them); without a `subagent_id` the child is named by
 * its delegation, depth and index, which is as unique as the wire allows.
 */
function identity(params: Record<string, unknown>): string {
  const id = str(params.subagent_id);
  if (id) return id;
  return `anon:${str(params.delegation_id) ?? "-"}:${num(params.depth) ?? 0}:${num(params.task_index) ?? 0}`;
}

function strings(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === "string");
}

function nonNegativeInt(value: unknown): number | null {
  const n = num(value);
  return n !== null && n >= 0 ? Math.floor(n) : null;
}

interface Row {
  block: SubagentBlock;
  /** Tool calls observed, uncapped: `tool_count` when the wire sends none. */
  seen: number;
  /** A `complete` arrived: later events are stale and ignored. */
  terminal: boolean;
}

export interface SubagentLedgerOptions {
  /** ISO-8601 now, for `started_at`; absent leaves it unset. */
  now?: () => string;
}

export function createSubagentLedger(opts: SubagentLedgerOptions = {}) {
  const rows = new Map<string, Row>();

  /** A defensive copy: an emitted block never changes under its holder. */
  function snapshot(block: SubagentBlock): SubagentBlock {
    return structuredClone(block);
  }

  function create(params: Record<string, unknown>, id: string, method: string): Row {
    const block: SubagentBlock = {
      kind: "subagent",
      subagent_id: id,
      depth: nonNegativeInt(params.depth) ?? 0,
      task_index: nonNegativeInt(params.task_index) ?? 0,
      task_count: Math.max(1, nonNegativeInt(params.task_count) ?? 1),
      goal: str(params.goal) ?? "",
      status: method === "subagent.spawn_requested" ? "queued" : "running",
      verdict: "running",
      tools: [],
      origin: "live",
    };
    if (method === "subagent.start" && opts.now) block.started_at = opts.now();
    const row: Row = { block, seen: 0, terminal: false };
    rows.set(id, row);
    return row;
  }

  /** Fields any event may refresh: identity, model, counters, files. */
  function refresh(block: SubagentBlock, params: Record<string, unknown>): void {
    const goal = str(params.goal);
    if (goal) block.goal = goal;
    for (const key of ["delegation_id", "parent_id", "child_session_id", "model"] as const) {
      const value = str(params[key]);
      if (value) block[key] = value;
    }
    const depth = nonNegativeInt(params.depth);
    if (depth !== null) block.depth = depth;
    const count = nonNegativeInt(params.task_count);
    if (count !== null && count > 0) block.task_count = count;
    const read = strings(params.files_read);
    if (read?.length) block.files_read = read;
    const written = strings(params.files_written);
    if (written?.length) block.files_written = written;
    const usage = { ...block.usage };
    let touched = false;
    for (const key of ["input_tokens", "output_tokens", "reasoning_tokens", "api_calls"] as const) {
      const value = nonNegativeInt(params[key]);
      if (value !== null) {
        usage[key] = value;
        touched = true;
      }
    }
    if (touched) block.usage = usage;
  }

  /**
   * One gateway event. Returns the child's whole block when the event changed
   * it, or null: not a subagent event, a child this ledger never saw spawn or
   * start (only those two create a row), or a row already terminal.
   */
  function apply(method: string, params: Record<string, unknown>): SubagentBlock | null {
    if (!EVENTS.has(method)) return null;
    const id = identity(params);
    let row = rows.get(id);
    if (!row) {
      if (method !== "subagent.spawn_requested" && method !== "subagent.start") return null;
      row = create(params, id, method);
    } else if (row.terminal) {
      return null;
    }
    const block = row.block;
    refresh(block, params);
    switch (method) {
      case "subagent.spawn_requested":
        break;
      case "subagent.start":
        if (block.status === "queued" || block.status === "unobserved") block.status = "running";
        if (!block.started_at && opts.now) block.started_at = opts.now();
        break;
      case "subagent.progress": {
        if (block.status !== "running") block.status = "running";
        const text = str(params.text);
        if (text) block.progress = text;
        break;
      }
      case "subagent.thinking": {
        if (block.status !== "running") block.status = "running";
        const text = str(params.text);
        if (text) block.thinking = text;
        break;
      }
      case "subagent.tool": {
        if (block.status !== "running") block.status = "running";
        const name = str(params.tool_name);
        if (name) {
          row.seen += 1;
          block.tools = [
            ...block.tools,
            { name, preview: str(params.tool_preview) ?? str(params.text) ?? "" },
          ].slice(-SUBAGENT_TOOLS_MAX);
        }
        break;
      }
      case "subagent.complete": {
        row.terminal = true;
        const raw = str(params.status);
        // Desktop folds `cancelled` into an interruption; anything else this
        // build does not know ended the child in a way nobody can name.
        const status: SubagentStatus =
          raw === "cancelled" || raw === "canceled"
            ? "interrupted"
            : raw !== null && WIRE_STATUSES.has(raw) && TERMINAL.has(raw as SubagentStatus)
              ? (raw as SubagentStatus)
              : "unobserved";
        block.status = status;
        const summary = str(params.summary);
        if (summary) block.summary = summary;
        const seconds = num(params.duration_seconds);
        if (seconds !== null && seconds >= 0) block.duration_ms = Math.round(seconds * 1000);
        const tail = arr(params.output_tail).flatMap((entry) => {
          const item = rec(entry);
          const name = str(item?.tool);
          if (!item || !name) return [];
          return [
            {
              name,
              preview: str(item.preview) ?? "",
              ...(item.is_error === true ? { is_error: true } : {}),
            },
          ];
        });
        if (tail.length) block.output_tail = tail;
        break;
      }
    }
    const wireCount = nonNegativeInt(params.tool_count);
    if (wireCount !== null) block.tool_count = wireCount;
    else if (row.seen > 0) block.tool_count = Math.max(block.tool_count ?? 0, row.seen);
    block.verdict = subagentVerdict(block.status);
    return snapshot(block);
  }

  /**
   * Reconcile against the gateway's live roster (`subagent.list`, active
   * children only) after a reconnect: a row that is neither terminal nor on
   * the roster ended while nobody was listening, and becomes `unobserved` /
   * `unknown` — never inferred success or interruption. Returns the rows it
   * changed. A later event for the same child (a replayed `complete`) still
   * applies, because an unobserved row is not terminal.
   */
  function markUnobserved(rosterIds: Iterable<string>): SubagentBlock[] {
    const live = new Set(rosterIds);
    const changed: SubagentBlock[] = [];
    for (const [id, row] of rows) {
      if (row.terminal || live.has(id) || row.block.status === "unobserved") continue;
      row.block.status = "unobserved";
      row.block.verdict = "unknown";
      changed.push(snapshot(row.block));
    }
    return changed;
  }

  function get(id: string): SubagentBlock | null {
    const row = rows.get(id);
    return row ? snapshot(row.block) : null;
  }

  function all(): SubagentBlock[] {
    return [...rows.values()].map((row) => snapshot(row.block));
  }

  return { apply, markUnobserved, get, all };
}

export type SubagentLedger = ReturnType<typeof createSubagentLedger>;
