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
  /**
   * The session's latest event `seq` when a roster snapshot last replaced
   * this row: an event at or below it is older than the snapshot and changes
   * nothing. Zero when no snapshot did, or the gateway named no `seq`.
   */
  watermark: number;
  /** The snapshot's `tool_count`: a tool event counting fewer is older than it. */
  floor: number;
  /** The highest event `seq` applied to this row; zero when none named one. */
  lastSeq: number;
}

export interface SubagentLedgerOptions {
  /** ISO-8601 now, for `started_at`; absent leaves it unset. */
  now?: () => string;
}

/**
 * How many applied event sequence numbers a ledger remembers. A session's
 * `seq` is upstream's per-session counter; the same event reaches a ledger
 * twice when a turn socket and an observation socket both carry it, and once
 * more on a reconnect replay.
 */
const SEEN_SEQ_MAX = 1024;

/**
 * Finished children a ledger keeps. A ledger lives as long as its session,
 * which may delegate for days; every child still running is kept whatever
 * this says, and the oldest finished ones go first.
 */
export const SUBAGENT_TERMINAL_MAX = 64;

export function createSubagentLedger(opts: SubagentLedgerOptions = {}) {
  const rows = new Map<string, Row>();
  /** Sequence numbers already applied, oldest first (a `Set` keeps insertion order). */
  const seen = new Set<number>();
  /** Finished children, oldest first: what is dropped past `SUBAGENT_TERMINAL_MAX`. */
  const finished: string[] = [];

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
    const row: Row = { block, seen: 0, terminal: false, watermark: 0, floor: 0, lastSeq: 0 };
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
  function apply(
    method: string,
    params: Record<string, unknown>,
    seq?: number | null,
  ): SubagentBlock | null {
    if (!EVENTS.has(method)) return null;
    const id = identity(params);
    // An event this ledger already applied — the same frame on a second
    // socket, or a replay — changes nothing, but its carrier still gets the
    // child's whole current block, so either stream can render it.
    if (typeof seq === "number" && seq > 0) {
      if (seen.has(seq)) {
        const known = rows.get(id);
        return known ? snapshot(known.block) : null;
      }
      seen.add(seq);
      if (seen.size > SEEN_SEQ_MAX) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
    }
    let row = rows.get(id);
    if (!row) {
      if (method !== "subagent.spawn_requested" && method !== "subagent.start") return null;
      row = create(params, id, method);
    } else if (row.terminal) {
      return null;
    } else if (typeof seq === "number" && seq > 0 && seq <= row.watermark) {
      // Older than the roster snapshot that already replaced this row.
      return snapshot(row.block);
    }
    if (typeof seq === "number" && seq > row.lastSeq) row.lastSeq = seq;
    const block = row.block;
    const wireCount = nonNegativeInt(params.tool_count);
    // A tool event counting fewer calls than the snapshot did is older than it
    // (a gateway that names no `seq` leaves only this to go by).
    if (method === "subagent.tool" && wireCount !== null && wireCount < row.floor)
      return snapshot(block);
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
        finished.push(id);
        while (finished.length > SUBAGENT_TERMINAL_MAX) {
          const oldest = finished.shift();
          if (oldest !== undefined) rows.delete(oldest);
        }
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
    // Monotonic: no event — late, replayed, or racing a snapshot — moves the
    // count backwards.
    if (wireCount !== null) block.tool_count = Math.max(block.tool_count ?? 0, wireCount);
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

  /**
   * Reconcile against the gateway's live roster after a reconnect
   * (`subagent.list`: active children only, `{subagent_id, status,
   * tool_count, last_tool, …}`), returning every row it changed.
   *
   * A non-terminal row on the roster becomes `origin: "replay"` with the
   * roster's live status, the larger of the two tool counts (a snapshot older
   * than the events already applied must not move a count backwards), and the
   * roster's last tool when the row does not already end with it. A row off
   * the roster goes through `markUnobserved`. Terminal rows are never touched,
   * so a `complete` applied before the snapshot arrived stands.
   *
   * `watermark` is the session's latest event `seq` taken just before the
   * roster was read: an event at or below it that arrives afterwards (one
   * buffered on another socket while the snapshot was in flight) is older
   * than the snapshot and leaves the replayed row alone.
   */
  function replay(roster: readonly unknown[], watermark?: number | null): SubagentBlock[] {
    const listed = new Map<string, Record<string, unknown>>();
    for (const value of roster) {
      const entry = rec(value);
      const id = str(entry?.subagent_id);
      if (entry && id) listed.set(id, entry);
    }
    const changed: SubagentBlock[] = [];
    for (const [id, entry] of listed) {
      const row = rows.get(id);
      if (!row || row.terminal) continue;
      // An event newer than the snapshot is already applied: the snapshot has
      // nothing to add, and its status and last tool would be a step back.
      if (typeof watermark === "number" && row.lastSeq > watermark) continue;
      const block = row.block;
      block.origin = "replay";
      const status = str(entry.status);
      // Running never goes back to queued on a snapshot's word.
      if (status === "running" || (status === "queued" && block.status !== "running"))
        block.status = status;
      else if (block.status === "unobserved") block.status = "running";
      for (const key of ["model", "delegation_id", "parent_id"] as const) {
        const value = str(entry[key]);
        if (value && !block[key]) block[key] = value;
      }
      const count = nonNegativeInt(entry.tool_count);
      // The roster's last tool is news only when the roster has counted more
      // calls than this row already has: otherwise it is this row's own last
      // tool, or an older one.
      const last = str(entry.last_tool);
      if (
        last &&
        count !== null &&
        count > (block.tool_count ?? 0) &&
        block.tools.at(-1)?.name !== last
      ) {
        row.seen += 1;
        block.tools = [...block.tools, { name: last, preview: "" }].slice(-SUBAGENT_TOOLS_MAX);
      }
      if (count !== null) {
        block.tool_count = Math.max(block.tool_count ?? 0, count);
        row.floor = Math.max(row.floor, count);
      }
      if (typeof watermark === "number" && watermark > row.watermark) row.watermark = watermark;
      const started = num(entry.started_at);
      if (!block.started_at && started !== null && started > 0)
        block.started_at = new Date(started * 1000).toISOString();
      block.verdict = subagentVerdict(block.status);
      changed.push(snapshot(block));
    }
    return [...changed, ...markUnobserved(listed.keys())];
  }

  /**
   * Record the parent `delegate_task` tool block a child belongs to. Returns
   * the whole block when that changed it, else null.
   */
  function link(id: string, toolId: string): SubagentBlock | null {
    const row = rows.get(id);
    if (!row || row.block.tool_id === toolId) return null;
    row.block.tool_id = toolId;
    return snapshot(row.block);
  }

  /** Whether any child is neither terminal nor already unobserved. */
  function pending(): boolean {
    for (const row of rows.values())
      if (!row.terminal && row.block.status !== "unobserved") return true;
    return false;
  }

  function get(id: string): SubagentBlock | null {
    const row = rows.get(id);
    return row ? snapshot(row.block) : null;
  }

  function all(): SubagentBlock[] {
    return [...rows.values()].map((row) => snapshot(row.block));
  }

  return { apply, markUnobserved, replay, link, pending, get, all };
}

export type SubagentLedger = ReturnType<typeof createSubagentLedger>;
