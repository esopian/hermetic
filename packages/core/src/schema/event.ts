import { z } from "zod";
import { Iso } from "./common.ts";
import { AgentStatus } from "./agent.ts";

/** A row in the `events` table (§4.2). Events are append-only and never deleted. */
export const AgentEvent = z.object({
  name: z.string(),
  timestamp: Iso,
  actor: z.string(),
  action: z.string(),
  from_status: AgentStatus.nullish(),
  to_status: AgentStatus.nullish(),
  detail: z.string().nullish(),
  /**
   * The tail of a failed stage's log, and nothing else — absent on every other
   * event.
   *
   * `detail` is the headline: one line, the last thing the stage said on
   * stderr, bounded so a row stays small. That is enough to know *which* step
   * broke and almost never enough to know *why*, and the answer to why lived
   * only in `/var/log/hermetic/stages/<id>.log` on the box — a file the laptop
   * cannot reach when the failure happened before hermeticd's RPC came up,
   * which is exactly when a boot fails. So the evidence travels with the
   * headline: the last lines of that attempt, captured as the runner already
   * captures them for the log file, redacted line by line at capture like
   * everything else hermeticd records (§8.3). The full log still stays on the
   * box; this is the part an operator reads first.
   */
  log_tail: z.string().nullish(),
});
export type AgentEvent = z.infer<typeof AgentEvent>;
