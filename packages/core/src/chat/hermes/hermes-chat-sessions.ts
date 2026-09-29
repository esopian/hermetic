/**
 * The session registry: `chat.sessions`, and the mapping from upstream's
 * `session.list` rows onto `schema/chat.ts`'s `Session`.
 *
 * The origin mapping is the part worth reading — it is the one field whose
 * being wrong sends an operator's reply somewhere they did not mean it to go.
 */
import { checkAbort } from "../../abort.ts";
import type { BoxAddress, HermesChatOptions } from "./hermes-chat-types.ts";
import type { Rpc } from "./hermes-chat-rpc.ts";
import { arr, isoOrNull, num, rec, str } from "./hermes-chat-wire.ts";
import { processNoticePreview } from "./process-notice.ts";
import type { Session, SessionKind, SessionOrigin } from "../../schema/index.ts";

/** What `createChatSessions` needs, and nothing more. */
export interface ChatSessionsDeps {
  connect(box: BoxAddress, signal: AbortSignal | undefined): Promise<Rpc>;
}

export function createChatSessions(deps: ChatSessionsDeps) {
  async function sessions(
    box: BoxAddress,
    bot: string,
    opts: HermesChatOptions = {},
  ): Promise<Session[]> {
    checkAbort(opts.signal, "chat.sessions");
    const rpc = await deps.connect(box, opts.signal);
    try {
      return mapSessions(box, bot, await listSessions(rpc, bot));
    } finally {
      rpc.close();
    }
  }

  /** Never retry a refused profile-scoped registry read without its scope. */
  async function listSessions(rpc: Rpc, bot: string): Promise<unknown> {
    return rpc.request("session.list", { profile: bot, include_hidden: true });
  }
  return { sessions };
}

/**
 * The session list.
 *
 * The one decision worth defending is the origin default. A session the box
 * lists was, in general, **not** started by this portal — a box runs messaging
 * channels, cron jobs, a CLI and a dashboard, and Hermes Desktop can attach to
 * it. `portal` is the single origin value that suppresses the composer's
 * restatement of where a reply is going (`FOREIGN_ORIGINS`), so an unknown
 * origin defaults to `cli` rather than `portal`: mislabelling a portal session
 * as foreign costs one redundant line of UI, and mislabelling a channel session
 * as `portal` sends an operator's reply into somebody's Slack.
 */
export function mapSessions(box: BoxAddress, bot: string, raw: unknown): Session[] {
  const rows = arr(rec(raw)?.sessions ?? raw);
  const out: Session[] = [];
  for (const entry of rows) {
    const row = rec(entry);
    const id = str(row?.session_id) ?? str(row?.id) ?? str(row?.stored_session_id);
    if (!id || (str(row?.profile) && row?.profile !== bot)) continue;
    out.push({
      id,
      instance: box.instance,
      bot: str(row?.profile) ?? str(row?.bot) ?? bot,
      kind:
        (str(row?.root_title) ?? str(row?.title)) === "Bot Chat"
          ? "canonical"
          : sessionKind(str(row?.kind)),
      origin: sessionOrigin(str(row?.origin) ?? str(row?.source)),
      origin_detail: str(row?.origin_detail) ?? str(row?.channel) ?? null,
      title: str(row?.title) || id,
      // Sent on every row of a real `session.list`, and truncated by the box
      // rather than here — the capture's longest is 60 characters ending in an
      // ellipsis, which is upstream's own cut, not this adapter's.
      // A session whose first user row is a background-process notice would
      // otherwise preview as `[IMPORTANT: Background process …` — upstream
      // builds the preview from that row — so it reads as the event instead.
      preview: eventPreview(str(row?.preview) ?? str(row?.snippet)),
      /**
       * `started_at` is the one a real box sends, as a **float of Unix seconds**
       * — not `updated_at`, not `last_message_at`, not `mtime`, and not a
       * string. Accepting only the other spellings returned null for every row
       * of every session list, which is how a watermark that looked mapped was
       * never mapped at all.
       *
       * The "last" spellings stay ahead of it because they mean what this field
       * means. `started_at` is when the conversation *opened*, so it is a floor,
       * and taking it was a choice rather than an oversight: a bot in the middle
       * of a long conversation reads as quieter than it is, so this field
       * **under-notifies rather than over-notifies**. That is the right direction
       * for a notification source to be wrong in — a missed nudge costs less than
       * a fleet of thirteen boxes crying wolf — and it beats a null, which reads
       * as "this bot has never spoken" and is wrong in the other direction while
       * looking like an absence of data.
       */
      last_message_at: isoOrNull(
        row?.last_message_at ?? row?.last_active ?? row?.updated_at ?? row?.started_at ?? row?.mtime,
      ),
      unread: 0,
      turn_count: Math.max(0, Math.trunc(num(row?.message_count) ?? num(row?.turn_count) ?? 0)),
    });
  }
  return out;
}

const SESSION_KINDS = new Set<string>(["canonical", "thread", "routine"]);

function sessionKind(raw: string | null): SessionKind {
  return raw !== null && SESSION_KINDS.has(raw) ? (raw as SessionKind) : "thread";
}

/**
 * Upstream's `source` field, mapped onto §9.2's origins — deliberately, one
 * value at a time, and **never onto `portal`**.
 *
 * `portal` is the single origin that suppresses the composer's restatement of
 * where a reply is going (`FOREIGN_ORIGINS` in `schema/chat.ts`). Getting it
 * wrong sends an operator's reply into somebody's Slack from a box that looks
 * like every other box, so it must be positively identified and nothing here
 * can identify it. Two reasons, and the second is the one that settles it.
 *
 * Upstream has no notion of hermetic's portal — it is a gateway being driven
 * over `/api/ws`, and a session hermetic opens is indistinguishable at this
 * layer from one the box's own Ink TUI opened. And upstream *does* use the word
 * `portal`, for something else entirely: `GET /api/portal` answers
 * `{"logged_in": …, "provider": "vercel"}`. Passing a `source` of `"portal"`
 * through would hand the safety-critical value to a string that means Vercel.
 *
 * So every mapping below lands on a foreign origin, and an unrecognised
 * `source` lands on `cli` — foreign, and the least specific claim available,
 * since the enum has no "unknown". Which sessions this portal actually started
 * is local state (§9.2), known to `chat.ts` and its SQLite, not to the box.
 *
 * Only `tui` has been observed live (every row of the captured `session.list`).
 * The rest are read from upstream's own vocabulary and are here so that a
 * value this build has never seen is still classified rather than defaulted.
 */
const UPSTREAM_ORIGINS: Record<string, SessionOrigin> = {
  // The Ink terminal UI on the box — the only value the capture contains.
  tui: "cli",
  cli: "cli",
  terminal: "cli",
  shell: "cli",
  web: "desktop",
  dashboard: "desktop",
  desktop: "desktop",
  ios: "desktop",
  mobile: "desktop",
  cron: "routine",
  routine: "routine",
  schedule: "routine",
  scheduler: "routine",
  peer: "peer",
  bot: "peer",
  a2a: "peer",
  subagent: "peer",
  relay: "peer",
  group: "room",
  room: "room",
  bot_room: "room",
  channel: "channel",
  slack: "channel",
  discord: "channel",
  telegram: "channel",
  imessage: "channel",
  signal: "channel",
  whatsapp: "channel",
  sms: "channel",
  email: "channel",
  webhook: "channel",
};

function sessionOrigin(raw: string | null): SessionOrigin {
  if (raw === null) return "cli";
  return UPSTREAM_ORIGINS[raw.toLowerCase()] ?? "cli";
}

/**
 * A preview as the rail shows it: an injected notice (`process-notice.ts`)
 * becomes its one-line sentence, anything else passes through untouched.
 */
export function eventPreview(preview: string | null): string | null {
  if (preview === null) return null;
  return processNoticePreview(preview) ?? preview;
}
