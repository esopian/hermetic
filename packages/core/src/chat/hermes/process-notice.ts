/**
 * Hermes' injected background-process notices, recognised and parsed into a
 * `process_event` block (`schema/chat.ts`).
 *
 * Hermes wakes a bot by appending a `user`-role row when a background process
 * finishes, a watch pattern matches, an async subagent returns or the MCP
 * servers reload. The operator typed none of them, so the history reader turns
 * each into a `system` message carrying one of these blocks instead of letting
 * the thread label it "You".
 *
 * Every shape here is copied from upstream's formatters, not inferred from
 * samples: `tools/process_registry.py` `format_process_notification` and
 * `_format_async_delegation`, the watch-disabled message in the same file, and
 * the MCP reload notice in `gateway/run.py` and `cli.py`. Recognition is
 * anchored at the start of the row — a user quoting a notice mid-message is
 * still the user speaking — and a field the text does not state is left null
 * rather than guessed.
 *
 * Pure: no I/O, no clock, so the same row always yields the same block.
 */
import { processEventSentence } from "../../shared/process-event.ts";
import type { ProcessEventBlock, ProcessOutcome } from "../../schema/index.ts";

type Delegation = NonNullable<ProcessEventBlock["delegation"]>;
type DelegationTask = Delegation["tasks"][number];

/** Every field null, so each branch below states only what its shape carries. */
function blank(
  raw: string,
  event: ProcessEventBlock["event"],
  outcome: ProcessOutcome,
): ProcessEventBlock {
  return {
    kind: "process_event",
    event,
    outcome,
    process_id: null,
    status: null,
    exit_code: null,
    signal: null,
    command: null,
    output_tail: null,
    output_lines: null,
    duration_s: null,
    message: null,
    watch: null,
    delegation: null,
    dm: null,
    raw,
  };
}

/**
 * `format_process_notification`'s completion branch. The status phrases are
 * upstream's full set; `terminated by` takes whatever source it names
 * (`Hermes` when none). The command is read lazily up to the first
 * `\nOutput:\n` so a multi-line shell command survives; the output runs to the
 * final `]`, and may itself contain brackets.
 */
const COMPLETION =
  /^\[IMPORTANT: Background process (\S+) (completed normally|exited|failed to start|marked lost because the process backend disappeared|terminated by .+?) \(exit code ([^,)\n]+)(, SIGTERM)?\)\.\nCommand: ([\s\S]*?)\nOutput:\n([\s\S]*)\]$/;

/** The watch-match branch: matched lines, then an optional rate-limit footnote. */
const WATCH_MATCH =
  /^\[IMPORTANT: Background process (\S+) matched watch pattern "([\s\S]*?)"\.\nCommand: ([\s\S]*?)\nMatched output:\n([\s\S]*?)(?:\n\((\d+) earlier matches were suppressed by rate limit\))?\]$/;

/** `process_registry.py`'s strike-limit message, wrapped by the `watch_disabled` branch. */
const WATCH_DISABLED = /^\[IMPORTANT: (Watch patterns disabled for process (\S+) [^\]\n]*)\]$/;

/** `gateway/run.py` and `cli.py` append the same text after `/reload-mcp`. */
const MCP_RELOAD = /^\[IMPORTANT: (MCP servers have been reloaded\.[^\]\n]*)\]$/;

/**
 * Any other one-line bracketed notice (`format_process_notification`'s generic
 * `[IMPORTANT: {message}]`). Kept as text, never dropped, never "You".
 *
 * One line with no inner bracket, because upstream also opens operator-driven
 * rows with `[IMPORTANT:` — a skill invocation carries the operator's request
 * after the hint, a cron job's first row carries its prompt — and those must
 * stay the user's.
 */
const OTHER_IMPORTANT = /^\[IMPORTANT:\s*([^[\]\n]*)\]$/;

/**
 * `[IMPORTANT: …` hints upstream prepends to a row the operator (or their cron
 * job) is behind (`agent/skill_commands.py`, `agent/skill_bundles.py`,
 * `cron/scheduler.py`, `gateway/run.py`). Never a background event, even on the
 * rare row where the hint is the whole text.
 */
const OPERATOR_HINTS = [
  "The user has invoked",
  "The user launched",
  "You are running as a scheduled cron job",
  "The following skill(s) were listed",
  'The "',
];

const DELEGATION_SINGLE = /^\[ASYNC DELEGATION COMPLETE — ([^\]\n]+)\]\n/;
const DELEGATION_BATCH = /^\[ASYNC DELEGATION BATCH COMPLETE — ([^\]\n]+)\]\n/;

/**
 * A bot-to-bot DM delivery (`tools/bot_mode_dm.py --run-delivery … hermes -p
 * <profile> chat …`). The `-p` read is the hermes invocation's, after the
 * script's own `--profile-home`, so a profile path cannot be mistaken for it.
 */
const DM_DELIVERY =
  /^(?:\S*python[0-9.]*\s+)?\S*bot_mode_dm\.py\s+--run-delivery\b[\s\S]*?\s-p\s+(?:'([^']+)'|"([^"]+)"|(\S+))\s+chat\b/;

/** A tool warning Hermes prints ahead of a reply (`⚠ tirith security scanner …`). */
const WARNING_LINE = /^\s*⚠/;

/** Upstream's status words for a subagent that finished its work. */
function delegationOk(status: string): boolean {
  return status === "completed" || status === "success";
}

/** A number the text states, or null for `?`, `None` and anything else upstream may print. */
function numberOrNull(text: string | undefined): number | null {
  if (text === undefined) return null;
  const trimmed = text.trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

function intOrNull(text: string | undefined): number | null {
  const value = numberOrNull(text);
  return value !== null && Number.isInteger(value) ? value : null;
}

function durationOrNull(text: string | undefined): number | null {
  const value = numberOrNull(text);
  return value !== null && value >= 0 ? value : null;
}

/** The output as the notice carried it, minus the one newline upstream's tail may end on. */
function tail(output: string): { output_tail: string; output_lines: number } {
  const body = output.endsWith("\n") ? output.slice(0, -1) : output;
  return { output_tail: body, output_lines: body === "" ? 0 : body.split("\n").length };
}

/** The DM fields, when `command` was a bot-to-bot delivery; the output is the other bot's reply. */
function dmOf(command: string, output: string): ProcessEventBlock["dm"] {
  const m = DM_DELIVERY.exec(command.trim());
  const profile = m ? (m[1] ?? m[2] ?? m[3]) : undefined;
  if (!profile) return null;
  const lines = output.split("\n");
  const warnings: string[] = [];
  let i = 0;
  // Leading blank lines are skipped with the warnings, so a blank between the
  // last warning and the reply does not survive as the reply's first line.
  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (WARNING_LINE.test(line)) warnings.push(line.trim());
    else if (line.trim() !== "") break;
  }
  return { to_profile: profile, reply: lines.slice(i).join("\n").trim(), warnings };
}

function completionOutcome(status: string, signal: string | undefined): ProcessOutcome {
  if (signal || status.startsWith("terminated by")) return "terminated";
  return status === "completed normally" ? "ok" : "failed";
}

function parseCompletion(raw: string, text: string): ProcessEventBlock | null {
  const m = COMPLETION.exec(text);
  if (!m) return null;
  const [, id, status = "", exit, signal, command = "", output = ""] = m;
  return {
    ...blank(raw, "completion", completionOutcome(status, signal)),
    process_id: id ?? null,
    status,
    exit_code: intOrNull(exit),
    signal: signal ? "SIGTERM" : null,
    command,
    ...tail(output),
    // A delivery that failed printed a traceback, not the other bot's reply,
    // so only a clean exit reads as a DM; anything else is the failure it is.
    dm: status === "completed normally" ? dmOf(command, output) : null,
  };
}

function parseWatchMatch(raw: string, text: string): ProcessEventBlock | null {
  const m = WATCH_MATCH.exec(text);
  if (!m) return null;
  const [, id, pattern = "", command = "", output = "", suppressed] = m;
  return {
    ...blank(raw, "watch_match", "info"),
    process_id: id ?? null,
    command,
    ...tail(output),
    watch: { pattern, suppressed: intOrNull(suppressed) ?? 0 },
  };
}

/**
 * The text between `from` and the first of `stops` after it (or the end),
 * for the labelled lines of a delegation notice. Lazy up to the next label, so
 * a goal or context the model wrote across several lines is kept whole.
 */
function labelled(text: string, label: string, stops: readonly string[]): string | null {
  const start = text.indexOf(`\n${label}: `);
  if (start === -1) return null;
  const from = start + label.length + 3;
  let end = text.length;
  for (const stop of stops) {
    const at = text.indexOf(`\n${stop}`, from);
    if (at !== -1 && at < end) end = at;
  }
  return text.slice(from, end);
}

const SINGLE_STATUS = /\nStatus: (.*?) {3}API calls: (.*?) {3}Duration: (.*?)s\n--- RESULT ---\n/;
const FAILED_LEAD =
  /^The subagent did not complete successfully \(status=[^)]*\)\.(?:\n([\s\S]*?))?(?:\nPartial output:\n[\s\S]*)?$/;
const INTERRUPTED_LEAD =
  /^The subagent was interrupted before completing(?:: ([\s\S]*?)|\.)(?:\nPartial output:\n[\s\S]*)?$/;

/**
 * `_format_async_delegation`'s single-task branch. The result body is kept
 * verbatim as the task's summary — success, partial output or the failure
 * sentence alike — and the error, when upstream appended one, is lifted out.
 */
function parseDelegationSingle(raw: string, text: string): ProcessEventBlock | null {
  const head = DELEGATION_SINGLE.exec(text);
  if (!head) return null;
  const s = SINGLE_STATUS.exec(text);
  if (!s) return null;
  const [, status = "", apiCalls, duration] = s;
  const body = text.slice(s.index + s[0].length);
  const ok = delegationOk(status);
  const goal = labelled(text.slice(0, s.index), "Original goal", [
    "Context you provided: ",
    "Toolsets: ",
    "Role: ",
  ]);
  let error: string | null = null;
  if (!ok) {
    const lead = status === "interrupted" ? INTERRUPTED_LEAD.exec(body) : FAILED_LEAD.exec(body);
    error = lead?.[1]?.trim() || null;
  }
  const duration_s = durationOrNull(duration);
  const api_calls = intOrNull(apiCalls);
  const task: DelegationTask = {
    index: 1,
    goal,
    status,
    ok,
    summary: body.trim() || null,
    duration_s,
    api_calls: api_calls !== null && api_calls >= 0 ? api_calls : null,
  };
  return {
    ...blank(raw, "delegation", ok ? "ok" : "failed"),
    duration_s,
    delegation: {
      id: head[1] ?? "",
      batch: false,
      status,
      total: 1,
      succeeded: ok ? 1 : 0,
      api_calls: task.api_calls,
      tasks: [task],
      error,
    },
  };
}

/**
 * One batch task header. The goal is lazy and may span lines, since upstream
 * prints whatever the model wrote; `api_calls` and the duration are only there
 * when upstream had them.
 */
const TASK_HEADER =
  /\n--- ([✓✗]) TASK (\d+)\/(\d+)(?:: ([\s\S]*?))? {2}\(status=([^,)\n]*)(?:, api_calls=(\d+))?(?:, ([^,)\n]*?)s)?\) ---(?=\n|$)/g;
const BATCH_ROLE = /\nRole: .*? {3}Model: .*? {3}Total duration: (.*?)s(?=\n|$)/;
const BATCH_ERROR = /\n--- ERROR ---\nThe batch did not complete successfully: ([\s\S]*)$/;
const BATCH_COUNT = /A background fan-out of (\d+) subagent\(s\)/;

/** `_format_async_delegation`'s batch branch: per-task headers and bodies, or the error. */
function parseDelegationBatch(raw: string, text: string): ProcessEventBlock | null {
  const head = DELEGATION_BATCH.exec(text);
  if (!head) return null;
  const role = BATCH_ROLE.exec(text);
  if (!role) return null;
  const rest = text.slice(role.index + role[0].length);
  const declared = intOrNull(BATCH_COUNT.exec(text)?.[1]);
  const failure = BATCH_ERROR.exec(rest);
  const tasks: DelegationTask[] = [];
  let totalFromHeaders: number | null = null;
  if (!failure) {
    const headers = [...rest.matchAll(TASK_HEADER)];
    for (const [i, h] of headers.entries()) {
      const bodyStart = (h.index ?? 0) + h[0].length + 1;
      const next = headers[i + 1];
      // Each task after the first is preceded by a blank line, so the body
      // before the next header ends on one newline that is not the summary's.
      let body = rest.slice(bodyStart, next ? next.index : rest.length);
      if (next && body.endsWith("\n")) body = body.slice(0, -1);
      const status = h[5] ?? "";
      const apiCalls = intOrNull(h[6]);
      totalFromHeaders = intOrNull(h[3]);
      tasks.push({
        index: intOrNull(h[2]) ?? i + 1,
        goal: h[4] ?? null,
        status,
        ok: h[1] === "✓",
        summary: body.trim() || null,
        duration_s: durationOrNull(h[7]),
        api_calls: apiCalls !== null && apiCalls >= 0 ? apiCalls : null,
      });
    }
  }
  const counted = tasks.filter((t) => t.api_calls != null);
  const succeeded = tasks.filter((t) => t.ok).length;
  const ok = !failure && tasks.every((t) => t.ok);
  const total = declared ?? totalFromHeaders ?? tasks.length;
  return {
    ...blank(raw, "delegation", ok ? "ok" : "failed"),
    duration_s: durationOrNull(role[1]),
    delegation: {
      id: head[1] ?? "",
      batch: true,
      status: null,
      total: total >= 0 ? total : tasks.length,
      succeeded,
      // A sum of what the headers state; upstream omits a zero, so no header
      // at all means unknown rather than zero.
      api_calls: counted.length > 0 ? counted.reduce((n, t) => n + (t.api_calls ?? 0), 0) : null,
      tasks,
      error: failure?.[1]?.trim() || null,
    },
  };
}

/**
 * The `process_event` block for one of Hermes' injected notices, or null when
 * `text` is anything else — including prose that merely quotes a notice.
 */
export function parseProcessNotice(text: string): ProcessEventBlock | null {
  const raw = text;
  const normalized = text.replace(/\r\n/g, "\n").replace(/\s+$/, "");
  if (normalized.startsWith("[ASYNC DELEGATION ")) {
    return parseDelegationBatch(raw, normalized) ?? parseDelegationSingle(raw, normalized);
  }
  if (!normalized.startsWith("[IMPORTANT:") || !normalized.endsWith("]")) return null;
  const parsed = parseCompletion(raw, normalized) ?? parseWatchMatch(raw, normalized);
  if (parsed) return parsed;
  const disabled = WATCH_DISABLED.exec(normalized);
  if (disabled) {
    return {
      ...blank(raw, "watch_disabled", "info"),
      process_id: disabled[2] ?? null,
      message: disabled[1] ?? null,
    };
  }
  const reload = MCP_RELOAD.exec(normalized);
  if (reload) return { ...blank(raw, "mcp_reload", "info"), message: reload[1] ?? null };
  const other = OTHER_IMPORTANT.exec(normalized);
  const message = other?.[1]?.trim() ?? "";
  if (!other || OPERATOR_HINTS.some((hint) => message.startsWith(hint))) return null;
  return { ...blank(raw, "other_important", "info"), message };
}

/* ── truncated previews ───────────────────────────────────────────────────── */

/**
 * What can follow `Background process <id> ` in a notice, with the outcome
 * each means. A preview can cut the phrase after a letter or two; the head is
 * read as whichever phrase the visible prefix is compatible with, and only
 * when exactly one is (`ma…` could be `matched` or `marked`).
 */
const HEAD_PHRASES: readonly (readonly [string, ProcessOutcome | "watch"])[] = [
  ["completed normally", "ok"],
  ["exited", "failed"],
  ["terminated by", "terminated"],
  ["failed to start", "failed"],
  ["marked lost because the process backend disappeared", "failed"],
  ["matched watch pattern", "watch"],
];

const PREVIEW_HEAD = /^\[IMPORTANT: Background process (\S+) ?(.*)$/;
const PREVIEW_EXIT = /\(exit code ([^,)\s]+)(, SIGTERM)?\)/;
const PREVIEW_COMMAND = / Command: (.*?) (?:Output|Matched output): /;
const PREVIEW_PATTERN = /^matched watch pattern "(.*?)"\./;
const PREVIEW_TERMINATED = /^(terminated by .+?) \(exit code/;

/** The sentence for a `Background process <id> <rest>` head, as far as it goes. */
function previewHead(raw: string, id: string, rest: string): string {
  const candidates = HEAD_PHRASES.filter(
    ([phrase]) => rest.startsWith(phrase) || (rest !== "" && phrase.startsWith(rest)),
  );
  const only = candidates.length === 1 ? candidates[0] : undefined;
  if (!only) return `background process ${id}`;
  const [phrase, outcome] = only;
  // The command only counts once its line visibly ended; a command cut
  // mid-token would put words in the row the box never ran.
  const command = PREVIEW_COMMAND.exec(rest)?.[1] ?? null;
  if (outcome === "watch") {
    return processEventSentence({
      ...blank(raw, "watch_match", "info"),
      process_id: id,
      command,
      watch: { pattern: PREVIEW_PATTERN.exec(rest)?.[1] ?? "?", suppressed: 0 },
    });
  }
  // A DM's reply is the part a preview cuts first, and its warning lines
  // cannot be told from the reply once newlines are flattened; the recipient
  // alone is still worth saying.
  const commandTail = / Command: (.*)$/.exec(rest)?.[1];
  const dm = outcome === "ok" && commandTail ? dmOf(commandTail, "") : null;
  if (dm) return `↩ ${dm.to_profile}: …`;
  const exit = PREVIEW_EXIT.exec(rest);
  const status = phrase === "terminated by" ? (PREVIEW_TERMINATED.exec(rest)?.[1] ?? null) : phrase;
  return processEventSentence({
    ...blank(raw, "completion", exit?.[2] ? "terminated" : outcome),
    process_id: id,
    status,
    exit_code: intOrNull(exit?.[1]),
    command,
  });
}

/**
 * A one-line sentence for a session or bot preview that opens with a notice,
 * or null when it does not.
 *
 * Upstream builds `preview` from the first user row's first 60 characters,
 * newlines flattened to spaces, with `...` appended (`hermes_state.py`
 * `list_sessions_rich`) — so a notice arrives cut off mid-status as often as
 * not and never parses whole. The full parse is tried first (a preview that
 * happens to carry the whole notice), then the head is read as far as it goes:
 * the process id, as much of the status as is visible, the exit code and
 * command when they made it in, the recipient of a DM when its `-p` did. What
 * was cut off stays unsaid.
 */
export function processNoticePreview(text: string): string | null {
  const whole = parseProcessNotice(text);
  if (whole) return processEventSentence(whole);
  const flat = text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(?:\.\.\.|…)$/, "");
  if (flat.startsWith("[ASYNC DELEGATION")) {
    return processEventSentence(blank(text, "delegation", "info"));
  }
  if (!flat.startsWith("[IMPORTANT:")) return null;
  const head = PREVIEW_HEAD.exec(flat);
  if (head) return previewHead(text, head[1] ?? "", head[2] ?? "");
  const inner = flat.replace(/^\[IMPORTANT:\s*/, "").replace(/\]$/, "");
  // A skill or cron hint opens a row the operator is behind; its preview is theirs.
  if (OPERATOR_HINTS.some((hint) => inner.startsWith(hint))) return null;
  const event = inner.startsWith("Watch patterns disabled")
    ? "watch_disabled"
    : inner.startsWith("MCP servers")
      ? "mcp_reload"
      : "other_important";
  return processEventSentence({ ...blank(text, event, "info"), message: inner });
}
