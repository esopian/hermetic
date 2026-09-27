/**
 * The one constructor for an `OpEvent` (§3.2 rule 2).
 *
 * Every long operation yields `{ phase, progress, message, at }` and, when it
 * has something to say about them, a `level` and a `kind`. Those last two are
 * *optional properties*, not nullable ones, so under `exactOptionalPropertyTypes`
 * they have to be spread in rather than assigned — which is exactly the fiddly
 * bit that had been hand-copied into `hermetic.ts`, `attach.ts` and
 * `handoff.ts`, three identical functions that any change to `OpEvent` would
 * have had to find in three places.
 *
 * The SDK closure passes this through the deps objects the extracted modules
 * already take (`LifecycleDeps.evt`, `TeardownDeps.evt`, …) so that a head or a
 * test can still substitute its own; the two standalone waits (`attach.ts`,
 * `handoff.ts`) import it directly, because neither has ever wanted a different
 * one and neither carries a closure to thread it through.
 *
 * `packages/agentd` has its own `opEvent`: the boundary table in AGENTS.md lets
 * agentd import `@hermetic/core/schema` and nothing else, so the shape is
 * shared through Zod and the helper deliberately is not.
 */
import type { OpEvent } from "./schema/index.ts";

export function evt(
  phase: string,
  progress: number,
  message: string,
  at: string,
  level?: OpEvent["level"],
  kind?: OpEvent["kind"],
): OpEvent {
  return {
    phase,
    progress,
    message,
    at,
    ...(level ? { level } : {}),
    ...(kind ? { kind } : {}),
  };
}

/**
 * The type every deps object names for its `evt`. Written as `typeof evt` so
 * the signature cannot drift from the implementation above.
 */
export type EvtFn = typeof evt;
