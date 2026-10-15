/**
 * A refused `agents.set`, in the operator's words — shared by the agent
 * drawer's two editors (provider profile and model, memory provider).
 */
import { ApiError } from "../api/index.ts";

/**
 * Refusals whose message already says what to do, and which keep their code in
 * front so the operator can find the same failure in the CLI or `app.log`.
 */
const NAMED_REFUSALS = new Set([
  "MEMORY_PROVIDER_UNDERSIZED",
  "MEMORY_LLM_UNSUPPORTED",
  "HERMETICD_UNAVAILABLE",
]);

/**
 * `CONFLICT` gets its own sentence because it is the one failure that is not
 * about this laptop: the row moved between the render this form was composed
 * against and the write, so retrying the same body would only lose the same
 * race again. Reloading is the fix, and saying so is the difference between an
 * error and an instruction.
 */
export function saveErrorMessage(e: unknown): string {
  if (e instanceof ApiError && e.code === "CONFLICT") {
    return `CONFLICT · this agent was changed by another operator — reload before saving again (${e.message})`;
  }
  if (e instanceof ApiError && NAMED_REFUSALS.has(e.code)) return `${e.code} · ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}
