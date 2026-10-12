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
