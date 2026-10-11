/**
 * Bot-to-bot DMs (`message_agent`, Hermes v2026.9.24 `tools/bot_mode_dm.py`)
 * as the thread draws them: the sender's call becomes a "Messaged <bot>"
 * marker, the delivery in the target's Bot Chat is drawn as the sending bot
 * speaking, and either end opens the exchange (`BotExchange.tsx`).
 *
 * Core does the upstream-specific part: it tags the call `render:
 * "message_agent"` and lifts the delivery's `Message from 🤖 …` signature into
 * `ChatMessage.from_bot` (`core/src/chat/hermes/bot-delivery.ts`). What is left
 * here is reading the call's own arguments and acknowledgement, which are the
 * tool's payload exactly as a generic tool card would show them.
 *
 * Wording follows Desktop's `AgentDeliveryNotice`: "Messaging <bot>…" while
 * the call runs, "Messaged <bot>" once it is queued, "Message from <bot>" on
 * the receiving side.
 *
 * The acknowledgements `message_agent` answers with (`tools/bot_mode_dm.py`):
 * `{status: "queued"|"claimed"|"settled", to, process_id?, …}` once the hand-off
 * happened; `{status: "ambiguous", error: "… Do not resend."}` when the live
 * owner's admission could not be confirmed either way; and `_err`'s
 * `{error, reason}`, with no status, when nothing was sent. Any other shape —
 * a terminal `failed`/`cancelled` record, a newer status — is not one this
 * build reads, so it draws as the ordinary tool row.
 */
import { botHandle, resolveBotTarget } from "@hermetic/core/shared";
import type { BlockLike, MessageLike } from "./chat-logic.ts";

/** A roster row, as far as these rules read one. Any `BotView` satisfies it. */
export interface DmBot {
  instance: string;
  name: string;
  title?: string | null;
  is_default?: boolean;
}

/** A `message_agent` call, read off its tool block. */
export interface MessageAgentCall {
  /** `target` exactly as the model wrote it: a profile name, a friendly name or an @slug. */
  target: string;
  message: string;
  /**
   * `pending` while the call runs, `sent` once handed off, `ambiguous` when
   * upstream could not tell whether it was (and says not to resend), `failed`
   * on an error acknowledgement.
   */
  state: "pending" | "sent" | "ambiguous" | "failed";
  /** The acknowledgement's `@handle`, when it gave one. */
  to: string | null;
  /** The delivery's background process, whose completion notice carries the reply. */
  processId: string | null;
  /** Upstream's failure code (`runtime_offline`, `target_busy`, …) on a failed call (`bot-dm-reasons.ts`). */
  reason: string | null;
  /** Upstream's sentence on a failed or ambiguous call. */
  error: string | null;
  /**
   * The valid targets a failed call's error lists, when upstream attached them:
   * `teammates` on this install, registered `peers` (`_err`,
   * `tools/bot_mode_dm.py:187-195`).
   */
  teammates: string[] | null;
  peers: string[] | null;
  /** Upstream's id for the call, which tells two identical calls in one turn apart. */
  toolId: string | null;
}

/** The statuses upstream acknowledges a completed hand-off with. */
const SENT = new Set(["queued", "claimed", "settled"]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** A JSON object, given as one or as its text; null for anything else. */
function jsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return record(value);
  try {
    return record(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value : null;

/** A list of names, or null for anything that is not one. */
const names = (value: unknown): string[] | null =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.trim() !== "")
    : null;

/**
 * The call a block makes, or null when the block is not a `message_agent` call
 * this build can read — not hinted, arguments missing, or a result that is not
 * the JSON upstream answers with. Null means "draw the ordinary tool row": a
 * shape this file does not recognise renders, it never disappears (§9.2).
 */
export function messageAgentCall(block: BlockLike): MessageAgentCall | null {
  if (block.kind !== "tool" || block["render"] !== "message_agent") return null;
  const args = jsonObject(block["args"]);
  const target = text(args?.["target"]);
  const message = typeof args?.["message"] === "string" ? args["message"] : null;
  if (!target || message === null) return null;
  const base = {
    target: target.trim(),
    message,
    to: null,
    processId: null,
    reason: null,
    error: null,
    teammates: null,
    peers: null,
    toolId: text(block["tool_id"]),
  };
  if (block["status"] === "running") return { ...base, state: "pending" };
  // A call with no result that is not running is one durable history could not
  // pair with its result row (`warn`): nothing says it is still in flight.
  const ack = jsonObject(block["result"]);
  if (!ack) return null;
  const status = ack["status"];
  const error = text(ack["error"]);
  if (status === undefined || status === null)
    return error
      ? {
          ...base,
          state: "failed",
          error,
          reason: text(ack["reason"]),
          teammates: names(ack["teammates"]),
          peers: names(ack["peers"]),
        }
      : null;
  if (status === "ambiguous") return { ...base, state: "ambiguous", error, to: text(ack["to"]) };
  if (typeof status !== "string" || !SENT.has(status)) return null;
  return {
    ...base,
    state: "sent",
    to: text(ack["to"]),
    processId: text(ack["process_id"]),
  };
}

/**
 * The roster bot a call or a signature names, or null. The acknowledgement's
 * `@handle` is the box's own resolution and is tried first; the free-text
 * target after it. Same instance only, with the box's own resolver.
 */
export function resolveDmBot<B extends DmBot>(
  names: readonly (string | null | undefined)[],
  teammates: readonly B[],
): B | null {
  for (const name of names) {
    if (!name) continue;
    const hit = resolveBotTarget(name, teammates);
    if (hit) return hit;
  }
  return null;
}

/**
 * Where a call says its message went: a handle, and the other machine it is on
 * when it is not this one (`elsewhere`: a connection's label, or `peer
 * <name>`). Null for text that names no destination.
 */
export interface DmDestination {
  handle: string;
  elsewhere: string | null;
}

/**
 * The acknowledgement's `to`, as `_start_delivery` labels it
 * (`tools/bot_mode_dm.py`): `@<handle>` for a teammate here (:282), `@<agent>
 * on peer '<peer>'` for a registered peer (:262), `@<handle> on <connection>`
 * for a relayed one (:315).
 */
const ACK_TO_RE = /^@([^\s@/]+)(?: on (?:peer '([^']+)'|(.+)))?$/;
/** `<peer>/<agent>`, upstream's `_PEER_TARGET_RE` (`bot_mode_dm.py:54`). */
const PEER_TARGET_RE = /^([a-z0-9][a-z0-9_-]{0,63})\/([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})$/;
/** `<handle>@<connection>`: upstream routes any target with an `@` past the local roster (:268). */
const RELAY_TARGET_RE = /^([^\s@/]+)@([^\s@/]+)$/;

/**
 * A call's destination. The acknowledgement's `to` is the box's own
 * resolution, so it wins whenever there is one; only a call that has none —
 * running, refused, ambiguous — falls back to the `target` the model wrote,
 * which names another machine only in its `x@conn` and `peer/x` forms. A bare
 * target stays local: it is the best guess there is, and a refused one names
 * nobody anyway.
 */
export function dmDestination(call: Pick<MessageAgentCall, "to" | "target">): DmDestination | null {
  if (call.to) {
    const ack = ACK_TO_RE.exec(call.to.trim());
    if (!ack) return null;
    const peer = ack[2];
    const connection = ack[3]?.trim();
    return { handle: ack[1]!, elsewhere: peer ? `peer ${peer}` : connection || null };
  }
  const target = call.target.trim().replace(/^@+/, "");
  const peer = PEER_TARGET_RE.exec(target);
  if (peer) return { handle: peer[2]!, elsewhere: `peer ${peer[1]}` };
  const relayed = RELAY_TARGET_RE.exec(target);
  if (relayed) return { handle: relayed[1]!, elsewhere: relayed[2]! };
  return target ? { handle: target, elsewhere: null } : null;
}

/**
 * The bot a call messaged, as far as this instance can tell: the roster bot
 * when it went to one here, else the name to show for it. A destination on
 * another machine is never resolved locally, however its handle reads — a
 * same-named bot here is a different bot (the same rule `dmSender` applies to
 * a relayed delivery).
 */
export function dmTarget<B extends DmBot>(
  call: Pick<MessageAgentCall, "to" | "target">,
  teammates: readonly B[],
): { bot: B | null; name: string; elsewhere: string | null } {
  const where = dmDestination(call);
  if (where?.elsewhere) return { bot: null, name: where.handle, elsewhere: where.elsewhere };
  // An acknowledgement that does not parse still names the target; it just is not one to resolve on.
  const bot = where ? resolveDmBot([call.to ?? call.target], teammates) : null;
  return { bot, name: where?.handle ?? call.target, elsewhere: null };
}

/**
 * The roster bot a delivery's signature names, or null. A delivery the relay
 * brought from another machine (`connection` set) is never a bot here, however
 * its name reads: a same-named local bot is a different bot.
 */
export function dmSender<B extends DmBot>(
  from: { name: string; handle?: string | null; connection?: string | null },
  teammates: readonly B[],
): B | null {
  return from.connection ? null : resolveDmBot([from.handle, from.name], teammates);
}

/** The name a bot is shown by: its title, else its handle. */
export function dmBotName(bot: DmBot | null, fallback: string): string {
  const title = bot?.title?.trim();
  if (title) return title;
  return bot ? botHandle(bot.name) : fallback.replace(/^@+/, "");
}

const sameBody = (a: string, b: string): boolean => a.trim() === b.trim();

function bodyOf(message: Pick<MessageLike, "blocks">): string {
  return message.blocks
    .map((block) =>
      block.kind === "text" && typeof block["markdown"] === "string" ? block["markdown"] : "",
    )
    .join("");
}

/** The shortest body a prefix match is trusted on: below it, two messages share one too easily. */
const MIN_PREFIX = 16;

/**
 * Whether a row is `sender`'s delivery of `message`. Exact (trimmed) first;
 * a prefix either way after it, because a box that capped or a fixture that
 * trimmed the body still names the same delivery — never on a short body,
 * where a prefix says nothing about which message it was.
 */
function isDeliveryOf(row: MessageLike, sender: string, message: string, exact: boolean): boolean {
  const from = row.from_bot;
  if (row.role !== "user" || !from) return false;
  // A legacy signature names no handle; the body alone has to carry it.
  if (from.handle && from.handle !== botHandle(sender)) return false;
  const body = bodyOf(row).trim();
  const want = message.trim();
  if (exact) return sameBody(body, want);
  if (body.length < MIN_PREFIX || want.length < MIN_PREFIX) return false;
  return body.startsWith(want.slice(0, 120)) || want.startsWith(body.slice(0, 120));
}

/**
 * How far before its call a delivery may be stamped and still be the call's.
 * Upstream persists the call row before the tool runs
 * (`agent/turn_tool_round.py:118-121`) and the delivery is written by the
 * process the tool starts, on the same box, so the delivery is never older on
 * a true clock; the allowance only absorbs stamps that were rounded or
 * re-based on the way here. The earlier sends of the same body (`earlier`)
 * keep it from reaching back into a previous call's delivery.
 */
export const DELIVERY_SKEW_MS = 1_000;

/**
 * The delivery of `message` from `sender` in a transcript, and the rows that
 * answered it: everything after it up to the next user row. Null when the
 * transcript does not hold it — the delivery has not run yet, or the Bot Chat
 * rolled over since.
 *
 * `since` is when the call was made, and `earlier` when each earlier call
 * from the same thread sent the same body to the same bot was, oldest first.
 * The same body sent twice is two deliveries, written in the order the calls
 * were made, so the calls claim them in order: each takes the earliest
 * unclaimed delivery stamped no more than `DELIVERY_SKEW_MS` before it, and
 * this call's is the last one claimed. Two calls in one turn share a stamp
 * and still get one delivery each. An earlier call whose delivery rolled out
 * of the transcript claims this call's instead, and this call finds none: the
 * exchange then says so and shows the completion notice's reply, which is
 * keyed by process and cannot be the wrong one. A row whose stamp does not
 * parse is never ruled out by it.
 */
export function findExchange<M extends MessageLike>(
  transcript: readonly M[],
  sender: string,
  message: string,
  since: string | null = null,
  earlier: readonly string[] = [],
): { delivery: M; replies: M[] } | null {
  const from = since ? Date.parse(since) : Number.NaN;
  let at = -1;
  for (const exact of [true, false]) {
    const hits: number[] = [];
    transcript.forEach((row, i) => {
      if (isDeliveryOf(row, sender, message, exact)) hits.push(i);
    });
    if (!hits.length) continue;
    // With no time to order by, the latest delivery is the likeliest guess.
    if (Number.isNaN(from)) {
      at = hits.at(-1)!;
      break;
    }
    const claimed = new Set<number>();
    const claim = (stamp: number): number => {
      const hit = hits.find(
        (i) => !claimed.has(i) && !(Date.parse(transcript[i]!.at) < stamp - DELIVERY_SKEW_MS),
      );
      if (hit !== undefined) claimed.add(hit);
      return hit ?? -1;
    };
    for (const stamp of earlier.map(Date.parse)) if (!Number.isNaN(stamp)) claim(stamp);
    at = claim(from);
    if (at >= 0) break;
  }
  if (at < 0) return null;
  const replies: M[] = [];
  for (const row of transcript.slice(at + 1)) {
    if (row.role === "user") break;
    replies.push(row);
  }
  return { delivery: transcript[at]!, replies };
}

/**
 * When a call was made, read off the sender's own unmerged transcript, and
 * when every earlier call that sent the same body to the same bot was (for
 * `findExchange`). A call is the same one by upstream's tool id, else by its
 * delivery process; `sameTarget` says which earlier calls went to the bot
 * this one did. `since` is null when the call is not in the transcript, and
 * the caller falls back to a stamp of its own.
 */
export function callSends(
  transcript: readonly MessageLike[],
  call: MessageAgentCall,
  sameTarget: (other: MessageAgentCall) => boolean,
): { since: string | null; earlier: string[] } {
  const earlier: string[] = [];
  const isThis = (other: MessageAgentCall) =>
    call.toolId
      ? other.toolId === call.toolId
      : call.processId !== null && other.processId === call.processId;
  for (const row of transcript) {
    for (const block of row.blocks) {
      const other = messageAgentCall(block);
      if (!other) continue;
      if (isThis(other)) return { since: row.at, earlier };
      // Only a hand-off can have a delivery to claim.
      if (other.state === "sent" && sameBody(other.message, call.message) && sameTarget(other))
        earlier.push(row.at);
    }
  }
  return { since: null, earlier: [] };
}

/**
 * The reply a delivery's completion notice carried back to the sender, by the
 * acknowledgement's process id, or null.
 */
export function noticeReply(
  transcript: readonly MessageLike[],
  processId: string | null,
): string | null {
  if (!processId) return null;
  for (const row of transcript) {
    for (const block of row.blocks) {
      if (block.kind !== "process_event" || block["process_id"] !== processId) continue;
      const reply = record(block["dm"])?.["reply"];
      if (typeof reply === "string") return reply;
    }
  }
  return null;
}
