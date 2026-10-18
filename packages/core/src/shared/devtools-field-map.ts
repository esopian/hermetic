/**
 * What the chat adapter does to each field of a Hermes event on its way to a
 * `ChatFrame` (§9.2 "Developer tools"): the table the stream inspector's Diff
 * view draws beside a wire record and the frame it became.
 *
 * Pure data, in `shared/` because the UI is its reader and may import nothing
 * else of core. It is a *description* of `hermes-chat-blocks.ts`'s mappers and
 * the turn loop (`hermes-chat-turn.ts`), not a second implementation of them,
 * and it is pinned against them by `packages/core/test/devtools-field-map.test.ts`,
 * which drives `mapUsage` and `toolBlock` on recorded payloads and fails when
 * the two disagree.
 *
 * Paths are dotted. `wire` is under the event's `payload`; `frame` is under the
 * frame (`usage.input_tokens` on a `done`, `block.args` on a tool block). `*`
 * stands for "every key not named elsewhere in this entry".
 */

/**
 * - `kept`: same name, same value.
 * - `renamed`: same value under another name (or folded into one).
 * - `dropped`: read and discarded, or never read.
 * - `synthesized`: made up by the adapter; `wire` is null.
 */
export type DevtoolsFieldFate = "kept" | "renamed" | "dropped" | "synthesized";

export interface DevtoolsFieldRule {
  wire: string | null;
  frame: string | null;
  fate: DevtoolsFieldFate;
  note?: string;
}

export interface DevtoolsEventMap {
  /** The Hermes event types this entry describes. */
  events: readonly string[];
  /** The frame they become: `delta`, `done`, `block.<kind>`. */
  frame: string;
  fields: readonly DevtoolsFieldRule[];
}

const USAGE_FIELDS: readonly DevtoolsFieldRule[] = [
  { wire: "usage.model", frame: "usage.model", fate: "kept" },
  { wire: "usage.input", frame: "usage.input_tokens", fate: "renamed" },
  {
    wire: "usage.input_tokens",
    frame: "usage.input_tokens",
    fate: "kept",
    note: "read when `input` is absent",
  },
  {
    wire: "usage.prompt",
    frame: null,
    fate: "dropped",
    note: "a fallback for `input`, read only when both input spellings are absent",
  },
  { wire: "usage.output", frame: "usage.output_tokens", fate: "renamed" },
  {
    wire: "usage.output_tokens",
    frame: "usage.output_tokens",
    fate: "kept",
    note: "read when `output` is absent",
  },
  {
    wire: "usage.completion",
    frame: null,
    fate: "dropped",
    note: "a fallback for `output`, read only when both output spellings are absent",
  },
  { wire: "usage.cost_usd", frame: "usage.cost_usd", fate: "kept" },
  {
    wire: "usage.cost",
    frame: "usage.cost_usd",
    fate: "renamed",
    note: "read when `cost_usd` is absent",
  },
  {
    wire: null,
    frame: "usage.cost_usd",
    fate: "synthesized",
    note: "null unless the provider said a cost",
  },
  {
    wire: "usage.context_used",
    frame: "usage.context_used",
    fate: "kept",
    note: "only with a positive `context_max`",
  },
  {
    wire: "usage.context_max",
    frame: "usage.context_max",
    fate: "kept",
    note: "only with `context_used`",
  },
  {
    wire: "usage.context_percent",
    frame: "usage.context_percent",
    fate: "kept",
    note: "rounded and clamped to 0–100; derived from used/max when absent",
  },
  {
    wire: "usage.context_estimated",
    frame: "usage.context_estimated",
    fate: "kept",
    note: "only when boolean",
  },
  { wire: "usage.reasoning", frame: null, fate: "dropped" },
  { wire: "usage.total", frame: null, fate: "dropped" },
  { wire: "usage.calls", frame: null, fate: "dropped" },
  { wire: "usage.compressions", frame: null, fate: "dropped" },
  { wire: "usage.cache_hit_pct", frame: null, fate: "dropped" },
  { wire: "usage.avg_latency_s", frame: null, fate: "dropped" },
  { wire: "usage.avg_tps", frame: null, fate: "dropped" },
  { wire: "usage.active_subagents", frame: null, fate: "dropped" },
];

const TOOL_FIELDS: readonly DevtoolsFieldRule[] = [
  { wire: "name", frame: "block.name", fate: "kept" },
  { wire: "tool", frame: "block.name", fate: "renamed", note: "read when `name` is absent" },
  { wire: "tool_id", frame: "block.tool_id", fate: "kept" },
  { wire: "call_id", frame: "block.tool_id", fate: "renamed", note: "read when `tool_id` is absent" },
  {
    wire: "id",
    frame: "block.tool_id",
    fate: "renamed",
    note: "read when `tool_id` and `call_id` are absent",
  },
  { wire: "args", frame: "block.args", fate: "kept" },
  { wire: "arguments", frame: "block.args", fate: "renamed" },
  { wire: "input", frame: "block.args", fate: "renamed" },
  { wire: "params", frame: "block.args", fate: "renamed" },
  { wire: "parameters", frame: "block.args", fate: "renamed" },
  { wire: "result", frame: "block.result", fate: "kept" },
  { wire: "output", frame: "block.result", fate: "renamed" },
  { wire: "content", frame: "block.result", fate: "renamed" },
  { wire: "response", frame: "block.result", fate: "renamed" },
  {
    wire: "status",
    frame: "block.status",
    fate: "kept",
    note: "running/ok/warn/bad as sent; anything else is derived",
  },
  {
    wire: "error",
    frame: "block.status",
    fate: "renamed",
    note: "any error makes the status `bad`; the text itself is not kept",
  },
  { wire: "exit_code", frame: "block.exit_code", fate: "kept" },
  { wire: "returncode", frame: "block.exit_code", fate: "renamed" },
  { wire: "duration_ms", frame: "block.duration_ms", fate: "kept" },
  { wire: "duration_s", frame: "block.duration_ms", fate: "renamed", note: "seconds × 1000" },
  {
    wire: "*",
    frame: "block.args.*",
    fate: "renamed",
    note: "every other key is merged beside the arguments; a real argument wins a collision",
  },
  {
    wire: null,
    frame: "block.server",
    fate: "synthesized",
    note: "the MCP server named in `<server>__<tool>`",
  },
  {
    wire: null,
    frame: "block.render",
    fate: "synthesized",
    note: "the card this build draws the tool with, or null",
  },
];

export const DEVTOOLS_FIELD_MAP: readonly DevtoolsEventMap[] = [
  {
    events: ["message.delta"],
    frame: "delta",
    fields: [
      {
        wire: "text",
        frame: "text",
        fate: "kept",
        note: "a `MEDIA:` line and the rest of its paragraph wait for the final",
      },
      {
        wire: null,
        frame: "message",
        fate: "synthesized",
        note: "the adapter's message id for the turn",
      },
    ],
  },
  {
    events: ["thinking.delta", "reasoning.delta"],
    frame: "block.reasoning",
    fields: [
      {
        wire: "text",
        frame: "block.text",
        fate: "renamed",
        note: "buffered and joined; flushed as one block when anything else arrives",
      },
    ],
  },
  {
    events: ["reasoning.available"],
    frame: "block.reasoning",
    fields: [
      { wire: "text", frame: null, fate: "dropped", note: "carries the answer, not the reasoning" },
      { wire: "tokens", frame: "block.tokens", fate: "renamed" },
      { wire: "duration_ms", frame: "block.duration_ms", fate: "kept" },
      { wire: "duration_s", frame: "block.duration_ms", fate: "renamed", note: "seconds × 1000" },
    ],
  },
  {
    events: ["message.complete"],
    frame: "done",
    fields: [
      {
        wire: "text",
        frame: "delta.text",
        fate: "renamed",
        note: "only the part that extends what was already streamed, as a last delta",
      },
      {
        wire: "status",
        frame: "incomplete",
        fate: "renamed",
        note: "true for anything but `complete`; `error` becomes an error frame",
      },
      {
        wire: "error",
        frame: "error.message",
        fate: "renamed",
        note: "the turn ends with an error frame instead of done",
      },
      { wire: "error_surface", frame: "error.failure.surface", fate: "renamed" },
      {
        wire: "response_transformed",
        frame: null,
        fate: "dropped",
        note: "settles the final text against what was shown",
      },
      ...USAGE_FIELDS,
      {
        wire: null,
        frame: "message",
        fate: "synthesized",
        note: "the adapter's message id for the turn",
      },
    ],
  },
  { events: ["tool.start", "tool.complete"], frame: "block.tool", fields: TOOL_FIELDS },
];

/** The entry for one Hermes event type, if the adapter maps it field by field. */
export function devtoolsFieldMap(event: string): DevtoolsEventMap | undefined {
  return DEVTOOLS_FIELD_MAP.find((entry) => entry.events.includes(event));
}
