/**
 * The fixture's `ChatUsage`, shaped the way the gateway reports it.
 *
 * Its own module because both the catalog and the process-event transcript
 * build rows at load time, and the catalog imports the transcript.
 */

import type { ChatUsage } from "../../schema/index.ts";

/**
 * Each fixture model's context window. A model missing here gets no context
 * figures at all, which is what a gateway that reported none looks like.
 */
const CONTEXT_WINDOW: Readonly<Record<string, number>> = {
  "claude-sonnet-5": 200_000,
  "claude-haiku-4-5": 200_000,
};

/**
 * One turn's usage. `input` doubles as the window's occupancy: a one-call turn's
 * input is its last prompt, which is what upstream's `context_used` counts.
 */
export const usage = (input: number, output: number, cost: number, model: string): ChatUsage => {
  const max = CONTEXT_WINDOW[model];
  return {
    input_tokens: input,
    output_tokens: output,
    cost_usd: cost,
    model,
    ...(max === undefined
      ? {}
      : {
          context_used: input,
          context_max: max,
          context_percent: Math.min(100, Math.round((input / max) * 100)),
          context_estimated: false,
        }),
  };
};

/**
 * One turn's usage as a durable row keeps it: the tokens and the cost, but no
 * context window, because the box's stored rows carry none (§9.2). The real
 * shape; `usage` above is the richer one most fixture rows keep so the
 * composer's meter has something to draw without a live gateway.
 */
export const storedUsage = (input: number, output: number, cost: number, model: string): ChatUsage => ({
  input_tokens: input,
  output_tokens: output,
  cost_usd: cost,
  model,
});

/**
 * The usage the fixture gateway holds for a conversation still live on it,
 * keyed by durable session: what `liveUsage` answers, so `chat.history` with
 * `usage: true` reports it. `sx-atlas-portal`'s rows are stored-shaped
 * (`storedUsage`), so its meter comes from here alone — the reopened
 * conversation whose window is known before any turn is sent.
 */
export const FIXTURE_LIVE_USAGE: Readonly<Record<string, ChatUsage>> = {
  "sx-atlas-portal": usage(24_400, 96, 0.0044, "claude-sonnet-5"),
};
