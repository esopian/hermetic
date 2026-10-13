/**
 * The usage the gateway holds for a conversation that is live on it, read
 * without resuming it: what `chat.history` reports when a head asks for it.
 *
 * The box's stored rows carry no context window, so a conversation opened
 * after the app restarted had no figure until its next turn's first tick. The
 * gateway has one while the session is still live there — Hermes Desktop holds
 * it attached, and the portal's own turn leaves it live only until the
 * gateway reaps the detached session (about 20 s upstream) — and it is the same object a
 * `session.resume` reply would put in `info.usage` (upstream's
 * `_session_usage_snapshot`). Resuming to get it is not on offer: a cold resume
 * reopens the durable row and schedules an agent build, and reading a
 * transcript must never do either (`hermes-chat-history.ts`).
 *
 * So it is two requests on the pooled Bot Mode socket, neither of which
 * resumes or builds anything:
 * `session.active_list` names the gateway's live sessions with their durable
 * key, and `session.usage` reads one by its runtime id without building
 * anything. A conversation that is not live, a gateway that predates either
 * method, or a session whose agent has not run yet all come back null, and a
 * head shows no figure rather than a guessed one. Each request gets a short
 * deadline of its own: `chat.history` waits on this beside the transcript, and
 * upstream's `session.usage` also asks the provider for account quota, so a slow
 * gateway must cost the first paint seconds, not the pool's 30 s slot wait.
 */
import type { ChatUsage } from "../../schema/index.ts";
import { mapUsage } from "./hermes-chat-blocks.ts";
import type { BoxAddress, HermesChatOptions } from "./hermes-chat-types.ts";
import { rec, records, str } from "./hermes-chat-wire.ts";

/** What `createLiveUsage` needs: one request on a box's socket. */
export interface LiveUsageDeps {
  rpc(
    box: BoxAddress,
    method: string,
    params: Record<string, unknown>,
    opts?: HermesChatOptions & { deadlineMs?: number },
  ): Promise<unknown>;
}

/** Per-request deadline for the lookup; a miss reads as "no figure". */
export const LIVE_USAGE_DEADLINE_MS = 5_000;

export function createLiveUsage(deps: LiveUsageDeps) {
  async function liveUsage(
    box: BoxAddress,
    bot: string,
    session: string,
    opts: HermesChatOptions = {},
  ): Promise<ChatUsage | null> {
    const request = { ...opts, deadlineMs: LIVE_USAGE_DEADLINE_MS };
    const listed = rec(await deps.rpc(box, "session.active_list", {}, request));
    // `session_key` is the durable id (the agent's own after a compression),
    // which is what a head addresses a conversation by.
    const live = records(listed?.sessions).find((row) => str(row.session_key) === session);
    const runtime = str(live?.id);
    if (!runtime) return null;
    const usage = mapUsage(
      rec(await deps.rpc(box, "session.usage", { session_id: runtime, profile: bot }, request)),
    );
    return usage?.context_used != null ? usage : null;
  }
  return { liveUsage };
}
