/**
 * The rest of the rows Hermes stores as the user's but the operator never
 * typed: scheduled and recurring wakeups, recovery notes, the agent loop's
 * continuation prompts, compaction summaries and the task list carried across
 * them, model and personality switches, and cron or webhook deliveries
 * mirrored into a session. `process-notice.ts` turns each reading into a
 * `process_event` block; this module only reads the text.
 *
 * Two operator rows live here too because they share the problem: a skill
 * invocation stores the whole skill body as the user's text, and a messaging
 * reply carries a `[Replying to: "…"]` prefix. Both stay the operator's
 * message; only the scaffolding is lifted off.
 *
 * Classification is by `display_kind` first and by text second. Every text
 * shape is copied from the upstream formatter cited beside it and anchored at
 * the start of the row, so a person quoting one mid-message is still the
 * person speaking, and anything that matches nothing stays the user's.
 *
 * Pure: no I/O, no clock.
 */
import type { ProcessEventBlock, ProcessNoticeVariant, ProcessTaskStatus } from "../../schema/index.ts";

type Notice = NonNullable<ProcessEventBlock["notice"]>;
type Task = NonNullable<Notice["tasks"]>[number];

/** What a row's text says, before `process-notice.ts` fills in the block's other fields. */
export interface InjectedReading {
  event: ProcessEventBlock["event"];
  outcome: ProcessEventBlock["outcome"];
  notice: Notice;
  /** A cron job's name or a webhook route. */
  message?: string | null;
  /** A mirrored delivery's payload, kept as the block's output. */
  output?: string;
  /** The operator's own text that followed the notice in the same row. */
  rest?: string | null;
}

function notice(fields: Partial<Notice> = {}): Notice {
  return { variant: null, subject: null, detail: null, body: null, tasks: null, ...fields };
}

function reading(
  event: InjectedReading["event"],
  outcome: InjectedReading["outcome"],
  fields: Partial<Notice> = {},
): InjectedReading {
  return { event, outcome, notice: notice(fields) };
}

/** The first non-empty line, trimmed. */
function firstLine(text: string): string | null {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? null
  );
}

/* ── mirrored deliveries ──────────────────────────────────────────────────── */

/** `cron/scheduler_delivery.py:203-204` `_cron_mirror_message`. */
const CRON_MIRROR = /^\[Cron delivery: ([^\n]*)\](?:\n([\s\S]*))?$/;
/** `gateway/platforms/webhook.py:913`, the route's `mirror_to_session` text. */
const WEBHOOK_MIRROR = /^\[Webhook delivery: ([^\n]*)\](?:\n([\s\S]*))?$/;

function parseMirror(text: string): InjectedReading | null {
  const cron = CRON_MIRROR.exec(text);
  const hook = cron ? null : WEBHOOK_MIRROR.exec(text);
  const m = cron ?? hook;
  if (!m) return null;
  return {
    ...reading(cron ? "cron" : "webhook", "info", { variant: "mirrored" }),
    message: m[1] || null,
    output: m[2] ?? "",
  };
}

/* ── recurring wakeups ────────────────────────────────────────────────────── */

/** `hermes_cli/heartbeat.py:22-26` `HEARTBEAT_PROMPT_TEMPLATE`. */
const HEARTBEAT =
  /^\[Heartbeat — recurring instruction, fires every ([^\]\n]+)\]\n([\s\S]*?)\n\nIf there is nothing meaningful to do or report for this instruction right now, reply briefly that nothing has changed and stop — do not invent work\.$/;

/**
 * `hermes_cli/loops.py:44-66` `WAKEUP_PROMPT_TEMPLATE` and its `until` twin;
 * the cadence is `, every 5m` or `, self-paced` (`loops.py:525`).
 */
const LOOP =
  /^\[\/loop wakeup (#\d+[^\]\n]*)\]\nRecurring task: ([\s\S]*?)\n\n(?:Stop condition: [\s\S]*?\n\n)?This is an automatic wakeup from the \/loop the user set\. /;

/**
 * `hermes_cli/goals.py:61-111`: every continuation template, and the failed-gate
 * one. The body must open with one of the templates' fixed sentences (plain,
 * contract, subgoals, gate), so a header and a `Goal:` line alone are not one.
 */
const GOAL =
  /^\[Continuing toward your standing goal( — a quality gate failed)?\]\nGoal: ([\s\S]*?)\n\n((?:Continue working toward this goal\. |Completion contract:\n|Additional criteria the user added mid-loop:\n|The quality gate command below must pass before this goal can be )[\s\S]*)$/;

/** `gateway/run_startup.py:1776-1781`, the synthetic turn a `/handoff` dispatches. */
const HANDOFF =
  /^\[Session was just handed off from (\S+) \("([\s\S]*?)"\) to this channel\. The full prior conversation history is loaded above\. Briefly confirm you're working here and summarize what we were working on, so the user can continue from this device\.\]$/;

function parseWakeup(text: string): InjectedReading | null {
  const beat = HEARTBEAT.exec(text);
  if (beat) return reading("heartbeat", "info", { detail: beat[1] ?? null, subject: beat[2] || null });
  const loop = LOOP.exec(text);
  if (loop) {
    // `#4, every 5m` reads `#4 · every 5m`, the way every head prints it.
    const detail = (loop[1] ?? "").replace(/^(#\d+), /, "$1 · ");
    return reading("loop", "info", { detail, subject: loop[2] || null });
  }
  const goal = GOAL.exec(text);
  if (goal) {
    const failed = goal[1] !== undefined;
    return reading("goal", failed ? "failed" : "info", {
      variant: failed ? "gate_failed" : "continuing",
      subject: goal[2] || null,
      body: goal[3] || null,
    });
  }
  const handoff = HANDOFF.exec(text);
  if (handoff)
    return reading("handoff", "info", { detail: handoff[1] ?? null, subject: handoff[2] ?? null });
  return null;
}

/* ── recovery notes ───────────────────────────────────────────────────────── */

/** `tui_gateway/session_auto_continue.py:49-54` `_auto_continue_note`, typed `auto_continue`. */
const RESUME_CRASH =
  /^\[System note: Your previous turn was interrupted mid-run — the app or its backend process stopped before the turn could finish\. Some of the work may already be complete; check the current state before redoing anything, then finish the task\. The interrupted request was:\](?:\n\n([\s\S]*))?$/;

/**
 * `gateway/run.py:1034-1076` `build_resume_recovery_note`. The guidance in the
 * middle is one of three fixed sentences, none with a `]`; a user's new
 * message may follow the note after a blank line.
 */
const RESUME_GATEWAY =
  /^\[System note: The previous turn was interrupted by a (gateway restart|gateway shutdown|gateway interruption); the gateway is now back online\. Any restart\/shutdown command in the history has already run — do NOT re-execute or verify it\. [^\]]*\](?:\n\n([\s\S]*))?$/;

function parseResume(text: string): InjectedReading | null {
  const crash = RESUME_CRASH.exec(text);
  if (crash) return reading("resume", "warn", { variant: "crash", subject: crash[1] || null });
  const gw = RESUME_GATEWAY.exec(text);
  if (!gw) return null;
  return {
    ...reading("resume", "warn", { variant: "gateway", detail: gw[1] ?? null }),
    rest: gw[2] || null,
  };
}

/* ── the agent loop's own prompts ─────────────────────────────────────────── */

/** `agent/conversation_loop.py:844-885`: the fixed `[System: …]` continuation prompts, verbatim. */
const NUDGES: ReadonlyMap<string, ProcessNoticeVariant> = new Map([
  [
    "[System: Your previous response was truncated by the output length limit. Continue exactly where you left off. Do not restart or repeat prior text. Finish the answer directly.]",
    "output_limit",
  ],
  [
    "[System: The previous response was cut off by a network error mid-stream. Continue exactly where you left off. Do not restart or repeat prior text. Finish the answer directly.]",
    "network_cut",
  ],
  [
    "[System: Your previous response contained only internal reasoning and never produced a visible answer or tool call. Do not keep thinking. Produce your final answer as plain text now (or make the tool call you were planning).]",
    "reasoning_only",
  ],
  [
    "[System: Continue now. Execute the required tool calls and only send your final answer after completing the task.]",
    "continue_now",
  ],
  [
    "[System: Your previous message ended the turn with a fragment that is not a usable answer. If the task is unfinished, continue it and then give the complete answer. If that fragment WAS your complete answer, send it again exactly as before.]",
    "fragment",
  ],
]);

/**
 * `conversation_loop.py:893-903`: the two re-prompts that carry no `[System:`
 * bracket — a turn that announced a tool call and sent none, and an empty
 * reply after tool results. Whole-text matches, verbatim.
 */
const BARE_NUDGES: ReadonlyMap<string, ProcessNoticeVariant> = new Map([
  [
    "Your previous turn indicated a tool call but none was included. Do not narrate a plan or restate intent — issue the actual tool call now to continue the task.",
    "dropped_tool_call",
  ],
  [
    "You just executed tool calls but returned an empty response. Please process the tool results above and continue with the task.",
    "empty_tool_response",
  ],
]);

/** `conversation_loop.py:857-865`: the dropped-tools prompt, which names up to three tools. */
const TOOL_TOO_LARGE =
  /^\[System: Your previous tool call \(([^)\n]*)\) was too large and the stream timed out before it could be delivered\.[^\]]*\]$/;

/** `agent/context_compressor.py:335-338` `MAX_ITERATIONS_SUMMARY_REQUEST`. */
const ITERATION_LIMIT =
  "You've reached the maximum number of tool-calling iterations allowed. Please provide a final response summarizing what you've found and accomplished so far, without calling any more tools.";

/**
 * `context_compressor.py:326-333`: the filler user row compaction adds when no
 * real user turn survived, current and legacy spelling. It carries nothing a
 * person needs; the history reader drops it.
 */
const CONTINUE_MARKERS: ReadonlySet<string> = new Set([
  "Continue from the compressed conversation context above. This marker exists because no human user turn was available.",
  "Continue from the compressed conversation context above. This marker exists because the compacted transcript contained no preserved user turn.",
]);

export function isCompactionContinueMarker(text: string): boolean {
  return CONTINUE_MARKERS.has(text.trim());
}

function parseLoopPrompt(text: string): InjectedReading | null {
  const nudge = NUDGES.get(text) ?? BARE_NUDGES.get(text);
  if (nudge) return reading("nudge", "info", { variant: nudge });
  const large = TOOL_TOO_LARGE.exec(text);
  if (large) return reading("nudge", "warn", { variant: "tool_too_large", subject: large[1] || null });
  if (text === ITERATION_LIMIT) return reading("iteration_limit", "warn");
  return null;
}

/* ── compaction ───────────────────────────────────────────────────────────── */

/**
 * The start every current and historical `SUMMARY_PREFIX` shares
 * (`context_compressor.py:251-290`, `_HISTORICAL_SUMMARY_PREFIXES` :581-650).
 * Each is one line ending `avoid repeating it:`, and the summary follows on
 * the next line (`_with_summary_prefix`).
 */
const SUMMARY_HEAD =
  "[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below.";
const SUMMARY_PREFIX_END = "avoid repeating it:";
/** `context_compressor.py:292`. */
const LEGACY_SUMMARY_PREFIX = "[CONTEXT SUMMARY]:";
/** `context_compressor.py:479`. */
const SUMMARY_END =
  "--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---";
/** `context_compressor.py:483-484`: prior tail content kept ahead of a merged summary. */
const MERGED_HEADER = "[PRIOR CONTEXT — for reference only; not a new message]";
const MERGED_DELIMITER = "[END OF PRIOR CONTEXT — COMPACTION SUMMARY BELOW]";

/**
 * A compaction summary row read the way upstream's `_strip_summary_prefix`
 * and `_strip_context_summary_handoff_message` (`context_compressor.py:4095`,
 * :4339) read it: the summary body without the preamble or the end marker, and
 * the real content the carrier also held (the prior tail ahead of a merged
 * summary, or a live ask after the end marker) as `rest`.
 */
export function parseCompaction(row: string): InjectedReading | null {
  // Upstream's `classify_summary_content` (:4128) reads the text left-stripped.
  const text = row.trimStart();
  let summary = text;
  let rest = "";
  if (text.startsWith(MERGED_HEADER)) {
    const at = text.indexOf(MERGED_DELIMITER);
    if (at === -1) return null;
    rest = text.slice(MERGED_HEADER.length, at).trim();
    summary = text.slice(at + MERGED_DELIMITER.length).trimStart();
  }
  let body: string;
  if (summary.startsWith(SUMMARY_HEAD)) {
    const head = summary.split("\n", 1)[0] ?? "";
    const cut = head.indexOf(SUMMARY_PREFIX_END);
    body = cut === -1 ? summary.slice(head.length) : summary.slice(cut + SUMMARY_PREFIX_END.length);
  } else if (summary.startsWith(LEGACY_SUMMARY_PREFIX)) {
    body = summary.slice(LEGACY_SUMMARY_PREFIX.length);
  } else {
    return null;
  }
  const end = body.indexOf(SUMMARY_END);
  if (end !== -1) {
    if (!rest) rest = body.slice(end + SUMMARY_END.length).trim();
    body = body.slice(0, end);
  }
  return { ...reading("compaction", "info", { body: body.trim() || null }), rest: rest || null };
}

/** `tools/todo_tool.py:21`, the header `format_for_injection` (:97-125) writes. */
const TODO_HEADER = "[Your active task list was preserved across context compression]\n";
/** One item's line: `{'  ' * depth}- {marker} ` (`todo_tool.py:118-119`). */
const TODO_ITEM = /^((?: {2})*)- \[([x> ~?])\] /;
/** The rest of an item: `{id}. {content} ({status})`. An indented line continues it. */
const TODO_BODY = /^(\S+?)\. ([\s\S]*) \([a-z_]+\)$/;
/** `todo_tool.py:22` `_STATUS_MARKERS`; `[?]` is upstream's marker for any other status. */
const TODO_STATUS: Readonly<Record<string, ProcessTaskStatus>> = {
  x: "done",
  ">": "active",
  " ": "pending",
  "~": "cancelled",
  "?": "unknown",
};

/** `conversation_compression.py:2373`: the reload notice `_fold_todo_snapshot` may add after the list. */
const SKILLS_PRUNED = "\n\n[Skills pruned during compression — reload before acting on these tasks]";

/**
 * Upstream only strips an item's content, so a multi-line item continues at
 * column 0: every line that is not an item belongs to the item above it. The
 * list ends only at the skills-pruned reload notice
 * (`conversation_compression.py:3104-3106`), which is the notice's `body`.
 */
function parseTodo(text: string): InjectedReading | null {
  if (!text.startsWith(TODO_HEADER)) return null;
  const list = text.slice(TODO_HEADER.length);
  const pruned = list.indexOf(SKILLS_PRUNED);
  const lines = (pruned === -1 ? list : list.slice(0, pruned)).split("\n");
  const items: { depth: number; status: ProcessTaskStatus; body: string }[] = [];
  for (const line of lines) {
    const m = TODO_ITEM.exec(line);
    const last = items.at(-1);
    if (m) {
      items.push({
        depth: (m[1] ?? "").length / 2,
        status: TODO_STATUS[m[2] ?? "?"] ?? "unknown",
        body: line.slice(m[0].length),
      });
    } else if (last) {
      last.body += `\n${line}`;
    } else {
      return null;
    }
  }
  const tasks: Task[] = items.map(({ depth, status, body }) => {
    const m = TODO_BODY.exec(body);
    return { status, depth, id: m ? (m[1] ?? null) : null, text: m ? (m[2] ?? "") : body };
  });
  const body = pruned === -1 ? null : list.slice(pruned).trim();
  return reading("todo", "info", { tasks, body });
}

/**
 * A task list `_fold_todo_snapshot` (`agent/conversation_compression.py:3118-3123`)
 * appended to the end of a real user row after a blank line: the operator's
 * text before it, and the list's reading. Null when the row carries none. The
 * first header that opens a list that parses is the one; an earlier header
 * the operator merely typed stays their text.
 */
export function parseTrailingTodo(text: string): { text: string; read: InjectedReading } | null {
  for (
    let at = text.indexOf(`\n\n${TODO_HEADER}`);
    at > 0;
    at = text.indexOf(`\n\n${TODO_HEADER}`, at + 2)
  ) {
    const read = parseTodo(text.slice(at + 2));
    const before = text.slice(0, at).trimEnd();
    if (read && before) return { text: before, read };
  }
  return null;
}

/* ── runtime switches ─────────────────────────────────────────────────────── */

/** `tui_gateway/server.py:1683`, `_append_model_switch_marker` (:1700-1708). */
const MODEL_SWITCH =
  /^\[System: The active model for this chat has changed to ([\s\S]+?)(?: via provider ([\s\S]+?))?\. From this point forward, use this runtime metadata when answering questions about what model\/provider is active\.\]$/;

/** `tui_gateway/agent_callbacks.py:271-276` `_apply_personality_to_session`. */
const PERSONA_SET =
  /^\[System: The user has changed the assistant's personality\. From this point forward, adopt the following persona and respond accordingly: ([\s\S]*)\]$/;
const PERSONA_CLEARED =
  "[System: The user has cleared the personality overlay. From this point forward, respond in your normal default style.]";

function parseModel(text: string): InjectedReading | null {
  const m = MODEL_SWITCH.exec(text);
  return m ? reading("model_switch", "info", { subject: m[1] ?? null, detail: m[2] ?? null }) : null;
}

function parsePersona(text: string): InjectedReading | null {
  if (text === PERSONA_CLEARED) return reading("personality", "info", { variant: "cleared" });
  const m = PERSONA_SET.exec(text);
  if (!m) return null;
  const persona = (m[1] ?? "").trim();
  return reading("personality", "info", {
    variant: "set",
    subject: firstLine(persona),
    body: persona || null,
  });
}

/* ── dispatch ─────────────────────────────────────────────────────────────── */

/**
 * The `display_kind`s that name one of these events outright. The row is that
 * event whatever its text, so a wording change upstream still never reads as
 * the operator; the text only fills in the fields.
 */
const BY_KIND: Readonly<
  Record<string, readonly [(text: string) => InjectedReading | null, () => InjectedReading]>
> = {
  model_switch: [parseModel, () => reading("model_switch", "info")],
  personality_switch: [parsePersona, () => reading("personality", "info")],
  auto_continue: [parseResume, () => reading("resume", "warn", { variant: "crash" })],
};

/** `display_kind`s upstream puts on rows that are the operator's or Hermes' own, never one of these. */
const NOT_INJECTED: ReadonlySet<string> = new Set(["skill_invocation", "steer", "failed_turn"]);

const PARSERS: readonly ((text: string) => InjectedReading | null)[] = [
  parseMirror,
  parseWakeup,
  parseResume,
  parseLoopPrompt,
  parseCompaction,
  parseTodo,
  parseModel,
  parsePersona,
];

/** The reading for `text` (already CRLF-normalised and right-trimmed), or null when it is none of these. */
export function readInjectedNotice(text: string, displayKind: string | null): InjectedReading | null {
  if (displayKind !== null && NOT_INJECTED.has(displayKind)) return null;
  const byKind = displayKind === null ? undefined : BY_KIND[displayKind];
  if (byKind) return byKind[0](text) ?? byKind[1]();
  for (const parse of PARSERS) {
    const read = parse(text);
    if (read) return read;
  }
  return null;
}

/* ── truncated previews ───────────────────────────────────────────────────── */

const flatten = (text: string) => text.replace(/\s+/g, " ").trim();

/** Fixed texts a preview may cut anywhere, flattened the way the preview is. */
const FIXED_PREVIEWS: readonly (readonly [string, () => InjectedReading])[] = [
  ...[...NUDGES, ...BARE_NUDGES].map(
    ([text, variant]) => [flatten(text), () => reading("nudge", "info", { variant })] as const,
  ),
  [flatten(ITERATION_LIMIT), () => reading("iteration_limit", "warn")],
  [flatten(PERSONA_CLEARED), () => reading("personality", "info", { variant: "cleared" })],
  ...[...CONTINUE_MARKERS].map((text) => [flatten(text), () => reading("compaction", "info")] as const),
];

/** Heads that settle what a preview is as soon as they are visible. */
const PREVIEW_HEADS: readonly (readonly [string, (flat: string) => InjectedReading])[] = [
  ["[Cron delivery: ", (f) => mirrorPreview(f, "cron", "[Cron delivery: ")],
  ["[Webhook delivery: ", (f) => mirrorPreview(f, "webhook", "[Webhook delivery: ")],
  [
    "[Heartbeat — recurring",
    (f) => reading("heartbeat", "info", { detail: /fires every ([^\]\s]+)\]/.exec(f)?.[1] ?? null }),
  ],
  [
    "[/loop wakeup #",
    (f) => reading("loop", "info", { detail: /^\[\/loop wakeup (#\d+)\b/.exec(f)?.[1] ?? null }),
  ],
  [
    "[Continuing toward your standing goal — a",
    () => reading("goal", "failed", { variant: "gate_failed" }),
  ],
  ["[Continuing toward your standing goal]", () => reading("goal", "info", { variant: "continuing" })],
  [
    "[Session was just handed off from ",
    (f) =>
      reading("handoff", "info", {
        detail: /^\[Session was just handed off from (\S+) \(/.exec(f)?.[1] ?? null,
      }),
  ],
  [
    "[System note: Your previous turn was interrupted mid-run",
    () => reading("resume", "warn", { variant: "crash" }),
  ],
  [
    "[System note: The previous turn was interrupted by a gateway",
    (f) =>
      reading("resume", "warn", {
        variant: "gateway",
        detail:
          /^\[System note: The previous turn was interrupted by a (gateway \w+);/.exec(f)?.[1] ?? null,
      }),
  ],
  ["[System: Your previous tool call (", () => reading("nudge", "warn", { variant: "tool_too_large" })],
  ["[CONTEXT COMPACTION — REFERENCE ONLY]", () => reading("compaction", "info")],
  [LEGACY_SUMMARY_PREFIX, () => reading("compaction", "info")],
  ["[PRIOR CONTEXT — for reference only", () => reading("compaction", "info")],
  [
    "[System: The active model for this chat has changed to ",
    (f) =>
      reading("model_switch", "info", {
        // Only a name whose end made it in: a name cut mid-token is not the model.
        subject: /changed to (\S+?)(?: via provider |\. From )/.exec(f)?.[1] ?? null,
      }),
  ],
  [
    "[System: The user has changed the assistant's personality.",
    () => reading("personality", "info", { variant: "set" }),
  ],
];

function mirrorPreview(flat: string, event: "cron" | "webhook", head: string): InjectedReading {
  const close = flat.indexOf("]", head.length);
  return {
    ...reading(event, "info", { variant: "mirrored" }),
    message: close === -1 ? null : flat.slice(head.length, close) || null,
  };
}

/**
 * The reading for a session preview — upstream's first 60 characters,
 * newlines flattened, `...` already removed; `cut` when the preview reached
 * the cut — or null. A head counts once the
 * part that tells the shapes apart is visible; a fixed text counts when every
 * fixed text the visible part is a prefix of reads the same.
 */
export function previewInjectedNotice(flat: string, cut: boolean): InjectedReading | null {
  for (const [head, read] of PREVIEW_HEADS) if (flat.startsWith(head)) return read(flat);
  // The todo header (65 characters) shows whole, or as upstream's cut of it.
  const todoHead = TODO_HEADER.trimEnd();
  if (flat.startsWith(todoHead) || (cut && todoHead.startsWith(flat))) return reading("todo", "info");
  // A short message that happens to be a prefix of a fixed text is the
  // operator's: only upstream's cut form, or the whole text, is the notice.
  const fits = FIXED_PREVIEWS.filter(([text]) => text === flat || (cut && text.startsWith(flat))).map(
    ([, read]) => read(),
  );
  // Both continue-marker spellings share their first 60 characters and read the same.
  const kinds = new Set(fits.map((r) => `${r.event}:${r.notice.variant}`));
  return kinds.size === 1 ? (fits[0] ?? null) : null;
}

/* ── operator rows ────────────────────────────────────────────────────────── */

/**
 * The markers `agent/skill_commands.py:36-42` writes, mirrored by upstream
 * Desktop's `apps/shared/src/skill-scaffold.ts`; the parse below is a port of
 * its `skillInvocationText`.
 */
const SKILL_PREFIX = "[IMPORTANT: The user has invoked the ";
const SKILL_SINGLE_MARKER = "The full skill content is loaded below.]";
const SKILL_SINGLE_INSTRUCTION =
  "The user has provided the following instruction alongside the skill invocation: ";
const SKILL_RUNTIME_NOTE = "\n\n[Runtime note:";
const SKILL_BUNDLE_MARKER = " skill bundle,";
const SKILL_BUNDLE_INSTRUCTION = "\nUser instruction: ";
const SKILL_BUNDLE_BLOCK = "\n\n[Loaded as part of the ";
const SKILL_NAME = /^\[IMPORTANT: The user has invoked the "([^"]*)"/;
/** `_scaffold_header` (`skill_commands.py:310-333`): the skills a bundle actually loaded. */
const SKILLS_LOADED = /\nSkills loaded: ([^\n]+)/;

function between(text: string, marker: string, end: string, fromEnd = false): string {
  const index = fromEnd ? text.lastIndexOf(marker) : text.indexOf(marker);
  if (index < 0) return "";
  const tail = text.slice(index + marker.length);
  const stop = tail.indexOf(end);
  return (stop >= 0 ? tail.slice(0, stop) : tail).trim();
}

export interface SkillInvocation {
  names: string[];
  instruction: string | null;
}

/**
 * The skills a scaffolded row invoked and the instruction typed beside them,
 * or null when `text` is not one. A single skill names itself; a bundle header
 * quotes its key (`"/a /b" stacked skill bundle`, `"<name>" skill bundle`) and
 * lists what it loaded, one name per skill.
 */
export function parseSkillInvocation(text: string): SkillInvocation | null {
  if (!text.startsWith(SKILL_PREFIX)) return null;
  const name = (SKILL_NAME.exec(text)?.[1] ?? "").trim();
  if (!name) return null;
  const bundle = text.includes(SKILL_BUNDLE_MARKER);
  const instruction = bundle
    ? between(text, SKILL_BUNDLE_INSTRUCTION, SKILL_BUNDLE_BLOCK)
    : text.includes(SKILL_SINGLE_MARKER)
      ? between(text, SKILL_SINGLE_INSTRUCTION, SKILL_RUNTIME_NOTE, true)
      : "";
  const loaded = bundle ? SKILLS_LOADED.exec(text)?.[1] : undefined;
  const names = (loaded ? loaded.split(",") : bundle ? name.split(/\s+/) : [name])
    .map((n) => n.trim().replace(/^\//, ""))
    .filter(Boolean);
  if (names.length === 0) return null;
  return { names, instruction: instruction || null };
}

/** `gateway/run_inbound.py:1590` `_prepend_inbound_reply_context`. */
const REPLY_TO = /^\[Replying to(?: your previous message)?: "([\s\S]*?)"\]\n\n([\s\S]*)$/;

/** The quoted message and the operator's own text, or null when `text` carries no reply pointer. */
export function parseReplyContext(text: string): { quote: string; text: string } | null {
  const m = REPLY_TO.exec(text);
  return m ? { quote: m[1] ?? "", text: m[2] ?? "" } : null;
}

/** `agent/turn_failure_copy.py:39-45`: the boundary row that closes a failed turn. */
const FAILED_TURN_NOTICES: ReadonlySet<string> = new Set([
  "Your request was not processed. Send it again if you still want me to carry it out.",
  "This turn did not complete. Some actions may already have run; verify their effects before resending.",
]);

/**
 * True for Hermes' failed-turn boundary row: typed `failed_turn`, or — as
 * upstream's own `untyped_failed_turn_display_kind` (:51-58) reads an older row —
 * an assistant row whose whole text is one of the notices.
 */
export function isFailedTurn(displayKind: string | null, text: string | null): boolean {
  if (displayKind === "failed_turn") return true;
  return displayKind === null && text !== null && FAILED_TURN_NOTICES.has(text.trim());
}
