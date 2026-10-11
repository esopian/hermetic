/**
 * Upstream payloads mapped onto `schema/chat.ts`'s blocks.
 *
 * One module because the live stream and the durable transcript both land here:
 * a tool card rendered from a `tool.complete` frame and one rendered from a
 * REST history row have to agree, and they only agree because they are the same
 * function.
 */
import type { ChatBlock, ChatUsage, ToolRender } from "../../schema/index.ts";
import { arr, isoOrNull, nonNegative, num, rec, scaleSeconds, str } from "./hermes-chat-wire.ts";

/**
 * Tool names whose result has a better rendering than a JSON dump, mapped to
 * the hint `schema/chat.ts` defines. A tool that is not in here still renders —
 * as name, arguments, result and verdict — which is the entire reason `render`
 * is a hint and not a type.
 */
const TOOL_RENDER: Record<string, ToolRender> = {
  bash: "terminal",
  shell: "terminal",
  run_command: "terminal",
  terminal: "terminal",
  edit: "diff",
  str_replace: "diff",
  apply_patch: "diff",
  write_file: "diff",
  read_file: "terminal",
  screenshot: "screenshot",
  computer: "screenshot",
  browser_screenshot: "screenshot",
  image: "image",
  sql: "table",
  query: "table",
  // Bot Mode's bot-to-bot DM (`tools/bot_mode_dm.py`).
  message_agent: "message_agent",
};

/** The spellings upstream has used for a tool's arguments, most specific first. */
const TOOL_ARG_KEYS = ["args", "arguments", "input", "params", "parameters"] as const;

/** The spellings upstream has used for a tool's result. */
const TOOL_RESULT_KEYS = ["result", "output", "content", "response"] as const;

/**
 * Every key `toolBlock` consumes. Anything else the payload carried is kept —
 * see the note there.
 */
const TOOL_CONSUMED_KEYS = new Set<string>([
  "name",
  "tool",
  // Read into `tool_id` rather than left over: it is the key a head supersedes
  // a running card by, not an argument the agent passed.
  "tool_id",
  "id",
  "call_id",
  ...TOOL_ARG_KEYS,
  ...TOOL_RESULT_KEYS,
  "status",
  "exit_code",
  "returncode",
  "duration_ms",
  "duration_s",
  "error",
]);

/** The first of `keys` the payload actually has, distinguishing absent from null. */
function pick(
  payload: Record<string, unknown>,
  keys: readonly string[],
): { has: boolean; value: unknown } {
  for (const key of keys) {
    if (payload[key] !== undefined) return { has: true, value: payload[key] };
  }
  return { has: false, value: null };
}

/**
 * A tool call, from either `tool.start` (no result yet) or `tool.complete`.
 *
 * A tool this repo has never heard of is **not** an `unknown` block: `ToolBlock`
 * is already generic — name, arguments, result, verdict — and `ToolRender` is
 * documented as a hint whose absence means "render the raw payload". So a new
 * upstream tool arrives as a fully-formed tool block with `render: null`, and a
 * `hermes_ref` bump that adds fifty tools blanks nothing. `unknown` is for an
 * *event* or a message part with no hermetic equivalent at all.
 *
 * **Nothing the payload carried is discarded.** That is the substance of the
 * choice above, not a nicety: keeping only the keys this build recognises gives
 * the same blank render the `unknown` contract exists to prevent, one field at a
 * time instead of all at once. `tool_id`, `context`, `args_text`,
 * `edit_snapshots` and whatever the next Hermes adds are merged in beside the
 * arguments, where a renderer drawing key/value rows shows them and a debugger
 * can find them. Real arguments win a name collision, because a tool argument
 * called `context` is the tool's, not the gateway's. A tool whose content sits
 * entirely under a key this build has never heard of therefore renders that key
 * rather than rendering `args: null`.
 *
 * Live start and completion frames retain tool_id so a head can replace the
 * running card by identity, including parallel calls to the same tool.
 */
export function toolBlock(payload: Record<string, unknown>, force: "running" | null): ChatBlock {
  const name = str(payload.name) ?? str(payload.tool) ?? "tool";
  const picked = pick(payload, TOOL_ARG_KEYS);
  const result = pick(payload, TOOL_RESULT_KEYS).value;
  const exit = num(payload.exit_code) ?? num(payload.returncode);

  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!TOOL_CONSUMED_KEYS.has(key)) extra[key] = value;
  }
  const hasExtra = Object.keys(extra).length > 0;

  let args: unknown;
  if (!picked.has) {
    args = hasExtra ? extra : null;
  } else if (!hasExtra) {
    args = picked.value;
  } else {
    const asObject = rec(picked.value);
    args = asObject ? { ...extra, ...asObject } : { ...extra, args: picked.value };
  }

  return {
    kind: "tool",
    tool_id: str(payload.tool_id) ?? str(payload.call_id) ?? str(payload.id),
    name,
    server: mcpServer(name),
    args,
    result,
    status: force ?? toolStatus(payload, exit),
    exit_code: exit,
    duration_ms: num(payload.duration_ms) ?? scaleSeconds(num(payload.duration_s)),
    render: TOOL_RENDER[name.toLowerCase()] ?? null,
  };
}

function toolStatus(
  payload: Record<string, unknown>,
  exit: number | null,
): "running" | "ok" | "warn" | "bad" {
  const raw = str(payload.status);
  if (raw === "running" || raw === "ok" || raw === "warn" || raw === "bad") return raw;
  if (payload.error !== undefined && payload.error !== null) return "bad";
  if (raw === "error" || raw === "failed") return "bad";
  if (exit !== null && exit !== 0) return "bad";
  return "ok";
}

/**
 * MCP tools are named `<server>__<tool>` or `mcp__<server>__<tool>` upstream.
 * A name with no separator came from Hermes itself and has no server.
 */
function mcpServer(name: string): string | null {
  const parts = name.split("__").filter((p) => p.length > 0);
  if (parts.length < 2) return null;
  const head = parts[0];
  if (head === "mcp") return parts[1] ?? null;
  return head ?? null;
}

export function approvalBlock(payload: Record<string, unknown>): ChatBlock {
  return {
    kind: "approval",
    tool: str(payload.tool) ?? str(payload.name) ?? "tool",
    summary: str(payload.summary) ?? str(payload.command) ?? str(payload.message) ?? "",
    detail: str(payload.detail) ?? str(payload.description),
    expires_at: isoOrNull(payload.expires_at),
  };
}

export function questionBlock(payload: Record<string, unknown>): ChatBlock {
  return {
    kind: "question",
    prompt: str(payload.prompt) ?? str(payload.question) ?? str(payload.message) ?? "",
    choices: arr(payload.choices ?? payload.options).flatMap((c) => {
      const s = typeof c === "string" ? c : (str(rec(c)?.label) ?? str(rec(c)?.value));
      return s ? [s] : [];
    }),
  };
}

/**
 * Upstream's usage object, which uses four different names for two numbers.
 *
 * Nothing in the recorded payload is a cost, and hermetic does not multiply
 * tokens by a price it guessed — `cost_usd` stays null unless the provider said
 * one, exactly as `ChatUsage` documents.
 */
export function mapUsage(usage: Record<string, unknown> | null): ChatUsage | null {
  if (!usage) return null;
  const input = num(usage.input) ?? num(usage.input_tokens) ?? num(usage.prompt);
  const output = num(usage.output) ?? num(usage.output_tokens) ?? num(usage.completion);
  return {
    input_tokens: nonNegative(input),
    output_tokens: nonNegative(output),
    cost_usd: num(usage.cost_usd) ?? num(usage.cost),
    model: str(usage.model),
  };
}
