/**
 * Whether the gateway has a turn running in a conversation, read without
 * touching it: the busy signal an observation hands a head (§9.2).
 *
 * Observation reads the durable transcript, and a durable read cannot say a
 * turn is in flight — the reply is not a row until it lands. A turn Hermes
 * started on its own (a background process's completion notice) or one another
 * client started therefore looked, to a head, like an idle conversation, and a
 * message typed into it went in as a plain `prompt.submit`, which upstream's
 * default `busy_input_mode: interrupt` turned into a live steer of a turn the
 * operator did not know existed.
 *
 * There is no event to listen for. Upstream emits only to a session's own
 * transport, and has no `turn.start` or `session.state` broadcast, so a socket
 * that merely listens does not hear another client's turn begin. What it does
 * have is `session.active_list` (upstream `tui_gateway/methods_session.py:1004`,
 * rows built by `_session_live_item` in `tui_gateway/server.py:2764-2800`): a
 * passive read of the sessions live in the gateway process — no rebind, no
 * agent build, no history load — each row carrying its durable `session_key`
 * and a `status` from `_session_live_status`. Passive is not free: building
 * each row's title (`_session_live_title`) opens the session database once per
 * live row, which is why the observation stops re-asking a gateway that keeps
 * failing to answer (`chat-observe.ts`, "Busy: the one live read").
 *
 * - `waiting` — blocked on an approval or a clarify answer from a person: busy;
 * - `working` — `session["running"]`, a turn in flight: busy;
 * - `starting` — the agent is being built. A turn submitted to a cold session
 *   reads this first (`_lock_in_submit_turn`, `methods_prompt.py:551`, sets
 *   `running` before the build), but so does a build with no turn behind it,
 *   so it is read as `null`, "cannot tell", rather than either answer;
 * - `idle`.
 *
 * Upstream's contracts also list `streaming` and `resuming`, which are read as
 * busy for the same reason `working` is. A session absent from the list is not
 * live on that gateway, so nothing is running in it there.
 *
 * Same transport and the same discipline as `hermes-chat-live-usage.ts`: one
 * request on the pooled Bot Mode socket, carrying a short deadline, the whole
 * lookup (dial included) raced against one budget. Every way of not knowing —
 * the budget ran out, the request failed, a gateway that predates the method
 * — reads as `null`, never as `false`: "could not tell" must not be mistaken
 * for "idle" by a head deciding whether to queue.
 */
import type { BoxAddress, HermesChatOptions } from "./hermes-chat-types.ts";
import type { LiveUsageDeps } from "./hermes-chat-live-usage.ts";
import { rec, records, str } from "./hermes-chat-wire.ts";

/** The statuses that mean a turn is running, or is waiting on a person. */
export const BUSY_STATUSES: ReadonlySet<string> = new Set([
  "working",
  "waiting",
  "streaming",
  "resuming",
]);

/**
 * The budget for the whole probe, dial included, and the request's own
 * deadline. Shorter than the live-usage one: an observation probes on every
 * reconcile of a running conversation, so a box that stops answering must not
 * hold its loop for long, and a miss costs only one `null`.
 */
export const BUSY_DEADLINE_MS = 3_000;

export function createBusyProbe(
  deps: LiveUsageDeps,
  { budgetMs = BUSY_DEADLINE_MS }: { budgetMs?: number } = {},
) {
  /**
   * `true` when a listed row whose durable `session_key` is one of `sessions`
   * reports a busy status; else `null` when one of them reads `starting`;
   * `false` when the list came back and none does; `null` when it did not
   * come back. Never throws.
   *
   * `bot` is not sent: `session.active_list` takes no profile, and a durable
   * session id is already unique to its profile.
   */
  function busy(
    box: BoxAddress,
    _bot: string,
    sessions: readonly string[],
    opts: HermesChatOptions = {},
  ): Promise<boolean | null> {
    // A conversation with no session yet has no turn to be running.
    if (sessions.length === 0) return Promise.resolve(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), budgetMs);
    });
    const read = lookup(box, sessions, opts).catch(() => null);
    return Promise.race([read, expired]).finally(() => clearTimeout(timer));
  }

  async function lookup(
    box: BoxAddress,
    sessions: readonly string[],
    opts: HermesChatOptions,
  ): Promise<boolean | null> {
    const listed = rec(
      await deps.rpc(box, "session.active_list", {}, { ...opts, deadlineMs: budgetMs }),
    );
    // A reply without the list is a gateway that does not speak this method's
    // shape, which is "could not tell", not "nothing running".
    if (listed === null || !Array.isArray(listed.sessions)) return null;
    const wanted = new Set(sessions);
    const statuses = records(listed.sessions).flatMap((row) => {
      const key = str(row.session_key);
      const status = str(row.status);
      return key !== null && wanted.has(key) && status !== null ? [status] : [];
    });
    if (statuses.some((status) => BUSY_STATUSES.has(status))) return true;
    return statuses.includes("starting") ? null : false;
  }

  return { busy };
}
